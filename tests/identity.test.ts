import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetIdentityCache,
  __setCodesignRunner,
  IDENTITY_TTL_MS,
  identitiesSettled,
  identityFor,
  parseCodesign,
  parseElapsed,
} from "@/lib/identity";
import { displayName, parsePsDetailed } from "@/lib/sampler";

import {
  CODESIGN_ADHOC,
  CODESIGN_APP_STORE,
  CODESIGN_APPLE,
  CODESIGN_DEVELOPER_ID,
  CODESIGN_UNSIGNED,
  PS_DETAILED_OUTPUT,
  installFakeCodesign,
} from "./fixtures";

describe("parseCodesign", () => {
  test("Apple's own software signing chain is 'apple'", () => {
    expect(parseCodesign(CODESIGN_APPLE, true)).toEqual({
      trust: "apple",
      publisher: "Apple",
      teamId: null,
      bundleId: "com.apple.filecoordinationd",
    });
  });

  test("a Developer ID certificate yields the publisher and team", () => {
    expect(parseCodesign(CODESIGN_DEVELOPER_ID, true)).toEqual({
      trust: "developer-id",
      publisher: "Google LLC",
      teamId: "EQHXZ8M8AV",
      bundleId: "com.google.Chrome",
    });
  });

  test("App Store signing is its own state", () => {
    expect(parseCodesign(CODESIGN_APP_STORE, true)).toMatchObject({
      trust: "app-store",
      teamId: "ABCDE12345",
      bundleId: "com.example.storeapp",
    });
  });

  test("ad-hoc signatures carry no identity and 'a.out' is not a bundle id", () => {
    expect(parseCodesign(CODESIGN_ADHOC, true)).toEqual({
      trust: "adhoc",
      publisher: null,
      teamId: null,
      bundleId: null,
    });
  });

  test("an unsigned object is 'unsigned', any other failure is 'unknown'", () => {
    expect(parseCodesign(CODESIGN_UNSIGNED, false).trust).toBe("unsigned");
    expect(parseCodesign("codesign: timed out", false).trust).toBe("unknown");
    expect(parseCodesign("", true).trust).toBe("unknown");
  });
});

describe("parseElapsed", () => {
  test("handles every ps ELAPSED form", () => {
    expect(parseElapsed("42")).toBe(42);
    expect(parseElapsed("05:12")).toBe(5 * 60 + 12);
    expect(parseElapsed("03:23:33")).toBe(3 * 3600 + 23 * 60 + 33);
    expect(parseElapsed("18-00:12:06")).toBe(18 * 86_400 + 12 * 60 + 6);
    expect(parseElapsed("12-05:04:40")).toBe(12 * 86_400 + 5 * 3600 + 4 * 60 + 40);
  });

  test("garbage is zero, never NaN", () => {
    expect(parseElapsed("")).toBe(0);
    expect(parseElapsed("abc")).toBe(0);
    expect(parseElapsed("1:2:3:4:5")).toBe(0);
  });
});

describe("identityFor: cached, background, bounded", () => {
  beforeEach(() => {
    __resetIdentityCache();
  });
  afterEach(() => {
    __setCodesignRunner(null);
    __resetIdentityCache();
  });

  test("a miss is 'pending' now and resolved after the queue drains", async () => {
    installFakeCodesign();
    const first = identityFor("/usr/sbin/filecoordinationd");
    expect(first.trust).toBe("pending");
    await identitiesSettled();
    expect(identityFor("/usr/sbin/filecoordinationd")).toMatchObject({
      trust: "apple",
      publisher: "Apple",
    });
  });

  test("names without a path are 'unknown' immediately and never looked up", async () => {
    let calls = 0;
    __setCodesignRunner(async () => {
      calls++;
      return { ok: true, output: CODESIGN_APPLE };
    });
    expect(identityFor("kernel_task").trust).toBe("unknown");
    await identitiesSettled();
    expect(calls).toBe(0);
  });

  test("each path is looked up once per TTL", async () => {
    let calls = 0;
    __setCodesignRunner(async () => {
      calls++;
      return { ok: true, output: CODESIGN_DEVELOPER_ID };
    });
    for (let i = 0; i < 5; i++) identityFor("/Applications/Slack.app/Contents/MacOS/Slack");
    await identitiesSettled();
    for (let i = 0; i < 5; i++) identityFor("/Applications/Slack.app/Contents/MacOS/Slack");
    await identitiesSettled();
    expect(calls).toBe(1);

    // After the TTL the stale entry is served once more and refreshed in the background.
    const later = Date.now() + IDENTITY_TTL_MS + 1;
    expect(identityFor("/Applications/Slack.app/Contents/MacOS/Slack", later).trust).toBe(
      "developer-id",
    );
    await identitiesSettled();
    expect(calls).toBe(2);
  });

  test("never runs more than four lookups at once", async () => {
    let inFlight = 0;
    let peak = 0;
    __setCodesignRunner(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, output: CODESIGN_APPLE };
    });
    for (let i = 0; i < 12; i++) identityFor(`/usr/bin/tool-${i}`);
    await identitiesSettled();
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  test("a runner failure is recorded as 'unknown' and does not wedge the queue", async () => {
    __setCodesignRunner(async (path) => {
      if (path.includes("bad")) throw new Error("boom");
      return { ok: true, output: CODESIGN_APPLE };
    });
    identityFor("/usr/bin/bad");
    identityFor("/usr/bin/good");
    await identitiesSettled();
    expect(identityFor("/usr/bin/bad").trust).toBe("unknown");
    expect(identityFor("/usr/bin/good").trust).toBe("apple");
  });
});

describe("parsePsDetailed", () => {
  beforeEach(() => __resetIdentityCache());
  afterEach(() => {
    __setCodesignRunner(null);
    __resetIdentityCache();
  });

  test("keeps paths with spaces intact and derives the display name", () => {
    installFakeCodesign();
    const rows = parsePsDetailed(PS_DETAILED_OUTPUT);
    const helper = rows.find((r) => r.pid === 903);
    expect(helper?.command).toBe("Google Chrome Helper (Renderer)");
    expect(helper?.path).toMatch(/\/Google Chrome Helper \(Renderer\)$/);
    expect(helper?.ppid).toBe(900);
    expect(helper?.elapsed).toBe(3600);
    expect(rows.find((r) => r.pid === 900)?.command).toBe("Google Chrome");
  });

  test("drops the kernel pseudo-process (pid 0) and sorts by CPU", () => {
    installFakeCodesign();
    const rows = parsePsDetailed(PS_DETAILED_OUTPUT);
    expect(rows.map((r) => r.pid)).toEqual([648, 637, 900, 902, 901, 903, 950]);
  });

  test("identity is pending on the first parse and filled once resolved", async () => {
    installFakeCodesign();
    const first = parsePsDetailed(PS_DETAILED_OUTPUT);
    expect(first[0]?.trust).toBe("pending");
    await identitiesSettled();
    const second = parsePsDetailed(PS_DETAILED_OUTPUT);
    expect(second.find((r) => r.pid === 648)).toMatchObject({
      trust: "apple",
      publisher: "Apple",
      bundleId: "com.apple.filecoordinationd",
    });
    expect(second.find((r) => r.pid === 900)).toMatchObject({
      trust: "developer-id",
      publisher: "Google LLC",
    });
  });

  test("displayName", () => {
    expect(displayName("/usr/sbin/filecoordinationd")).toBe("filecoordinationd");
    expect(displayName("kernel_task")).toBe("kernel_task");
    expect(displayName("")).toBe("unknown");
  });
});
