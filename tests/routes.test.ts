import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GET as getCleanup } from "@/app/api/cleanup/route";
import { GET as getPrivacy } from "@/app/api/privacy/route";
import { GET as getScan } from "@/app/api/scan/route";
import { GET as getStats } from "@/app/api/stats/route";
import { __resetIdentityCache, identitiesSettled } from "@/lib/identity";
import { __resetMonitor, monitorSettled } from "@/lib/monitor";
import { __resetMachineInfo } from "@/lib/probe";
import { __resetResolveCache } from "@/lib/resolve-host";
import { __resetSampler } from "@/lib/sampler";
import { parseCleanup, parsePrivacy, parseScan, parseStats } from "@/lib/schemas";

import {
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

/**
 * Route handlers invoked as functions, against fixture tool output.
 *
 * Until now these were only exercised as opaque HTTP status codes by the smoke
 * script, and the QA gate checked for the literal text `assertLocalRequest(`
 * in each file. These tests assert on behaviour: the boundary rejects, the
 * bodies satisfy the client contract in `schemas.ts`, and failed probes are
 * reported rather than served as healthy zeros (H-01, H-03).
 */

beforeEach(() => {
  __resetMachineInfo();
  __resetSampler();
  __resetResolveCache();
  __resetIdentityCache();
  installFakeProbe();
  installFakeCodesign();
  installLoopbackHeaders();
});

afterEach(async () => {
  // The stats route ticks the monitor without awaiting it; let it finish
  // before the seams change under it, then clear its module state.
  await monitorSettled();
  __resetMonitor();
  resetSeams();
  __resetMachineInfo();
  __resetSampler();
});

describe("trust boundary on every route", () => {
  const routes = [
    ["stats", getStats],
    ["scan", getScan],
    ["cleanup", getCleanup],
    ["privacy", getPrivacy],
  ] as const;

  for (const [name, handler] of routes) {
    test(`${name}: forged Host is refused with 403 and no data`, async () => {
      installHeaders({ host: "evil.example.com" });
      const res = await handler();
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("non-loopback Host");
      expect(Object.keys(body)).toEqual(["error"]);
    });

    test(`${name}: cross-origin caller is refused`, async () => {
      installHeaders({ host: "127.0.0.1:3000", origin: "http://192.168.1.10:3000" });
      const res = await handler();
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("cross-origin");
    });

    test(`${name}: loopback without an Origin header is served`, async () => {
      installHeaders({ host: "localhost:3000" });
      const res = await handler();
      expect(res.status).toBe(200);
    });
  }
});

describe("GET /api/stats", () => {
  test("serves a body that satisfies the client contract", async () => {
    const res = await getStats();
    expect(res.status).toBe(200);
    const stats = parseStats(await res.json());
    expect(stats.complete).toBe(true);
    expect(stats.cpu.used).toBe(20);
    expect(stats.cpu.cores).toBe(10);
    expect(stats.memory.totalGB).toBe(16);
    expect(stats.swap.percent).toBe(25);
    expect(stats.disk.percent).toBe(2);
    expect(stats.processes.top[0]?.command).toBe("fileproviderd");
    expect(stats.processes.top[0]?.pid).toBe(648);
    expect(stats.battery).toEqual({ percent: 80, charging: true });
    expect(stats.uptime).toBe("18 days, 11 mins");
    expect(stats.processes.top[0]?.trust).toBe("pending");

    // A later sample carries the resolved identity.
    await identitiesSettled();
    const again = parseStats(await (await getStats()).json());
    expect(again.processes.top[0]).toMatchObject({ trust: "apple", publisher: "Apple", ppid: 1 });
    expect(again.processes.top.find((p) => p.pid === 900)).toMatchObject({
      trust: "developer-id",
      publisher: "Google LLC",
      bundleId: "com.google.Chrome",
    });
  });

  test("returns 503, not zero-filled data, when every core probe fails", async () => {
    installFakeProbe({
      top: () => ({ status: "timeout" }),
      vm_stat: () => ({ status: "denied" }),
      ps: () => ({ status: "failed", error: "boom" }),
    });
    const res = await getStats();
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: string;
      unavailable: { check: string; reason: string }[];
    };
    expect(body.error).toContain("unavailable");
    expect(body.unavailable.map((u) => u.check)).toEqual(
      expect.arrayContaining(["cpu/load (top)", "memory (vm_stat)", "processes (ps)"]),
    );
  });

  test("a failing monitor tick never affects the stats response", async () => {
    // The monitor's snapshot lists connections with lsof; make that blow up.
    installFakeProbe({
      lsof: () => {
        throw new Error("boom");
      },
    });
    const res = await getStats();
    expect(res.status).toBe(200);
    await monitorSettled();
  });

  test("a single failed probe is reported, and the rest is still served", async () => {
    installFakeProbe({ pmset: () => ({ status: "denied" }) });
    const res = await getStats();
    expect(res.status).toBe(200);
    const stats = parseStats(await res.json());
    expect(stats.complete).toBe(false);
    expect(stats.unavailable).toEqual([{ check: "battery (pmset)", reason: "denied" }]);
    expect(stats.battery).toBeNull();
    expect(stats.cpu.used).toBe(20);
  });
});

