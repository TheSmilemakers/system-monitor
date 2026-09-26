"use client";

import { useMemo, useRef, useState } from "react";

import { TrustLamp } from "@/components/bench/trust-lamp";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import {
  FILTERS,
  filterProcesses,
  formatAge,
  sortProcesses,
  type FilterKey,
  type SortDir,
  type SortKey,
} from "@/lib/process-model";
import type { ProcessAlert, ProcessInfo, WatchEntry } from "@/lib/schemas";

export interface ProcessTableProps {
  processes: ProcessInfo[];
  alerts: ProcessAlert[];
  currentUser: string | null;
  killingPid: number | null;
  selectedPid: number | null;
  /** Pinned processes; their rows carry a watch lamp. */
  watches?: WatchEntry[];
  onSelect: (pid: number | null) => void;
  onInspect: (pid: number) => void;
  onKill: (pid: number, name: string) => void;
}

interface Column {
  key: SortKey;
  label: string;
  className: string;
  srLabel?: string;
}

const COLUMNS: Column[] = [
  { key: "trust", label: "Trust", className: "w-24" },
  { key: "pid", label: "PID", className: "w-16 text-right" },
  { key: "command", label: "Process", className: "" },
  { key: "user", label: "User", className: "w-24" },
  { key: "cpu", label: "CPU", className: "w-16 text-right", srLabel: "CPU percent of one core" },
  { key: "mem", label: "Mem", className: "w-16 text-right", srLabel: "memory percent" },
  { key: "rss", label: "RSS", className: "w-20 text-right", srLabel: "resident memory" },
  { key: "elapsed", label: "Age", className: "w-20 text-right" },
];

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  cpu: "desc",
  mem: "desc",
  rss: "desc",
  elapsed: "desc",
  pid: "asc",
  command: "asc",
  user: "asc",
  trust: "asc",
};

/**
 * The workhorse: every process, sortable by any column, filterable by
 * ownership, trust or alert state, searchable, keyboard-driven.
 *
 * Keys (when the table has focus): j / k or the arrows move the selection,
 * Enter or i opens the inspector, x asks to terminate, / focuses search.
 */
export function ProcessTable({
  processes,
  alerts,
  currentUser,
  killingPid,
  selectedPid,
  watches,
  onSelect,
  onInspect,
  onKill,
}: ProcessTableProps) {
  const watchedPaths = useMemo(() => new Set((watches ?? []).map((w) => w.key)), [watches]);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const alertedPids = useMemo(() => new Set(alerts.map((a) => a.pid)), [alerts]);

  const rows = useMemo(
    () =>
      sortProcesses(
        filterProcesses(processes, { filter, query, currentUser, alertedPids }),
        sortKey,
        sortDir,
      ),
    [processes, filter, query, currentUser, alertedPids, sortKey, sortDir],
  );

  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.pid === selectedPid);
    const next =
      idx === -1
        ? delta > 0
          ? 0
          : rows.length - 1
        : Math.min(Math.max(idx + delta, 0), rows.length - 1);
    const pid = rows[next]?.pid;
    if (pid !== undefined) onSelect(pid);
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-pid="${pid}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return; // typing in search
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter":
      case "i":
        if (selectedPid !== null) {
          e.preventDefault();
          onInspect(selectedPid);
        }
        break;
      case "x": {
        const row = rows.find((r) => r.pid === selectedPid);
        if (row) {
          e.preventDefault();
          onKill(row.pid, row.command);
        }
        break;
      }
      case "/":
        e.preventDefault();
        searchRef.current?.focus();
        break;
      default:
        break;
    }
  };

  const summary = `${rows.length} of ${processes.length} processes`;

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div role="group" aria-label="Filter processes" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                filter === f.key
                  ? "border-phosphor/60 bg-phosphor/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span>Search</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="name, path, publisher, pid"
            className="w-56 rounded border border-border bg-tube px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60"
          />
        </label>
        <span role="status" className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {summary}
        </span>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        <table
          tabIndex={0}
          role="grid"
          aria-label="Processes"
          aria-rowcount={rows.length}
          aria-keyshortcuts="j k Enter i x /"
          className="w-full border-collapse font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-phosphor/60"
        >
          <caption className="sr-only">
            Running processes. Sort by any column heading. Each row can be inspected or terminated.
          </caption>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left">
              {COLUMNS.map((c) => {
                const active = c.key === sortKey;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    className={`px-2 py-1.5 font-medium text-muted-foreground ${c.className}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSort(c.key)}
                      className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
                    >
                      {c.label}
                      {c.srLabel && <span className="sr-only"> {c.srLabel}</span>}
                      <span aria-hidden="true" className="text-[9px]">
                        {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
              <th
                scope="col"
                className="w-16 px-2 py-1.5 text-right font-medium text-muted-foreground"
              >
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((proc) => {
              const isAlerted = alertedPids.has(proc.pid);
              const selected = proc.pid === selectedPid;
              const busy = killingPid === proc.pid;
              const cpuTone =
                proc.cpu > 50 ? "text-alarm font-semibold" : proc.cpu > 20 ? "text-amber" : "";
              return (
                <tr
                  key={proc.pid}
                  data-pid={proc.pid}
                  aria-selected={selected}
                  onClick={() => onSelect(proc.pid)}
                  onDoubleClick={() => onInspect(proc.pid)}
                  className={`cursor-default border-b border-border/60 ${
                    selected ? "bg-cathode/10" : isAlerted ? "bg-alarm/5" : "hover:bg-accent/60"
                  }`}
                >
                  <td className="px-2 py-1">
                    <TrustLamp trust={proc.trust} />
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {proc.pid}
                  </td>
                  <td className="max-w-[320px] truncate px-2 py-1" title={proc.path}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onInspect(proc.pid);
                      }}
                      className="truncate text-left hover:underline"
                      aria-label={`Inspect ${proc.command}, PID ${proc.pid}`}
                    >
                      {proc.command}
                    </button>
                    {watchedPaths.has(proc.path) && (
                      <span className="ml-2 lamp" data-state="info" title="Watched">
                        <span aria-hidden="true">watch</span>
                        <span className="sr-only">watched</span>
                      </span>
                    )}
                    {isAlerted && (
                      <span className="ml-2 lamp" data-state="alarm">
                        <span aria-hidden="true">hot</span>
                        <span className="sr-only">flagged: sustained high CPU</span>
                      </span>
                    )}
                    {proc.publisher && proc.trust !== "apple" && (
                      <span className="ml-2 text-muted-foreground">{proc.publisher}</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{proc.user}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${cpuTone}`}>
                    {proc.cpu.toFixed(1)}
                  </td>
                  <td
                    className={`px-2 py-1 text-right tabular-nums ${proc.mem > 5 ? "text-amber" : ""}`}
                  >
                    {proc.mem.toFixed(1)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {formatBytes(proc.rss)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {formatAge(proc.elapsed)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Terminate ${proc.command}, PID ${proc.pid}`}
                      className="h-6 min-h-6 px-2 font-mono text-xs text-alarm hover:bg-alarm/10 hover:text-alarm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onKill(proc.pid, proc.command);
                      }}
                      disabled={busy}
                    >
                      {busy ? "…" : "kill"}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length + 1}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No processes match. Clear the search or choose another filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
