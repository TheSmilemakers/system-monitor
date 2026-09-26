import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  parseKexts,
  parseListeningPorts,
  parseSystemExtensions,
  posture,
  REMOTE_PORTS,
  type PostureLamp,
} from "./posture";
import { hasValue, isOk, probe } from "./probe";
import { locationClass } from "./process-model";
import { remoteAddressOf, resolveAll } from "./resolve-host";
import type { ProcessInfo } from "./sampler";
import { appendJsonl, compactJsonl, readJson, readJsonl, writeJson } from "./store";
import { grantsFor, TCC_SERVICES } from "./tcc";
import { loadWatches, type Watch } from "./watch";

/**
 * The constant monitor: a baseline of what the machine normally looks like,
 * a diff every tick, and an append-only timeline of what changed.
 *
 * Surfaces: running executables (by path and trust), outbound destinations,
 * listening ports, launch agents and daemons (by content hash), the posture
 * lamps, accounts and admins, ~/.ssh, DNS resolvers, system extensions,
 * privacy grants (TCC), web proxies and /etc/hosts, cron and periodic
 * scripts, and third-party kernel extensions. Each difference becomes an event
 * with a severity from the rule table below. An event fires when a subject
 * first appears relative to the previous tick and is not in the baseline;
 * the same rule and subject is not repeated within ten minutes. Alarms are
 * also posted as macOS notifications, as are watch events: the user pins
 * a process and hears when it starts or stops. Everything stays on this
 * machine.
 */

export type EventSeverity = "info" | "caution" | "alarm";
export type EventCategory =
  | "process"
  | "network"
  | "port"
  | "persistence"
  | "posture"
  | "account"
  | "credential"
  | "extension"
  | "permission"
  | "watch"
  | "monitor";

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
  /** Local user accounts (system accounts starting with an underscore excluded). */
  accounts: string[];
  /** Members of the admin group. */
  admins: string[];
  /** ~/.ssh entries -> sha256 of authorized_keys for that name, or "" for other files. */
  sshKeys: Record<string, string>;
  /** DNS resolver addresses in use. */
  dns: string[];
  /** Active third-party system extensions by bundle id. */
  extensions: string[];
  /** TCC service -> sorted clients holding the grant. Empty when unreadable. */
  permissions: Record<string, string[]>;
  /** Whether the TCC database could be read; drift is judged only when both sides could. */
  tccReadable: boolean;
  /** Enabled web, secure web, SOCKS proxies and PAC URLs, as "KIND target". */
  proxies: string[];
  /** sha256 of /etc/hosts, or "" when unreadable. */
  hostsHash: string;
  /** User crontab and /etc/periodic scripts -> sha256. */
  cron: Record<string, string>;
  /** Loaded third-party kernel extensions by bundle id. */
  kexts: string[];
}

/** Fill fields a baseline recorded by an older build did not have. */
export function normalizeSnapshot(s: Partial<Snapshot> & { ts: number }): Snapshot {
  return {
    ts: s.ts,
    processes: s.processes ?? {},
    destinations: s.destinations ?? [],
    ports: s.ports ?? [],
    persistence: s.persistence ?? {},
    posture: s.posture ?? {},
    accounts: s.accounts ?? [],
    admins: s.admins ?? [],
    sshKeys: s.sshKeys ?? {},
    dns: s.dns ?? [],
    extensions: s.extensions ?? [],
    permissions: s.permissions ?? {},
    tccReadable: s.tccReadable ?? false,
    proxies: s.proxies ?? [],
    hostsHash: s.hostsHash ?? "",
    cron: s.cron ?? {},
    kexts: s.kexts ?? [],
  };
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

/** Parse `scutil --dns` for the resolver addresses, in order, without duplicates. */
export function parseDnsServers(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g))
    if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Parse `scutil --proxy` into the enabled proxies: "HTTP host:port",
 * "HTTPS host:port", "SOCKS host:port", "PAC url". A silently added proxy
 * is a classic interception, so each one is a subject in its own right.
 */
