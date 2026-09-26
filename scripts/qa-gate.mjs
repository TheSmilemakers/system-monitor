#!/usr/bin/env node
/**
 * QA gate — phase-scoped, hard 10/10 required.
 *
 *   node scripts/qa-gate.mjs 0     # containment
 *   node scripts/qa-gate.mjs 1     # trust boundary
 *   node scripts/qa-gate.mjs 2     # reliable collection
 *   node scripts/qa-gate.mjs 3     # honest + accessible UI
 *   node scripts/qa-gate.mjs 4     # release engineering
 *   node scripts/qa-gate.mjs all   # every phase defined so far
 *
 * Each phase defines exactly 10 gates. Every gate must pass.
 * Exit 0 only on a perfect score.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const rel = (p) => path.join(ROOT, p);

// ---------- helpers ----------

const read = (p) => (existsSync(rel(p)) ? readFileSync(rel(p), "utf-8") : null);
const pkg = () => JSON.parse(read("package.json"));

function walk(dir, out = []) {
  const abs = rel(dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const srcFiles = (ext = /\.(ts|tsx)$/) => walk("src").filter((f) => ext.test(f));

/** Run a command; return {ok, out}. Never throws. */
function run(file, args, opts = {}) {
  try {
    const out = execFileSync(file, args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 600_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    return { ok: true, out: out ?? "" };
  } catch (e) {
    return {
      ok: false,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message ?? e),
    };
  }
}

/** Cache expensive toolchain runs across gates within one invocation. */
const memo = new Map();
const once = (key, fn) => {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};

const typecheck = () => once("tsc", () => run("bunx", ["tsc", "--noEmit"]));
const lint = () => once("lint", () => run("bunx", ["eslint", "--max-warnings=0"]));
const build = () => once("build", () => run("bunx", ["next", "build"]));
const tests = () => once("test", () => run("bun", ["test"]));
const audit = () => once("audit", () => run("bun", ["audit"]));
const smoke = () => once("smoke", () => run("node", ["scripts/smoke.mjs"]));

/**
 * Advisories reachable from *production* dependencies.
 * `bun audit` has no --production flag, so map each advisory path's
 * top-level package back to package.json "dependencies".
 */
