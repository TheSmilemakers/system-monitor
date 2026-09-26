import os from "node:os";
import path from "node:path";

import { parseListeningPorts, posture, REMOTE_PORTS, type PostureLamp } from "./posture";
import { hasValue, isOk, probe } from "./probe";
import { locationClass } from "./process-model";
import { remoteAddressOf, resolveAll } from "./resolve-host";
import type { ProcessInfo } from "./sampler";
import { appendJsonl, compactJsonl, readJson, readJsonl, writeJson } from "./store";

/**
 * The constant monitor: a baseline of what the machine normally looks like,
 * a diff every tick, and an append-only timeline of what changed.
 *
 * Surfaces in this first stage: running executables (by path and trust),
 * outbound destinations, listening ports, launch agents and daemons (by
 * content hash), and the posture lamps. Each difference becomes an event
 * with a severity from the rule table below. An event fires when a subject
 * first appears relative to the previous tick and is not in the baseline;
 * the same rule and subject is not repeated within ten minutes. Alarms are
 * also posted as macOS notifications. Everything stays on this machine.
 */

export type EventSeverity = "info" | "caution" | "alarm";
export type EventCategory = "process" | "network" | "port" | "persistence" | "posture" | "monitor";

export interface MonitorEvent {
  id: string;
  ts: number;
  severity: EventSeverity;
  category: EventCategory;
  /** What the event is about: a path, a host, a port, a plist, a lamp. */
  subject: string;
  message: string;
  /** The rule that fired, so the user can see why and silence it. */
  rule: string;
}

export interface Snapshot {
  ts: number;
  /** Executable path -> trust state. */
  processes: Record<string, string>;
  /** Resolved hostnames or bare addresses currently connected to. */
  destinations: string[];
  /** Ports with a listener bound to the network. */
  ports: number[];
  /** Launch agent and daemon plist path -> sha256. */
  persistence: Record<string, string>;
  /** Posture lamp id -> state. */
  posture: Record<string, string>;
}

export interface Baseline {
  createdAt: number;
  snapshot: Snapshot;
}

export const BASELINE_FILE = "baseline.json";
export const EVENTS_FILE = "events.jsonl";
export const TICK_INTERVAL_MS = 60_000;
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EPHEMERAL_PORT_MIN = 49_152;
const KNOWN_VENDORS = [
  "com.apple.",
  "com.google.",
  "com.microsoft.",
  "com.docker.",
  "com.spotify.",
];

// ---------- snapshot ----------

export interface SnapshotInputs {
  processes: readonly ProcessInfo[];
  lamps?: readonly PostureLamp[];
}

function agentDirs(): string[] {
  return [
    path.join(os.homedir(), "Library/LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
  ];
}

/** sha256 of every plist in the launch directories, one shasum call per directory. */
async function persistenceHashes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const dir of agentDirs()) {
    const ls = await probe("ls", [dir]);
    if (!isOk(ls)) continue;
    const files = ls.value
      .split("\n")
      .filter((f) => f.endsWith(".plist"))
      .map((f) => path.join(dir, f));
    if (files.length === 0) continue;
    const sums = await probe("shasum", ["-a", "256", ...files], 15_000);
    if (!hasValue(sums)) continue;
    for (const line of sums.value.split("\n")) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m) out[m[2]] = m[1];
    }
  }
  return out;
}

export async function takeSnapshot(inputs: SnapshotInputs, now = Date.now()): Promise<Snapshot> {
  const [conns, listen, hashes, lamps] = await Promise.all([
    probe("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED"], 15_000),
    probe("netstat", ["-an", "-p", "tcp"]),
    persistenceHashes(),
    inputs.lamps ? Promise.resolve([...inputs.lamps]) : posture(now).then((r) => r.lamps),
  ]);

  const processes: Record<string, string> = {};
  for (const p of inputs.processes) if (p.path.startsWith("/")) processes[p.path] = p.trust;

  const addrs = hasValue(conns)
    ? conns.value
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[8] ?? "")
        .map((name) => remoteAddressOf(name))
        .filter((a): a is string => a !== null)
    : [];
  const resolved = await resolveAll(addrs);
  const destinations = [
    ...new Set(
      addrs.map((a) => {
        const r = resolved.get(a);
        return r && r.status === "resolved" && r.hostnames[0] !== "<local network>"
          ? r.hostnames[0]
          : a;
      }),
    ),
  ].sort();

  const ports = hasValue(listen)
    ? [...parseListeningPorts(listen.value)].sort((a, b) => a - b)
    : [];
  const postureStates: Record<string, string> = {};
  for (const l of lamps) postureStates[l.id] = l.state;

  return { ts: now, processes, destinations, ports, persistence: hashes, posture: postureStates };
}

// ---------- rules ----------

let counter = 0;
const newId = (ts: number) => `${ts.toString(36)}-${(counter++).toString(36)}`;

