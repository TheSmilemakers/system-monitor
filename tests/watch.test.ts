import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { toggleWatch, unwatch } from "@/app/actions";
import { GET as getStats } from "@/app/api/stats/route";
import { GET as getTimeline } from "@/app/api/timeline/route";
import { __resetIdentityCache } from "@/lib/identity";
import {
  __resetMonitor,
  __setNotifier,
  diffWatches,
  monitorSettled,
  tick,
  TICK_INTERVAL_MS,
  type Snapshot,
} from "@/lib/monitor";
import { __resetNet } from "@/lib/net";
import { __resetPosture, posture, updatesSettled } from "@/lib/posture";
import { __resetMachineInfo } from "@/lib/probe";
import { watchKey } from "@/lib/process-model";
import { __resetResolveCache } from "@/lib/resolve-host";
import { __resetSampler, sample, type ProcessInfo } from "@/lib/sampler";
import { parseStats, parseTimeline } from "@/lib/schemas";
import {
  __resetWatches,
  addWatch,
  isWatched,
  loadWatches,
  removeWatch,
  WATCH_LIMIT,
  WATCHES_FILE,
} from "@/lib/watch";

import {
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = Date.parse("2026-09-26T03:00:00Z");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let dir = "";
const previous = process.env.SM_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-watch-"));
  process.env.SM_DATA_DIR = dir;
  __resetWatches();
  __resetMonitor();
});
afterEach(async () => {
  await monitorSettled();
  __resetWatches();
  __resetMonitor();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("watchKey", () => {
  test("is the executable path, and null until the path is resolved", () => {
    expect(watchKey({ path: CHROME })).toBe(CHROME);
    expect(watchKey({ path: "kernel_task" })).toBeNull();
    expect(watchKey({ path: "" })).toBeNull();
  });
});

describe("the watch list", () => {
  test("adds once, removes, survives a cache reset, and is capped", async () => {
    expect(await loadWatches()).toEqual([]);
    const a = await addWatch(CHROME, "Google Chrome", T0);
    expect(a.added).toBe(true);
    expect(await isWatched(CHROME)).toBe(true);
    expect((await addWatch(CHROME, "Google Chrome", T0 + 1)).added).toBe(false);
    expect(await loadWatches()).toEqual([{ key: CHROME, name: "Google Chrome", addedAt: T0 }]);

    __resetWatches();
    expect(await loadWatches()).toEqual([{ key: CHROME, name: "Google Chrome", addedAt: T0 }]);

    expect((await removeWatch(CHROME)).removed).toBe(true);
    expect((await removeWatch(CHROME)).removed).toBe(false);
    expect(await isWatched(CHROME)).toBe(false);

    for (let i = 0; i < WATCH_LIMIT; i++) await addWatch(`/opt/bin/tool${i}`, `tool${i}`, T0);
    expect((await addWatch("/opt/bin/one-too-many", "x", T0)).added).toBe(false);
    expect(await loadWatches()).toHaveLength(WATCH_LIMIT);
  });

  test("a torn or foreign document reads as empty", async () => {
    await writeFile(path.join(dir, WATCHES_FILE), '{"watches": [{"key": 1}, "x", {', "utf8");
    expect(await loadWatches()).toEqual([]);
    __resetWatches();
    await writeFile(path.join(dir, WATCHES_FILE), '{"watches": [{"key": 1}, "x"]}', "utf8");
    expect(await loadWatches()).toEqual([]);
  });
});

describe("diffWatches", () => {
  const snap = (processes: Record<string, string>): Snapshot => ({
    ts: T0,
    processes,
    destinations: [],
    ports: [],
    persistence: {},
    posture: {},
    accounts: [],
    admins: [],
    sshKeys: {},
    dns: [],
    extensions: [],
  });
  const watches = [{ key: CHROME, name: "Google Chrome", addedAt: T0 }];

  test("reports a start and a stop relative to the previous tick, never on the first", () => {
    const without = snap({ "/usr/sbin/filecoordinationd": "apple" });
    const withIt = snap({ "/usr/sbin/filecoordinationd": "apple", [CHROME]: "developer-id" });
    expect(diffWatches(null, withIt, watches, T0)).toEqual([]);
    expect(diffWatches(without, without, watches, T0)).toEqual([]);
    expect(diffWatches(withIt, withIt, watches, T0)).toEqual([]);
    expect(diffWatches(without, withIt, watches, T0)).toMatchObject([
      {
        severity: "caution",
        category: "watch",
        subject: CHROME,
        rule: "watch.started",
        message: "Watched process started: Google Chrome.",
      },
    ]);
    expect(diffWatches(withIt, without, watches, T0)).toMatchObject([
      { rule: "watch.stopped", message: "Watched process stopped: Google Chrome." },
    ]);
    expect(diffWatches(without, withIt, [], T0)).toEqual([]);
  });
});

describe("watching end to end", () => {
  const notifications: string[] = [];
  const proc = (over: Partial<ProcessInfo>): ProcessInfo => ({
    user: "rajan",
    pid: 1,
    ppid: 1,
    cpu: 0,
    mem: 0,
    rss: 0,
    command: "x",
    path: "/usr/bin/x",
    elapsed: 0,
    trust: "apple",
    publisher: "Apple",
    bundleId: null,
    ...over,
  });

  beforeEach(async () => {
    __resetMachineInfo();
    __resetSampler();
    __resetIdentityCache();
    __resetNet();
    __resetPosture();
    __resetResolveCache();
    notifications.length = 0;
    __setNotifier(async (_title, message) => {
      notifications.push(message);
    });
    installFakeProbe();
    installFakeCodesign();
    installLoopbackHeaders();
    await posture(T0);
    await updatesSettled();
  });
  afterEach(async () => {
    await updatesSettled();
    resetSeams();
    __setNotifier(null);
    __resetSampler();
  });

  test("the actions refuse a forged Host", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await toggleWatch(648)).success).toBe(false);
    expect((await unwatch(CHROME)).success).toBe(false);
  });

  test("toggleWatch pins by path from the last sample; unwatch drops a stale key", async () => {
    expect(await toggleWatch(900)).toMatchObject({
      success: false,
      error: "That process is not in the current sample",
    });
    await sample();
    expect(await toggleWatch(0)).toMatchObject({ success: false }); // kernel_task has no path
    expect(await toggleWatch(900)).toEqual({ success: true, watching: true });
    expect(await loadWatches()).toMatchObject([{ key: CHROME, name: "Google Chrome" }]);
    expect(await toggleWatch(900)).toEqual({ success: true, watching: false });
    expect(await loadWatches()).toEqual([]);

    await addWatch("/opt/gone/tool", "tool", T0);
    expect(await unwatch("/opt/gone/tool")).toEqual({ success: true });
    expect((await unwatch("/opt/gone/tool")).success).toBe(false);
  });

  test("a watched executable stopping is an event and a notification; stats and timeline carry the list", async () => {
    const chrome = proc({
      pid: 900,
      command: "Google Chrome",
      path: CHROME,
      trust: "developer-id",
    });
    const base = [proc({ path: "/usr/sbin/filecoordinationd" }), chrome];
    await tick({ processes: base }, T0, true); // baseline
    await addWatch(CHROME, "Google Chrome", T0);

    const stopped = await tick({ processes: base.slice(0, 1) }, T0 + TICK_INTERVAL_MS, true);
    expect(stopped).toMatchObject([{ category: "watch", rule: "watch.stopped" }]);
    expect(notifications).toEqual(["Watched process stopped: Google Chrome."]);

    const started = await tick({ processes: base }, T0 + 2 * TICK_INTERVAL_MS, true);
    // Chrome is in the baseline, so only the watch rule speaks.
    expect(started).toMatchObject([{ category: "watch", rule: "watch.started" }]);

    const timeline = parseTimeline(
      await (await getTimeline(new Request("http://localhost/api/timeline"))).json(),
    );
    expect(timeline.watches).toMatchObject([{ key: CHROME, name: "Google Chrome" }]);
    expect(timeline.events.filter((e) => e.category === "watch")).toHaveLength(2);

    const stats = parseStats(await (await getStats()).json());
    await monitorSettled();
    expect(stats.watches).toMatchObject([{ key: CHROME, name: "Google Chrome" }]);
  });

  test("the parsers tolerate a missing or malformed watch list", () => {
    const t = parseTimeline({ events: [], watches: [{ key: "k" }, { key: "/a", name: "a" }] });
    expect(t.watches).toEqual([{ key: "/a", name: "a", addedAt: 0 }]);
    expect(parseTimeline({ events: [] }).watches).toEqual([]);
  });
});