export function parseProxies(raw: string): string[] {
  const get = (key: string) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(raw);
    return m?.[1]?.trim() ?? null;
  };
  const out: string[] = [];
  for (const [kind, prefix] of [
    ["HTTP", "HTTP"],
    ["HTTPS", "HTTPS"],
    ["SOCKS", "SOCKS"],
  ] as const) {
    if (get(`${prefix}Enable`) === "1") {
      const host = get(`${prefix}Proxy`);
      const port = get(`${prefix}Port`);
      if (host) out.push(`${kind} ${host}${port ? `:${port}` : ""}`);
    }
  }
  if (get("ProxyAutoConfigEnable") === "1") {
    const url = get("ProxyAutoConfigURLString");
    if (url) out.push(`PAC ${url}`);
  }
  return out;
}

/** Parse `dscl . -read /Groups/admin GroupMembership`. */
export function parseAdmins(raw: string): string[] {
  const m = /GroupMembership:\s*(.*)/.exec(raw);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

async function sshInventory(): Promise<Record<string, string>> {
  const dir = path.join(os.homedir(), ".ssh");
  const ls = await probe("ls", [dir]);
  if (!isOk(ls)) return {};
  const names = ls.value.split("\n").filter(Boolean);
  const out: Record<string, string> = {};
  for (const n of names) out[n] = "";
  const keyFiles = names.filter((n) => n.startsWith("authorized_keys"));
  if (keyFiles.length > 0) {
    const sums = await probe("shasum", ["-a", "256", ...keyFiles.map((n) => path.join(dir, n))]);
    if (hasValue(sums)) {
      for (const line of sums.value.split("\n")) {
        const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
        if (m) out[path.basename(m[2])] = m[1];
      }
    }
  }
  return out;
}

/** The user's crontab (hashed here) and every /etc/periodic script (hashed by shasum). */
async function cronInventory(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const tab = await probe("crontab", ["-l"]);
  if (isOk(tab) && tab.value.trim().length > 0) {
    out["crontab"] = createHash("sha256").update(tab.value).digest("hex");
  }
  for (const dir of ["/etc/periodic/daily", "/etc/periodic/weekly", "/etc/periodic/monthly"]) {
    const ls = await probe("ls", [dir]);
    if (!isOk(ls)) continue;
    const files = ls.value
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(dir, f));
    if (files.length === 0) continue;
    const sums = await probe("shasum", ["-a", "256", ...files], 15_000);
    if (!hasValue(sums)) continue;
    for (const line of sums.value.split("\n")) {
      const [, hash, file] = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()) ?? [];
      if (hash && file) out[file] = hash;
    }
  }
  return out;
}

/** Privacy grants per readable service; null when no database opened at all. */
async function permissionInventory(): Promise<Record<string, string[]> | null> {
  const out: Record<string, string[]> = {};
  let any = false;
  for (const svc of TCC_SERVICES) {
    const clients = await grantsFor(svc.service, svc.scope);
    if (clients === null) continue;
    out[svc.service] = [...clients].sort();
    any = true;
  }
  return any ? out : null;
}

