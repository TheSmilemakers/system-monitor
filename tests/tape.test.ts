import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { GET as getTape } from "@/app/api/tape/route";
import { __resetIdentityCache } from "@/lib/identity";
import { __resetNet } from "@/lib/net";
import { __resetMachineInfo } from "@/lib/probe";
import {
  __resetSampler,
  HISTORY_WINDOW_MS,
  sample,
  SCOPE_WINDOW_MS,
  TAPE_FRAMES,
  TAPE_TOP,
  tapeFrame,
  tapeIndex,
} from "@/lib/sampler";
import { parseTapeFrame, parseTapeIndex } from "@/lib/schemas";
import { sliceWindow } from "@/lib/scope-model";

import {
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = new Date("2026-09-26T00:30:00Z");

beforeEach(() => {
  __resetMachineInfo();
  __resetSampler();
  __resetIdentityCache();
  __resetNet();
  installFakeProbe();
  installFakeCodesign();
  installLoopbackHeaders();
  setSystemTime(T0);
});

afterEach(() => {
  setSystemTime();
  resetSeams();
  __resetSampler();
});

describe("the tape", () => {
  test("each sample records a frame of the top processes and the alerts", async () => {
    await sample();
    setSystemTime(new Date(T0.getTime() + 5000));
    await sample();
    expect(tapeIndex()).toEqual([T0.getTime(), T0.getTime() + 5000]);
    const f = tapeFrame(T0.getTime() + 1000);
    expect(f?.ts).toBe(T0.getTime());
    expect(f?.top.length).toBeLessThanOrEqual(TAPE_TOP);
    expect(f?.top[0]?.command).toBe("fileproviderd");
    expect(tapeFrame(T0.getTime() + 4000)?.ts).toBe(T0.getTime() + 5000);
  });

  test("the ring is bounded and returns copies", async () => {
    for (let i = 0; i < TAPE_FRAMES + 3; i++) {
      setSystemTime(new Date(T0.getTime() + i * 5000));
      await sample();
    }
    expect(tapeIndex()).toHaveLength(TAPE_FRAMES);
    const a = tapeFrame(T0.getTime() + 10 * 5000);
    a!.top.length = 0;
    expect(tapeFrame(T0.getTime() + 10 * 5000)?.top.length).toBeGreaterThan(0);
  });

  test("history keeps an hour; the scope window slices five minutes to a chosen end", async () => {
    expect(HISTORY_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(SCOPE_WINDOW_MS).toBe(5 * 60 * 1000);
    const points = Array.from({ length: 120 }, (_, i) => ({
      ts: T0.getTime() + i * 5000,
      cpu: i,
      mem: 0,
      swap: 0,
      load: 0,
      net: 0,
    }));
    const live = sliceWindow(points, null, SCOPE_WINDOW_MS);
    expect(live[live.length - 1]?.cpu).toBe(119);
    expect(live[0]?.ts).toBe((points[119]?.ts ?? 0) - SCOPE_WINDOW_MS);
    const rewound = sliceWindow(points, T0.getTime() + 60 * 5000, SCOPE_WINDOW_MS);
    expect(rewound[rewound.length - 1]?.cpu).toBe(60);
    expect(rewound).toHaveLength(61);
    expect(sliceWindow([], null, SCOPE_WINDOW_MS)).toEqual([]);
  });

  test("GET /api/tape lists frames, serves the nearest frame, and 404s when empty", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getTape(new Request("http://127.0.0.1:3000/api/tape"))).status).toBe(403);
    installLoopbackHeaders();

    expect((await getTape(new Request("http://127.0.0.1:3000/api/tape?at=123"))).status).toBe(404);

    await sample();
    const index = parseTapeIndex(
      await (await getTape(new Request("http://127.0.0.1:3000/api/tape"))).json(),
    );
    expect(index.frames).toEqual([T0.getTime()]);

    const res = await getTape(
      new Request(`http://127.0.0.1:3000/api/tape?at=${T0.getTime() + 999}`),
    );
    expect(res.status).toBe(200);
    const frame = parseTapeFrame(await res.json());
    expect(frame.ts).toBe(T0.getTime());
    expect(frame.top[0]?.pid).toBe(648);
  });
});
