import { describe, expect, test } from "bun:test";

import {
  clampWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  nearestDetent,
  sheetDetents,
  shouldDismiss,
} from "@/lib/gestures";

describe("shouldDismiss: the sign of the release velocity decides", () => {
  test("a firm rightward flick commits from anywhere", () => {
    expect(shouldDismiss(400, 10)).toBe(true);
    expect(shouldDismiss(121, 0)).toBe(true);
  });
  test("a slow drag far right commits only if still moving right", () => {
    expect(shouldDismiss(20, 200)).toBe(true);
    expect(shouldDismiss(0, 300)).toBe(false);
    expect(shouldDismiss(-50, 300)).toBe(false);
  });
  test("a small, slow nudge springs home", () => {
    expect(shouldDismiss(50, 40)).toBe(false);
  });
  test("thresholds are adjustable", () => {
    expect(shouldDismiss(50, 40, { minVelocity: 40 })).toBe(true);
    expect(shouldDismiss(50, 40, { minOffset: 30 })).toBe(true);
  });
});

describe("clampWidth", () => {
  test("keeps the drawer within the bench and rounds", () => {
    expect(clampWidth(100)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampWidth(5000)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampWidth(500.4)).toBe(500);
    expect(clampWidth(Number.NaN)).toBe(INSPECTOR_DEFAULT_WIDTH);
    expect(clampWidth(200, 150, 300)).toBe(200);
  });
});

describe("sheet detents", () => {
  test("three detents from the viewport height, with a floor for tiny screens", () => {
    expect(sheetDetents(800)).toEqual({ full: 0, half: 360, peek: 652 });
    expect(sheetDetents(100)).toEqual({ full: 0, half: 144, peek: 172 });
  });
  test("nearestDetent picks the closest to the projected rest point", () => {
    const d = sheetDetents(800);
    expect(nearestDetent(-40, d)).toBe(0);
    expect(nearestDetent(200, d)).toBe(360);
    expect(nearestDetent(520, d)).toBe(652);
    expect(nearestDetent(900, d)).toBe(652);
  });
});