function processEvent(p: string, trust: string, ts: number): MonitorEvent | null {
  const where = locationClass(p);
  const name = p.split("/").pop() ?? p;
  if (where.flag) {
    return {
      id: newId(ts),
      ts,
      severity: "alarm",
      category: "process",
      subject: p,
      message: `${name} is running from the ${where.label}, which is unusual for code.`,
      rule: "process.unusual-location",
    };
  }
  switch (trust) {
    case "unsigned":
      return {
        id: newId(ts),
        ts,
        severity: "alarm",
        category: "process",
        subject: p,
        message: `New unsigned binary running: ${name}.`,
        rule: "process.unsigned",
      };
    case "adhoc":
    case "unknown":
      return {
        id: newId(ts),
        ts,
        severity: "caution",
        category: "process",
        subject: p,
        message: `New ${trust === "adhoc" ? "ad-hoc signed" : "unverified"} binary running: ${name}.`,
        rule: "process.unverified",
      };
    case "developer-id":
    case "app-store":
      return {
        id: newId(ts),
        ts,
        severity: "info",
        category: "process",
        subject: p,
        message: `New signed software running: ${name}.`,
        rule: "process.new-signed",
      };
    default:
      return null; // Apple system software, or still pending: not an event
  }
}

/**
 * Events for what is new in `curr` relative to `prev` and absent from the
 * baseline, plus posture changes relative to `prev`. Pure, so the rule table
 * is unit-tested without probes.
 */
export function diffSnapshots(
  prev: Snapshot | null,
  curr: Snapshot,
  baseline: Snapshot,
): MonitorEvent[] {
  const ts = curr.ts;
  const events: MonitorEvent[] = [];
  const seenBefore = (key: keyof Snapshot, value: string | number) => {
    const inPrev = prev ? contains(prev, key, value) : false;
    return inPrev || contains(baseline, key, value);
  };

  for (const [p, trust] of Object.entries(curr.processes)) {
    if (seenBefore("processes", p)) continue;
    const e = processEvent(p, trust, ts);
    if (e) events.push(e);
  }

  for (const host of curr.destinations) {
    if (seenBefore("destinations", host)) continue;
    events.push({
      id: newId(ts),
      ts,
      severity: "caution",
      category: "network",
      subject: host,
      message: `New outbound destination: ${host}.`,
      rule: "network.new-destination",
    });
  }

  for (const port of curr.ports) {
    if (port >= EPHEMERAL_PORT_MIN || seenBefore("ports", port)) continue;
    const known = REMOTE_PORTS[port];
    events.push({
      id: newId(ts),
      ts,
      severity: known ? "caution" : "info",
      category: "port",
      subject: String(port),
      message: known
        ? `Port ${port} is now listening on the network (${known}).`
        : `Port ${port} is now listening on the network.`,
      rule: "port.new-listener",
    });
  }

  for (const [file, hash] of Object.entries(curr.persistence)) {
    const name = path.basename(file);
    const prevHash = prev?.persistence[file] ?? baseline.persistence[file];
    if (prevHash === undefined) {
      const vendorKnown = KNOWN_VENDORS.some((v) => name.startsWith(v));
      events.push({
        id: newId(ts),
        ts,
        severity: vendorKnown ? "info" : "alarm",
        category: "persistence",
        subject: file,
        message: `New launch item: ${name}${vendorKnown ? "" : " from an unrecognised vendor"}.`,
        rule: "persistence.new-item",
      });
    } else if (
      prevHash !== hash &&
      prev?.persistence[file] !== undefined &&
      prev.persistence[file] !== hash
    ) {
      events.push({
        id: newId(ts),
        ts,
        severity: "caution",
        category: "persistence",
        subject: file,
        message: `Launch item changed: ${name}.`,
        rule: "persistence.changed",
      });
    }
  }
  if (prev) {
    for (const file of Object.keys(prev.persistence)) {
      if (!(file in curr.persistence)) {
        events.push({
          id: newId(ts),
          ts,
          severity: "info",
          category: "persistence",
          subject: file,
          message: `Launch item removed: ${path.basename(file)}.`,
          rule: "persistence.removed",
        });
      }
    }
  }

  if (prev) {
    const rank: Record<string, number> = { ok: 0, info: 0, off: 0, caution: 1, alarm: 2 };
    for (const [id, state] of Object.entries(curr.posture)) {
      const before = prev.posture[id];
      if (before === undefined || before === state) continue;
      const worse = (rank[state] ?? 0) > (rank[before] ?? 0);
      events.push({
        id: newId(ts),
        ts,
        severity: worse ? (state === "alarm" ? "alarm" : "caution") : "info",
        category: "posture",
        subject: id,
        message: `${id} changed from ${before} to ${state}.`,
        rule: worse ? "posture.worsened" : "posture.improved",
      });
    }
  }

  return events;
}

