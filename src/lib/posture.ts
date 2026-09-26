import { hasValue, isOk, probe, type ProbeStatus } from "./probe";

/**
 * Security posture: the annunciator's lamps.
 *
 * Each lamp is one read-only, argv-based probe with a typed outcome. A probe
 * that cannot run yields an "off" lamp that says so; nothing is guessed. The
 * software-update check is slow (tens of seconds even from cache) and may be
 * refused while another process holds the updater, so it refreshes in the
 * background with a long cache and the lamp reads "checking" until it lands.
 */

export type LampState = "ok" | "caution" | "alarm" | "info" | "off";

export interface PostureLamp {
  id: string;
  /** Short, for the strip. */
  label: string;
  state: LampState;
  /** One line under the lamp when opened. */
  summary: string;
  /** What it means and what to do. */
  detail: string;
}

export interface PostureReport {
  complete: boolean;
  unavailable: { check: string; reason: ProbeStatus }[];
  lamps: PostureLamp[];
  timestamp: number;
}

export const XPROTECT_PLIST =
  "/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist";
export const XPROTECT_STALE_DAYS = 30;
export const UPDATES_TTL_MS = 6 * 60 * 60 * 1000;
export const REMOTE_PORTS: Record<number, string> = {
  22: "Remote Login (SSH)",
  5900: "Screen Sharing (VNC)",
  3283: "Remote Management (ARD)",
  548: "File Sharing (AFP)",
  445: "File Sharing (SMB)",
};

// ---------- parsers (exported for tests) ----------

export function parseFirewall(out: string): { enabled: boolean; stealth: boolean } | null {
  const enabled = /Firewall is (enabled|disabled)/i.exec(out);
  if (!enabled) return null;
  return {
    enabled: enabled[1].toLowerCase() === "enabled",
    stealth: /stealth mode is on/i.test(out),
  };
}

export function parseSip(out: string): boolean | null {
  const m = /System Integrity Protection status:\s*(enabled|disabled)/i.exec(out);
  return m ? m[1].toLowerCase() === "enabled" : null;
}

export function parseGatekeeper(out: string): boolean | null {
  if (/assessments enabled/i.test(out)) return true;
  if (/assessments disabled/i.test(out)) return false;
  return null;
}

export function parseFileVault(out: string): boolean | null {
  const m = /FileVault is (On|Off)/i.exec(out);
  return m ? m[1].toLowerCase() === "on" : null;
}

