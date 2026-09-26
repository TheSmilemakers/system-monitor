import { finiteInt } from "./probe";

/**
 * Network throughput from interface byte counters.
 *
 * `netstat` with the `-ibn` flags prints one `<Link#n>` row per interface with cumulative
 * input and output bytes. The sampler keeps the previous counters and turns
 * the difference into KB/s. Loopback is excluded; tunnels are counted, so
 * VPN traffic can appear twice (once on the tunnel, once on the wire), which
 * is acceptable for a trend line.
 */

export interface ByteCounters {
  inBytes: number;
  outBytes: number;
}

export function parseNetstatBytes(raw: string): ByteCounters {
  let inBytes = 0;
  let outBytes = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes("<Link#")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || parts[0] === "lo0") continue;
    // ... Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    inBytes += finiteInt(parts[parts.length - 5], 0);
    outBytes += finiteInt(parts[parts.length - 2], 0);
  }
  return { inBytes, outBytes };
}

export interface NetRate {
  inKBps: number;
  outKBps: number;
}

/** Rate between two readings; a counter that went backwards (interface reset) reads as zero. */
export function netRate(prev: ByteCounters, curr: ByteCounters, dtMs: number): NetRate {
  if (dtMs <= 0) return { inKBps: 0, outKBps: 0 };
  const seconds = dtMs / 1000;
  const inKBps = Math.max(0, curr.inBytes - prev.inBytes) / 1024 / seconds;
  const outKBps = Math.max(0, curr.outBytes - prev.outBytes) / 1024 / seconds;
  return { inKBps: Math.round(inKBps * 10) / 10, outKBps: Math.round(outKBps * 10) / 10 };
}

let last: { counters: ByteCounters; at: number } | null = null;

/** The rate since the previous call, or zero on the first reading. */
export function trackNetRate(counters: ByteCounters, now: number): NetRate {
  const rate = last ? netRate(last.counters, counters, now - last.at) : { inKBps: 0, outKBps: 0 };
  last = { counters, at: now };
  return rate;
}

/** Test seam. */
export function __resetNet(): void {
  last = null;
}
