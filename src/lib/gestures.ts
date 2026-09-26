/**
 * The decisions behind the bench's gestures, kept pure so they are tested
 * without a pointer. The motion library does the tracking and the springs;
 * these functions say what a release means.
 */

export const INSPECTOR_MIN_WIDTH = 320;
export const INSPECTOR_MAX_WIDTH = 760;
export const INSPECTOR_DEFAULT_WIDTH = 448;

/**
 * A rightward swipe on the drawer dismisses it. The sign of the release
 * velocity decides, not the position: a slow drag far to the right that ends
 * moving back left springs home. A firm flick commits even from nearby, and
 * a slow but deliberate drag past `minOffset` commits when still moving right.
 */
export function shouldDismiss(
  velocityX: number,
  offsetX: number,
  { minVelocity = 120, minOffset = 96 } = {},
): boolean {
  if (velocityX <= 0) return false;
  return velocityX > minVelocity || offsetX > minOffset;
}

/** The drawer width the user asked for, kept within what the bench can show. */
export function clampWidth(
  width: number,
  min = INSPECTOR_MIN_WIDTH,
  max = INSPECTOR_MAX_WIDTH,
): number {
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(max, Math.max(min, Math.round(width)));
}

export interface SheetDetents {
  /** Fully open: the sheet's top at the top of the viewport. */
  full: number;
  /** Identity and explainer. */
  half: number;
  /** Identity only, the rest below the fold. */
  peek: number;
}

/** Detents as y offsets of the sheet (0 is fully open) for a viewport height. */
export function sheetDetents(viewportHeight: number): SheetDetents {
  const h = Math.max(320, viewportHeight);
  return { full: 0, half: Math.round(h * 0.45), peek: Math.max(0, Math.round(h - 148)) };
}

/** Which detent a projected rest point lands on: the nearest one. */
export function nearestDetent(target: number, detents: SheetDetents): number {
  const candidates = [detents.full, detents.half, detents.peek];
  let best = candidates[0] ?? 0;
  for (const c of candidates) if (Math.abs(c - target) < Math.abs(best - target)) best = c;
  return best;
}
