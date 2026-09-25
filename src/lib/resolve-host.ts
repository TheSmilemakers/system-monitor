import dns from "node:dns/promises";

/**
 * Reverse-DNS with a short-lived cache (H-04).
 *
 * `lsof -i -nP` deliberately emits numeric addresses, so matching domain
 * substrings against its output could never match — the tracker detector was
 * structurally incapable of firing. Names are resolved here instead, and an
 * address that will not resolve is reported as `unknown`, never as clean.
 */

export type Resolution = { status: "resolved"; hostnames: string[] } | { status: "unknown" };

interface Entry {
  value: Resolution;
  expires: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, Entry>();
const MAX_CONCURRENCY = 16;

function isPrivate(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    ip === "::1" ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fe80:") ||
    ip.startsWith("169.254.")
  );
}

export async function resolveHost(ip: string, now = Date.now()): Promise<Resolution> {
  if (isPrivate(ip)) return { status: "resolved", hostnames: ["<local network>"] };

  const hit = cache.get(ip);
  if (hit && hit.expires > now) return hit.value;

  let value: Resolution;
  try {
    const hostnames = await dns.reverse(ip);
    value = hostnames.length > 0 ? { status: "resolved", hostnames } : { status: "unknown" };
  } catch {
    value = { status: "unknown" };
  }

  cache.set(ip, { value, expires: now + TTL_MS });
  return value;
}

/** Resolve many addresses with bounded concurrency. */
export async function resolveAll(ips: readonly string[]): Promise<Map<string, Resolution>> {
  const unique = [...new Set(ips)];
  const out = new Map<string, Resolution>();

  for (let i = 0; i < unique.length; i += MAX_CONCURRENCY) {
    const batch = unique.slice(i, i + MAX_CONCURRENCY);
    const results = await Promise.all(batch.map((ip) => resolveHost(ip)));
    batch.forEach((ip, j) => out.set(ip, results[j]));
  }
  return out;
}

/** Parse the remote address out of an lsof NAME column such as `a:b->c:d`. */
export function remoteAddressOf(name: string): string | null {
  const arrow = name.split("->")[1];
  if (!arrow) return null;
  const v6 = arrow.match(/^\[([^\]]+)\]:/);
  if (v6) return v6[1];
  const host = arrow.split(":")[0];
  return host || null;
}

export function __resetResolveCache(): void {
  cache.clear();
}
