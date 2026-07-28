# System Monitor — Deep Full-App Audit

**Date:** 2026-07-28 21:46 BST  
**Commit inspected:** `bcacb71bbc6f7cd3242d10574c3a240fc6b8600b` (`main`)  
**Verification:** direct source inspection, static quality gates, live loopback runtime probes, and a network-backed dependency advisory audit  
**Scope:** all 32 tracked files; all 2,780 TypeScript/TSX/CSS source lines; API routes, Server Actions, UI, accessibility, runtime behavior, dependencies, documentation, testing, and release readiness  
**Application-code edits:** none  
**Pre-existing dirty files preserved:** `package.json`, `bun.lock`

## Executive verdict

**FAIL — not safe to release or expose to a LAN.**

The application has a useful compact UI and passes TypeScript and production compilation, but it has one critical command-injection path, no authentication or loopback enforcement around system-level operations, blocking request handlers that can freeze the entire app for approximately 50 seconds, security/health scanners that fail open, a headline tracker-detection feature that cannot work as implemented, no automated tests or CI, and current high-severity dependency advisories.

Immediate operating advice:

1. **Do not use the Cleanup action until C-01 is fixed.**
2. **Do not run the current app on a network-reachable interface.** Explicitly bind it to `127.0.0.1`.
3. **Do not treat a high health/privacy score as evidence that the machine is healthy or private.** Missing probes are currently scored as success.
4. **Do not call the current implementation release-ready merely because `next build` passes.**

## Severity summary

| Severity | Count | Release meaning |
|---|---:|---|
| Critical | 1 | Immediate code-execution risk; block use of the affected feature |
| High | 6 | Blocks release |
| Medium | 13 | Fix before a dependable public release |
| Low / improvement | 7 | Quality, maintainability, and product-polish work |

## What passed

- TypeScript strict checking passed: `bunx tsc --noEmit`.
- Production compilation passed: `bun run build`.
- ESLint completed with no errors, but with eight warnings.
- The development page and four routes returned HTTP 200 during loopback smoke testing.
- PID input is constrained to a positive integer before shell interpolation (`src/app/actions.ts:41-50`).
- The kill path attempts a same-user ownership check (`src/app/actions.ts:53-59`).
- Cleanup rejects commands beginning with `sudo` (`src/app/actions.ts:28-31`).
- No tracked credentials, private keys, `.env` files, database, upload, payment, or SSRF input surface was found.
- Core landmarks and native table elements exist (`src/app/page.tsx:367-370,470`; `src/components/ui/table.tsx:7-18,22-39,68-91`).
- The shared Button renders a native button and defines a visible focus ring (`src/components/ui/button.tsx:8-9,45-56`).

These positives do not offset a Critical or High release blocker.

---

## Critical finding

### C-01 — Client-controlled cleanup command permits shell injection and arbitrary code execution

**Status:** Verified  
**Evidence:**

```ts
// src/app/actions.ts:14-18
const SAFE_CLEANUP_PATTERNS = [
  /^rm -rf ".*\/(Library\/Caches|Library\/Logs|\.Trash|Library\/Developer|\.bun\/install\/cache|\.npm\/_cacache|\.cache\/yarn|\.cache\/pip|Library\/Caches\/Homebrew|Library\/Caches\/CocoaPods|Library\/Caches\/pnpm|Library\/Logs\/DiagnosticReports|MobileSync\/Backup|Mail Downloads)"\/?\*$/,
];
```

```ts
// src/app/actions.ts:21-34
export async function cleanupItem(command: string) {
  const isSafe = SAFE_CLEANUP_PATTERNS.some((p) => p.test(command));
  if (!isSafe) return { success: false, error: "Command not in safe cleanup allowlist" };
  // ...
  execSync(command, { encoding: "utf-8", timeout: 30000 });
}
```

```tsx
// src/app/page.tsx:301-305
const handleClean = async (item: CleanupItem) => {
  // ...
  const result = await cleanupItem(item.command);
```

The browser receives and resubmits a raw command. The allowlist's `.*` accepts embedded quotes and shell separators. A safe predicate-only reproduction, which did **not** execute the payload, proved that this string passes the regex:

