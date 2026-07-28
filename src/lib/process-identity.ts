import { probe } from "./probe";

/**
 * Process identity for safe signalling (M-01).
 *
 * A PID alone is not an identity: PIDs are reused, so a check-then-signal
 * sequence can target a different process than the one inspected. Pairing the
 * PID with its start time (`lstart`, second granularity) makes the reference
 * stable across the SIGTERM grace period.
 */
export interface ProcessIdentity {
  pid: number;
  user: string;
  /** Raw `lstart` string — compared verbatim, never parsed. */
  startedAt: string;
}

export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const res = await probe("ps", ["-o", "user=,lstart=", "-p", String(pid)]);
  if (res.status !== "ok" || res.value.length === 0) return null;

  const line = res.value.split("\n")[0]?.trim();
  if (!line) return null;

  const parts = line.split(/\s+/);
  const user = parts[0];
  const startedAt = parts.slice(1).join(" ");
  if (!user || !startedAt) return null;

  return { pid, user, startedAt };
}

export function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.user === b.user && a.startedAt === b.startedAt;
}
