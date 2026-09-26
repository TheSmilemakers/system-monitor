import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { GET as getPosture } from "@/app/api/posture/route";
import {
  __resetPosture,
  parseFileVault,
  parseFirewall,
  parseGatekeeper,
  parseListeningPorts,
  parseSip,
  parseSoftwareUpdate,
  parseSystemExtensions,
  posture,
  updatesSettled,
} from "@/lib/posture";
import { parsePosture } from "@/lib/schemas";

import {
  FIREWALL_OFF,
  FIREWALL_ON,
  NETSTAT_OUTPUT,
  SOFTWAREUPDATE_OUTPUT,
  SYSEXT_OUTPUT,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = new Date("2026-09-26T00:30:00Z");

describe("posture parsers", () => {
  test("firewall", () => {
    expect(parseFirewall(FIREWALL_OFF)).toEqual({ enabled: false, stealth: true });
    expect(parseFirewall(FIREWALL_ON)).toEqual({ enabled: true, stealth: false });
    expect(parseFirewall("garbage")).toBeNull();
  });

  test("sip, gatekeeper, filevault", () => {
    expect(parseSip("System Integrity Protection status: enabled.")).toBe(true);
    expect(parseSip("System Integrity Protection status: disabled.")).toBe(false);
    expect(parseSip("")).toBeNull();
    expect(parseGatekeeper("assessments enabled")).toBe(true);
    expect(parseGatekeeper("assessments disabled")).toBe(false);
    expect(parseGatekeeper("?")).toBeNull();
    expect(parseFileVault("FileVault is On.")).toBe(true);
    expect(parseFileVault("FileVault is Off.")).toBe(false);
    expect(parseFileVault("")).toBeNull();
  });

  test("listening ports ignore loopback-only listeners and established sockets", () => {
    const ports = parseListeningPorts(NETSTAT_OUTPUT);
    expect([...ports].sort((a, b) => a - b)).toEqual([22, 39503]);
  });

  test("system extensions parse the tab-separated rows", () => {
    expect(parseSystemExtensions(SYSEXT_OUTPUT)).toEqual([
      {
        teamId: "W5W395V82Y",
        bundleId: "com.nordvpn.macos.Shield",
        name: "NordVPN protection",
        state: "activated enabled",
      },
    ]);
    expect(parseSystemExtensions("0 extension(s)")).toEqual([]);
  });

  test("software update labels and the denied marker", () => {
    expect(parseSoftwareUpdate(SOFTWAREUPDATE_OUTPUT)).toEqual({
      pending: ["Safari27.0TahoeAuto-27.0"],
      denied: false,
    });
    expect(
      parseSoftwareUpdate("Scan finished with error: SUMacControllerError ... denied"),
    ).toEqual({
      pending: [],
      denied: true,
    });
  });
});

describe("posture()", () => {
  beforeEach(() => {
    __resetPosture();
    installFakeProbe();
    setSystemTime(T0);
  });
  afterEach(async () => {
    await updatesSettled();
    setSystemTime();
    resetSeams();
    __resetPosture();
  });

  test("builds one lamp per check with the right states", async () => {
    const r = await posture(T0.getTime());
    const byId = Object.fromEntries(r.lamps.map((l) => [l.id, l]));
    expect(r.complete).toBe(true);
    expect(byId.firewall).toMatchObject({
      state: "caution",
      summary: expect.stringContaining("Off"),
    });
    expect(byId.sip?.state).toBe("ok");
    expect(byId.gatekeeper?.state).toBe("ok");
    expect(byId.filevault?.state).toBe("ok");
    expect(byId.xprotect).toMatchObject({
      state: "ok",
      summary: "Definitions 5360, updated 10 days ago",
    });
    expect(byId.remote).toMatchObject({
      state: "caution",
      summary: "Listening: Remote Login (SSH)",
    });
    expect(byId.sysext).toMatchObject({ state: "info", summary: "1 active: NordVPN protection" });
    // The update check runs in the background: dark until it lands.
    expect(byId.updates?.state).toBe("off");

    await updatesSettled();
    const again = await posture(T0.getTime() + 1000);
    expect(again.lamps.find((l) => l.id === "updates")).toMatchObject({
      state: "caution",
      summary: "1 pending: Safari27.0TahoeAuto-27.0",
    });
  });

  test("stale XProtect definitions and a disabled SIP raise the right lamps", async () => {
    installFakeProbe({
      stat: () => ({
        status: "ok",
        value: String(Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000)),
      }),
      csrutil: () => ({ status: "ok", value: "System Integrity Protection status: disabled." }),
    });
    const r = await posture(T0.getTime());
    const byId = Object.fromEntries(r.lamps.map((l) => [l.id, l]));
    expect(byId.xprotect?.state).toBe("caution");
    expect(byId.sip?.state).toBe("alarm");
  });

  test("a probe that cannot run gives a dark lamp and marks the report incomplete", async () => {
    installFakeProbe({
      fdesetup: () => ({ status: "denied" }),
      netstat: () => ({ status: "timeout" }),
    });
    const r = await posture(T0.getTime());
    expect(r.complete).toBe(false);
    expect(r.unavailable).toEqual([
      { check: "FileVault", reason: "denied" },
      { check: "listening sockets (netstat)", reason: "timeout" },
    ]);
    expect(r.lamps.find((l) => l.id === "filevault")?.state).toBe("off");
    expect(r.lamps.find((l) => l.id === "remote")?.state).toBe("off");
  });

  test("a denied software-update read stays dark rather than green", async () => {
    installFakeProbe({
      softwareupdate: () => ({
        status: "ok",
        value: "Scan finished with error: SUMacControllerError denied",
      }),
    });
    await posture(T0.getTime());
    await updatesSettled();
    const r = await posture(T0.getTime() + 1000);
    expect(r.lamps.find((l) => l.id === "updates")).toMatchObject({ state: "off" });
  });
});

describe("GET /api/posture", () => {
  beforeEach(() => {
    __resetPosture();
    installFakeProbe();
    installLoopbackHeaders();
  });
  afterEach(async () => {
    await updatesSettled();
    resetSeams();
    __resetPosture();
  });

  test("refuses a forged Host", async () => {
    installHeaders({ host: "evil.example.com" });
    const res = await getPosture();
    expect(res.status).toBe(403);
  });

  test("serves a body that satisfies the client contract", async () => {
    const res = await getPosture();
    expect(res.status).toBe(200);
    const report = parsePosture(await res.json());
    expect(report.lamps.map((l) => l.id)).toEqual([
      "firewall",
      "sip",
      "gatekeeper",
      "filevault",
      "xprotect",
      "remote",
      "sysext",
      "updates",
    ]);
    expect(report.lamps.every((l) => l.detail.length > 0)).toBe(true);
  });
});
