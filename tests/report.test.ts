import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getReport } from "@/app/api/report/route";
import { __resetIdentityCache } from "@/lib/identity";
import { __resetMonitor, type MonitorEvent } from "@/lib/monitor";
import { __resetNet } from "@/lib/net";
import { __resetPosture, updatesSettled, type PostureLamp } from "@/lib/posture";
import { __resetMachineInfo } from "@/lib/probe";
import { buildReport, type ReportInputs } from "@/lib/report";
import { __resetResolveCache } from "@/lib/resolve-host";
import { __resetSampler, type ProcessInfo } from "@/lib/sampler";

import {
  installFakeCodesign,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = Date.parse("2026-09-26T09:30:00");

const lamp = (id: string, state: PostureLamp["state"], summary: string): PostureLamp => ({
  id,
  label: id,
  state,
  summary,
  detail: "",
});

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

const event = (over: Partial<MonitorEvent>): MonitorEvent => ({
  id: "e",
  ts: T0 - 3600_000,
  severity: "info",
  category: "monitor",
  subject: "s",
  message: "Baseline recorded.",
  rule: "monitor.baseline",
  ...over,
});

describe("buildReport", () => {
  const inputs: ReportInputs = {
    now: T0,
    machine: "Apple M1 Pro",
    uptime: "18 days, 3:20",
    lamps: [
      lamp("Firewall", "caution", "Off"),
      lamp("SIP", "ok", "Enabled"),
      lamp("Updates", "off", "Checking"),
    ],
    processes: [
      proc({ pid: 648, cpu: 72, mem: 1.2, command: "fileproviderd" }),
      proc({
        pid: 900,
        cpu: 3,
        command: "Google Chrome",
        trust: "developer-id",
        publisher: "Google LLC",
      }),
      proc({
        pid: 2000,
        cpu: 12,
        command: "gh",
        path: "/opt/homebrew/bin/gh",
        trust: "adhoc",
        publisher: null,
      }),
    ],
    events: [
      event({}),
      event({ id: "old", ts: T0 - 48 * 3600_000, message: "Too old to print." }),
      event({
        id: "a",
        ts: T0 - 60_000,
        severity: "alarm",
        category: "process",
        message: "New unsigned binary running: dropper.",
      }),
    ],
    baselineAt: T0 - 86_400_000,
    destinations: [
      { host: "p59-content.icloud.com", connections: 4, tracker: null, fresh: false },
      {
        host: "www.google-analytics.com",
        connections: 1,
        tracker: "Google Analytics",
        fresh: true,
      },
    ],
    listeners: [{ port: 22, name: "Remote Login (SSH)" }],
  };

  test("prints every section in fixed width with marks for state and severity", () => {
    const text = buildReport(inputs);
    const lines = text.split("\n");
    expect(lines.every((l) => l.length <= 78)).toBe(true);
    expect(text).toContain("SYSTEM MONITOR  SHIFT REPORT");
    expect(text).toContain("Apple M1 Pro   printed 26/09/2026 09:30   up 18 days, 3:20");
    expect(text).toContain("[WARN] Firewall       Off");
    expect(text).toContain("[ OK ] SIP            Enabled");
    expect(text).toContain("[ -- ] Updates        Checking");
    // Sorted by CPU, publisher for third parties, trust column.
    expect(text).toMatch(/648 {4}72\.0 {3}1\.2 {3}apple {8}fileproviderd/);
    expect(text).toContain("developer-id Google Chrome (Google LLC)");
    expect(text).toContain("Unsigned or ad-hoc signed executables running: 1");
    expect(text).toContain("adhoc     /opt/homebrew/bin/gh");
    expect(text).toContain("Listening on the network: 22 (Remote Login (SSH))");
    expect(text).toMatch(/ {4}4 {7}p59-content\.icloud\.com$/m);
    expect(text).toMatch(
      / {4}1 {2}NEW {2}www\.google-analytics\.com\s+tracker: Google Analytics$/m,
    );
    expect(text).toContain("NEW marks a destination not seen when the baseline was recorded.");
    expect(text).toContain("Baseline recorded 25/09/2026 09:30.");
    expect(text).toContain("09:29 !! process     New unsigned binary running: dropper.");
    expect(text).not.toContain("Too old to print.");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("copes with nothing to report", () => {
    const text = buildReport({
      ...inputs,
      lamps: [],
      processes: [],
      events: [],
      baselineAt: null,
      destinations: [],
      listeners: [],
    });
    expect(text).toContain("No ports bound to the network.");
    expect(text).toContain("No baseline recorded yet.");
    expect(text).toContain("No events.");
  });
});

describe("GET /api/report", () => {
  let dir = "";
  const previous = process.env.SM_DATA_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sm-report-"));
    process.env.SM_DATA_DIR = dir;
    __resetMachineInfo();
    __resetSampler();
    __resetIdentityCache();
    __resetNet();
    __resetMonitor();
    __resetPosture();
    __resetResolveCache();
    installFakeProbe();
    installFakeCodesign();
    installLoopbackHeaders();
  });
  afterEach(async () => {
    await updatesSettled();
    resetSeams();
    __resetMonitor();
    __resetSampler();
    if (previous === undefined) delete process.env.SM_DATA_DIR;
    else process.env.SM_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses a forged Host as plain text", async () => {
    installHeaders({ host: "evil.example.com" });
    const res = await getReport();
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("serves the report as plain text, sampling first when nothing has been sampled", async () => {
    const res = await getReport();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("SHIFT REPORT");
    expect(text).toContain("Apple M1 Pro");
    expect(text).toContain("fileproviderd");
    expect(text).toContain("[WARN] Firewall");
    expect(text).toContain("22 (Remote Login (SSH))");
  });
});
