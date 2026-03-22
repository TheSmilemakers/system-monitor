import { execSync } from "child_process";
import { NextResponse } from "next/server";

function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 10000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// Known categories of processes
const KNOWN_BLOAT: Record<string, string> = {
  "com.avast": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.avg": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.mcafee": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.norton": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.symantec": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.trendmicro": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.kaspersky": "Antivirus — macOS has built-in XProtect/Gatekeeper",
  "com.malwarebytes": "Antivirus — on-demand scans are fine, real-time scanning adds overhead",
  CleanMyMac: "System cleaner — often runs background agents unnecessarily",
  MacKeeper: "Known bloatware — aggressive resource usage",
  "com.macpaw": "CleanMyMac/Gemini — background agents use resources",
  "Adobe Creative Cloud": "Adobe background services — heavy resource usage if not actively using Adobe apps",
  "AdobeIPCBroker": "Adobe IPC — runs even when no Adobe app is open",
  "Adobe Desktop Service": "Adobe background service — can be quit if not using Adobe apps",
  "com.adobe.acc": "Adobe Creative Cloud agent",
  CCLibrary: "Adobe CC Library sync — runs continuously",
  "Core Sync": "Adobe file sync — runs continuously in background",
  "com.google.keystone": "Google updater — checks for Chrome updates frequently",
  "Google Software Update": "Google updater daemon",
  "com.microsoft.autoupdate": "Microsoft AutoUpdate — can be run manually instead",
  iTunesHelper: "iTunes helper — legacy, not needed on modern macOS",
  "Cisco AnyConnect": "VPN client — heavy when idle, quit if not using VPN",
};

const ELECTRON_APPS: Record<string, string> = {
  Electron: "Generic Electron app",
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
  Zoom: "Zoom",
  WhatsApp: "WhatsApp",
  Telegram: "Telegram",
  Signal: "Signal",
  Binance: "Binance",
  Claude: "Claude Desktop",
  Brave: "Brave Browser",
  "Google Chrome": "Google Chrome",
  Antigravity: "Antigravity",
};

interface ScanProcess {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number; // bytes
  command: string;
  fullPath: string;
}

interface Finding {
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  processes: { pid: number; name: string; cpu: number; mem: number; rss: number }[];
  recommendation: string;
}

