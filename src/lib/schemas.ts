/**
 * Runtime validation for API responses (M-11).
 *
 * The client previously stored `await res.json()` unchecked behind hand-written
 * interfaces, then called the values as numbers. A non-finite value serialised
 * as `null` — exactly what the old fail-open collectors produced — crashed the
 * dashboard at `stats.load[0].toFixed(1)`. Every response is now validated at
 * the boundary and contract violations surface as errors, not exceptions.
 */

export interface Unavailable {
  check: string;
  reason: string;
}

export interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
  swap: number;
  load: number;
}

export type TrustState =
  "apple" | "app-store" | "developer-id" | "adhoc" | "unsigned" | "unknown" | "pending";

export const TRUST_STATES: readonly TrustState[] = [
  "apple",
  "app-store",
  "developer-id",
  "adhoc",
  "unsigned",
  "unknown",
  "pending",
];

export interface ProcessInfo {
  user: string;
  pid: number;
  ppid: number;
  cpu: number;
  mem: number;
  rss: number;
  command: string;
  path: string;
  elapsed: number;
  trust: TrustState;
  publisher: string | null;
  bundleId: string | null;
}

export interface ProcessAlert {
  pid: number;
  command: string;
  cpu: number;
  duration: number;
}

export interface SystemStats {
  complete: boolean;
  unavailable: Unavailable[];
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

export interface ScanFinding {
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  processes: { pid: number; name: string; cpu: number; mem: number; rss: number }[];
  recommendation: string;
}

export interface ScanResult {
  complete: boolean;
  healthScore: number | null;
  unavailable: Unavailable[];
  findings: ScanFinding[];
  summary: {
    totalProcesses: number;
    electronApps: number;
    electronProcesses: number;
    browsers: number;
    launchItems: number;
    swapUsedMB: number;
  } | null;
  timestamp: number;
}

export interface CleanupItem {
  id: string;
  category: string;
  name: string;
  path: string;
  size: number;
  sizeFormatted: string;
  fileCount: number | null;
  description: string;
  risk: "safe" | "low" | "medium";
  requiresRoot: boolean;
}

export interface CleanupResult {
  complete: boolean;
  unavailable: Unavailable[];
  items: CleanupItem[];
  totalSize: number;
  totalFormatted: string;
  timestamp: number;
}

export interface PrivacyFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  detail: string;
  items: string[];
  recommendation: string;
}

export interface PrivacyResult {
  complete: boolean;
  privacyScore: number | null;
  unavailable: Unavailable[];
  findings: PrivacyFinding[];
  connectionCount: number;
  resolvedCount: number;
  unknownCount: number;
  trackerCount: number;
  timestamp: number;
}

// ---------- primitive guards ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const arr = (v: unknown): v is unknown[] => Array.isArray(v);

export class ContractError extends Error {
  constructor(what: string) {
    super(`Malformed API response: ${what}`);
    this.name = "ContractError";
  }
}

function unavailableList(v: unknown): Unavailable[] {
  if (!arr(v)) return [];
  return v.filter(isObj).map((u) => ({
    check: str(u.check) ? u.check : "unknown check",
    reason: str(u.reason) ? u.reason : "unknown",
  }));
}

// ---------- parsers ----------

