import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";

import { useStream } from "@/hooks/use-stream";
import { formatSseEvent } from "@/lib/sse";

/**
 * useStream against a scripted fetch whose body is a stream the test feeds.
 * Each connection is recorded with its abort signal and a handle to push
 * events, close, or fail it, so reconnection and cancellation are observable.
 */

interface Connection {
  push: (event: string, data: unknown) => void;
  end: () => void;
  aborted: () => boolean;
}

let connections: Connection[] = [];
let nextStatus = 200;
const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

function streamingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (nextStatus !== 200) {
      const status = nextStatus;
      nextStatus = 200;
      return new Response(JSON.stringify({ error: "nope" }), { status });
    }
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const conn: Connection = {
      push: (event, data) =>
        ctrl?.enqueue(encoder.encode(formatSseEvent(event, JSON.stringify(data)))),
      end: () => {
        try {
          ctrl?.close();
        } catch {
          /* already closed */
        }
      },
      aborted: () => signal?.aborted ?? false,
    };
    signal?.addEventListener("abort", () => {
      try {
        ctrl?.error(new DOMException("aborted", "AbortError"));
      } catch {
        /* already closed */
      }
    });
    connections.push(conn);
    await new Promise((r) => setTimeout(r, 5));
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

function Probe({ enabled = true, retryMs = 30 }: { enabled?: boolean; retryMs?: number }) {
  const s = useStream({
    url: "/api/stream",
    parse: (raw) => {
      if (!raw || typeof raw !== "object" || !("n" in raw)) throw new Error("malformed");
      return raw as { n: number };
    },
    enabled,
    retryMs,
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

const status = () => screen.getByRole("status").textContent ?? "";
const untilConnections = (n: number) =>
  waitFor(() => expect(connections.length).toBeGreaterThanOrEqual(n));

beforeEach(() => {
  connections = [];
  nextStatus = 200;
  globalThis.fetch = streamingFetch();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("useStream", () => {
  test("connects, shows loading, then success on the first stats event", async () => {
    render(<Probe />);
    await untilConnections(1);
    await waitFor(() => expect(status()).toContain("loading"));
    connections[0]?.push("stats", { n: 1 });
    await waitFor(() => expect(status()).toContain("success n=1 fresh"));
  });

  test("Strict Mode: the doubled effect leaves one live connection and data still lands", async () => {
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await untilConnections(2);
    await waitFor(() => expect(connections[0]?.aborted()).toBe(true));
    connections[1]?.push("stats", { n: 3 });
    await waitFor(() => expect(status()).toContain("success n=3"));
  });

  test("an error event keeps the last reading as stale; a closed stream reconnects", async () => {
    render(<Probe />);
    await untilConnections(1);
    connections[0]?.push("stats", { n: 1 });
    await waitFor(() => expect(status()).toContain("n=1"));
    connections[0]?.push("error", { error: "metrics unavailable" });
    await waitFor(() => expect(status()).toContain("error n=1 stale metrics unavailable"));

    connections[0]?.end();
    await untilConnections(2);
    connections[1]?.push("stats", { n: 2 });
    await waitFor(() => expect(status()).toContain("success n=2 fresh"));
  });

  test("a malformed event is a contract error, not a crash", async () => {
    render(<Probe />);
    await untilConnections(1);
    connections[0]?.push("stats", { wrong: true });
    await waitFor(() => expect(status()).toContain("error no-data fresh malformed"));
  });

  test("a non-OK response reports the server's message and retries", async () => {
    nextStatus = 503;
    render(<Probe />);
    await waitFor(() => expect(status()).toContain("error no-data fresh nope"));
    await untilConnections(1);
    connections[0]?.push("stats", { n: 5 });
    await waitFor(() => expect(status()).toContain("success n=5"));
  });

  test("refresh opens a new connection and aborts the old one", async () => {
    render(<Probe />);
    await untilConnections(1);
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await untilConnections(2);
    expect(connections[0]?.aborted()).toBe(true);
  });

  test("a hidden tab closes the stream and a visible one reopens it; disabled opens nothing", async () => {
    render(<Probe />);
    await untilConnections(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(connections[0]?.aborted()).toBe(true));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await untilConnections(2);

    cleanup();
    connections = [];
    render(<Probe enabled={false} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(connections).toHaveLength(0);
    expect(status()).toContain("idle");
  });
});