export async function GET() {
  // Get all processes — ps aux format: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
  const psOutput = run("ps aux");
  const lines = psOutput.split("\n").slice(1).filter(Boolean);

  const allProcs: ScanProcess[] = lines.map((line) => {
    const parts = line.split(/\s+/);
    return {
      user: parts[0],
      pid: parseInt(parts[1]),
      cpu: parseFloat(parts[2]),
      mem: parseFloat(parts[3]),
      rss: parseInt(parts[5]) * 1024, // RSS is column 5 (index 5), in KB
      command: parts.slice(10).join(" ").replace(/\/.*\//, "").replace(/ -.*$/, "").substring(0, 60),
      fullPath: parts.slice(10).join(" "),
    };
  }).filter((p) => p.pid > 0);

  const currentUser = run("whoami");
  const findings: Finding[] = [];

  // 1. Check for known bloatware
  for (const [pattern, reason] of Object.entries(KNOWN_BLOAT)) {
    const matches = allProcs.filter((p) => p.fullPath.includes(pattern));
    if (matches.length > 0) {
      const totalMem = matches.reduce((s, p) => s + p.rss, 0);
      const totalCpu = matches.reduce((s, p) => s + p.cpu, 0);
      findings.push({
        severity: totalCpu > 10 || totalMem > 200 * 1024 * 1024 ? "warning" : "info",
        category: "Bloatware",
        title: pattern.replace(/com\.\w+\.?/, "").replace(/^\./, "") || pattern,
        detail: `${reason}. ${matches.length} process(es) using ${(totalMem / 1024 / 1024).toFixed(0)}MB RAM, ${totalCpu.toFixed(1)}% CPU.`,
        processes: matches.map((p) => ({ pid: p.pid, name: p.command, cpu: p.cpu, mem: p.mem, rss: p.rss })),
        recommendation: `Consider removing or quitting when not in use.`,
      });
    }
  }

  // 2. Electron app audit
  const electronProcs: ScanProcess[] = [];
  const electronApps = new Map<string, ScanProcess[]>();

  for (const proc of allProcs) {
    for (const [pattern, appName] of Object.entries(ELECTRON_APPS)) {
      if (proc.fullPath.includes(pattern)) {
        electronProcs.push(proc);
        const existing = electronApps.get(appName) || [];
        existing.push(proc);
        electronApps.set(appName, existing);
        break;
      }
    }
  }

  if (electronApps.size > 0) {
    const totalElectronMem = electronProcs.reduce((s, p) => s + p.rss, 0);
    const appSummary = Array.from(electronApps.entries())
      .map(([name, procs]) => {
        const mem = procs.reduce((s, p) => s + p.rss, 0);
        return { name, procs: procs.length, mem };
      })
      .sort((a, b) => b.mem - a.mem);

    findings.push({
      severity: electronApps.size > 6 ? "warning" : "info",
      category: "Electron Apps",
      title: `${electronApps.size} Electron apps running (${electronProcs.length} processes)`,
      detail: `Total memory: ${(totalElectronMem / 1024 / 1024 / 1024).toFixed(1)}GB. Each Electron app is a full Chromium instance. ${appSummary.map((a) => `${a.name}: ${(a.mem / 1024 / 1024).toFixed(0)}MB (${a.procs} procs)`).join(", ")}.`,
      processes: appSummary.flatMap(a => {
        const procs = electronApps.get(a.name) || [];
        return procs.map(p => ({ pid: p.pid, name: p.command, cpu: p.cpu, mem: p.mem, rss: p.rss }));
      }),
      recommendation: `Consider closing ${electronApps.size > 4 ? "apps you're not actively using" : "unused apps"} to free memory. Web versions of Slack, Discord, and Spotify use less RAM.`,
    });
  }

  // 3. Duplicate browsers
  const browsers = ["Google Chrome", "Brave", "Firefox", "Safari", "Arc", "Vivaldi", "Opera", "Microsoft Edge"];
  const runningBrowsers = browsers.filter((b) => allProcs.some((p) => p.fullPath.includes(b)));
  if (runningBrowsers.length > 1) {
    const browserProcs = allProcs.filter((p) => runningBrowsers.some((b) => p.fullPath.includes(b)));
    const totalMem = browserProcs.reduce((s, p) => s + p.rss, 0);
    findings.push({
      severity: "warning",
      category: "Duplicate Browsers",
      title: `${runningBrowsers.length} browsers running: ${runningBrowsers.join(", ")}`,
      detail: `${browserProcs.length} browser processes using ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB total. Each browser has its own renderer, GPU, and utility processes.`,
      processes: browserProcs.slice(0, 10).map((p) => ({ pid: p.pid, name: p.command, cpu: p.cpu, mem: p.mem, rss: p.rss })),
      recommendation: `Use one browser. Consolidate tabs and close the other.`,
    });
  }

  // 4. Resource hogs (>5% CPU or >500MB for user processes)
  const hogs = allProcs.filter(
    (p) => p.user === currentUser && (p.cpu > 15 || p.rss > 500 * 1024 * 1024)
  ).filter(
    // Exclude already-flagged processes
    (p) => !findings.some((f) => f.processes.some((fp) => fp.pid === p.pid))
  );

  if (hogs.length > 0) {
    for (const hog of hogs.sort((a, b) => b.cpu + b.rss / 1e9 - (a.cpu + a.rss / 1e9)).slice(0, 5)) {
      findings.push({
        severity: hog.cpu > 50 || hog.rss > 1024 * 1024 * 1024 ? "critical" : "warning",
        category: "Resource Hog",
        title: `${hog.command} — ${hog.cpu.toFixed(1)}% CPU, ${(hog.rss / 1024 / 1024).toFixed(0)}MB`,
        detail: `PID ${hog.pid} is consuming significant resources.`,
        processes: [{ pid: hog.pid, name: hog.command, cpu: hog.cpu, mem: hog.mem, rss: hog.rss }],
        recommendation: hog.cpu > 50
          ? "This process may be stuck or spinning. Consider restarting it."
          : "High memory usage. Restart the app if it's been running for a long time.",
      });
    }
  }

  // 5. Launch agents/daemons audit
  const userAgents = run("ls ~/Library/LaunchAgents/ 2>/dev/null").split("\n").filter(Boolean);
  const systemAgents = run("ls /Library/LaunchAgents/ 2>/dev/null").split("\n").filter(Boolean);
  const thirdPartyDaemons = run("ls /Library/LaunchDaemons/ 2>/dev/null")
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.startsWith("com.apple."));

  const launchItems = [...userAgents, ...systemAgents.filter((f) => !f.startsWith("com.apple.")), ...thirdPartyDaemons];
  if (launchItems.length > 0) {
    findings.push({
      severity: launchItems.length > 10 ? "warning" : "info",
      category: "Startup Items",
      title: `${launchItems.length} third-party launch agents/daemons`,
      detail: `These start automatically on boot: ${launchItems.slice(0, 8).map((f) => f.replace(".plist", "")).join(", ")}${launchItems.length > 8 ? ` +${launchItems.length - 8} more` : ""}.`,
      processes: [],
      recommendation: "Review and remove agents for apps you no longer use. Each one consumes memory and CPU on every boot.",
    });
  }

  // 6. Overall health score
  const totalRamGB = parseInt(run("sysctl -n hw.memsize") || "0") / 1024 ** 3;
  const swapRaw = run("sysctl vm.swapusage");
  const swapUsed = parseFloat(swapRaw.match(/used\s*=\s*([\d.]+)M/)?.[1] || "0");
  const processCount = allProcs.length;

  let healthScore = 100;
  if (swapUsed > 2000) healthScore -= 30;
  else if (swapUsed > 500) healthScore -= 15;
  else if (swapUsed > 100) healthScore -= 5;
  if (electronApps.size > 8) healthScore -= 15;
  else if (electronApps.size > 5) healthScore -= 8;
  if (runningBrowsers.length > 1) healthScore -= 10;
  if (processCount > 800) healthScore -= 10;
  else if (processCount > 600) healthScore -= 5;
  findings.filter((f) => f.severity === "critical").forEach(() => healthScore -= 10);
  findings.filter((f) => f.severity === "warning").forEach(() => healthScore -= 3);
  healthScore = Math.max(0, Math.min(100, healthScore));

  // Sort by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return NextResponse.json({
    healthScore,
    findings,
    summary: {
      totalProcesses: processCount,
      electronApps: electronApps.size,
      electronProcesses: electronProcs.length,
      browsers: runningBrowsers.length,
      launchItems: launchItems.length,
      swapUsedMB: Math.round(swapUsed),
    },
    timestamp: Date.now(),
  });
}
