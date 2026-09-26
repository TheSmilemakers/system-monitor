import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { __resetIdentityCache } from "@/lib/identity";
import { __resetNet } from "@/lib/net";
import { __resetMachineInfo } from "@/lib/probe";
import {
  ALERT_MIN_DURATION_MS,
  HISTORY_WINDOW_MS,
  SAMPLE_MIN_INTERVAL_MS,
  __resetSampler,
  sample,
} from "@/lib/sampler";

import {
  PS_DETAILED_OUTPUT_IDLE,
  installFakeCodesign,
  installFakeProbe,
  resetSeams,
} from "./fixtures";

/**
 * The sampler's orchestration: parsing every probe into the stats shape,
 * server-cadence history, and elapsed-time alerts (M-03, M-16, M-17).
 * `tests/parsers.test.ts` covers the two parsers in isolation; this covers
 * the code that runs on every poll.
 */

const T0 = new Date("2026-09-26T00:30:00Z");

beforeEach(() => {
  __resetMachineInfo();
  __resetSampler();
  __resetIdentityCache();
  __resetNet();
  installFakeProbe();
  installFakeCodesign();
  setSystemTime(T0);
});

afterEach(() => {
  setSystemTime();
  resetSeams();
  __resetMachineInfo();
  __resetSampler();
});

describe("sample()", () => {
  test("derives every section from the fixture output", async () => {
    const s = await sample();
    expect(s.complete).toBe(true);
    expect(s.unavailable).toEqual([]);

    expect(s.cpu).toEqual({
      user: 12.5,
      system: 7.5,
      idle: 80,
      used: 20,
      model: "Apple M1 Pro",
      cores: 10,
    });
    expect(s.load).toEqual([2.1, 2.35, 2.5]);

    // (active + wired + compressor) pages × the page size read from the machine (M-16).
    expect(s.memory.totalGB).toBe(16);
    expect(s.memory.usedGB).toBe(5.3);
    expect(s.memory.wiredGB).toBe(1.5);
    expect(s.memory.compressorGB).toBe(0.8);
    expect(s.memory.percent).toBe(33);
    expect(s.memory.freeGB).toBe(10.7);

    expect(s.swap).toEqual({ totalMB: 2048, usedMB: 512, percent: 25 });
    expect(s.disk).toEqual({ total: "926Gi", used: "12Gi", available: "800Gi", percent: 2 });
    expect(s.processes.total).toBe(612);
    expect(s.processes.threads).toBe(3210);
    expect(s.processes.top.map((p) => p.pid)).toEqual([648, 637, 900, 902, 901, 903, 950]);
    expect(s.processes.top[0]).toMatchObject({
      user: "rajan",
      pid: 648,
      cpu: 72,
      mem: 0.4,
      rss: 63488 * 1024,
      command: "fileproviderd",
    });
    expect(s.uptime).toBe("18 days, 11 mins");
    expect(s.battery).toEqual({ percent: 80, charging: true });
    expect(s.timestamp).toBe(T0.getTime());
  });

  test("the page size comes from the machine, not a constant", async () => {
    installFakeProbe({
      sysctl: (args) => {
        const key = args[args.length - 1];
        if (key === "hw.pagesize") return { status: "ok", value: "4096" };
        if (key === "hw.memsize") return { status: "ok", value: "17179869184" };
        if (key === "hw.ncpu") return { status: "ok", value: "8" };
        if (key === "machdep.cpu.brand_string") return { status: "ok", value: "Intel Core i9" };
        return { status: "ok", value: "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M" };
      },
    });
    const s = await sample();
    // Same page counts, a quarter of the page size: a quarter of the memory.
    expect(s.memory.usedGB).toBe(1.3);
    expect(s.swap.percent).toBe(0);
  });

  test("a failed probe is named in `unavailable` and its section degrades to zeros", async () => {
    installFakeProbe({ top: () => ({ status: "timeout" }), df: () => ({ status: "denied" }) });
    const s = await sample();
    expect(s.complete).toBe(false);
    expect(s.unavailable).toEqual([
      { check: "cpu/load (top)", reason: "timeout" },
      { check: "disk (df)", reason: "denied" },
    ]);
    expect(s.cpu.used).toBe(0);
    expect(s.load).toEqual([0, 0, 0]);
    expect(s.disk.percent).toBe(0);
    // Unrelated sections are untouched.
    expect(s.memory.totalGB).toBe(16);
  });

  test("partial output is used, and still flagged", async () => {
    installFakeProbe({
      uptime: () => ({ status: "partial", value: " up 3 days, 2:15, 1 user", reason: "timeout" }),
    });
    const s = await sample();
    expect(s.uptime).toBe("3 days, 2:15");
    expect(s.unavailable).toEqual([{ check: "uptime", reason: "partial" }]);
  });
});

