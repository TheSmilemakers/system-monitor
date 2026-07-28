import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import { processIdentity, sameIdentity, type ProcessIdentity } from "@/lib/process-identity";

/**
 * M-01 regression suite.
 *
 * The historical defect: `kill -15` exiting 0 only means the signal was *sent*.
 * The old implementation returned success immediately, so the advertised
 * SIGKILL fallback was unreachable for any process that ignores SIGTERM. It
 * also re-derived the target from the bare PID between steps, so PID reuse
 * could redirect the kill onto a different process.
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

describe("process identity", () => {
  test("returns null for impossible pids", async () => {
    expect(await processIdentity(-1)).toBeNull();
    expect(await processIdentity(0)).toBeNull();
    expect(await processIdentity(2.5)).toBeNull();
    expect(await processIdentity(Number.NaN)).toBeNull();
  });

  test("returns null for a pid that does not exist", async () => {
    expect(await processIdentity(999_999)).toBeNull();
  });

  test("identifies a live process with a user and start time", async () => {
    const child = spawn("sleep", ["5"]);
    await sleep(200);
    const id = await processIdentity(child.pid!);
    expect(id).not.toBeNull();
    expect(id!.pid).toBe(child.pid!);
    expect(id!.user.length).toBeGreaterThan(0);
    expect(id!.startedAt.length).toBeGreaterThan(0);
    child.kill("SIGKILL");
  });

  test("identity is stable across repeated reads", async () => {
    const child = spawn("sleep", ["5"]);
    await sleep(200);
    const a = await processIdentity(child.pid!);
    await sleep(150);
    const b = await processIdentity(child.pid!);
    expect(sameIdentity(a!, b!)).toBe(true);
    child.kill("SIGKILL");
  });

  test("sameIdentity rejects a reused pid with a different start time", () => {
    const a: ProcessIdentity = { pid: 42, user: "rajan", startedAt: "Mon Jul 28 09:00:00 2026" };
    const b: ProcessIdentity = { pid: 42, user: "rajan", startedAt: "Mon Jul 28 11:30:00 2026" };
    expect(sameIdentity(a, b)).toBe(false);
  });

  test("sameIdentity rejects a different owner", () => {
    const a: ProcessIdentity = { pid: 42, user: "rajan", startedAt: "T" };
    const b: ProcessIdentity = { pid: 42, user: "root", startedAt: "T" };
    expect(sameIdentity(a, b)).toBe(false);
  });
});

describe("M-01 — signal escalation semantics", () => {
  test("a cooperative process exits on SIGTERM", async () => {
    const child = spawn("sleep", ["10"]);
    await sleep(200);
    const pid = child.pid!;
    process.kill(pid, "SIGTERM");
    expect(await waitForExit(pid)).toBe(true);
  });

  /**
   * The core regression: a process that ignores SIGTERM must still be killed.
   * Under the old code, `kill -15` returned 0, the function returned success,
   * and this process would have survived while the UI reported "Killed".
   */
  test("a process ignoring SIGTERM survives it and requires SIGKILL", async () => {
    const child = spawn("bash", ["-c", "trap '' TERM; sleep 10"]);
    await sleep(300);
    const pid = child.pid!;

    process.kill(pid, "SIGTERM");
    await sleep(600);

    // Still alive — this is precisely what the old implementation reported as success.
    const survived = await processIdentity(pid);
    expect(survived).not.toBeNull();

    process.kill(pid, "SIGKILL");
    expect(await waitForExit(pid)).toBe(true);
  });

  test("signalling an already-exited pid throws ESRCH rather than hitting a stranger", async () => {
    const child = spawn("sleep", ["0.1"]);
    const pid = child.pid!;
    await waitForExit(pid, 3000);
    expect(() => process.kill(pid, "SIGTERM")).toThrow();
  });
});
