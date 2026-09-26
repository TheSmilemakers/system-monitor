import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getPermissions } from "@/app/api/permissions/route";
import {
  __resetMonitor,
  __setNotifier,
  diffSnapshots,
  loadBaseline,
  monitorSettled,
  normalizeSnapshot,
  parseProxies,
  takeSnapshot,
  tick,
  TICK_INTERVAL_MS,
  type Snapshot,
} from "@/lib/monitor";
import { __resetPosture, parseKexts, posture, updatesSettled } from "@/lib/posture";
import { __resetResolveCache } from "@/lib/resolve-host";
import { parsePermissions } from "@/lib/schemas";
import { writeJson } from "@/lib/store";

import {
  installFakeProbe,
  installLoopbackHeaders,
  KMUTIL_OUTPUT_APPLE,
  KMUTIL_OUTPUT_THIRD_PARTY,
  PROXY_OUTPUT_HTTP,
  PROXY_OUTPUT_NONE,
  resetSeams,
} from "./fixtures";

/**
 * The third-stage drift surfaces: privacy grants, proxies and /etc/hosts,
 * cron and periodic scripts, kernel extensions. Pure rules first, then the
 * snapshot against fixtures, then the permissions route's history.
 */

const T0 = Date.parse("2026-09-26T04:00:00Z");
let dir = "";
const previous = process.env.SM_DATA_DIR;

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  normalizeSnapshot({ ts: T0, processes: { "/usr/sbin/filecoordinationd": "apple" }, ...over });

describe("parsers", () => {
  test("parseProxies lists only enabled proxies, with ports, and the PAC url", () => {
    expect(parseProxies(PROXY_OUTPUT_NONE)).toEqual([]);
    expect(parseProxies(PROXY_OUTPUT_HTTP)).toEqual([
      "HTTP proxy.example.net:8080",
      "HTTPS proxy.example.net:8443",
      "PAC http://pac.example.net/proxy.pac",
    ]);
    expect(parseProxies("SOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\n")).toEqual(["SOCKS 127.0.0.1"]);
  });

  test("parseKexts keeps third-party bundle ids and drops Apple's", () => {
    expect(parseKexts(KMUTIL_OUTPUT_APPLE)).toEqual([]);
    expect(parseKexts(KMUTIL_OUTPUT_THIRD_PARTY)).toEqual([
      "com.paragon-software.filesystems.ntfs",
    ]);
    expect(parseKexts("")).toEqual([]);
  });

  test("normalizeSnapshot fills what an older baseline lacks", () => {
    const old = normalizeSnapshot({ ts: 1, processes: { "/a": "apple" } });
    expect(old.permissions).toEqual({});
    expect(old.tccReadable).toBe(false);
    expect(old.proxies).toEqual([]);
    expect(old.hostsHash).toBe("");
    expect(old.cron).toEqual({});
    expect(old.kexts).toEqual([]);
    expect(old.processes).toEqual({ "/a": "apple" });
  });
});

