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

export interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
  swap: number;
  load: number;
}

export interface ProcessInfo {
  user: string;
  pid: number;
  /** Percent of ONE core, as reported by ps (may exceed 100) — see M-17. */
  cpu: number;
  mem: number;
  rss: number;
  command: string;
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
  processes: { total: number; threads: number; top: ProcessInfo[] };
  uptime: string;
  battery: { percent: number; charging: boolean } | null;
  history: HistoryPoint[];
  alerts: ProcessAlert[];
  timestamp: number;
}

/** Parse `ps aux` output into structured rows. Exported for parser tests. */
export function parsePsAux(raw: string, limit = 20): ProcessInfo[] {
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

  const [topRes, vmRes, swapRes, dfRes, psRes, battRes, upRes] = await Promise.all([
    probe("top", ["-l", "1", "-n", "0", "-s", "0"], 8_000),
    probe("vm_stat", []),
    probe("sysctl", ["vm.swapusage"]),
    probe("df", ["-h", "/"]),
    probe("ps", ["aux"], 8_000),
    probe("pmset", ["-g", "batt"]),
    probe("uptime", []),
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
  const allProcs = hasValue(psRes) ? parsePsAux(psRes.value, 20) : [];

  // --- Battery ---
  const battRaw = hasValue(battRes) ? battRes.value : "";
  const battPct = battRaw.match(/(\d+)%/);

  const now = Date.now();

  // --- History on a server cadence (M-03) ---
  const last = history[history.length - 1];
  if (!last || now - last.ts >= SAMPLE_MIN_INTERVAL_MS) {
    history.push({ ts: now, cpu: cpuUsed, mem: memPercent, swap: swapUsedMB, load: load[0] });
  }
  while (history.length > 0 && now - history[0].ts > HISTORY_WINDOW_MS) history.shift();

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
    battery: battPct
      ? { percent: finiteInt(battPct[1], 0), charging: battRaw.includes("AC Power") }
      : null,
    history: [...history],
    alerts,
    timestamp: now,
  };
}

/** Test seam. */
export function __resetSampler(): void {
  history.length = 0;
  hot.clear();
}
