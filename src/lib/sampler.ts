import os from "node:os";

import { attachExecutablePaths } from "./exec-path";
import { identityFor, parseElapsed, type TrustState } from "./identity";
import { parseNetstatBytes, trackNetRate } from "./net";
import {
  finiteInt,
  finiteNumber,
  getMachineInfo,
  hasValue,
  probe,
  round,
  type ProbeStatus,
} from "./probe";

/**
 * Server-owned sampling for /api/stats.
 *
 * History and hot-process alerts are driven by a monotonic server cadence, not
 * by how often a browser happens to poll. Previously both were incremented once
 * per request, so "5 minutes of history" meant ~100 s at a 1 s interval, ~16.7
 * minutes at 10 s, and halved again with a second tab open (M-03).
 */

export const SAMPLE_MIN_INTERVAL_MS = 1_000;
export const HISTORY_WINDOW_MS = 5 * 60 * 1_000;
export const CPU_ALERT_THRESHOLD_PER_CORE = 0.5; // fraction of one core
export const ALERT_MIN_DURATION_MS = 9_000;
/** Rows sent per sample. The whole table is sortable client-side. */
export const PROCESS_LIMIT = 1_500;

export interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
  swap: number;
  load: number;
  /** Total network throughput, KB/s in plus out. */
  net: number;
}

export interface ProcessInfo {
  user: string;
  pid: number;
  ppid: number;
  /** Percent of ONE core, as reported by ps (may exceed 100) — see M-17. */
  cpu: number;
  mem: number;
  rss: number;
  /** Display name: the executable's basename. */
  command: string;
  /** Absolute executable path when ps reports one; otherwise the bare name. */
  path: string;
  /** Seconds since the process started, from ps ELAPSED. */
  elapsed: number;
  trust: TrustState;
  publisher: string | null;
  bundleId: string | null;
}

export interface ProcessAlert {
  pid: number;
  command: string;
  cpu: number;
  /** Seconds the process has been continuously hot, by wall clock. */
  duration: number;
}

interface HotEntry {
  pid: number;
  command: string;
  cpu: number;
  firstSeen: number;
  startedAt: string | null;
}

const history: HistoryPoint[] = [];
const hot = new Map<number, HotEntry>();

let lastTop: ProcessInfo[] = [];

/** The process list from the most recent sample; empty before the first. */
export function lastProcesses(): ProcessInfo[] {
  return lastTop;
}

/** Per-process trace for the inspector. Keyed by pid and approximate start time so PID reuse cannot splice histories. */
export interface ProcessPoint {
  ts: number;
  cpu: number;
  mem: number;
}
interface ProcessTrace {
  /** Implied start time (now minus elapsed). Compared with a tolerance, not bucketed. */
  startAt: number;
  points: ProcessPoint[];
}
/** ps reports elapsed to the second and sampling has latency; anything closer than this is the same process. */
const START_TOLERANCE_MS = 15_000;
export const PROCESS_TRACE_POINTS = 60;
const traces = new Map<number, ProcessTrace>();

function recordProcessTraces(rows: readonly ProcessInfo[], now: number): void {
  const seen = new Set<number>();
  for (const p of rows) {
    seen.add(p.pid);
    const startAt = now - p.elapsed * 1000;
    let trace = traces.get(p.pid);
    if (!trace || Math.abs(trace.startAt - startAt) > START_TOLERANCE_MS) {
      trace = { startAt, points: [] };
      traces.set(p.pid, trace);
    }
    // Compare step to step, so second-granularity jitter never accumulates into a reset.
    trace.startAt = startAt;
    trace.points.push({ ts: now, cpu: p.cpu, mem: p.mem });
    if (trace.points.length > PROCESS_TRACE_POINTS) trace.points.shift();
  }
  for (const pid of [...traces.keys()]) if (!seen.has(pid)) traces.delete(pid);
}

/** The recent CPU and memory trace for a pid, oldest first. Empty when unknown. */
export function processHistory(pid: number): ProcessPoint[] {
  return [...(traces.get(pid)?.points ?? [])];
}

export interface StatsSample {
  complete: boolean;
  unavailable: { check: string; reason: ProbeStatus }[];
  cpu: { user: number; system: number; idle: number; used: number; model: string; cores: number };
  load: number[];
  memory: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    percent: number;
    wiredGB: number;
    compressorGB: number;
  };
  swap: { totalMB: number; usedMB: number; percent: number };
  disk: { total: string; used: string; available: string; percent: number };
  net: { inKBps: number; outKBps: number };
  processes: { total: number; threads: number; top: ProcessInfo[] };
  uptime: string;
  /** The account this server runs as; the client uses it for the "mine" filter. */
  currentUser: string;
  battery: { percent: number; charging: boolean } | null;
  history: HistoryPoint[];
  alerts: ProcessAlert[];
  timestamp: number;
}

