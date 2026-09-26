import os from "node:os";
import path from "node:path";

import { identityFor, type TrustState } from "./identity";
import { loadBaseline } from "./monitor";
import { mapLimit } from "./pool";
import { hasValue, isOk, probe, type ProbeStatus } from "./probe";

/**
 * The Persistence view: everything that starts on its own. Launch agents and
 * daemons are read from their plists (Label, what they run, when), the
 * program's signature is looked up, and items absent from the monitor's
 * baseline are flagged. Login items and configuration profiles are reported
 * where the tools allow it without root.
 */

export interface LaunchItem {
  file: string;
  scope: "user" | "system-agent" | "system-daemon";
  label: string;
  program: string | null;
  runAtLoad: boolean;
  keepAlive: boolean;
  trust: TrustState;
  publisher: string | null;
  knownVendor: boolean;
  newSinceBaseline: boolean;
  changedSinceBaseline: boolean;
}

export interface PersistenceReport {
  items: LaunchItem[];
  profiles: string[] | null;
  unavailable: { check: string; reason: ProbeStatus }[];
  timestamp: number;
}

const KNOWN_VENDORS = [
  "com.apple.",
  "com.google.",
  "com.microsoft.",
  "com.docker.",
  "com.spotify.",
];
const PARSE_CONCURRENCY = 6;

interface PlistFields {
  label: string | null;
  program: string | null;
  runAtLoad: boolean;
  keepAlive: boolean;
}

/** Fields from `plutil -convert json -o - file` output. */
export function parsePlistJson(json: string): PlistFields | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const label = typeof obj.Label === "string" ? obj.Label : null;
  let program: string | null = typeof obj.Program === "string" ? obj.Program : null;
  if (
    !program &&
    Array.isArray(obj.ProgramArguments) &&
    typeof obj.ProgramArguments[0] === "string"
  ) {
    program = obj.ProgramArguments[0];
  }
  const keepAlive =
    obj.KeepAlive === true || (typeof obj.KeepAlive === "object" && obj.KeepAlive !== null);
  return { label, program, runAtLoad: obj.RunAtLoad === true, keepAlive };
}

/** Fallback for plists JSON cannot express (dates, data): the XML form. */
export function parsePlistXml(xml: string): PlistFields | null {
  if (!xml.includes("<plist")) return null;
  const str = (key: string): string | null => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
    return m ? m[1] : null;
  };
  const bool = (key: string): boolean => new RegExp(`<key>${key}</key>\\s*<true/>`).test(xml);
  let program = str("Program");
  if (!program) {
    const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(xml);
    program = m ? m[1] : null;
  }
  return {
    label: str("Label"),
    program,
    runAtLoad: bool("RunAtLoad"),
    keepAlive: bool("KeepAlive") || /<key>KeepAlive<\/key>\s*<dict>/.test(xml),
  };
}

function dirs(): { dir: string; scope: LaunchItem["scope"] }[] {
  return [
    { dir: path.join(os.homedir(), "Library/LaunchAgents"), scope: "user" },
    { dir: "/Library/LaunchAgents", scope: "system-agent" },
    { dir: "/Library/LaunchDaemons", scope: "system-daemon" },
  ];
}

export const PERSISTENCE_TTL_MS = 60_000;
let reportCache: { at: number; report: PersistenceReport } | null = null;
let reportInFlight: Promise<PersistenceReport> | null = null;

/** The report, at most once a minute, for callers that only need a lookup. */
export async function cachedPersistenceReport(now = Date.now()): Promise<PersistenceReport> {
  if (reportCache && now - reportCache.at < PERSISTENCE_TTL_MS) return reportCache.report;
  if (reportInFlight) return reportInFlight;
  reportInFlight = persistenceReport(now)
    .then((report) => {
      reportCache = { at: now, report };
      return report;
    })
    .finally(() => {
      reportInFlight = null;
    });
  return reportInFlight;
}

/** Test seam. */
export function __resetPersistenceCache(): void {
  reportCache = null;
  reportInFlight = null;
}

export async function persistenceReport(now = Date.now()): Promise<PersistenceReport> {
  const unavailable: PersistenceReport["unavailable"] = [];
  const baseline = await loadBaseline();
  const baselineHashes = baseline?.snapshot.persistence ?? {};

  const files: { file: string; scope: LaunchItem["scope"] }[] = [];
  for (const { dir, scope } of dirs()) {
    const ls = await probe("ls", [dir]);
    if (!isOk(ls)) {
      if (ls.status !== "failed") unavailable.push({ check: `${dir} listing`, reason: ls.status });
      continue;
    }
    for (const f of ls.value.split("\n")) {
      if (f.endsWith(".plist")) files.push({ file: path.join(dir, f), scope });
    }
  }

  // Current hashes, one shasum call per directory, to flag changed items.
  const hashes: Record<string, string> = {};
  for (const { dir } of dirs()) {
    const batch = files.filter((f) => f.file.startsWith(`${dir}/`)).map((f) => f.file);
    if (batch.length === 0) continue;
    const sums = await probe("shasum", ["-a", "256", ...batch], 15_000);
    if (!hasValue(sums)) continue;
    for (const line of sums.value.split("\n")) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m) hashes[m[2]] = m[1];
    }
  }

  const items = await mapLimit(
    files,
    PARSE_CONCURRENCY,
    async ({ file, scope }): Promise<LaunchItem> => {
      const json = await probe("plutil", ["-convert", "json", "-r", "-o", "-", file]);
      let fields = hasValue(json) ? parsePlistJson(json.value) : null;
      if (!fields) {
        const xml = await probe("plutil", ["-convert", "xml1", "-o", "-", file]);
        fields = hasValue(xml) ? parsePlistXml(xml.value) : null;
      }
      const name = path.basename(file, ".plist");
      const program = fields?.program ?? null;
      const id = program && program.startsWith("/") ? identityFor(program) : null;
      const inBaseline = file in baselineHashes;
      return {
        file,
        scope,
        label: fields?.label ?? name,
        program,
        runAtLoad: fields?.runAtLoad ?? false,
        keepAlive: fields?.keepAlive ?? false,
        trust: id?.trust ?? "unknown",
        publisher: id?.publisher ?? null,
        knownVendor: KNOWN_VENDORS.some((v) => name.startsWith(v)),
        newSinceBaseline: baseline !== null && !inBaseline,
        changedSinceBaseline:
          inBaseline && hashes[file] !== undefined && hashes[file] !== baselineHashes[file],
      };
    },
  );

  let profiles: string[] | null = null;
  const prof = await probe("profiles", ["list"]);
  if (isOk(prof)) {
    profiles = prof.value
      .split("\n")
      .filter((l) => /attribute: name:/.test(l))
      .map((l) => l.replace(/.*attribute: name:\s*/, "").trim());
  } else if (prof.status !== "failed") {
    unavailable.push({ check: "configuration profiles", reason: prof.status });
  }

  const order: Record<LaunchItem["scope"], number> = {
    user: 0,
    "system-agent": 1,
    "system-daemon": 2,
  };
  items.sort((a, b) => order[a.scope] - order[b.scope] || a.label.localeCompare(b.label));

  return { items, profiles, unavailable, timestamp: now };
}
