import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getPersistence } from "@/app/api/persistence/route";
import { __resetIdentityCache, identitiesSettled } from "@/lib/identity";
import { __resetMonitor, saveBaseline, type Snapshot } from "@/lib/monitor";
import { parsePlistJson, parsePlistXml, persistenceReport } from "@/lib/persistence";
import { parsePersistence } from "@/lib/schemas";

import {
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

let dir = "";
const previous = process.env.SM_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-persist-"));
  process.env.SM_DATA_DIR = dir;
  __resetMonitor();
  __resetIdentityCache();
  installFakeProbe();
  installFakeCodesign();
  installLoopbackHeaders();
});

afterEach(async () => {
  resetSeams();
  __resetMonitor();
  __resetIdentityCache();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("plist parsing", () => {
  test("JSON form: Label, Program or first ProgramArguments, RunAtLoad, KeepAlive as bool or dict", () => {
    expect(
      parsePlistJson(
        JSON.stringify({
          Label: "a",
          ProgramArguments: ["/x/y", "--z"],
          RunAtLoad: true,
          KeepAlive: { SuccessfulExit: false },
        }),
      ),
    ).toEqual({ label: "a", program: "/x/y", runAtLoad: true, keepAlive: true });
    expect(parsePlistJson(JSON.stringify({ Label: "b", Program: "/p" }))).toEqual({
      label: "b",
      program: "/p",
      runAtLoad: false,
      keepAlive: false,
    });
    expect(parsePlistJson("{}")).toEqual({
      label: null,
      program: null,
      runAtLoad: false,
      keepAlive: false,
    });
    expect(parsePlistJson("not json")).toBeNull();
  });

  test("XML form", () => {
    const xml =
      '<plist version="1.0"><dict><key>Label</key><string>c</string><key>ProgramArguments</key><array><string>/q</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>Crashed</key><true/></dict></dict></plist>';
    expect(parsePlistXml(xml)).toEqual({
      label: "c",
      program: "/q",
      runAtLoad: true,
      keepAlive: true,
    });
    expect(parsePlistXml("<html/>")).toBeNull();
  });
});

describe("persistenceReport", () => {
  test("lists every launch item with scope, program, signature, vendor and baseline flags", async () => {
    const baseline: Snapshot = {
      ts: 0,
      processes: {},
      destinations: [],
      ports: [],
      posture: {},
      accounts: [],
      admins: [],
      sshKeys: {},
      dns: [],
      extensions: [],
      persistence: {
        "/Library/LaunchAgents/com.docker.vmnetd.plist": "stale-hash",
        "/Library/LaunchDaemons/com.apple.bar.plist":
          "0".repeat(60) +
          ("/Library/LaunchDaemons/com.apple.bar.plist".length % 10000)
            .toString(16)
            .padStart(4, "0"),
      },
    };
    await saveBaseline(baseline, 1);

    const first = await persistenceReport(5);
    await identitiesSettled();
    const r = await persistenceReport(6);
    expect(r.timestamp).toBe(6);
    expect(first.items.length).toBe(r.items.length);

    const byLabel = Object.fromEntries(r.items.map((i) => [i.label, i]));
    expect(byLabel["com.acme.helper"]).toMatchObject({
      scope: "system-agent",
      program: "/Users/rajan/Downloads/acme-helper",
      runAtLoad: true,
      keepAlive: true,
      trust: "unsigned",
      knownVendor: false,
      newSinceBaseline: true,
    });
    expect(byLabel["com.docker.vmnetd"]).toMatchObject({
      program: "/Library/PrivilegedHelperTools/com.docker.vmnetd",
      knownVendor: true,
      newSinceBaseline: false,
      changedSinceBaseline: true,
    });
    // The XML fallback ran for the plist JSON could not express.
    expect(byLabel["com.example.updater"]).toMatchObject({
      scope: "user",
      program: "/Applications/Example.app/Contents/MacOS/updater",
      runAtLoad: true,
      keepAlive: true,
      trust: "developer-id",
      publisher: "Google LLC",
    });
    expect(byLabel["com.apple.bar"]).toMatchObject({
      scope: "system-daemon",
      newSinceBaseline: false,
      changedSinceBaseline: false,
    });
    expect(r.items.map((i) => i.scope)).toEqual([
      "user",
      "user",
      "system-agent",
      "system-agent",
      "system-agent",
      "system-daemon",
    ]);
    expect(r.profiles).toEqual([]);
    expect(r.unavailable).toEqual([]);
  });

  test("a directory that cannot be listed is reported; profiles that cannot be read are null", async () => {
    installFakeProbe({
      ls: (args) =>
        args[0] === "/Library/LaunchDaemons" ? { status: "denied" } : { status: "ok", value: "" },
      profiles: () => ({ status: "timeout" }),
    });
    const r = await persistenceReport();
    expect(r.items).toEqual([]);
    expect(r.profiles).toBeNull();
    expect(r.unavailable).toEqual([
      { check: "/Library/LaunchDaemons listing", reason: "denied" },
      { check: "configuration profiles", reason: "timeout" },
    ]);
  });

  test("GET /api/persistence refuses a forged Host and serves the contract", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getPersistence()).status).toBe(403);
    installLoopbackHeaders();
    const res = await getPersistence();
    expect(res.status).toBe(200);
    const body = parsePersistence(await res.json());
    expect(body.items.length).toBe(6);
    expect(body.profiles).toEqual([]);
  });
});