describe("history runs on a server cadence (M-03)", () => {
  test("polls faster than the minimum interval do not add points", async () => {
    await sample();
    setSystemTime(new Date(T0.getTime() + SAMPLE_MIN_INTERVAL_MS / 2));
    await sample();
    const s = await sample();
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toEqual({
      ts: T0.getTime(),
      cpu: 20,
      mem: 33,
      swap: 512,
      load: 2.1,
      net: 0,
    });
  });

  test("a new point is recorded once the interval has elapsed", async () => {
    await sample();
    setSystemTime(new Date(T0.getTime() + SAMPLE_MIN_INTERVAL_MS));
    const s = await sample();
    expect(s.history).toHaveLength(2);
  });

  test("points older than the window are dropped", async () => {
    await sample();
    setSystemTime(new Date(T0.getTime() + HISTORY_WINDOW_MS + 1));
    const s = await sample();
    expect(s.history).toHaveLength(1);
    expect(s.history[0].ts).toBe(T0.getTime() + HISTORY_WINDOW_MS + 1);
  });

  test("history is a copy, not the live buffer", async () => {
    const a = await sample();
    a.history.length = 0;
    const b = await sample();
    expect(b.history).toHaveLength(1);
  });
});

describe("alerts require sustained load by wall clock (M-03, M-17)", () => {
  test("a hot process is not an alert until it has been hot for the minimum duration", async () => {
    const first = await sample();
    expect(first.alerts).toEqual([]);

    setSystemTime(new Date(T0.getTime() + ALERT_MIN_DURATION_MS - 1));
    expect((await sample()).alerts).toEqual([]);

    setSystemTime(new Date(T0.getTime() + ALERT_MIN_DURATION_MS));
    const alerted = await sample();
    expect(alerted.alerts).toEqual([{ pid: 648, command: "fileproviderd", cpu: 72, duration: 9 }]);
  });

  test("the alert clears as soon as the process drops below the threshold", async () => {
    await sample();
    setSystemTime(new Date(T0.getTime() + ALERT_MIN_DURATION_MS));
    expect((await sample()).alerts).toHaveLength(1);

    installFakeProbe({ ps: () => ({ status: "ok", value: PS_DETAILED_OUTPUT_IDLE }) });
    setSystemTime(new Date(T0.getTime() + ALERT_MIN_DURATION_MS + 1000));
    expect((await sample()).alerts).toEqual([]);

    // Coming back hot starts the clock again.
    installFakeProbe();
    setSystemTime(new Date(T0.getTime() + ALERT_MIN_DURATION_MS + 2000));
    expect((await sample()).alerts).toEqual([]);
  });

  test("only processes at or above half a core are tracked", async () => {
    installFakeProbe({ ps: () => ({ status: "ok", value: PS_DETAILED_OUTPUT_IDLE }) });
    await sample();
    setSystemTime(new Date(T0.getTime() + ALERT_MIN_DURATION_MS * 2));
    expect((await sample()).alerts).toEqual([]);
  });
});
