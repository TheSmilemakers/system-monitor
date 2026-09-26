import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getTimeline } from "@/app/api/timeline/route";
import {
  __resetMonitor,
  __setNotifier,
  compactEvents,
  dedupe,
  DEDUPE_WINDOW_MS,
  diffSnapshots,
  loadBaseline,
  recentEvents,
  resetBaseline,
  RETENTION_MS,
  takeSnapshot,
  tick,
  TICK_INTERVAL_MS,
  type MonitorEvent,
  type Snapshot,
} from "@/lib/monitor";
import { __resetPosture, posture, updatesSettled } from "@/lib/posture";
import { __resetResolveCache } from "@/lib/resolve-host";
import type { ProcessInfo } from "@/lib/sampler";
import { appendJsonl } from "@/lib/store";
import { parseTimeline } from "@/lib/schemas";

import { installFakeProbe, installHeaders, installLoopbackHeaders, resetSeams } from "./fixtures";

let dir = "";
const previous = process.env.SM_DATA_DIR;
const T0 = Date.parse("2026-09-26T00:30:00Z");

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

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: T0,
  processes: { "/usr/sbin/filecoordinationd": "apple" },
  destinations: ["p59-content.icloud.com"],
  ports: [22],
  persistence: { "/Library/LaunchAgents/com.apple.foo.plist": "aaa" },
  posture: { firewall: "caution", sip: "ok" },
  accounts: ["daemon", "nobody", "rajan", "root"],
  admins: ["root", "rajan"],
  sshKeys: { authorized_keys: "k1", id_ed25519: "" },
  dns: ["1.1.1.1", "8.8.8.8"],
  extensions: ["com.nordvpn.macos.Shield"],
  permissions: {},
  tccReadable: false,
  proxies: [],
  hostsHash: "",
  cron: {},
  kexts: [],
  ...over,
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-monitor-"));
  process.env.SM_DATA_DIR = dir;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("diffSnapshots: the rule table", () => {
  const baseline = snap();

  test("new executables are judged by trust and location; Apple software is not an event", () => {
    const curr = snap({
      processes: {
        "/usr/sbin/filecoordinationd": "apple",
        "/System/Library/x/newapple": "apple",
        "/Applications/New.app/Contents/MacOS/New": "developer-id",
        "/opt/homebrew/bin/tool": "adhoc",
        "/Users/rajan/Downloads/dropper": "unsigned",
        "/usr/local/bin/mystery": "unsigned",
      },
    });
    const events = diffSnapshots(baseline, curr, baseline);
    const byRule = Object.fromEntries(events.map((e) => [e.subject, e]));
    expect(byRule["/System/Library/x/newapple"]).toBeUndefined();
    expect(byRule["/Applications/New.app/Contents/MacOS/New"]).toMatchObject({
      severity: "info",
      rule: "process.new-signed",
    });
    expect(byRule["/opt/homebrew/bin/tool"]).toMatchObject({
      severity: "caution",
      rule: "process.unverified",
    });
    expect(byRule["/Users/rajan/Downloads/dropper"]).toMatchObject({
      severity: "alarm",
      rule: "process.unusual-location",
    });
    expect(byRule["/usr/local/bin/mystery"]).toMatchObject({
      severity: "alarm",
      rule: "process.unsigned",
    });
  });

  test("something already in the baseline or the previous tick is not new", () => {
    const prev = snap({ processes: { "/usr/local/bin/seen": "unsigned" } });
    const curr = snap({
      processes: { "/usr/local/bin/seen": "unsigned", "/usr/sbin/filecoordinationd": "apple" },
    });
    expect(diffSnapshots(prev, curr, baseline)).toEqual([]);
  });

  test("new destinations and network-bound ports; ephemeral ports are ignored", () => {
    const curr = snap({
      destinations: ["p59-content.icloud.com", "evil.example.net"],
      ports: [22, 5900, 60000],
    });
    const events = diffSnapshots(baseline, curr, baseline);
    expect(events.map((e) => [e.category, e.subject, e.severity])).toEqual([
      ["network", "evil.example.net", "caution"],
      ["port", "5900", "caution"],
    ]);
    expect(events[1].message).toContain("Screen Sharing");
  });

  test("launch items: new (vendor-aware), changed, removed", () => {
    const prev = snap({
      persistence: {
        "/Library/LaunchAgents/com.apple.foo.plist": "aaa",
        "/Library/LaunchAgents/gone.plist": "ccc",
      },
    });
    const curr = snap({
      persistence: {
        "/Library/LaunchAgents/com.apple.foo.plist": "bbb",
        "/Library/LaunchAgents/com.google.keystone.plist": "ddd",
        "/Users/rajan/Library/LaunchAgents/com.acme.updater.plist": "eee",
      },
    });
    const events = diffSnapshots(prev, curr, baseline).filter((e) => e.category === "persistence");
    expect(events.map((e) => [e.rule, e.severity, path.basename(e.subject)])).toEqual([
      ["persistence.changed", "caution", "com.apple.foo.plist"],
      ["persistence.new-item", "info", "com.google.keystone.plist"],
      ["persistence.new-item", "alarm", "com.acme.updater.plist"],
      ["persistence.removed", "info", "gone.plist"],
    ]);
  });

  test("accounts, admins, DNS, extensions and SSH keys", () => {
    const curr = snap({
      accounts: ["daemon", "nobody", "rajan", "root", "eve"],
      admins: ["root", "rajan", "eve"],
      dns: ["1.1.1.1", "185.0.0.53"],
      extensions: ["com.nordvpn.macos.Shield", "com.evil.filter"],
      sshKeys: { authorized_keys: "k2", id_ed25519: "", id_rsa: "" },
    });
    const events = diffSnapshots(baseline, curr, baseline);
    expect(events.map((e) => [e.rule, e.subject, e.severity])).toEqual([
      ["account.new", "eve", "alarm"],
      ["account.new-admin", "eve", "alarm"],
      ["network.dns-changed", "185.0.0.53", "alarm"],
      ["extension.new", "com.evil.filter", "caution"],
      ["credential.authorized-keys-changed", "authorized_keys", "alarm"],
      ["credential.new-file", "id_rsa", "caution"],
    ]);
  });

  test("posture lamps that worsen or improve", () => {
    const prev = snap({ posture: { firewall: "ok", sip: "ok", updates: "off" } });
    const curr = snap({ posture: { firewall: "caution", sip: "alarm", updates: "ok" } });
    const events = diffSnapshots(prev, curr, baseline).filter((e) => e.category === "posture");
    expect(events.map((e) => [e.subject, e.severity, e.rule])).toEqual([
      ["firewall", "caution", "posture.worsened"],
      ["sip", "alarm", "posture.worsened"],
      ["updates", "info", "posture.improved"],
    ]);
  });
});

