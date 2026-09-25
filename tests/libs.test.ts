import { afterEach, describe, expect, test } from "bun:test";

import { formatBytes, formatDuration } from "@/lib/format";
import { mapLimit } from "@/lib/pool";
import { __resetResolveCache, remoteAddressOf, resolveAll, resolveHost } from "@/lib/resolve-host";

/** The small libraries that had no tests at all. */

describe("mapLimit", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("never runs more than `limit` workers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapLimit(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(10);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  test("returns results in input order even when they finish out of order", async () => {
    const delays = [30, 5, 20, 1];
    const out = await mapLimit(delays, 2, async (d, i) => {
      await sleep(d);
      return `${i}:${d}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  test("copes with a limit larger than the input and with empty input", async () => {
    expect(await mapLimit([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapLimit([], 3, async (n) => n)).toEqual([]);
  });

  test("a limit below one still makes progress", async () => {
    expect(await mapLimit([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
  });

  test("a rejected item rejects the whole map", async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("formatBytes", () => {
  test("picks the unit by magnitude", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(40960 * 1024)).toBe("40 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  test("never produces NaN or a negative size", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  test("seconds, then minutes with a remainder", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(461)).toBe("7m 41s");
  });

  test("rounds and rejects nonsense", () => {
    expect(formatDuration(59.6)).toBe("1m");
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("resolve-host", () => {
  afterEach(() => __resetResolveCache());

  test("remoteAddressOf extracts the peer from an lsof NAME column", () => {
    expect(remoteAddressOf("192.168.1.5:50000->10.0.0.9:443")).toBe("10.0.0.9");
    expect(remoteAddressOf("[fe80::1]:50000->[2606:4700::1111]:443")).toBe("2606:4700::1111");
    expect(remoteAddressOf("*:49152")).toBeNull();
    expect(remoteAddressOf("192.168.1.5:50000->")).toBeNull();
  });

  test("private and loopback addresses are attributed locally without DNS", async () => {
    for (const ip of [
      "10.1.2.3",
      "192.168.0.1",
      "172.16.5.5",
      "172.31.0.1",
      "127.0.0.1",
      "::1",
      "fe80::1",
      "169.254.1.1",
    ]) {
      expect(await resolveHost(ip)).toEqual({ status: "resolved", hostnames: ["<local network>"] });
    }
  });

  test("an address that cannot be reversed is unknown, never clean", async () => {
    expect(await resolveHost("999.999.1.1")).toEqual({ status: "unknown" });
  });

  test("results are cached for the TTL and expire afterwards", async () => {
    const t0 = 1_000_000;
    const first = await resolveHost("999.999.1.1", t0);
    expect(first.status).toBe("unknown");
    // Within the TTL the cached value is returned; 172.32.x is not private, so a miss would hit DNS.
    const cached = await resolveHost("999.999.1.1", t0 + 1000);
    expect(cached).toBe(first);
    const expired = await resolveHost("999.999.1.1", t0 + 5 * 60 * 1000 + 1);
    expect(expired).not.toBe(first);
    expect(expired.status).toBe("unknown");
  });

  test("resolveAll de-duplicates and keys by address", async () => {
    const out = await resolveAll(["10.0.0.9", "10.0.0.9", "192.168.1.1", "999.999.1.1"]);
    expect(out.size).toBe(3);
    expect(out.get("10.0.0.9")?.status).toBe("resolved");
    expect(out.get("999.999.1.1")?.status).toBe("unknown");
  });
});
