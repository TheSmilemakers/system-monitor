"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { cleanupItem, killProcess, stopServer } from "./actions";
import { Annunciator } from "@/components/bench/annunciator";
import { CommandPalette, type PaletteAction } from "@/components/bench/command-palette";
import { Header } from "@/components/bench/header";
import { Inspector } from "@/components/bench/inspector";
import { Scope } from "@/components/bench/scope";
import { computeLevels, VitalsRail } from "@/components/bench/vitals-rail";
import {
  CleanupView,
  PrivacyView,
  ScanView,
  Workbench,
  type TabKey,
} from "@/components/bench/workbench";
import { UnavailableNotice } from "@/components/dashboard/panel";
import { ProcessTable } from "@/components/dashboard/process-table";
import { Button } from "@/components/ui/button";
import { useOnDemand, usePolling } from "@/hooks/use-polling";
import { formatBytes, formatDuration } from "@/lib/format";
import { currentRetro, currentTheme, setRetro, setTheme } from "@/lib/prefs";
import {
  parseCleanup,
  parsePosture,
  parsePrivacy,
  parseScan,
  parseStats,
  type CleanupItem,
} from "@/lib/schemas";

/**
 * The bench. Header, vitals rail, workbench, inspector, palette.
 *
 * Polling stays server-cadenced (usePolling); the on-demand scans run when
 * their tab is first opened. Destructive actions confirm; everything else
 * acts immediately and announces its outcome in the live region.
 */
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

  // Posture changes slowly; a minute is plenty and keeps the probes cheap.
  const posture = usePolling({ url: "/api/posture", intervalMs: 60_000, parse: parsePosture });

  const scan = useOnDemand("/api/scan", parseScan);
  const cleanup = useOnDemand("/api/cleanup", parseCleanup);
  const privacy = useOnDemand("/api/privacy", parsePrivacy);

  const [tab, setTab] = useState<TabKey>("processes");
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [inspectPid, setInspectPid] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
          result.success
            ? `Terminated ${name} (PID ${pid}).`
            : `Could not terminate ${name}: ${result.error}`,
        );
        if (result.success) {
          if (inspectPid === pid) setInspectPid(null);
          stats.refresh();
        }
      } catch {
        announce("error", `Could not terminate ${name}: the request failed.`);
      } finally {
        // L-03: always released, even when the action transport rejects.
        setKillingPid(null);
      }
    },
    [announce, stats, inspectPid],
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
            `Cleaned ${item.name}, freed ${formatBytes(result.bytesFreed ?? 0)} across ${result.itemsRemoved ?? 0} item(s).`,
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

  const handleStop = useCallback(async () => {
    if (!window.confirm("Stop the System Monitor server?")) return;
    const r = await stopServer();
    announce(r.success ? "ok" : "error", r.success ? "Server stopping…" : (r.error ?? "Failed"));
  }, [announce]);

  const openTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      if (next === "scan" && scan.phase === "idle") void scan.run();
      if (next === "cleanup" && cleanup.phase === "idle") {
        setCleanedIds(new Set());
        void cleanup.run();
      }
      if (next === "privacy" && privacy.phase === "idle") void privacy.run();
    },
    [scan, cleanup, privacy],
  );

  const inspect = useCallback((pid: number) => {
    setSelectedPid(pid);
    setInspectPid(pid);
    setTab("processes");
  }, []);

  // ⌘K / Ctrl+K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const data = stats.data;
  const levels = useMemo(() => (data ? computeLevels(data) : null), [data]);
  const processes = useMemo(() => data?.processes.top ?? [], [data]);
  const inspected = useMemo(
    () => (inspectPid === null ? null : (processes.find((p) => p.pid === inspectPid) ?? null)),
    [processes, inspectPid],
  );

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "processes", label: "Show processes", run: () => openTab("processes") },
      { id: "scan", label: "Run system scan", run: () => openTab("scan") },
      { id: "cleanup", label: "Open disk cleanup", run: () => openTab("cleanup") },
      { id: "privacy", label: "Run privacy scan", run: () => openTab("privacy") },
      { id: "refresh", label: "Refresh now", run: () => stats.refresh() },
      {
        id: "pause",
        label: refreshInterval === 0 ? "Resume polling" : "Pause polling",
        run: () => setRefreshInterval((v) => (v === 0 ? 5000 : 0)),
      },
      {
        id: "theme",
        label: "Toggle theme",
        hint: "night shift or daylight",
        run: () => setTheme(currentTheme() === "dark" ? "light" : "dark"),
      },
      {
        id: "retro",
        label: "Cycle retro intensity",
        hint: "clean, instrument, tube",
        run: () => {
          const r = currentRetro();
          setRetro(r === "0" ? "1" : r === "1" ? "2" : "0");
        },
      },
    ],
    [openTab, stats, refreshInterval],
  );

  // M-04: the first-load error is rendered *before* any loading early-return,
  // so a persistent failure can never present as an endless spinner.
  if (stats.phase === "error" && !data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div role="alert" className="max-w-md space-y-3 text-center">
          <h1 className="font-display text-base font-semibold">System Monitor</h1>
          <p className="font-mono text-sm text-alarm">{stats.error}</p>
          <p className="font-mono text-xs text-muted-foreground">
            The server could not collect system metrics. This is reported rather than shown as
            zeroes.
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
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p
          role="status"
          className="font-mono text-sm text-muted-foreground motion-safe:animate-pulse"
        >
          Loading system stats…
        </p>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Header
        data={data}
        refreshInterval={refreshInterval}
        onRefreshIntervalChange={setRefreshInterval}
        onOpenPalette={() => setPaletteOpen(true)}
        onStop={handleStop}
      />

      <Annunciator report={posture.data} error={posture.error} />

      {/* Live region: async outcomes are announced, not just recoloured (M-08). */}
      <div aria-live="polite" aria-atomic="true" className="px-3 sm:px-4">
        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`mt-3 rounded border px-3 py-2 font-mono text-xs ${
              notice.kind === "ok"
                ? "border-phosphor/20 bg-phosphor/10 text-phosphor"
                : "border-alarm/20 bg-alarm/10 text-alarm"
            }`}
          >
            {notice.message}
          </div>
        )}
      </div>

      {stats.stale && stats.error && (
        <div
          role="alert"
          className="mx-3 mt-3 rounded border border-amber/20 bg-amber/5 px-3 py-2 font-mono text-xs text-amber sm:mx-4"
        >
          Refresh failed ({stats.error}). Showing the last successful reading from{" "}
          {stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleTimeString() : "earlier"}.
        </div>
      )}

      {!data.complete && data.unavailable.length > 0 && (
        <div className="mx-3 mt-3 sm:mx-4">
          <UnavailableNotice items={data.unavailable} />
        </div>
      )}

      {data.alerts.length > 0 && (
        <section aria-labelledby="alerts-heading" className="mx-3 mt-3 space-y-2 sm:mx-4">
          <h2 id="alerts-heading" className="sr-only">
            Process alerts
          </h2>
          {data.alerts.map((alert) => (
            <div
              key={alert.pid}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-alarm/25 bg-alarm/10 px-3 py-2 font-mono text-xs"
            >
              <span className="text-alarm">
                <button
                  type="button"
                  className="font-semibold hover:underline"
                  onClick={() => inspect(alert.pid)}
                >
                  {alert.command}
                </button>{" "}
                (PID {alert.pid}) held {alert.cpu.toFixed(0)}% of one core for{" "}
                {formatDuration(alert.duration)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Terminate ${alert.command}, PID ${alert.pid}`}
                className="h-6 min-h-6 px-2 font-mono text-xs text-alarm hover:bg-alarm/20"
                onClick={() => handleKill(alert.pid, alert.command)}
                disabled={killingPid === alert.pid}
              >
                {killingPid === alert.pid ? "…" : "kill"}
              </Button>
            </div>
          ))}
        </section>
      )}

      <main className="grid flex-1 gap-3 p-3 sm:p-4 xl:grid-cols-[272px_minmax(0,1fr)]">
        <VitalsRail data={data} levels={levels} />
        <div className="flex min-h-[560px] flex-col gap-3">
          <Scope
            history={data.history}
            alerts={data.alerts}
            cores={data.cpu.cores}
            net={data.net}
          />
          <Workbench
            tab={tab}
            onTabChange={openTab}
            panels={{
              processes: (
                <div className="h-[640px]">
                  <ProcessTable
                    processes={processes}
                    alerts={data.alerts}
                    currentUser={data.currentUser || null}
                    killingPid={killingPid}
                    selectedPid={selectedPid}
                    onSelect={setSelectedPid}
                    onInspect={inspect}
                    onKill={handleKill}
                  />
                </div>
              ),
              scan: (
                <ScanView
                  state={scan}
                  killingPid={killingPid}
                  onKill={handleKill}
                  onClose={() => setTab("processes")}
                />
              ),
              cleanup: (
                <CleanupView
                  state={cleanup}
                  cleaningId={cleaningId}
                  cleanedIds={cleanedIds}
                  onClean={handleClean}
                  onClose={() => setTab("processes")}
                />
              ),
              privacy: <PrivacyView state={privacy} onClose={() => setTab("processes")} />,
            }}
          />
        </div>
      </main>

      <Inspector
        proc={inspected}
        all={processes}
        alerts={data.alerts}
        killingPid={killingPid}
        onClose={() => setInspectPid(null)}
        onInspect={inspect}
        onKill={handleKill}
        onNotice={announce}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        processes={processes}
        actions={paletteActions}
        onInspect={inspect}
      />
    </div>
  );
}
