"use client";

import { animate, type AnimationPlaybackControls } from "motion";
import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Scrubbing the tape by hand: drag the scope's time axis (or the counter)
 * and the shown moment follows the pointer 1:1. On release, the last four
 * positions give a velocity, the deceleration function projects where a
 * flick would come to rest, the nearest recorded frame is chosen, and a
 * critically damped spring carries the view there, starting at the release
 * velocity so there is no seam. Grabbing again mid-flight takes over from
 * wherever the animation is. Under reduced motion the view jumps.
 */

export interface ScrubOptions {
  /** Recorded frame timestamps, oldest first. */
  frames: readonly number[];
  /** The frame being shown, or null when live. */
  at: number | null;
  /** How much time one pixel of drag is worth; a function reads it from the dragged element on pointer-down. */
  msPerPx: number | ((el: HTMLElement) => number);
  /** The clock for release velocity; injectable for tests. */
  now?: () => number;
  onScrub: (ts: number) => void;
  onLive: () => void;
  reduced: boolean;
}

/** Apple's scroll projection: where a flick at `velocity` px/s comes to rest. */
export function projectDeceleration(velocity: number, rate = 0.998): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/** The recorded frame nearest a moment, or null when nothing is recorded. */
export function nearestFrame(frames: readonly number[], ts: number): number | null {
  let best: number | null = null;
  for (const f of frames) {
    if (best === null || Math.abs(f - ts) < Math.abs(best - ts)) best = f;
  }
  return best;
}

/** Velocity in px/s from the last few pointer samples; zero when too few or too old. */
export function releaseVelocity(samples: readonly { x: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const first = samples[0];
  if (!last || !first) return 0;
  const dt = last.t - first.t;
  if (dt <= 0 || dt > 250) return 0;
  return ((last.x - first.x) / dt) * 1000;
}

export function useScrub({
  frames,
  at,
  msPerPx,
  onScrub,
  onLive,
  reduced,
  now = () => performance.now(),
}: ScrubOptions) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startEnd = useRef(0);
  const samples = useRef<{ x: number; t: number }[]>([]);
  const current = useRef<number | null>(null);
  const flight = useRef<AnimationPlaybackControls | null>(null);
  const scale = useRef(1);

  const latest = frames.length > 0 ? frames[frames.length - 1] : undefined;
  const earliest = frames[0];

  // Show a moment: the nearest frame, or live when it is the newest one.
  const show = useCallback(
    (ts: number) => {
      const frame = nearestFrame(frames, ts);
      if (frame === null) return;
      if (frame === current.current) return;
      current.current = frame;
      if (frame === latest) onLive();
      else onScrub(frame);
    },
    [frames, latest, onLive, onScrub],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (latest === undefined || earliest === undefined || e.button !== 0) return;
      flight.current?.stop();
      flight.current = null;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      startX.current = e.clientX;
      startEnd.current = current.current ?? at ?? latest;
      scale.current = typeof msPerPx === "function" ? msPerPx(e.currentTarget) : msPerPx;
      samples.current = [{ x: e.clientX, t: now() }];
      setDragging(true);
    },
    [at, earliest, latest, msPerPx, now],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragging || latest === undefined || earliest === undefined) return;
      samples.current = [...samples.current.slice(-3), { x: e.clientX, t: now() }];
      // Dragging right pulls older frames into view: the content follows the hand.
      const end = startEnd.current - (e.clientX - startX.current) * scale.current;
      show(Math.min(latest, Math.max(earliest, end)));
    },
    [dragging, earliest, latest, now, show],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragging) return;
      setDragging(false);
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (latest === undefined || earliest === undefined) return;
      const velocity = releaseVelocity(samples.current);
      const from = current.current ?? startEnd.current;
      const projected = from - projectDeceleration(velocity) * scale.current;
      const target = nearestFrame(frames, Math.min(latest, Math.max(earliest, projected)));
      if (target === null) return;
      if (reduced || Math.abs(target - from) < 1) {
        show(target);
        return;
      }
      flight.current = animate(from, target, {
        type: "spring",
        bounce: 0,
        duration: 0.4,
        velocity: -velocity * scale.current,
        onUpdate: (v) => show(v),
        onComplete: () => show(target),
      });
    },
    [dragging, earliest, frames, latest, reduced, show],
  );

  return { dragging, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
