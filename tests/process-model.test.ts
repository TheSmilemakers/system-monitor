import { describe, expect, test } from "bun:test";

import {
  appOf,
  bundleRoot,
  childrenOf,
  explainTrust,
  filterProcesses,
  groupByApp,
  formatAge,
  indexByPid,
  locationClass,
  parentChain,
  sortProcesses,
  trustLamp,
} from "@/lib/process-model";
import type { ProcessInfo } from "@/lib/schemas";

const proc = (over: Partial<ProcessInfo>): ProcessInfo => ({
  user: "rajan",
  pid: 1000,
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
  connections: 0,
  newSinceBaseline: false,
  ...over,
});

const launchd = proc({ pid: 1, ppid: 0, user: "root", command: "launchd", path: "/sbin/launchd" });
const chrome = proc({
  pid: 900,
  cpu: 3,
  mem: 1.4,
  rss: 200,
  command: "Google Chrome",
  path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  trust: "developer-id",
  publisher: "Google LLC",
  bundleId: "com.google.Chrome",
  elapsed: 3600,
});
const helper = proc({
  pid: 903,
  ppid: 900,
  cpu: 0.8,
  command: "Google Chrome Helper (Renderer)",
  path: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
  trust: "developer-id",
  publisher: "Google LLC",
});
const brew = proc({
  pid: 2000,
  cpu: 12,
  command: "gh",
  path: "/opt/homebrew/bin/gh",
  trust: "adhoc",
  publisher: null,
});
const dl = proc({
  pid: 3000,
  cpu: 1,
  command: "installer",
  path: "/Users/rajan/Downloads/installer",
  trust: "unsigned",
  publisher: null,
});
const daemon = proc({
  pid: 637,
  user: "root",
  cpu: 11.1,
  command: "filecoordinationd",
  path: "/usr/sbin/filecoordinationd",
});
const all = [launchd, chrome, helper, brew, dl, daemon];

describe("sortProcesses", () => {
  test("numeric keys sort in either direction and are stable on ties", () => {
    expect(sortProcesses(all, "cpu", "desc").map((p) => p.pid)).toEqual([
      2000, 637, 900, 3000, 903, 1,
    ]);
    expect(sortProcesses(all, "cpu", "asc").map((p) => p.pid)).toEqual([
      1, 903, 3000, 900, 637, 2000,
    ]);
    // launchd and daemon share elapsed 0 with everyone but chrome: incoming order kept.
    expect(sortProcesses(all, "elapsed", "desc").map((p) => p.pid)).toEqual([
      900, 1, 903, 2000, 3000, 637,
    ]);
  });

  test("command sorts case-insensitively, trust by rank", () => {
    expect(sortProcesses(all, "command", "asc").map((p) => p.command)).toEqual([
      "filecoordinationd",
      "gh",
      "Google Chrome",
      "Google Chrome Helper (Renderer)",
      "installer",
      "launchd",
    ]);
    expect(sortProcesses(all, "trust", "asc").map((p) => p.trust)).toEqual([
      "unsigned",
      "adhoc",
      "developer-id",
      "developer-id",
      "apple",
      "apple",
    ]);
  });

  test("does not mutate the input", () => {
    const copy = [...all];
    sortProcesses(all, "pid", "asc");
    expect(all).toEqual(copy);
  });
});

