import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getStats } from "@/app/api/stats/route";
import {
  __resetEnrich,
  connectionCounts,
  CONNECTIONS_TTL_MS,
  enrichProcesses,
  parseConnectionCounts,
} from "@/lib/enrich";
import { __resetIdentityCache } from "@/lib/identity";
import { __resetMonitor, monitorSettled, normalizeSnapshot } from "@/lib/monitor";
import { __resetNet } from "@/lib/net";
import { __resetPosture, updatesSettled } from "@/lib/posture";
import { __resetMachineInfo } from "@/lib/probe";
import { __resetSampler, type ProcessInfo } from "@/lib/sampler";
import { parseStats } from "@/lib/schemas";
import { writeJson } from "@/lib/store";

import {
  installFakeCodesign,
  installFakeProbe,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = Date.parse("2026-09-26T05:00:00Z");
const LSOF = [
  "COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "Google    900 rajan   45u  IPv4 0x1      0t0  TCP 10.0.0.2:55555->142.250.1.1:443 (ESTABLISHED)",
  "Google    900 rajan   46u  IPv4 0x2      0t0  TCP 10.0.0.2:55556->142.250.1.2:443 (ESTABLISHED)",
  "Slack     902 rajan   30u  IPv6 0x3      0t0  TCP [::1]:60000->[::1]:443 (ESTABLISHED)",
  "broken    x   rajan   30u  IPv6 0x3      0t0  TCP a->b (ESTABLISHED)",
  "short 1 2",
].join("\n");

const proc = (over: Partial<ProcessInfo>): ProcessInfo => ({
  user: "rajan",
  pid: 1,
  ppid: 1,
  cpu: 0,
  mem: 0,
  rss: 0,
  command: "x",
  path: "/usr/bin/x",
  elapsed: 0,
  trust: "apple",
  publisher: "Apple",
  bundleId: null,
  ...over,
});

let dir = "";
const previous = process.env.SM_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-enrich-"));
  process.env.SM_DATA_DIR = dir;
  __resetEnrich();
  __resetMonitor();
  installLoopbackHeaders();
});
afterEach(async () => {
  await monitorSettled();
  resetSeams();
  __resetEnrich();
  __resetMonitor();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("connection counts", () => {
  test("parseConnectionCounts counts established rows per pid and skips torn lines", () => {
    const counts = parseConnectionCounts(LSOF);
    expect([...counts.entries()]).toEqual([
      [900, 2],
      [902, 1],
    ]);
    expect(parseConnectionCounts("").size).toBe(0);
  });

  test("one lsof pass serves a whole TTL, then a fresh one runs", async () => {
    let calls = 0;
    installFakeProbe({
      lsof: () => {
        calls++;
        return { status: "ok", value: LSOF };
      },
    });
    expect((await connectionCounts(T0)).get(900)).toBe(2);
    expect((await connectionCounts(T0 + CONNECTIONS_TTL_MS - 1)).get(900)).toBe(2);
    expect(calls).toBe(1);
    await connectionCounts(T0 + CONNECTIONS_TTL_MS);
    expect(calls).toBe(2);
  });

  test("a failed lsof yields zero counts rather than an error", async () => {
    installFakeProbe({ lsof: () => ({ status: "timeout" }) });
    expect((await connectionCounts(T0)).size).toBe(0);
  });
});

describe("enrichProcesses", () => {
  test("attaches counts, and novelty relative to the baseline when there is one", async () => {
    installFakeProbe({ lsof: () => ({ status: "ok", value: LSOF }) });
    const list = [
      proc({ pid: 900, path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
      proc({ pid: 2000, path: "/opt/homebrew/bin/gh" }),
      proc({ pid: 0, path: "kernel_task" }),
    ];
    // No baseline yet: nothing is new.
    const before = await enrichProcesses(list, T0);
    expect(before.map((p) => [p.connections, p.newSinceBaseline])).toEqual([
      [2, false],
      [0, false],
      [0, false],
    ]);

    __resetMonitor();
    await writeJson("baseline.json", {
      createdAt: T0 - 1000,
      snapshot: normalizeSnapshot({
        ts: T0 - 1000,
        processes: {
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": "developer-id",
        },
      }),
    });
    const after = await enrichProcesses(list, T0);
    expect(after.map((p) => p.newSinceBaseline)).toEqual([false, true, false]);
  });
});

describe("GET /api/stats carries the enrichment", () => {
  beforeEach(() => {
    __resetMachineInfo();
    __resetSampler();
    __resetIdentityCache();
    __resetNet();
    __resetPosture();
    installFakeProbe({ lsof: () => ({ status: "ok", value: LSOF }) });
    installFakeCodesign();
    installLoopbackHeaders();
  });
  afterEach(async () => {
    await updatesSettled();
    __resetSampler();
  });

  test("every process has a connection count and a novelty flag; Chrome holds two", async () => {
    const res = await getStats();
    expect(res.status).toBe(200);
    const stats = parseStats(await res.json());
    const chrome = stats.processes.top.find((p) => p.pid === 900);
    expect(chrome?.connections).toBe(2);
    expect(stats.processes.top.every((p) => typeof p.newSinceBaseline === "boolean")).toBe(true);
    // The wire carries the fields, not only the parser's defaults.
    const raw = (await (await getStats()).json()) as {
      processes: { top: { pid: number; connections?: number }[] };
    };
    expect(raw.processes.top.find((p) => p.pid === 900)?.connections).toBe(2);
  });
});
