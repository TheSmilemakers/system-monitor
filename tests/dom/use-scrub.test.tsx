import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { nearestFrame, projectDeceleration, releaseVelocity, useScrub } from "@/hooks/use-scrub";

/**
 * The scrub gesture against synthetic pointer events. Reduced motion is on
 * for determinism: the view jumps to the projected frame instead of
 * springing there, which is the same decision without the tween.
 */

const T0 = 1_700_000_000_000;
const FRAMES = Array.from({ length: 61 }, (_, i) => T0 + i * 5_000); // five minutes, 5 s apart

let calls: string[] = [];
let clock = 0;

function Probe({
  msPerPx,
  at = null,
  reduced = true,
}: {
  msPerPx: number;
  at?: number | null;
  reduced?: boolean;
}) {
  const scrub = useScrub({
    frames: FRAMES,
    at,
    msPerPx,
    onScrub: (ts) => calls.push(`scrub:${(ts - T0) / 1000}`),
    onLive: () => calls.push("live"),
    reduced,
    now: () => clock,
  });
  return (
    <div
      data-testid="axis"
      data-dragging={scrub.dragging}
      onPointerDown={scrub.onPointerDown}
      onPointerMove={scrub.onPointerMove}
      onPointerUp={scrub.onPointerUp}
      onPointerCancel={scrub.onPointerCancel}
    />
  );
}
afterEach(() => {
  cleanup();
  calls = [];
  clock = 0;
});

describe("the arithmetic", () => {
  test("projectDeceleration is the exponential-decay rest point", () => {
    expect(projectDeceleration(1000)).toBeCloseTo(499, 0);
    expect(projectDeceleration(-1000)).toBeCloseTo(-499, 0);
    expect(projectDeceleration(0)).toBe(0);
  });

  test("nearestFrame picks the closest recorded moment", () => {
    expect(nearestFrame(FRAMES, T0 + 12_400)).toBe(T0 + 10_000);
    expect(nearestFrame(FRAMES, T0 + 12_600)).toBe(T0 + 15_000);
    expect(nearestFrame([], T0)).toBeNull();
  });

  test("releaseVelocity uses the recent samples and ignores a stale or lone one", () => {
    expect(releaseVelocity([{ x: 0, t: 0 }])).toBe(0);
    expect(
      releaseVelocity([
        { x: 0, t: 0 },
        { x: 50, t: 100 },
      ]),
    ).toBe(500);
    expect(
      releaseVelocity([
        { x: 0, t: 0 },
        { x: 50, t: 1000 },
      ]),
    ).toBe(0);
  });
});

describe("useScrub", () => {
  test("dragging right pulls older frames into view, snapped to samples, and releasing without a flick stays", () => {
    render(<Probe msPerPx={1000} />);
    const axis = screen.getByTestId("axis");
    fireEvent.pointerDown(axis, { clientX: 100, button: 0, pointerId: 1 });
    expect(axis.getAttribute("data-dragging")).toBe("true");
    clock = 400;
    // 12 px at a second a pixel: twelve seconds back, nearest frame is 10 s before the newest (300 s).
    fireEvent.pointerMove(axis, { clientX: 112, pointerId: 1 });
    expect(calls).toEqual(["scrub:290"]);
    // One pixel back (eleven seconds): still nearest 290, so no repeat call.
    clock = 800;
    fireEvent.pointerMove(axis, { clientX: 111, pointerId: 1 });
    expect(calls).toEqual(["scrub:290"]);
    clock = 1200;
    fireEvent.pointerUp(axis, { clientX: 111, pointerId: 1 });
    expect(axis.getAttribute("data-dragging")).toBe("false");
    expect(calls).toEqual(["scrub:290"]);
  });

  test("dragging back past the newest frame returns to live, and the window is clamped at both ends", () => {
    render(<Probe msPerPx={1000} at={T0 + 100_000} />);
    const axis = screen.getByTestId("axis");
    fireEvent.pointerDown(axis, { clientX: 0, button: 0, pointerId: 1 });
    clock = 400;
    fireEvent.pointerMove(axis, { clientX: -500, pointerId: 1 }); // 500 s forward: clamp to newest
    expect(calls).toEqual(["live"]);
    clock = 800;
    fireEvent.pointerMove(axis, { clientX: 5000, pointerId: 1 }); // way back: clamp to oldest
    expect(calls).toEqual(["live", "scrub:0"]);
    clock = 1200;
    fireEvent.pointerUp(axis, { clientX: 5000, pointerId: 1 });
  });

  test("a flick projects past the release point and settles on a frame", () => {
    render(<Probe msPerPx={1000} />);
    const axis = screen.getByTestId("axis");
    clock = 1000;
    fireEvent.pointerDown(axis, { clientX: 0, button: 0, pointerId: 1 });
    // 40 px in 40 ms: 1000 px/s to the right, which projects ~499 px further back.
    clock = 1020;
    fireEvent.pointerMove(axis, { clientX: 20, pointerId: 1 });
    clock = 1040;
    fireEvent.pointerMove(axis, { clientX: 40, pointerId: 1 });
    fireEvent.pointerUp(axis, { clientX: 40, pointerId: 1 });
    const last = calls[calls.length - 1];
    // Release at 40 s back (260); projection adds ~499 s, clamped to the oldest frame.
    expect(last).toBe("scrub:0");
  });

  test("a secondary button or an empty tape does nothing", () => {
    render(<Probe msPerPx={1000} />);
    const axis = screen.getByTestId("axis");
    fireEvent.pointerDown(axis, { clientX: 0, button: 2, pointerId: 1 });
    expect(axis.getAttribute("data-dragging")).toBe("false");
    fireEvent.pointerMove(axis, { clientX: 50, pointerId: 1 });
    expect(calls).toEqual([]);
  });

  test("with motion, a flick springs from the release velocity and lands on a frame", async () => {
    render(<Probe msPerPx={1000} reduced={false} />);
    const axis = screen.getByTestId("axis");
    clock = 1000;
    fireEvent.pointerDown(axis, { clientX: 0, button: 0, pointerId: 1 });
    clock = 1020;
    fireEvent.pointerMove(axis, { clientX: 10, pointerId: 1 });
    clock = 1040;
    fireEvent.pointerMove(axis, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(axis, { clientX: 20, pointerId: 1 });
    // 500 px/s projects 249.5 s further back from 280: the 30 s frame.
    await waitFor(() => expect(calls[calls.length - 1]).toBe("scrub:30"), { timeout: 3000 });
    // The spring passed through intermediate frames on the way.
    expect(calls.length).toBeGreaterThan(2);
  });
});
