# System Monitor

Lightweight macOS system monitor, process manager, and security dashboard. Real-time stats, disk cleanup, and privacy scanning — all from your browser.

Built with Next.js, shadcn/ui, and Geist Mono. Runs locally — no external services, no data leaves your machine.

## Features

### Real-Time Dashboard
- **Live system stats** — CPU, memory, swap, disk, and load average with color-coded status indicators
- **Sparkline history charts** — 5-minute rolling graphs for CPU, memory, swap, and load with warn/critical threshold lines
- **Process table** — top 20 processes sorted by CPU with color-coded hot indicators
- **Process alerts** — automatic detection of processes stuck above 50% CPU with kill button
- **Kill processes** — hover any row to kill stuck/runaway processes (user-owned only, SIGTERM with SIGKILL escalation)
- **Auto-refresh** — configurable 1s/3s/5s/10s polling

### System Scan
- **Bloatware detection** — flags antivirus suites, Adobe background services, CleanMyMac, MacKeeper, and other resource-draining software
- **Electron app audit** — counts all Electron/Chromium apps and their combined memory footprint
- **Duplicate browser detection** — warns when running multiple browsers simultaneously
- **Resource hog identification** — flags processes with excessive CPU or memory usage
- **Startup item audit** — lists third-party launch agents/daemons running on every boot
- **Health score** — composite 0-100 score based on all findings

### Disk Cleanup
- **Cache scanning** — app caches, Homebrew, npm, Bun, pip, CocoaPods, Xcode DerivedData
- **Log cleanup** — user and system logs, crash reports
- **Stale file detection** — old Downloads (30+ days), Trash, mail attachment caches, iOS backups
- **Per-item cleaning** — confirm and clean individual categories with size and file count
- **Safety levels** — safe (caches), low (system logs), medium (downloads/backups requiring review)
- **Allowlisted commands** — only pre-approved cleanup patterns can execute

### Privacy Scanner
- **Active tracker detection** — monitors outbound connections against known tracking domains (Google Ads, Facebook, TikTok, Hotjar, FullStory, Mixpanel, Segment, and 30+ others)
- **Suspicious process detection** — scans for keyloggers, spyware, sniffers, and RATs
- **Permission audit** — checks which apps have accessibility, screen recording, input monitoring, camera, microphone, contacts, and location access via the TCC database
- **Persistence check** — identifies unrecognized launch agents/daemons that auto-start on boot
- **Network activity analysis** — reports processes with unusually high outbound connection counts
- **Apple telemetry reporting** — shows macOS diagnostic data connections
- **Browser tracking audit** — extension count, cookie database size, and history per browser
- **Privacy score** — composite 0-100 score based on findings

## Quick Start

```bash
git clone https://github.com/TheSmilemakers/system-monitor.git
cd system-monitor
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

### With npm

```bash
npm install
npm run dev
```

## macOS Desktop App (Optional)

Create a clickable app icon that starts the server and opens your browser:

```bash
mkdir -p ~/Desktop/SystemMonitor.app/Contents/MacOS

cat > ~/Desktop/SystemMonitor.app/Contents/MacOS/launch << 'EOF'
#!/bin/bash
PROJECT_DIR="$HOME/projects/system-monitor"  # adjust to your clone path
PORT=3000
if lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://localhost:$PORT"
  exit 0
fi
cd "$PROJECT_DIR"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
nohup bun run dev --port $PORT > "$PROJECT_DIR/.monitor.log" 2>&1 &
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:$PORT 2>/dev/null && break
  sleep 0.5
done
open "http://localhost:$PORT"
EOF

chmod +x ~/Desktop/SystemMonitor.app/Contents/MacOS/launch
```

Double-click **SystemMonitor** on your Desktop to launch.

## Architecture

| Endpoint | Purpose |
|----------|---------|
| `/api/stats` | Real-time CPU, memory, swap, disk, load, processes. Maintains in-memory history buffer and process alert tracking |
| `/api/scan` | System health scan — bloatware, Electron apps, resource hogs, startup items |
| `/api/cleanup` | Disk cleanup scan — caches, logs, stale files with per-item size and file counts |
| `/api/privacy` | Privacy scan — network trackers, TCC permissions, suspicious processes, browser data |
| Server Actions | `killProcess()`, `stopServer()`, `cleanupItem()` with allowlisted command execution |

## Requirements

- macOS (uses macOS-specific system commands: `top`, `vm_stat`, `ps`, `sysctl`, `lsof`, `sqlite3`)
- Node.js 18+ or Bun

## License

MIT
