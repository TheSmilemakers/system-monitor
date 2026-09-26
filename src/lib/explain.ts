import kb from "@/data/process-kb.json";

import { bundleRoot } from "./process-model";
import { hasValue, probe } from "./probe";
import type { TrustState } from "./schemas";

/**
 * What a process is, in plain words. Three offline layers, tried in order:
 *
 * 1. The curated knowledge base (src/data/process-kb.json): purpose, normal
 *    behaviour, when to worry, whether it is safe to kill, what to check.
 * 2. Apple's own manual pages: this Mac ships hundreds of section-8 pages,
 *    and their NAME line and DESCRIPTION paragraph are authoritative.
 * 3. Heuristics from the path, bundle, helper naming and signature.
 *
 * Nothing leaves the machine. Results are cached per name.
 */

export type KillAdvice = "safe" | "restarts" | "avoid";

export interface Explanation {
  source: "knowledge-base" | "man-page" | "heuristic";
  /** One or two sentences: what this process is. */
  what: string;
  normal: string | null;
  worry: string | null;
  kill: KillAdvice | null;
  check: string | null;
}

export interface ExplainInput {
  name: string;
  path: string;
  trust: TrustState;
  publisher: string | null;
  bundleId: string | null;
}

interface KbEntry {
  what: string;
  normal?: string;
  worry?: string;
  kill?: KillAdvice;
  check?: string;
}

const KB: ReadonlyMap<string, KbEntry> = new Map(
  Object.entries(kb as Record<string, KbEntry | string>)
    .filter((e): e is [string, KbEntry] => typeof e[1] === "object")
    .map(([k, v]) => [k.toLowerCase(), v]),
);

export function lookupKnowledgeBase(name: string): Explanation | null {
  const entry = KB.get(name.toLowerCase());
  if (!entry) return null;
  return {
    source: "knowledge-base",
    what: entry.what,
    normal: entry.normal ?? null,
    worry: entry.worry ?? null,
    kill: entry.kill ?? null,
    check: entry.check ?? null,
  };
}

/** Undo the overstrike bold and underline that `man` emits for terminals. */
export function cleanManText(raw: string): string {
  return raw
    .replace(/(.)\x08\1/g, "$1") // X<BS>X  bold
    .replace(/_\x08(.)/g, "$1") // _<BS>X  underline
    .replace(/.\x08/g, "") // anything else overstruck
    .replace(/\r/g, "");
}

export interface ManSummary {
  /** The text after the dash on the NAME line. */
  name: string | null;
  /** The first paragraph of DESCRIPTION, wrapped lines joined. */
  description: string | null;
}

export function extractManSummary(clean: string): ManSummary {
  const lines = clean.split("\n");
  const section = (title: string): string[] => {
    const start = lines.findIndex((l) => l.trim() === title);
    if (start === -1) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (/^\S/.test(l) && l.trim().length > 0) break; // next heading
      out.push(l);
    }
    return out;
  };
  const nameLine = section("NAME").find((l) => l.trim().length > 0) ?? "";
  const dash = nameLine.match(/\s[–—-]\s+(.+)$/);
  const name = dash?.[1]?.trim() ?? null;

  const desc = section("DESCRIPTION");
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const l of desc) {
    if (l.trim().length === 0) {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else current.push(l.trim());
  }
  if (current.length) paragraphs.push(current.join(" "));
  const description = paragraphs.length ? paragraphs.slice(0, 2).join(" ").slice(0, 600) : null;
  return { name, description };
}

const manCache = new Map<string, ManSummary | null>();

async function manSummary(name: string): Promise<ManSummary | null> {
  if (!/^[A-Za-z0-9_.+-]+$/.test(name)) return null; // argv-safe already, but keep man's input plain
  if (manCache.has(name)) return manCache.get(name) ?? null;
  const where = await probe("man", ["-w", name]);
  let result: ManSummary | null = null;
  if (where.status === "ok" && where.value.length > 0) {
    const page = await probe("man", ["-P", "cat", name]);
    if (hasValue(page)) {
      const summary = extractManSummary(cleanManText(page.value));
      if (summary.description || summary.name) result = summary;
    }
  }
  manCache.set(name, result);
  return result;
}

export function heuristicExplanation(input: ExplainInput): Explanation {
  const { name, path, trust, publisher } = input;
  const root = bundleRoot(path);
  const app = root ? (root.split("/").pop() ?? "").replace(/\.app$/, "") : null;
  const helper = name.match(/^(.+?) Helper(?: \((Renderer|GPU|Plugin|Network|Utility)\))?$/);

  let what: string;
  let kill: KillAdvice | null = null;
  if (helper) {
    const kind = helper[2] ?? "helper";
    const owner = app ?? helper[1];
    what =
      kind === "Renderer"
        ? `A sandboxed renderer of ${owner}: it hosts web content for one window or tab. Chromium-based apps run several of these.`
        : `A ${kind.toLowerCase()} process of ${owner}, a Chromium-based app.`;
    kill = "safe";
  } else if (app && app !== name) {
    what = `Part of the ${app} app.`;
  } else if (app) {
    what = `The ${app} app.`;
    kill = "safe";
  } else if (trust === "apple") {
    what = "A macOS system process signed by Apple. No description is available for it.";
  } else if (publisher) {
    what = `Third-party software signed by ${publisher}. No description is available for it.`;
  } else {
    what = "No description is available for this process.";
  }
  return { source: "heuristic", what, normal: null, worry: null, kill, check: null };
}

export async function explainProcess(input: ExplainInput): Promise<Explanation> {
  const fromKb = lookupKnowledgeBase(input.name);
  if (fromKb) return fromKb;

  const man = await manSummary(input.name);
  if (man) {
    const what = [man.name ? `${input.name}: ${man.name}.` : null, man.description]
      .filter(Boolean)
      .join(" ");
    return { source: "man-page", what, normal: null, worry: null, kill: null, check: null };
  }

  return heuristicExplanation(input);
}

/** Test seam. */
export function __resetExplainCache(): void {
  manCache.clear();
}
