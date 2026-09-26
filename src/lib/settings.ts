import { readJson, writeJson } from "./store";

/**
 * Settings the server keeps for the user, beside the baseline. One so far:
 * whether the monitor may post macOS notifications. Read once and cached;
 * the server action that changes it updates the cache.
 */

export interface Settings {
  notifications: boolean;
}

export const SETTINGS_FILE = "settings.json";
const DEFAULTS: Settings = { notifications: true };

let cache: Settings | undefined;

export async function loadSettings(): Promise<Settings> {
  if (cache === undefined) {
    const doc = await readJson<Partial<Settings>>(SETTINGS_FILE);
    cache = {
      notifications:
        typeof doc?.notifications === "boolean" ? doc.notifications : DEFAULTS.notifications,
    };
  }
  return { ...cache };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await writeJson(SETTINGS_FILE, next);
  cache = next;
  return { ...next };
}

/** Test seam. */
export function __resetSettings(): void {
  cache = undefined;
}