function contains(s: Snapshot, key: keyof Snapshot, value: string | number): boolean {
  switch (key) {
    case "processes":
      return typeof value === "string" && value in s.processes;
    case "destinations":
      return typeof value === "string" && s.destinations.includes(value);
    case "ports":
      return typeof value === "number" && s.ports.includes(value);
    default:
      return false;
  }
}

// ---------- state, dedupe, notify, tick ----------

const recent = new Map<string, number>();
let previous: Snapshot | null = null;
let baselineCache: Baseline | null | undefined;
let lastTick = 0;
let ticking: Promise<MonitorEvent[]> | null = null;
let notifier: ((title: string, message: string) => Promise<void>) | null = null;

/** Drop events whose rule and subject fired within the dedupe window. */
export function dedupe(events: MonitorEvent[], now: number): MonitorEvent[] {
  const kept: MonitorEvent[] = [];
  for (const e of events) {
    const key = `${e.rule}|${e.subject}`;
    const last = recent.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) continue;
    recent.set(key, now);
    kept.push(e);
  }
  return kept;
}

async function realNotify(title: string, message: string): Promise<void> {
  const clean = (s: string) => s.replace(/["\\]/g, "").slice(0, 200);
  await probe("osascript", [
    "-e",
    `display notification "${clean(message)}" with title "${clean(title)}"`,
  ]);
}

export async function loadBaseline(): Promise<Baseline | null> {
  if (baselineCache === undefined) baselineCache = await readJson<Baseline>(BASELINE_FILE);
  return baselineCache;
}

export async function saveBaseline(snapshot: Snapshot, now = Date.now()): Promise<Baseline> {
  const b: Baseline = { createdAt: now, snapshot };
  await writeJson(BASELINE_FILE, b);
  baselineCache = b;
  return b;
}

async function record(events: MonitorEvent[]): Promise<void> {
  for (const e of events) await appendJsonl(EVENTS_FILE, e);
}

/**
 * One monitoring pass: snapshot, establish or load the baseline, diff,
 * dedupe, persist, notify on alarms. Safe to call often; it runs at most
 * once per interval unless forced.
 */
export async function tick(
  inputs: SnapshotInputs,
  now = Date.now(),
  force = false,
): Promise<MonitorEvent[]> {
  if (ticking) return ticking;
  if (!force && now - lastTick < TICK_INTERVAL_MS) return [];
  lastTick = now;
  ticking = (async () => {
    const snapshot = await takeSnapshot(inputs, now);
    let baseline = await loadBaseline();
    let events: MonitorEvent[];
    if (!baseline) {
      baseline = await saveBaseline(snapshot, now);
      events = [
        {
          id: newId(now),
          ts: now,
          severity: "info",
          category: "monitor",
          subject: "baseline",
          message: `Baseline recorded: ${Object.keys(snapshot.processes).length} executables, ${snapshot.destinations.length} destinations, ${snapshot.ports.length} listening ports, ${Object.keys(snapshot.persistence).length} launch items.`,
          rule: "monitor.baseline",
        },
      ];
    } else {
      events = dedupe(diffSnapshots(previous, snapshot, baseline.snapshot), now);
    }
    previous = snapshot;
    await record(events);
    for (const e of events) {
      if (e.severity !== "alarm") continue;
      try {
        await (notifier ?? realNotify)("System Monitor", e.message);
      } catch {
        /* notifications are best effort */
      }
    }
    return events;
  })().finally(() => {
    ticking = null;
  });
  return ticking;
}

/** Events since `since`, newest first, from the log. */
export async function recentEvents(since = 0, limit = 500): Promise<MonitorEvent[]> {
  const all = await readJsonl<MonitorEvent>(EVENTS_FILE);
  return all
    .filter((e) => e.ts >= since)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

/** Drop events past the retention window. Returns how many remain. */
export async function compactEvents(now = Date.now()): Promise<number> {
  return compactJsonl<MonitorEvent>(EVENTS_FILE, (e) => now - e.ts <= RETENTION_MS);
}

/** Re-record the baseline from the current snapshot: what is here now is normal. */
export async function resetBaseline(inputs: SnapshotInputs, now = Date.now()): Promise<Baseline> {
  const snapshot = await takeSnapshot(inputs, now);
  previous = snapshot;
  recent.clear();
  const b = await saveBaseline(snapshot, now);
  await record([
    {
      id: newId(now),
      ts: now,
      severity: "info",
      category: "monitor",
      subject: "baseline",
      message: "Baseline reset: the current state is now considered normal.",
      rule: "monitor.baseline",
    },
  ]);
  return b;
}

/** Wait for an in-flight tick (the stats route fires one without awaiting it). */
export async function monitorSettled(): Promise<void> {
  while (ticking) await ticking.catch(() => undefined);
}

/** Test seams. */
export function __setNotifier(
  fn: ((title: string, message: string) => Promise<void>) | null,
): void {
  notifier = fn;
}
export function __resetMonitor(): void {
  recent.clear();
  previous = null;
  baselineCache = undefined;
  lastTick = 0;
  ticking = null;
}
