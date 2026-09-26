"use server";

import { readdir, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { getCleanupTarget, isAtOrUnder, isWithinPermittedRoots } from "@/lib/cleanup-targets";
import { executablePathFor } from "@/lib/exec-path";
import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { hasValue, probe } from "@/lib/probe";
import { processIdentity, sameIdentity, type ProcessIdentity } from "@/lib/process-identity";

export interface ActionResult {
  success: boolean;
  error?: string;
}

export interface CleanupOutcome extends ActionResult {
  bytesFreed?: number;
  itemsRemoved?: number;
  itemsSkipped?: number;
}

function forbidden(e: unknown): ActionResult | null {
  return e instanceof ForbiddenError ? { success: false, error: e.message } : null;
}

/**
 * Stop this server process (M-02).
 *
 * The previous implementation ran `kill $(lsof -ti :3000)`, which targeted a
 * port rather than this application — killing an unrelated listener when the
 * app ran on any other port, and nothing at all when 3000 was free.
 */
export async function stopServer(): Promise<ActionResult> {
  try {
    await assertLocalRequest();
  } catch (e) {
    return forbidden(e) ?? { success: false, error: "Request refused" };
  }

  // Reply first, then exit, so the client observes the result.
  setTimeout(() => process.exit(0), 250);
  return { success: true };
}

/**
 * Delete a server-defined cleanup target (C-01).
 *
 * The client supplies an opaque id and nothing else. No shell is involved at
 * any point: paths come from the server-owned table, are resolved through
 * `realpath`, re-checked for containment, and removed with filesystem APIs.
 * Symlinks are never followed or deleted.
 */
export async function cleanupItem(id: string): Promise<CleanupOutcome> {
  try {
    await assertLocalRequest();
  } catch (e) {
    return forbidden(e) ?? { success: false, error: "Request refused" };
  }

  const target = getCleanupTarget(id);
  if (!target) return { success: false, error: "Unknown cleanup target" };
  if (target.requiresRoot) {
    return { success: false, error: "Requires administrator rights — run manually in Terminal" };
  }

  // Resolve symlinks *before* the containment check, then verify the real path.
  let resolved: string;
  try {
    resolved = await realpath(target.absPath);
  } catch {
    return { success: false, error: "Target no longer exists" };
  }
  if (!isWithinPermittedRoots(resolved)) {
    return { success: false, error: "Target resolves outside the permitted roots" };
  }

  const cutoff =
    target.mode === "delete-files-older-than" && target.olderThanDays
      ? Date.now() - target.olderThanDays * 86_400_000
      : null;

  let bytesFreed = 0;
  let itemsRemoved = 0;
  let itemsSkipped = 0;

  let entries;
  try {
    // readdir includes dotfiles, so the reported and deleted sets agree (L-01).
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    return { success: false, error: "Could not read the target directory" };
  }

  for (const entry of entries) {
    const child = path.join(resolved, entry.name);

    // Re-validate every entry: never traverse or delete through a symlink.
    let st;
    try {
      st = await lstat(child);
    } catch {
      itemsSkipped++;
      continue;
    }
    if (st.isSymbolicLink()) {
      itemsSkipped++;
      continue;
    }
    if (!isAtOrUnder(child, resolved)) {
      itemsSkipped++;
      continue;
    }
    if (cutoff !== null) {
      if (!st.isFile() || st.mtimeMs >= cutoff) {
        itemsSkipped++;
        continue;
      }
    }

    try {
      await rm(child, { recursive: true, force: true });
      bytesFreed += st.size;
      itemsRemoved++;
    } catch {
      itemsSkipped++;
    }
  }

  return { success: true, bytesFreed, itemsRemoved, itemsSkipped };
}

// ---------- process actions ----------

const SIGTERM_GRACE_MS = 3_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Owned = { ok: true; identity: ProcessIdentity } | { ok: false; result: ActionResult };

/**
 * The checks every process action shares: loopback caller, a sane pid, a
 * live process, and ownership by the account this server runs as. The
 * identity (pid plus start time) is returned so callers can re-verify it
 * before and after signalling (M-01).
 */
async function ownedProcess(pid: number): Promise<Owned> {
  try {
    await assertLocalRequest();
  } catch (e) {
    return { ok: false, result: forbidden(e) ?? { success: false, error: "Request refused" } };
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, result: { success: false, error: "Invalid or protected PID" } };
  }
  const identity = await processIdentity(pid);
  if (!identity) return { ok: false, result: { success: false, error: "Process not found" } };

  const whoami = await probe("whoami", []);
  const currentUser = whoami.status === "ok" ? whoami.value : null;
  if (!currentUser) {
    return { ok: false, result: { success: false, error: "Could not determine the current user" } };
  }
  if (identity.user !== currentUser) {
    return {
      ok: false,
      result: {
        success: false,
        error: `Process is owned by "${identity.user}", not "${currentUser}"`,
      },
    };
  }
  return { ok: true, identity };
}

/**
 * Terminate a user-owned process with real SIGTERM → SIGKILL escalation (M-01).
 *
 * The previous implementation returned as soon as `kill -15` exited 0 — which
 * only means the signal was *sent*. A process ignoring SIGTERM never reached
 * the advertised SIGKILL fallback. Identity (pid + start time) is revalidated
 * before every signal so PID reuse cannot redirect the kill.
 */
