"use client";

import { Button } from "@/components/ui/button";
import type { SystemStats } from "@/lib/schemas";

import { ThemeControls } from "./theme-controls";

export const REFRESH_OPTIONS = [
  { value: 0, label: "paused" },
  { value: 3000, label: "3 s" },
  { value: 5000, label: "5 s" },
  { value: 10000, label: "10 s" },
  { value: 30000, label: "30 s" },
];

export interface HeaderProps {
  data: SystemStats;
  refreshInterval: number;
  onRefreshIntervalChange: (ms: number) => void;
  onOpenPalette: () => void;
  onStop: () => void;
}

/**
 * The bench's top rail: identity of the machine, uptime and power, the
 * refresh cadence, appearance switches, and the palette shortcut.
 */
export function Header({
  data,
  refreshInterval,
  onRefreshIntervalChange,
  onOpenPalette,
  onStop,
}: HeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-base font-semibold tracking-wide">System Monitor</h1>
        <span className="font-mono text-xs text-muted-foreground">{data.cpu.model}</span>
        <span className="font-mono text-xs text-muted-foreground">up {data.uptime}</span>
        {data.battery && (
          <span className="font-mono text-xs text-muted-foreground">
            {data.battery.charging ? "mains" : "battery"} {data.battery.percent}%
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">
          {data.processes.total} processes, {data.processes.threads} threads
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <label htmlFor="refresh-interval" className="text-muted-foreground">
            Refresh
          </label>
          <select
            id="refresh-interval"
            value={refreshInterval}
            onChange={(e) => onRefreshIntervalChange(Number(e.target.value))}
            className="rounded border border-border bg-bezel px-2 py-0.5 text-xs"
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </span>

        <ThemeControls />

        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 font-mono text-xs"
          onClick={onOpenPalette}
          aria-keyshortcuts="Meta+K Control+K"
        >
          Commands <kbd className="ml-1 rounded border border-border px-1 text-[10px]">⌘K</kbd>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 font-mono text-xs text-alarm hover:bg-alarm/10 hover:text-alarm"
          onClick={onStop}
        >
          Stop server
        </Button>
      </div>
    </header>
  );
}
