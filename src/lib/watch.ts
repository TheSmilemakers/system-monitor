import { readJson, writeJson } from "./store";

/**
 * The watch list: processes the user has pinned so the monitor reports when
 * they start and stop. A watch is keyed by executable path (or by name when
 * the path is unknown), so it survives PID reuse and restarts. Stored beside
 * the baseline; capped so a runaway client cannot grow it without bound.
 */

export interface Watch {
  /** The executable path, or `name:<command>` when there is no path. */
  key: string;
  /** What to call it in events and chips. */
  name: string;
  addedAt: number;
}

export const WATCHES_FILE = "watches.json";
export const WATCH_LIMIT = 50;

interface WatchDoc {
  watches: Watch[];
}

let cache: Watch[] | undefined;

export async function loadWatches(): Promise<Watch[]> {
  if (cache === undefined) {
    const doc = await readJson<WatchDoc>(WATCHES_FILE);
    cache = Array.isArray(doc?.watches)
      ? doc.watches.filter(
          (w): w is Watch =>
            typeof w === "object" &&
            w !== null &&
            typeof w.key === "string" &&
            typeof w.name === "string" &&
            typeof w.addedAt === "number",
        )
      : [];
  }
  return [...cache];
}

async function save(watches: Watch[]): Promise<void> {
  cache = watches;
  await writeJson(WATCHES_FILE, { watches } satisfies WatchDoc);
}

/** Add a watch. Adding one that exists is a no-op; the list is capped. */
export async function addWatch(
  key: string,
  name: string,
  now = Date.now(),
): Promise<{ added: boolean; watches: Watch[] }> {
  const current = await loadWatches();
  if (current.some((w) => w.key === key)) return { added: false, watches: current };
  if (current.length >= WATCH_LIMIT) return { added: false, watches: current };
  const next = [...current, { key, name, addedAt: now }];
  await save(next);
  return { added: true, watches: next };
}

export async function removeWatch(key: string): Promise<{ removed: boolean; watches: Watch[] }> {
  const current = await loadWatches();
  const next = current.filter((w) => w.key !== key);
  if (next.length === current.length) return { removed: false, watches: current };
  await save(next);
  return { removed: true, watches: next };
}

export async function isWatched(key: string): Promise<boolean> {
  return (await loadWatches()).some((w) => w.key === key);
}

/** Test seam: forget the cached list so the next read hits the store. */
export function __resetWatches(): void {
  cache = undefined;
}
