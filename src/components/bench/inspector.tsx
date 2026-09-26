"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assessProcess,
  reniceProcess,
  resumeProcess,
  revealProcess,
  sampleProcess,
  suspendProcess,
  toggleWatch,
  type AssessOutcome,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { usePolling } from "@/hooks/use-polling";
import {
  appOf,
  childrenOf,
  formatAge,
  indexByPid,
  locationClass,
  parentChain,
  watchKey,
} from "@/lib/process-model";
import {
  parseProcessDetail,
  type ProcessAlert,
  type ProcessInfo,
  type WatchEntry,
} from "@/lib/schemas";

import { Explainer } from "./explainer";
import { LiveDetail } from "./live-detail";
import { TrustLamp } from "./trust-lamp";

export interface InspectorProps {
  proc: ProcessInfo | null;
  all: ProcessInfo[];
  alerts: ProcessAlert[];
  killingPid: number | null;
  watches: WatchEntry[];
  onClose: () => void;
  onInspect: (pid: number) => void;
  onKill: (pid: number, name: string) => void;
  onNotice: (kind: "ok" | "error", message: string) => void;
  /** The watch list changed on the server; the owner refetches whatever carries it. */
  onWatchToggled: () => void;
}

type ActionKey = "suspend" | "resume" | "renice" | "sample" | "assess" | "reveal" | "watch";

/**
 * The inspector: a parallel panel (no scrim, the table keeps updating
 * beneath) that answers who is this, what does it do, what is it doing now,
 * and what can I do. Enters from the right and leaves to the right on a
 * critically damped spring; a cross-fade under reduced motion. Escape closes.
 *
 * Non-destructive actions (suspend, resume, lower priority, sample, assess,
 * reveal, watch) act immediately and announce their outcome; terminate
 * confirms.
 */
export function Inspector({
  proc,
  all,
  alerts,
  killingPid,
  watches,
  onClose,
  onInspect,
  onKill,
  onNotice,
  onWatchToggled,
}: InspectorProps) {
  const reduced = useReducedMotion();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [sampleText, setSampleText] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<AssessOutcome | null>(null);

  const pid = proc?.pid ?? 0;
  const detail = usePolling({
    url: `/api/process?pid=${pid}`,
    intervalMs: 5_000,
    parse: parseProcessDetail,
    enabled: pid > 0,
  });

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

  const run = useCallback(
    async (
      key: ActionKey,
      fn: () => Promise<{ success: boolean; error?: string }>,
      done: string,
    ) => {
      if (!proc) return;
      setBusy(key);
      try {
        const r = await fn();
        onNotice(r.success ? "ok" : "error", r.success ? done : (r.error ?? "The action failed."));
        if (r.success) detail.refresh();
      } catch {
        onNotice("error", "The request failed.");
      } finally {
        setBusy(null);
      }
    },
    [proc, onNotice, detail],
  );

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

  const suspended = detail.data?.suspended ?? false;
  const name = proc?.command ?? "";
  const key = proc ? watchKey(proc) : null;
  const watching = key !== null && watches.some((w) => w.key === key);

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
                {assessment && assessment.success && (
                  <>
                    <dt className="text-muted-foreground">gatekeeper</dt>
                    <dd>
                      <span
                        className="lamp"
                        data-state={
                          assessment.verdict === "accepted"
                            ? "ok"
                            : assessment.verdict === "rejected"
                              ? "alarm"
                              : "off"
                        }
                      >
                        <span>{assessment.verdict}</span>
                      </span>
                      {assessment.source && <span className="ml-2">{assessment.source}</span>}
                      {assessment.quarantined && (
                        <span className="lamp ml-2" data-state="caution">
                          <span>quarantine flag set</span>
                        </span>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            </section>

            {/* Explainer: knowledge base, man page or heuristic; trust line beneath. */}
            <Explainer proc={proc} />

            {/* Live behaviour */}
            <LiveDetail
              proc={proc}
              alert={alert ?? null}
              detail={detail.data}
              error={detail.error}
            />

            <section aria-labelledby="insp-tree" className="mt-3">
              <h3 id="insp-tree" className="engraved">
                Process tree
              </h3>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
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

            {sampleText && (
              <section aria-labelledby="insp-sample" className="mt-3">
                <h3 id="insp-sample" className="engraved flex items-center justify-between">
                  <span>Sample</span>
                  <button
                    type="button"
                    className="normal-case tracking-normal hover:underline"
                    onClick={() => setSampleText(null)}
                  >
                    clear
                  </button>
                </h3>
                <pre className="mt-1 max-h-64 overflow-auto rounded border border-border bg-tube p-2 font-mono text-[10px] leading-snug">
                  {sampleText}
                </pre>
              </section>
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
            {suspended ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 font-mono text-xs"
                disabled={busy !== null}
                onClick={() => run("resume", () => resumeProcess(proc.pid), `Resumed ${name}.`)}
              >
                {busy === "resume" ? "Resuming…" : "Resume"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 font-mono text-xs"
                disabled={busy !== null}
                title="Pause the process with SIGSTOP; it keeps its state and can be resumed"
                onClick={() => run("suspend", () => suspendProcess(proc.pid), `Suspended ${name}.`)}
              >
                {busy === "suspend" ? "Suspending…" : "Suspend"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              disabled={busy !== null}
              onClick={() =>
                run("renice", () => reniceProcess(proc.pid), `Lowered the priority of ${name}.`)
              }
            >
              {busy === "renice" ? "Lowering…" : "Lower priority"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "sample",
                  async () => {
                    const r = await sampleProcess(proc.pid);
                    if (r.success && r.text) setSampleText(r.text);
                    return r;
                  },
                  `Sampled ${name} for two seconds.`,
                )
              }
            >
              {busy === "sample" ? "Sampling…" : "Sample 2 s"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "assess",
                  async () => {
                    const r = await assessProcess(proc.pid);
                    if (r.success) setAssessment(r);
                    return r;
                  },
                  `Assessed ${name}.`,
                )
              }
            >
              {busy === "assess" ? "Assessing…" : "Assess"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              disabled={busy !== null}
              onClick={() =>
                run("reveal", () => revealProcess(proc.pid), `Revealed ${name} in Finder.`)
              }
            >
              {busy === "reveal" ? "Revealing…" : "Reveal"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              disabled={busy !== null || key === null}
              aria-pressed={watching}
              title={
                key === null
                  ? "Watching needs the executable path, which is still being resolved"
                  : watching
                    ? "Stop reporting when this process starts or stops"
                    : "Report in the timeline, and notify, when this process starts or stops"
              }
              onClick={() =>
                run(
                  "watch",
                  async () => {
                    const r = await toggleWatch(proc.pid);
                    if (r.success) onWatchToggled();
                    return r;
                  },
                  watching ? `Stopped watching ${name}.` : `Watching ${name}.`,
                )
              }
            >
              {busy === "watch" ? "…" : watching ? "Unwatch" : "Watch"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              onClick={() => {
                void navigator.clipboard?.writeText(proc.path || proc.command);
                onNotice("ok", "Copied the path.");
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
