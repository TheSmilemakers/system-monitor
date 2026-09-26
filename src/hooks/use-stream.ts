"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createSseParser } from "@/lib/sse";

import type { PollState } from "./use-polling";

/**
 * A server-sent event stream with the same state shape as usePolling, so a
 * panel can switch transport without changing what it renders.
 *
 * Built on fetch and a body reader rather than EventSource: the same abort
 * discipline as polling, one connection per mount, and a scripted fetch can
 * drive it in tests. Events named `stats` carry a JSON body for `parse`;
 * events named `error` carry `{ error }` and leave the last data showing as
 * stale. A dropped connection reconnects after `retryMs` while the tab is
 * visible; a hidden tab closes the stream and reopens on return.
 */

export interface UseStreamOptions<T> {
  url: string;
  parse: (raw: unknown) => T;
  enabled?: boolean;
  retryMs?: number;
}

const EVENT_NAME = "stats";

export function useStream<T>({ url, parse, enabled = true, retryMs = 2_000 }: UseStreamOptions<T>) {
  const [state, setState] = useState<PollState<T>>({
    phase: "idle",
    data: null,
    error: null,
    stale: false,
    lastUpdated: null,
  });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  // Bumped by refresh() so the effect reconnects without a dependency on state.
  const [epoch, setEpoch] = useState(0);

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!enabled) return;
    // Alias for the cleanup: a counter, not a DOM node, so reading it at
    // cleanup time is the intent (the exhaustive-deps heuristic cannot tell).
    const generationRef = generation;
    const gen = ++generationRef.current;
    const live = () => gen === generation.current;
    const fail = (message: string) => {
      if (!live()) return;
      setState((s) => ({
        phase: "error",
        data: s.data,
        error: message,
        stale: s.data !== null,
        lastUpdated: s.lastUpdated,
      }));
    };

    const connect = async () => {
      if (!live()) return;
      if (typeof document !== "undefined" && document.hidden) return; // reopened by onVisible
      const ac = new AbortController();
      controller.current = ac;
      setState((s) => (s.phase === "idle" ? { ...s, phase: "loading" } : s));
      try {
        const res = await fetch(url, { cache: "no-store", signal: ac.signal });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          const message =
            typeof body === "object" && body !== null && "error" in body
              ? String((body as { error: unknown }).error)
              : `Request failed (${res.status})`;
          throw new Error(message);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const feed = createSseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of feed(decoder.decode(value, { stream: true }))) {
            if (!live()) return;
            if (ev.event === EVENT_NAME) {
              try {
                const parsed = parseRef.current(JSON.parse(ev.data));
                setState({
                  phase: "success",
                  data: parsed,
                  error: null,
                  stale: false,
                  lastUpdated: Date.now(),
                });
              } catch (e) {
                fail(e instanceof Error ? e.message : "Malformed event");
              }
            } else if (ev.event === "error") {
              let message = "The server reported an error";
              try {
                const body = JSON.parse(ev.data) as { error?: unknown };
                if (typeof body.error === "string") message = body.error;
              } catch {
                /* keep the generic message */
              }
              fail(message);
            }
          }
        }
        // The server closed the stream: treat it like a dropped connection.
        throw new Error("The stream ended");
      } catch (e) {
        if (ac.signal.aborted || !live()) return;
        fail(e instanceof Error ? e.message : "Request failed");
        timer.current = setTimeout(() => void connect(), retryMs);
      }
    };

    const onVisible = () => {
      if (!live()) return;
      if (document.hidden) {
        controller.current?.abort();
        if (timer.current) clearTimeout(timer.current);
      } else if (!controller.current || controller.current.signal.aborted) {
        void connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void connect();

    return () => {
      generationRef.current++;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
      controller.current = null;
    };
  }, [url, enabled, retryMs, epoch]);

  return { ...state, refresh };
}
