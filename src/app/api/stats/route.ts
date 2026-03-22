import { execSync } from "child_process";
import { NextResponse } from "next/server";

function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 5000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// --- History ring buffer (in-memory, survives across requests) ---
const MAX_HISTORY = 100; // ~5 min at 3s intervals
const history: { ts: number; cpu: number; mem: number; swap: number; load: number }[] = [];

// --- Process alert tracking ---
interface ProcAlert {
  pid: number;
  command: string;
  cpu: number;
  firstSeen: number;
  count: number; // consecutive polls above threshold
}
const CPU_ALERT_THRESHOLD = 50;
const ALERT_POLLS_REQUIRED = 3; // must be hot for 3+ consecutive polls (~9s at 3s interval)
const hotProcesses = new Map<number, ProcAlert>();

export async function GET() {
  const pageSize = 16384;

  // CPU & load
  const topOutput = run(
    "top -l 1 -n 0 -s 0 2>/dev/null | head -12"
  );
  const loadMatch = topOutput.match(
    /Load Avg:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/
  );
  const cpuMatch = topOutput.match(
    /CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/
  );
  const processMatch = topOutput.match(
    /Processes:\s*(\d+) total/
  );
  const threadMatch = topOutput.match(/(\d+) threads/);

  const load = loadMatch
    ? [parseFloat(loadMatch[1]), parseFloat(loadMatch[2]), parseFloat(loadMatch[3])]
    : [0, 0, 0];

  const cpuUser = cpuMatch ? parseFloat(cpuMatch[1]) : 0;
  const cpuSys = cpuMatch ? parseFloat(cpuMatch[2]) : 0;
  const cpuIdle = cpuMatch ? parseFloat(cpuMatch[3]) : 0;

  // Memory
  const vmstat = run("vm_stat");
  const getPages = (label: string): number => {
    const m = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? parseInt(m[1]) : 0;
  };

  const pagesFree = getPages("Pages free");
  const pagesActive = getPages("Pages active");
  const pagesInactive = getPages("Pages inactive");
  const pagesSpeculative = getPages("Pages speculative");
  const pagesWired = getPages("Pages wired down");
  const pagesCompressor = getPages("Pages occupied by compressor");

  const totalRamBytes = parseInt(run("sysctl -n hw.memsize") || "0");
  const totalRamGB = totalRamBytes / 1024 ** 3;
  const usedPages = pagesActive + pagesWired + pagesCompressor;
  const usedGB = (usedPages * pageSize) / 1024 ** 3;
  const freeGB = totalRamGB - usedGB;

  // Swap
  const swapRaw = run("sysctl vm.swapusage");
  const swapUsedMatch = swapRaw.match(/used\s*=\s*([\d.]+)M/);
  const swapTotalMatch = swapRaw.match(/total\s*=\s*([\d.]+)M/);
  const swapUsedMB = swapUsedMatch ? parseFloat(swapUsedMatch[1]) : 0;
  const swapTotalMB = swapTotalMatch ? parseFloat(swapTotalMatch[1]) : 0;

  // Disk
  const dfLine = run("df -h / | tail -1");
  const dfParts = dfLine.split(/\s+/);
  const diskTotal = dfParts[1] || "0";
  const diskUsed = dfParts[2] || "0";
  const diskAvail = dfParts[3] || "0";
  const diskPercent = parseInt(dfParts[4] || "0");

  // Network
  const netstat = run("netstat -ib | grep -E 'en0' | head -1");
  const netParts = netstat.split(/\s+/);

  // Uptime
  const uptime = run("uptime").replace(/.*up\s+/, "").replace(/,\s*\d+ users?.*/, "").trim();

  // Top processes
  const psOutput = run(
    "ps aux -r | head -21 | tail -20"
  );
  const processes = psOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const user = parts[0];
      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const rss = parseInt(parts[5]) * 1024; // KB to bytes
      const command = parts.slice(10).join(" ");
      const shortName =
        command.match(/\/([^/]+?)(\s|$)/)?.[1]?.replace(
          / Helper.*$/,
          ""
        ) || command.substring(0, 40);
      return { user, pid, cpu, mem, rss, command: shortName };
    })
    .filter((p) => p.pid);

  // CPU core count
  const cpuCores = parseInt(run("sysctl -n hw.ncpu") || "1");
  const cpuModel = run("sysctl -n machdep.cpu.brand_string");

  // Battery
  const batteryRaw = run("pmset -g batt");
  const batteryMatch = batteryRaw.match(/(\d+)%/);
  const batteryPercent = batteryMatch ? parseInt(batteryMatch[1]) : null;
  const isCharging = batteryRaw.includes("AC Power");

  const now = Date.now();
  const cpuUsed = cpuUser + cpuSys;
  const memPercent = Math.round((usedGB / totalRamGB) * 100);

  // Record history
  history.push({ ts: now, cpu: cpuUsed, mem: memPercent, swap: swapUsedMB, load: load[0] });
  if (history.length > MAX_HISTORY) history.shift();

  // Update process alerts
  const currentHotPids = new Set<number>();
  for (const proc of processes) {
    if (proc.cpu >= CPU_ALERT_THRESHOLD) {
      currentHotPids.add(proc.pid);
      const existing = hotProcesses.get(proc.pid);
      if (existing) {
        existing.count++;
        existing.cpu = proc.cpu;
      } else {
        hotProcesses.set(proc.pid, {
          pid: proc.pid,
          command: proc.command,
          cpu: proc.cpu,
          firstSeen: now,
          count: 1,
        });
      }
    }
  }
  // Clear processes that dropped below threshold
  for (const [pid] of hotProcesses) {
    if (!currentHotPids.has(pid)) hotProcesses.delete(pid);
  }

  // Build alerts for processes that have been hot long enough
  const alerts = Array.from(hotProcesses.values())
    .filter((p) => p.count >= ALERT_POLLS_REQUIRED)
    .map((p) => ({
      pid: p.pid,
      command: p.command,
      cpu: p.cpu,
      duration: Math.round((now - p.firstSeen) / 1000),
    }))
    .sort((a, b) => b.cpu - a.cpu);

  return NextResponse.json({
    cpu: {
      user: cpuUser,
      system: cpuSys,
      idle: cpuIdle,
      used: cpuUsed,
      model: cpuModel,
      cores: cpuCores,
    },
    load,
    memory: {
      totalGB: Math.round(totalRamGB * 10) / 10,
      usedGB: Math.round(usedGB * 10) / 10,
      freeGB: Math.round(freeGB * 10) / 10,
      percent: memPercent,
      wiredGB: Math.round((pagesWired * pageSize) / 1024 ** 3 * 10) / 10,
      compressorGB: Math.round((pagesCompressor * pageSize) / 1024 ** 3 * 10) / 10,
    },
    swap: {
      totalMB: Math.round(swapTotalMB),
      usedMB: Math.round(swapUsedMB),
      percent: swapTotalMB > 0 ? Math.round((swapUsedMB / swapTotalMB) * 100) : 0,
    },
    disk: {
      total: diskTotal,
      used: diskUsed,
      available: diskAvail,
      percent: diskPercent,
    },
    processes: {
      total: processMatch ? parseInt(processMatch[1]) : 0,
      threads: threadMatch ? parseInt(threadMatch[1]) : 0,
      top: processes,
    },
    uptime,
    battery: batteryPercent !== null ? { percent: batteryPercent, charging: isCharging } : null,
    history: history.map((h) => ({ ts: h.ts, cpu: h.cpu, mem: h.mem, swap: h.swap, load: h.load })),
    alerts,
    timestamp: now,
  });
}
