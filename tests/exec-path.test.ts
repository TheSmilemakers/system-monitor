import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetExecPathCache,
  attachExecutablePaths,
  EXEC_PATH_TTL_MS,
  parseLsofText,
} from "@/lib/exec-path";
import { __resetIdentityCache, identitiesSettled } from "@/lib/identity";
import type { ProcessInfo } from "@/lib/sampler";

import { LSOF_TXT_OUTPUT, installFakeCodesign, installFakeProbe, resetSeams } from "./fixtures";

const row = (pid: number, title: string): ProcessInfo => ({
  user: "rajan",
  pid,
  ppid: 1,
  cpu: 0,
  mem: 0,
  rss: 0,
  command: title,
  path: title,
  elapsed: 0,
  trust: "unknown",
  publisher: null,
  bundleId: null,
});

describe("parseLsofText", () => {
  test("takes the first absolute text file per pid", () => {
    const m = parseLsofText(LSOF_TXT_OUTPUT);
    expect(m.get(95665)).toBe("/Users/rajan/.nvm/versions/node/v22.17.0/bin/node");
    expect(m.get(54357)).toBe("/Applications/Claude.app/Contents/MacOS/Claude");
    expect(m.size).toBe(2);
  });

  test("ignores malformed pids and relative names", () => {
    expect(parseLsofText("pabc\nnfoo\np12\nnrelative\nn/abs").get(12)).toBe("/abs");
  });
});

describe("attachExecutablePaths", () => {
  beforeEach(() => {
    __resetExecPathCache();
    __resetIdentityCache();
    installFakeProbe();
    installFakeCodesign();
  });
  afterEach(() => {
    resetSeams();
    __resetExecPathCache();
    __resetIdentityCache();
  });

  test("resolves title-bearing rows, keeps the title as the display name, and derives identity", async () => {
    const rows = [
      row(95665, "next-server (v16.3.6)"),
      row(54357, "Claude"),
      row(1, "/sbin/launchd"),
    ];
    await attachExecutablePaths(rows);
    expect(rows[0].path).toBe("/Users/rajan/.nvm/versions/node/v22.17.0/bin/node");
    expect(rows[0].command).toBe("next-server (v16.3.6)");
    expect(rows[1].path).toBe("/Applications/Claude.app/Contents/MacOS/Claude");
    expect(rows[2].path).toBe("/sbin/launchd"); // untouched

    await identitiesSettled();
    const again = [row(95665, "next-server (v16.3.6)"), row(54357, "Claude")];
    await attachExecutablePaths(again);
    expect(again[1]).toMatchObject({ trust: "developer-id", publisher: "Google LLC" });
  });

  test("only asks lsof for rows without a path, and only once per pid and title", async () => {
    let calls = 0;
    installFakeProbe({
      lsof: (args) => {
        calls++;
        expect(args).toEqual(["-a", "-d", "txt", "-Fpn", "-p", "95665"]);
        return { status: "ok", value: LSOF_TXT_OUTPUT };
      },
    });
    await attachExecutablePaths([row(95665, "next-server (v16.3.6)"), row(1, "/sbin/launchd")]);
    await attachExecutablePaths([row(95665, "next-server (v16.3.6)")]);
    expect(calls).toBe(1);
  });

  test("a reused pid with a different title is looked up again", async () => {
    let calls = 0;
    installFakeProbe({
      lsof: () => {
        calls++;
        return { status: "ok", value: LSOF_TXT_OUTPUT };
      },
    });
    await attachExecutablePaths([row(95665, "next-server (v16.3.6)")]);
    await attachExecutablePaths([row(95665, "something else")]);
    expect(calls).toBe(2);
  });

  test("cache entries expire", async () => {
    let calls = 0;
    installFakeProbe({
      lsof: () => {
        calls++;
        return { status: "ok", value: LSOF_TXT_OUTPUT };
      },
    });
    const t0 = 1_000_000;
    await attachExecutablePaths([row(95665, "next-server (v16.3.6)")], t0);
    await attachExecutablePaths([row(95665, "next-server (v16.3.6)")], t0 + EXEC_PATH_TTL_MS + 1);
    expect(calls).toBe(2);
  });

  test("a failed lsof leaves rows unchanged and does not throw", async () => {
    installFakeProbe({ lsof: () => ({ status: "denied" }) });
    const rows = [row(95665, "next-server (v16.3.6)")];
    await attachExecutablePaths(rows);
    expect(rows[0].path).toBe("next-server (v16.3.6)");
    expect(rows[0].trust).toBe("unknown");
  });
});
