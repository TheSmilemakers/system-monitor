import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Durable local state for the monitor: the baseline document and the
 * append-only event log.
 *
 * Lives under ~/Library/Application Support/system-monitor, never in the
 * repository. Plain JSON and JSONL: the server runs under Node (Next), where
 * Bun's SQLite is unavailable and Node's is version-gated, and the volumes
 * here (one baseline, a few events an hour) do not need a database. Writes
 * are atomic (temp file then rename) so a crash cannot leave a torn file.
 * SM_DATA_DIR overrides the location, which tests use for a scratch dir.
 */

export function dataDir(): string {
  const override = process.env.SM_DATA_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), "Library", "Application Support", "system-monitor");
}

async function ensureDir(): Promise<string> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson<T>(name: string): Promise<T | null> {
  try {
    const raw = await readFile(path.join(dataDir(), name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  const dir = await ensureDir();
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, target);
}

/** Append one JSON line. Each call is a single write, so lines never interleave. */
export async function appendJsonl(name: string, value: unknown): Promise<void> {
  const dir = await ensureDir();
  await appendFile(path.join(dir, name), `${JSON.stringify(value)}\n`, "utf8");
}

/** Read every line that parses; a torn last line is skipped, not fatal. */
export async function readJsonl<T>(name: string): Promise<T[]> {
  try {
    const raw = await readFile(path.join(dataDir(), name), "utf8");
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Rewrite a JSONL file with only the entries that pass `keep`. */
export async function compactJsonl<T>(name: string, keep: (entry: T) => boolean): Promise<number> {
  const entries = (await readJsonl<T>(name)).filter(keep);
  const dir = await ensureDir();
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
    "utf8",
  );
  await rename(tmp, target);
  return entries.length;
}
