import { loadBaseline } from "./monitor";
import { parseListeningPorts, REMOTE_PORTS } from "./posture";
import { hasValue, probe, type ProbeStatus } from "./probe";
import { remoteAddressOf, resolveAll } from "./resolve-host";
import { isAppleTelemetry, matchTracker } from "./trackers";

/**
 * The Network view: every TCP connection by process and by destination,
 * resolved and tracker-matched, plus network-bound listeners, with anything
 * not in the monitor's baseline flagged as new.
 */

export interface NetConnection {
  process: string;
  pid: number;
  proto: string;
  local: string;
  remote: string;
  host: string | null;
  state: string;
  tracker: { category: string; description: string; severity: string } | null;
  appleTelemetry: boolean;
  newSinceBaseline: boolean;
}

export interface Destination {
  host: string;
  connections: number;
  processes: string[];
  tracker: NetConnection["tracker"];
  newSinceBaseline: boolean;
}

export interface Listener {
  port: number;
  name: string | null;
}

export interface NetworkReport {
  connections: NetConnection[];
  destinations: Destination[];
  listeners: Listener[];
  unavailable: { check: string; reason: ProbeStatus }[];
  timestamp: number;
}

/** Parse `lsof -nP -iTCP` rows (all states). */
export function parseLsofAll(
  raw: string,
): Omit<NetConnection, "host" | "tracker" | "appleTelemetry" | "newSinceBaseline">[] {
  const out: Omit<NetConnection, "host" | "tracker" | "appleTelemetry" | "newSinceBaseline">[] = [];
  for (const line of raw.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid)) continue;
    const [local, remote = ""] = parts[8].split("->");
    out.push({
      process: parts[0],
      pid,
      proto: parts[7],
      local,
      remote,
      state: (parts[9] ?? "").replace(/^\(|\)$/g, ""),
    });
  }
  return out;
}

export async function networkReport(now = Date.now()): Promise<NetworkReport> {
  const [lsofRes, netRes, baseline] = await Promise.all([
    probe("lsof", ["-nP", "-iTCP"], 15_000),
    probe("netstat", ["-an", "-p", "tcp"]),
    loadBaseline(),
  ]);
  const unavailable: NetworkReport["unavailable"] = [];
  const known = new Set(baseline?.snapshot.destinations ?? []);

  const rows = hasValue(lsofRes) ? parseLsofAll(lsofRes.value) : [];
  if (!hasValue(lsofRes) && lsofRes.status !== "failed") {
    unavailable.push({ check: "connections (lsof)", reason: lsofRes.status });
  }
  const addrs = rows
    .map((r) => remoteAddressOf(`${r.local}->${r.remote}`))
    .filter((a): a is string => a !== null);
  const resolved = await resolveAll(addrs);

  const connections: NetConnection[] = rows.map((r) => {
    const addr = remoteAddressOf(`${r.local}->${r.remote}`);
    const res = addr ? resolved.get(addr) : undefined;
    const host =
      res && res.status === "resolved" && res.hostnames[0] !== "<local network>"
        ? (res.hostnames[0] ?? null)
        : null;
    const key = host ?? addr ?? "";
    return {
      ...r,
      host,
      tracker: host ? matchTracker(host) : null,
      appleTelemetry: host ? isAppleTelemetry(host) : false,
      newSinceBaseline: addr !== null && baseline !== null && !known.has(key),
    };
  });

  const byHost = new Map<string, Destination>();
  for (const c of connections) {
    if (!c.remote) continue;
    const key = c.host ?? remoteAddressOf(`${c.local}->${c.remote}`) ?? c.remote;
    const d = byHost.get(key) ?? {
      host: key,
      connections: 0,
      processes: [],
      tracker: c.tracker,
      newSinceBaseline: c.newSinceBaseline,
    };
    d.connections++;
    if (!d.processes.includes(c.process)) d.processes.push(c.process);
    byHost.set(key, d);
  }
  const destinations = [...byHost.values()].sort((a, b) => b.connections - a.connections);

  let listeners: Listener[] = [];
  if (hasValue(netRes)) {
    listeners = [...parseListeningPorts(netRes.value)]
      .sort((a, b) => a - b)
      .map((port) => ({ port, name: REMOTE_PORTS[port] ?? null }));
  } else {
    unavailable.push({ check: "listeners (netstat)", reason: netRes.status });
  }

  return { connections, destinations, listeners, unavailable, timestamp: now };
}
