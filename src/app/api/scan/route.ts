import { NextResponse } from "next/server";

import { lookupKnowledgeBase } from "@/lib/explain";
import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { hasValue, isOk, probe, type ProbeStatus } from "@/lib/probe";
import { parsePsAux } from "@/lib/sampler";
import { healthScore } from "@/lib/scoring";
import { singleFlight } from "@/lib/single-flight";

/**
 * System health scan.
 *
 * Categories are mutually exclusive (M-14): Chromium *browsers* are no longer
 * also counted as *Electron apps*, which previously inflated both the findings
 * list and the health score by counting the same processes twice.
 */

export interface ScanProcessRef {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  rss: number;
}

export interface Finding {
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  processes: ScanProcessRef[];
  recommendation: string;
}

/** Vendor -> matcher. One finding per vendor, so a suite is not counted six times (M-15). */
const BLOAT_VENDORS: { vendor: string; patterns: string[]; reason: string }[] = [
  {
    vendor: "Adobe",
    patterns: [
      "Adobe Creative Cloud",
      "AdobeIPCBroker",
      "Adobe Desktop Service",
      "com.adobe.acc",
      "CCLibrary",
      "Core Sync",
    ],
    reason: "Adobe background services run even when no Adobe app is open",
  },
  {
    vendor: "Third-party antivirus",
    patterns: [
      "com.avast",
      "com.avg",
      "com.mcafee",
      "com.norton",
      "com.symantec",
      "com.trendmicro",
      "com.kaspersky",
      "com.malwarebytes",
    ],
    reason: "macOS ships XProtect and Gatekeeper; third-party real-time scanning adds overhead",
  },
  {
    vendor: "System cleaners",
    patterns: ["CleanMyMac", "MacKeeper", "com.macpaw"],
    reason: "System cleaners run background agents continuously",
  },
  {
    vendor: "Updaters",
    patterns: ["com.google.keystone", "Google Software Update", "com.microsoft.autoupdate"],
    reason: "Update agents poll frequently and can be run manually instead",
  },
];

/** Genuine Electron/Chromium-embedding applications — browsers excluded (M-14). */
const ELECTRON_APPS: Record<string, string> = {
  Slack: "Slack",
  Discord: "Discord",
  "Microsoft Teams": "Microsoft Teams",
  "Visual Studio Code": "VS Code",
  "Code - Insiders": "VS Code Insiders",
  "Code Helper": "VS Code",
  Spotify: "Spotify",
  Figma: "Figma",
  Notion: "Notion",
  "1Password": "1Password",
  Obsidian: "Obsidian",
  Postman: "Postman",
  "GitHub Desktop": "GitHub Desktop",
  Loom: "Loom",
  Signal: "Signal",
  Electron: "Electron app",
};

/** Chromium/Gecko browsers — a separate category from Electron apps (M-14). */
const CHROMIUM_BROWSERS = [
  "Google Chrome",
  "Brave",
  "Firefox",
  "Safari",
  "Arc",
  "Vivaldi",
  "Opera",
  "Microsoft Edge",
];

