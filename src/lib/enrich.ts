import { loadBaseline } from "./monitor";
import { finiteInt, hasValue, probe } from "./probe";
import type { ProcessInfo } from "./sampler";

/**
 * What the table shows beyond the sample: how many established TCP
 * connections each process holds, and whether its executable was absent
 * from the baseline. The connection count comes from one lsof pass cached
 * for thirty seconds, so a five-second cadence costs one lsof every sixth
 * sample and every tab shares it.
 */

export interface EnrichedProcess extends ProcessInfo {
  connections: number;
  newSinceBaseline: boolean;
}

export const CONNECTIONS_TTL_MS = 30_000;

let cache: { at: number; counts: ReadonlyMap<number, number> } | null = null;
let inFlight: Promise<ReadonlyMap<number, number>> | null = null;

/** Parse `lsof -nP -iTCP -sTCP:ESTABLISHED` into connections per pid. */
export function parseConnectionCounts(raw: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of raw.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = finiteInt(parts[1], -1);
    if (pid < 0) continue;
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  return counts;
}

export async function connectionCounts(now = Date.now()): Promise<ReadonlyMap<number, number>> {
  if (cache && now - cache.at < CONNECTIONS_TTL_MS) return cache.counts;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await probe("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED"], 15_000);
    const counts = hasValue(res) ? parseConnectionCounts(res.value) : new Map<number, number>();
    cache = { at: now, counts };
    return counts;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function enrichProcesses(
  list: readonly ProcessInfo[],
  now = Date.now(),
): Promise<EnrichedProcess[]> {
  const [counts, baseline] = await Promise.all([connectionCounts(now), loadBaseline()]);
  const known = baseline?.snapshot.processes ?? null;
  return list.map((p) => ({
    ...p,
    connections: counts.get(p.pid) ?? 0,
    newSinceBaseline: known !== null && p.path.startsWith("/") && !(p.path in known),
  }));
}

/** Test seam. */
export function __resetEnrich(): void {
  cache = null;
  inFlight = null;
}
