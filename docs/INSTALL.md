# Installing System Monitor on your Mac

System Monitor is a local security and health monitor for macOS: what is
running and who signed it, what is listening and where connections go, which
apps hold which permissions, what starts at login, and what has changed since
you last looked. It runs entirely on your Mac and sends nothing anywhere.

It is not a download-and-double-click app yet. It is built on your Mac from
source, which takes about two minutes and has one advantage: an app built where
it runs carries no quarantine flag, so macOS opens it without the "unidentified
developer" dance.

## What you need

- An Apple silicon Mac (M1 or later) on macOS 13 or later.
- Apple's Command Line Tools. The installer offers to install them if they are
  missing; macOS shows a dialog, and you run the installer again when it is done.
- About 600 MB of disk for the source, its dependencies and the build.

The installer also installs [Bun](https://bun.sh), the JavaScript runtime the
app runs on, if you do not have it.

## Install

Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/TheSmilemakers/system-monitor/main/scripts/install.sh | bash
```

It fetches the source into `~/.local/share/system-monitor`, builds the app,
compiles the native shell into `~/Applications/System Monitor.app`, and opens
it. Read the script first if you like; it is short and does only what this page
says. To put the app on the Desktop instead, set `SM_APP` first:

```bash
SM_APP="$HOME/Desktop/System Monitor.app" bash -c "$(curl -fsSL https://raw.githubusercontent.com/TheSmilemakers/system-monitor/main/scripts/install.sh)"
```

The app sits in the dock and the menu bar. Closing its window leaves the
monitor running in the menu bar, where the icon shows the count of alarms you
have not seen and its menu brings the window back or quits. Drag it to the
Dock if you want it one click away.

Then two permissions, both in System Settings:

- **Privacy & Security, Full Disk Access**: add System Monitor. Without it the
  Permissions tab cannot read which apps hold Accessibility, Screen Recording
  and Full Disk Access, and says so rather than pretending nothing does.
- **Notifications**: allow System Monitor, so alarms appear as banners. They
  land in the Timeline tab either way.

## Updating

Run the same command again. It pulls the latest source and rebuilds. The app
also rebuilds itself on launch when its source is newer than its build.

## Removing

Delete `~/Applications/System Monitor.app`, `~/.local/share/system-monitor`
and `~/Library/Application Support/system-monitor` (the monitor's baseline,
timeline and settings).

## If you use an AI coding agent

Paste this into Claude Code, Codex or a similar agent on the Mac in question:

> Install System Monitor from https://github.com/TheSmilemakers/system-monitor
> on this Mac. Clone it to `~/.local/share/system-monitor`, run
> `bun install --frozen-lockfile` and `bun run build` there (install Bun from
> bun.sh first if it is missing, and the Command Line Tools if `clang` is
> missing), then run `scripts/build-shell.sh "$HOME/Applications/System
> Monitor.app"`, write the checkout path to
> `~/Library/Application Support/system-monitor/project`, and open the app.
> Everything runs locally; do not change the loopback binding. Afterwards tell
> me to grant Full Disk Access and Notifications to System Monitor in System
> Settings.

That is exactly what `scripts/install.sh` does; the prompt is for people who
would rather watch an agent do it than run a script they have not read.

## Sharing it from a website

A download link would need the app to be self-contained (the built app and
its runtime inside the bundle) and signed with an Apple Developer ID and
notarised, or every recipient has to override Gatekeeper by hand. That is a
packaging step this project has not taken; until it does, the install command
above is the way to share it.

## Trust

- The app binds to 127.0.0.1 only and refuses requests whose Host is not
  loopback. Nothing on your network can reach it.
- Every figure is read with macOS's own command-line tools (`ps`, `lsof`,
  `netstat`, `codesign`, `sqlite3` and friends). No kernel extension, no
  daemon, nothing installed system-wide.
- The only things it can change on your Mac are the ones you click: terminate,
  suspend or renice a process, and delete a cleanup item, each confirmed.
- The source is public and short enough to read.