describe("diffSnapshots: the third-stage rules", () => {
  const baseline = snap();

  test("a proxy appearing is an alarm; one going away is information", () => {
    const withProxy = snap({ proxies: ["HTTP proxy.example.net:8080"] });
    expect(diffSnapshots(baseline, withProxy, baseline)).toMatchObject([
      { severity: "alarm", category: "network", rule: "network.proxy-set" },
    ]);
    expect(diffSnapshots(withProxy, baseline, baseline)).toMatchObject([
      { severity: "info", rule: "network.proxy-removed", subject: "HTTP proxy.example.net:8080" },
    ]);
    expect(diffSnapshots(withProxy, withProxy, baseline)).toEqual([]);
  });

  test("/etc/hosts changing is an alarm, but only between two readable hashes", () => {
    const a = snap({ hostsHash: "a".repeat(64) });
    const b = snap({ hostsHash: "b".repeat(64) });
    const unread = snap({ hostsHash: "" });
    expect(diffSnapshots(a, b, baseline)).toMatchObject([
      { severity: "alarm", rule: "network.hosts-changed", subject: "/etc/hosts" },
    ]);
    expect(diffSnapshots(a, a, baseline)).toEqual([]);
    expect(diffSnapshots(unread, b, baseline)).toEqual([]);
    expect(diffSnapshots(a, unread, baseline)).toEqual([]);
    expect(diffSnapshots(null, b, baseline)).toEqual([]);
  });

  test("cron: a crontab appearing, a periodic script appearing or changing", () => {
    const withTab = snap({ cron: { crontab: "1".repeat(64) } });
    expect(diffSnapshots(baseline, withTab, baseline)).toMatchObject([
      {
        severity: "alarm",
        category: "persistence",
        rule: "persistence.cron-new",
        subject: "crontab",
      },
    ]);
    const changed = snap({ cron: { crontab: "2".repeat(64) } });
    expect(diffSnapshots(withTab, changed, baseline)).toMatchObject([
      { rule: "persistence.cron-changed", message: "The crontab changed." },
    ]);
    const script = snap({ cron: { "/etc/periodic/daily/999.evil": "3".repeat(64) } });
    expect(diffSnapshots(baseline, script, baseline)).toMatchObject([
      {
        rule: "persistence.cron-new",
        message: "New periodic script: /etc/periodic/daily/999.evil.",
      },
    ]);
    // In the baseline: nothing to say.
    expect(diffSnapshots(null, withTab, withTab)).toEqual([]);
  });

  test("a kernel extension loading is a caution", () => {
    const k = snap({ kexts: ["com.paragon-software.filesystems.ntfs"] });
    expect(diffSnapshots(baseline, k, baseline)).toMatchObject([
      { severity: "caution", category: "extension", rule: "extension.new-kext" },
    ]);
    expect(diffSnapshots(k, k, baseline)).toEqual([]);
  });

  test("privacy grants: high-risk is an alarm, others a caution, revocation is information", () => {
    const before = snap({
      tccReadable: true,
      permissions: { kTCCServiceCamera: ["us.zoom.xos"] },
    });
    const after = snap({
      tccReadable: true,
      permissions: {
        kTCCServiceScreenCapture: ["com.evil.recorder"],
        kTCCServiceCamera: ["us.zoom.xos", "com.slack.Slack"],
      },
    });
    const events = diffSnapshots(before, after, before);
    expect(events.map((e) => [e.rule, e.subject, e.severity])).toEqual([
      ["permission.granted", "kTCCServiceScreenCapture:com.evil.recorder", "alarm"],
      ["permission.granted", "kTCCServiceCamera:com.slack.Slack", "caution"],
    ]);
    expect(events[0]?.message).toBe("com.evil.recorder was granted Screen Recording.");
    expect(diffSnapshots(after, before, before)).toMatchObject([
      { rule: "permission.revoked", subject: "kTCCServiceScreenCapture:com.evil.recorder" },
      {
        rule: "permission.revoked",
        severity: "info",
        subject: "kTCCServiceCamera:com.slack.Slack",
      },
    ]);
  });

  test("privacy grants are not judged when either side could not read the database", () => {
    const unreadable = snap({ tccReadable: false, permissions: {} });
    const readable = snap({
      tccReadable: true,
      permissions: { kTCCServiceScreenCapture: ["com.evil.recorder"] },
    });
    expect(diffSnapshots(unreadable, readable, unreadable)).toEqual([]);
    expect(diffSnapshots(readable, unreadable, readable)).toEqual([]);
    // A baseline that could read, and a previous tick that could not: the baseline decides.
    expect(diffSnapshots(unreadable, readable, readable)).toEqual([]);
  });
});

