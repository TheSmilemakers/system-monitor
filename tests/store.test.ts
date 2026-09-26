import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendJsonl, compactJsonl, dataDir, readJson, readJsonl, writeJson } from "@/lib/store";

let dir = "";
const previous = process.env.SM_DATA_DIR;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sm-store-"));
  process.env.SM_DATA_DIR = dir;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.SM_DATA_DIR;
  else process.env.SM_DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
  test("dataDir honours the override and defaults under Application Support", () => {
    expect(dataDir()).toBe(dir);
    const saved = process.env.SM_DATA_DIR;
    delete process.env.SM_DATA_DIR;
    expect(dataDir()).toBe(
      path.join(os.homedir(), "Library", "Application Support", "system-monitor"),
    );
    process.env.SM_DATA_DIR = saved;
  });

  test("JSON round-trips and a missing file reads as null", async () => {
    expect(await readJson("nope.json")).toBeNull();
    await writeJson("doc.json", { a: 1, nested: { b: [1, 2] } });
    expect(await readJson<{ a: number; nested: { b: number[] } }>("doc.json")).toEqual({
      a: 1,
      nested: { b: [1, 2] },
    });
    // No temp file is left behind.
    const files = (await import("node:fs/promises")).readdir(dir);
    expect((await files).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("JSONL appends, reads in order, skips a torn line, and compacts", async () => {
    await appendJsonl("log.jsonl", { n: 1 });
    await appendJsonl("log.jsonl", { n: 2 });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path.join(dir, "log.jsonl"), '{"n":3', "utf8"); // torn
    expect(await readJsonl<{ n: number }>("log.jsonl")).toEqual([{ n: 1 }, { n: 2 }]);

    expect(await compactJsonl<{ n: number }>("log.jsonl", (e) => e.n > 1)).toBe(1);
    expect(await readFile(path.join(dir, "log.jsonl"), "utf8")).toBe('{"n":2}\n');
    expect(await readJsonl("missing.jsonl")).toEqual([]);
  });
});
