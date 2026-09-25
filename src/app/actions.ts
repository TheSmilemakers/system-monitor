"use server";

import { readdir, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { getCleanupTarget, isAtOrUnder, isWithinPermittedRoots } from "@/lib/cleanup-targets";
import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { probe } from "@/lib/probe";
import { processIdentity, sameIdentity } from "@/lib/process-identity";

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

const SIGTERM_GRACE_MS = 3_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Terminate a user-owned process with real SIGTERM → SIGKILL escalation (M-01).
 *
 * The previous implementation returned as soon as `kill -15` exited 0 — which
 * only means the signal was *sent*. A process ignoring SIGTERM never reached
 * the advertised SIGKILL fallback. Identity (pid + start time) is revalidated
 * before every signal so PID reuse cannot redirect the kill.
 */
export async function killProcess(pid: number): Promise<ActionResult> {
  try {
    await assertLocalRequest();
  } catch (e) {
    return forbidden(e) ?? { success: false, error: "Request refused" };
  }

  if (!Number.isInteger(pid) || pid <= 1) {
    return { success: false, error: "Invalid or protected PID" };
  }

  const identity = await processIdentity(pid);
  if (!identity) return { success: true }; // already gone

  const whoami = await probe("whoami", []);
  const currentUser = whoami.status === "ok" ? whoami.value : null;
  if (!currentUser) {
    return { success: false, error: "Could not determine the current user" };
  }
  if (identity.user !== currentUser) {
    return {
      success: false,
      error: `Process is owned by "${identity.user}", not "${currentUser}"`,
    };
  }

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