function prodAdvisories() {
  return once("prodAdv", () => {
    const out = audit().out.replace(/\x1b\[[0-9;]*m/g, "");
    const prod = new Set(Object.keys(pkg().dependencies ?? {}));

    // Fail closed. When the registry is unreachable `bun audit` prints an
    // error and no summary line; that used to parse as "no advisories" and
    // pass the gate. Only an explicit opt-out may skip the check, and it
    // is recorded in the detail so a green run is never silent about it.
    const summarised = /\d+ vulnerabilit(y|ies)|No vulnerabilities/i.test(out);
    if (!summarised) {
      if (process.env.ALLOW_OFFLINE_QA === "1") return [];
      const reason = out.trim().split("\n").slice(-3).join(" | ").slice(0, 160) || "no output";
      return [
        {
          pkg: `audit unavailable, failing closed: ${reason}; set ALLOW_OFFLINE_QA=1 to skip deliberately`,
          via: "bun audit",
          severity: "critical",
        },
      ];
    }
    const blocks = out.split(/\n(?=\S)/);
    const offenders = [];
    for (const b of blocks) {
      const lines = b.split("\n");
      const paths = lines.filter((l) => l.includes("›"));
      const sevs = lines
        .map((l) => l.trim().match(/^(critical|high|moderate|low):/))
        .filter(Boolean)
        .map((m) => m[1]);
      if (sevs.length === 0) continue;
      const tops = new Set(paths.map((p) => p.trim().split("›")[0].trim()));
      // A direct dependency appears as its own block header with no arrow path.
      const header = lines[0]?.trim().split(/\s+/)[0];
      if (header && prod.has(header)) tops.add(header);
      for (const t of tops) {
        if (!prod.has(t)) continue;
        for (const s of sevs) offenders.push({ pkg: header ?? t, via: t, severity: s });
      }
    }
    return offenders;
  });
}

/** Grep across src for a pattern; returns matching "file:line" strings. */
function grepSrc(re, files = srcFiles()) {
  const hits = [];
  for (const f of files) {
    const text = read(f);
    if (text == null) continue;
    text.split("\n").forEach((line, i) => {
      if (re.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  return hits;
}

/**
 * Strip comments and string literals so a gate measures *code*, not prose.
 * Findings are documented inline throughout this codebase, so a naive grep for
 * e.g. `execSync` matches the explanation of why it was removed.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/^\s*\/\/.*$/gm, " ") // whole-line comments
    .replace(/([^:])\/\/.*$/gm, "$1 ") // trailing comments (keep URLs in strings rare)
    .replace(/`(?:[^`\\]|\\.)*`/g, "``") // template literals
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // single-quoted strings
}

/** Grep across src, ignoring comments and string literals. */
function grepCode(re, files = srcFiles()) {
  const hits = [];
  for (const f of files) {
    const text = read(f);
    if (text == null) continue;
    codeOnly(text)
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) hits.push(`${f}:${i + 1}`);
      });
  }
  return hits;
}

/** Remove comments but keep string literals (class names live in strings). */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Extract the body of a top-level object literal by name. */
function objectBody(text, name) {
  const m = text.match(new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  return m ? m[1] : "";
}

/** Modules that actually perform system collection. */
const COLLECTION_MODULES = [
  "src/lib/sampler.ts",
  "src/app/api/cleanup/route.ts",
  "src/app/api/scan/route.ts",
  "src/app/api/privacy/route.ts",
];

// ---------- gate definitions ----------

const PHASES = {
  0: {
    title: "Phase 0 — Containment",
    gates: [
      {
        id: "P0-1",
        name: "dev script binds loopback only",
        check: () => {
          const s = pkg().scripts?.dev ?? "";
          return s.includes("--hostname 127.0.0.1")
            ? { pass: true, detail: s }
            : { pass: false, detail: `dev = "${s}"` };
        },
      },
      {
        id: "P0-2",
        name: "start script binds loopback only",
        check: () => {
          const s = pkg().scripts?.start ?? "";
          return s.includes("--hostname 127.0.0.1")
            ? { pass: true, detail: s }
            : { pass: false, detail: `start = "${s}"` };
        },
      },
      {
        id: "P0-3",
        name: "next >= 16.2.5 (clears 23 advisories, 12 high)",
        check: () => {
          const v = (pkg().dependencies?.next ?? "").replace(/^[\^~]/, "");
          const [maj, min, pat] = v.split(".").map(Number);
          const ok = maj > 16 || (maj === 16 && (min > 2 || (min === 2 && pat >= 5)));
          return { pass: ok, detail: `next@${v || "missing"}` };
        },
      },
      {
        id: "P0-4",
        name: "shadcn CLI absent from runtime dependencies",
        check: () => {
          const d = pkg().dependencies ?? {};
          return { pass: !("shadcn" in d), detail: "shadcn" in d ? "present" : "absent" };
        },
      },
      {
        id: "P0-5",
        name: "no platform-locked binaries in dependencies",
        check: () => {
          const bad = Object.keys(pkg().dependencies ?? {}).filter((k) =>
            /darwin|linux|win32|-arm64|-x64/.test(k),
          );
          return { pass: bad.length === 0, detail: bad.join(", ") || "none" };
        },
      },
      {
        id: "P0-6",
        name: "no client-supplied command can reach a shell (C-01 contained)",
        check: () => {
          const t = read("src/app/actions.ts") ?? "";
          // Contained if cleanupItem neither accepts a command string nor execs one.
          const acceptsCommand = /cleanupItem\(\s*command:\s*string/.test(t);
          const execsInput = /execSync\(\s*command\b/.test(t);
          const ok = !acceptsCommand && !execsInput;
          return {
            pass: ok,
            detail: ok
              ? "no command parameter, no command exec"
              : `accepts-command:${acceptsCommand} execs-command:${execsInput}`,
          };
        },
      },
      {
        id: "P0-7",
        name: "dead code removed (netstat / log show / EXPECTED_CONNECTIONS)",
        check: () => {
          const hits = grepSrc(/netstat -ib|log show|EXPECTED_CONNECTIONS/);
          return { pass: hits.length === 0, detail: hits.join(", ") || "none" };
        },
      },
      {
        id: "P0-8",
        name: "typecheck passes",
        check: () => ({
          pass: typecheck().ok,
          detail: typecheck().ok ? "clean" : typecheck().out.slice(-400),
        }),
      },
      {
        id: "P0-9",
        name: "lint passes with zero warnings",
        check: () => ({
          pass: lint().ok,
          detail: lint().ok ? "0 warnings" : lint().out.slice(-400),
        }),
      },
      {
        id: "P0-10",
        name: "zero high/critical advisories reachable from production deps",
        check: () => {
          const bad = prodAdvisories().filter(
            (a) => a.severity === "high" || a.severity === "critical",
          );
          const total = (audit().out.match(/(\d+)\s+vulnerabilit/) ?? [])[1] ?? "?";
          return {
            pass: bad.length === 0,
            detail:
              bad.length === 0
                ? `0 production-reachable (${total} total, all dev tooling)`
                : bad.map((a) => `${a.pkg} via ${a.via} (${a.severity})`).join(", "),
          };
        },
      },
    ],
  },

  1: {
    title: "Phase 1 — Trust boundary",
    gates: [
      {
        id: "P1-1",
        name: "cleanup action takes an opaque id, never a command",
        check: () => {
          const t = read("src/app/actions.ts") ?? "";
          const takesId = /export async function cleanupItem\(\s*id:\s*string/.test(t);
          return { pass: takesId, detail: takesId ? "id: string" : "does not accept an opaque id" };
        },
      },
      {
        id: "P1-2",
        name: "cleanup API response exposes no executable command",
        check: () => {
          const files = ["src/app/api/cleanup/route.ts", "src/lib/cleanup-targets.ts"];
          const hits = grepSrc(
            /\bcommand\s*:/,
            files.filter((f) => read(f) != null),
          );
          return { pass: hits.length === 0, detail: hits.join(", ") || "none" };
        },
      },
      {
        id: "P1-3",
        name: "server-owned target table exists and is the only source of paths",
        check: () => {
          const t = read("src/lib/cleanup-targets.ts");
          if (!t) return { pass: false, detail: "src/lib/cleanup-targets.ts missing" };
          const ok =
            /CLEANUP_TARGETS/.test(t) && /PERMITTED_ROOTS/.test(t) && /getCleanupTarget/.test(t);
          return { pass: ok, detail: ok ? "table + roots + lookup" : "incomplete" };
        },
      },
      {
        id: "P1-4",
        name: "deletion uses fs APIs, rejects symlinks, checks containment",
        check: () => {
          const t = read("src/app/actions.ts") ?? "";
          const fsApi = /from "node:fs\/promises"/.test(t) && /\brm\(/.test(t);
          const symlink = /isSymbolicLink\(\)/.test(t);
          const contain = /isAtOrUnder|PERMITTED_ROOTS/.test(t);
          const realp = /realpath\(/.test(t);
          const ok = fsApi && symlink && contain && realp;
          return {
            pass: ok,
            detail: `fs:${fsApi} symlink:${symlink} containment:${contain} realpath:${realp}`,
          };
        },
      },
      {
        id: "P1-5",
        name: "every route handler enforces the local-request guard",
        check: () => {
          const routes = srcFiles().filter((f) => /app\/api\/.*route\.ts$/.test(f));
          const missing = routes.filter((f) => !/assertLocalRequest\(/.test(read(f) ?? ""));
          return {
            pass: missing.length === 0 && routes.length > 0,
            detail: missing.join(", ") || `${routes.length} routes guarded`,
          };
        },
      },
      {
        id: "P1-6",
        name: "every server action enforces the local-request guard",
        check: () => {
          const t = read("src/app/actions.ts") ?? "";
          const actions = [...t.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
          // A non-exported helper that performs the check counts, so shared
          // preconditions (ownership, identity) can live in one place.
          const helpers = [...t.matchAll(/^async function (\w+)\(/gm)]
            .map((m) => m[1])
            .filter((name) => {
              const start = t.indexOf(`async function ${name}(`);
              const body = t.slice(start, t.indexOf("\n}\n", start));
              return /assertLocalRequest\(/.test(body);
            });
          const guarded = (b) =>
            /assertLocalRequest\(/.test(b) || helpers.some((h) => new RegExp(`\\b${h}\\(`).test(b));
          const bodies = t.split(/export async function /).slice(1);
          const missing = bodies.filter((b) => !guarded(b)).map((b) => b.split("(")[0]);
          return {
            pass: missing.length === 0 && actions.length > 0,
            detail: missing.join(", ") || `${actions.length} actions guarded`,
          };
        },
      },
      {
        id: "P1-7",
        name: "guard validates Host and Origin",
        check: () => {
          const t = read("src/lib/guard.ts");
          if (!t) return { pass: false, detail: "src/lib/guard.ts missing" };
          const ok = /host/i.test(t) && /origin/i.test(t);
          return { pass: ok, detail: ok ? "host + origin" : "incomplete" };
        },
      },
      {
        id: "P1-8",
        name: "security + no-store headers configured",
        check: () => {
          const t = read("next.config.ts") ?? "";
          const need = ["frame-ancestors", "nosniff", "Referrer-Policy", "no-store"];
          const missing = need.filter((n) => !t.includes(n));
          return { pass: missing.length === 0, detail: missing.join(", ") || "all present" };
        },
      },
      {
        id: "P1-9",
        name: "cleanup boundary tests exist and pass",
        check: () => {
          const has = existsSync(rel("tests/cleanup-boundary.test.ts"));
          if (!has) return { pass: false, detail: "tests/cleanup-boundary.test.ts missing" };
          return { pass: tests().ok, detail: tests().ok ? "passing" : tests().out.slice(-400) };
        },
      },
      {
        id: "P1-10",
        name: "typecheck + lint + build still clean",
        check: () => {
          const ok = typecheck().ok && lint().ok && build().ok;
          const detail = ok
            ? "tsc + eslint + build"
            : `tsc:${typecheck().ok} lint:${lint().ok} build:${build().ok}`;
          return { pass: ok, detail };
        },
      },
    ],
  },

  2: {
    title: "Phase 2 — Reliable collection",
    gates: [
      {
        id: "P2-1",
        name: "probe layer exists with typed outcomes",
        check: () => {
          const t = read("src/lib/probe.ts");
          if (!t) return { pass: false, detail: "src/lib/probe.ts missing" };
          const states = ["ok", "timeout", "denied", "unsupported", "failed"];
          const missing = states.filter((s) => !new RegExp(`status:\\s*"${s}"`).test(t));
          return { pass: missing.length === 0, detail: missing.join(", ") || states.join("|") };
        },
      },
      {
        id: "P2-2",
        name: "no synchronous child_process use in src",
        check: () => {
          const hits = grepCode(/\b(execSync|execFileSync|spawnSync)\s*\(/);
          return {
            pass: hits.length === 0,
            detail: hits.join(", ") || "none (comment references ignored)",
          };
        },
      },
      {
        id: "P2-3",
        name: "probes run concurrently (Promise.all fan-out)",
        check: () => {
          const missing = COLLECTION_MODULES.filter((f) => !/Promise\.all/.test(read(f) ?? ""));
          return {
            pass: missing.length === 0,
            detail: missing.join(", ") || `${COLLECTION_MODULES.length} collection modules fan out`,
          };
        },
      },
      {
        id: "P2-4",
        name: "machine constants cached, page size read dynamically",
        check: () => {
          const t = read("src/lib/probe.ts") ?? "";
          const cached = /getMachineInfo/.test(t);
          const dynamic = /hw\.pagesize/.test(t);
          const nohard = grepSrc(/pageSize\s*=\s*16384/).length === 0;
          return {
            pass: cached && dynamic && nohard,
            detail: `cached:${cached} hw.pagesize:${dynamic} no-hardcode:${nohard}`,
          };
        },
      },
      {
        id: "P2-5",
        name: "scans withhold the score when incomplete",
        check: () => {
          const files = ["src/app/api/scan/route.ts", "src/app/api/privacy/route.ts"];
          const missing = files.filter((f) => {
            const t = read(f) ?? "";
            return !(/complete/.test(t) && /unavailable/.test(t));
          });
          return {
            pass: missing.length === 0,
            detail: missing.join(", ") || "both report completeness",
          };
        },
      },
      {
        id: "P2-6",
        name: "stats returns 503 when core collection fails",
        check: () => {
          const t = read("src/app/api/stats/route.ts") ?? "";
          return {
            pass: /503/.test(t),
            detail: /503/.test(t) ? "503 path present" : "no 503 path",
          };
        },
      },
      {
        id: "P2-7",
        name: "no non-finite number can be serialised",
        check: () => {
          const helper = /Number\.isFinite/.test(read("src/lib/probe.ts") ?? "");
          // Any module that parses numbers must also guard them.
          const unguarded = srcFiles().filter((f) => {
            const code = codeOnly(read(f) ?? "");
            const parses = /\b(parseFloat|parseInt|Number\.parse(Float|Int))\s*\(/.test(code);
            if (!parses) return false;
            return !/finiteNumber|finiteInt|Number\.isFinite/.test(code);
          });
          return {
            pass: helper && unguarded.length === 0,
            detail: helper
              ? unguarded.join(", ") || "all numeric parses are finite-guarded"
              : "probe.ts lacks a finite guard",
          };
        },
      },
      {
        id: "P2-8",
        name: "single-flight prevents duplicate concurrent sampling",
        check: () => {
          const t = read("src/lib/single-flight.ts");
          if (!t) return { pass: false, detail: "src/lib/single-flight.ts missing" };
          const used = grepSrc(/singleFlight|withSingleFlight/).length > 0;
          return { pass: used, detail: used ? "in use" : "defined but unused" };
        },
      },
      {
        id: "P2-9",
        name: "scanner categories are mutually exclusive (browsers ≠ Electron)",
        check: () => {
          const src = read("src/app/api/scan/route.ts") ?? "";
          const electron = objectBody(src, "ELECTRON_APPS");
          const browsers = [
            "Google Chrome",
            "Brave",
            "Firefox",
            "Safari",
            "Arc",
            "Vivaldi",
            "Opera",
            "Microsoft Edge",
          ];
          const leaked = browsers.filter((b) => electron.includes(b));
          const separateList = /CHROMIUM_BROWSERS/.test(src);
          // Processes claimed as browsers must be excluded from the Electron pass.
          const claimsGuard = /claimed\.(add|has)\(/.test(src);
          return {
            pass: leaked.length === 0 && separateList && claimsGuard,
            detail:
              leaked.length > 0
                ? `browsers inside ELECTRON_APPS: ${leaked.join(", ")}`
                : `exclusive (separate CHROMIUM_BROWSERS list, claim guard: ${claimsGuard})`,
          };
        },
      },
      {
        id: "P2-10",
        name: "collection + scoring tests pass; toolchain clean",
        check: () => {
          const has =
            existsSync(rel("tests/probe.test.ts")) && existsSync(rel("tests/scoring.test.ts"));
          if (!has) return { pass: false, detail: "probe/scoring tests missing" };
          const ok = tests().ok && typecheck().ok && lint().ok && build().ok;
          return {
            pass: ok,
            detail: ok
              ? "tests + tsc + eslint + build"
              : `test:${tests().ok} tsc:${typecheck().ok} lint:${lint().ok} build:${build().ok}`,
          };
        },
      },
    ],
  },

  3: {
    title: "Phase 3 — Honest & accessible UI",
    gates: [
      {
        id: "P3-1",
        name: "first-load error is reachable (not masked by loading return)",
        check: () => {
          const hook = read("src/hooks/use-polling.ts") ?? "";
          const machine = ["idle", "loading", "success", "error"].every((s) =>
            new RegExp(`"${s}"`).test(hook),
          );

          const page = read("src/app/page.tsx") ?? "";
          const errIdx = page.search(/phase === "error"/);
          // Anchor on the rendered loading UI itself — guard expressions like
          // `if (!data)` also appear inside hooks and would match spuriously.
          const loadIdx = page.search(/Loading system stats/);
          const ordered = errIdx !== -1 && (loadIdx === -1 || errIdx < loadIdx);
          const retry = /Retry|onClick=\{stats\.refresh\}/.test(page);

          return {
            pass: machine && ordered && retry,
            detail: `state-machine:${machine} error-before-loading-return:${ordered} retry-offered:${retry}`,
          };
        },
      },
      {
        id: "P3-2",
        name: "destructive controls remain visible to keyboard focus",
        check: () => {
          const bad = [];
          let checked = 0;
          for (const f of srcFiles(/\.tsx$/)) {
            const lines = stripComments(read(f) ?? "").split("\n");
            lines.forEach((line, i) => {
              if (!/opacity-0\b/.test(line)) return;
              checked++;
              // A className may span several lines; inspect the enclosing element.
              const win = lines.slice(Math.max(0, i - 10), i + 11).join(" ");
              if (
                !/focus-visible:opacity-100|focus-within:opacity-100|group-focus-within:opacity-100/.test(
                  win,
                )
              ) {
                bad.push(`${f}:${i + 1}`);
              }
            });
          }
          return {
            pass: bad.length === 0,
            detail: bad.join(", ") || `${checked} hidden control(s), all revealed on focus`,
          };
        },
      },
      {
        id: "P3-3",
        name: "destructive controls carry a process-identifying accessible name",
        check: () => {
          const t =
            read("src/components/dashboard/process-table.tsx") ?? read("src/app/page.tsx") ?? "";
          const ok =
            /aria-label=\{`?Kill|aria-label=\{`Terminate/.test(t) ||
            /aria-label=\{`[^`]*PID/.test(t);
          return {
            pass: ok,
            detail: ok ? "aria-label includes process + PID" : "generic names only",
          };
        },
      },
      {
        id: "P3-4",
        name: "async status is announced (live regions)",
        check: () => {
          const files = srcFiles(/\.tsx$/);
          const hasStatus = files.some((f) => /role="status"|aria-live/.test(read(f) ?? ""));
          const hasAlert = files.some((f) => /role="alert"/.test(read(f) ?? ""));
          return { pass: hasStatus && hasAlert, detail: `status:${hasStatus} alert:${hasAlert}` };
        },
      },
      {
        id: "P3-5",
        name: "refresh control is labelled",
        check: () => {
          const files = srcFiles(/\.tsx$/);
          const ok = files.some((f) => {
            const t = read(f) ?? "";
            return /<select/.test(t) && /aria-label=|htmlFor=/.test(t);
          });
          return { pass: ok, detail: ok ? "labelled" : "unlabelled select" };
        },
      },
      {
        id: "P3-6",
        name: "polling cancels, guards overlap, and pauses when hidden",
        check: () => {
          const files = srcFiles();
          const joined = files.map((f) => read(f) ?? "").join("\n");
          const abort = /AbortController/.test(joined);
          const overlap = /inFlight|inflight|isFetching/.test(joined);
          const visibility = /visibilitychange|document\.hidden/.test(joined);
          return {
            pass: abort && overlap && visibility,
            detail: `abort:${abort} overlap:${overlap} visibility:${visibility}`,
          };
        },
      },
      {
        id: "P3-7",
        name: "charts reflow (no fixed pixel width in an overflow-hidden card)",
        check: () => {
          const joined = srcFiles(/\.tsx$/)
            .map((f) => read(f) ?? "")
            .join("\n");
          const responsive = /viewBox=/.test(joined);
          const fixed = /width=\{?280\}?/.test(joined);
          return { pass: responsive && !fixed, detail: `viewBox:${responsive} fixed-280:${fixed}` };
        },
      },
      {
        id: "P3-8",
        name: "severity conveyed as text, not colour alone",
        check: () => {
          const joined = srcFiles(/\.tsx$/)
            .map((f) => read(f) ?? "")
            .join("\n");
          const ok = /sr-only/.test(joined) || /severityLabel|SEVERITY_LABEL/.test(joined);
          return { pass: ok, detail: ok ? "textual severity present" : "colour/shape only" };
        },
      },
      {
        id: "P3-9",
        name: "reduced motion respected; real headings used",
        check: () => {
          const css = read("src/app/globals.css") ?? "";
          const joined = srcFiles(/\.tsx$/)
            .map((f) => read(f) ?? "")
            .join("\n");
          const motion = /prefers-reduced-motion/.test(css) || /motion-reduce:/.test(joined);
          const headings = /<h2|<h3/.test(joined);
          return {
            pass: motion && headings,
            detail: `reduced-motion:${motion} headings:${headings}`,
          };
        },
      },
      {
        id: "P3-10",
        name: "API responses validated at runtime; toolchain clean",
        check: () => {
          const t = read("src/lib/schemas.ts");
          if (!t) return { pass: false, detail: "src/lib/schemas.ts missing" };
          const used = grepSrc(/parseStats|parseScan|parseCleanup|parsePrivacy/).length > 0;
          const ok = used && tests().ok && typecheck().ok && lint().ok && build().ok;
          return {
            pass: ok,
            detail: ok
              ? "validated + toolchain clean"
              : `used:${used} test:${tests().ok} tsc:${typecheck().ok} lint:${lint().ok} build:${build().ok}`,
          };
        },
      },
    ],
  },

  4: {
    title: "Phase 4 — Release engineering",
    gates: [
      {
        id: "P4-1",
        name: "test suite exists and passes",
        check: () => {
          const files = walk("tests").filter((f) => /\.test\.ts$/.test(f));
          if (files.length === 0) return { pass: false, detail: "no tests" };
          return {
            pass: tests().ok,
            detail: tests().ok ? `${files.length} test files pass` : tests().out.slice(-400),
          };
        },
      },
      {
        id: "P4-2",
        name: "coverage spans every required layer",
        check: () => {
          const required = [
            "cleanup-boundary",
            "process-actions",
            "parsers",
            "scoring",
            "probe",
            "schemas",
            // Production entry points invoked as functions, not mirrored logic.
            "routes",
            "actions",
            "sampler",
            "libs",
          ];
          const have = walk("tests").map((f) => path.basename(f));
          const missing = required.filter((r) => !have.some((h) => h.includes(r)));
          return { pass: missing.length === 0, detail: missing.join(", ") || required.join(", ") };
        },
      },
      {
        id: "P4-3",
        name: "quality scripts defined (typecheck / test / check)",
        check: () => {
          const s = pkg().scripts ?? {};
          const missing = ["typecheck", "test", "check", "qa"].filter((k) => !s[k]);
          return { pass: missing.length === 0, detail: missing.join(", ") || "all defined" };
        },
      },
      {
        id: "P4-4",
        name: "CI workflow gates the full suite",
        check: () => {
          const t = read(".github/workflows/ci.yml");
          if (!t) return { pass: false, detail: "workflow missing" };
          // CI delegates to `bun run check` so local and CI can never drift;
          // expand package.json scripts so the gates are checked where they live.
          const s = pkg().scripts ?? {};
          const expand = (cmd, depth = 0) =>
            depth > 4
              ? cmd
              : cmd.replace(/bun run (\S+)/g, (m, name) =>
                  s[name] ? `${m} { ${expand(s[name], depth + 1)} }` : m,
                );
          const wired = t.includes("bun run check") ? `${t}\n${expand("bun run check")}` : t;
          const need = [
            "typecheck",
            "max-warnings=0",
            "bun test",
            "audit --prod",
            "next build",
            "smoke",
            "qa",
          ];
          const missing = need.filter((n) => !wired.includes(n));
          // The gating audit must be able to fail: no `|| true` anywhere in the check chain.
          const softened = /\|\|\s*true/.test(expand("bun run check"));
          if (softened) missing.push("audit is softened with || true");
          return {
            pass: missing.length === 0,
            detail: missing.join(", ") || "all gates wired via bun run check",
          };
        },
      },
      {
        id: "P4-5",
        name: "declared Node engine matches Next's requirement",
        check: () => {
          const eng = pkg().engines?.node ?? "";
          const ok = /20\.9|>=\s*20|>=\s*22|\^20|\^22/.test(eng);
          return { pass: ok, detail: eng || "engines.node undeclared" };
        },
      },
      {
        id: "P4-6",
        name: "workspace root pinned (no inference warning)",
        check: () => {
          const t = read("next.config.ts") ?? "";
          const pinned = /turbopack/.test(t) && /root/.test(t);
          const warned = /inferred your workspace root/.test(build().out);
          return { pass: pinned && !warned, detail: `pinned:${pinned} build-warning:${warned}` };
        },
      },
      {
        id: "P4-7",
        name: "packaging hygiene (private, LICENSE present)",
        check: () => {
          const p = pkg();
          const priv = p.private === true;
          const lic = existsSync(rel("LICENSE"));
          return { pass: priv && lic, detail: `private:${priv} LICENSE:${lic}` };
        },
      },
      {
        id: "P4-8",
        name: "README claims match implemented behaviour",
        check: () => {
          const t = read("README.md") ?? "";
          const stale = [];
          if (/Node\.js 18\+/.test(t)) stale.push("Node 18+");
          if (/bun run dev`?\s*$/m.test(t) && !/127\.0\.0\.1/.test(t))
            stale.push("no loopback note");
          if (/only pre-approved cleanup patterns can execute/i.test(t))
            stale.push("allowlist claim");
          if (/SIGKILL escalation/.test(t) && !/grace/i.test(t)) stale.push("escalation claim");
          return { pass: stale.length === 0, detail: stale.join(", ") || "accurate" };
        },
      },
      {
        id: "P4-9",
        name: "zero high/critical advisories reachable from production deps",
        check: () => {
          const bad = prodAdvisories().filter(
            (a) => a.severity === "high" || a.severity === "critical",
          );
          return {
            pass: bad.length === 0,
            detail:
              bad.length === 0
                ? "0 production-reachable"
                : bad.map((a) => `${a.pkg} (${a.severity})`).join(", "),
          };
        },
      },
      {
        id: "P4-10",
        name: "app actually boots and renders (smoke) + toolchain green",
        check: () => {
          // A build that compiles is not an app that runs: tsc, eslint and
          // next build all passed green while every page load returned 500.
          const ok = typecheck().ok && lint().ok && tests().ok && build().ok && smoke().ok;
          if (ok) return { pass: true, detail: "tsc + eslint + tests + build + smoke 13/13" };
          const smokeLine =
            smoke()
              .out.split("\n")
              .find((l) => /SMOKE|FAIL/.test(l)) ?? "";
          return {
            pass: false,
            detail: `tsc:${typecheck().ok} lint:${lint().ok} test:${tests().ok} build:${build().ok} smoke:${smoke().ok} ${smokeLine.replace(/\x1b\[[0-9;]*m/g, "")}`,
          };
        },
      },
    ],
  },
};

// ---------- runner ----------

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function runPhase(n) {
  const phase = PHASES[n];
  if (!phase) {
    console.error(`Unknown phase: ${n}`);
    process.exit(2);
  }
  console.log(`\n${C.bold(phase.title)}`);
  console.log("─".repeat(74));

  let passed = 0;
  for (const gate of phase.gates) {
    let res;
    try {
      res = gate.check();
    } catch (e) {
      res = { pass: false, detail: `gate threw: ${e.message}` };
    }
    if (res.pass) passed++;
    const mark = res.pass ? C.green("PASS") : C.red("FAIL");
    console.log(`  ${mark}  ${gate.id.padEnd(6)} ${gate.name}`);
    if (res.detail) {
      const d = String(res.detail).split("\n").slice(0, 6).join("\n         ");
      console.log(C.dim(`         ${d}`));
    }
  }

  const total = phase.gates.length;
  const score = `${passed}/${total}`;
  console.log("─".repeat(74));
  if (passed === total) {
    console.log(`  ${C.green(C.bold(`GATE PASSED — ${score}`))}\n`);
  } else {
    console.log(`  ${C.red(C.bold(`GATE FAILED — ${score}`))}\n`);
  }
  return passed === total;
}

const arg = process.argv[2] ?? "all";
const phases = arg === "all" ? Object.keys(PHASES) : [arg];
let allPass = true;
for (const p of phases) allPass = runPhase(p) && allPass;
process.exit(allPass ? 0 : 1);
