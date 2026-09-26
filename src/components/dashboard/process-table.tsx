"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";

import { TrustLamp } from "@/components/bench/trust-lamp";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDuration } from "@/lib/format";
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
  /** Off by default; the chooser turns it on and remembers per browser. */
  optional?: boolean;
}

const COLUMNS: Column[] = [
  { key: "trust", label: "Trust", className: "w-24" },
  { key: "pid", label: "PID", className: "w-16 text-right" },
  { key: "ppid", label: "Parent", className: "w-16 text-right", optional: true },
  { key: "command", label: "Process", className: "" },
  { key: "publisher", label: "Publisher", className: "w-40", optional: true },
  { key: "path", label: "Path", className: "max-w-[280px]", optional: true },
  { key: "user", label: "User", className: "w-24" },
  { key: "cpu", label: "CPU", className: "w-16 text-right", srLabel: "CPU percent of one core" },
  { key: "mem", label: "Mem", className: "w-16 text-right", srLabel: "memory percent" },
  { key: "rss", label: "RSS", className: "w-20 text-right", srLabel: "resident memory" },
  {
    key: "connections",
    label: "Conns",
    className: "w-16 text-right",
    srLabel: "established TCP connections",
    optional: true,
  },
  { key: "elapsed", label: "Age", className: "w-20 text-right" },
];

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  cpu: "desc",
  mem: "desc",
  rss: "desc",
  elapsed: "desc",
  connections: "desc",
  pid: "asc",
  ppid: "asc",
  command: "asc",
  publisher: "asc",
  path: "asc",
  user: "asc",
  trust: "asc",
};

// The column choice is a per-viewer convenience kept in localStorage and read
// through an external store: the server snapshot is empty, the client reads the
// stored value after hydration, and a toggle notifies every table on the page.
// When storage is unavailable the value lives in memory for the session.
const COLUMNS_KEY = "sm:columns";
const OPTIONAL_KEYS = COLUMNS.filter((c) => c.optional).map((c) => c.key);
const listeners = new Set<() => void>();
let memoryValue = "";

