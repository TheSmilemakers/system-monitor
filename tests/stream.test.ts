import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_INTERVAL_MS,
  GET as getStream,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
} from "@/app/api/stream/route";
import { __resetIdentityCache } from "@/lib/identity";
import { __resetMonitor, monitorSettled } from "@/lib/monitor";
import { __resetNet } from "@/lib/net";
import { __resetPosture, updatesSettled } from "@/lib/posture";
import { __resetMachineInfo } from "@/lib/probe";
import { __resetSampler } from "@/lib/sampler";
import { parseStats } from "@/lib/schemas";
import { createSseParser, type SseEvent } from "@/lib/sse";
import { __resetWatches, addWatch } from "@/lib/watch";

import {
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

/**
 * The event stream, driven as a function: the route returns a Response whose
 * body is read with the same parser the browser hook uses. Aborting the
 * request's signal is what closing a tab does.
 */

let dir = "";
const previous = process.env.SM_DATA_DIR;

async function firstEvent(res: Response): Promise<SseEvent> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const feed = createSseParser();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before an event");
    const events = feed(decoder.decode(value, { stream: true }));
    if (events[0]) {
      reader.releaseLock();
      return events[0];
    }
  }
}

async function drain(res: Response): Promise<number> {
  if (!res.body) return 0;
  const reader = res.body.getReader();
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return bytes;
    bytes += value.length;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-stream-"));
  process.env.SM_DATA_DIR = dir;
  __resetMachineInfo();
  __resetSampler();
  __resetIdentityCache();
  __resetNet();
  __resetMonitor();
  __resetPosture();
  __resetWatches();
  installFakeProbe();
  installFakeCodesign();
  installLoopbackHeaders();
});
afterEach(async () => {
  await updatesSettled();
  await monitorSettled();
  resetSeams();
  __resetMonitor();
  __resetSampler();
  __resetWatches();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/stream", () => {
  test("the interval bounds are sane", () => {
    expect(MIN_INTERVAL_MS).toBeLessThanOrEqual(DEFAULT_INTERVAL_MS);
    expect(DEFAULT_INTERVAL_MS).toBeLessThanOrEqual(MAX_INTERVAL_MS);
  });

  test("refuses a forged Host with JSON, not a stream", async () => {
    installHeaders({ host: "evil.example.com" });
    const res = await getStream(new Request("http://localhost/api/stream"));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("pushes a stats event that parses, with the watch list, and ends when the request aborts", async () => {
    await addWatch("/usr/sbin/filecoordinationd", "filecoordinationd", 1);
    const ac = new AbortController();
    const res = await getStream(
      new Request("http://localhost/api/stream?interval=1", { signal: ac.signal }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");

    const ev = await firstEvent(res);
    expect(ev.event).toBe("stats");
    const stats = parseStats(JSON.parse(ev.data));
    expect(stats.processes.top.map((p) => p.command)).toContain("fileproviderd");
    expect(stats.watches).toMatchObject([{ key: "/usr/sbin/filecoordinationd" }]);

    // Closing the tab: the loop wakes from its wait and the stream closes.
    ac.abort();
    const rest = await drain(res);
    expect(rest).toBeGreaterThanOrEqual(0);
  });

  test("a core collection failure is an error event, not zero-filled stats", async () => {
    installFakeProbe({
      top: () => ({ status: "timeout" }),
      vm_stat: () => ({ status: "denied" }),
      ps: () => ({ status: "failed", error: "boom" }),
    });
    const ac = new AbortController();
    const res = await getStream(new Request("http://localhost/api/stream", { signal: ac.signal }));
    const ev = await firstEvent(res);
    expect(ev.event).toBe("error");
    const body = JSON.parse(ev.data) as { error: string; unavailable: { check: string }[] };
    expect(body.error).toContain("unavailable");
    expect(body.unavailable.map((u) => u.check)).toEqual(
      expect.arrayContaining(["cpu/load (top)", "memory (vm_stat)", "processes (ps)"]),
    );
    ac.abort();
    await drain(res);
  });

  test("a stream whose consumer has already gone produces nothing and does not throw", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await getStream(new Request("http://localhost/api/stream", { signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(await drain(res)).toBe(0);
  });
});
