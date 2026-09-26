#!/bin/bash
# Install System Monitor on this Mac: fetch the source, build it, and put a
# native app in ~/Applications. Everything stays on the machine.
#
#   curl -fsSL https://raw.githubusercontent.com/TheSmilemakers/system-monitor/main/scripts/install.sh | bash
#
# Or from a checkout:  scripts/install.sh
#
# What it needs: an Apple silicon Mac on macOS 13 or later, the Command Line
# Tools (it offers to install them), and Bun (it installs it if missing).
# What it does: clones or updates ~/.local/share/system-monitor (SM_HOME to
# change), installs dependencies, builds the app, compiles the native shell
# into ~/Applications/System Monitor.app (SM_APP to change), points the shell
# at the checkout, and opens it. Built here, the app carries no quarantine
# flag, so Gatekeeper has nothing to say about it.
set -euo pipefail

REPO="${SM_REPO:-https://github.com/TheSmilemakers/system-monitor.git}"
HOME_DIR="${SM_HOME:-$HOME/.local/share/system-monitor}"
APP="${SM_APP:-$HOME/Applications/System Monitor.app}"
SUPPORT="$HOME/Library/Application Support/system-monitor"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "System Monitor runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "System Monitor needs an Apple silicon Mac (this one is $(uname -m))."
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 13 ] || fail "macOS 13 or later is needed (this is $(sw_vers -productVersion))."

if ! xcode-select -p >/dev/null 2>&1; then
  say "The Command Line Tools are needed (clang, git). macOS will offer to install them."
  xcode-select --install || true
  fail "Run this script again once the Command Line Tools have finished installing."
fi
command -v clang >/dev/null || fail "clang is missing; install the Command Line Tools (xcode-select --install) and run again."

export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null; then
  say "Installing Bun (the JavaScript runtime the app runs on)."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null || fail "Bun did not install; see https://bun.sh"

if [ -d "$HOME_DIR/.git" ]; then
  say "Updating $HOME_DIR"
  git -C "$HOME_DIR" pull --ff-only
else
  say "Fetching the source into $HOME_DIR"
  mkdir -p "$(dirname "$HOME_DIR")"
  git clone --depth 1 "$REPO" "$HOME_DIR"
fi

cd "$HOME_DIR"
say "Installing dependencies"
arch -arm64 bun install --frozen-lockfile
say "Building the app (about a minute)"
arch -arm64 bun run build

say "Building the native shell into $APP"
mkdir -p "$(dirname "$APP")" "$SUPPORT"
printf '%s\n' "$HOME_DIR" > "$SUPPORT/project"
scripts/build-shell.sh "$APP"

say "Done. Opening System Monitor."
open -a "$APP"
cat <<EOF

System Monitor is in $APP (drag it to the Dock if you like).

Two permissions make it complete, both under System Settings:
  Privacy & Security > Full Disk Access: add System Monitor, so it can read
    which apps hold Accessibility, Screen Recording and Full Disk Access.
  Notifications: allow System Monitor, so alarms appear as banners.

To update later, run this script again. To remove it: delete the app,
$HOME_DIR and "$SUPPORT".
EOF
