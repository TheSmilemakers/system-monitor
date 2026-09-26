import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GET as getExplain } from "@/app/api/explain/route";
import {
  __resetExplainCache,
  cleanManText,
  explainProcess,
  extractManSummary,
  heuristicExplanation,
  lookupKnowledgeBase,
  type ExplainInput,
} from "@/lib/explain";
import { parseExplanation } from "@/lib/schemas";

import {
  MAN_FILEPROVIDERD,
  installFakeProbe,
  installHeaders,
  installLoopbackHeaders,
  resetSeams,
} from "./fixtures";

const input = (over: Partial<ExplainInput>): ExplainInput => ({
  name: "x",
  path: "/usr/bin/x",
  trust: "unknown",
  publisher: null,
  bundleId: null,
  ...over,
});

describe("knowledge base", () => {
  test("matches by basename, case-insensitively, with every field", () => {
    const e = lookupKnowledgeBase("WindowServer");
    expect(e?.source).toBe("knowledge-base");
    expect(e?.what).toContain("Composites every window");
    expect(e?.kill).toBe("avoid");
    expect(lookupKnowledgeBase("windowserver")?.what).toBe(e?.what);
    expect(lookupKnowledgeBase("Google Chrome Helper (Renderer)")?.kill).toBe("safe");
    expect(lookupKnowledgeBase("definitely-not-a-process")).toBeNull();
  });

  test("every entry has a what, and kill advice is one of the three values", async () => {
    const kb = (await import("@/data/process-kb.json")).default as Record<string, unknown>;
    const entries = Object.entries(kb).filter(([k]) => k !== "$comment");
    expect(entries.length).toBeGreaterThanOrEqual(500);
    for (const [name, v] of entries) {
      const entry = v as { what?: string; kill?: string };
      expect(typeof entry.what, name).toBe("string");
      expect(["safe", "restarts", "avoid", undefined], name).toContain(entry.kill);
    }
  });
});

describe("man pages", () => {
  test("cleanManText removes overstrike bold and underline", () => {
    expect(cleanManText("N\bNA\bAM\bME\bE")).toBe("NAME");
    expect(cleanManText("_\bx_\by")).toBe("xy");
    expect(cleanManText("plain\r\n")).toBe("plain\n");
  });

  test("extractManSummary takes the NAME line and the first DESCRIPTION paragraphs", () => {
    const s = extractManSummary(cleanManText(MAN_FILEPROVIDERD));
    expect(s.name).toBe("Part of File Coordination");
    expect(s.description).toBe(
      "fileproviderd is the daemon controlling the interaction between extensions and filecoordinationd. It is also responsible for coordinating enumeration and property lookup. There are no configuration options to fileproviderd, and users should not run fileproviderd manually.",
    );
    expect(extractManSummary("nothing here")).toEqual({ name: null, description: null });
  });
});

describe("heuristics", () => {
  test("Chromium helpers, app bundles, Apple and third-party fallbacks", () => {
    expect(
      heuristicExplanation(
        input({
          name: "Slack Helper (Renderer)",
          path: "/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)",
        }),
      ),
    ).toMatchObject({
      source: "heuristic",
      kill: "safe",
      what: expect.stringContaining("renderer of Slack"),
    });
    expect(
      heuristicExplanation(
        input({ name: "Slack", path: "/Applications/Slack.app/Contents/MacOS/Slack" }),
      ).what,
    ).toBe("The Slack app.");
    expect(
      heuristicExplanation(
        input({ name: "helper-x", path: "/Applications/Foo.app/Contents/Helpers/helper-x" }),
      ).what,
    ).toBe("Part of the Foo app.");
    expect(heuristicExplanation(input({ name: "odd", trust: "apple" })).what).toContain(
      "signed by Apple",
    );
    expect(heuristicExplanation(input({ name: "odd", publisher: "Acme" })).what).toContain(
      "signed by Acme",
    );
    expect(heuristicExplanation(input({ name: "odd" })).what).toBe(
      "No description is available for this process.",
    );
  });
});

describe("explainProcess", () => {
  beforeEach(() => {
    __resetExplainCache();
    installFakeProbe();
  });
  afterEach(() => {
    resetSeams();
    __resetExplainCache();
  });

  test("knowledge base first, then the man page, then heuristics", async () => {
    expect((await explainProcess(input({ name: "WindowServer" }))).source).toBe("knowledge-base");

    // fileproviderd is in the knowledge base; use a name only the fake man knows about.
    const viaMan = await explainProcess(input({ name: "fileproviderd-x" }));
    expect(viaMan.source).toBe("heuristic"); // no page for that name

    installFakeProbe({
      man: (args) =>
        args[0] === "-w"
          ? { status: "ok", value: "/usr/share/man/man8/x.8" }
          : { status: "ok", value: MAN_FILEPROVIDERD },
    });
    __resetExplainCache();
    const page = await explainProcess(input({ name: "somedaemon" }));
    expect(page.source).toBe("man-page");
    expect(page.what).toContain("somedaemon: Part of File Coordination.");
    expect(page.what).toContain("is the daemon controlling");
  });

  test("man is asked once per name", async () => {
    let calls = 0;
    installFakeProbe({
      man: () => {
        calls++;
        return { status: "failed", error: "No manual entry" };
      },
    });
    await explainProcess(input({ name: "nope" }));
    await explainProcess(input({ name: "nope" }));
    expect(calls).toBe(1);
  });

  test("names that are not argv-plain never reach man", async () => {
    let calls = 0;
    installFakeProbe({
      man: () => {
        calls++;
        return { status: "ok", value: "" };
      },
    });
    await explainProcess(input({ name: "Google Chrome Helper (GPU) x" }));
    expect(calls).toBe(0);
  });
});

describe("GET /api/explain", () => {
  beforeEach(() => {
    __resetExplainCache();
    installFakeProbe();
    installLoopbackHeaders();
  });
  afterEach(() => {
    resetSeams();
    __resetExplainCache();
  });

  const req = (query: string) => new Request(`http://127.0.0.1:3000/api/explain?${query}`);

  test("refuses a forged Host and requires a name", async () => {
    installHeaders({ host: "evil.example.com" });
    expect((await getExplain(req("name=x"))).status).toBe(403);
    installLoopbackHeaders();
    expect((await getExplain(req(""))).status).toBe(400);
  });

  test("serves a body that satisfies the contract", async () => {
    const res = await getExplain(
      req("name=WindowServer&path=%2FSystem%2Fx&trust=apple&publisher=Apple"),
    );
    expect(res.status).toBe(200);
    const e = parseExplanation(await res.json());
    expect(e.source).toBe("knowledge-base");
    expect(e.kill).toBe("avoid");
  });

  test("an unknown trust value is treated as unknown, and long inputs are capped", async () => {
    const res = await getExplain(req(`name=${"a".repeat(2000)}&trust=hacker`));
    expect(res.status).toBe(200);
    const e = parseExplanation(await res.json());
    expect(e.source).toBe("heuristic");
  });
});
