"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Completion-driven polling with cancellation and visibility pausing (M-06).
 *
 * Replaces `setInterval(fetch, interval)`, which started requests independently
 * of whether the previous one had finished. Because collection was synchronous
 * and slower than the 3 s default interval, requests queued without bound and
 * stale responses could overwrite newer state.
 *
 * Guarantees:
 *   - at most one request in flight;
 *   - the next request is scheduled only after the previous settles;
 *   - responses from superseded requests are discarded (generation counter);
 *   - polling pauses while the tab is hidden and resumes on return;
 *   - everything is aborted on unmount.
 */

export type PollPhase = "idle" | "loading" | "success" | "error";

export interface PollState<T> {
  phase: PollPhase;
  data: T | null;
  error: string | null;
  /** True when showing data from a previous successful poll after a failure. */
  stale: boolean;
  lastUpdated: number | null;
}

export interface UsePollingOptions<T> {
  url: string;
  intervalMs: number;
  parse: (raw: unknown) => T;
  enabled?: boolean;
}

export function usePolling<T>({ url, intervalMs, parse, enabled = true }: UsePollingOptions<T>) {
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
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const parseRef = useRef(parse);
  parseRef.current = parse;

  const fetchOnce = useCallback(async () => {
    if (inFlight.current) return; // overlap guard
    inFlight.current = true;

    const gen = ++generation.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;

    setState((s) => (s.phase === "idle" ? { ...s, phase: "loading" } : s));

    try {
      const res = await fetch(url, { cache: "no-store", signal: ac.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `Request failed (${res.status})`;
        throw new Error(message);
      }
      const parsed = parseRef.current(await res.json());

      // Discard superseded responses.
      if (!mounted.current || gen !== generation.current) return;
      setState({
        phase: "success",
        data: parsed,
        error: null,
        stale: false,
        lastUpdated: Date.now(),
      });
    } catch (e) {
      if (ac.signal.aborted) return;
      if (!mounted.current || gen !== generation.current) return;
      const message = e instanceof Error ? e.message : "Request failed";
      setState((s) => ({
        phase: "error",
        data: s.data,
        error: message,
        stale: s.data !== null,
        lastUpdated: s.lastUpdated,
      }));
    } finally {
      // Only the current request may release the guard: an aborted, superseded
      // request settling late must not clear a newer one's flag.
      if (gen === generation.current) inFlight.current = false;
    }
  }, [url]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;

    let cancelled = false;
    // Aliases for the cleanup: these are counters, not DOM nodes, so reading
    // them at cleanup time is the intent (the exhaustive-deps heuristic cannot
    // tell the difference).
    const guard = inFlight;
    const generationRef = generation;

    const tick = async () => {
      if (cancelled || !mounted.current) return;
      if (typeof document !== "undefined" && document.hidden) {
        // Paused while hidden — re-check shortly rather than collecting.
        timer.current = setTimeout(tick, 1_000);
        return;
      }
      await fetchOnce();
      if (cancelled || !mounted.current) return;
      timer.current = setTimeout(tick, intervalMs);
    };

    void tick();

    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
      // Release the overlap guard synchronously. Under React Strict Mode the
      // effect runs, is cleaned up, and runs again before the aborted fetch's
      // rejection has settled; without this the second run's fetch was dropped
      // by the guard and the first real sample waited a whole interval.
      generationRef.current++;
      guard.current = false;
    };
  }, [enabled, intervalMs, fetchOnce, refresh]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return { ...state, refresh };
}

/** One-shot fetch with the same validation and cancellation discipline. */
export function useOnDemand<T>(url: string, parse: (raw: unknown) => T) {
  const [state, setState] = useState<PollState<T>>({
    phase: "idle",
    data: null,
    error: null,
    stale: false,
    lastUpdated: null,
  });
  const controller = useRef<AbortController | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const run = useCallback(async () => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setState((s) => ({ ...s, phase: "loading", error: null }));
    try {
      const res = await fetch(url, { cache: "no-store", signal: ac.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `Request failed (${res.status})`;
        throw new Error(message);
      }
      const parsed = parseRef.current(await res.json());
      setState({
        phase: "success",
        data: parsed,
        error: null,
        stale: false,
        lastUpdated: Date.now(),
      });
    } catch (e) {
      if (ac.signal.aborted) return;
      setState((s) => ({
        phase: "error",
        data: s.data,
        error: e instanceof Error ? e.message : "Request failed",
        stale: s.data !== null,
        lastUpdated: s.lastUpdated,
      }));
    }
  }, [url]);

  useEffect(() => () => controller.current?.abort(), []);

  return { ...state, run };
}
