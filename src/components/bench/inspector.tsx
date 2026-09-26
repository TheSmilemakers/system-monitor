"use client";

import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
  clampWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  nearestDetent,
  sheetDetents,
  shouldDismiss,
} from "@/lib/gestures";
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

const WIDTH_KEY = "sm:inspector-width";
const NARROW = "(max-width: 639px)";

function subscribeNarrow(cb: () => void): () => void {
  const m = window.matchMedia(NARROW);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const readNarrow = () => window.matchMedia(NARROW).matches;

function readWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw ? clampWidth(Number(raw)) : INSPECTOR_DEFAULT_WIDTH;
  } catch {
    return INSPECTOR_DEFAULT_WIDTH;
  }
}

/**
 * The inspector: a parallel panel (no scrim, the table keeps updating
 * beneath) that answers who is this, what does it do, what is it doing now,
 * and what can I do. Enters from the right and leaves to the right on a
 * critically damped spring; a cross-fade under reduced motion. Escape closes.
 *
 * Non-destructive actions (suspend, resume, lower priority, sample, assess,
 * reveal, watch) act immediately and announce their outcome; terminate
 * confirms.
 *
 * Gestures: drag the header rightwards and the drawer follows the hand; the
 * sign of the release velocity decides whether it goes or springs back. Drag
 * the left edge to resize (remembered per browser; the arrow keys work too).
 * On a narrow screen the inspector is a bottom sheet with three detents,
 * peek, half and full, chosen by momentum projection on release.
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
  // The drawer is only ever rendered after a click, so reading storage in the
  // initialiser cannot disagree with a server render.
  const [width, setWidth] = useState(readWidth);
  const resize = useRef({ startX: 0, startWidth: 0, active: false });
  const dragControls = useDragControls();
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
  const detents = useMemo(
    () => sheetDetents(typeof window === "undefined" ? 800 : window.innerHeight),
    // Recomputed when the layout mode flips; the detents follow the viewport then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [narrow],
  );

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

  const spring = { type: "spring" as const, bounce: 0, duration: 0.3 };
  const motionProps = narrow
    ? reduced
      ? {
          initial: { opacity: 0, y: detents.half },
          animate: { opacity: 1, y: detents.half },
          exit: { opacity: 0 },
          transition: { duration: 0.15 },
        }
      : {
          initial: { y: "100%" },
          animate: { y: detents.half },
          exit: { y: "100%" },
          transition: spring,
          drag: "y" as const,
          dragControls,
          dragListener: false,
          dragConstraints: { top: 0, bottom: detents.peek },
          dragElastic: 0.15,
          // Momentum projection, then the nearest detent: motion projects the
          // rest point from the release velocity and asks where to settle.
          dragTransition: {
            bounceStiffness: 400,
            bounceDamping: 40,
            modifyTarget: (target: number) => nearestDetent(target, detents),
          },
        }
    : reduced
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
          transition: spring,
          drag: "x" as const,
          dragControls,
          dragListener: false,
          // Free to the right (dismiss), held on the left; release decides.
          dragConstraints: { left: 0, right: 0 },
          dragElastic: { left: 0, right: 1 },
          onDragEnd: (_e: unknown, info: { velocity: { x: number }; offset: { x: number } }) => {
            if (shouldDismiss(info.velocity.x, info.offset.x)) onClose();
          },
        };

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (reduced) return;
    if (e.target instanceof HTMLElement && e.target.closest("button, a, input")) return;
    dragControls.start(e);
  };

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    resize.current = { startX: e.clientX, startWidth: width, active: true };
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resize.current.active) return;
    setWidth(clampWidth(resize.current.startWidth + (resize.current.startX - e.clientX)));
  };
  const persistWidth = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* storage unavailable: the width lasts the session */
    }
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resize.current.active) return;
    resize.current.active = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    persistWidth(width);
  };
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = clampWidth(width + step);
    setWidth(next);
    persistWidth(next);
  };

  const suspended = detail.data?.suspended ?? false;
  const name = proc?.command ?? "";
  const key = proc ? watchKey(proc) : null;
  const watching = key !== null && watches.some((w) => w.key === key);

  return (
    <AnimatePresence>
      {proc && (
        <motion.div
          key="inspector"
          {...motionProps}
          role="dialog"
          aria-modal="false"
          aria-labelledby="inspector-title"
          className={
            narrow
              ? "glass fixed inset-x-0 top-0 bottom-0 z-40 flex flex-col rounded-t-lg border-t border-border shadow-2xl"
              : "glass fixed inset-y-0 right-0 z-40 flex max-w-[100vw] flex-col border-l border-border shadow-2xl"
          }
          style={narrow ? {} : { width, willChange: "transform" }}
        >
          {!narrow && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize inspector"
              aria-valuenow={width}
              aria-valuemin={INSPECTOR_MIN_WIDTH}
              aria-valuemax={INSPECTOR_MAX_WIDTH}
              tabIndex={0}
              title="Drag to resize; arrow keys work too"
              className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize outline-none hover:bg-phosphor/30 focus-visible:bg-phosphor/40"
              style={{ touchAction: "none" }}
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onPointerCancel={onResizeUp}
              onKeyDown={onResizeKey}
            />
          )}
          <div
            className={`flex items-start justify-between gap-3 border-b border-border px-4 py-3 ${reduced ? "" : "cursor-grab active:cursor-grabbing"}`}
            style={{ touchAction: "none" }}
            onPointerDown={startDrag}
            title={
              reduced
                ? undefined
                : narrow
                  ? "Drag up or down; it settles on the nearest stop"
                  : "Drag to the right to dismiss"
            }
          >
            <div className="min-w-0">
              {narrow && (
                <span
                  aria-hidden="true"
                  className="mx-auto mb-1.5 block h-1 w-10 rounded-full bg-muted-foreground/40"
                />
              )}
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
          </div>

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
                <dt className="text-muted-foreground">launched</dt>
                <dd>
                  {(() => {
                    const launch = detail.data?.launch;
                    const parent = chain[0];
                    if (!launch) return <span className="text-muted-foreground">checking…</span>;
                    switch (launch.kind) {
                      case "launch-item":
                        return (
                          <span title={launch.file ?? undefined}>
                            by launchd via {launch.label}
                            {launch.scope ? ` (${launch.scope} launch item)` : ""}
                          </span>
                        );
                      case "launchd":
                        return launch.label
                          ? `by launchd as ${launch.label}`
                          : "by launchd on demand; no launch item names it";
                      case "parent":
                        return parent
                          ? `by ${parent.command} (${parent.pid})`
                          : `by PID ${proc.ppid}, no longer running`;
                      default:
                        return <span className="text-muted-foreground">unknown</span>;
                    }
                  })()}
                </dd>
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
