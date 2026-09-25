import { describe, expect, test } from "bun:test";

import { parsePsAux, parseVmStat } from "@/lib/sampler";
import { remoteAddressOf } from "@/lib/resolve-host";

const PS_HEADER =
  "USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND";

const PS_FIXTURE = [
  PS_HEADER,
  "rajan            43830  92.4  3.1 41234567 512000   ??  R     9:41AM   1:02.33 /Applications/Foo.app/Contents/MacOS/Foo --flag",
  "rajan             1234   5.0  1.0  4123456 128000   ??  S    Wed11AM   0:10.00 /usr/bin/some-daemon",
  "root                88   0.0  0.1  1234567   4096   ??  Ss   28Jul25   0:00.01 /usr/libexec/tiny",
].join("\n");

describe("ps aux parsing", () => {
  test("skips the header and parses rows", () => {
    const rows = parsePsAux(PS_FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[0].pid).toBe(43830);
    expect(rows[0].user).toBe("rajan");
    expect(rows[0].cpu).toBeCloseTo(92.4);
  });

  test("orders by CPU descending", () => {
    const rows = parsePsAux(PS_FIXTURE);
    expect(rows[0].cpu).toBeGreaterThanOrEqual(rows[1].cpu);
    expect(rows[1].cpu).toBeGreaterThanOrEqual(rows[2].cpu);
  });

  test("converts RSS from KB to bytes", () => {
    const rows = parsePsAux(PS_FIXTURE);
    expect(rows[0].rss).toBe(512000 * 1024);
  });

  test("derives a readable command name", () => {
    const rows = parsePsAux(PS_FIXTURE);
    expect(rows[0].command).toBe("Foo");
  });

  test("respects the row limit", () => {
    expect(parsePsAux(PS_FIXTURE, 2)).toHaveLength(2);
  });

  test("handles empty and malformed input without throwing", () => {
    expect(parsePsAux("")).toEqual([]);
    expect(parsePsAux(PS_HEADER)).toEqual([]);
    expect(parsePsAux("garbage\nnot a ps line at all")).toEqual([]);
  });

  test("never emits a non-finite metric", () => {
    const rows = parsePsAux([PS_HEADER, "u ? ? ? ? ? ? ? ? ? cmd"].join("\n"));
    for (const r of rows) {
      expect(Number.isFinite(r.cpu)).toBe(true);
      expect(Number.isFinite(r.mem)).toBe(true);
      expect(Number.isFinite(r.rss)).toBe(true);
    }
  });

  test("tolerates leading whitespace on a row", () => {
    const rows = parsePsAux(
      [PS_HEADER, "  rajan  777  1.0  0.5  100  200  ??  S  9:00AM  0:01.00 /bin/thing"].join("\n"),
    );
    expect(rows[0]?.pid).toBe(777);
  });
});

const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              123456.
Pages active:                            234567.
Pages inactive:                          345678.
Pages speculative:                        45678.
Pages wired down:                        456789.
Pages occupied by compressor:            567890.`;

describe("vm_stat parsing", () => {
  test("extracts labelled page buckets", () => {
    expect(parseVmStat(VM_STAT_FIXTURE, "Pages active")).toBe(234567);
    expect(parseVmStat(VM_STAT_FIXTURE, "Pages wired down")).toBe(456789);
    expect(parseVmStat(VM_STAT_FIXTURE, "Pages occupied by compressor")).toBe(567890);
  });

  test("returns 0 for an absent or malformed bucket", () => {
    expect(parseVmStat(VM_STAT_FIXTURE, "Pages nonexistent")).toBe(0);
    expect(parseVmStat("", "Pages active")).toBe(0);
  });
});

describe("H-04 — lsof remote address extraction", () => {
  test("extracts the remote IPv4 address", () => {
    expect(remoteAddressOf("192.168.1.48:50070->142.250.72.14:443")).toBe("142.250.72.14");
  });

  test("extracts a bracketed IPv6 remote address", () => {
    expect(remoteAddressOf("[::1]:1234->[2606:2800:220:1:248:1893:25c8:1946]:443")).toBe(
      "2606:2800:220:1:248:1893:25c8:1946",
    );
  });

  test("returns null for a listening socket with no peer", () => {
    expect(remoteAddressOf("*:3000")).toBeNull();
    expect(remoteAddressOf("127.0.0.1:3000")).toBeNull();
    expect(remoteAddressOf("")).toBeNull();
  });

  test("documents the original defect: numeric output carries no hostname", () => {
    // `lsof -nP` emits addresses, so matching domain substrings against the
    // raw NAME column could never fire — the detector needed resolution.
    const name = "192.168.1.48:50070->142.250.72.14:443";
    expect(name.includes("google")).toBe(false);
    expect(remoteAddressOf(name)).toBe("142.250.72.14");
  });
});