describe("filterProcesses", () => {
  const base = {
    filter: "all" as const,
    query: "",
    currentUser: "rajan",
    alertedPids: new Set<number>(),
  };

  test("mine, system, untrusted and alerted", () => {
    expect(filterProcesses(all, { ...base, filter: "mine" }).map((p) => p.pid)).toEqual([
      900, 903, 2000, 3000,
    ]);
    expect(filterProcesses(all, { ...base, filter: "system" }).map((p) => p.pid)).toEqual([1, 637]);
    expect(filterProcesses(all, { ...base, filter: "untrusted" }).map((p) => p.pid)).toEqual([
      2000, 3000,
    ]);
    expect(
      filterProcesses(all, { ...base, filter: "alerted", alertedPids: new Set([637]) }).map(
        (p) => p.pid,
      ),
    ).toEqual([637]);
    expect(filterProcesses(all, { ...base, filter: "mine", currentUser: null })).toEqual([]);
  });

  test("query matches name, path, publisher, bundle id, user and exact pid", () => {
    expect(filterProcesses(all, { ...base, query: "chrome" }).map((p) => p.pid)).toEqual([
      900, 903,
    ]);
    expect(filterProcesses(all, { ...base, query: "google llc" }).map((p) => p.pid)).toEqual([
      900, 903,
    ]);
    expect(filterProcesses(all, { ...base, query: "com.google" }).map((p) => p.pid)).toEqual([900]);
    expect(filterProcesses(all, { ...base, query: "homebrew" }).map((p) => p.pid)).toEqual([2000]);
    expect(filterProcesses(all, { ...base, query: "637" }).map((p) => p.pid)).toEqual([637]);
    expect(filterProcesses(all, { ...base, query: "63" })).toEqual([]);
    expect(filterProcesses(all, { ...base, query: "ROOT" }).map((p) => p.pid)).toEqual([1, 637]);
  });
});

describe("parent chain and app grouping", () => {
  test("parentChain walks to launchd and stops", () => {
    const byPid = indexByPid(all);
    expect(parentChain(903, byPid).map((p) => p.pid)).toEqual([900, 1]);
    expect(parentChain(1, byPid)).toEqual([]);
    expect(parentChain(99999, byPid)).toEqual([]);
  });

  test("parentChain survives a cycle", () => {
    const a = proc({ pid: 10, ppid: 11 });
    const b = proc({ pid: 11, ppid: 10 });
    expect(parentChain(10, indexByPid([a, b])).map((p) => p.pid)).toEqual([11]);
  });

  test("childrenOf", () => {
    expect(childrenOf(900, all).map((p) => p.pid)).toEqual([903]);
    expect(childrenOf(903, all)).toEqual([]);
  });

  test("bundleRoot takes the outermost .app; appOf names the app", () => {
    expect(bundleRoot(helper.path)).toBe("/Applications/Google Chrome.app");
    expect(bundleRoot("/usr/sbin/filecoordinationd")).toBeNull();
    expect(appOf(helper)).toBe("Google Chrome");
    expect(appOf(daemon)).toBe("filecoordinationd");
  });
});

describe("lamps, locations, hints", () => {
  test("trustLamp maps every state to a lamp with a label", () => {
    expect(trustLamp("apple")).toMatchObject({ state: "ok", short: "Apple" });
    expect(trustLamp("developer-id").state).toBe("ok");
    expect(trustLamp("adhoc").state).toBe("caution");
    expect(trustLamp("unsigned").state).toBe("alarm");
    expect(trustLamp("unknown").state).toBe("off");
    expect(trustLamp("pending")).toMatchObject({ state: "off", short: "Checking" });
  });

  test("locationClass flags the places code should not usually run from", () => {
    expect(locationClass("/usr/sbin/filecoordinationd")).toMatchObject({
      key: "system",
      flag: false,
    });
    expect(locationClass("/Applications/Slack.app/Contents/MacOS/Slack").key).toBe("apps");
    expect(locationClass("/opt/homebrew/bin/gh").key).toBe("homebrew");
    expect(locationClass("/Users/rajan/Downloads/installer")).toMatchObject({
      key: "downloads",
      flag: true,
    });
    expect(locationClass("/private/tmp/x")).toMatchObject({ key: "temp", flag: true });
    expect(locationClass("/Users/rajan/Library/Application Support/x/bin")).toMatchObject({
      key: "user-library",
    });
    expect(locationClass("kernel_task").key).toBe("none");
  });

  test("explainTrust is one honest sentence per state", () => {
    expect(explainTrust(daemon)).toBe(
      "Part of macOS, signed by Apple. Runs from macOS system location.",
    );
    expect(explainTrust(chrome)).toContain("signed by Google LLC");
    expect(explainTrust(brew)).toContain("Homebrew");
    expect(explainTrust(dl)).toContain("unusual for running code");
    expect(explainTrust(proc({ trust: "pending", path: "kernel_task" }))).toBe(
      "Signature check in progress.",
    );
  });

  test("formatAge", () => {
    expect(formatAge(42)).toBe("42s");
    expect(formatAge(312)).toBe("5m 12s");
    expect(formatAge(3600 * 3 + 60 * 23 + 33)).toBe("3h 23m");
    expect(formatAge(86_400 * 18 + 3600)).toBe("18d 1h");
    expect(formatAge(-1)).toBe("0s");
    expect(formatAge(Number.NaN)).toBe("0s");
  });
});

