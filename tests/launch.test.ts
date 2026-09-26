import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GET as getProcess } from "@/app/api/process/route";
import { __resetIdentityCache } from "@/lib/identity";
import {
  __resetLaunchCache,
  LAUNCHCTL_TTL_MS,
  launchctlPids,
  launchProvenance,
  parseLaunchctlList,
} from "@/lib/launch";
import { __resetMonitor } from "@/lib/monitor";
import { __resetNet } from "@/lib/net";
import {
  __resetPersistenceCache,
  cachedPersistenceReport,
  PERSISTENCE_TTL_MS,
} from "@/lib/persistence";
import { __resetPosture } from "@/lib/posture";
import { __resetMachineInfo } from "@/lib/probe";
import { __resetResolveCache } from "@/lib/resolve-host";
import { __resetSampler, sample } from "@/lib/sampler";
import { parseProcessDetail } from "@/lib/schemas";

import {
  installFakeCodesign,
  installFakeProbe,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const T0 = Date.parse("2026-09-26T06:00:00Z");
let dir = "";
const previous = process.env.SM_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-launch-"));
  process.env.SM_DATA_DIR = dir;
  __resetLaunchCache();
  __resetPersistenceCache();
  __resetMonitor();
  __resetIdentityCache();
  __resetResolveCache();
  installFakeProbe();
  installFakeCodesign();
  installLoopbackHeaders();
});
afterEach(async () => {
  resetSeams();
  __resetLaunchCache();
  __resetPersistenceCache();
  __resetMonitor();
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("launchctl list", () => {
  test("parseLaunchctlList maps running pids to labels and skips idle jobs", () => {
    const m = parseLaunchctlList(
      "PID\tStatus\tLabel\n-\t0\tcom.apple.foo\n950\t0\tcom.example.updater\nbad line",
    );
    expect([...m.entries()]).toEqual([[950, "com.example.updater"]]);
  });

  test("one launchctl call serves the TTL", async () => {
    let calls = 0;
    installFakeProbe({
      launchctl: () => {
        calls++;
        return { status: "ok", value: "950\t0\tcom.example.updater" };
      },
    });
    expect((await launchctlPids(T0)).get(950)).toBe("com.example.updater");
    await launchctlPids(T0 + LAUNCHCTL_TTL_MS - 1);
    expect(calls).toBe(1);
    await launchctlPids(T0 + LAUNCHCTL_TTL_MS);
    expect(calls).toBe(2);
  });
});

describe("launchProvenance", () => {
  test("a launch item whose program is the executable wins", async () => {
    const p = await launchProvenance(
      { pid: 4242, ppid: 1, path: "/Users/rajan/Downloads/acme-helper" },
      T0,
    );
    expect(p).toMatchObject({
      kind: "launch-item",
      label: "com.acme.helper",
      scope: "system-agent",
    });
    expect(p.file).toContain("com.acme.helper.plist");
  });

  test("otherwise the user's launchd domain by pid, then launchd on demand, then the parent", async () => {
    expect(await launchProvenance({ pid: 950, ppid: 1, path: "/usr/libexec/trustd" }, T0)).toEqual({
      kind: "launchd",
      label: "com.example.updater",
      scope: "user session",
      file: null,
    });
    expect(
      await launchProvenance({ pid: 648, ppid: 1, path: "/System/x/fileproviderd" }, T0),
    ).toEqual({ kind: "launchd", label: null, scope: null, file: null });
    expect(await launchProvenance({ pid: 903, ppid: 900, path: "/Applications/x" }, T0)).toEqual({
      kind: "parent",
      label: null,
      scope: null,
      file: null,
    });
    expect(await launchProvenance({ pid: 0, ppid: 0, path: "kernel_task" }, T0)).toEqual({
      kind: "unknown",
      label: null,
      scope: null,
      file: null,
    });
  });

  test("the persistence report is cached for a minute", async () => {
    let lists = 0;
    installFakeProbe({
      ls: (args) => {
        if ((args[0] ?? "").includes("LaunchAgents") || (args[0] ?? "").includes("LaunchDaemons"))
          lists++;
        return { status: "ok", value: "" };
      },
    });
    await cachedPersistenceReport(T0);
    await cachedPersistenceReport(T0 + PERSISTENCE_TTL_MS - 1);
    expect(lists).toBe(3);
    await cachedPersistenceReport(T0 + PERSISTENCE_TTL_MS);
    expect(lists).toBe(6);
  });
});

describe("GET /api/process carries the provenance", () => {
  beforeEach(() => {
    __resetMachineInfo();
    __resetSampler();
    __resetNet();
    __resetPosture();
  });
  afterEach(() => __resetSampler());

  test("after a sample, trustd is a launchd job and a Chrome helper is its parent's child", async () => {
    await sample();
    const trustd = parseProcessDetail(
      await (await getProcess(new Request("http://localhost/api/process?pid=950"))).json(),
    );
    expect(trustd.launch).toMatchObject({ kind: "launchd", label: "com.example.updater" });
    const helper = parseProcessDetail(
      await (await getProcess(new Request("http://localhost/api/process?pid=903"))).json(),
    );
    expect(helper.launch.kind).toBe("parent");
    // Unknown pid in the sample: the parser's default, not a crash.
    expect(parseProcessDetail({ pid: 1, launch: { kind: "weird" } }).launch.kind).toBe("unknown");
  });
});
