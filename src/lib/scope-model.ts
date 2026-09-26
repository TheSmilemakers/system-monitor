import type { HistoryPoint, ProcessAlert } from "./schemas";

/**
 * Geometry and wording for the vector scope, kept free of the canvas so the
 * rules are unit-tested: which traces exist, how each value maps to the
 * screen, where alert ticks sit on the time axis, and the text equivalent.
 */

export type TraceId = "cpu" | "mem" | "load" | "net";

export interface ScopeTrace {
  id: TraceId;
  label: string;
  /** CSS colour token for the trace. */
  color: string;
  values: number[];
  /** Full-scale value; values above it are clipped to the top. */
  max: number;
  unit: string;
  /** Current (last) value, formatted. */
  now: string;
  /** Peak over the window, formatted. */
  peak: string;
}

export const NET_FLOOR_KBPS = 64;

const fmt = (v: number, unit: string): string =>
  unit === "KB/s"
    ? v >= 1024
      ? `${(v / 1024).toFixed(1)} MB/s`
      : `${Math.round(v)} KB/s`
    : `${v.toFixed(unit === "%" ? 0 : 1)}${unit}`;

export function buildTraces(history: readonly HistoryPoint[], cores: number): ScopeTrace[] {
  const pick = (f: (h: HistoryPoint) => number) => history.map(f);
  const cpu = pick((h) => h.cpu);
  const mem = pick((h) => h.mem);
  const load = pick((h) => h.load);
  const net = pick((h) => h.net);
  const loadMax = Math.max(1, cores) * 2;
  const netMax = Math.max(NET_FLOOR_KBPS, ...net);
  const make = (
    id: TraceId,
    label: string,
    color: string,
    values: number[],
    max: number,
    unit: string,
  ): ScopeTrace => ({
    id,
    label,
    color,
    values,
    max,
    unit,
    now: values.length ? fmt(values[values.length - 1], unit) : "",
    peak: values.length ? fmt(Math.max(...values), unit) : "",
  });
  return [
    make("cpu", "CPU", "var(--phosphor)", cpu, 100, "%"),
    make("mem", "Memory", "var(--amber)", mem, 100, "%"),
    make("load", "Load", "var(--ivory)", load, loadMax, ""),
    make("net", "Network", "var(--cathode)", net, netMax, "KB/s"),
  ];
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Screen points for a trace. Time runs left to right across the full width;
 * the newest sample sits at the right edge. A single sample is a dot at the
 * right edge.
 */
export function tracePoints(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
  pad = 2,
): Point[] {
  const n = values.length;
  if (n === 0) return [];
  const w = Math.max(1, width - pad * 2);
  const h = Math.max(1, height - pad * 2);
  const scale = max > 0 ? max : 1;
  return values.map((v, i) => ({
    x: n === 1 ? pad + w : pad + (i / (n - 1)) * w,
    y: pad + h - (Math.min(Math.max(v, 0), scale) / scale) * h,
  }));
}

/**
 * X positions of alert onsets within the window, given the alert's duration
 * and the sample timestamps. Alerts that began before the window sit at the
 * left edge.
 */
export function alertTicks(
  alerts: readonly ProcessAlert[],
  history: readonly HistoryPoint[],
  width: number,
  now: number,
  pad = 2,
): { x: number; label: string }[] {
  if (history.length < 2) return [];
  const start = history[0].ts;
  const end = history[history.length - 1].ts;
  const span = Math.max(1, end - start);
  const w = Math.max(1, width - pad * 2);
  return alerts.map((a) => {
    const onset = now - a.duration * 1000;
    const t = Math.min(Math.max((onset - start) / span, 0), 1);
    return { x: pad + t * w, label: `${a.command} (PID ${a.pid}) went hot` };
  });
}

/** The text equivalent, so the trend is not conveyed by shape and colour alone. */
export function describeScope(traces: readonly ScopeTrace[], samples: number): string {
  if (samples < 2) return "Scope: collecting history.";
  const parts = traces.map((t) => `${t.label} now ${t.now}, peak ${t.peak}`);
  return `Scope over the last ${samples} samples. ${parts.join(". ")}.`;
}