export async function takeSnapshot(inputs: SnapshotInputs, now = Date.now()): Promise<Snapshot> {
  const [
    conns,
    listen,
    hashes,
    lamps,
    users,
    admins,
    dnsRes,
    ssh,
    sysext,
    proxyRes,
    hosts,
    kmRes,
    cron,
    perms,
  ] = await Promise.all([
    probe("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED"], 15_000),
    probe("netstat", ["-an", "-p", "tcp"]),
    persistenceHashes(),
    inputs.lamps ? Promise.resolve([...inputs.lamps]) : posture(now).then((r) => r.lamps),
    probe("dscl", [".", "-list", "/Users"]),
    probe("dscl", [".", "-read", "/Groups/admin", "GroupMembership"]),
    probe("scutil", ["--dns"]),
    sshInventory(),
    probe("systemextensionsctl", ["list"]),
    probe("scutil", ["--proxy"]),
    probe("shasum", ["-a", "256", "/etc/hosts"]),
    probe("kmutil", ["showloaded", "--list-only", "--no-kernel-components"], 15_000),
    cronInventory(),
    permissionInventory(),
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

  const accounts = isOk(users)
    ? users.value
        .split("\n")
        .filter((u) => u.length > 0 && !u.startsWith("_"))
        .sort()
    : [];
  const extensions = hasValue(sysext)
    ? parseSystemExtensions(sysext.value)
        .filter((e) => /activated/.test(e.state))
        .map((e) => e.bundleId)
        .sort()
    : [];

  return {
    ts: now,
    processes,
    destinations,
    ports,
    persistence: hashes,
    posture: postureStates,
    accounts,
    admins: isOk(admins) ? parseAdmins(admins.value) : [],
    sshKeys: ssh,
    dns: hasValue(dnsRes) ? parseDnsServers(dnsRes.value) : [],
    extensions,
    permissions: perms ?? {},
    tccReadable: perms !== null,
    proxies: hasValue(proxyRes) ? parseProxies(proxyRes.value) : [],
    hostsHash: hasValue(hosts) ? (/^([0-9a-f]{64})/.exec(hosts.value.trim())?.[1] ?? "") : "",
    cron,
    kexts: hasValue(kmRes) ? parseKexts(kmRes.value) : [],
  };
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

  const listNew = (
    key: "accounts" | "admins" | "dns" | "extensions" | "kexts" | "proxies",
    make: (value: string) => Omit<MonitorEvent, "id" | "ts">,
  ) => {
    const before = new Set([...(prev?.[key] ?? []), ...baseline[key]]);
    for (const value of curr[key]) {
      if (before.has(value)) continue;
      events.push({ id: newId(ts), ts, ...make(value) });
    }
  };
  listNew("accounts", (u) => ({
    severity: "alarm",
    category: "account",
    subject: u,
    message: `New user account: ${u}.`,
    rule: "account.new",
  }));
  listNew("admins", (u) => ({
    severity: "alarm",
    category: "account",
    subject: u,
    message: `${u} is now an administrator.`,
    rule: "account.new-admin",
  }));
  listNew("dns", (d) => ({
    severity: "alarm",
    category: "network",
    subject: d,
    message: `DNS resolver changed to ${d}.`,
    rule: "network.dns-changed",
  }));
  listNew("extensions", (e) => ({
    severity: "caution",
    category: "extension",
    subject: e,
    message: `New system extension active: ${e}.`,
    rule: "extension.new",
  }));

  listNew("kexts", (k) => ({
    severity: "caution",
    category: "extension",
    subject: k,
    message: `Kernel extension loaded: ${k}.`,
    rule: "extension.new-kext",
  }));
  listNew("proxies", (p) => ({
    severity: "alarm",
    category: "network",
    subject: p,
    message: `A web proxy is now set: ${p}. Traffic may be routed through it.`,
    rule: "network.proxy-set",
  }));
  if (prev) {
    for (const p of prev.proxies) {
      if (!curr.proxies.includes(p)) {
        events.push({
          id: newId(ts),
          ts,
          severity: "info",
          category: "network",
          subject: p,
          message: `Web proxy removed: ${p}.`,
          rule: "network.proxy-removed",
        });
      }
    }
    if (prev.hostsHash && curr.hostsHash && prev.hostsHash !== curr.hostsHash) {
      events.push({
        id: newId(ts),
        ts,
        severity: "alarm",
        category: "network",
        subject: "/etc/hosts",
        message: "/etc/hosts changed: a name may now resolve somewhere else.",
        rule: "network.hosts-changed",
      });
    }
  }

  for (const [file, hash] of Object.entries(curr.cron)) {
    const before = prev?.cron[file] ?? baseline.cron[file];
    if (before === undefined) {
      events.push({
        id: newId(ts),
        ts,
        severity: "alarm",
        category: "persistence",
        subject: file,
        message:
          file === "crontab"
            ? "A crontab appeared for this user."
            : `New periodic script: ${file}.`,
        rule: "persistence.cron-new",
      });
    } else if (prev?.cron[file] !== undefined && prev.cron[file] !== hash) {
      events.push({
        id: newId(ts),
        ts,
        severity: "alarm",
        category: "persistence",
        subject: file,
        message: file === "crontab" ? "The crontab changed." : `Periodic script changed: ${file}.`,
        rule: "persistence.cron-changed",
      });
    }
  }

  // Privacy grants: a service is judged only when this tick and the previous
  // tick or the baseline could all read its database, so a protected read
  // never looks like every grant being revoked or given.
  if (curr.tccReadable) {
    for (const svc of TCC_SERVICES) {
      const now = curr.permissions[svc.service];
      if (!now) continue;
      const prevList = prev?.tccReadable ? prev.permissions[svc.service] : undefined;
      const baseList = baseline.tccReadable ? baseline.permissions[svc.service] : undefined;
      if (!prevList && !baseList) continue;
      const before = new Set([...(prevList ?? []), ...(baseList ?? [])]);
      for (const client of now) {
        if (before.has(client)) continue;
        events.push({
          id: newId(ts),
          ts,
          severity: svc.highRisk ? "alarm" : "caution",
          category: "permission",
          subject: `${svc.service}:${client}`,
          message: `${client} was granted ${svc.name}.`,
          rule: "permission.granted",
        });
      }
      if (prevList) {
        for (const client of prevList) {
          if (now.includes(client)) continue;
          events.push({
            id: newId(ts),
            ts,
            severity: "info",
            category: "permission",
            subject: `${svc.service}:${client}`,
            message: `${client} no longer holds ${svc.name}.`,
            rule: "permission.revoked",
          });
        }
      }
    }
  }

  for (const [name, hash] of Object.entries(curr.sshKeys)) {
    const wasBefore = name in (prev?.sshKeys ?? {}) || name in baseline.sshKeys;
    if (!wasBefore) {
      events.push({
        id: newId(ts),
        ts,
        severity: name.startsWith("authorized_keys") ? "alarm" : "caution",
        category: "credential",
        subject: name,
        message: `New file in ~/.ssh: ${name}.`,
        rule: "credential.new-file",
      });
    } else if (name.startsWith("authorized_keys") && hash) {
      const previousHash = prev?.sshKeys[name] ?? baseline.sshKeys[name];
      if (previousHash && previousHash !== hash) {
        events.push({
          id: newId(ts),
          ts,
          severity: "alarm",
          category: "credential",
          subject: name,
          message: `${name} changed: a key was added or removed.`,
          rule: "credential.authorized-keys-changed",
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

/**
 * Watched executables that started or stopped since the previous tick.
 * Nothing fires on the first tick, since there is nothing to compare
 * against, and a watch is keyed by path so PID reuse cannot fool it. Pure.
 */
export function diffWatches(
  prev: Snapshot | null,
  curr: Snapshot,
  watches: readonly Watch[],
  ts: number,
): MonitorEvent[] {
  if (!prev || watches.length === 0) return [];
  const events: MonitorEvent[] = [];
  for (const w of watches) {
    const was = w.key in prev.processes;
    const is = w.key in curr.processes;
    if (was === is) continue;
    events.push({
      id: newId(ts),
      ts,
      severity: "caution",
      category: "watch",
      subject: w.key,
      message: is ? `Watched process started: ${w.name}.` : `Watched process stopped: ${w.name}.`,
      rule: is ? "watch.started" : "watch.stopped",
    });
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
  if (baselineCache === undefined) {
    const doc = await readJson<Baseline>(BASELINE_FILE);
    baselineCache = doc ? { ...doc, snapshot: normalizeSnapshot(doc.snapshot) } : null;
  }
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
      events = dedupe(
        [
          ...diffSnapshots(previous, snapshot, baseline.snapshot),
          ...diffWatches(previous, snapshot, await loadWatches(), now),
        ],
        now,
      );
    }
    previous = snapshot;
    await record(events);
    for (const e of events) {
      if (e.severity !== "alarm" && e.category !== "watch") continue;
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
