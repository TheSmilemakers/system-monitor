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
  });

  test("a denied read is null, not an empty grant list", async () => {
    expect(await grantsFor("kTCCServiceCamera")).toBeNull();
  });

  test("the report is honest when the database is unreadable", async () => {
    const r = await permissionsReport(7);
    expect(r).toMatchObject({ readable: false, grants: [], highRiskGrants: 0, timestamp: 7 });
    expect(r.unavailable).toEqual([{ check: "app permissions (TCC database)", reason: "denied" }]);
  });

  test("with a readable database, grants are listed per service and high-risk ones counted", async () => {
    installFakeProbe({
      sqlite3: (args) => {
        const q = args[1] ?? "";
        if (q.includes("kTCCServiceScreenCapture"))
          return { status: "ok", value: "us.zoom.xos\ncom.apple.screencaptureui" };
        if (q.includes("kTCCServiceCamera")) return { status: "ok", value: "us.zoom.xos" };
        return { status: "ok", value: "" };
      },
    });
    const r = await permissionsReport();
    expect(r.readable).toBe(true);
    expect(r.grants).toHaveLength(TCC_SERVICES.length);
    expect(r.grants.find((g) => g.service === "kTCCServiceScreenCapture")?.clients).toEqual([
      "us.zoom.xos",
      "com.apple.screencaptureui",
    ]);
    expect(r.highRiskGrants).toBe(2);
    expect(r.unavailable).toEqual([]);
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
