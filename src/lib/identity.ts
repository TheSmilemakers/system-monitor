import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mapLimit } from "./pool";

const pExecFile = promisify(execFile);

/**
 * Process identity: who signed the code that is running.
 *
 * The table used to show a short name, a PID and three numbers. Trust is the
 * first thing a security monitor should show, so every process now carries
 * the code-signing state of its executable, resolved through `codesign` and
 * cached per path. Resolution runs in the background with bounded
 * concurrency: a sample never waits on it. Until a path has been resolved its
 * state is `pending`, and it is reported as such rather than guessed.
 */

export type TrustState =
  /** Signed by Apple's own "Software Signing" chain: part of macOS. */
  | "apple"
  /** Signed by "Apple Mac OS Application Signing": from the App Store. */
  | "app-store"
  /** Signed with a Developer ID certificate issued by Apple. */
  | "developer-id"
  /** Signed, but only ad-hoc: no identity behind it (Homebrew, local builds). */
  | "adhoc"
  /** Not signed at all. */
  | "unsigned"
  /** Could not be determined (no path, unreadable, tool failure). */
  | "unknown"
  /** Not looked up yet; a later sample will carry the answer. */
  | "pending";

export interface Identity {
  trust: TrustState;
  /** The Developer ID holder or Apple, when known. */
  publisher: string | null;
  teamId: string | null;
  /** The code-signing identifier, usually a bundle id for apps. */
  bundleId: string | null;
}

export const UNKNOWN_IDENTITY: Identity = {
  trust: "unknown",
  publisher: null,
  teamId: null,
  bundleId: null,
};
const PENDING_IDENTITY: Identity = { ...UNKNOWN_IDENTITY, trust: "pending" };

export const IDENTITY_TTL_MS = 60 * 60 * 1000;
const RESOLVE_CONCURRENCY = 4;
const CODESIGN_TIMEOUT_MS = 5_000;

/** Parse `codesign -dv --verbose=2` output (it writes to stderr) into an identity. */
export function parseCodesign(output: string, ok: boolean): Identity {
  const text = output.replace(/\r/g, "");
  if (!ok) {
    if (/not signed at all/i.test(text)) return { ...UNKNOWN_IDENTITY, trust: "unsigned" };
    return UNKNOWN_IDENTITY;
  }

  const lines = text.split("\n").map((l) => l.trim());
  const value = (key: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : null;
  };
  const authorities = lines.filter((l) => l.startsWith("Authority=")).map((l) => l.slice(10));
  const identifier = value("Identifier");
  const teamRaw = value("TeamIdentifier");
  const teamId = teamRaw && teamRaw !== "not set" ? teamRaw : null;
  const bundleId = identifier && identifier !== "a.out" ? identifier : null;

  if (value("Signature") === "adhoc") {
    return { trust: "adhoc", publisher: null, teamId, bundleId };
  }
  if (authorities.includes("Software Signing")) {
    return { trust: "apple", publisher: "Apple", teamId, bundleId };
  }
  if (authorities.some((a) => a.startsWith("Apple Mac OS Application Signing"))) {
    return { trust: "app-store", publisher: "App Store", teamId, bundleId };
  }
  const devId = authorities.find((a) => a.startsWith("Developer ID Application:"));
  if (devId) {
    const m = devId.match(/^Developer ID Application:\s*(.+?)\s*(?:\(([A-Z0-9]+)\))?$/);
    return {
      trust: "developer-id",
      publisher: m?.[1] ?? devId,
      teamId: teamId ?? m?.[2] ?? null,
      bundleId,
    };
  }
  if (authorities.length > 0) {
    // Signed by something we do not classify: report the leaf authority.
    return { trust: "developer-id", publisher: authorities[0] ?? null, teamId, bundleId };
  }
  return UNKNOWN_IDENTITY;
}

/**
 * Parse a `ps` ELAPSED value into seconds.
 * Forms: `ss`, `mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`.
 */
export function parseElapsed(etime: string): number {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(?:(\d+):)?(\d+)$/);
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const parts = [m[2], m[3], m[4]].filter((p): p is string => p !== undefined).map(Number);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return days * 86_400 + seconds;
}

// ---------- resolution with a bounded background queue ----------

type CodesignRunner = (path: string) => Promise<{ ok: boolean; output: string }>;

async function realCodesign(path: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await pExecFile("codesign", ["-dv", "--verbose=2", path], {
      timeout: CODESIGN_TIMEOUT_MS,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}` };
  }
}

let runner: CodesignRunner | null = null;

/** Test seam: replace the codesign invocation. */
export function __setCodesignRunner(fn: CodesignRunner | null): void {
  runner = fn;
}

interface CacheEntry {
  identity: Identity;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();
let queue: string[] = [];
let draining: Promise<void> | null = null;

function isResolvablePath(path: string): boolean {
  return path.startsWith("/");
}

/**
 * The identity for an executable path, from cache.
 *
 * A miss returns `pending` and enqueues the path; the queue drains in the
 * background at bounded concurrency. Paths that are not absolute (for example
 * `kernel_task`) are `unknown` immediately and never queued.
 */
export function identityFor(path: string, now = Date.now()): Identity {
  if (!isResolvablePath(path)) return UNKNOWN_IDENTITY;
  const hit = cache.get(path);
  if (hit && hit.expires > now) return hit.identity;
  enqueue(path);
  return hit?.identity ?? PENDING_IDENTITY;
}

function enqueue(path: string): void {
  if (inFlight.has(path) || queue.includes(path)) return;
  queue.push(path);
  if (!draining) draining = drain().finally(() => (draining = null));
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const batch = queue;
    queue = [];
    for (const p of batch) inFlight.add(p);
    await mapLimit(batch, RESOLVE_CONCURRENCY, async (path) => {
      try {
        const result = await (runner ?? realCodesign)(path);
        cache.set(path, {
          identity: parseCodesign(result.output, result.ok),
          expires: Date.now() + IDENTITY_TTL_MS,
        });
      } catch {
        cache.set(path, { identity: UNKNOWN_IDENTITY, expires: Date.now() + IDENTITY_TTL_MS });
      } finally {
        inFlight.delete(path);
      }
    });
  }
}

/** Wait for every queued resolution to finish. Used by tests and shutdown. */
export async function identitiesSettled(): Promise<void> {
  while (draining) await draining;
}

/** Test seam. */
export function __resetIdentityCache(): void {
  cache.clear();
  inFlight.clear();
  queue = [];
}
