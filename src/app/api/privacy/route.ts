import { execSync } from "child_process";
import { NextResponse } from "next/server";

function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 15000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// Known telemetry/tracking domains and what they do
const KNOWN_TRACKERS: Record<string, { category: string; description: string; severity: "high" | "medium" | "low" }> = {
  // Analytics
  "google-analytics": { category: "Analytics", description: "Google Analytics — web/app usage tracking", severity: "medium" },
  "googleads": { category: "Ads", description: "Google Ads tracking", severity: "high" },
  "doubleclick": { category: "Ads", description: "Google DoubleClick ad network", severity: "high" },
  "facebook.com": { category: "Social Tracking", description: "Facebook/Meta tracking pixel", severity: "high" },
  "graph.facebook": { category: "Social Tracking", description: "Facebook Graph API — social data", severity: "high" },
  "fbcdn": { category: "Social Tracking", description: "Facebook CDN — tracking assets", severity: "medium" },
  "analytics.google": { category: "Analytics", description: "Google Analytics endpoint", severity: "medium" },
  "crashlytics": { category: "Crash Reporting", description: "Firebase Crashlytics — crash data", severity: "low" },
  "app-measurement": { category: "Analytics", description: "Firebase Analytics — app usage data", severity: "medium" },
  "amplitude": { category: "Analytics", description: "Amplitude — product analytics", severity: "medium" },
  "mixpanel": { category: "Analytics", description: "Mixpanel — user behavior tracking", severity: "medium" },
  "segment.io": { category: "Analytics", description: "Segment — data pipeline to multiple trackers", severity: "medium" },
  "segment.com": { category: "Analytics", description: "Segment — data pipeline", severity: "medium" },
  "sentry.io": { category: "Error Tracking", description: "Sentry — error/crash reporting", severity: "low" },
  "hotjar": { category: "Session Recording", description: "Hotjar — session recording and heatmaps", severity: "high" },
  "fullstory": { category: "Session Recording", description: "FullStory — session replay", severity: "high" },
  "mouseflow": { category: "Session Recording", description: "Mouseflow — session recording", severity: "high" },
  "smartlook": { category: "Session Recording", description: "Smartlook — session recording", severity: "high" },
  "appsflyer": { category: "Attribution", description: "AppsFlyer — mobile attribution tracking", severity: "medium" },
  "adjust.com": { category: "Attribution", description: "Adjust — mobile attribution", severity: "medium" },
  "branch.io": { category: "Attribution", description: "Branch — deep link attribution", severity: "medium" },
  "newrelic": { category: "APM", description: "New Relic — performance monitoring (sends app data)", severity: "low" },
  "datadog": { category: "APM", description: "Datadog — monitoring (sends system metrics)", severity: "low" },
  "telemetry": { category: "Telemetry", description: "Generic telemetry endpoint", severity: "medium" },
  "tracking": { category: "Tracking", description: "Generic tracking endpoint", severity: "medium" },
  "stats.": { category: "Analytics", description: "Stats collection endpoint", severity: "medium" },
  "pixel": { category: "Tracking Pixel", description: "Tracking pixel endpoint", severity: "high" },
  "adservice": { category: "Ads", description: "Ad serving network", severity: "high" },
  "scorecardresearch": { category: "Analytics", description: "comScore — cross-platform analytics", severity: "medium" },
  "quantserve": { category: "Analytics", description: "Quantcast — audience measurement", severity: "medium" },
  "tiktok": { category: "Social Tracking", description: "TikTok tracking/analytics", severity: "high" },
  "bytedance": { category: "Social Tracking", description: "ByteDance (TikTok parent) — data collection", severity: "high" },
  "snapchat": { category: "Social Tracking", description: "Snapchat tracking pixel", severity: "medium" },
};

// Known legitimate/expected connections
const EXPECTED_CONNECTIONS = [
  "apple.com", "icloud.com", "mzstatic.com", "aaplimg.com", // Apple
  "github.com", "githubusercontent.com", // GitHub
  "localhost", "127.0.0.1", "::1", // Local
  "cloudflare", "fastly", // CDNs
];

interface PrivacyFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  detail: string;
  items: string[];
  recommendation: string;
}

