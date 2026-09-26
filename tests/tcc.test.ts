import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GET as getPermissions } from "@/app/api/permissions/route";
import { parsePermissions } from "@/lib/schemas";
import { grantsFor, permissionsReport, TCC_SERVICES, tccDatabasePath } from "@/lib/tcc";

import { installFakeProbe, installHeaders, installLoopbackHeaders, resetSeams } from "./fixtures";

beforeEach(() => {
  installFakeProbe();
  installLoopbackHeaders();
});
afterEach(() => resetSeams());

describe("TCC", () => {
  test("the database path is under the user's Application Support", () => {
    expect(tccDatabasePath()).toMatch(/\/Library\/Application Support\/com\.apple\.TCC\/TCC\.db$/);
    expect(tccDatabasePath("system")).toBe("/Library/Application Support/com.apple.TCC/TCC.db");
    // The four high-risk services are system-wide; the rest are the user's.
    expect(TCC_SERVICES.filter((s) => s.scope === "system").map((s) => s.name)).toEqual([
      "Accessibility (can observe keystrokes)",
      "Screen Recording",
      "Input Monitoring",
      "Full Disk Access",
    ]);
  });

  test("a denied read is null, not an empty grant list", async () => {
    expect(await grantsFor("kTCCServiceCamera")).toBeNull();
  });

  test("the report is honest when the database is unreadable", async () => {
    const r = await permissionsReport(7);
    expect(r).toMatchObject({ readable: false, highRiskGrants: 0, timestamp: 7 });
    // Every service is listed, each saying it could not be read: unknown, not none.
    expect(r.grants).toHaveLength(TCC_SERVICES.length);
    expect(r.grants.every((g) => !g.readable && g.clients.length === 0)).toBe(true);
    expect(r.unavailable.map((u) => u.check)).toEqual([
      "app permissions (TCC database)",
      "system-level permissions (system TCC database, needs Full Disk Access)",
    ]);
  });

  test("with a readable database, grants are listed per service and high-risk ones counted", async () => {
    installFakeProbe({
      sqlite3: (args) => {
        const q = args[1] ?? "";
        // Screen Recording is answered only by the system database.
        if (q.includes("kTCCServiceScreenCapture"))
          return args[0]?.startsWith("/Library/")
            ? { status: "ok", value: "us.zoom.xos\ncom.apple.screencaptureui" }
            : { status: "ok", value: "" };
        if (q.includes("kTCCServiceCamera")) return { status: "ok", value: "us.zoom.xos" };
        return { status: "ok", value: "" };
      },
    });
    const r = await permissionsReport();
    expect(r.readable).toBe(true);
    expect(r.grants).toHaveLength(TCC_SERVICES.length);
    expect(r.grants.every((g) => g.readable)).toBe(true);
    expect(r.grants.find((g) => g.service === "kTCCServiceScreenCapture")?.clients).toEqual([
      "us.zoom.xos",
      "com.apple.screencaptureui",
    ]);
    expect(r.highRiskGrants).toBe(2);
    expect(r.unavailable).toEqual([]);
  });

  test("with only the user's database readable, system-level services say so rather than reading empty", async () => {
    installFakeProbe({
      sqlite3: (args) =>
        args[0]?.startsWith("/Library/")
          ? { status: "denied" }
          : {
              status: "ok",
              value: (args[1] ?? "").includes("kTCCServiceCamera") ? "us.zoom.xos" : "",
            },
    });
    const r = await permissionsReport();
    expect(r.readable).toBe(true);
    const fda = r.grants.find((g) => g.service === "kTCCServiceSystemPolicyAllFiles");
    expect(fda).toMatchObject({ readable: false, clients: [] });
    expect(r.grants.find((g) => g.service === "kTCCServiceCamera")).toMatchObject({
      readable: true,
      clients: ["us.zoom.xos"],
    });
    expect(r.highRiskGrants).toBe(0);
    expect(r.unavailable).toEqual([
      {
        check: "system-level permissions (system TCC database, needs Full Disk Access)",
        reason: "denied",
      },
    ]);
  });

  test("GET /api/permissions refuses a forged Host and serves the contract", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getPermissions()).status).toBe(403);
    installLoopbackHeaders();
    const res = await getPermissions();
    expect(res.status).toBe(200);
    const body = parsePermissions(await res.json());
    expect(body.readable).toBe(false);
  });
});
