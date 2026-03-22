# System Monitor

Lightweight macOS system monitor dashboard with real-time stats and process management.

Built with Next.js, shadcn/ui, and Geist Mono. Runs locally — no external services needed.

## Features

- **Real-time system stats** — CPU, memory, swap, disk, load average
- **Process table** — top 20 processes sorted by CPU with color-coded hot indicators
- **Kill processes** — hover any row to kill stuck/runaway processes (user-owned only)
- **Status indicators** — green/amber/red dots with animated pulse for critical states
- **Auto-refresh** — configurable 1s/3s/5s/10s polling
- **Stop server** — built-in button to shut down the monitor
- **Dark mode** — full dark UI with Geist Mono typography

## Quick Start

```bash
git clone https://github.com/rajandangi/system-monitor.git
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

## How It Works

- **`/api/stats`** — Route handler that runs `top`, `vm_stat`, `ps`, `df`, `sysctl` to collect system metrics
- **Server Action** — `killProcess()` sends SIGTERM (escalates to SIGKILL), only for processes owned by the current user
- **Client** — Polls the stats API at the configured interval and renders with shadcn/ui

## Requirements

- macOS (uses macOS-specific system commands)
- Node.js 18+ or Bun

## License

MIT
