"use client";

import { useSyncExternalStore } from "react";

import {
  currentRetro,
  currentTheme,
  setRetro,
  setTheme,
  type RetroLevel,
  type Theme,
} from "@/lib/prefs";

const RETRO_LABEL: Record<RetroLevel, string> = { "0": "clean", "1": "instrument", "2": "tube" };

/** The <html> data attributes are the store; a MutationObserver is the subscription. */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-retro"],
  });
  return () => observer.disconnect();
}

/**
 * Theme and retro-intensity switches. Both flip a data attribute on <html>
 * on pointer-down, so the change lands on the same frame as the press. The
 * server snapshot is the default so hydration never mismatches.
 */
export function ThemeControls() {
  const theme = useSyncExternalStore<Theme>(subscribe, currentTheme, () => "dark");
  const retro = useSyncExternalStore<RetroLevel>(subscribe, currentRetro, () => "1");

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");
  const cycleRetro = () => setRetro(retro === "0" ? "1" : retro === "1" ? "2" : "0");

  const keyActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Appearance">
      <button
        type="button"
        onPointerDown={toggleTheme}
        onKeyDown={keyActivate(toggleTheme)}
        aria-pressed={theme === "light"}
        className="rounded border border-border bg-bezel px-2 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
      >
        {theme === "dark" ? "night shift" : "daylight"}
      </button>
      <button
        type="button"
        onPointerDown={cycleRetro}
        onKeyDown={keyActivate(cycleRetro)}
        aria-label={`Retro intensity: ${RETRO_LABEL[retro]}. Activate to change.`}
        className="rounded border border-border bg-bezel px-2 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
      >
        retro: {RETRO_LABEL[retro]}
      </button>
    </div>
  );
}