describe("GET /api/scan", () => {
  test("categorises browsers, Electron apps and startup items without double counting", async () => {
    const res = await getScan();
    expect(res.status).toBe(200);
    const scan = parseScan(await res.json());
    expect(scan.complete).toBe(true);
    expect(typeof scan.healthScore).toBe("number");

    const categories = scan.findings.map((f) => f.category);
    expect(categories).toContain("Browsers");
    expect(categories).toContain("Electron Apps");
    expect(categories).toContain("Startup Items");

    const browsers = scan.findings.find((f) => f.category === "Browsers");
    expect(browsers?.title).toContain("2 browsers");
    // Chrome is a browser, so it must not also be counted as an Electron app (M-14).
    const electron = scan.findings.find((f) => f.category === "Electron Apps");
    expect(electron?.processes.map((p) => p.pid)).toEqual([902]);

    expect(scan.summary?.browsers).toBe(2);
    expect(scan.summary?.electronApps).toBe(1);
    // com.apple.* system items are excluded from the startup count.
    expect(scan.summary?.launchItems).toBe(4);
  });

  test("withholds the score and findings when the process list is unavailable", async () => {
    installFakeProbe({ ps: () => ({ status: "timeout" }) });
    const res = await getScan();
    expect(res.status).toBe(200);
    const scan = parseScan(await res.json());
    expect(scan.complete).toBe(false);
    expect(scan.healthScore).toBeNull();
    expect(scan.findings).toEqual([]);
    expect(scan.unavailable).toEqual(
      expect.arrayContaining([{ check: "process list", reason: "timeout" }]),
    );
  });
});

describe("GET /api/cleanup", () => {
  test("lists measured targets by size with opaque ids and no executable command (C-01)", async () => {
    const res = await getCleanup();
    expect(res.status).toBe(200);
    const raw = await res.json();
    const cleanup = parseCleanup(raw);
    expect(JSON.stringify(raw)).not.toContain('"command"');
    expect(cleanup.items.length).toBeGreaterThan(0);
    for (let i = 1; i < cleanup.items.length; i++) {
      expect(cleanup.items[i - 1].size).toBeGreaterThanOrEqual(cleanup.items[i].size);
    }
    for (const item of cleanup.items) {
      expect(item.size).toBe(40960 * 1024);
      expect(item.fileCount).toBe(3);
      expect(item.sizeFormatted).toBe("40 MB");
    }
    expect(cleanup.totalSize).toBe(cleanup.items.length * 40960 * 1024);
  });

  test("a timed-out measurement is reported, not dropped as an empty target (H-03)", async () => {
    installFakeProbe({ du: () => ({ status: "timeout" }) });
    const res = await getCleanup();
    const cleanup = parseCleanup(await res.json());
    expect(cleanup.items).toEqual([]);
    expect(cleanup.complete).toBe(false);
    expect(cleanup.unavailable.length).toBeGreaterThan(0);
    expect(cleanup.unavailable.every((u) => u.reason === "timeout")).toBe(true);
  });
});

describe("GET /api/privacy", () => {
  test("attributes connections, flags unresolved endpoints, and reports the TCC denial", async () => {
    const res = await getPrivacy();
    expect(res.status).toBe(200);
    const privacy = parsePrivacy(await res.json());

    // Two ESTABLISHED rows; the LISTEN row is not a connection.
    expect(privacy.connectionCount).toBe(2);
    expect(privacy.resolvedCount).toBe(1);
    expect(privacy.unknownCount).toBe(1);

    const categories = privacy.findings.map((f) => f.category);
    expect(categories).toContain("Unresolved Endpoints");
    expect(categories).toContain("Persistence");
    expect(categories).toContain("App Permissions");

    const persistence = privacy.findings.find((f) => f.category === "Persistence");
    expect(persistence?.items).toEqual(["com.example.updater.plist", "com.acme.helper.plist"]);

    // TCC unreadable: surfaced as unavailable and the score is withheld (H-03).
    expect(privacy.complete).toBe(false);
    expect(privacy.privacyScore).toBeNull();
    expect(privacy.unavailable).toEqual([
      { check: "app permissions (TCC database)", reason: "denied" },
    ]);
  });

  test("scores the machine when the TCC database is readable", async () => {
    installFakeProbe({
      sqlite3: (args) => ({
        status: "ok",
        value: (args[1] ?? "").includes("kTCCServiceScreenCapture")
          ? "us.zoom.xos\ncom.apple.screencaptureui"
          : "",
      }),
    });
    const res = await getPrivacy();
    const privacy = parsePrivacy(await res.json());
    expect(privacy.complete).toBe(true);
    expect(typeof privacy.privacyScore).toBe("number");
    const perms = privacy.findings.filter((f) => f.category === "App Permissions");
    expect(perms).toHaveLength(1);
    expect(perms[0].title).toContain("Screen Recording: 2 app(s) granted");
    expect(perms[0].severity).toBe("medium");
  });

  test("reports a failed connection listing instead of a clean network", async () => {
    installFakeProbe({ lsof: () => ({ status: "timeout" }) });
    const res = await getPrivacy();
    const privacy = parsePrivacy(await res.json());
    expect(privacy.connectionCount).toBe(0);
    expect(privacy.complete).toBe(false);
    expect(privacy.unavailable).toEqual(
      expect.arrayContaining([{ check: "network connections (lsof)", reason: "timeout" }]),
    );
  });
});
