import { describe, expect, test } from "bun:test";

import { createSseParser, formatSseEvent } from "@/lib/sse";

describe("server-sent events wire format", () => {
  test("formatSseEvent writes one record, splitting multi-line data", () => {
    expect(formatSseEvent("stats", '{"a":1}')).toBe('event: stats\ndata: {"a":1}\n\n');
    expect(formatSseEvent("note", "one\ntwo")).toBe("event: note\ndata: one\ndata: two\n\n");
  });

  test("the parser yields complete records and rejoins multi-line data", () => {
    const feed = createSseParser();
    expect(feed('event: stats\ndata: {"a":1}\n\n')).toEqual([{ event: "stats", data: '{"a":1}' }]);
    expect(feed("event: note\ndata: one\ndata: two\n\n")).toEqual([
      { event: "note", data: "one\ntwo" },
    ]);
  });

  test("records that straddle chunks are held until their blank line", () => {
    const feed = createSseParser();
    expect(feed("event: st")).toEqual([]);
    expect(feed("ats\ndata: {")).toEqual([]);
    expect(feed('"a":1}\n')).toEqual([]);
    expect(feed("\nevent: stats\ndata: 2\n\n")).toEqual([
      { event: "stats", data: '{"a":1}' },
      { event: "stats", data: "2" },
    ]);
  });

  test("comments and id lines are ignored, CRLF is accepted, a bare data line is a message", () => {
    const feed = createSseParser();
    expect(feed(": keepalive\r\n\r\n")).toEqual([]);
    expect(feed("id: 7\r\ndata: x\r\n\r\n")).toEqual([{ event: "message", data: "x" }]);
    expect(feed("data:no-space\n\n")).toEqual([{ event: "message", data: "no-space" }]);
    // An event name with no data is not a record.
    expect(feed("event: empty\n\n")).toEqual([]);
    // Round trip.
    expect(feed(formatSseEvent("stats", "a\nb"))).toEqual([{ event: "stats", data: "a\nb" }]);
  });
});
