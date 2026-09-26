"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { formatBytes, formatDuration } from "@/lib/format";
import {
  appOf,
  childrenOf,
  formatAge,
  indexByPid,
  locationClass,
  parentChain,
} from "@/lib/process-model";
import type { ProcessAlert, ProcessInfo } from "@/lib/schemas";

import { Explainer } from "./explainer";
import { TrustLamp } from "./trust-lamp";

export interface InspectorProps {
  proc: ProcessInfo | null;
  all: ProcessInfo[];
  alerts: ProcessAlert[];
  killingPid: number | null;
  onClose: () => void;
  onInspect: (pid: number) => void;
  onKill: (pid: number, name: string) => void;
}

/**
 * The inspector: a parallel panel (no scrim, the table keeps updating
 * beneath) that answers who is this, what does it do, what is it doing now,
 * and what can I do. Enters from the right and leaves to the right on a
 * critically damped spring; a cross-fade under reduced motion. Escape closes.
 */
export function Inspector({
  proc,
  all,
  alerts,
  killingPid,
  onClose,
  onInspect,
  onKill,
}: InspectorProps) {
  const reduced = useReducedMotion();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!proc) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proc, onClose]);

  const byPid = useMemo(() => indexByPid(all), [all]);
  const chain = useMemo(() => (proc ? parentChain(proc.pid, byPid) : []), [proc, byPid]);
  const children = useMemo(() => (proc ? childrenOf(proc.pid, all) : []), [proc, all]);
  const alert = proc ? alerts.find((a) => a.pid === proc.pid) : undefined;

  const motionProps = reduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.15 },
      }
    : {
        initial: { x: "100%" },
        animate: { x: 0 },
        exit: { x: "100%" },
        transition: { type: "spring" as const, bounce: 0, duration: 0.3 },
      };

  return (
    <AnimatePresence>
      {proc && (
        <motion.aside
          key="inspector"
          {...motionProps}
          role="dialog"
          aria-modal="false"
          aria-labelledby="inspector-title"
          className="glass fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border shadow-2xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <p className="engraved">Inspector</p>
              <h2 id="inspector-title" className="truncate font-display text-lg font-semibold">
                {proc.command}
              </h2>
              <p className="font-mono text-xs text-muted-foreground">
                PID {proc.pid}, running {formatAge(proc.elapsed)}
                {proc.user ? `, as ${proc.user}` : ""}
              </p>
            </div>
            <Button
              ref={closeRef}
              variant="ghost"
              size="sm"
              className="h-6 px-2 font-mono text-xs"
              onClick={onClose}
              aria-label="Close inspector"
            >
              Close
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-3 font-sans text-sm">
            {/* Identity badge */}
            <section
              aria-labelledby="insp-identity"
              className="rounded-md border border-border bg-card p-3"
            >
              <h3 id="insp-identity" className="engraved">
                Identity
              </h3>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <TrustLamp trust={proc.trust} verbose />
                {proc.publisher && (
                  <span className="font-mono text-xs text-muted-foreground">{proc.publisher}</span>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                {proc.bundleId && (
                  <>
                    <dt className="text-muted-foreground">bundle</dt>
                    <dd className="truncate" title={proc.bundleId}>
                      {proc.bundleId}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">app</dt>
                <dd>{appOf(proc)}</dd>
                <dt className="text-muted-foreground">path</dt>
                <dd className="break-all">{proc.path || "no executable path"}</dd>
                <dt className="text-muted-foreground">location</dt>
                <dd>
                  {locationClass(proc.path).label}
                  {locationClass(proc.path).flag && (
                    <span className="lamp ml-2" data-state="caution">
                      <span>unusual</span>
                    </span>
                  )}
                </dd>
              </dl>
            </section>

            {/* Explainer: knowledge base, man page or heuristic; trust line beneath. */}
            <Explainer proc={proc} />

            {/* Live behaviour */}
            <section aria-labelledby="insp-now" className="mt-3">
              <h3 id="insp-now" className="engraved">
                Right now
              </h3>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                <dt className="text-muted-foreground">cpu</dt>
                <dd className={proc.cpu > 50 ? "text-alarm" : proc.cpu > 20 ? "text-amber" : ""}>
                  {proc.cpu.toFixed(1)}% of one core
                  {alert && ` for ${formatDuration(alert.duration)}`}
                </dd>
                <dt className="text-muted-foreground">memory</dt>
                <dd>
                  {formatBytes(proc.rss)} resident, {proc.mem.toFixed(1)}% of RAM
                </dd>
                <dt className="text-muted-foreground">parent</dt>
                <dd className="flex flex-wrap items-center gap-1">
                  {chain.length === 0 && <span className="text-muted-foreground">none listed</span>}
                  {chain.map((p, i) => (
                    <span key={p.pid} className="inline-flex items-center gap-1">
                      {i > 0 && <span aria-hidden="true">←</span>}
                      <button
                        type="button"
                        onClick={() => onInspect(p.pid)}
                        className="hover:underline"
                        aria-label={`Inspect parent ${p.command}, PID ${p.pid}`}
                      >
                        {p.command} ({p.pid})
                      </button>
                    </span>
                  ))}
                </dd>
                <dt className="text-muted-foreground">children</dt>
                <dd>
                  {children.length === 0
                    ? "none"
                    : children.slice(0, 8).map((c, i) => (
                        <span key={c.pid}>
                          {i > 0 && ", "}
                          <button
                            type="button"
                            onClick={() => onInspect(c.pid)}
                            className="hover:underline"
                            aria-label={`Inspect child ${c.command}, PID ${c.pid}`}
                          >
                            {c.command}
                          </button>
                        </span>
                      ))}
                  {children.length > 8 && ` and ${children.length - 8} more`}
                </dd>
              </dl>
            </section>
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              onClick={() => {
                void navigator.clipboard?.writeText(proc.path || proc.command);
              }}
            >
              Copy path
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 px-2 font-mono text-xs text-alarm hover:bg-alarm/10 hover:text-alarm"
              aria-label={`Terminate ${proc.command}, PID ${proc.pid}`}
              onClick={() => onKill(proc.pid, proc.command)}
              disabled={killingPid === proc.pid}
            >
              {killingPid === proc.pid ? "Terminating…" : "Terminate"}
            </Button>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
