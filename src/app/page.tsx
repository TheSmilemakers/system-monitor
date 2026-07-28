"use client";

import { useCallback, useMemo, useState } from "react";

import { cleanupItem, killProcess, stopServer } from "./actions";
import { ProcessTable } from "@/components/dashboard/process-table";
import {
  Panel,
  ScorePill,
  SEVERITY_LABEL,
  UnavailableNotice,
  severityCardClass,
  severityDotClass,
} from "@/components/dashboard/panel";
import { Sparkline } from "@/components/dashboard/sparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOnDemand, usePolling } from "@/hooks/use-polling";
import { formatBytes, formatDuration } from "@/lib/format";
import {
  parseCleanup,
  parsePrivacy,
  parseScan,
  parseStats,
  type CleanupItem,
} from "@/lib/schemas";

type Level = "ok" | "warn" | "critical";

const LEVEL_TEXT: Record<Level, string> = {
  ok: "normal",
  warn: "elevated",
  critical: "critical",
};

function getLevel(value: number, warn: number, critical: number): Level {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

function barColor(level: Level): string {
  return level === "critical" ? "bg-red-500" : level === "warn" ? "bg-amber-500" : "bg-emerald-500";
}

function sparkColor(level: Level): string {
  return level === "critical"
    ? "oklch(0.704 0.191 22.216)"
    : level === "warn"
      ? "oklch(0.828 0.189 84.429)"
      : "oklch(0.765 0.177 163.223)";
}

/** Status conveyed by text as well as colour (M-10). */
function StatusDot({ level, label }: { level: Level; label: string }) {
  const cls = level === "critical" ? "bg-red-500" : level === "warn" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <>
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full shadow-sm ${cls} ${level === "critical" ? "motion-safe:animate-pulse" : ""}`}
      />
      <span className="sr-only">
        {label} status: {LEVEL_TEXT[level]}.
      </span>
    </>
  );
}

function MiniBar({ value, max, level }: { value: number; max: number; level: Level }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all duration-500 motion-reduce:transition-none ${barColor(level)}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const REFRESH_OPTIONS = [
  { value: 0, label: "Paused" },
  { value: 3000, label: "3s" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" },
  { value: 30000, label: "30s" },
];

export default function Dashboard() {
  // M-06: 1s is gone. Even after the async rewrite a full sample costs ~2.2s,
  // so offering an interval below the response time invites a queue again.
  const [refreshInterval, setRefreshInterval] = useState(5000);

  const stats = usePolling({
    url: "/api/stats",
    intervalMs: refreshInterval || 5000,
    parse: parseStats,
    enabled: refreshInterval > 0,
  });

  const scan = useOnDemand("/api/scan", parseScan);
  const cleanup = useOnDemand("/api/cleanup", parseCleanup);
  const privacy = useOnDemand("/api/privacy", parsePrivacy);

  const [showScan, setShowScan] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [cleaningId, setCleaningId] = useState<string | null>(null);
  const [cleanedIds, setCleanedIds] = useState<Set<string>>(new Set());

  const announce = useCallback((kind: "ok" | "error", message: string) => {
    setNotice({ kind, message });
  }, []);

  const handleKill = useCallback(
    async (pid: number, name: string) => {
      if (!window.confirm(`Terminate "${name}" (PID ${pid})?`)) return;
      setKillingPid(pid);
      try {
        const result = await killProcess(pid);
        announce(
          result.success ? "ok" : "error",
          result.success ? `Terminated ${name} (PID ${pid}).` : `Could not terminate ${name}: ${result.error}`,
        );
        if (result.success) stats.refresh();
      } catch {
        announce("error", `Could not terminate ${name}: the request failed.`);
      } finally {
        // L-03: always released, even when the action transport rejects.
        setKillingPid(null);
      }
    },
    [announce, stats],
  );

  const handleClean = useCallback(
    async (item: CleanupItem) => {
      const ok = window.confirm(
        `Clean "${item.name}"?\n\nFrees about ${item.sizeFormatted}.\nPath: ${item.path}\nRisk: ${item.risk}`,
      );
      if (!ok) return;
      setCleaningId(item.id);
      try {
        // C-01: only the opaque id crosses the wire.
        const result = await cleanupItem(item.id);
        if (result.success) {
          setCleanedIds((prev) => new Set(prev).add(item.id));
          announce(
            "ok",
            `Cleaned ${item.name} — freed ${formatBytes(result.bytesFreed ?? 0)} across ${result.itemsRemoved ?? 0} item(s).`,
          );
        } else {
          announce("error", `Could not clean ${item.name}: ${result.error}`);
        }
      } catch {
        announce("error", `Could not clean ${item.name}: the request failed.`);
      } finally {
        setCleaningId(null);
      }
    },
    [announce],
  );

  const openScan = useCallback(() => {
    setShowScan(true);
    void scan.run();
  }, [scan]);
  const openCleanup = useCallback(() => {
    setShowCleanup(true);
    setCleanedIds(new Set());
    void cleanup.run();
  }, [cleanup]);
  const openPrivacy = useCallback(() => {
    setShowPrivacy(true);
    void privacy.run();
  }, [privacy]);

  const data = stats.data;

  const levels = useMemo(() => {
    if (!data) return null;
    return {
      mem: getLevel(data.memory.percent, 70, 90),
      cpu: getLevel(data.cpu.used, 60, 85),
      swap: (data.swap.usedMB > 2000 ? "critical" : data.swap.usedMB > 100 ? "warn" : "ok") as Level,
      load: getLevel(data.load[0], data.cpu.cores * 0.8, data.cpu.cores * 1.2),
      disk: getLevel(data.disk.percent, 80, 95),
    };
  }, [data]);

  // M-04: the first-load error is rendered *before* any loading early-return,
  // so a persistent failure can never present as an endless spinner.
  if (stats.phase === "error" && !data) {
    return (
      <main className="dark flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div role="alert" className="max-w-md space-y-3 text-center">
          <h1 className="font-mono text-base font-semibold">System Monitor</h1>
          <p className="font-mono text-sm text-red-400">{stats.error}</p>
          <p className="font-mono text-xs text-muted-foreground">
            The server could not collect system metrics. This is reported rather than shown as zeroes.
          </p>
          <Button variant="outline" size="sm" className="font-mono text-xs" onClick={stats.refresh}>
            Retry
          </Button>
        </div>
      </main>
    );
  }

  if (!data || !levels) {
    return (
      <main className="dark flex min-h-screen items-center justify-center bg-background text-foreground">
        <p role="status" className="font-mono text-sm text-muted-foreground motion-safe:animate-pulse">
          Loading system stats…
        </p>
      </main>
    );
  }

  const history = data.history;

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-base font-semibold tracking-tight">System Monitor</h1>
          <Badge variant="outline" className="font-mono text-xs">{data.cpu.model}</Badge>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs text-muted-foreground">
          <span>up {data.uptime}</span>
          {data.battery && (
            <span>
              {data.battery.charging ? "AC" : "battery"} {data.battery.percent}%
            </span>
          )}
          <span>{data.processes.total} procs / {data.processes.threads} threads</span>

          <span className="flex items-center gap-1.5">
            <label htmlFor="refresh-interval" className="text-muted-foreground">
              Refresh
            </label>
            <select
              id="refresh-interval"
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="rounded border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </span>

          <Button variant="outline" size="sm" className="h-6 px-3 font-mono text-xs"
            onClick={openScan} disabled={scan.phase === "loading"}
            aria-expanded={showScan} aria-controls="scan-panel">
            {scan.phase === "loading" ? "Scanning…" : "Scan System"}
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-3 font-mono text-xs"
            onClick={openCleanup} disabled={cleanup.phase === "loading"}
            aria-expanded={showCleanup} aria-controls="cleanup-panel">
            {cleanup.phase === "loading" ? "Scanning…" : "Cleanup"}
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-3 font-mono text-xs"
            onClick={openPrivacy} disabled={privacy.phase === "loading"}
            aria-expanded={showPrivacy} aria-controls="privacy-panel">
            {privacy.phase === "loading" ? "Scanning…" : "Privacy"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-mono text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
            onClick={async () => {
              if (!window.confirm("Stop the System Monitor server?")) return;
              const r = await stopServer();
              announce(r.success ? "ok" : "error", r.success ? "Server stopping…" : (r.error ?? "Failed"));
            }}
          >
            Stop Server
          </Button>
        </div>
      </header>

      {/* Live region: async outcomes are announced, not just recoloured (M-08). */}
      <div aria-live="polite" aria-atomic="true" className="px-4 sm:px-6">
        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`mt-3 rounded px-3 py-2 font-mono text-xs ${
              notice.kind === "ok"
                ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                : "border border-red-500/20 bg-red-500/10 text-red-400"
            }`}
          >
            {notice.message}
          </div>
        )}
      </div>

      {stats.stale && stats.error && (
        <div role="alert" className="mx-4 mt-3 rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 font-mono text-xs text-amber-400 sm:mx-6">
          Refresh failed ({stats.error}). Showing the last successful reading from{" "}
          {stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleTimeString() : "earlier"}.
        </div>
      )}

      {!data.complete && data.unavailable.length > 0 && (
        <div className="mx-4 mt-3 sm:mx-6">
          <UnavailableNotice items={data.unavailable} />
        </div>
      )}

      {data.alerts.length > 0 && (
        <section aria-labelledby="alerts-heading" className="mx-4 mt-3 space-y-2 sm:mx-6">
          <h2 id="alerts-heading" className="sr-only">Process alerts</h2>
          {data.alerts.map((alert) => (
            <div
              key={alert.pid}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-500/20 bg-red-500/10 px-3 py-2 font-mono text-xs"
            >
              <span className="text-red-400">
                <strong>{alert.command}</strong> (PID {alert.pid}) held {alert.cpu.toFixed(0)}% of one core for{" "}
                {formatDuration(alert.duration)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Terminate ${alert.command}, PID ${alert.pid}`}
                className="h-6 min-h-6 px-2 font-mono text-xs text-red-400 hover:bg-red-500/20 hover:text-red-300"
                onClick={() => handleKill(alert.pid, alert.command)}
                disabled={killingPid === alert.pid}
              >
                {killingPid === alert.pid ? "…" : "kill"}
              </Button>
            </div>
          ))}
        </section>
      )}

      <main className="space-y-4 p-4 sm:p-6">
        {/* M-09: single column on small screens so charts are never clipped. */}
        <section aria-labelledby="metrics-heading" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <h2 id="metrics-heading" className="sr-only">System metrics</h2>

          <Card className="border-border">
            <CardContent className="space-y-1 px-4 py-3">
              <h3 className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <StatusDot level={levels.cpu} label="CPU" /> CPU
              </h3>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-2xl font-bold tabular-nums">{data.cpu.used.toFixed(1)}%</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {data.cpu.user.toFixed(0)}% usr / {data.cpu.system.toFixed(0)}% sys
                </p>
              </div>
              <MiniBar value={data.cpu.used} max={100} level={levels.cpu} />
              <Sparkline data={history.map((h) => h.cpu)} max={100} color={sparkColor(levels.cpu)}
                label="CPU usage" unit="%" warnAt={60} critAt={85} />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardContent className="space-y-1 px-4 py-3">
              <h3 className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <StatusDot level={levels.mem} label="Memory" /> Memory
              </h3>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-2xl font-bold tabular-nums">
                  {data.memory.usedGB}G <span className="text-sm text-muted-foreground">/ {data.memory.totalGB}G</span>
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {data.memory.wiredGB}G wired / {data.memory.compressorGB}G comp
                </p>
              </div>
              <MiniBar value={data.memory.usedGB} max={data.memory.totalGB} level={levels.mem} />
              <Sparkline data={history.map((h) => h.mem)} max={100} color={sparkColor(levels.mem)}
                label="Memory usage" unit="%" warnAt={70} critAt={90} />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardContent className="space-y-1 px-4 py-3">
              <h3 className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <StatusDot level={levels.swap} label="Swap" /> Swap
              </h3>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-2xl font-bold tabular-nums">
                  {data.swap.usedMB < 1024 ? `${data.swap.usedMB}M` : `${(data.swap.usedMB / 1024).toFixed(1)}G`}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {data.swap.totalMB > 0 ? `${data.swap.totalMB}M total` : "none allocated"}
                </p>
              </div>
              <MiniBar value={data.swap.usedMB} max={Math.max(data.swap.totalMB, 1)} level={levels.swap} />
              <Sparkline data={history.map((h) => h.swap)} max={4096} color={sparkColor(levels.swap)}
                label="Swap usage" unit="MB" warnAt={100} critAt={2000} />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardContent className="space-y-1 px-4 py-3">
              <h3 className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <StatusDot level={levels.load} label="Load" /> Load
              </h3>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-2xl font-bold tabular-nums">{data.load[0].toFixed(1)}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {data.load.map((l) => l.toFixed(1)).join(" / ")} ({data.cpu.cores} cores)
                </p>
              </div>
              <MiniBar value={data.load[0]} max={data.cpu.cores * 2} level={levels.load} />
              <Sparkline data={history.map((h) => h.load)} max={data.cpu.cores * 2} color={sparkColor(levels.load)}
                label="Load average" warnAt={data.cpu.cores * 0.8} critAt={data.cpu.cores * 1.2} />
            </CardContent>
          </Card>
        </section>

        <Card className="border-border">
          <CardContent className="flex flex-wrap items-center gap-4 px-4 py-3">
            <div>
              <h3 className="mb-1 flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <StatusDot level={levels.disk} label="Disk" /> Disk
              </h3>
              <p className="font-mono text-lg font-bold tabular-nums">{data.disk.percent}%</p>
              <p className="font-mono text-xs text-muted-foreground">{data.disk.used} / {data.disk.total}</p>
            </div>
            <div className="min-w-[120px] flex-1">
              <MiniBar value={data.disk.percent} max={100} level={levels.disk} />
            </div>
          </CardContent>
        </Card>

        {showPrivacy && (
          <div id="privacy-panel">
            <Panel
              id="privacy" title="Privacy Scan"
              phase={privacy.phase} error={privacy.error} stale={privacy.stale} lastUpdated={privacy.lastUpdated}
              loadingMessage="Checking connections, resolving endpoints, reading permissions…"
              onRefresh={privacy.run} onClose={() => setShowPrivacy(false)}
              badges={privacy.data && (
                <>
                  <ScorePill label="Privacy" score={privacy.data.privacyScore} complete={privacy.data.complete} />
                  <Badge variant="outline" className="font-mono text-xs">
                    {privacy.data.connectionCount} connections · {privacy.data.resolvedCount} resolved ·{" "}
                    {privacy.data.unknownCount} unknown
                  </Badge>
                  {privacy.data.trackerCount > 0 && (
                    <Badge variant="outline" className="border-red-500/30 font-mono text-xs text-red-400">
                      {privacy.data.trackerCount} tracker connection(s)
                    </Badge>
                  )}
                </>
              )}
            >
              {privacy.data && (
                <div className="space-y-2">
                  <UnavailableNotice items={privacy.data.unavailable} />
                  <ScrollArea className="h-[420px]">
                    <div className="space-y-2 pr-3">
                      {privacy.data.findings.length === 0 ? (
                        <p className="py-4 text-center font-mono text-sm text-muted-foreground">
                          No findings from the checks that ran.
                        </p>
                      ) : (
                        privacy.data.findings.map((f, i) => (
                          <article key={`${f.category}-${i}`} className={`space-y-1.5 rounded border px-3 py-2.5 ${severityCardClass(f.severity)}`}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${severityDotClass(f.severity)}`} />
                              <h3 className="font-mono text-xs font-medium">{f.title}</h3>
                              <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">{f.category}</Badge>
                              <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                                {SEVERITY_LABEL[f.severity] ?? f.severity}
                              </Badge>
                            </div>
                            {f.items.length > 0 && (
                              <ul className="space-y-0.5 pl-3.5">
                                {f.items.slice(0, 6).map((item, j) => (
                                  <li key={j} className="truncate font-mono text-xs text-muted-foreground" title={item}>{item}</li>
                                ))}
                                {f.items.length > 6 && (
                                  <li className="font-mono text-xs text-muted-foreground/60">+{f.items.length - 6} more</li>
                                )}
                              </ul>
                            )}
                            <p className="pl-3.5 font-mono text-xs">
                              <span className="text-emerald-400/80">Fix:</span>{" "}
                              <span className="text-muted-foreground">{f.recommendation}</span>
                            </p>
                          </article>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </Panel>
          </div>
        )}

        {showCleanup && (
          <div id="cleanup-panel">
            <Panel
              id="cleanup" title="Disk Cleanup"
              phase={cleanup.phase} error={cleanup.error} stale={cleanup.stale} lastUpdated={cleanup.lastUpdated}
              loadingMessage="Measuring caches, logs and developer artifacts…"
              onRefresh={cleanup.run} onClose={() => setShowCleanup(false)}
              badges={cleanup.data && (
                <Badge variant="outline" className="border-emerald-500/30 font-mono text-xs text-emerald-400">
                  {cleanup.data.totalFormatted} reclaimable
                </Badge>
              )}
            >
              {cleanup.data && (
                <div className="space-y-2">
                  <UnavailableNotice items={cleanup.data.unavailable} />
                  {cleanup.data.items.length === 0 ? (
                    <p className="py-4 text-center font-mono text-sm text-muted-foreground">
                      Nothing significant to clear.
                    </p>
                  ) : (
                    <ScrollArea className="h-[420px]">
                      <div className="space-y-1.5 pr-3">
                        {cleanup.data.items.map((item) => {
                          const cleaned = cleanedIds.has(item.id);
                          const busy = cleaningId === item.id;
                          return (
                            <div
                              key={item.id}
                              className={`flex flex-wrap items-start justify-between gap-3 rounded border px-3 py-2 ${
                                cleaned
                                  ? "border-emerald-500/20 bg-emerald-500/5 opacity-60"
                                  : item.risk === "medium"
                                    ? "border-amber-500/20 bg-amber-500/5"
                                    : "border-border bg-muted/30"
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="font-mono text-xs font-medium">
                                    {cleaned ? `${item.name} — cleaned` : item.name}
                                  </h3>
                                  <span className="font-mono text-xs font-bold tabular-nums text-emerald-400">
                                    {item.sizeFormatted}
                                  </span>
                                  {item.risk === "medium" && (
                                    <Badge variant="outline" className="border-amber-500/30 px-1.5 py-0 font-mono text-[10px] text-amber-400">
                                      review first
                                    </Badge>
                                  )}
                                  {item.requiresRoot && (
                                    <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                                      needs admin
                                    </Badge>
                                  )}
                                </div>
                                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{item.description}</p>
                                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/60" title={item.path}>
                                  {item.path}
                                  {item.fileCount !== null ? ` — ${item.fileCount.toLocaleString()} files` : " — file count unavailable"}
                                </p>
                              </div>
                              {!cleaned && (
                                <Button
                                  variant="ghost" size="sm"
                                  aria-label={`Clean ${item.name}, freeing about ${item.sizeFormatted}`}
                                  className="h-6 min-h-6 shrink-0 px-2 font-mono text-xs text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                                  onClick={() => handleClean(item)}
                                  disabled={busy || item.requiresRoot || cleaningId !== null}
                                  title={item.requiresRoot ? "Requires administrator rights — run manually" : undefined}
                                >
                                  {busy ? "…" : item.requiresRoot ? "manual" : "clean"}
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              )}
            </Panel>
          </div>
        )}

        {showScan && (
          <div id="scan-panel">
            <Panel
              id="scan" title="System Scan"
              phase={scan.phase} error={scan.error} stale={scan.stale} lastUpdated={scan.lastUpdated}
              loadingMessage="Analysing processes, launch agents and resource usage…"
              onRefresh={scan.run} onClose={() => setShowScan(false)}
              badges={scan.data && <ScorePill label="Health" score={scan.data.healthScore} complete={scan.data.complete} />}
            >
              {scan.data && (
                <div className="space-y-3">
                  <UnavailableNotice items={scan.data.unavailable} />
                  {scan.data.summary && (
                    <div className="flex flex-wrap gap-2 border-b border-border pb-2">
                      <Badge variant="outline" className="font-mono text-xs">{scan.data.summary.totalProcesses} processes</Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        {scan.data.summary.electronApps} Electron apps ({scan.data.summary.electronProcesses} procs)
                      </Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        {scan.data.summary.browsers} browser{scan.data.summary.browsers === 1 ? "" : "s"}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-xs">{scan.data.summary.launchItems} startup items</Badge>
                      <Badge variant="outline" className="font-mono text-xs">{scan.data.summary.swapUsedMB}MB swap</Badge>
                    </div>
                  )}
                  {scan.data.findings.length === 0 ? (
                    <p className="py-4 text-center font-mono text-sm text-muted-foreground">
                      No findings from the checks that ran.
                    </p>
                  ) : (
                    <ScrollArea className="h-[400px]">
                      <div className="space-y-2 pr-3">
                        {scan.data.findings.map((f, i) => (
                          <article key={`${f.category}-${i}`} className={`space-y-1.5 rounded border px-3 py-2.5 ${severityCardClass(f.severity)}`}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${severityDotClass(f.severity)}`} />
                                <h3 className="font-mono text-xs font-medium">{f.title}</h3>
                                <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">{f.category}</Badge>
                                <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                                  {SEVERITY_LABEL[f.severity] ?? f.severity}
                                </Badge>
                              </div>
                              {f.processes.length > 0 && (
                                <Button
                                  variant="ghost" size="sm"
                                  aria-label={`Terminate ${f.processes[0].name}, PID ${f.processes[0].pid}`}
                                  className="h-6 min-h-6 shrink-0 px-2 font-mono text-[10px] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                  onClick={() => handleKill(f.processes[0].pid, f.processes[0].name)}
                                  disabled={killingPid === f.processes[0].pid}
                                >
                                  kill {f.processes[0].name}
                                </Button>
                              )}
                            </div>
                            <p className="pl-3.5 font-mono text-xs leading-relaxed text-muted-foreground">{f.detail}</p>
                            <p className="pl-3.5 font-mono text-xs">
                              <span className="text-emerald-400/80">Recommendation:</span>{" "}
                              <span className="text-muted-foreground">{f.recommendation}</span>
                            </p>
                          </article>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              )}
            </Panel>
          </div>
        )}

        <Card className="border-border">
          <CardContent className="px-0 pb-0 pt-3">
            <h2 className="px-4 pb-2 font-mono text-xs text-muted-foreground">
              Processes by CPU <span className="text-muted-foreground/60">(percent of one core)</span>
            </h2>
            <ProcessTable
              processes={data.processes.top}
              alerts={data.alerts}
              killingPid={killingPid}
              onKill={handleKill}
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
