import { launchProvenance, type LaunchProvenance } from "./launch";
import { finiteInt, finiteNumber, hasValue, isOk, probe, type ProbeStatus } from "./probe";
import { remoteAddressOf, resolveAll } from "./resolve-host";
import { lastProcesses, processHistory, type ProcessPoint } from "./sampler";

/**
 * Live detail for one process, for the inspector: state and priority, thread
 * count and energy impact, open files, network connections with resolved
 * hosts, the recent CPU and memory trace from the sampler's ring buffer, and
 * how the process was launched (see ./launch.ts).
 * Every probe is scoped to the pid and typed; a probe that cannot run is
 * reported in `unavailable` rather than shown as zero.
 */

export interface Connection {
  proto: string;
  local: string;
  remote: string;
  host: string | null;
  state: string;
}

export interface ProcessDetailReport {
  pid: number;
  alive: boolean;
  /** True when the process is stopped (SIGSTOP), shown by ps state "T". */
  suspended: boolean;
  nice: number;
  threads: number | null;
  /** top's POWER column: Apple's energy-impact figure, unitless. */
  energy: number | null;
  openFiles: number | null;
  connections: Connection[];
  history: ProcessPoint[];
  launch: LaunchProvenance;
  unavailable: { check: string; reason: ProbeStatus }[];
  timestamp: number;
}

/** Parse `top -l 1 -pid N -stats pid,th,power,cpu,mem`. */
export function parseTopPid(raw: string, pid: number): { threads: number; energy: number } | null {
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== String(pid) || parts.length < 3) continue;
    const threads = finiteInt(parts[1].split("/")[0], 0);
    return { threads, energy: finiteNumber(parts[2], 0) };
  }
  return null;
}

/** Parse `lsof -a -nP -i -p N` rows into connections (without hosts). */
export function parseLsofConnections(raw: string): Omit<Connection, "host">[] {
  const out: Omit<Connection, "host">[] = [];
  for (const line of raw.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const proto = parts[7];
    const name = parts[8];
    const state = (parts[9] ?? "").replace(/^\(|\)$/g, "");
    const [local, remote = ""] = name.split("->");
    out.push({ proto, local, remote, state });
  }
  return out;
}

export async function processDetail(pid: number, now = Date.now()): Promise<ProcessDetailReport> {
  const [stateRes, topRes, connRes, filesRes] = await Promise.all([
    probe("ps", ["-o", "stat=,nice=,ppid=", "-p", String(pid)]),
    probe("top", ["-l", "1", "-pid", String(pid), "-stats", "pid,th,power,cpu,mem"], 8_000),
    probe("lsof", ["-a", "-nP", "-i", "-p", String(pid)]),
    probe("lsof", ["-p", String(pid)], 8_000),
  ]);

  const unavailable: ProcessDetailReport["unavailable"] = [];
  const note = (check: string, status: ProbeStatus) => {
    if (status !== "ok") unavailable.push({ check, reason: status });
  };

  // ps: an empty result means the process is gone.
  const stateLine = isOk(stateRes) ? stateRes.value.trim() : "";
  const alive = stateLine.length > 0;
  const stateParts = stateLine.split(/\s+/);
  const suspended = alive && /^T/.test(stateParts[0] ?? "");
  const nice = alive ? finiteInt(stateParts[1], 0) : 0;
  if (!isOk(stateRes)) note("process state (ps)", stateRes.status);

  const top = hasValue(topRes) ? parseTopPid(topRes.value, pid) : null;
  if (!hasValue(topRes)) note("threads and energy (top)", topRes.status);

  // lsof exits non-zero when a process has no matching files; treat "no rows" as empty, not failed.
  const rawConns = hasValue(connRes) ? parseLsofConnections(connRes.value) : [];
  if (!hasValue(connRes) && connRes.status !== "failed") note("connections (lsof)", connRes.status);
  const remotes = rawConns
    .map((c) => remoteAddressOf(`${c.local}->${c.remote}`))
    .filter((a): a is string => a !== null);
  const resolved = await resolveAll(remotes);
  const connections: Connection[] = rawConns.map((c) => {
    const addr = remoteAddressOf(`${c.local}->${c.remote}`);
    const r = addr ? resolved.get(addr) : undefined;
    return { ...c, host: r && r.status === "resolved" ? (r.hostnames[0] ?? null) : null };
  });

  const known = lastProcesses().find((p) => p.pid === pid);
  const launch: LaunchProvenance = known
    ? await launchProvenance(known, now)
    : { kind: "unknown", label: null, scope: null, file: null };

  let openFiles: number | null = null;
  if (hasValue(filesRes)) {
    openFiles = Math.max(0, filesRes.value.split("\n").filter(Boolean).length - 1);
  } else if (filesRes.status !== "failed") {
    note("open files (lsof)", filesRes.status);
  }

  return {
    pid,
    alive,
    suspended,
    nice,
    threads: top?.threads ?? null,
    energy: top?.energy ?? null,
    openFiles,
    connections,
    history: processHistory(pid),
    launch,
    unavailable,
    timestamp: now,
  };
}
