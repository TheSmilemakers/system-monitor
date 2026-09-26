import { NextResponse } from "next/server";

import { enrichProcesses } from "@/lib/enrich";
import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { tick } from "@/lib/monitor";
import { finiteInt } from "@/lib/probe";
import { sample } from "@/lib/sampler";
import { singleFlight } from "@/lib/single-flight";
import { formatSseEvent } from "@/lib/sse";
import { loadWatches } from "@/lib/watch";

/**
 * GET /api/stream?interval=<ms>: the stats sample pushed as server-sent
 * events at the requested cadence, completion-driven (the wait starts when
 * a sample finishes, so a slow probe never queues). One connection per tab;
 * concurrent tabs share a sample through singleFlight. The monitor ticks
 * off the same cadence, as it does from /api/stats. Closing the tab aborts
 * the request and ends the loop.
 */

const CORE_CHECKS = ["cpu/load (top)", "memory (vm_stat)", "processes (ps)"];
export const MIN_INTERVAL_MS = 3_000;
export const MAX_INTERVAL_MS = 30_000;
export const DEFAULT_INTERVAL_MS = 5_000;

const encoder = new TextEncoder();
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export async function GET(request: Request) {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const requested = finiteInt(
    new URL(request.url).searchParams.get("interval"),
    DEFAULT_INTERVAL_MS,
  );
  const interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, requested));
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, payload: unknown) => {
        if (signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, JSON.stringify(payload))));
          return true;
        } catch {
          return false; // the consumer went away between checks
        }
      };
      while (!signal.aborted) {
        try {
          const data = await singleFlight("stats-sample", sample);
          void tick({ processes: data.processes.top }).catch(() => {
            /* the monitor reports its own failures in the timeline */
          });
          const coreFailures = data.unavailable.filter((u) => CORE_CHECKS.includes(u.check));
          const ok =
            coreFailures.length === CORE_CHECKS.length
              ? send("error", {
                  error: "System metrics are unavailable",
                  unavailable: data.unavailable,
                })
              : send("stats", {
                  ...data,
                  processes: { ...data.processes, top: await enrichProcesses(data.processes.top) },
                  watches: await loadWatches(),
                });
          if (!ok) break;
        } catch (e) {
          if (!send("error", { error: e instanceof Error ? e.message : "Sampling failed" })) break;
        }
        await sleep(interval, signal);
      }
      try {
        controller.close();
      } catch {
        /* already closed by the consumer */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