```text
rm -rf ""; touch /tmp/SM_AUDIT_PWN; echo "/Library/Caches"*
matches=true
```

The generated client bundle also contains a callable Server Action reference for `cleanupItem`, confirming that this is a client-callable mutation rather than an internal-only helper.

The exposure is materially worse because the documented launcher uses `bun run dev --port $PORT` without a loopback hostname (`README.md:68-83`). Live startup verification showed both `next dev` and `next start` attempting to listen on `0.0.0.0`.

**Impact:** Any client able to reach the service and invoke the action can execute shell commands with the app user's privileges. That includes reading, modifying, or deleting user-accessible data.

**Required fix:**

- Accept an opaque cleanup ID, never a command or path from the browser.
- Map the ID to a closed server-side cleanup definition.
- Resolve and validate the target under explicitly permitted roots.
- Reject symlinks and revalidate immediately before deletion.
- Use Node filesystem APIs such as `fs.rm`, or `execFile`/`spawn` with an argument array and `shell: false`.
- Add authentication/reauthorization for destructive actions and enforce loopback Host/Origin policy.
- Add adversarial tests for quotes, separators, substitutions, newlines, symlinks, path traversal, and unknown IDs.

---

## High findings

### H-01 — No access-control boundary protects system data or destructive operations

**Status:** Verified  
**Evidence:**

```ts
// src/app/actions.ts:5,21,41
export async function stopServer() { /* ... */ }
export async function cleanupItem(command: string) { /* ... */ }
export async function killProcess(pid: number) { /* ... */ }
```

```ts
// Route entry points
// src/app/api/stats/route.ts:28
// src/app/api/scan/route.ts:84
// src/app/api/cleanup/route.ts:42
// src/app/api/privacy/route.ts:67
export async function GET() { /* ... */ }
```

A repository-wide search found no middleware, authentication, session, token, Host allowlist, Origin allowlist, authorization, or rate-limit implementation. The routes disclose process, user, network, permissions, startup-item, filesystem-path, and cleanup-command data. The actions can stop the server, terminate same-user processes, and delete files.

**Impact:** A network-reachable visitor receives local system inventory and can invoke system mutations. Server Action Origin checks are not user authentication.

**Required fix:** Bind to `127.0.0.1` by default and enforce loopback at the application boundary; add a local authentication secret/session; require explicit recent confirmation for destructive mutations; reject unexpected Host/Origin values; rate-limit expensive probes; return opaque cleanup IDs only.

### H-02 — Synchronous shell and filesystem probes block the entire Next.js process

**Status:** Verified statically and at runtime  
**Evidence:**

```ts
// src/app/api/cleanup/route.ts:4-19
function run(cmd: string): string {
  return execSync(cmd, { timeout: 15000, encoding: "utf-8" }).trim();
}
function dirSize(path: string): number {
  const raw = run(`du -sk "${path}" 2>/dev/null | cut -f1`);
  // ...
}
function fileCount(path: string): number {
  const raw = run(`find "${path}" -type f 2>/dev/null | wc -l`);
  // ...
}
```

The same blocking helper is repeated in `stats/route.ts:4-9`, `scan/route.ts:4-9`, and `privacy/route.ts:4-9`. Cleanup repeatedly walks large directory trees at `cleanup/route.ts:52-71,89-105,164-203,209-241`.

Observed loopback timings:

```text
/api/stats    200  approximately 2.0–3.4s
/api/scan     200  approximately 0.5s
/api/cleanup  200  49–51s
/api/privacy  200  approximately 3.4s
```

While a second cleanup scan ran for 51 seconds, a stats request received no bytes and timed out after 30 seconds. This verifies process-wide event-loop starvation.

Under sustained polling, the server log later showed queued `/api/stats` response times rising as high as 22.8 seconds even though individual application-code collection was generally about 2.5–5.7 seconds.

The client amplifies this:

```tsx
// src/app/page.tsx:313-329,378-386
const res = await fetch("/api/stats", { cache: "no-store" });
// ...
const id = setInterval(fetchStats, refreshInterval);
// offers 1000, 3000, 5000, 10000 ms
```

At the one-second option, requests are generated faster than the measured route can complete.

