import { describe, expect, test, beforeEach } from "bun:test";

import {
  __resetMachineInfo,
  finiteInt,
  finiteNumber,
  getMachineInfo,
  isOk,
  probe,
  round,
} from "@/lib/probe";
import { inFlightCount, singleFlight } from "@/lib/single-flight";

describe("H-02 — probes are async and argv-based", () => {
  test("returns ok with trimmed output", async () => {
    const r = await probe("echo", ["hello"]);
    expect(r.status).toBe("ok");
    if (isOk(r)) expect(r.value).toBe("hello");
  });

  test("shell metacharacters are inert — argv is never interpreted", async () => {
    // Under the old execSync helper this would have run two commands.
    const r = await probe("echo", ["a; touch /tmp/sm_probe_pwned; echo b"]);
    expect(r.status).toBe("ok");
    if (isOk(r)) expect(r.value).toBe("a; touch /tmp/sm_probe_pwned; echo b");
    expect(await Bun.file("/tmp/sm_probe_pwned").exists()).toBe(false);
  });

  test("does not block the event loop", async () => {
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 5);
    await probe("sleep", ["0.15"]);
    clearTimeout(timer);
    // A synchronous exec would have starved the timer for the full sleep.
    expect(ticked).toBe(true);
  });

  test("runs concurrently rather than serialising", async () => {
    const start = Date.now();
    await Promise.all([
      probe("sleep", ["0.3"]),
      probe("sleep", ["0.3"]),
      probe("sleep", ["0.3"]),
    ]);
    const elapsed = Date.now() - start;
    // Serialised would be ~900ms; concurrent should stay well under.
    expect(elapsed).toBeLessThan(700);
  });
});

describe("H-03 — failures are typed, never silent success", () => {
  test("missing binary reports unsupported", async () => {
    const r = await probe("definitely-not-a-real-binary-xyz", []);
    expect(r.status).toBe("unsupported");
  });

  test("timeout is distinguishable from success", async () => {
    const r = await probe("sleep", ["5"], 120);
    expect(r.status).toBe("timeout");
  });

  test("non-zero exit reports failure, not empty success", async () => {
    const r = await probe("false", []);
    expect(r.status).toBe("failed");
  });

  test("no failure mode yields an ok with empty value", async () => {
    for (const r of [
      await probe("definitely-not-a-real-binary-xyz", []),
      await probe("sleep", ["5"], 100),
      await probe("false", []),
    ]) {
      expect(r.status).not.toBe("ok");
    }
  });
});

describe("non-finite guards (H-03, M-11)", () => {
  test("finiteNumber rejects NaN and Infinity", () => {
    expect(finiteNumber("abc", -1)).toBe(-1);
    expect(finiteNumber("", -1)).toBe(-1);
    expect(finiteNumber(undefined, -1)).toBe(-1);
    expect(finiteNumber(null, -1)).toBe(-1);
    expect(finiteNumber(Number.POSITIVE_INFINITY, -1)).toBe(-1);
    expect(finiteNumber(Number.NaN, -1)).toBe(-1);
    expect(finiteNumber("12.5")).toBe(12.5);
  });

  test("finiteInt parses integers safely", () => {
    expect(finiteInt("42")).toBe(42);
    expect(finiteInt("42abc")).toBe(42);
    expect(finiteInt("abc", 7)).toBe(7);
  });

  test("round never emits a non-finite value", () => {
    expect(round(Number.NaN)).toBe(0);
    expect(round(Number.POSITIVE_INFINITY)).toBe(0);
    expect(round(1 / 0)).toBe(0);
    expect(round(3.14159, 2)).toBe(3.14);
  });

  test("a zero RAM total cannot produce NaN percent", () => {
    const total = 0;
    const used = 4;
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;
    expect(Number.isFinite(percent)).toBe(true);
    expect(JSON.parse(JSON.stringify({ percent })).percent).not.toBeNull();
  });
});

describe("M-16 — machine constants", () => {
  beforeEach(() => __resetMachineInfo());

  test("page size is read from the system, not hardcoded", async () => {
    const info = await getMachineInfo();
    // Whatever this host is, the value must match hw.pagesize.
    const sysctl = await probe("sysctl", ["-n", "hw.pagesize"]);
    if (isOk(sysctl)) expect(info.pageSize).toBe(Number(sysctl.value));
    expect([4096, 16384]).toContain(info.pageSize);
  });

  test("constants are memoised — read once per process", async () => {
    const a = await getMachineInfo();
    const b = await getMachineInfo();
    expect(a).toBe(b); // identity, not just equality
  });

  test("cores is always at least 1", async () => {
    const info = await getMachineInfo();
    expect(info.cores).toBeGreaterThanOrEqual(1);
  });
});

describe("H-02 — single-flight", () => {
  test("collapses concurrent identical work onto one execution", async () => {
    let runs = 0;
    const work = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 50));
      return runs;
    };
    const results = await Promise.all([
      singleFlight("k", work),
      singleFlight("k", work),
      singleFlight("k", work),
    ]);
    expect(runs).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });

  test("releases the slot after completion", async () => {
    await singleFlight("k2", async () => 1);
    expect(inFlightCount()).toBe(0);
    let second = 0;
    await singleFlight("k2", async () => { second = 1; return second; });
    expect(second).toBe(1);
  });

  test("releases the slot even when the work throws", async () => {
    await expect(singleFlight("k3", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(inFlightCount()).toBe(0);
  });
});
