# System Monitor

Local macOS system monitor, process manager and privacy scanner. Real-time stats, disk cleanup and privacy checks, in the browser.

**Loopback only by design.** The app reports on — and can act on — your machine: running processes, granted permissions, network connections, and file deletion. It binds to `127.0.0.1` and refuses requests whose `Host` is not loopback. Do not expose it to a network.

Built with Next.js and shadcn/ui. Runs entirely locally; no data leaves the machine.

## Quick start

```bash
git clone https://github.com/TheSmilemakers/system-monitor.git
cd system-monitor
bun install
bun run dev
```

Open <http://localhost:3000>. `bun run dev` and `bun run start` both bind `127.0.0.1`.

## Features

### Real-time dashboard
- **Live stats** — CPU, memory, swap, disk and load average with status text and colour
- **Sparkline history** — a rolling 5-minute window sampled on a server-side cadence, so the window means the same thing regardless of how often the browser polls
- **Process table** — top processes by CPU, with per-row termination
- **Process alerts** — processes sustaining high CPU for 9 seconds or more
- **Refresh control** — 3s / 5s / 10s / 30s, or paused; polling is completion-driven and pauses while the tab is hidden

### System scan
- **Browser audit** — flags multiple concurrent browsers
- **Electron app audit** — counts genuine Electron apps and their memory footprint, excluding browsers so nothing is counted twice
- **Bloatware detection** — one finding per vendor rather than one per matched pattern
- **Resource hogs** — user-owned processes with outsized CPU or memory
- **Startup items** — third-party launch agents and daemons
- **Health score** — withheld entirely when a required probe could not run

### Disk cleanup
- **Measured targets** — caches, logs, crash reports, developer artifacts, Trash, old Downloads, iOS backups, mail attachments
- **Per-item cleaning** — with size, file count and a risk level
- **Server-owned operations** — the browser sends an opaque id; paths and deletion logic never leave the server

### Privacy scanner
- **Connection audit** — established connections are resolved to hostnames before being matched against a tracker list. Addresses that do not resolve are reported as **unknown**, never as clean
- **Permission audit** — reads the TCC database for accessibility, screen recording, input monitoring, camera, microphone, contacts, calendar and photos grants. **Requires Full Disk Access**; without it the check reports itself unavailable rather than reporting no findings
- **Suspicious process detection** — name-based heuristics
- **Persistence check** — unrecognised launch agents and daemons
- **Privacy score** — withheld when any check could not run

## Accuracy notes

- **CPU percentages come from two sources with different units.** The CPU card shows system-wide usage normalised 0–100% across all cores. The process table shows `ps` values, which are a percentage of **one** core and can exceed 100%. The table is labelled accordingly.
- **A score is never a guess.** If a probe times out, is denied, or is unsupported, the scan reports `complete: false`, lists what failed, and shows no score.
- **Reclaimed space is measured, not estimated.** Cleanup enumerates exactly what it will delete, including dotfiles, and reports the bytes actually freed.

## Requirements

- macOS — uses `top`, `vm_stat`, `ps`, `sysctl`, `df`, `lsof`, `pmset`, `du`, `find`, `sqlite3`
- Node.js 20.9+ or Bun
- Full Disk Access for your terminal, if you want the permission audit to run

## Development

```bash
bun run check:fast  # typecheck, lint (zero warnings), tests
bun run check       # what CI runs, exactly: check:fast, production dependency
                    # audit (hard fail), build, smoke against next start, smoke
                    # against next dev, every QA phase at 10/10

bun run typecheck   # tsc --noEmit
bun run lint        # eslint, zero warnings
bun run test        # bun test
bun run audit:prod  # bun audit --prod --audit-level=high
bun run build       # next build
bun run smoke       # boots the dev server and asserts every route responds
bun run smoke:prod  # same against the production server
bun run qa 0        # QA gate for a phase (0-4)
bun run qa all      # every phase; exits non-zero unless each scores 10/10
```