async function scan() {
  const [psRes, whoRes, swapRes, userAgentsRes, sysAgentsRes, daemonsRes] = await Promise.all([
    probe("ps", ["aux"], 8_000),
    probe("whoami", []),
    probe("sysctl", ["vm.swapusage"]),
    probe("ls", [`${process.env.HOME ?? ""}/Library/LaunchAgents`]),
    probe("ls", ["/Library/LaunchAgents"]),
    probe("ls", ["/Library/LaunchDaemons"]),
  ]);

  const unavailable: { check: string; reason: ProbeStatus }[] = [];
  if (!isOk(psRes)) unavailable.push({ check: "process list", reason: psRes.status });
  if (!isOk(swapRes)) unavailable.push({ check: "swap usage", reason: swapRes.status });

  // Without a process list there is nothing to score.
  if (!hasValue(psRes)) {
    return {
      complete: false,
      healthScore: null,
      unavailable,
      findings: [] as Finding[],
      summary: null,
      timestamp: Date.now(),
    };
  }

  const rawLines = psRes.value.split("\n").slice(1).filter(Boolean);
  const fullPaths = rawLines.map((l) => l.trim().split(/\s+/).slice(10).join(" "));
  const procs = parsePsAux(psRes.value, Number.MAX_SAFE_INTEGER);
  const withPath = procs.map((p, i) => ({ ...p, fullPath: fullPaths[i] ?? "" }));

  const currentUser = isOk(whoRes) ? whoRes.value : "";
  const findings: Finding[] = [];
  const claimed = new Set<number>();

  const toRef = (p: (typeof withPath)[number]): ScanProcessRef => ({
    pid: p.pid,
    name: p.command,
    cpu: p.cpu,
    mem: p.mem,
    rss: p.rss,
  });

  // 1. Browsers (claimed first so they cannot also be counted as Electron).
  const runningBrowsers = CHROMIUM_BROWSERS.filter((b) =>
    withPath.some((p) => p.fullPath.includes(b)),
  );
  const browserProcs = withPath.filter((p) => runningBrowsers.some((b) => p.fullPath.includes(b)));
  browserProcs.forEach((p) => claimed.add(p.pid));

  if (runningBrowsers.length > 1) {
    const mem = browserProcs.reduce((s, p) => s + p.rss, 0);
    findings.push({
      severity: "warning",
      category: "Browsers",
      title: `${runningBrowsers.length} browsers running: ${runningBrowsers.join(", ")}`,
      detail: `${browserProcs.length} browser processes using ${(mem / 1024 ** 3).toFixed(1)}GB. Each browser runs its own renderer, GPU and utility processes.`,
      processes: browserProcs.slice(0, 10).map(toRef),
      recommendation: "Consolidate onto one browser and close the others.",
    });
  }

  // 2. Electron apps (excluding anything already claimed as a browser).
  const electronApps = new Map<string, typeof withPath>();
  for (const p of withPath) {
    if (claimed.has(p.pid)) continue;
    for (const [pattern, appName] of Object.entries(ELECTRON_APPS)) {
      if (p.fullPath.includes(pattern)) {
        const list = electronApps.get(appName) ?? [];
        list.push(p);
        electronApps.set(appName, list);
        claimed.add(p.pid);
        break;
      }
    }
  }

  const electronProcs = [...electronApps.values()].flat();
  if (electronApps.size > 0) {
    const mem = electronProcs.reduce((s, p) => s + p.rss, 0);
    const summary = [...electronApps.entries()]
      .map(([name, ps]) => ({ name, count: ps.length, mem: ps.reduce((s, p) => s + p.rss, 0) }))
      .sort((a, b) => b.mem - a.mem);
    findings.push({
      severity: electronApps.size > 6 ? "warning" : "info",
      category: "Electron Apps",
      title: `${electronApps.size} Electron apps running (${electronProcs.length} processes)`,
      detail: `Total memory ${(mem / 1024 ** 3).toFixed(1)}GB. ${summary.map((a) => `${a.name}: ${(a.mem / 1024 ** 2).toFixed(0)}MB (${a.count})`).join(", ")}.`,
      processes: electronProcs.slice(0, 10).map(toRef),
      recommendation: "Close apps you are not using. Web versions typically use less memory.",
    });
  }

  // 3. Bloatware — one finding per vendor.
  for (const { vendor, patterns, reason } of BLOAT_VENDORS) {
    const matches = withPath.filter((p) => patterns.some((pat) => p.fullPath.includes(pat)));
    if (matches.length === 0) continue;
    matches.forEach((p) => claimed.add(p.pid));
    const mem = matches.reduce((s, p) => s + p.rss, 0);
    const cpu = matches.reduce((s, p) => s + p.cpu, 0);
    findings.push({
      severity: cpu > 10 || mem > 200 * 1024 ** 2 ? "warning" : "info",
      category: "Bloatware",
      title: vendor,
      detail: `${reason}. ${matches.length} process(es) using ${(mem / 1024 ** 2).toFixed(0)}MB and ${cpu.toFixed(1)}% CPU.`,
      processes: matches.slice(0, 10).map(toRef),
      recommendation: "Remove, or quit when not in use.",
    });
  }

  // 4. Resource hogs among the user's own unclaimed processes.
  const hogs = withPath
    .filter((p) => p.user === currentUser && !claimed.has(p.pid))
    .filter((p) => p.cpu > 15 || p.rss > 500 * 1024 ** 2)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 5);

  let criticalHogs = 0;
  let warningHogs = 0;
  for (const hog of hogs) {
    // What the knowledge base says about this process decides the advice: a
    // system daemon that launchd keeps alive is never "stuck, restart it".
    const known = lookupKnowledgeBase(hog.command);
    const protectedDaemon = known?.kill === "avoid" || known?.kill === "restarts";
    const critical = !protectedDaemon && (hog.cpu > 50 || hog.rss > 1024 ** 3);
    if (critical) criticalHogs++;
    else warningHogs++;
    const advice = [known?.normal, known?.check].filter((s): s is string => Boolean(s)).join(" ");
    findings.push({
      severity: critical ? "critical" : "warning",
      category: "Resource Hog",
      title: `${hog.command} — ${hog.cpu.toFixed(1)}% of one core, ${(hog.rss / 1024 ** 2).toFixed(0)}MB`,
      detail: known
        ? `PID ${hog.pid}. ${known.what}`
        : `PID ${hog.pid} is consuming significant resources.`,
      // A daemon that must not be killed gets no kill target.
      processes: known?.kill === "avoid" ? [] : [toRef(hog)],
      recommendation:
        known?.kill === "avoid"
          ? `Part of macOS; do not terminate it. ${advice}`.trim()
          : known?.kill === "restarts"
            ? `launchd relaunches it if terminated, so killing it rarely helps. ${advice}`.trim()
            : critical
              ? "This process may be stuck. Consider restarting it."
              : "High memory use. Restart the app if it has been running a long time.",
    });
  }

  // 5. Startup items.
  const launchItems = [
    ...(isOk(userAgentsRes) ? userAgentsRes.value.split("\n") : []),
    ...(isOk(sysAgentsRes)
      ? sysAgentsRes.value.split("\n").filter((f) => !f.startsWith("com.apple."))
      : []),
    ...(isOk(daemonsRes)
      ? daemonsRes.value.split("\n").filter((f) => !f.startsWith("com.apple."))
      : []),
  ].filter(Boolean);

  if (launchItems.length > 0) {
    findings.push({
      severity: launchItems.length > 10 ? "warning" : "info",
      category: "Startup Items",
      title: `${launchItems.length} third-party launch agents/daemons`,
      detail: `Start automatically on boot: ${launchItems
        .slice(0, 8)
        .map((f) => f.replace(".plist", ""))
        .join(", ")}${launchItems.length > 8 ? ` +${launchItems.length - 8} more` : ""}.`,
      processes: [],
      recommendation: "Remove agents for apps you no longer use.",
    });
  }

  const swapUsedMB = isOk(swapRes)
    ? Number.parseFloat(swapRes.value.match(/used\s*=\s*([\d.]+)M/)?.[1] ?? "0")
    : 0;

  const order = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const complete = unavailable.length === 0;

  return {
    complete,
    // H-03: withhold the score when evidence is missing rather than implying health.
    healthScore: complete
      ? healthScore({
          swapUsedMB: Number.isFinite(swapUsedMB) ? swapUsedMB : 0,
          electronAppCount: electronApps.size,
          browserCount: runningBrowsers.length,
          processCount: procs.length,
          criticalHogs,
          warningHogs,
        })
      : null,
    unavailable,
    findings,
    summary: {
      totalProcesses: procs.length,
      electronApps: electronApps.size,
      electronProcesses: electronProcs.length,
      browsers: runningBrowsers.length,
      launchItems: launchItems.length,
      swapUsedMB: Math.round(Number.isFinite(swapUsedMB) ? swapUsedMB : 0),
    },
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

  const data = await singleFlight("system-scan", scan);
  return NextResponse.json(data);
}