**Required fix:** Replace `execSync` and shell pipelines with bounded asynchronous collectors; centralize a single server-side sampler; cache/deduplicate reads; permit one scan of each type at a time; use completion-driven polling, AbortController, hidden-tab pause, and stale-response rejection.

### H-03 — Probe failures silently become healthy data and perfect scores

**Status:** Verified  
**Evidence:**

```ts
// src/app/api/privacy/route.ts:4-9
function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 15000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}
```

All four routes use this fail-open pattern. Empty results become zero values in `stats/route.ts:46-87`; health starts at 100 in `scan/route.ts:225-236`; privacy starts at 100 in `privacy/route.ts:269-277`.

For example:

```ts
// src/app/api/privacy/route.ts:269-277
let privacyScore = 100;
findings.forEach((f) => {
  if (f.severity === "critical") privacyScore -= 25;
  // ...
});
```

If `lsof`, `sqlite3`, `ps`, or a TCC query is unavailable, denied, malformed, or timed out, it produces no finding and therefore improves the displayed result. In stats, division by a zero RAM total can produce non-finite values that serialize as `null`, violating the client type.

**Impact:** The most dangerous collection failure can be displayed as “100/100” or “No privacy concerns found.”

**Required fix:** Return typed collector results (`success`, `failure`, `timeout`, `permission_denied`, `unsupported`); validate all parsed numbers with `Number.isFinite`; expose unavailable checks; mark the scan `incomplete`; withhold the score when required evidence is missing; return 503 for a failed core stats collection.

### H-04 — Active tracker detection cannot match the data it collects

**Status:** Verified statically and at runtime  
**Evidence:**

```ts
// src/app/api/privacy/route.ts:71-88
const lsofOutput = run("lsof -i -nP 2>/dev/null | grep ESTABLISHED");
// ...
if (conn.destination.toLowerCase().includes(pattern.toLowerCase())) {
```

`lsof -nP` intentionally emits numeric IP addresses and ports, while `KNOWN_TRACKERS` contains domain-name substrings such as `google-analytics`, `doubleclick`, `facebook.com`, and `hotjar` (`privacy/route.ts:12-48`). The collected DNS log is never used (`privacy/route.ts:116-117`), and `EXPECTED_CONNECTIONS` is also unused (`privacy/route.ts:50-56`).

A live response reported 109 established connections and zero tracker matches, consistent with the numeric/domain mismatch. This single observation does not prove the machine had trackers; the code mismatch proves the detector lacks the domain evidence it requires.

**Impact:** The README's headline “active tracker detection” claim (`README.md:33-40`) is not implemented by the current evidence pipeline.

**Required fix:** Correlate connections with authoritative DNS/process evidence, model unresolved endpoints explicitly, deduplicate and timestamp observations, and create fixture tests that prove known tracker and known-safe destinations are classified correctly.

### H-05 — The current dependency tree contains known high-severity advisories

**Status:** Verified with `bun audit` on 2026-07-28  
**Evidence:**

```json
// package.json:21-24
"next": "16.2.1",
"react": "19.2.4",
"react-dom": "19.2.4",
"shadcn": "^4.1.0"
```

The live audit reported **74 advisories: 27 high, 42 moderate, and 5 low** across the installed tree. The direct `next@16.2.1` dependency is in the reported vulnerable range `<16.2.5`, including high-severity Server Action/RSC denial-of-service and endpoint-disclosure advisories. The CLI-only `shadcn` package is in production dependencies and pulls a large MCP/Hono/Express/tooling tree (`bun.lock:1110`). `sharp@0.34.5`, resolved through Next (`bun.lock:948,1112`), was also reported with a high advisory.

Not every transitive advisory is necessarily reachable in this app. The direct vulnerable framework and unnecessary production tooling surface are sufficient to block release pending upgrade and re-audit.

**Required fix:** Upgrade Next and matching ESLint config to a non-vulnerable release, remove `shadcn` from runtime dependencies (or remove it entirely if the CLI is not needed), refresh transitive dependencies, then rerun build, tests, smoke probes, and `bun audit`.

### H-06 — There are no automated tests or CI gates for destructive behavior

**Status:** Verified  
**Evidence:**