describe("snapshot, posture and the permissions route against fixtures", () => {
  const notifications: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sm-drift-"));
    process.env.SM_DATA_DIR = dir;
    __resetMonitor();
    __resetPosture();
    __resetResolveCache();
    notifications.length = 0;
    __setNotifier(async (_title, message) => {
      notifications.push(message);
    });
    installFakeProbe();
    installLoopbackHeaders();
    await posture(T0);
    await updatesSettled();
  });
  afterEach(async () => {
    await updatesSettled();
    await monitorSettled();
    resetSeams();
    __setNotifier(null);
    __resetMonitor();
    __resetPosture();
    if (previous === undefined) delete process.env.SM_DATA_DIR;
    else process.env.SM_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("the default fixtures give a quiet snapshot: no proxies, no kexts, no cron, TCC protected", async () => {
    const s = await takeSnapshot({ processes: [] }, T0);
    expect(s.proxies).toEqual([]);
    expect(s.kexts).toEqual([]);
    expect(s.cron).toEqual({});
    expect(s.tccReadable).toBe(false);
    expect(s.permissions).toEqual({});
    expect(s.hostsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the snapshot gathers proxies, kexts, the crontab hash and readable grants", async () => {
    installFakeProbe({
      scutil: (args) =>
        args[0] === "--proxy"
          ? { status: "ok", value: PROXY_OUTPUT_HTTP }
          : { status: "ok", value: "nameserver[0] : 1.1.1.1" },
      kmutil: () => ({ status: "ok", value: KMUTIL_OUTPUT_THIRD_PARTY }),
      crontab: () => ({ status: "ok", value: "* * * * * /tmp/x\n" }),
      sqlite3: (args) => ({
        status: "ok",
        value: (args[1] ?? "").includes("kTCCServiceCamera") ? "us.zoom.xos" : "",
      }),
    });
    const s = await takeSnapshot({ processes: [] }, T0);
    expect(s.proxies).toHaveLength(3);
    expect(s.kexts).toEqual(["com.paragon-software.filesystems.ntfs"]);
    expect(s.cron.crontab).toMatch(/^[0-9a-f]{64}$/);
    expect(s.tccReadable).toBe(true);
    expect(s.permissions.kTCCServiceCamera).toEqual(["us.zoom.xos"]);
    expect(s.permissions.kTCCServiceScreenCapture).toEqual([]);
  });

  test("a kernel extension turns the Extensions lamp to caution", async () => {
    __resetPosture();
    installFakeProbe({ kmutil: () => ({ status: "ok", value: KMUTIL_OUTPUT_THIRD_PARTY }) });
    const r = await posture(T0 + 120_000);
    await updatesSettled();
    const lamp = r.lamps.find((l) => l.id === "sysext");
    expect(lamp?.state).toBe("caution");
    expect(lamp?.summary).toContain(
      "1 kernel extension loaded: com.paragon-software.filesystems.ntfs",
    );
  });

  test("an older baseline on disk is normalised, and a new proxy after it is an alarm that notifies", async () => {
    // A baseline written by a build that knew nothing of proxies or grants.
    await writeJson("baseline.json", {
      createdAt: T0 - 86_400_000,
      snapshot: {
        ts: T0 - 86_400_000,
        processes: {},
        destinations: ["10.0.0.9", "999.999.1.1"],
        ports: [22, 39503],
        persistence: {},
        posture: {},
        accounts: ["daemon", "nobody", "rajan", "root"],
        admins: ["root", "rajan"],
        sshKeys: {},
        dns: ["1.1.1.1", "8.8.8.8"],
        extensions: ["com.nordvpn.macos.Shield"],
      },
    });
    expect((await loadBaseline())?.snapshot.proxies).toEqual([]);

    await tick({ processes: [] }, T0, true); // previous = quiet
    installFakeProbe({
      scutil: (args) =>
        args[0] === "--proxy"
          ? { status: "ok", value: PROXY_OUTPUT_HTTP }
          : { status: "ok", value: "nameserver[0] : 1.1.1.1\nnameserver[1] : 8.8.8.8" },
    });
    const events = await tick({ processes: [] }, T0 + TICK_INTERVAL_MS, true);
    const proxies = events.filter((e) => e.rule === "network.proxy-set");
    expect(proxies).toHaveLength(3);
    expect(notifications).toEqual(expect.arrayContaining([proxies[0]?.message ?? ""]));
  });

  test("the permissions route carries the last week of grant events", async () => {
    await tick({ processes: [] }, T0, true);
    // Record a grant event by making the database readable with a new client.
    installFakeProbe({
      sqlite3: (args) => ({
        status: "ok",
        value: (args[1] ?? "").includes("kTCCServiceScreenCapture") ? "com.evil.recorder" : "",
      }),
    });
    // The baseline could not read TCC, so the first readable tick says nothing...
    expect(
      (await tick({ processes: [] }, T0 + TICK_INTERVAL_MS, true)).filter(
        (e) => e.category === "permission",
      ),
    ).toEqual([]);
    // ...and the next one, with a readable previous tick, reports the new client.
    installFakeProbe({
      sqlite3: (args) => ({
        status: "ok",
        value: (args[1] ?? "").includes("kTCCServiceScreenCapture")
          ? "com.evil.recorder\ncom.other.recorder"
          : "",
      }),
    });
    const later = await tick({ processes: [] }, T0 + 2 * TICK_INTERVAL_MS, true);
    expect(later.filter((e) => e.category === "permission")).toMatchObject([
      { rule: "permission.granted", subject: "kTCCServiceScreenCapture:com.other.recorder" },
    ]);

    const res = await getPermissions();
    expect(res.status).toBe(200);
    const body = parsePermissions(await res.json());
    expect(body.readable).toBe(true);
    expect(body.recent.map((e) => e.rule)).toEqual(["permission.granted"]);
    expect(parsePermissions({ grants: [] }).recent).toEqual([]);
  });
});
