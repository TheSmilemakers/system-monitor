import { cachedPersistenceReport } from "./persistence";
import { finiteInt, isOk, probe } from "./probe";
import type { ProcessInfo } from "./sampler";

/**
 * How a process came to be running, for the inspector's identity card.
 * Three answers, tried in order: a launch agent or daemon whose program is
 * this executable (from the persistence report, cached a minute); a job in
 * the user's launchd domain that owns this pid (`launchctl list`, cached
 * half a minute); otherwise launchd on demand when the parent is pid 1, or
 * simply the parent process, which the inspector already names.
 */

export interface LaunchProvenance {
  kind: "launch-item" | "launchd" | "parent" | "unknown";
  /** The launchd label, when one names the job. */
  label: string | null;
  /** user, system-agent, system-daemon, or "user session" for a launchctl match. */
  scope: string | null;
  /** The plist, when a launch item was matched. */
  file: string | null;
}

export const LAUNCHCTL_TTL_MS = 30_000;

/** Parse `launchctl list`: "PID\tStatus\tLabel" rows; "-" means no running pid. */
export function parseLaunchctlList(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = finiteInt(parts[0], -1);
    const label = parts[2];
    if (pid > 0 && label) out.set(pid, label);
  }
  return out;
}

let listCache: { at: number; byPid: ReadonlyMap<number, string> } | null = null;
let listInFlight: Promise<ReadonlyMap<number, string>> | null = null;

export async function launchctlPids(now = Date.now()): Promise<ReadonlyMap<number, string>> {
  if (listCache && now - listCache.at < LAUNCHCTL_TTL_MS) return listCache.byPid;
  if (listInFlight) return listInFlight;
  listInFlight = (async () => {
    const res = await probe("launchctl", ["list"]);
    const byPid = isOk(res) ? parseLaunchctlList(res.value) : new Map<number, string>();
    listCache = { at: now, byPid };
    return byPid;
  })().finally(() => {
    listInFlight = null;
  });
  return listInFlight;
}

export async function launchProvenance(
  proc: Pick<ProcessInfo, "pid" | "ppid" | "path">,
  now = Date.now(),
): Promise<LaunchProvenance> {
  if (proc.path.startsWith("/")) {
    const report = await cachedPersistenceReport(now);
    const item = report.items.find((i) => i.program === proc.path);
    if (item) return { kind: "launch-item", label: item.label, scope: item.scope, file: item.file };
  }
  const label = (await launchctlPids(now)).get(proc.pid);
  if (label) return { kind: "launchd", label, scope: "user session", file: null };
  if (proc.ppid === 1) return { kind: "launchd", label: null, scope: null, file: null };
  if (proc.ppid > 1) return { kind: "parent", label: null, scope: null, file: null };
  return { kind: "unknown", label: null, scope: null, file: null };
}

/** Test seam. */
export function __resetLaunchCache(): void {
  listCache = null;
  listInFlight = null;
}