export async function killProcess(pid: number): Promise<ActionResult> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) {
    return owned.result.error === "Process not found" ? { success: true } : owned.result; // already gone
  }
  const { identity } = owned;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { success: true }; // exited between the check and the signal
  }

  const deadline = Date.now() + SIGTERM_GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const now = await processIdentity(pid);
    if (!now || !sameIdentity(identity, now)) return { success: true };
  }

  // Still alive after the grace period — revalidate identity, then escalate.
  const before = await processIdentity(pid);
  if (!before || !sameIdentity(identity, before)) return { success: true };

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return { success: true };
  }

  await sleep(POLL_MS * 2);
  const after = await processIdentity(pid);
  if (!after || !sameIdentity(identity, after)) return { success: true };

  return { success: false, error: "Process survived SIGKILL" };
}

async function processState(pid: number): Promise<string | null> {
  const res = await probe("ps", ["-o", "stat=", "-p", String(pid)]);
  return res.status === "ok" && res.value.trim().length > 0 ? res.value.trim() : null;
}

/**
 * Pause a user-owned process (SIGSTOP). Reversible, unlike kill: the process
 * keeps its memory and state and can be resumed. The stopped state is read
 * back from ps so the result reports what happened, not what was sent.
 */
export async function suspendProcess(pid: number): Promise<ActionResult> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) return owned.result;
  try {
    process.kill(pid, "SIGSTOP");
  } catch {
    return { success: false, error: "Could not signal the process" };
  }
  await sleep(POLL_MS);
  const state = await processState(pid);
  return state?.startsWith("T")
    ? { success: true }
    : { success: false, error: "Process did not stop" };
}

export async function resumeProcess(pid: number): Promise<ActionResult> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) return owned.result;
  try {
    process.kill(pid, "SIGCONT");
  } catch {
    return { success: false, error: "Could not signal the process" };
  }
  await sleep(POLL_MS);
  const state = await processState(pid);
  return state && !state.startsWith("T")
    ? { success: true }
    : { success: false, error: "Process did not resume" };
}

/** Lower a user-owned process's priority. Without root, nice can only go up. */
export async function reniceProcess(pid: number): Promise<ActionResult> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) return owned.result;
  const res = await probe("renice", ["10", "-p", String(pid)]);
  return res.status === "ok"
    ? { success: true }
    : { success: false, error: `renice reported ${res.status}` };
}

export interface SampleOutcome extends ActionResult {
  /** The head of the call-graph report, plain text. */
  text?: string;
}

/**
 * Sample a user-owned process for two seconds and return the head of the
 * report. Output is text for the user to read; it is never executed.
 */
export async function sampleProcess(pid: number): Promise<SampleOutcome> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) return owned.result;
  const res = await probe("sample", [String(pid), "2", "-file", "/dev/stdout"], 20_000);
  if (!hasValue(res)) return { success: false, error: `sample reported ${res.status}` };
  const lines = res.value.split("\n");
  const text = lines.slice(0, 80).join("\n").slice(0, 8_000);
  return { success: true, text };
}

export interface AssessOutcome extends ActionResult {
  verdict?: "accepted" | "rejected" | "unknown";
  source?: string | null;
  notarised?: boolean | null;
  quarantined?: boolean;
  path?: string;
}

/**
 * Gatekeeper's verdict on the process's executable, plus whether it still
 * carries the quarantine flag (downloaded, never assessed). Read-only.
 */
export async function assessProcess(pid: number): Promise<AssessOutcome> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) return owned.result;
  const exe = await executablePathFor(pid);
  if (!exe) return { success: false, error: "Could not determine the executable path" };

  const [assess, quarantine] = await Promise.all([
    probe("spctl", ["--assess", "--type", "execute", "-v", exe]),
    probe("xattr", ["-p", "com.apple.quarantine", exe]),
  ]);
  const out = hasValue(assess) ? assess.value : "";
  const failedText = assess.status === "failed" ? assess.error : "";
  const combined = `${out}\n${failedText}`;
  const verdict: AssessOutcome["verdict"] = /: accepted/.test(combined)
    ? "accepted"
    : /: rejected/.test(combined)
      ? "rejected"
      : "unknown";
  const sourceMatch = /source=([^\n]+)/.exec(combined);
  const source = sourceMatch ? sourceMatch[1].trim() : null;
  return {
    success: true,
    path: exe,
    verdict,
    source,
    notarised: source ? /notarized/i.test(source) : null,
    quarantined: quarantine.status === "ok" && quarantine.value.trim().length > 0,
  };
}

/** Show the executable in Finder. */
export async function revealProcess(pid: number): Promise<ActionResult> {
  const owned = await ownedProcess(pid);
  if (!owned.ok) return owned.result;
  const exe = await executablePathFor(pid);
  if (!exe) return { success: false, error: "Could not determine the executable path" };
  const res = await probe("open", ["-R", exe]);
  return res.status === "ok"
    ? { success: true }
    : { success: false, error: `open reported ${res.status}` };
}
