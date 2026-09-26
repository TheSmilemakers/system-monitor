import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";

import { useOnDemand, usePolling } from "@/hooks/use-polling";

/**
 * usePolling and useOnDemand against a scripted fetch.
 *
 * Regression covered first: under React Strict Mode the effect runs, is
 * cleaned up (aborting the first fetch) and runs again before that abort has
 * settled. The overlap guard was still set, so the second run's fetch was
 * dropped and the first real sample only arrived after a whole interval
 * (60 s for the posture strip).
 */

type Scripted = { status: number; body: unknown; delayMs?: number };

let calls = 0;
let script: Scripted[] = [];
const realFetch = globalThis.fetch;

function scriptedFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const step = script[Math.min(calls, script.length - 1)] ?? {
      status: 200,
      body: { n: calls + 1 },
    };
    calls++;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, step.delayMs ?? 15);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    return new Response(JSON.stringify(step.body), { status: step.status });
  }) as typeof fetch;
}

function PollProbe({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const s = usePolling({
    url: "/api/thing",
    intervalMs,
    parse: (raw) => {
      if (!raw || typeof raw !== "object" || !("n" in raw)) throw new Error("malformed");
      return raw as { n: number };
    },
  });
  return (
    <div>
      <p role="status">
        {s.phase} {s.data ? `n=${s.data.n}` : "no-data"} {s.stale ? "stale" : "fresh"}{" "}
        {s.error ?? ""}
      </p>
      <button type="button" onClick={s.refresh}>
        refresh
      </button>
    </div>
  );
}

function OnDemandProbe() {
  const s = useOnDemand("/api/scan", (raw) => raw as { n: number });
  return (
    <div>
      <p role="status">
        {s.phase} {s.data ? `n=${s.data.n}` : "no-data"} {s.error ?? ""}
      </p>
      <button type="button" onClick={() => void s.run()}>
        run
      </button>
    </div>
  );
}

beforeEach(() => {
  calls = 0;
  script = [];
  globalThis.fetch = scriptedFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("usePolling", () => {
  test("Strict Mode: the first real sample arrives immediately, not after an interval", async () => {
    render(
      <StrictMode>
        <PollProbe />
      </StrictMode>,
    );
    expect(await screen.findByText(/n=/, {}, { timeout: 2000 })).toBeTruthy();
    // One aborted attempt from the first effect run, one that completed.
    expect(calls).toBe(2);
  });

  test("outside Strict Mode a single fetch is made", async () => {
    render(<PollProbe />);
    expect(await screen.findByText(/success n=1 fresh/, {}, { timeout: 2000 })).toBeTruthy();
    expect(calls).toBe(1);
  });

  test("a failed refresh keeps the last data and marks it stale, with the server's message", async () => {
    script = [
      { status: 200, body: { n: 1 } },
      { status: 503, body: { error: "System metrics are unavailable" } },
    ];
    render(<PollProbe />);
    await screen.findByText(/success n=1/, {}, { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(
      await screen.findByText(
        /error n=1 stale System metrics are unavailable/,
        {},
        { timeout: 2000 },
      ),
    ).toBeTruthy();
  });

  test("a malformed body is a contract error, not a crash", async () => {
    script = [{ status: 200, body: { nope: true } }];
    render(<PollProbe />);
    expect(
      await screen.findByText(/error no-data fresh malformed/, {}, { timeout: 2000 }),
    ).toBeTruthy();
  });

  test("a non-JSON failure falls back to the status code", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    render(<PollProbe />);
    expect(await screen.findByText(/Request failed \(502\)/, {}, { timeout: 2000 })).toBeTruthy();
  });

  test("polls again after the interval", async () => {
    render(<PollProbe intervalMs={30} />);
    expect(await screen.findByText(/n=2/, {}, { timeout: 2000 })).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("useOnDemand", () => {
  test("runs on request and reports success, then an error with stale data", async () => {
    script = [
      { status: 200, body: { n: 7 } },
      { status: 500, body: { error: "boom" } },
    ];
    render(<OnDemandProbe />);
    expect(screen.getByRole("status").textContent).toContain("idle no-data");
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    expect(await screen.findByText(/success n=7/, {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    expect(await screen.findByText(/error n=7 boom/, {}, { timeout: 2000 })).toBeTruthy();
  });

  test("a second run supersedes the first", async () => {
    script = [
      { status: 200, body: { n: 1 }, delayMs: 200 },
      { status: 200, body: { n: 2 }, delayMs: 10 },
    ];
    render(<OnDemandProbe />);
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    expect(await screen.findByText(/success n=2/, {}, { timeout: 2000 })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole("status").textContent).toContain("n=2");
  });
});
