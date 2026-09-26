import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { Scope } from "@/components/bench/scope";
import type { HistoryPoint, ProcessAlert } from "@/lib/schemas";

const point = (i: number, cpu = 20): HistoryPoint => ({
  ts: 1_000_000 + i * 5000,
  cpu,
  mem: 40,
  swap: 0,
  load: 1.5,
  net: 12,
});

const alert = (pid: number): ProcessAlert => ({
  pid,
  command: `proc${pid}`,
  cpu: 80,
  duration: 10,
});

/**
 * happy-dom has no 2D context. A recording stub stands in so the drawing code
 * runs and its calls can be asserted.
 */
const calls: string[] = [];
const ctxStub = new Proxy(
  {},
  {
    get: (_target, prop: string) => {
      if (prop === "canvas") return null;
      return (...args: unknown[]) => {
        calls.push(
          `${prop}(${args.map((a) => (typeof a === "number" ? Math.round(a) : String(a))).join(",")})`,
        );
      };
    },
    set: () => true,
  },
) as unknown as CanvasRenderingContext2D;
const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as typeof realGetContext;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("Scope", () => {
  test("exposes the text equivalent and the legend values", () => {
    render(
      <Scope
        history={[point(0), point(1, 60)]}
        alerts={[]}
        cores={8}
        net={{ inKBps: 8, outKBps: 4 }}
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("CPU now 60%, peak 60%");
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByText("in 8 out 4 KB/s")).toBeTruthy();
  });

  test("draws the wash, the grid, four traces and the alert ticks", () => {
    render(
      <Scope
        history={[point(0), point(1, 60), point(2, 30)]}
        alerts={[alert(648)]}
        cores={8}
        net={{ inKBps: 0, outKBps: 0 }}
      />,
    );
    // Wash first, then dashed grid, then traces and end dots, then the tick.
    expect(calls[0]).toMatch(/^setTransform/);
    expect(calls.some((c) => c.startsWith("fillRect(0,0,"))).toBe(true);
    expect(calls.filter((c) => c === "stroke()").length).toBeGreaterThanOrEqual(3 + 4 + 4 + 1);
    expect(calls.filter((c) => c.startsWith("arc(")).length).toBe(4);
    expect(calls.some((c) => c === "fill()")).toBe(true);
  });

  test("says it is collecting until two samples exist", () => {
    render(<Scope history={[point(0)]} alerts={[]} cores={8} net={{ inKBps: 0, outKBps: 0 }} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Scope: collecting history.");
  });

  test("a new alert sweeps the sync-loss bar once; a repeated alert does not", async () => {
    const history = [point(0), point(1)];
    const { rerender, container } = render(
      <Scope history={history} alerts={[]} cores={8} net={{ inKBps: 0, outKBps: 0 }} />,
    );
    const frame = () => container.querySelector(".scope-frame");
    expect(frame()?.classList.contains("sync-loss")).toBe(false);

    rerender(
      <Scope history={history} alerts={[alert(648)]} cores={8} net={{ inKBps: 0, outKBps: 0 }} />,
    );
    expect(frame()?.classList.contains("sync-loss")).toBe(true);
    await new Promise((r) => setTimeout(r, 360));
    expect(frame()?.classList.contains("sync-loss")).toBe(false);

    // Same alert on the next sample: no second sweep.
    rerender(
      <Scope
        history={[...history, point(2)]}
        alerts={[alert(648)]}
        cores={8}
        net={{ inKBps: 0, outKBps: 0 }}
      />,
    );
    expect(frame()?.classList.contains("sync-loss")).toBe(false);
  });
});
