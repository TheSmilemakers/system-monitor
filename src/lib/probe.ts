import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/**
 * Asynchronous, argv-based system probes with typed outcomes.
 *
 * Replaces the previous `execSync` helper, which (a) blocked the single Node
 * event loop for the duration of every shell-out, serialising all concurrent
 * requests, and (b) collapsed every failure mode — timeout, permission denied,
 * missing binary — into an empty string, so a failed probe was indistinguishable
 * from a clean result and silently improved health/privacy scores (H-02, H-03).
 *
 * No argument is ever concatenated into a shell string: `execFile` passes argv
 * directly, so shell metacharacters carry no meaning.
 */
export type Probe<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "denied" }
  | { status: "unsupported" }
  | { status: "failed"; error: string };

export type ProbeStatus = Probe<never>["status"];

export const DEFAULT_TIMEOUT_MS = 5_000;

export async function probe(
  file: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Probe<string>> {
  try {
    const { stdout } = await pExecFile(file, [...args], {
      timeout: timeoutMs,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: "ok", value: stdout.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stderr?: string;
    };
    if (e.killed || e.signal === "SIGTERM") return { status: "timeout" };
    if (e.code === "ENOENT") return { status: "unsupported" };
    if (e.code === "EACCES" || e.code === "EPERM") return { status: "denied" };

    const stderr = (e.stderr ?? "").toLowerCase();
    if (
      stderr.includes("authorization denied") ||
      stderr.includes("operation not permitted") ||
      stderr.includes("permission denied")
    ) {
      return { status: "denied" };
    }
    return { status: "failed", error: e.message ?? "unknown error" };
  }
}

/** Convenience: the value when ok, otherwise null. Use only where absence is meaningful. */
export function valueOr<T>(p: Probe<T>, fallback: T): T {
  return p.status === "ok" ? p.value : fallback;
}

export function isOk<T>(p: Probe<T>): p is { status: "ok"; value: T } {
  return p.status === "ok";
}

/**
 * Parse a finite number, or return the fallback.
 * Guards every numeric path so `NaN`/`Infinity` can never be serialised into
 * JSON as `null` and violate the client contract (H-03, M-11).
 */
export function finiteNumber(raw: string | number | undefined | null, fallback = 0): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

export function finiteInt(raw: string | number | undefined | null, fallback = 0): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Round to `dp` decimal places, always returning a finite number. */
export function round(value: number, dp = 1): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

export interface MachineInfo {
  totalRamBytes: number;
  cores: number;
  model: string;
  /** Bytes per VM page. 16384 on Apple Silicon, 4096 on Intel (M-16). */
  pageSize: number;
}

let machineCache: MachineInfo | null = null;

/**
 * Machine constants, read once per process.
 *
 * These never change while the process lives, yet the previous implementation
 * re-shelled `hw.memsize`, `hw.ncpu` and `machdep.cpu.brand_string` on every
 * 3-second poll. Page size is now read from `hw.pagesize` instead of being
 * hardcoded to 16384, which overstated memory use 4x on Intel Macs (M-16).
 */
export async function getMachineInfo(): Promise<MachineInfo> {
  if (machineCache) return machineCache;

  const [mem, cores, model, page] = await Promise.all([
    probe("sysctl", ["-n", "hw.memsize"]),
    probe("sysctl", ["-n", "hw.ncpu"]),
    probe("sysctl", ["-n", "machdep.cpu.brand_string"]),
    probe("sysctl", ["-n", "hw.pagesize"]),
  ]);

  machineCache = {
    totalRamBytes: isOk(mem) ? finiteInt(mem.value, 0) : 0,
    cores: Math.max(1, isOk(cores) ? finiteInt(cores.value, 1) : 1),
    model: isOk(model) ? model.value : "unknown",
    pageSize: Math.max(1, isOk(page) ? finiteInt(page.value, 4096) : 4096),
  };
  return machineCache;
}

/** Test seam — reset the memoised machine constants. */
export function __resetMachineInfo(): void {
  machineCache = null;
}
