import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { GET as getProcess } from "@/app/api/process/route";
import { __resetIdentityCache } from "@/lib/identity";
import { __resetNet } from "@/lib/net";
import { __resetMachineInfo } from "@/lib/probe";
import { parseLsofConnections, parseTopPid, processDetail } from "@/lib/process-detail";
import { __resetResolveCache } from "@/lib/resolve-host";
import { __resetSampler, PROCESS_TRACE_POINTS, processHistory, sample } from "@/lib/sampler";
import { parseProcessDetail } from "@/lib/schemas";

import {
  LSOF_PID_OUTPUT,
  TOP_PID_OUTPUT,
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = new Date("2026-09-26T00:30:00Z");

describe("parsers", () => {
  test("parseTopPid reads threads and energy for the pid, ignoring the header", () => {
    expect(parseTopPid(TOP_PID_OUTPUT, 648)).toEqual({ threads: 11, energy: 4.1 });
    expect(parseTopPid(TOP_PID_OUTPUT, 999)).toBeNull();
  });

  test("parseLsofConnections keeps protocol, endpoints and state", () => {
    expect(parseLsofConnections(LSOF_PID_OUTPUT)).toEqual([
      { proto: "TCP", local: "192.168.1.5:50000", remote: "10.0.0.9:443", state: "ESTABLISHED" },
      { proto: "TCP", local: "[::1]:50001", remote: "[::1]:8080", state: "CLOSE_WAIT" },
      { proto: "UDP", local: "*:5353", remote: "", state: "" },
    ]);
  });
});

describe("processDetail", () => {
  beforeEach(() => {
    __resetResolveCache();
    installFakeProbe();
  });
  afterEach(() => resetSeams());

  test("assembles state, threads, energy, files and resolved connections", async () => {
    const d = await processDetail(648, T0.getTime());
    expect(d).toMatchObject({
      pid: 648,
      alive: true,
      suspended: false,
      nice: 0,
      threads: 11,
      energy: 4.1,
      openFiles: 3,
      unavailable: [],
      timestamp: T0.getTime(),
    });
    expect(d.connections[0]).toMatchObject({ remote: "10.0.0.9:443", host: "<local network>" });
    expect(d.connections[2]).toMatchObject({ proto: "UDP", remote: "", host: null });
  });

  test("a stopped process reads as suspended; a missing one as not alive", async () => {
    installFakeProbe({
      ps: (args) =>
        args[1] === "stat=,nice=,ppid="
          ? { status: "ok", value: "T    10     1" }
          : { status: "ok", value: "" },
    });
    const d = await processDetail(648);
    expect(d).toMatchObject({ alive: true, suspended: true, nice: 10 });

    installFakeProbe({
      ps: (args) =>
        args[1] === "stat=,nice=,ppid=" ? { status: "ok", value: "" } : { status: "ok", value: "" },
    });
    expect((await processDetail(648)).alive).toBe(false);
  });

  test("a probe that cannot run is named; lsof's 'no rows' failure is simply empty", async () => {
    installFakeProbe({
      top: () => ({ status: "timeout" }),
      lsof: (args) =>
        args[0] === "-a" ? { status: "failed", error: "no files" } : { status: "denied" },
    });
    const d = await processDetail(648);
    expect(d.threads).toBeNull();
    expect(d.connections).toEqual([]);
    expect(d.openFiles).toBeNull();
    expect(d.unavailable).toEqual([
      { check: "threads and energy (top)", reason: "timeout" },
      { check: "open files (lsof)", reason: "denied" },
    ]);
  });
});

describe("per-process history from the sampler", () => {
  beforeEach(() => {
    __resetMachineInfo();
    __resetSampler();
    __resetIdentityCache();
    __resetNet();
    installFakeProbe();
    installFakeCodesign();
    setSystemTime(T0);
  });
  afterEach(() => {
    setSystemTime();
    resetSeams();
    __resetSampler();
  });

  test("each sample appends a point per process, bounded, and drops processes that vanish", async () => {
    await sample();
    setSystemTime(new Date(T0.getTime() + 5000));
    await sample();
    const h = processHistory(648);
    expect(h).toEqual([
      { ts: T0.getTime(), cpu: 72, mem: 0.4 },
      { ts: T0.getTime() + 5000, cpu: 72, mem: 0.4 },
    ]);
    expect(processHistory(424242)).toEqual([]);

    for (let i = 2; i < PROCESS_TRACE_POINTS + 5; i++) {
      setSystemTime(new Date(T0.getTime() + i * 5000));
      await sample();
    }
    expect(processHistory(648)).toHaveLength(PROCESS_TRACE_POINTS);
  });

  test("a reused pid with a different start time begins a fresh trace", async () => {
    await sample();
    installFakeProbe({
      ps: (args) =>
        args[0] === "-axwwo"
          ? {
              status: "ok",
              value: "rajan    648     1  10.0  0.1  1000        00:03 /usr/bin/fresh",
            }
          : { status: "ok", value: "" },
    });
    setSystemTime(new Date(T0.getTime() + 5000));
    await sample();
    expect(processHistory(648)).toEqual([{ ts: T0.getTime() + 5000, cpu: 10, mem: 0.1 }]);
  });
});

describe("GET /api/process", () => {
  beforeEach(() => {
    __resetResolveCache();
    installFakeProbe();
    installLoopbackHeaders();
  });
  afterEach(() => resetSeams());

  const req = (q: string) => new Request(`http://127.0.0.1:3000/api/process?${q}`);

  test("refuses a forged Host and a bad pid", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getProcess(req("pid=648"))).status).toBe(403);
    installLoopbackHeaders();
    expect((await getProcess(req("pid=abc"))).status).toBe(400);
    expect((await getProcess(req("pid=-1"))).status).toBe(400);
  });

  test("serves a body that satisfies the contract", async () => {
    const res = await getProcess(req("pid=648"));
    expect(res.status).toBe(200);
    const d = parseProcessDetail(await res.json());
    expect(d.pid).toBe(648);
    expect(d.threads).toBe(11);
    expect(d.connections).toHaveLength(3);
  });
});