describe("networked and new-since-baseline filters, publisher and connection sorting", () => {
  const list = [
    proc({ pid: 1, command: "a", publisher: "Zed", connections: 0, newSinceBaseline: false }),
    proc({ pid: 2, command: "b", publisher: null, connections: 3, newSinceBaseline: true }),
    proc({ pid: 3, command: "c", publisher: "apple", connections: 1, newSinceBaseline: false }),
  ];
  const opts = { query: "", currentUser: "rajan", alertedPids: new Set<number>() };

  test("networked keeps processes with a connection; new keeps those absent from the baseline", () => {
    expect(filterProcesses(list, { ...opts, filter: "networked" }).map((p) => p.pid)).toEqual([
      2, 3,
    ]);
    expect(filterProcesses(list, { ...opts, filter: "new" }).map((p) => p.pid)).toEqual([2]);
  });

  test("publisher sorts case-insensitively with the unknown first; connections numerically", () => {
    expect(sortProcesses(list, "publisher", "asc").map((p) => p.pid)).toEqual([2, 3, 1]);
    expect(sortProcesses(list, "connections", "desc").map((p) => p.pid)).toEqual([2, 3, 1]);
    expect(sortProcesses(list, "path", "asc").map((p) => p.pid)).toEqual([1, 2, 3]);
  });
});

describe("groupByApp", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const helper = "/Applications/Google Chrome.app/Contents/Frameworks/H.app/Contents/MacOS/Helper";
  const list = [
    proc({ pid: 1, command: "launchd", path: "/sbin/launchd", cpu: 1, rss: 10 }),
    proc({ pid: 900, command: "Google Chrome", path: chrome, cpu: 3, rss: 100 }),
    proc({ pid: 2000, command: "gh", path: "/opt/homebrew/bin/gh", cpu: 12 }),
    proc({ pid: 903, ppid: 900, command: "Helper", path: helper, cpu: 5, rss: 50 }),
    proc({ pid: 904, ppid: 900, command: "Helper", path: helper, cpu: 2, rss: 20 }),
  ];

  test("folds an app's processes under the first in list order, with totals; singletons stay put", () => {
    const g = groupByApp(list);
    expect(g.order.map((p) => p.pid)).toEqual([1, 900, 903, 904, 2000]);
    expect(g.groups.get(900)).toMatchObject({ cpu: 10, rss: 170 });
    expect(g.groups.get(900)?.members.map((p) => p.pid)).toEqual([903, 904]);
    expect([...g.memberOf.entries()]).toEqual([
      [903, 900],
      [904, 900],
    ]);
    expect(g.groups.has(2000)).toBe(false);
  });

  test("a helper sorted above its app leads the group", () => {
    const g = groupByApp([list[3], list[1], list[4]]);
    expect(g.order.map((p) => p.pid)).toEqual([903, 900, 904]);
    expect(g.groups.get(903)?.members.map((p) => p.pid)).toEqual([900, 904]);
    expect(groupByApp([]).order).toEqual([]);
  });
});
