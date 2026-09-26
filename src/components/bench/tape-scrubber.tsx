"use client";

import { useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { useScrub } from "@/hooks/use-scrub";

/**
 * The tape scrubber: a cassette-counter style control that rewinds the scope
 * and the table through the last hour. The range input tracks the pointer
 * 1:1 and every change updates both views; "Live" returns to now. The
 * counter reads the time being shown and doubles as a jog wheel: drag it
 * sideways, two seconds a pixel, and flick it to coast.
 */
export function TapeScrubber({
  frames,
  at,
  onScrub,
  onLive,
}: {
  /** Recorded frame timestamps, oldest first. */
  frames: number[];
  /** The frame being shown, or null when live. */
  at: number | null;
  onScrub: (ts: number) => void;
  onLive: () => void;
}) {
  const reduced = useReducedMotion();
  const scrub = useScrub({
    frames,
    at,
    msPerPx: 2_000,
    onScrub,
    onLive,
    reduced: reduced ?? false,
  });
  const count = frames.length;
  const index =
    at === null
      ? count - 1
      : Math.max(
          0,
          frames.findIndex((f) => f >= at),
        );
  const shown = at ?? (count ? frames[count - 1] : null);
  const spanMin = count > 1 ? Math.round((frames[count - 1] - frames[0]) / 60_000) : 0;

  return (
    <div
      role="group"
      aria-label="Tape scrubber"
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
    >
      <span className="engraved">Tape</span>
      <span
        className={`segment min-w-[9ch] select-none text-base ${count > 1 ? (scrub.dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
        aria-live="polite"
        style={{ color: at === null ? "var(--phosphor)" : "var(--amber)", touchAction: "pan-y" }}
        title={count > 1 ? "Drag sideways to jog the tape" : undefined}
        onPointerDown={scrub.onPointerDown}
        onPointerMove={scrub.onPointerMove}
        onPointerUp={scrub.onPointerUp}
        onPointerCancel={scrub.onPointerCancel}
      >
        {shown === null
          ? "--:--:--"
          : new Date(shown).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })}
      </span>
      <input
        type="range"
        aria-label={`Rewind through the last ${spanMin} minutes`}
        min={0}
        max={Math.max(count - 1, 0)}
        value={Math.max(index, 0)}
        disabled={count < 2}
        onChange={(e) => {
          const i = Number(e.target.value);
          if (i >= count - 1) onLive();
          else onScrub(frames[i]);
        }}
        className="min-w-[200px] flex-1 accent-[var(--phosphor)]"
      />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {count} frames, {spanMin} min
      </span>
      <Button
        variant={at === null ? "ghost" : "outline"}
        size="sm"
        className="h-6 px-2 font-mono text-xs"
        onClick={onLive}
        disabled={at === null}
      >
        {at === null ? "Live" : "Back to live"}
      </Button>
    </div>
  );
}