```json
// package.json:8-13
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint"
}
```

No test/spec files, test configuration, or `.github/workflows` were found. The actual test command returned:

```text
bun test
No tests found!
exit 1
```

**Impact:** Shell parsing, deletion boundaries, signal handling, parser drift, fail-open scoring, async races, and accessibility regressions can reach `main` without an automated check.

**Required fix:** Add unit, contract, component, integration, and end-to-end tests; add explicit `typecheck`, `test`, and `check` scripts; require lint with zero warnings, typecheck, tests, build, dependency audit, and production smoke checks in CI.

---

## Medium findings

### M-01 — Process termination does not implement the documented escalation and has a PID identity race

**Evidence:**

```ts
// src/app/actions.ts:53-69
const owner = execSync(`ps -o user= -p ${pid} 2>/dev/null`, ...).trim();
// ...
execSync(`kill -15 ${pid} 2>/dev/null`);
return { success: true };
// SIGKILL is attempted only when the kill command itself throws
```

`kill -15` returning zero only means the signal was sent; it does not mean the process exited. The code returns immediately, so a process that ignores SIGTERM never reaches the advertised SIGKILL fallback (`README.md:14`). Separate owner check, signal, existence check, and SIGKILL calls do not preserve process identity; PID reuse can target a different process.

**Fix:** Capture PID plus start time/executable, revalidate before every signal, send SIGTERM, wait asynchronously for a bounded grace period, then revalidate identity and send SIGKILL only if still alive.

### M-02 — Stop Server targets a port, not this application

**Evidence:**

```ts
// src/app/actions.ts:5-10
execSync("kill $(lsof -ti :3000) 2>/dev/null", { encoding: "utf-8" });
```

It fails when the app uses another port, kills every listener on 3000, and does not verify owner or process identity. The UI ignores the returned result (`src/app/page.tsx:419-425`).

**Fix:** Remove HTTP self-termination or use a launcher/supervisor with a verified PID and configurable port; show failure to the user.

### M-03 — History and hot-process alert timing are controlled by request count, not elapsed time

**Evidence:**

```ts
// src/app/api/stats/route.ts:12-26
const MAX_HISTORY = 100; // ~5 min at 3s intervals
const history = [];
const ALERT_POLLS_REQUIRED = 3; // ~9s
```

```ts
// src/app/api/stats/route.ts:134-160
history.push(...);
existing.count++;
```

One tab at 1s makes the “5 minute” history about 100 seconds; one tab at 10s makes it about 16.7 minutes; multiple tabs shorten it again and trigger alerts early. Module state also resets or splits across restarts/workers.

**Fix:** Use a server-owned monotonic sampling cadence, timestamp windows, and PID plus start-time identity.

### M-04 — Persistent initial stats failure is displayed as endless loading

**Evidence:**

```tsx
// src/app/page.tsx:313-323
catch {
  setError("Failed to fetch system stats");
}
```

```tsx
// src/app/page.tsx:342-348
if (!stats) {
  return ... "Loading system stats...";
}
```

The error UI is below the early return at `page.tsx:464-468` and is unreachable while `stats` remains null.

**Fix:** Model `idle/loading/success/error`, show retryable initial errors, and distinguish background refresh failure from first load.

### M-05 — Scan, cleanup, and privacy errors produce blank or stale panels

**Evidence:** Each fetch catch only clears its result (`src/app/page.tsx:255-299`), while render branches end in `result ? (...) : null` (`page.tsx:615-679,706-784,820-890`). Rescans do not clear or label the previous result before starting.

**Fix:** Use explicit panel states, retain old data only when visibly marked stale, display timestamps and actionable errors, and provide Retry.

### M-06 — Polling has no cancellation, overlap guard, ordering guard, hidden-tab pause, or user pause

**Evidence:** `fetchStats` always commits its response (`src/app/page.tsx:313-323`), and `setInterval` starts calls independently (`page.tsx:325-329`). Options only include 1s/3s/5s/10s (`page.tsx:378-387`).

**Impact:** Old responses can overwrite newer state; interval changes can leave prior requests in flight; background tabs continue expensive collection; users cannot pause automatically updating content.

