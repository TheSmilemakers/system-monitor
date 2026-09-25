import os from "node:os";

import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { hasValue, isOk, probe, type ProbeStatus } from "@/lib/probe";
import { remoteAddressOf, resolveAll } from "@/lib/resolve-host";
import { privacyScore } from "@/lib/scoring";
import { singleFlight } from "@/lib/single-flight";

/**
 * Privacy scan.
 *
 * Tracker detection now correlates connections against *resolved hostnames*
 * (H-04). Addresses that will not resolve are reported as `unknown` rather than
 * silently treated as clean, and every probe failure — notably the TCC database,
 * which is unreadable without Full Disk Access — is surfaced instead of being
 * swallowed into a perfect score (H-03).
 */

const KNOWN_TRACKERS: Record<
  string,
  { category: string; description: string; severity: "high" | "medium" | "low" }
> = {
  "google-analytics": {
    category: "Analytics",
    description: "Google Analytics",
    severity: "medium",
  },
  googleads: { category: "Ads", description: "Google Ads", severity: "high" },
  doubleclick: { category: "Ads", description: "Google DoubleClick", severity: "high" },
  "graph.facebook": { category: "Social", description: "Facebook Graph API", severity: "high" },
  facebook: { category: "Social", description: "Facebook/Meta", severity: "high" },
  fbcdn: { category: "Social", description: "Facebook CDN", severity: "medium" },
  crashlytics: {
    category: "Crash Reporting",
    description: "Firebase Crashlytics",
    severity: "low",
  },
  "app-measurement": {
    category: "Analytics",
    description: "Firebase Analytics",
    severity: "medium",
  },
  amplitude: { category: "Analytics", description: "Amplitude", severity: "medium" },
  mixpanel: { category: "Analytics", description: "Mixpanel", severity: "medium" },
  segment: { category: "Analytics", description: "Segment", severity: "medium" },
  sentry: { category: "Error Tracking", description: "Sentry", severity: "low" },
  hotjar: { category: "Session Recording", description: "Hotjar", severity: "high" },
  fullstory: { category: "Session Recording", description: "FullStory", severity: "high" },
  mouseflow: { category: "Session Recording", description: "Mouseflow", severity: "high" },
  smartlook: { category: "Session Recording", description: "Smartlook", severity: "high" },
  appsflyer: { category: "Attribution", description: "AppsFlyer", severity: "medium" },
  adjust: { category: "Attribution", description: "Adjust", severity: "medium" },
  branch: { category: "Attribution", description: "Branch", severity: "medium" },
  newrelic: { category: "APM", description: "New Relic", severity: "low" },
  datadog: { category: "APM", description: "Datadog", severity: "low" },
  scorecardresearch: { category: "Analytics", description: "comScore", severity: "medium" },
  quantserve: { category: "Analytics", description: "Quantcast", severity: "medium" },
  tiktok: { category: "Social", description: "TikTok", severity: "high" },
  bytedance: { category: "Social", description: "ByteDance", severity: "high" },
  snapchat: { category: "Social", description: "Snapchat", severity: "medium" },
};

const APPLE_TELEMETRY = ["xp.apple.com", "metrics.apple.com", "diagnostics.apple.com"];

const TCC_CATEGORIES = [
  {
    service: "kTCCServiceAccessibility",
    name: "Accessibility (can observe keystrokes)",
    highRisk: true,
  },
  { service: "kTCCServiceScreenCapture", name: "Screen Recording", highRisk: true },
  { service: "kTCCServiceListenEvent", name: "Input Monitoring", highRisk: true },
  { service: "kTCCServiceCamera", name: "Camera", highRisk: false },
  { service: "kTCCServiceMicrophone", name: "Microphone", highRisk: false },
  { service: "kTCCServiceAddressBook", name: "Contacts", highRisk: false },
  { service: "kTCCServiceCalendar", name: "Calendar", highRisk: false },
  { service: "kTCCServicePhotos", name: "Photos", highRisk: false },
];

export interface PrivacyFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  detail: string;
  items: string[];
  recommendation: string;
}

