"use client";

/**
 * Per-viewer conveniences: theme and retro intensity.
 *
 * Stored in localStorage and mirrored onto <html> as data attributes, which is
 * what the stylesheet keys from. Storage can be absent or throw (private
 * windows, cleared site data), so every access is guarded and the attribute
 * is the source of truth for the current session.
 */

export type Theme = "dark" | "light";
export type RetroLevel = "0" | "1" | "2";

const THEME_KEY = "sm:theme";
const RETRO_KEY = "sm:retro";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the attribute still applies for this session */
  }
}

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

export function currentTheme(): Theme {
  const attr = root()?.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  const stored = read(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function setTheme(theme: Theme): void {
  const el = root();
  if (el) el.dataset.theme = theme;
  write(THEME_KEY, theme);
}

export function currentRetro(): RetroLevel {
  const attr = root()?.dataset.retro;
  if (attr === "0" || attr === "1" || attr === "2") return attr;
  const stored = read(RETRO_KEY);
  if (stored === "0" || stored === "1" || stored === "2") return stored;
  return "1";
}

export function setRetro(level: RetroLevel): void {
  const el = root();
  if (el) el.dataset.retro = level;
  write(RETRO_KEY, level);
}