/** The ps columns the sampler asks for, in order. `comm` is last because it may contain spaces. */
export const PS_COLUMNS = "user=,pid=,ppid=,%cpu=,%mem=,rss=,etime=,comm=";

/** Basename of an executable path, or the name itself when there is no path. */
export function displayName(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  return base || "unknown";
}

/**
 * Parse `ps -axwwo user=,pid=,ppid=,%cpu=,%mem=,rss=,etime=,comm=` output.
 * Exported for parser tests.
 */
export function parsePsDetailed(raw: string, limit = PROCESS_LIMIT): ProcessInfo[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const path = parts.slice(7).join(" ");
      const identity = identityFor(path);
      return {
        user: parts[0] ?? "?",
        pid: finiteInt(parts[1], 0),
        ppid: finiteInt(parts[2], 0),
        cpu: finiteNumber(parts[3], 0),
        mem: finiteNumber(parts[4], 0),
        rss: finiteInt(parts[5], 0) * 1024,
        command: displayName(path),
        path,
        elapsed: parseElapsed(parts[6] ?? ""),
        trust: identity.trust,
        publisher: identity.publisher,
        bundleId: identity.bundleId,
      };
    })
    .filter((p) => p.pid > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
}

/**
 * Parse `ps aux` output into structured rows. Used by the scan and privacy
 * routes, which need the full argument list. Exported for parser tests.
 */
export function parsePsAux(
  raw: string,
  limit = 20,
): Omit<ProcessInfo, "ppid" | "path" | "elapsed" | "trust" | "publisher" | "bundleId">[] {
  return raw
    .split("\n")
    .slice(1) // header
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const command = parts.slice(10).join(" ");
      const shortName =
        command.match(/\/([^/]+?)(\s|$)/)?.[1]?.replace(/ Helper.*$/, "") ||
        command.substring(0, 40) ||
        "unknown";
      return {
        user: parts[0] ?? "?",
        pid: finiteInt(parts[1], 0),
        cpu: finiteNumber(parts[2], 0),
        mem: finiteNumber(parts[3], 0),
        rss: finiteInt(parts[5], 0) * 1024,
        command: shortName,
      };
    })
    .filter((p) => p.pid > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
}

/** Parse `vm_stat` page buckets. Exported for parser tests. */
export function parseVmStat(raw: string, label: string): number {
  const m = raw.match(new RegExp(`${label}:\\s+(\\d+)`));
  return m ? finiteInt(m[1], 0) : 0;
}