function subscribeColumns(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function readColumnsRaw(): string {
  try {
    return localStorage.getItem(COLUMNS_KEY) ?? memoryValue;
  } catch {
    return memoryValue;
  }
}

function writeColumnsRaw(value: string): void {
  memoryValue = value;
  try {
    localStorage.setItem(COLUMNS_KEY, value);
  } catch {
    /* storage unavailable: memoryValue carries the session */
  }
  for (const l of listeners) l();
}

function parseColumns(raw: string): Set<SortKey> {
  if (!raw) return new Set();
  try {
    return new Set(
      (JSON.parse(raw) as unknown[]).filter((k): k is SortKey =>
        OPTIONAL_KEYS.includes(k as SortKey),
      ),
    );
  } catch {
    return new Set();
  }
}

/**
 * The workhorse: every process, sortable by any column, filterable by
 * ownership, trust, alert state, network use or novelty, searchable,
 * keyboard-driven. Publisher, path, parent and connection columns are
 * optional and remembered per browser.
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
  const columnsRaw = useSyncExternalStore(subscribeColumns, readColumnsRaw, () => "");
  const shown = useMemo(() => parseColumns(columnsRaw), [columnsRaw]);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const columns = useMemo(() => COLUMNS.filter((c) => !c.optional || shown.has(c.key)), [shown]);
  const toggleColumn = (key: SortKey) => {
    const next = new Set(shown);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    writeColumnsRaw(JSON.stringify([...next]));
  };

  const alertedPids = useMemo(() => new Set(alerts.map((a) => a.pid)), [alerts]);
  const alertByPid = useMemo(() => new Map(alerts.map((a) => [a.pid, a])), [alerts]);

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
    if (pid === undefined) return;
    onSelect(pid);
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-pid="${pid}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return; // typing in search or the chooser
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

  const cell = (proc: ProcessInfo, key: SortKey) => {
    switch (key) {
      case "trust":
        return (
          <td key={key} className="px-2 py-1">
            <TrustLamp trust={proc.trust} />
          </td>
        );
      case "pid":
        return (
          <td key={key} className="px-2 py-1 text-right tabular-nums text-muted-foreground">
            {proc.pid}
          </td>
        );
      case "ppid":
        return (
          <td key={key} className="px-2 py-1 text-right tabular-nums text-muted-foreground">
            {proc.ppid}
          </td>
        );
      case "command": {
        const alert = alertByPid.get(proc.pid);
        return (
          <td key={key} className="max-w-[320px] px-2 py-1" title={proc.path}>
            <div className="truncate">
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
              {proc.newSinceBaseline && (
                <span
                  className="ml-2 lamp"
                  data-state="caution"
                  title="This executable was not running when the baseline was recorded"
                >
                  <span aria-hidden="true">new</span>
                  <span className="sr-only">new since baseline</span>
                </span>
              )}
              {alert && (
                <span className="ml-2 lamp" data-state="alarm">
                  <span aria-hidden="true">hot</span>
                  <span className="sr-only">flagged: sustained high CPU</span>
                </span>
              )}
              {proc.publisher && proc.trust !== "apple" && !shown.has("publisher") && (
                <span className="ml-2 text-muted-foreground">{proc.publisher}</span>
              )}
            </div>
            {alert && (
              <p className="text-[10px] leading-tight text-muted-foreground">
                {alert.cpu.toFixed(0)}% of one core for {formatDuration(alert.duration)}
              </p>
            )}
          </td>
        );
      }
      case "publisher":
        return (
          <td key={key} className="max-w-[160px] truncate px-2 py-1 text-muted-foreground">
            {proc.publisher ?? ""}
          </td>
        );
      case "path":
        return (
          <td
            key={key}
            className="max-w-[280px] truncate px-2 py-1 text-muted-foreground"
            title={proc.path}
          >
            {proc.path}
          </td>
        );
      case "user":
        return (
          <td key={key} className="px-2 py-1 text-muted-foreground">
            {proc.user}
          </td>
        );
      case "cpu": {
        const tone = proc.cpu > 50 ? "text-alarm font-semibold" : proc.cpu > 20 ? "text-amber" : "";
        return (
          <td key={key} className={`px-2 py-1 text-right tabular-nums ${tone}`}>
            {proc.cpu.toFixed(1)}
          </td>
        );
      }
      case "mem":
        return (
          <td
            key={key}
            className={`px-2 py-1 text-right tabular-nums ${proc.mem > 5 ? "text-amber" : ""}`}
          >
            {proc.mem.toFixed(1)}
          </td>
        );
      case "rss":
        return (
          <td key={key} className="px-2 py-1 text-right tabular-nums text-muted-foreground">
            {formatBytes(proc.rss)}
          </td>
        );
      case "connections":
        return (
          <td
            key={key}
            className={`px-2 py-1 text-right tabular-nums ${proc.connections > 0 ? "text-cathode" : "text-muted-foreground"}`}
          >
            {proc.connections}
          </td>
        );
      case "elapsed":
        return (
          <td key={key} className="px-2 py-1 text-right tabular-nums text-muted-foreground">
            {formatAge(proc.elapsed)}
          </td>
        );
      default:
        return null;
    }
  };

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
        <details className="relative font-mono text-[11px]">
          <summary className="cursor-default list-none rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground">
            Columns
          </summary>
          <div
            role="group"
            aria-label="Optional columns"
            className="absolute left-0 z-20 mt-1 flex flex-col gap-1 rounded border border-border bg-card p-2 shadow-lg"
          >
            {COLUMNS.filter((c) => c.optional).map((c) => (
              <label key={c.key} className="flex items-center gap-1.5 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={shown.has(c.key)}
                  onChange={() => toggleColumn(c.key)}
                />
                {c.label}
              </label>
            ))}
          </div>
        </details>
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
              {columns.map((c) => {
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
                  {columns.map((c) => cell(proc, c.key))}
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
                  colSpan={columns.length + 1}
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