**Fix:** Completion-driven scheduling, AbortController/request generation, Page Visibility pause, and an explicit Paused option.

### M-07 — Destructive actions are inaccessible or ambiguous for keyboard, touch, and screen-reader users

**Evidence:**

```tsx
// src/app/page.tsx:940-948
className={`... ${isAlerted ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
// button text: "kill"
```

The button remains opacity zero when keyboard-focused and is undiscoverable on touch. Repeated names such as `kill` and `kill main` do not identify the process (`page.tsx:443-450,866-876,940-948`).

**Fix:** Keep destructive controls visible for all modalities or add focus-visible/focus-within visibility; give each an accessible name containing process and PID; ensure at least a 24×24 CSS-pixel target.

### M-08 — Controls and asynchronous status changes lack accessible naming/announcements

**Evidence:** The refresh `<select>` has no label or ARIA name (`src/app/page.tsx:378-387`). Kill feedback, errors, and scan progress/results are plain divs with no live-region or alert roles (`page.tsx:457-468,615-679,706-784,820-890`). Trigger buttons lack `aria-controls`/`aria-expanded`.

**Fix:** Add a visible select label, `role="status"`/`aria-live` for progress and success, `role="alert"` for failures, `aria-busy`, labelled regions, and trigger-to-panel relationships.

### M-09 — Mobile reflow clips charts and crushes controls

**Evidence:** The stats grid stays two-column on mobile (`src/app/page.tsx:470-472`), but every chart is a fixed 280px wide (`page.tsx:488,507,532,551`) inside a card with `overflow-hidden` (`src/components/ui/card.tsx:14-16`). Disk is a permanent four-column grid with a one-column card (`page.tsx:557-559`). The header and toolbar are non-wrapping flex rows (`page.tsx:367-372`).

**Fix:** Use one column on small screens; responsive SVG `viewBox`/`width:100%`; make disk span the available width; stack or wrap the toolbar; verify at 320 CSS px and 400% zoom.

### M-10 — Severity and chart meaning are partly color/shape-only

**Evidence:** `StatusDot` is an empty colored span (`src/app/page.tsx:137-144`); Sparkline has no title, description, label, or textual trend (`page.tsx:161-230`); system-scan severity renders a dot but not severity text (`page.tsx:858-863`).

**Fix:** Provide explicit status/severity text and an accessible trend summary or data table; mark graphics decorative only after equivalent text exists.

### M-11 — API response types are duplicated and not validated at runtime

**Evidence:** Client-only interfaces are manually declared at `src/app/page.tsx:20-117`. Each request performs unvalidated `await res.json()` and stores it (`page.tsx:259-262,274-277,290-293,315-318`), after which fields are called as numbers, for example `stats.load[0].toFixed(1)` (`page.tsx:545`).

**Fix:** Define shared schemas, validate every route response at runtime, and surface contract errors rather than crashing the dashboard.

### M-12 — Application security and sensitive-response cache policy are undefined

**Evidence:** `next.config.ts:3-5` is empty, and the live `/api/stats` response had no explicit Cache-Control, CSP, frame-ancestor, nosniff, Referrer-Policy, or Permissions-Policy header.

**Fix:** Define strict security headers, `frame-ancestors 'none'`, explicit `private, no-store` for system JSON, a minimal Permissions-Policy, and Host/Origin enforcement. Validate production headers, not just development output.

### M-13 — Runtime/package documentation and workspace configuration are inconsistent

**Evidence:**

- README says Node 18+ (`README.md:101-104`), while installed Next declares Node `>=20.9.0` (`node_modules/next/package.json:375-377`).
- `next.config.ts:3-5` does not define the project root; build/start warned that `/Users/rajan/package-lock.json` was selected as workspace root.
- The optional desktop launcher runs development mode (`README.md:68-83`).
- Both architecture-specific Lightning CSS binaries are directly declared (`package.json:18-19`), although platform selection should be optional; the advertised npm tree reports the x64 package missing on this ARM host.

**Fix:** Declare the real Node engine, set project/output tracing roots, package a production launcher, and resolve platform dependencies through supported optional-dependency behavior. Test clean installs on Apple Silicon and Intel.

---

## Low-severity gaps and improvements

### L-01 — Cleanup completion and reclaimed-size reporting can be inaccurate

Size/count scans include dotfiles (`src/app/api/cleanup/route.ts:12-19`), while commands such as `rm -rf "${dir.path}"/*` omit dotfiles (`cleanup/route.ts:65,104,124,177,202,222,241`). The UI marks an item cleaned without rescanning (`src/app/page.tsx:301-307`).

**Improve:** Use filesystem APIs that enumerate exactly what will be deleted, return actual deleted bytes/count, and rescan before declaring success.

### L-02 — Hard-coded home fallback is not portable and should fail closed

`src/app/api/cleanup/route.ts:43` and `src/app/api/privacy/route.ts:68` fall back to `/Users/rajan`.

**Improve:** Use verified `os.homedir()`/user identity and fail explicitly when the home root cannot be established.

### L-03 — Concurrent destructive actions share single-slot state

`killingPid`, `killMessage`, `cleaningId`, and unconditional timers are single values (`src/app/page.tsx:240-249,331-339`). Other rows remain enabled, completions can clear another operation's state, and action transport rejection can leave cleanup stuck because `handleClean` lacks `try/finally` (`page.tsx:301-311`).

**Improve:** Disable all destructive controls while one action runs or track pending/results by stable ID; use `try/catch/finally`; key or cancel feedback timers.

### L-04 — Document structure needs real headings and a table caption

`CardTitle` renders a `div` (`src/components/ui/card.tsx:36-46`), so dashboard section titles are not headings. The process table has no caption (`src/app/page.tsx:895-954`) although a caption primitive exists (`src/components/ui/table.tsx:94-105`).

**Improve:** Use semantic `h2`/`h3`, labelled sections, and a visually hidden table caption.

### L-05 — Motion is not reduced for user preference

Indefinite pulses occur at `src/app/page.tsx:141,345,438,616,707,821,926`; bars and tooltips animate at `page.tsx:155-156` and `src/components/ui/tooltip.tsx:52-59`. No `prefers-reduced-motion` or `motion-reduce` handling exists in `globals.css:120-130`.

**Improve:** Disable non-essential animation and transitions under reduced motion.

### L-06 — A 961-line client component increases coupling and rerender cost

All state, polling, scan panels, cleanup panels, charts, and the process table live in `src/app/page.tsx:1-961`. Every stats update reruns the component, including open scan/cleanup/privacy render work.

**Improve:** Extract shared domain schemas and focused panels/hooks; profile before memoizing; keep server sampling separate from presentation.

### L-07 — Repository and packaging hygiene is incomplete

`package.json:4` sets `"private": false`; package/README claim MIT (`package.json:6`, `README.md:106-108`) but no tracked `LICENSE` exists. ESLint reports eight unused-symbol warnings at `actions.ts:36`, `privacy/route.ts:51,117`, `scan/route.ts:220`, and `stats/route.ts:61,63-64,91`.

**Improve:** Mark the local system utility private unless publication is intentional, add the actual license file, and enforce zero warnings.

---

## Missing test matrix

| Layer | Required coverage |
|---|---|
| Command/parsers | Valid, empty, malformed, localized, permission-denied, and changed-format fixtures for `top`, `vm_stat`, `ps`, `df`, `sysctl`, `lsof`, and `sqlite3` |
| Cleanup boundary | Unknown ID, injection strings, traversal, symlinks, dotfiles, permission failures, large trees, race/revalidation, exact deleted size/count |
| Process actions | Invalid PID, ownership mismatch, already exited, PID reuse identity, SIGTERM exit, timeout, SIGKILL fallback |
| Scoring | Missing collectors never increase health/privacy scores; incomplete results are visibly incomplete |
| Route contracts | Schema, status codes, cache/security headers, timeouts, cancellation, concurrency, bounded execution |
| Polling | No overlap, cancellation on interval/unmount, stale-response ordering, visibility pause, first-load retry |
| UI/accessibility | Keyboard-visible destructive actions, accessible names, live regions, focus flow, 320px reflow, 400% zoom, reduced motion |
| Integration | Cleanup cannot block stats; all system probes are single-flight/cached; destructive operations use only server-owned targets |
| Platform/release | Clean Bun/npm install, Apple Silicon and Intel fixtures, minimum Node version, production startup, health check, rollback |

## Remediation plan

### Phase 0 — Contain now

1. Disable or remove `cleanupItem`.
2. Change all launch commands to `--hostname 127.0.0.1`.
3. Do not advertise current scanner scores as authoritative.
4. Upgrade the vulnerable framework and re-audit dependencies.

### Phase 1 — Rebuild the trust boundary

1. Replace browser-supplied commands with opaque server-owned operation IDs.
2. Replace shell deletion with validated filesystem operations.
3. Add local authentication, Host/Origin enforcement, reauthorization, and rate limits.
4. Return opaque data only; stop returning executable commands.
5. Add security/cache headers.

### Phase 2 — Make collection reliable

1. Replace synchronous request-path commands with asynchronous bounded collectors.
2. Add a single server sampling service, caching, deduplication, cancellation, and explicit degraded states.
3. Repair DNS-to-process correlation for tracker detection.
4. Move history/alert logic from request count to monotonic time.
5. Correct signal escalation and process identity revalidation.

### Phase 3 — Make the UI honest and accessible

1. Implement explicit loading/success/stale/error states.
2. Add safe polling controls and pause behavior.
3. Repair keyboard/touch visibility, accessible names, live regions, headings, chart alternatives, and responsive reflow.
4. Add runtime response validation.

### Phase 4 — Establish release engineering

1. Add the full test matrix.
2. Add CI gates for zero-warning lint, typecheck, tests, build, dependency audit, and production smoke.
3. Fix Node/platform/install documentation and workspace-root configuration.
4. Add a production launcher, health check, rollback procedure, LICENSE, and packaging policy.

## Binary release gates

Release remains **blocked** until all of these are true:

- [ ] No client-controlled command reaches a shell.
- [ ] The app is loopback-only by default and destructive actions are authenticated/reauthorized.
- [ ] Cleanup cannot starve stats or the event loop.
- [ ] Missing probes produce incomplete/error state, never a healthy score.
- [ ] Tracker detection is proven with fixtures and live evidence.
- [ ] Direct high-severity dependency advisories are resolved or explicitly proven inapplicable.
- [ ] `bun test`, strict lint, typecheck, build, and production smoke all pass in CI.
- [ ] Process kill escalation and identity checks pass deterministic tests.
- [ ] Keyboard, screen-reader status messaging, reflow, and reduced-motion checks pass.
- [ ] Clean Bun/npm installs and the documented minimum Node version are verified.

## Verification log

| Check | Result |
|---|---|
| `git status --short --branch` | Existing `M bun.lock`, `M package.json`; preserved |
| `bunx tsc --noEmit` | Pass |
| `bun run lint` | Exit 0; 8 warnings |
| `bun test` | Fail; no tests found |
| `bun run build` | Pass; workspace-root warning |
| `bun audit` | 74 advisories: 27 high, 42 moderate, 5 low |
| Loopback `/` | HTTP 200 |
| Loopback `/api/stats` | HTTP 200; approximately 2.0–3.4s baseline; queued polling reached 22.8s |
| Loopback `/api/scan` | HTTP 200; approximately 0.5s |
| Loopback `/api/cleanup` | HTTP 200; 49–51s |
| Loopback `/api/privacy` | HTTP 200; approximately 3.4s |
| Stats during cleanup | Timed out at 30s with no bytes; cleanup completed at 51s |
| Command-injection predicate | Malicious separator payload matched allowlist; payload not executed |

## Confidence and limitations

- **Static code findings:** high confidence; all material claims were verified against the cited source.
- **Runtime blocking findings:** high confidence; reproduced against the local loopback app.
- **Dependency findings:** high confidence as a current advisory snapshot, but applicability must be reassessed after upgrades.
- **Accessibility semantics/reflow:** high confidence for code-proven issues.
- **Color contrast:** not scored. No computed-style browser contrast measurement was completed, so this report makes no pass/fail contrast claim.
- **Real tracker accuracy/recall:** not measured. The report proves the current domain-matching pipeline is structurally incapable of using numeric `lsof -nP` output as domain evidence.
