import { describe, expect, test } from "bun:test";

import { isAllowedOrigin, isLoopbackHost } from "@/lib/guard";

describe("H-01 — loopback host enforcement", () => {
  test("accepts loopback hosts on any port", () => {
    for (const h of [
      "localhost:3000",
      "localhost",
      "127.0.0.1:3000",
      "127.0.0.1",
      "127.0.0.1:8080",
      "[::1]:3000",
      "[::1]",
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  test("rejects LAN and public hosts", () => {
    for (const h of [
      "192.168.1.48:3000",
      "10.0.0.5:3000",
      "monitor.example.com",
      "evil.test:3000",
      "0.0.0.0:3000",
      "[fe80::1]:3000",
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  test("rejects an absent Host header", () => {
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });

  test("is not fooled by a loopback-looking prefix or suffix", () => {
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
  });
});

describe("H-01 — origin enforcement", () => {
  test("permits absent origin (same-origin GET / direct navigation)", () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  test("permits loopback origins", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  test("rejects cross-origin callers", () => {
    expect(isAllowedOrigin("http://evil.test")).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.10:3000")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});
