import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assessProcess,
  cleanupItem,
  killProcess,
  reniceProcess,
  resumeProcess,
  revealProcess,
  sampleProcess,
  stopServer,
  suspendProcess,
} from "@/app/actions";
import { probe } from "@/lib/probe";
import {
  CLEANUP_TARGETS,
  __setExtraCleanupTargets,
  type CleanupTarget,
} from "@/lib/cleanup-targets";
import { processIdentity } from "@/lib/process-identity";

import { installFakeProbe, installHeaders, installLoopbackHeaders, resetSeams } from "./fixtures";

/**
 * Server actions invoked as functions.
 *
 * `tests/cleanup-boundary.test.ts` proves the containment helpers; this file
 * proves the actions themselves refuse what they must refuse, and that
 * killProcess really terminates a process it is allowed to.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processIdentity(pid)) === null) return true;
    await sleep(50);
  }
  return false;
}

beforeEach(() => installLoopbackHeaders());
afterEach(() => resetSeams());

describe("every action enforces the trust boundary first", () => {
  test("killProcess refuses a forged Host before touching any process", async () => {
    installHeaders({ host: "monitor.example.com" });
    const r = await killProcess(process.pid);
    expect(r.success).toBe(false);
    expect(r.error).toContain("non-loopback Host");
    expect(await processIdentity(process.pid)).not.toBeNull();
  });

  test("cleanupItem refuses a cross-origin caller", async () => {
    installHeaders({ host: "localhost:3000", origin: "http://evil.test" });
    const r = await cleanupItem("user-caches");
    expect(r.success).toBe(false);
    expect(r.error).toContain("cross-origin");
  });

  test("stopServer refuses a forged Host and keeps the server alive", async () => {
    installHeaders({ host: "192.168.1.48:3000" });
    const r = await stopServer();
    expect(r.success).toBe(false);
    expect(r.error).toContain("non-loopback Host");
  });
});

describe("killProcess", () => {
  test("rejects invalid and protected PIDs without consulting the system", async () => {
    installFakeProbe({
      ps: () => {
        throw new Error("must not be called");
      },
    });
    for (const pid of [0, 1, -1, 2.5, Number.NaN]) {
      const r = await killProcess(pid);
      expect(r.success).toBe(false);
      expect(r.error).toBe("Invalid or protected PID");
    }
  });

  test("a PID that no longer exists is reported as already gone", async () => {
    const r = await killProcess(999_999);
    expect(r).toEqual({ success: true });
  });

  test("refuses a process owned by another user", async () => {
    installFakeProbe({
      ps: (args) => ({
        status: "ok",
        value: args[0] === "-o" ? "root Mon Sep 22 07:00:00 2026" : "",
      }),
      whoami: () => ({ status: "ok", value: "rajan" }),
    });
    const r = await killProcess(4242);
    expect(r.success).toBe(false);
    expect(r.error).toContain('owned by "root"');
  });

  test("refuses when the current user cannot be determined", async () => {
    installFakeProbe({
      ps: (args) => ({
        status: "ok",
        value: args[0] === "-o" ? "rajan Mon Sep 22 07:00:00 2026" : "",
      }),
      whoami: () => ({ status: "denied" }),
    });
    const r = await killProcess(4242);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Could not determine the current user");
  });

  test("terminates a process the caller owns and confirms it is gone", async () => {
    const child = spawn("sleep", ["30"]);
    await sleep(150);
    const pid = child.pid!;
    expect(await processIdentity(pid)).not.toBeNull();

    const r = await killProcess(pid);
    expect(r).toEqual({ success: true });
    expect(await waitForExit(pid)).toBe(true);
  });

  test("escalates to SIGKILL when SIGTERM is ignored (M-01)", async () => {
    // A shell that traps TERM keeps running after the polite signal.
    const child = spawn("bash", ["-c", 'trap "" TERM; sleep 30']);
    await sleep(200);
    const pid = child.pid!;
    expect(await processIdentity(pid)).not.toBeNull();

    const started = Date.now();
    const r = await killProcess(pid);
    expect(r).toEqual({ success: true });
    // The grace period must actually elapse before escalation.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(await waitForExit(pid)).toBe(true);
  }, 10_000);
});

describe("cleanupItem", () => {
  test("unknown ids are refused", async () => {
    const r = await cleanupItem("../../etc");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Unknown cleanup target");
  });

  test("targets that need root are always refused", async () => {
    const target = CLEANUP_TARGETS.find((t) => t.requiresRoot);
    expect(target).toBeDefined();
    const r = await cleanupItem(target!.id);
    expect(r.success).toBe(false);
    expect(r.error).toContain("administrator");
  });

  describe("real deletion in a scratch directory beneath a permitted root", () => {
    const scratch = path.join(
      os.homedir(),
      "Library/Caches",
      `system-monitor-test-${process.pid}-${Date.now()}`,
    );
    const outside = path.join(os.tmpdir(), `system-monitor-outside-${process.pid}`);

    const target = (overrides: Partial<CleanupTarget>): CleanupTarget => ({
      id: "test-scratch",
      category: "Test",
      name: "Scratch",
      absPath: scratch,
      mode: "empty-dir",
      risk: "safe",
      requiresRoot: false,
      description: "scratch",
      minSize: 0,
      ...overrides,
    });

    beforeEach(async () => {
      await rm(scratch, { recursive: true, force: true });
      await mkdir(path.join(scratch, "subdir"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(scratch, "a.txt"), "aaaa");
      await writeFile(path.join(scratch, "subdir", "b.txt"), "bbbbbbbb");
      await writeFile(path.join(outside, "keep.txt"), "must survive");
      // A symlink out of the tree: must be skipped, never followed.
      await symlink(outside, path.join(scratch, "escape"));
    });

    afterEach(async () => {
      __setExtraCleanupTargets(null);
      await rm(scratch, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    test("empties the directory, skips symlinks, and never follows them", async () => {
      __setExtraCleanupTargets([target({})]);
      const r = await cleanupItem("test-scratch");
      expect(r.success).toBe(true);
      expect(r.itemsRemoved).toBe(2);
      expect(r.itemsSkipped).toBe(1);
      expect(r.bytesFreed).toBeGreaterThan(0);

      const left = await readdir(scratch);
      expect(left).toEqual(["escape"]);
      // The symlink's destination is untouched.
      expect(await readdir(outside)).toEqual(["keep.txt"]);
    });

    test("delete-files-older-than removes only old plain files", async () => {
      __setExtraCleanupTargets([target({ mode: "delete-files-older-than", olderThanDays: 7 })]);
      const old = new Date(Date.now() - 30 * 86_400_000);
      await utimes(path.join(scratch, "a.txt"), old, old);

      const r = await cleanupItem("test-scratch");
      expect(r.success).toBe(true);
      expect(r.itemsRemoved).toBe(1); // a.txt is old
      expect(r.itemsSkipped).toBe(2); // subdir is not a file; escape is a symlink

      const left = (await readdir(scratch)).sort();
      expect(left).toEqual(["escape", "subdir"]);
    });

    test("a target resolving outside the permitted roots is refused after realpath", async () => {
      __setExtraCleanupTargets([target({ absPath: outside })]);
      const r = await cleanupItem("test-scratch");
      expect(r.success).toBe(false);
      expect(r.error).toContain("outside the permitted roots");
      expect(await readdir(outside)).toEqual(["keep.txt"]);
    });

    test("a symlinked target is resolved before the containment check", async () => {
      // A link inside a permitted root pointing outside it must not be honoured.
      const link = path.join(scratch, "linked-target");
      await symlink(outside, link);
      __setExtraCleanupTargets([target({ absPath: link })]);
      const r = await cleanupItem("test-scratch");
      expect(r.success).toBe(false);
      expect(r.error).toContain("outside the permitted roots");
      expect(await readdir(outside)).toEqual(["keep.txt"]);
    });
  });

  test("a target whose directory is absent is reported, not created", async () => {
    let absent: string | null = null;
    for (const t of CLEANUP_TARGETS) {
      if (t.requiresRoot) continue;
      try {
        await stat(t.absPath);
      } catch {
        absent = t.id;
        break;
      }
    }
    if (absent === null) return; // every optional target exists on this machine
    const r = await cleanupItem(absent);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Target no longer exists");
  });
});

describe("suspend, resume, renice, sample on an owned process", () => {
  const state = async (pid: number) => {
    const r = await probe("ps", ["-o", "stat=,nice=", "-p", String(pid)]);
    return r.status === "ok" ? r.value.trim().split(/\s+/) : [];
  };

  test("suspend stops the process and resume continues it, verified through ps", async () => {
    const child = spawn("sleep", ["30"]);
    await sleep(150);
    const pid = child.pid!;
    expect(await suspendProcess(pid)).toEqual({ success: true });
    expect((await state(pid))[0]).toMatch(/^T/);
    expect(await resumeProcess(pid)).toEqual({ success: true });
    expect((await state(pid))[0]).not.toMatch(/^T/);
    child.kill("SIGKILL");
  });

  test("renice lowers the priority", async () => {
    const child = spawn("sleep", ["30"]);
    await sleep(150);
    const pid = child.pid!;
    expect(await reniceProcess(pid)).toEqual({ success: true });
    expect(Number((await state(pid))[1])).toBe(10);
    child.kill("SIGKILL");
  });

  test("every process action refuses a protected pid and a foreign owner", async () => {
    const actions: Array<(pid: number) => Promise<{ success: boolean; error?: string }>> = [
      suspendProcess,
      resumeProcess,
      reniceProcess,
      sampleProcess,
      assessProcess,
      revealProcess,
    ];
    for (const fn of actions) {
      expect((await fn(1)).success).toBe(false);
    }
    installFakeProbe({
      ps: (args) => ({
        status: "ok",
        value: args[0] === "-o" ? "root Mon Sep 22 07:00:00 2026" : "",
      }),
      whoami: () => ({ status: "ok", value: "rajan" }),
    });
    expect((await suspendProcess(4242)).error).toContain('owned by "root"');
    expect((await assessProcess(4242)).error).toContain('owned by "root"');
  });

  test("sample returns the head of the report as text", async () => {
    const child = spawn("sleep", ["30"]);
    await sleep(150);
    const pid = child.pid!;
    const r = await sampleProcess(pid);
    child.kill("SIGKILL");
    // sample may be refused for hardened processes; sleep is not one, but be tolerant of the host.
    if (r.success) {
      expect(r.text).toContain("Call graph:");
      expect(r.text!.split("\n").length).toBeLessThanOrEqual(80);
    } else {
      expect(r.error).toContain("sample reported");
    }
  }, 30_000);
});

describe("assess and reveal", () => {
  beforeEach(() => {
    installLoopbackHeaders();
    installFakeProbe();
  });

  test("assess reports Gatekeeper's verdict, the notarisation source and the quarantine flag", async () => {
    const r = await assessProcess(4242);
    expect(r).toMatchObject({
      success: true,
      path: "/Applications/Slack.app/Contents/MacOS/Slack",
      verdict: "accepted",
      notarised: true,
      quarantined: false,
    });
    expect(r.source).toContain("Notarized Developer ID");
  });

  test("a rejected, quarantined binary is reported as such", async () => {
    installFakeProbe({
      spctl: (args) => ({
        status: "failed",
        error: `${args[args.length - 1]}: rejected\nsource=no usable signature`,
      }),
      xattr: () => ({ status: "ok", value: "0083;66f0a1b2;Safari;" }),
    });
    const r = await assessProcess(4242);
    expect(r).toMatchObject({
      success: true,
      verdict: "rejected",
      notarised: false,
      quarantined: true,
    });
  });

  test("reveal asks Finder to show the executable; a missing path is an error", async () => {
    const captured: { args: readonly string[] | null } = { args: null };
    installFakeProbe({
      open: (args) => {
        captured.args = args;
        return { status: "ok", value: "" };
      },
    });
    expect(await revealProcess(4242)).toEqual({ success: true });
    expect(captured.args).toEqual(["-R", "/Applications/Slack.app/Contents/MacOS/Slack"]);

    installFakeProbe({
      ps: (args) =>
        args[1] === "comm="
          ? { status: "ok", value: "titled" }
          : { status: "ok", value: "rajan Mon Sep 22 07:00:00 2026" },
      lsof: () => ({ status: "denied" }),
    });
    expect((await revealProcess(4242)).error).toContain("executable path");
  });
});