export function parseStats(raw: unknown): SystemStats {
  if (!isObj(raw)) throw new ContractError("stats is not an object");
  const { cpu, memory, swap, disk, processes } = raw;
  if (!isObj(cpu) || !isObj(memory) || !isObj(swap) || !isObj(disk) || !isObj(processes)) {
    throw new ContractError("stats is missing a required section");
  }
  if (!num(cpu.used) || !num(memory.percent)) {
    throw new ContractError("stats contains a non-finite metric");
  }
  const load = arr(raw.load) ? raw.load.filter(num) : [];
  if (load.length < 3) throw new ContractError("stats.load must hold three finite averages");

  const top = arr(processes.top)
    ? processes.top.filter(isObj).map((p) => ({
        user: str(p.user) ? p.user : "?",
        pid: num(p.pid) ? p.pid : 0,
        ppid: num(p.ppid) ? p.ppid : 0,
        cpu: num(p.cpu) ? p.cpu : 0,
        mem: num(p.mem) ? p.mem : 0,
        rss: num(p.rss) ? p.rss : 0,
        command: str(p.command) ? p.command : "unknown",
        path: str(p.path) ? p.path : "",
        elapsed: num(p.elapsed) ? p.elapsed : 0,
        trust:
          str(p.trust) && (TRUST_STATES as readonly string[]).includes(p.trust)
            ? (p.trust as TrustState)
            : "unknown",
        publisher: str(p.publisher) ? p.publisher : null,
        bundleId: str(p.bundleId) ? p.bundleId : null,
      }))
    : [];

  return {
    complete: bool(raw.complete) ? raw.complete : true,
    unavailable: unavailableList(raw.unavailable),
    cpu: {
      user: num(cpu.user) ? cpu.user : 0,
      system: num(cpu.system) ? cpu.system : 0,
      idle: num(cpu.idle) ? cpu.idle : 0,
      used: cpu.used,
      model: str(cpu.model) ? cpu.model : "unknown",
      cores: num(cpu.cores) && cpu.cores > 0 ? cpu.cores : 1,
    },
    load,
    memory: {
      totalGB: num(memory.totalGB) ? memory.totalGB : 0,
      usedGB: num(memory.usedGB) ? memory.usedGB : 0,
      freeGB: num(memory.freeGB) ? memory.freeGB : 0,
      percent: memory.percent,
      wiredGB: num(memory.wiredGB) ? memory.wiredGB : 0,
      compressorGB: num(memory.compressorGB) ? memory.compressorGB : 0,
    },
    swap: {
      totalMB: num(swap.totalMB) ? swap.totalMB : 0,
      usedMB: num(swap.usedMB) ? swap.usedMB : 0,
      percent: num(swap.percent) ? swap.percent : 0,
    },
    disk: {
      total: str(disk.total) ? disk.total : "0",
      used: str(disk.used) ? disk.used : "0",
      available: str(disk.available) ? disk.available : "0",
      percent: num(disk.percent) ? disk.percent : 0,
    },
    processes: {
      total: num(processes.total) ? processes.total : 0,
      threads: num(processes.threads) ? processes.threads : 0,
      top,
    },
    uptime: str(raw.uptime) ? raw.uptime : "",
    battery:
      isObj(raw.battery) && num(raw.battery.percent)
        ? {
            percent: raw.battery.percent,
            charging: bool(raw.battery.charging) ? raw.battery.charging : false,
          }
        : null,
    history: arr(raw.history)
      ? raw.history
          .filter(isObj)
          .filter((h) => num(h.ts) && num(h.cpu) && num(h.mem) && num(h.swap) && num(h.load))
          .map((h) => h as unknown as HistoryPoint)
      : [],
    alerts: arr(raw.alerts)
      ? raw.alerts
          .filter(isObj)
          .filter((a) => num(a.pid) && num(a.cpu) && num(a.duration) && str(a.command))
          .map((a) => a as unknown as ProcessAlert)
      : [],
    timestamp: num(raw.timestamp) ? raw.timestamp : Date.now(),
  };
}