`bun run dev` runs `scripts/preflight.mjs` first. It fails in a few milliseconds,
with the reason, when Node is running under Rosetta on an Apple Silicon Mac or
the lightningcss binary for this architecture is missing.

CI (`.github/workflows/ci.yml`) calls `bun run check`, so local green and CI
green mean the same thing. Bun is pinned through `packageManager`; actions are
pinned to commit SHAs; Dependabot opens grouped weekly updates.

### Troubleshooting: every page returns HTTP 500 on localhost

If the dev server boots but every route is a 500 and the log says
`Cannot find module '../lightningcss.darwin-x64.node'`, Node is running under
Rosetta on an Apple Silicon Mac. `bun install` only fetches the native
`lightningcss-darwin-arm64` binary, so an x86_64 Node process cannot load it.
Do not add the x64 binary as a dependency (that was tried and reverted as M-13);
fix the launch environment instead:

- Check with `node -p process.arch` from the same shell or launcher that starts
  the app. It must print `arm64`.
- A universal Node such as `/usr/local/bin/node` picks the x86_64 slice whenever
  its parent was launched with "Open using Rosetta". Untick that in Finder's
  Get Info for the launcher app, or prefix the command with `arch -arm64`.
- Next 16 keeps a per-project dev lock. A broken server left on port 3000 makes
  every other `next dev` here (including `bun run smoke`) exit with code 1
  until it is killed. The smoke script now names the PID holding the lock.
- One run under Rosetta poisons the Turbopack dev cache: the failed x64 CSS
  transform is cached, so pages keep returning 500 even after Node runs
  natively. Delete `.next/dev` once and start again.
- `bun run dev` runs `scripts/preflight.mjs` first and refuses to start under
  Rosetta, so this failure now surfaces as a one-line error instead of 500s.

### Architecture

| Path | Purpose |
|---|---|
| `src/lib/probe.ts` | Async, argv-based system probes with typed outcomes (`ok` / `timeout` / `denied` / `unsupported` / `failed`) |
| `src/lib/sampler.ts` | Server-owned sampling, history window and alert tracking |
| `src/lib/cleanup-targets.ts` | The cleanup catalogue and permitted deletion roots |
| `src/lib/guard.ts` | Loopback Host/Origin enforcement, applied per handler |
| `src/lib/scoring.ts` | Health and privacy rubrics, unit-tested against fixtures |
| `src/lib/schemas.ts` | Runtime validation of every API response |
| `src/hooks/use-polling.ts` | Completion-driven polling with abort, overlap and visibility guards |
| `scripts/qa-gate.mjs` | Phase-scoped quality gates |

| Endpoint | Purpose |
|---|---|
| `GET /api/stats` | CPU, memory, swap, disk, load, processes. Returns 503 when core collection fails |
| `GET /api/scan` | Health scan — browsers, Electron apps, bloatware, hogs, startup items |
| `GET /api/cleanup` | Cleanup scan — measured targets with opaque ids |
| `GET /api/privacy` | Privacy scan — connections, permissions, persistence |
| Server Actions | `killProcess(pid)`, `cleanupItem(id)`, `stopServer()` |

Every route and action calls `assertLocalRequest()` directly. This is deliberate: the Next.js versions this app has targeted have carried repeated middleware/proxy bypass advisories, and a routing bypass must not become an authorisation bypass.

## Security

`AUDIT_FIX_PLAN.md` records the full audit and remediation history, including the resolved critical finding (C-01: a client-supplied shell command reaching `execSync` through a bypassable regex allowlist).

Current posture:
- No client-supplied string reaches a shell. Deletion uses filesystem APIs with containment checks and symlink rejection.
- Loopback binding plus per-handler `Host`/`Origin` enforcement.
- CSP, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, and `no-store` on all system JSON.
- Zero high or critical advisories reachable from production dependencies.

Report anything you find via GitHub issues.

## License

MIT — see [LICENSE](LICENSE).
