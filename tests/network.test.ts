import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getNetwork } from "@/app/api/network/route";
import { __resetMonitor, saveBaseline, type Snapshot } from "@/lib/monitor";
import { networkReport, parseLsofAll } from "@/lib/network";
import { __resetResolveCache } from "@/lib/resolve-host";
import { parseNetwork } from "@/lib/schemas";
import { isAppleTelemetry, matchTracker } from "@/lib/trackers";

import {
  LSOF_OUTPUT,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

let dir = "";
const previous = process.env.SM_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-network-"));
  process.env.SM_DATA_DIR = dir;
  __resetMonitor();
  __resetResolveCache();
  installFakeProbe();
  installLoopbackHeaders();
});

afterEach(async () => {
  resetSeams();
  __resetMonitor();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("trackers", () => {
  test("matches by substring of the hostname and knows Apple telemetry", () => {
    expect(matchTracker("www.google-analytics.com")).toMatchObject({
      category: "Analytics",
      pattern: "google-analytics",
    });
    expect(matchTracker("edge-star.c10r.facebook.com")?.description).toBe("Facebook/Meta");
    expect(matchTracker("p59-content.icloud.com")).toBeNull();
    expect(isAppleTelemetry("xp.apple.com")).toBe(true);
    expect(isAppleTelemetry("icloud.com")).toBe(false);
  });
});

describe("parseLsofAll", () => {
  test("keeps every TCP row with its state; listeners have no remote", () => {
    const rows = parseLsofAll(LSOF_OUTPUT);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      process: "Google",
      pid: 900,
      remote: "10.0.0.9:443",
      state: "ESTABLISHED",
    });
    expect(rows[2]).toMatchObject({
      process: "rapportd",
      pid: 300,
      local: "*:49152",
      remote: "",
      state: "LISTEN",
    });
  });
});

describe("networkReport", () => {
  test("groups by destination, flags trackers and new-since-baseline, lists network listeners", async () => {
    const baselineSnapshot: Snapshot = {
      ts: 0,
      processes: {},
      destinations: ["10.0.0.9"],
      ports: [22],
      persistence: {},
      posture: {},
    };
    await saveBaseline(baselineSnapshot, 1);

    const r = await networkReport(123);
    expect(r.timestamp).toBe(123);
    expect(r.connections).toHaveLength(3);
    // Private address keeps its bare form; the unresolvable one is bare too and not in the baseline.
    expect(r.destinations.map((d) => [d.host, d.connections, d.newSinceBaseline])).toEqual([
      ["10.0.0.9", 1, false],
      ["999.999.1.1", 1, true],
    ]);
    expect(r.destinations[0].processes).toEqual(["Google"]);
    expect(r.listeners).toEqual([
      { port: 22, name: "Remote Login (SSH)" },
      { port: 39503, name: null },
    ]);
    expect(r.unavailable).toEqual([]);
  });

  test("without a baseline nothing is flagged new; a failed lsof lists nothing", async () => {
    const r = await networkReport();
    expect(r.connections.every((c) => !c.newSinceBaseline)).toBe(true);

    installFakeProbe({ lsof: () => ({ status: "timeout" }) });
    const empty = await networkReport();
    expect(empty.connections).toEqual([]);
    expect(empty.unavailable).toEqual([{ check: "connections (lsof)", reason: "timeout" }]);
  });

  test("GET /api/network refuses a forged Host and serves the contract", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getNetwork()).status).toBe(403);
    installLoopbackHeaders();
    const res = await getNetwork();
    expect(res.status).toBe(200);
    const body = parseNetwork(await res.json());
    expect(body.destinations.length).toBe(2);
    expect(body.listeners[0].port).toBe(22);
  });
});
