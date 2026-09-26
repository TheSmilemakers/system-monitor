"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ProcessInfo } from "@/lib/schemas";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string | undefined;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  processes: ProcessInfo[];
  actions: PaletteAction[];
  onInspect: (pid: number) => void;
}

interface Item {
  id: string;
  label: string;
  hint?: string | undefined;
  run: () => void;
}

/**
 * Command palette (⌘K): jump to a process by name or PID, or run an action.
 * A plain, accessible combobox; arrows move, Enter runs, Escape closes.
 */
export function CommandPalette({
  open,
  onClose,
  processes,
  actions,
  onInspect,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const acts: Item[] = actions
      .filter((a) => q.length === 0 || a.label.toLowerCase().includes(q))
      .map((a) => ({ id: `action:${a.id}`, label: a.label, hint: a.hint, run: a.run }));
    if (q.length === 0) return acts;
    const procs: Item[] = processes
      .filter(
        (p) =>
          p.command.toLowerCase().includes(q) ||
          String(p.pid) === q ||
          (p.publisher?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 12)
      .map((p) => ({
        id: `proc:${p.pid}`,
        label: `Inspect ${p.command}`,
        hint: `PID ${p.pid}, ${p.cpu.toFixed(1)}% CPU${p.publisher ? `, ${p.publisher}` : ""}`,
        run: () => onInspect(p.pid),
      }));
    return [...procs, ...acts];
  }, [query, processes, actions, onInspect]);

  const clampedActive = Math.min(active, Math.max(items.length - 1, 0));

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    setQuery("");
    setActive(0);
    item.run();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-tube/60 p-4 pt-[12vh]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass w-full max-w-lg overflow-hidden rounded-md border border-border shadow-2xl"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={
            items[clampedActive] ? `palette-${items[clampedActive].id}` : undefined
          }
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[clampedActive]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Type a process name, a PID, or a command"
          className="w-full border-b border-border bg-transparent px-4 py-3 font-mono text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <ul id="palette-list" role="listbox" className="max-h-80 overflow-auto py-1">
          {items.length === 0 && (
            <li className="px-4 py-3 font-mono text-xs text-muted-foreground">Nothing matches.</li>
          )}
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={i === clampedActive}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(item);
              }}
              onPointerEnter={() => setActive(i)}
              className={`flex cursor-default items-baseline justify-between gap-3 px-4 py-1.5 font-mono text-xs ${
                i === clampedActive ? "bg-cathode/15 text-foreground" : "text-foreground/90"
              }`}
            >
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-muted-foreground">{item.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
