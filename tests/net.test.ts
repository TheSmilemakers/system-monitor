import { afterEach, describe, expect, test } from "bun:test";

import { __resetNet, netRate, parseNetstatBytes, trackNetRate } from "@/lib/net";

import { NETSTAT_IB_OUTPUT } from "./fixtures";

describe("parseNetstatBytes", () => {
  test("sums the link rows, excluding loopback, and ignores address rows", () => {
    expect(parseNetstatBytes(NETSTAT_IB_OUTPUT)).toEqual({
      inBytes: 2_000_000_000 + 10_000_000,
      outBytes: 500_000_000 + 5_000_000,
    });
  });

  test("empty or malformed output is zero", () => {
    expect(parseNetstatBytes("")).toEqual({ inBytes: 0, outBytes: 0 });
    expect(parseNetstatBytes("en0 <Link#1> x")).toEqual({ inBytes: 0, outBytes: 0 });
  });
});

describe("netRate", () => {
  test("bytes per interval become KB/s, rounded to a tenth", () => {
    const r = netRate(
      { inBytes: 0, outBytes: 0 },
      { inBytes: 5 * 1024 * 1024, outBytes: 1024 * 512 },
      5000,
    );
    expect(r).toEqual({ inKBps: 1024, outKBps: 102.4 });
  });

  test("a counter reset or a zero interval reads as zero, never negative", () => {
    expect(netRate({ inBytes: 100, outBytes: 100 }, { inBytes: 50, outBytes: 50 }, 1000)).toEqual({
      inKBps: 0,
      outKBps: 0,
    });
    expect(netRate({ inBytes: 0, outBytes: 0 }, { inBytes: 100, outBytes: 100 }, 0)).toEqual({
      inKBps: 0,
      outKBps: 0,
    });
  });
});

describe("trackNetRate", () => {
  afterEach(() => __resetNet());

  test("first reading is zero; later readings are rates since the previous call", () => {
    expect(trackNetRate({ inBytes: 1000, outBytes: 1000 }, 0)).toEqual({ inKBps: 0, outKBps: 0 });
    expect(trackNetRate({ inBytes: 1000 + 2048, outBytes: 1000 + 1024 }, 1000)).toEqual({
      inKBps: 2,
      outKBps: 1,
    });
  });
});
