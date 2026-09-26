import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { setNotifications } from "@/app/actions";
import { GET as getSettings, POST as postSettings } from "@/app/api/settings/route";
import {
  __resetMonitor,
  __setNotifier,
  BASELINE_SCHEMA,
  diffSnapshots,
  extendBaseline,
  loadBaseline,
  monitorSettled,
  normalizeSnapshot,
  tick,
  TICK_INTERVAL_MS,
  type Baseline,
  type Snapshot,
} from "@/lib/monitor";
import { __resetPosture, posture, updatesSettled } from "@/lib/posture";
import { __resetResolveCache } from "@/lib/resolve-host";
import type { ProcessInfo } from "@/lib/sampler";
import { __resetSettings, loadSettings, saveSettings } from "@/lib/settings";
import { readJson, writeJson } from "@/lib/store";

import { installFakeProbe, installHeaders, installLoopbackHeaders, resetSeams } from "./fixtures";

/**
 * Why the dock filled with Script Editor: a baseline from an older build was
 * empty for the surfaces added since, so every fresh start re-announced the
 * accounts, resolvers and keys as new; signed helpers in temp folders were
 * alarms; and each alarm was its own notification. These tests pin the cure.
 */

const T0 = Date.parse("2026-09-26T07:00:00Z");
let dir = "";
const previous = process.env.SM_DATA_DIR;

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

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  normalizeSnapshot({ ts: T0, processes: { "/usr/sbin/filecoordinationd": "apple" }, ...over });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-quiet-"));
  process.env.SM_DATA_DIR = dir;
  __resetMonitor();
  __resetSettings();
  __resetPosture();
  __resetResolveCache();
  installFakeProbe();
  installLoopbackHeaders();
});
afterEach(async () => {
  await updatesSettled();
  await monitorSettled();
  resetSeams();
  __setNotifier(null);
  __resetMonitor();
  __resetSettings();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("extendBaseline", () => {
  test("fills only the surfaces an older baseline lacks, and says which", () => {
    const old: Baseline = { createdAt: 1, snapshot: snap({ accounts: [], dns: [], kexts: [] }) };
    const current = snap({
      accounts: ["rajan", "root"],
      admins: ["root", "rajan"],
      dns: ["1.1.1.1"],
      sshKeys: { authorized_keys: "k" },
      hostsHash: "h".repeat(64),
      processes: { "/new": "unsigned" },
    });
    const filled = extendBaseline(old, current);
    expect(filled).toEqual(["accounts", "admins", "sshKeys", "dns", "hostsHash"]);
    expect(old.snapshot.accounts).toEqual(["rajan", "root"]);
    expect(old.snapshot.dns).toEqual(["1.1.1.1"]);
    // The surfaces it already had are untouched: the new executable stays new.
    expect(old.snapshot.processes).toEqual({ "/usr/sbin/filecoordinationd": "apple" });
    // A current baseline is never touched.
    expect(
      extendBaseline({ createdAt: 1, snapshot: snap(), schema: BASELINE_SCHEMA }, current),
    ).toEqual([]);
  });
});

describe("the process location rule", () => {
  test("signed software in a temp folder is information; an unsigned binary there is an alarm", () => {
    const baseline = snap();
    const curr = snap({
      processes: {
        "/usr/sbin/filecoordinationd": "apple",
        "/private/var/folders/x/T/Code Helper": "developer-id",
        "/private/var/folders/x/T/dropper": "unsigned",
      },
    });
    const events = diffSnapshots(baseline, curr, baseline);
    expect(events.map((e) => [e.subject, e.severity])).toEqual([
      ["/private/var/folders/x/T/Code Helper", "info"],
      ["/private/var/folders/x/T/dropper", "alarm"],
    ]);
    expect(events[0]?.message).toBe(
      "Code Helper (signed) is running from the temporary directory.",
    );
  });
});

describe("tick against an older baseline, and notifications", () => {
  const notifications: string[] = [];
  beforeEach(async () => {
    notifications.length = 0;
    __setNotifier(async (_t, m) => {
      notifications.push(m);
    });
    await posture(T0);
    await updatesSettled();
  });

  test("an older baseline is extended on the first tick instead of re-announcing every account", async () => {
    // Record a full baseline, then strip it back to what a build before
    // accounts, admins, DNS, ssh keys and the rest would have written.
    const inputs = { processes: [proc({ path: "/usr/sbin/filecoordinationd" })] };
    await tick(inputs, T0 - 86_400_000, true);
    const full = await readJson<Baseline>("baseline.json");
    if (!full) throw new Error("no baseline");
    const { processes, destinations, ports, persistence, posture: lamps } = full.snapshot;
    await writeJson("baseline.json", {
      createdAt: full.createdAt,
      snapshot: {
        ts: full.snapshot.ts,
        processes,
        destinations,
        ports,
        persistence,
        posture: lamps,
      },
    });
    __resetMonitor();
    notifications.length = 0;
    const events = await tick(
      { processes: [proc({ path: "/usr/sbin/filecoordinationd" })] },
      T0,
      true,
    );
    const rules = events.map((e) => e.rule);
    expect(rules.filter((r) => r === "account.new" || r === "account.new-admin")).toEqual([]);
    expect(rules.filter((r) => r === "network.dns-changed")).toEqual([]);
    expect(rules.filter((r) => r === "credential.new-file")).toEqual([]);
    expect(events[0]).toMatchObject({ category: "monitor", rule: "monitor.baseline" });
    expect(events[0]?.message).toContain("Baseline extended with surfaces this build added");
    expect(events[0]?.message).toContain("accounts");
    // Nothing urgent: no notification.
    expect(notifications).toEqual([]);
    // The document on disk now carries the schema and the surfaces.
    const doc = await readJson<Baseline>("baseline.json");
    expect(doc?.schema).toBe(BASELINE_SCHEMA);
    expect(doc?.snapshot.accounts).toEqual(["daemon", "nobody", "rajan", "root"]);
    expect((await loadBaseline())?.schema).toBe(BASELINE_SCHEMA);

    // A fresh instance later (previous unknown) is quiet too.
    __resetMonitor();
    const later = await tick(inputs, T0 + TICK_INTERVAL_MS, true);
    expect(later.map((e) => e.rule)).toEqual([]);
  });

  test("several alarms in one tick are one notification; muted means none; the Timeline still fills", async () => {
    await tick({ processes: [] }, T0, true); // baseline
    const bad = [
      proc({ path: "/Users/rajan/Downloads/one", trust: "unsigned" }),
      proc({ path: "/Users/rajan/Downloads/two", trust: "unsigned" }),
      proc({ path: "/Users/rajan/Downloads/three", trust: "unsigned" }),
    ];
    const events = await tick({ processes: bad }, T0 + TICK_INTERVAL_MS, true);
    expect(events.filter((e) => e.severity === "alarm")).toHaveLength(3);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatch(/^3 alarms\. one is running from the Downloads folder/);

    await saveSettings({ notifications: false });
    const more = await tick(
      { processes: [...bad, proc({ path: "/Users/rajan/Downloads/four", trust: "unsigned" })] },
      T0 + 2 * TICK_INTERVAL_MS,
      true,
    );
    expect(more.filter((e) => e.severity === "alarm")).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });
});

describe("settings and the action", () => {
  test("defaults to notifications on, round-trips, and tolerates a torn document", async () => {
    expect(await loadSettings()).toEqual({ notifications: true });
    await saveSettings({ notifications: false });
    __resetSettings();
    expect(await loadSettings()).toEqual({ notifications: false });
    await writeJson("settings.json", { notifications: "yes" });
    __resetSettings();
    expect(await loadSettings()).toEqual({ notifications: true });
  });

  test("setNotifications refuses a forged Host and otherwise flips the switch", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await setNotifications(false)).success).toBe(false);
    installLoopbackHeaders();
    expect(await setNotifications(false)).toEqual({ success: true });
    expect((await loadSettings()).notifications).toBe(false);
    expect(await setNotifications(true)).toEqual({ success: true });
    expect((await loadSettings()).notifications).toBe(true);
  });

  test("the settings route serves and changes the switch behind the loopback guard", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getSettings()).status).toBe(403);
    installLoopbackHeaders();
    expect(await (await getSettings()).json()).toEqual({ notifications: true });
    const bad = await postSettings(
      new Request("http://localhost/api/settings", { method: "POST", body: "{}" }),
    );
    expect(bad.status).toBe(400);
    const off = await postSettings(
      new Request("http://localhost/api/settings", {
        method: "POST",
        body: JSON.stringify({ notifications: false }),
      }),
    );
    expect(await off.json()).toEqual({ notifications: false });
    expect((await loadSettings()).notifications).toBe(false);
  });

  test("with SM_NOTIFIER=app the server leaves notifications to the shell", async () => {
    const notifications: string[] = [];
    __setNotifier(async (_t, m) => {
      notifications.push(m);
    });
    process.env.SM_NOTIFIER = "app";
    try {
      await tick({ processes: [] }, T0, true);
      const events = await tick(
        { processes: [proc({ path: "/Users/rajan/Downloads/dropper", trust: "unsigned" })] },
        T0 + TICK_INTERVAL_MS,
        true,
      );
      expect(events.some((e) => e.severity === "alarm")).toBe(true);
      expect(notifications).toEqual([]);
    } finally {
      delete process.env.SM_NOTIFIER;
    }
  });
});
