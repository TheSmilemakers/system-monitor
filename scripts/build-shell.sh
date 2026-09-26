#!/bin/bash
# Build the native shell (desktop/shell/main.m) into an app bundle.
#
#   scripts/build-shell.sh [path/to/SystemMonitor.app]
#
# Defaults to ~/Desktop/SystemMonitor.app, keeping that bundle's icon. The old
# bash launcher there is renamed, not removed. Ad-hoc signed, arm64 only, so
# Rosetta cannot apply to it or to the server it starts. Needs the Command
# Line Tools (clang, codesign). Objective-C rather than Swift because a
# Command Line Tools install whose Swift toolchain and SDK disagree (as on a
# Mac with the tools update pending) cannot build Swift at all.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$HOME/Desktop/SystemMonitor.app}"
SRC="$HERE/desktop/shell/main.m"
PLIST="$HERE/desktop/shell/Info.plist"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "compiling $SRC"
clang -O2 -fobjc-arc -fno-modules -target arm64-apple-macos13.0 -Wall \
  -framework AppKit -framework WebKit -framework UserNotifications -framework Foundation \
  -o "$BUILD/SystemMonitor" "$SRC"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Anything else under MacOS must be signed too, so the old bash launcher and
# its backups move out of the bundle rather than staying beside the binary.
BACKUPS="$HOME/Library/Application Support/system-monitor/launcher-backups"
for old in "$APP"/Contents/MacOS/launch*; do
  [ -e "$old" ] || continue
  mkdir -p "$BACKUPS"
  mv "$old" "$BACKUPS/$(basename "$old").$(date +%F-%H%M%S)"
done
cp "$BUILD/SystemMonitor" "$APP/Contents/MacOS/SystemMonitor"
cp "$PLIST" "$APP/Contents/Info.plist"
if [ ! -f "$APP/Contents/Resources/icon.icns" ] && [ -f "$HERE/desktop/shell/icon.icns" ]; then
  cp "$HERE/desktop/shell/icon.icns" "$APP/Contents/Resources/icon.icns"
fi

# Finder metadata on an old bundle makes codesign refuse ("detritus"); strip it.
xattr -cr "$APP"
codesign --force --sign - "$APP"
touch "$APP"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

echo "built $APP"
echo "project: \${SM_PROJECT_DIR}, else $HOME/Library/Application Support/system-monitor/project, else ~/projects/system-monitor"