export async function sample(): Promise<StatsSample> {
  const machine = await getMachineInfo();

  const [topRes, vmRes, swapRes, dfRes, psRes, battRes, upRes, netRes] = await Promise.all([
    probe("top", ["-l", "1", "-n", "0", "-s", "0"], 8_000),
    probe("vm_stat", []),
    probe("sysctl", ["vm.swapusage"]),
    probe("df", ["-h", "/"]),
    probe("ps", ["-axwwo", PS_COLUMNS], 8_000),
    probe("pmset", ["-g", "batt"]),
    probe("uptime", []),
    probe("netstat", ["-ibn"]),
  ]);

  const unavailable: { check: string; reason: ProbeStatus }[] = [];
  const note = (check: string, status: ProbeStatus) => {
    if (status !== "ok") unavailable.push({ check, reason: status });
  };
  note("cpu/load (top)", topRes.status);
  note("memory (vm_stat)", vmRes.status);
  note("swap (sysctl)", swapRes.status);
  note("disk (df)", dfRes.status);
  note("processes (ps)", psRes.status);
  note("battery (pmset)", battRes.status);
  note("uptime", upRes.status);
  note("network (netstat)", netRes.status);

  // --- CPU + load ---
  const topOut = hasValue(topRes) ? topRes.value : "";
  const loadMatch = topOut.match(/Load Avg:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  const cpuMatch = topOut.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/);
  const procMatch = topOut.match(/Processes:\s*(\d+) total/);
  const threadMatch = topOut.match(/(\d+) threads/);

  const load = loadMatch
    ? [finiteNumber(loadMatch[1]), finiteNumber(loadMatch[2]), finiteNumber(loadMatch[3])]
    : [0, 0, 0];
  const cpuUser = cpuMatch ? finiteNumber(cpuMatch[1]) : 0;
  const cpuSys = cpuMatch ? finiteNumber(cpuMatch[2]) : 0;
  const cpuIdle = cpuMatch ? finiteNumber(cpuMatch[3]) : 0;
  const cpuUsed = cpuUser + cpuSys;

  // --- Memory (page size read from the machine, not hardcoded — M-16) ---
  const vm = hasValue(vmRes) ? vmRes.value : "";
  const pageSize = machine.pageSize;
  const pagesActive = parseVmStat(vm, "Pages active");
  const pagesWired = parseVmStat(vm, "Pages wired down");
  const pagesCompressor = parseVmStat(vm, "Pages occupied by compressor");

  const totalRamGB = machine.totalRamBytes / 1024 ** 3;
  const usedGB = ((pagesActive + pagesWired + pagesCompressor) * pageSize) / 1024 ** 3;
  const memPercent = totalRamGB > 0 ? Math.round((usedGB / totalRamGB) * 100) : 0;

  // --- Swap ---
  const swapRaw = hasValue(swapRes) ? swapRes.value : "";
  const swapUsedMB = finiteNumber(swapRaw.match(/used\s*=\s*([\d.]+)M/)?.[1], 0);
  const swapTotalMB = finiteNumber(swapRaw.match(/total\s*=\s*([\d.]+)M/)?.[1], 0);

  // --- Disk ---
  const dfParts = (hasValue(dfRes) ? dfRes.value : "").split("\n").slice(-1)[0]?.split(/\s+/) ?? [];

  // --- Processes ---
  const allProcs = hasValue(psRes) ? parsePsDetailed(psRes.value) : [];
  // Rows whose `comm` is a self-set title get their executable from lsof.
  await attachExecutablePaths(allProcs);

  // --- Battery ---
  const battRaw = hasValue(battRes) ? battRes.value : "";
  const battPct = battRaw.match(/(\d+)%/);

  const now = Date.now();

  // --- Network rate from cumulative interface counters ---
  const net = hasValue(netRes)
    ? trackNetRate(parseNetstatBytes(netRes.value), now)
    : { inKBps: 0, outKBps: 0 };

  // --- History on a server cadence (M-03) ---
  const last = history[history.length - 1];
  if (!last || now - last.ts >= SAMPLE_MIN_INTERVAL_MS) {
    history.push({
      ts: now,
      cpu: cpuUsed,
      mem: memPercent,
      swap: swapUsedMB,
      load: load[0],
      net: Math.round((net.inKBps + net.outKBps) * 10) / 10,
    });
  }
  while (history.length > 0 && now - history[0].ts > HISTORY_WINDOW_MS) history.shift();

  recordProcessTraces(allProcs, now);
  lastTop = allProcs;

  // --- Alerts by elapsed time and stable identity (M-03, M-17) ---
  const threshold = CPU_ALERT_THRESHOLD_PER_CORE * 100;
  const seen = new Set<number>();
  for (const p of allProcs) {
    if (p.cpu < threshold) continue;
    seen.add(p.pid);
    const existing = hot.get(p.pid);
    if (existing) {
      existing.cpu = p.cpu;
      existing.command = p.command;
    } else {
      hot.set(p.pid, {
        pid: p.pid,
        command: p.command,
        cpu: p.cpu,
        firstSeen: now,
        startedAt: null,
      });
    }
  }
  for (const pid of [...hot.keys()]) if (!seen.has(pid)) hot.delete(pid);

  const alerts: ProcessAlert[] = [...hot.values()]
    .filter((e) => now - e.firstSeen >= ALERT_MIN_DURATION_MS)
    .map((e) => ({
      pid: e.pid,
      command: e.command,
      cpu: e.cpu,
      duration: Math.round((now - e.firstSeen) / 1000),
    }))
    .sort((a, b) => b.cpu - a.cpu);

  return {
    complete: unavailable.length === 0,
    unavailable,
    cpu: {
      user: round(cpuUser),
      system: round(cpuSys),
      idle: round(cpuIdle),
      used: round(cpuUsed),
      model: machine.model,
      cores: machine.cores,
    },
    load,
    memory: {
      totalGB: round(totalRamGB),
      usedGB: round(usedGB),
      freeGB: round(Math.max(0, totalRamGB - usedGB)),
      percent: memPercent,
      wiredGB: round((pagesWired * pageSize) / 1024 ** 3),
      compressorGB: round((pagesCompressor * pageSize) / 1024 ** 3),
    },
    swap: {
      totalMB: Math.round(swapTotalMB),
      usedMB: Math.round(swapUsedMB),
      percent: swapTotalMB > 0 ? Math.round((swapUsedMB / swapTotalMB) * 100) : 0,
    },
    disk: {
      total: dfParts[1] ?? "0",
      used: dfParts[2] ?? "0",
      available: dfParts[3] ?? "0",
      percent: finiteInt(dfParts[4], 0),
    },
    net,
    processes: {
      total: procMatch ? finiteInt(procMatch[1], 0) : 0,
      threads: threadMatch ? finiteInt(threadMatch[1], 0) : 0,
      top: allProcs,
    },
    uptime: hasValue(upRes)
      ? upRes.value
          .replace(/.*up\s+/, "")
          .replace(/,\s*\d+ users?.*/, "")
          .trim()
      : "",
    currentUser: safeUsername(),
    battery: battPct
      ? { percent: finiteInt(battPct[1], 0), charging: battRaw.includes("AC Power") }
      : null,
    history: [...history],
    alerts,
    timestamp: now,
  };
}

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

/** Test seam. */
export function __resetSampler(): void {
  history.length = 0;
  hot.clear();
  traces.clear();
  lastTop = [];
}