/** Ports with a LISTEN socket bound to every interface (`*.port`), from `netstat -an -p tcp`. */
export function parseListeningPorts(out: string): Set<number> {
  const ports = new Set<number>();
  for (const line of out.split("\n")) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[3] ?? "";
    // Loopback-only listeners are not reachable from the network; skip them.
    if (local.startsWith("127.") || local.startsWith("::1.")) continue;
    const m = /\.(\d+)$/.exec(local);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

export interface SystemExtension {
  teamId: string;
  bundleId: string;
  name: string;
  state: string;
}

/**
 * Parse `kmutil showloaded --list-only` for third-party kernel extensions.
 * Each row names the bundle id followed by its version in parentheses; Apple's
 * own are not events, everything else is, since a kext is code in the kernel.
 */
export function parseKexts(raw: string): string[] {
  const out = new Set<string>();
  for (const line of raw.split("\n")) {
    const m = /\s([A-Za-z][\w-]*(?:\.[\w-]+)+)\s+\(/.exec(line);
    const id = m?.[1];
    if (id && !id.startsWith("com.apple.")) out.add(id);
  }
  return [...out].sort();
}

export function parseSystemExtensions(out: string): SystemExtension[] {
  const items: SystemExtension[] = [];
  for (const line of out.split("\n")) {
    // Rows are tab-separated: enabled  active  teamID  bundleID (version)  name  [state]
    if (!line.includes("\t")) continue;
    const cols = line.split("\t");
    if (cols.length < 5 || cols[2] === "teamID") continue;
    items.push({
      teamId: cols[2].trim(),
      bundleId: cols[3].trim().replace(/\s*\(.*\)$/, ""),
      name: cols[4].trim(),
      state: (cols[5] ?? "").trim().replace(/^\[|\]$/g, ""),
    });
  }
  return items;
}

export function parseSoftwareUpdate(out: string): { pending: string[]; denied: boolean } {
  const pending = [...out.matchAll(/^\s*\*\s*Label:\s*(.+)$/gm)].map((m) => m[1].trim());
  const denied = /Access request was denied|SUMacControllerError/.test(out);
  return { pending, denied };
}

// ---------- background software-update check ----------

interface UpdatesCache {
  result: { pending: string[]; denied: boolean; reason: ProbeStatus } | null;
  expires: number;
  inFlight: Promise<void> | null;
}

const updates: UpdatesCache = { result: null, expires: 0, inFlight: null };

function refreshUpdates(now: number): void {
  if (updates.inFlight || updates.expires > now) return;
  updates.inFlight = probe("softwareupdate", ["-l", "--no-scan"], 90_000)
    .then((res) => {
      const parsed = hasValue(res)
        ? parseSoftwareUpdate(res.value)
        : { pending: [], denied: false };
      updates.result = { ...parsed, reason: res.status };
      updates.expires = Date.now() + UPDATES_TTL_MS;
    })
    .catch(() => {
      updates.result = { pending: [], denied: false, reason: "failed" };
      updates.expires = Date.now() + UPDATES_TTL_MS;
    })
    .finally(() => {
      updates.inFlight = null;
    });
}

/** Test seam. */
export function __resetPosture(): void {
  updates.result = null;
  updates.expires = 0;
  updates.inFlight = null;
}

/** Test seam: wait for a background update check to finish. */
export async function updatesSettled(): Promise<void> {
  while (updates.inFlight) await updates.inFlight;
}

// ---------- the report ----------

export async function posture(now = Date.now()): Promise<PostureReport> {
  const [fwRes, sipRes, gkRes, fvRes, xpVerRes, xpMtimeRes, netRes, sysextRes, kmRes] =
    await Promise.all([
      probe("/usr/libexec/ApplicationFirewall/socketfilterfw", [
        "--getglobalstate",
        "--getstealthmode",
      ]),
      probe("csrutil", ["status"]),
      probe("spctl", ["--status"]),
      probe("fdesetup", ["status"]),
      probe("plutil", ["-extract", "CFBundleShortVersionString", "raw", XPROTECT_PLIST]),
      probe("stat", ["-f", "%m", XPROTECT_PLIST]),
      probe("netstat", ["-an", "-p", "tcp"]),
      probe("systemextensionsctl", ["list"]),
      probe("kmutil", ["showloaded", "--list-only", "--no-kernel-components"], 15_000),
    ]);
  refreshUpdates(now);

  const unavailable: PostureReport["unavailable"] = [];
  const lamps: PostureLamp[] = [];
  const off = (id: string, label: string, check: string, reason: ProbeStatus): PostureLamp => {
    unavailable.push({ check, reason });
    return {
      id,
      label,
      state: "off",
      summary: `Could not check (${reason})`,
      detail: `The ${check} probe did not run. The lamp is dark rather than green: no conclusion has been drawn.`,
    };
  };

  // Firewall
  const fw = hasValue(fwRes) ? parseFirewall(fwRes.value) : null;
  lamps.push(
    fw === null
      ? off(
          "firewall",
          "Firewall",
          "application firewall",
          fwRes.status === "ok" ? "failed" : fwRes.status,
        )
      : {
          id: "firewall",
          label: "Firewall",
          state: fw.enabled ? "ok" : "caution",
          summary: fw.enabled
            ? `On${fw.stealth ? ", stealth mode" : ""}`
            : "Off: incoming connections are not filtered",
          detail: fw.enabled
            ? "The application firewall filters incoming connections per app. Stealth mode also drops probe packets so the Mac does not answer pings."
            : "Turn it on in System Settings, Network, Firewall. It blocks unsolicited incoming connections to apps that have not been allowed.",
        },
  );

  // SIP
  const sip = hasValue(sipRes) ? parseSip(sipRes.value) : null;
  lamps.push(
    sip === null
      ? off(
          "sip",
          "SIP",
          "System Integrity Protection",
          sipRes.status === "ok" ? "failed" : sipRes.status,
        )
      : {
          id: "sip",
          label: "SIP",
          state: sip ? "ok" : "alarm",
          summary: sip ? "Enabled" : "Disabled: system files are writable",
          detail: sip
            ? "System Integrity Protection stops even root from modifying protected system files and injecting into system processes."
            : "With SIP off, malware with root can alter macOS itself. Re-enable it from Recovery: csrutil enable.",
        },
  );

  // Gatekeeper
  const gk = hasValue(gkRes) ? parseGatekeeper(gkRes.value) : null;
  lamps.push(
    gk === null
      ? off(
          "gatekeeper",
          "Gatekeeper",
          "Gatekeeper",
          gkRes.status === "ok" ? "failed" : gkRes.status,
        )
      : {
          id: "gatekeeper",
          label: "Gatekeeper",
          state: gk ? "ok" : "alarm",
          summary: gk ? "Assessments enabled" : "Assessments disabled",
          detail: gk
            ? "Downloaded apps are checked for a valid signature and notarisation before they first run."
            : "Any downloaded app runs without a signature check. Re-enable with: sudo spctl --master-enable.",
        },
  );

  // FileVault
  const fv = hasValue(fvRes) ? parseFileVault(fvRes.value) : null;
  lamps.push(
    fv === null
      ? off("filevault", "FileVault", "FileVault", fvRes.status === "ok" ? "failed" : fvRes.status)
      : {
          id: "filevault",
          label: "FileVault",
          state: fv ? "ok" : "caution",
          summary: fv ? "Disk encrypted" : "Disk not encrypted",
          detail: fv
            ? "The startup disk is encrypted; data is unreadable without the login password or recovery key."
            : "Anyone with the hardware can read the disk. Turn on FileVault in System Settings, Privacy & Security.",
        },
  );

  // XProtect
  const version = isOk(xpVerRes) ? xpVerRes.value.trim() : null;
  const mtime = isOk(xpMtimeRes) ? Number.parseInt(xpMtimeRes.value.trim(), 10) * 1000 : Number.NaN;
  if (version === null || !Number.isFinite(mtime)) {
    lamps.push(
      off(
        "xprotect",
        "XProtect",
        "XProtect definitions",
        xpVerRes.status === "ok" ? xpMtimeRes.status : xpVerRes.status,
      ),
    );
  } else {
    const ageDays = Math.floor((now - mtime) / 86_400_000);
    const stale = ageDays > XPROTECT_STALE_DAYS;
    lamps.push({
      id: "xprotect",
      label: "XProtect",
      state: stale ? "caution" : "ok",
      summary: `Definitions ${version}, updated ${ageDays} day${ageDays === 1 ? "" : "s"} ago`,
      detail: stale
        ? `Apple's malware definitions have not changed in ${ageDays} days. They normally update silently every few days; check that automatic security updates are on in System Settings, Software Update.`
        : "XProtect is Apple's built-in malware scanner. Its definitions update silently through the background update mechanism.",
    });
  }

  // Remote access
  if (hasValue(netRes)) {
    const ports = parseListeningPorts(netRes.value);
    const open = Object.entries(REMOTE_PORTS)
      .filter(([port]) => ports.has(Number(port)))
      .map(([, name]) => name);
    lamps.push({
      id: "remote",
      label: "Remote access",
      state: open.length === 0 ? "ok" : "caution",
      summary:
        open.length === 0 ? "No remote-access services listening" : `Listening: ${open.join(", ")}`,
      detail:
        open.length === 0
          ? "No SSH, screen-sharing or file-sharing listener is bound to the network."
          : "These services accept connections from the network. If you did not turn them on, disable them in System Settings, General, Sharing.",
    });
  } else {
    lamps.push(off("remote", "Remote access", "listening sockets (netstat)", netRes.status));
  }

  // System extensions, and legacy kernel extensions (code in the kernel itself).
  if (hasValue(sysextRes)) {
    const exts = parseSystemExtensions(sysextRes.value).filter((e) => /activated/.test(e.state));
    const kexts = hasValue(kmRes) ? parseKexts(kmRes.value) : [];
    const parts = [
      exts.length === 0
        ? "No third-party system extensions"
        : `${exts.length} active: ${exts.map((e) => e.name).join(", ")}`,
      kexts.length > 0
        ? `${kexts.length} kernel extension${kexts.length === 1 ? "" : "s"} loaded: ${kexts.join(", ")}`
        : null,
    ].filter((p): p is string => p !== null);
    lamps.push({
      id: "sysext",
      label: "Extensions",
      state: kexts.length > 0 ? "caution" : exts.length === 0 ? "ok" : "info",
      summary: parts.join("; "),
      detail:
        "System extensions run with deep access (network filters, endpoint security, drivers). Each should belong to software you installed on purpose; manage them in System Settings, General, Login Items & Extensions. A kernel extension is older and riskier still: it runs inside the kernel, and Apple silicon needs reduced security to load one.",
    });
  } else {
    lamps.push(off("sysext", "Extensions", "system extensions", sysextRes.status));
  }

  // Software updates (background)
  const u = updates.result;
  if (!u) {
    lamps.push({
      id: "updates",
      label: "Updates",
      state: "off",
      summary: "Checking",
      detail:
        "The software update list is being read in the background. It can take a minute the first time.",
    });
  } else if (u.pending.length > 0) {
    lamps.push({
      id: "updates",
      label: "Updates",
      state: "caution",
      summary: `${u.pending.length} pending: ${u.pending.slice(0, 3).join(", ")}${u.pending.length > 3 ? "…" : ""}`,
      detail:
        "Security fixes ship in these updates. Install from System Settings, General, Software Update.",
    });
  } else if (u.denied || u.reason !== "ok") {
    lamps.push({
      id: "updates",
      label: "Updates",
      state: "off",
      summary: "Could not read the update list",
      detail:
        "Another process held the software updater, or the tool failed. The lamp stays dark; it will retry within six hours.",
    });
  } else {
    lamps.push({
      id: "updates",
      label: "Updates",
      state: "ok",
      summary: "Up to date (cached list)",
      detail: "No pending updates in the cached software-update list.",
    });
  }

  return { complete: unavailable.length === 0, unavailable, lamps, timestamp: now };
}
