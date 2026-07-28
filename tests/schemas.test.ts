import { describe, expect, test } from "bun:test";

import {
  ContractError,
  parseCleanup,
  parsePrivacy,
  parseScan,
  parseStats,
} from "@/lib/schemas";

const validStats = {
  complete: true,
  unavailable: [],
  cpu: { user: 10, system: 5, idle: 85, used: 15, model: "Apple M3", cores: 8 },
  load: [1.5, 1.2, 1.0],
  memory: { totalGB: 16, usedGB: 8, freeGB: 8, percent: 50, wiredGB: 2, compressorGB: 1 },
  swap: { totalMB: 1024, usedMB: 0, percent: 0 },
  disk: { total: "500G", used: "250G", available: "250G", percent: 50 },
  processes: { total: 400, threads: 2000, top: [] },
  uptime: "3 days",
  battery: { percent: 80, charging: true },
  history: [],
  alerts: [],
  timestamp: 1,
};

describe("M-11 — stats contract", () => {
  test("accepts a well-formed payload", () => {
    expect(parseStats(validStats).cpu.used).toBe(15);
  });

  test("rejects a non-object", () => {
    for (const v of [null, undefined, 42, "x", []]) {
      expect(() => parseStats(v)).toThrow(ContractError);
    }
  });

  test("rejects a missing section", () => {
    const { memory: _omitted, ...rest } = validStats;
    void _omitted;
    expect(() => parseStats(rest)).toThrow(ContractError);
  });

  /**
   * The historical crash: fail-open collectors produced NaN, which serialised
   * as null, and the dashboard called .toFixed() on it.
   */
  test("rejects null where a finite number is required", () => {
    expect(() => parseStats({ ...validStats, cpu: { ...validStats.cpu, used: null } })).toThrow(ContractError);
    expect(() => parseStats({ ...validStats, memory: { ...validStats.memory, percent: null } })).toThrow(ContractError);
  });

  test("rejects a short or non-numeric load array", () => {
    expect(() => parseStats({ ...validStats, load: [1, 2] })).toThrow(ContractError);
    expect(() => parseStats({ ...validStats, load: [null, null, null] })).toThrow(ContractError);
    expect(() => parseStats({ ...validStats, load: "1.5" })).toThrow(ContractError);
  });

  test("load always yields callable numbers", () => {
    const parsed = parseStats(validStats);
    expect(() => parsed.load[0].toFixed(1)).not.toThrow();
    expect(parsed.load[0].toFixed(1)).toBe("1.5");
  });

  test("drops malformed history and alert entries rather than trusting them", () => {
    const parsed = parseStats({
      ...validStats,
      history: [{ ts: 1, cpu: 1, mem: 1, swap: 1, load: 1 }, { ts: null }, "nope"],
      alerts: [{ pid: 1, command: "x", cpu: 1, duration: 1 }, { pid: null }],
    });
    expect(parsed.history).toHaveLength(1);
    expect(parsed.alerts).toHaveLength(1);
  });

  test("tolerates an absent battery", () => {
    expect(parseStats({ ...validStats, battery: null }).battery).toBeNull();
  });
});

describe("M-11 / H-03 — scores are nullable in the contract", () => {
  test("a null health score survives parsing as null, not 0", () => {
    const parsed = parseScan({ complete: false, healthScore: null, unavailable: [], findings: [], summary: null, timestamp: 1 });
    expect(parsed.healthScore).toBeNull();
    expect(parsed.complete).toBe(false);
  });

  test("a null privacy score survives parsing as null", () => {
    const parsed = parsePrivacy({ complete: false, privacyScore: null, unavailable: [], findings: [], connectionCount: 0, resolvedCount: 0, unknownCount: 0, trackerCount: 0, timestamp: 1 });
    expect(parsed.privacyScore).toBeNull();
  });

  test("unknown severities degrade to info rather than throwing", () => {
    const parsed = parseScan({
      complete: true, healthScore: 90, unavailable: [], summary: null, timestamp: 1,
      findings: [{ severity: "apocalyptic", category: "X", title: "T", detail: "", processes: [], recommendation: "" }],
    });
    expect(parsed.findings[0].severity).toBe("info");
  });
});

describe("M-11 — cleanup contract carries ids, never commands", () => {
  test("parses items and preserves requiresRoot", () => {
    const parsed = parseCleanup({
      complete: true, unavailable: [], totalSize: 100, totalFormatted: "100 B", timestamp: 1,
      items: [{
        id: "user-caches", category: "Caches", name: "App Caches", path: "/x",
        size: 100, sizeFormatted: "100 B", fileCount: 5, description: "d",
        risk: "low", requiresRoot: true,
      }],
    });
    expect(parsed.items[0].id).toBe("user-caches");
    expect(parsed.items[0].requiresRoot).toBe(true);
  });

  test("a null file count is preserved rather than coerced to 0", () => {
    const parsed = parseCleanup({
      complete: false, unavailable: [], totalSize: 0, totalFormatted: "0 B", timestamp: 1,
      items: [{ id: "a", name: "A", path: "/x", size: 1, fileCount: null }],
    });
    expect(parsed.items[0].fileCount).toBeNull();
  });

  test("items lacking an id are discarded", () => {
    const parsed = parseCleanup({ items: [{ size: 1 }, { id: "ok", size: 2 }], timestamp: 1 });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe("ok");
  });

  test("an unrecognised risk degrades to the most cautious value", () => {
    const parsed = parseCleanup({ items: [{ id: "a", size: 1, risk: "totally-safe" }], timestamp: 1 });
    expect(parsed.items[0].risk).toBe("medium");
  });
});
