import { describe, expect, test } from "bun:test";

import {
  alertTicks,
  buildTraces,
  describeScope,
  NET_FLOOR_KBPS,
  tracePoints,
} from "@/lib/scope-model";
import type { HistoryPoint } from "@/lib/schemas";

const point = (i: number, over: Partial<HistoryPoint> = {}): HistoryPoint => ({
  ts: 1_000_000 + i * 5000,
  cpu: 10 + i,
  mem: 50,
  swap: 0,
  load: 2,
  net: 10,
  ...over,
});

describe("buildTraces", () => {
  test("four traces with sensible scales and formatted current and peak values", () => {
    const history = [point(0), point(1, { cpu: 90, net: 2048 }), point(2, { net: 512 })];
    const traces = buildTraces(history, 10);
    expect(traces.map((t) => t.id)).toEqual(["cpu", "mem", "load", "net"]);
    const cpu = traces[0];
    expect(cpu.max).toBe(100);
    expect(cpu.now).toBe("12%");
    expect(cpu.peak).toBe("90%");
    expect(traces[2].max).toBe(20); // load: twice the core count
    expect(traces[2].now).toBe("2.0");
    const net = traces[3];
    expect(net.max).toBe(2048); // auto-scaled to the window's peak
    expect(net.now).toBe("512 KB/s");
    expect(net.peak).toBe("2.0 MB/s");
  });

  test("the network scale never drops below the floor, and empty history yields empty labels", () => {
    expect(buildTraces([point(0, { net: 3 })], 4)[3].max).toBe(NET_FLOOR_KBPS);
    const empty = buildTraces([], 4);
    expect(empty[0].now).toBe("");
    expect(empty[0].values).toEqual([]);
  });
});

describe("tracePoints", () => {
  test("spreads samples across the width and inverts the y axis", () => {
    const pts = tracePoints([0, 50, 100], 100, 102, 52, 1);
    expect(pts.map((p) => Math.round(p.x))).toEqual([1, 51, 101]);
    expect(pts.map((p) => Math.round(p.y))).toEqual([51, 26, 1]);
  });

  test("clips values above the scale and puts a single sample at the right edge", () => {
    expect(tracePoints([250], 100, 100, 50, 0)[0]).toEqual({ x: 100, y: 0 });
    expect(tracePoints([-5], 100, 100, 50, 0)[0].y).toBe(50);
    expect(tracePoints([], 100, 100, 50)).toEqual([]);
  });
});

describe("alertTicks", () => {
  const history = [point(0), point(1), point(2), point(3)]; // 15 s window
  const now = history[3].ts;

  test("maps an alert onset to its position in the window", () => {
    const ticks = alertTicks(
      [{ pid: 1, command: "x", cpu: 90, duration: 5 }],
      history,
      152,
      now,
      1,
    );
    // Onset at now - 5 s = two thirds of the way across.
    expect(Math.round(ticks[0].x)).toBe(101);
    expect(ticks[0].label).toBe("x (PID 1) went hot");
  });

  test("alerts older than the window pin to the left edge; short history yields none", () => {
    const ticks = alertTicks(
      [{ pid: 1, command: "x", cpu: 90, duration: 3600 }],
      history,
      152,
      now,
      1,
    );
    expect(ticks[0].x).toBe(1);
    expect(
      alertTicks([{ pid: 1, command: "x", cpu: 90, duration: 1 }], [point(0)], 100, now),
    ).toEqual([]);
  });
});

describe("describeScope", () => {
  test("reads out every trace once there are two samples", () => {
    const traces = buildTraces([point(0), point(1)], 8);
    expect(describeScope(traces, 2)).toBe(
      "Scope over the last 2 samples. CPU now 11%, peak 11%. Memory now 50%, peak 50%. Load now 2.0, peak 2.0. Network now 10 KB/s, peak 10 KB/s.",
    );
    expect(describeScope(traces, 1)).toBe("Scope: collecting history.");
  });
});