async function scan() {
  const home = os.homedir();
  const findings: PrivacyFinding[] = [];
  const unavailable: { check: string; reason: ProbeStatus }[] = [];

  const [lsofRes, psRes, userAgentsRes, sysAgentsRes, daemonsRes] = await Promise.all([
    probe("lsof", ["-i", "-nP"], 15_000),
    probe("ps", ["aux"], 8_000),
    probe("ls", [`${home}/Library/LaunchAgents`]),
    probe("ls", ["/Library/LaunchAgents"]),
    probe("ls", ["/Library/LaunchDaemons"]),
  ]);

  // --- Connections ---
  let connectionCount = 0;
  let resolvedCount = 0;
  let unknownCount = 0;
  let trackerCount = 0;

  if (!hasValue(lsofRes)) {
    unavailable.push({ check: "network connections (lsof)", reason: lsofRes.status });
  } else {
    const conns = lsofRes.value
      .split("\n")
      .filter((l) => l.includes("ESTABLISHED"))
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return { process: parts[0] ?? "?", pid: parts[1] ?? "?", name: parts[8] ?? "" };
      })
      .filter((c) => c.name);

    connectionCount = conns.length;

    const addrs = conns.map((c) => remoteAddressOf(c.name)).filter((a): a is string => a !== null);
    const resolutions = await resolveAll(addrs);

    const grouped = new Map<string, string[]>();
    const appleHits: string[] = [];

    for (const c of conns) {
      const addr = remoteAddressOf(c.name);
      if (!addr) continue;
      const res = resolutions.get(addr);
      if (!res || res.status === "unknown") {
        unknownCount++;
        continue;
      }
      resolvedCount++;
      const host = res.hostnames.join(" ").toLowerCase();

      for (const [pattern, info] of Object.entries(KNOWN_TRACKERS)) {
        if (host.includes(pattern)) {
          trackerCount++;
          const list = grouped.get(info.category) ?? [];
          list.push(`${c.process} (PID ${c.pid}) → ${res.hostnames[0]} — ${info.description}`);
          grouped.set(info.category, list);
          break;
        }
      }
      if (APPLE_TELEMETRY.some((d) => host.includes(d))) {
        appleHits.push(`${c.process} → ${res.hostnames[0]}`);
      }
    }

    for (const [category, items] of grouped) {
      findings.push({
        severity: "high",
        category: "Active Trackers",
        title: `${category}: ${items.length} active connection(s)`,
        detail: items.join("\n"),
        items,
        recommendation: "Block at DNS level (NextDNS, Little Snitch) or quit the app.",
      });
    }

    if (appleHits.length > 0) {
      findings.push({
        severity: "info",
        category: "Apple Telemetry",
        title: `macOS diagnostics (${appleHits.length} connections)`,
        detail: appleHits.join("\n"),
        items: appleHits,
        recommendation:
          "Disable in System Settings → Privacy & Security → Analytics & Improvements.",
      });
    }

    if (unknownCount > 0) {
      // Never present unresolved endpoints as clean.
      findings.push({
        severity: "low",
        category: "Unresolved Endpoints",
        title: `${unknownCount} connection(s) could not be attributed`,
        detail:
          "These remote addresses did not resolve to a hostname, so they could not be checked against the tracker list. They are not known-clean.",
        items: [`${unknownCount} unresolved of ${connectionCount} established`],
        recommendation:
          "Inspect with Little Snitch or a DNS log if the count is unexpectedly high.",
      });
    }
  }

  // --- Suspicious processes ---
  if (!hasValue(psRes)) {
    unavailable.push({ check: "process list (ps)", reason: psRes.status });
  } else {
    const keywords = [
      "keylog",
      "keystroke",
      "spyware",
      "surveillance",
      "sniff",
      "intercept",
      "meterpreter",
      "cobalt",
    ];
    const safe = [
      "screencapture",
      "screenshotservices",
      "activitymonitor",
      "com.apple",
      "windowserver",
      "loginwindow",
      "corespotlight",
      "next-server",
      "system-monitor",
    ];
    const suspicious = psRes.value
      .split("\n")
      .filter((line) => {
        const l = line.toLowerCase();
        if (safe.some((s) => l.includes(s))) return false;
        return keywords.some((k) => l.includes(k)) && !l.includes("grep");
      })
      .map((l) => l.trim().split(/\s+/).slice(10).join(" ").substring(0, 80))
      .filter(Boolean);

    if (suspicious.length > 0) {
      findings.push({
        severity: "critical",
        category: "Suspicious Processes",
        title: `${suspicious.length} process(es) with suspicious names`,
        detail: suspicious.join("\n"),
        items: suspicious,
        recommendation:
          "Investigate immediately — these may observe keystrokes or screen activity.",
      });
    }
  }

  // --- TCC permissions ---
  const tccDb = `${home}/Library/Application Support/com.apple.TCC/TCC.db`;
  let highRiskGrants = 0;
  let tccReadable = true;

  for (const tcc of TCC_CATEGORIES) {
    const res = await probe("sqlite3", [
      tccDb,
      `SELECT client FROM access WHERE service='${tcc.service}' AND auth_value=2`,
    ]);
    if (!isOk(res)) {
      tccReadable = false;
      continue;
    }
    const apps = res.value.split("\n").filter(Boolean);
    if (apps.length === 0) continue;
    if (tcc.highRisk) highRiskGrants += apps.length;

    findings.push({
      severity: tcc.highRisk ? "medium" : "info",
      category: "App Permissions",
      title: `${tcc.name}: ${apps.length} app(s) granted`,
      detail: apps.map((a) => a.split(".").pop() || a).join(", "),
      items: apps,
      recommendation: tcc.highRisk
        ? "Review in System Settings → Privacy & Security and revoke anything unfamiliar."
        : "Normal permissions. Review anything unexpected.",
    });
  }

  if (!tccReadable) {
    // Previously this failure produced no finding at all, which read as "clean".
    unavailable.push({ check: "app permissions (TCC database)", reason: "denied" });
    findings.push({
      severity: "info",
      category: "App Permissions",
      title: "Permission audit unavailable",
      detail:
        "The TCC database is protected by macOS. Without Full Disk Access this check cannot run, so no conclusion can be drawn about granted permissions.",
      items: [tccDb],
      recommendation:
        "Grant Full Disk Access to your terminal in System Settings → Privacy & Security to enable this check.",
    });
  }

  // --- Persistence ---
  const knownVendors = [
    "com.apple.",
    "com.google.",
    "com.microsoft.",
    "com.docker.",
    "com.spotify.",
  ];
  const agents = [
    ...(isOk(userAgentsRes) ? userAgentsRes.value.split("\n") : []),
    ...(isOk(sysAgentsRes) ? sysAgentsRes.value.split("\n") : []),
    ...(isOk(daemonsRes) ? daemonsRes.value.split("\n") : []),
  ]
    .filter(Boolean)
    .filter((f) => f.endsWith(".plist"))
    .filter((f) => !knownVendors.some((v) => f.startsWith(v)));

  if (agents.length > 0) {
    findings.push({
      severity: agents.length > 5 ? "medium" : "low",
      category: "Persistence",
      title: `${agents.length} unrecognised launch agent(s)/daemon(s)`,
      detail: agents.map((a) => a.replace(".plist", "")).join(", "),
      items: agents,
      recommendation: "Check each one. Legitimate apps install these, but so does malware.",
    });
  }

  const order: Record<PrivacyFinding["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const complete = unavailable.length === 0;

  return {
    complete,
    // H-03: no score when the evidence is incomplete.
    privacyScore: complete
      ? privacyScore({
          suspiciousProcesses: findings.filter((f) => f.category === "Suspicious Processes").length,
          highRiskPermissionGrants: highRiskGrants,
          unknownLaunchAgents: agents.length,
          activeTrackers: trackerCount,
        })
      : null,
    unavailable,
    findings,
    connectionCount,
    resolvedCount,
    unknownCount,
    trackerCount,
    timestamp: Date.now(),
  };
}

export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const data = await singleFlight("privacy-scan", scan);
  return NextResponse.json(data);
}