export function parseScan(raw: unknown): ScanResult {
  if (!isObj(raw)) throw new ContractError("scan is not an object");
  const findings = arr(raw.findings)
    ? raw.findings.filter(isObj).map((f) => ({
        severity: (["critical", "warning", "info"] as const).includes(f.severity as never)
          ? (f.severity as ScanFinding["severity"])
          : "info",
        category: str(f.category) ? f.category : "General",
        title: str(f.title) ? f.title : "Untitled finding",
        detail: str(f.detail) ? f.detail : "",
        processes: arr(f.processes)
          ? f.processes.filter(isObj).map((p) => ({
              pid: num(p.pid) ? p.pid : 0,
              name: str(p.name) ? p.name : "unknown",
              cpu: num(p.cpu) ? p.cpu : 0,
              mem: num(p.mem) ? p.mem : 0,
              rss: num(p.rss) ? p.rss : 0,
            }))
          : [],
        recommendation: str(f.recommendation) ? f.recommendation : "",
      }))
    : [];

  const s = raw.summary;
  return {
    complete: bool(raw.complete) ? raw.complete : false,
    healthScore: num(raw.healthScore) ? raw.healthScore : null,
    unavailable: unavailableList(raw.unavailable),
    findings,
    summary: isObj(s)
      ? {
          totalProcesses: num(s.totalProcesses) ? s.totalProcesses : 0,
          electronApps: num(s.electronApps) ? s.electronApps : 0,
          electronProcesses: num(s.electronProcesses) ? s.electronProcesses : 0,
          browsers: num(s.browsers) ? s.browsers : 0,
          launchItems: num(s.launchItems) ? s.launchItems : 0,
          swapUsedMB: num(s.swapUsedMB) ? s.swapUsedMB : 0,
        }
      : null,
    timestamp: num(raw.timestamp) ? raw.timestamp : Date.now(),
  };
}

export function parseCleanup(raw: unknown): CleanupResult {
  if (!isObj(raw)) throw new ContractError("cleanup is not an object");
  const items = arr(raw.items)
    ? raw.items
        .filter(isObj)
        .filter((i) => str(i.id) && num(i.size))
        .map((i) => ({
          id: i.id as string,
          category: str(i.category) ? i.category : "Other",
          name: str(i.name) ? i.name : "Unnamed",
          path: str(i.path) ? i.path : "",
          size: i.size as number,
          sizeFormatted: str(i.sizeFormatted) ? i.sizeFormatted : "0 B",
          fileCount: num(i.fileCount) ? i.fileCount : null,
          description: str(i.description) ? i.description : "",
          risk: (["safe", "low", "medium"] as const).includes(i.risk as never)
            ? (i.risk as CleanupItem["risk"])
            : "medium",
          requiresRoot: bool(i.requiresRoot) ? i.requiresRoot : false,
        }))
    : [];

  return {
    complete: bool(raw.complete) ? raw.complete : false,
    unavailable: unavailableList(raw.unavailable),
    items,
    totalSize: num(raw.totalSize) ? raw.totalSize : 0,
    totalFormatted: str(raw.totalFormatted) ? raw.totalFormatted : "0 B",
    timestamp: num(raw.timestamp) ? raw.timestamp : Date.now(),
  };
}

export function parsePrivacy(raw: unknown): PrivacyResult {
  if (!isObj(raw)) throw new ContractError("privacy is not an object");
  const severities = ["critical", "high", "medium", "low", "info"] as const;
  const findings = arr(raw.findings)
    ? raw.findings.filter(isObj).map((f) => ({
        severity: severities.includes(f.severity as never)
          ? (f.severity as PrivacyFinding["severity"])
          : "info",
        category: str(f.category) ? f.category : "General",
        title: str(f.title) ? f.title : "Untitled finding",
        detail: str(f.detail) ? f.detail : "",
        items: arr(f.items) ? f.items.filter(str) : [],
        recommendation: str(f.recommendation) ? f.recommendation : "",
      }))
    : [];

  return {
    complete: bool(raw.complete) ? raw.complete : false,
    privacyScore: num(raw.privacyScore) ? raw.privacyScore : null,
    unavailable: unavailableList(raw.unavailable),
    findings,
    connectionCount: num(raw.connectionCount) ? raw.connectionCount : 0,
    resolvedCount: num(raw.resolvedCount) ? raw.resolvedCount : 0,
    unknownCount: num(raw.unknownCount) ? raw.unknownCount : 0,
    trackerCount: num(raw.trackerCount) ? raw.trackerCount : 0,
    timestamp: num(raw.timestamp) ? raw.timestamp : Date.now(),
  };
}