describe("dedupe", () => {
  beforeEach(() => __resetMonitor());

  test("the same rule and subject fires once per window", () => {
    const e = (ts: number): MonitorEvent => ({
      id: String(ts),
      ts,
      severity: "alarm",
      category: "process",
      subject: "/x",
      message: "m",
      rule: "r",
    });
    expect(dedupe([e(T0)], T0)).toHaveLength(1);
    expect(dedupe([e(T0 + 1000)], T0 + 1000)).toHaveLength(0);
    expect(dedupe([e(T0 + DEDUPE_WINDOW_MS + 1)], T0 + DEDUPE_WINDOW_MS + 1)).toHaveLength(1);
  });
});

describe("takeSnapshot and tick against fixtures", () => {
  const notifications: string[] = [];

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    __resetMonitor();
    __resetPosture();
    __resetResolveCache();
    notifications.length = 0;
    __setNotifier(async (_title, message) => {
      notifications.push(message);
    });
    installFakeProbe();
    installLoopbackHeaders();
    // The software-update lamp lands in the background; settle it first so
    // every tick in a test sees the same posture.
    await posture(T0);
    await updatesSettled();
  });
  afterEach(async () => {
    await updatesSettled();
    resetSeams();
    __setNotifier(null);
    __resetMonitor();
  });

  test("a snapshot gathers executables, destinations, ports, launch-item hashes and lamps", async () => {
    const s = await takeSnapshot(
      { processes: [proc({ path: "/usr/sbin/filecoordinationd" }), proc({ path: "kernel_task" })] },
      T0,
    );
    expect(s.processes).toEqual({ "/usr/sbin/filecoordinationd": "apple" });
    // 10.0.0.9 is private (local network) so the bare address is kept; 999.999.1.1 does not resolve.
    expect(s.destinations).toEqual(["10.0.0.9", "999.999.1.1"]);
    expect(s.ports).toEqual([22, 39503]);
    expect(Object.keys(s.persistence).sort()).toEqual([
      "/Library/LaunchAgents/com.acme.helper.plist",
      "/Library/LaunchAgents/com.apple.foo.plist",
      "/Library/LaunchAgents/com.docker.vmnetd.plist",
      "/Library/LaunchDaemons/com.apple.bar.plist",
      `${os.homedir()}/Library/LaunchAgents/com.example.updater.plist`,
      `${os.homedir()}/Library/LaunchAgents/com.google.keystone.agent.plist`,
    ]);
    expect(Object.values(s.persistence).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(s.posture.firewall).toBe("caution");
    expect(s.accounts).toEqual(["daemon", "nobody", "rajan", "root"]);
    expect(s.admins).toEqual(["root", "rajan"]);
    expect(s.dns).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(s.extensions).toEqual(["com.nordvpn.macos.Shield"]);
    expect(Object.keys(s.sshKeys).sort()).toEqual([
      "authorized_keys",
      "id_ed25519",
      "id_ed25519.pub",
      "known_hosts",
    ]);
    expect(s.sshKeys.authorized_keys).toMatch(/^[0-9a-f]{64}$/);
    expect(s.sshKeys.known_hosts).toBe("");
  });

  test("the first tick records the baseline; later ticks report only what is new, and alarms notify", async () => {
    const inputs = { processes: [proc({ path: "/usr/sbin/filecoordinationd" })] };
    const first = await tick(inputs, T0, true);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ category: "monitor", rule: "monitor.baseline" });
    expect((await loadBaseline())?.createdAt).toBe(T0);

    // Nothing changed: no events, and the rate limit skips a second call inside the interval.
    expect(await tick(inputs, T0 + 1000)).toEqual([]);
    expect(await tick(inputs, T0 + TICK_INTERVAL_MS, true)).toEqual([]);

    // A new unsigned binary from Downloads appears.
    const later = await tick(
      {
        processes: [
          ...inputs.processes,
          proc({ path: "/Users/rajan/Downloads/dropper", trust: "unsigned" }),
        ],
      },
      T0 + 2 * TICK_INTERVAL_MS,
      true,
    );
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ severity: "alarm", rule: "process.unusual-location" });
    expect(notifications).toEqual([later[0].message]);

    // Persisted, newest first.
    const events = await recentEvents();
    expect(events.map((e) => e.rule)).toEqual(["process.unusual-location", "monitor.baseline"]);
  });

  test("resetting the baseline makes the current state normal", async () => {
    await tick({ processes: [] }, T0, true);
    const extra = { processes: [proc({ path: "/usr/local/bin/mystery", trust: "unsigned" })] };
    expect(await tick(extra, T0 + TICK_INTERVAL_MS, true)).toHaveLength(1);
    await resetBaseline(extra, T0 + 2 * TICK_INTERVAL_MS);
    expect(await tick(extra, T0 + 3 * TICK_INTERVAL_MS, true)).toEqual([]);
    const events = await recentEvents();
    expect(events[0].message).toContain("Baseline reset");
  });

  test("compaction drops events past retention", async () => {
    await appendJsonl("events.jsonl", {
      id: "old",
      ts: T0 - RETENTION_MS - 1,
      severity: "info",
      category: "monitor",
      subject: "x",
      message: "m",
      rule: "r",
    });
    await appendJsonl("events.jsonl", {
      id: "new",
      ts: T0,
      severity: "info",
      category: "monitor",
      subject: "x",
      message: "m",
      rule: "r",
    });
    expect(await compactEvents(T0)).toBe(1);
    expect((await recentEvents()).map((e) => e.id)).toEqual(["new"]);
  });

  test("GET /api/timeline refuses a forged Host and serves the contract", async () => {
    await tick({ processes: [] }, T0, true);
    installHeaders({ host: "evil.example.com" });
    expect((await getTimeline(new Request("http://127.0.0.1:3000/api/timeline"))).status).toBe(403);
    installLoopbackHeaders();
    const res = await getTimeline(new Request("http://127.0.0.1:3000/api/timeline?since=0"));
    expect(res.status).toBe(200);
    const body = parseTimeline(await res.json());
    expect(body.baselineAt).toBe(T0);
    expect(body.events[0].rule).toBe("monitor.baseline");
    const none = parseTimeline(
      await (
        await getTimeline(new Request(`http://127.0.0.1:3000/api/timeline?since=${T0 + 1}`))
      ).json(),
    );
    expect(none.events).toEqual([]);
  });
});
