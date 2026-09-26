import { describe, expect, test } from "bun:test";

import { canonicalDestination, ownerOf } from "@/lib/destinations";
import { KNOWN_PORTS } from "@/lib/posture";
import { parsePsDetailed } from "@/lib/sampler";

describe("canonicalDestination", () => {
  test("content networks and clouds fold to their owner's pattern", () => {
    expect(
      canonicalDestination(
        "g2a02-26f0-fd00-1800-0000-0000-0215-409c.deploy.static.akamaitechnologies.com",
      ),
    ).toEqual({ key: "*.akamaitechnologies.com", owner: "Akamai CDN" });
    expect(canonicalDestination("uklon6-vip-bx-003.b.aaplimg.com")).toEqual({
      key: "*.aaplimg.com",
      owner: "Apple CDN",
    });
    expect(canonicalDestination("p59-content.icloud.com")).toEqual({
      key: "*.icloud.com",
      owner: "Apple iCloud",
    });
    expect(canonicalDestination("ec2-108-128-193-124.eu-west-1.compute.amazonaws.com")).toEqual({
      key: "*.amazonaws.com",
      owner: "Amazon Web Services",
    });
    expect(canonicalDestination("lb-140-82-112-22-iad.github.com")).toEqual({
      key: "*.github.com",
      owner: "GitHub",
    });
    expect(canonicalDestination("wh-in-f207.1e100.net").owner).toBe("Google");
  });

  test("an unknown host stays itself, lower-cased and without a trailing dot", () => {
    expect(canonicalDestination("Evil.Example.NET.")).toEqual({
      key: "evil.example.net",
      owner: null,
    });
    expect(canonicalDestination("")).toEqual({ key: "", owner: null });
  });

  test("bare addresses fold to their block; private ones are kept; known blocks name an owner", () => {
    expect(canonicalDestination("999.999.1.1")).toEqual({ key: "999.999.1.0/24", owner: null });
    expect(canonicalDestination("17.137.184.130")).toEqual({
      key: "17.137.184.0/24",
      owner: "Apple",
    });
    expect(canonicalDestination("2603:1061:14:d5::1")).toEqual({
      key: "2603:1061:14::/48",
      owner: "Microsoft",
    });
    expect(canonicalDestination("2a04:4e42:4f::762")).toEqual({
      key: "2a04:4e42:4f::/48",
      owner: "Fastly CDN",
    });
    expect(canonicalDestination("10.0.0.9")).toEqual({ key: "10.0.0.9", owner: null });
    expect(canonicalDestination("fe80::1")).toEqual({ key: "fe80::1", owner: null });
  });

  test("a key fed back in is stable, and ownerOf answers for keys and hosts alike", () => {
    for (const h of ["*.aaplimg.com", "2603:1061:14::/48", "999.999.1.0/24", "evil.example.net"]) {
      expect(canonicalDestination(h).key).toBe(h);
    }
    expect(ownerOf("*.aaplimg.com")).toBe("Apple CDN");
    expect(ownerOf("2603:1061:14::/48")).toBe("Microsoft");
    expect(ownerOf("999.999.1.0/24")).toBeNull();
    expect(ownerOf("gateway.icloud.com")).toBe("Apple iCloud");
  });
});

describe("known ports and parenthesised names", () => {
  test("common listeners have a name", () => {
    expect(KNOWN_PORTS[11434]).toBe("Ollama");
    expect(KNOWN_PORTS[57621]).toBe("Spotify Connect");
    expect(KNOWN_PORTS[443]).toBe("HTTPS server");
  });

  test("a name ps wrapped in parentheses is kept as a name, with no path to trust", () => {
    const [p] = parsePsDetailed("rajan 99643 900 13.5 0.6 95000 00:05 (Google Chrome He)");
    expect(p?.command).toBe("Google Chrome He");
    expect(p?.path).toBe("Google Chrome He");
    expect(p?.trust).toBe("unknown");
  });
});
