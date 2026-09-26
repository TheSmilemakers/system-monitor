import { identityFor } from "./identity";
import { hasValue, probe } from "./probe";
import type { ProcessInfo } from "./sampler";

/**
 * Executable paths for processes that set their own title.
 *
 * `ps -o comm` reports the process title when one is set (Node prints
 * "next-server (v16.3.6)", Electron apps rename helpers), so the row has no
 * path to sign-check. `lsof -d txt` lists the files mapped as text for a
 * process, and the first one is its executable. One batched call per sample
 * covers every title-bearing row; results are cached per PID and title so
 * PID reuse with a different title cannot serve a stale path.
 */

export const EXEC_PATH_TTL_MS = 10 * 60 * 1000;
const MAX_PIDS_PER_CALL = 200;

interface Entry {
  title: string;
  path: string | null;
  expires: number;
}

const cache = new Map<number, Entry>();

/** Parse `lsof -a -d txt -Fpn -p ...` field output into pid -> first text file. */
export function parseLsofText(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number.parseInt(line.slice(1), 10);
      if (!Number.isFinite(pid)) pid = null;
    } else if (line.startsWith("n") && pid !== null && !out.has(pid)) {
      const path = line.slice(1).trim();
      if (path.startsWith("/")) out.set(pid, path);
    }
  }
  return out;
}

/**
 * Fill `path` (and the identity derived from it) for rows whose ps `comm`
 * was a title rather than a path. Mutates the rows in place; the title is
 * kept as the display name because it is more informative than a basename.
 */
export async function attachExecutablePaths(rows: ProcessInfo[], now = Date.now()): Promise<void> {
  const pending: ProcessInfo[] = [];
  for (const row of rows) {
    if (row.path.startsWith("/")) continue;
    const hit = cache.get(row.pid);
    if (hit && hit.title === row.path && hit.expires > now) {
      if (hit.path) apply(row, hit.path);
      continue;
    }
    pending.push(row);
  }
  if (pending.length === 0) return;

  const batch = pending.slice(0, MAX_PIDS_PER_CALL);
  const res = await probe(
    "lsof",
    ["-a", "-d", "txt", "-Fpn", "-p", batch.map((r) => r.pid).join(",")],
    5_000,
  );
  const found = hasValue(res) ? parseLsofText(res.value) : new Map<number, string>();
  for (const row of batch) {
    const path = found.get(row.pid) ?? null;
    cache.set(row.pid, { title: row.path, path, expires: now + EXEC_PATH_TTL_MS });
    if (path) apply(row, path);
  }
}

function apply(row: ProcessInfo, path: string): void {
  row.path = path;
  const id = identityFor(path);
  row.trust = id.trust;
  row.publisher = id.publisher;
  row.bundleId = id.bundleId;
}

/** Test seam. */
export function __resetExecPathCache(): void {
  cache.clear();
}