export async function GET() {
  const home = process.env.HOME || "/Users/rajan";
  const findings: PrivacyFinding[] = [];

  // 1. Active network connections — what's phoning home
  const lsofOutput = run("lsof -i -nP 2>/dev/null | grep ESTABLISHED");
  const connections = lsofOutput.split("\n").filter(Boolean).map((line) => {
    const parts = line.split(/\s+/);
    return {
      process: parts[0],
      pid: parts[1],
      user: parts[2],
      destination: parts[8] || "",
    };
  });

  // Match against known trackers
  const trackerConnections: { process: string; pid: string; destination: string; tracker: string; info: typeof KNOWN_TRACKERS[string] }[] = [];
  for (const conn of connections) {
    for (const [pattern, info] of Object.entries(KNOWN_TRACKERS)) {
      if (conn.destination.toLowerCase().includes(pattern.toLowerCase())) {
        trackerConnections.push({ ...conn, tracker: pattern, info });
        break;
      }
    }
  }

  if (trackerConnections.length > 0) {
    const grouped = new Map<string, typeof trackerConnections>();
    for (const tc of trackerConnections) {
      const key = tc.info.category;
      const arr = grouped.get(key) || [];
      arr.push(tc);
      grouped.set(key, arr);
    }

    for (const [category, conns] of grouped) {
      const highSev = conns.some((c) => c.info.severity === "high");
      findings.push({
        severity: highSev ? "high" : "medium",
        category: "Active Trackers",
        title: `${category}: ${conns.length} active connection(s)`,
        detail: conns.map((c) => `${c.process} (PID ${c.pid}) → ${c.destination} — ${c.info.description}`).join("\n"),
        items: conns.map((c) => `${c.process}: ${c.info.description}`),
        recommendation: `These processes are actively sending data. Consider blocking with a DNS-level blocker like NextDNS or Little Snitch.`,
      });
    }
  }

  // 2. DNS queries to tracking domains (recent)
  const dnsCache = run("log show --predicate 'subsystem == \"com.apple.networkd\"' --style compact --last 5m 2>/dev/null | head -100");

  // 3. Processes with suspicious names
  const allProcs = run("ps aux");
  const suspiciousKeywords = ["keylog", "keystroke", "spyware", "surveillance", "sniff", "intercept", "ratpoison", "meterpreter", "cobalt"];
  // Exclude known legitimate macOS processes
  const safeProcesses = [
    "screencapture", "screenshotservices", "activitymonitor", "com.apple",
    "windowserver", "loginwindow", "corespotlight", "systemmonitor",
    "next-server", "system-monitor", "inputmonitor", // our own app
  ];
  const suspiciousProcs: string[] = [];
  for (const line of allProcs.split("\n")) {
    const lower = line.toLowerCase();
    if (safeProcesses.some((s) => lower.includes(s))) continue;
    for (const kw of suspiciousKeywords) {
      if (lower.includes(kw) && !lower.includes("grep")) {
        suspiciousProcs.push(line.split(/\s+/).slice(10).join(" ").substring(0, 80));
        break;
      }
    }
  }

  if (suspiciousProcs.length > 0) {
    findings.push({
      severity: "critical",
      category: "Suspicious Processes",
      title: `${suspiciousProcs.length} process(es) with suspicious names`,
      detail: suspiciousProcs.join("\n"),
      items: suspiciousProcs,
      recommendation: "Investigate these processes immediately. They may be monitoring keystrokes or screen activity.",
    });
  }

  // 4. TCC permissions — apps with access to sensitive data
  const tccCategories = [
    { service: "kTCCServiceAccessibility", name: "Accessibility (can monitor keystrokes)" },
    { service: "kTCCServiceScreenCapture", name: "Screen Recording" },
    { service: "kTCCServiceListenEvent", name: "Input Monitoring (keyboard/mouse)" },
    { service: "kTCCServiceCamera", name: "Camera" },
    { service: "kTCCServiceMicrophone", name: "Microphone" },
    { service: "kTCCServiceAddressBook", name: "Contacts" },
    { service: "kTCCServiceCalendar", name: "Calendar" },
    { service: "kTCCServicePhotos", name: "Photos" },
    { service: "kTCCServiceLocation", name: "Location" },
  ];

  const tccDb = `${home}/Library/Application Support/com.apple.TCC/TCC.db`;
  for (const tcc of tccCategories) {
    const apps = run(`sqlite3 "${tccDb}" "SELECT client FROM access WHERE service='${tcc.service}' AND auth_value=2" 2>/dev/null`);
    const appList = apps.split("\n").filter(Boolean);
    if (appList.length > 0) {
      const isHighRisk = ["Accessibility", "Screen Recording", "Input Monitoring"].some((s) => tcc.name.includes(s));
      findings.push({
        severity: isHighRisk ? "medium" : "info",
        category: "App Permissions",
        title: `${tcc.name}: ${appList.length} app(s) granted`,
        detail: `These apps have ${tcc.name.toLowerCase()} access: ${appList.map((a) => a.split(".").pop() || a).join(", ")}`,
        items: appList,
        recommendation: isHighRisk
          ? "Review these permissions in System Settings → Privacy & Security. Remove access for apps you don't recognize."
          : "Normal permissions. Review if any app seems unexpected.",
      });
    }
  }

  // 5. Unrecognized LaunchAgents/Daemons (potential persistence mechanisms)
  const knownVendors = ["com.apple.", "com.google.", "com.microsoft.", "com.nordvpn.", "com.spotify.", "com.docker."];
  const userAgents = run(`ls ~/Library/LaunchAgents/ 2>/dev/null`).split("\n").filter(Boolean);
  const sysAgents = run(`ls /Library/LaunchAgents/ 2>/dev/null`).split("\n").filter(Boolean);
  const sysDaemons = run(`ls /Library/LaunchDaemons/ 2>/dev/null`).split("\n").filter(Boolean);

  const unknownAgents = [...userAgents, ...sysAgents, ...sysDaemons]
    .filter((f) => !knownVendors.some((v) => f.startsWith(v)))
    .filter((f) => f.endsWith(".plist"));

  if (unknownAgents.length > 0) {
    findings.push({
      severity: unknownAgents.length > 5 ? "medium" : "low",
      category: "Persistence",
      title: `${unknownAgents.length} unrecognized launch agent(s)/daemon(s)`,
      detail: `These run automatically on boot and could be used for tracking: ${unknownAgents.map((a) => a.replace(".plist", "")).join(", ")}`,
      items: unknownAgents,
      recommendation: "Investigate unknown agents. Legitimate apps install these, but so does malware. Check each one.",
    });
  }

  // 6. Outbound connection count per process
  const connCounts = new Map<string, number>();
  for (const conn of connections) {
    connCounts.set(conn.process, (connCounts.get(conn.process) || 0) + 1);
  }
  const heavyPhoners = Array.from(connCounts.entries())
    .filter(([, count]) => count >= 10)
    .sort(([, a], [, b]) => b - a);

  if (heavyPhoners.length > 0) {
    findings.push({
      severity: "low",
      category: "Network Activity",
      title: `${heavyPhoners.length} process(es) with many outbound connections`,
      detail: heavyPhoners.map(([proc, count]) => `${proc}: ${count} connections`).join(", "),
      items: heavyPhoners.map(([proc, count]) => `${proc} (${count} connections)`),
      recommendation: "High connection counts are normal for browsers and cloud apps, but unusual for small utilities. Investigate unfamiliar processes.",
    });
  }

  // 7. Check for known macOS telemetry
  const appleTelemetry = connections.filter((c) =>
    c.destination.includes("xp.apple.com") ||
    c.destination.includes("metrics.apple.com") ||
    c.destination.includes("diagnostics.apple.com")
  );
  if (appleTelemetry.length > 0) {
    findings.push({
      severity: "info",
      category: "Apple Telemetry",
      title: `macOS sending diagnostics to Apple (${appleTelemetry.length} connections)`,
      detail: `Apple collects diagnostic data by default. Processes: ${[...new Set(appleTelemetry.map((c) => c.process))].join(", ")}`,
      items: appleTelemetry.map((c) => `${c.process} → ${c.destination}`),
      recommendation: "You can disable this in System Settings → Privacy & Security → Analytics & Improvements.",
    });
  }

  // 8. Browser tracking profile (cookie databases, extensions)
  const browserProfiles = [
    { name: "Chrome", path: `${home}/Library/Application Support/Google/Chrome/Default` },
    { name: "Brave", path: `${home}/Library/Application Support/BraveSoftware/Brave-Browser/Default` },
    { name: "Firefox", path: `${home}/Library/Application Support/Firefox/Profiles` },
  ];

  for (const browser of browserProfiles) {
    const cookieSize = run(`du -sk "${browser.path}/Cookies" 2>/dev/null | cut -f1`);
    const extensionCount = run(`ls "${browser.path}/Extensions/" 2>/dev/null | wc -l`).trim();
    const historySize = run(`du -sk "${browser.path}/History" 2>/dev/null | cut -f1`);

    if (parseInt(cookieSize) > 0) {
      findings.push({
        severity: "info",
        category: "Browser Data",
        title: `${browser.name}: ${extensionCount} extensions, ${parseInt(cookieSize) > 0 ? `${cookieSize}KB cookies` : "no cookies"}`,
        detail: `Cookies and browsing history can be used for cross-site tracking. History: ${historySize ? `${historySize}KB` : "N/A"}.`,
        items: [`Cookies: ${cookieSize}KB`, `Extensions: ${extensionCount}`, `History: ${historySize || 0}KB`],
        recommendation: `Review extensions in ${browser.name} settings. Remove any you don't recognize. Consider using a tracker blocker like uBlock Origin.`,
      });
    }
  }

  // Sort by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Privacy score
  let privacyScore = 100;
  findings.forEach((f) => {
    if (f.severity === "critical") privacyScore -= 25;
    if (f.severity === "high") privacyScore -= 15;
    if (f.severity === "medium") privacyScore -= 8;
    if (f.severity === "low") privacyScore -= 3;
  });
  privacyScore = Math.max(0, Math.min(100, privacyScore));

  return NextResponse.json({
    privacyScore,
    findings,
    connectionCount: connections.length,
    trackerCount: trackerConnections.length,
    timestamp: Date.now(),
  });
}
