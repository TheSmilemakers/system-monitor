"use client";

import type { ReactNode } from "react";

import {
  Panel,
  ScorePill,
  SEVERITY_LABEL,
  UnavailableNotice,
  severityCardClass,
  severityDotClass,
} from "@/components/dashboard/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PollState } from "@/hooks/use-polling";
import type { CleanupItem, CleanupResult, PrivacyResult, ScanResult } from "@/lib/schemas";

export type TabKey =
  | "processes"
  | "timeline"
  | "network"
  | "persistence"
  | "permissions"
  | "scan"
  | "cleanup"
  | "privacy";

export const TABS: { key: TabKey; label: string }[] = [
  { key: "processes", label: "Processes" },
  { key: "timeline", label: "Timeline" },
  { key: "network", label: "Network" },
  { key: "persistence", label: "Persistence" },
  { key: "permissions", label: "Permissions" },
  { key: "scan", label: "Scan" },
  { key: "cleanup", label: "Cleanup" },
  { key: "privacy", label: "Privacy" },
];

export interface WorkbenchProps {
  tab: TabKey;
  onTabChange: (tab: TabKey) => void;
  panels: Record<TabKey, ReactNode>;
}

/**
 * The workbench: a tab strip and one panel. Arrow keys move between tabs
 * (roving tabindex), and each panel is labelled by its tab.
 */
export function Workbench({ tab, onTabChange, panels }: WorkbenchProps) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = TABS.findIndex((t) => t.key === tab);
    if (e.key === "ArrowRight") onTabChange(TABS[(idx + 1) % TABS.length]?.key ?? tab);
    else if (e.key === "ArrowLeft")
      onTabChange(TABS[(idx - 1 + TABS.length) % TABS.length]?.key ?? tab);
    else return;
    e.preventDefault();
    (
      e.currentTarget.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null
    )?.focus();
  };

  return (
    <section className="flex min-h-0 flex-col rounded-md border border-border bg-card">
      <div
        role="tablist"
        aria-label="Workbench"
        onKeyDown={onKeyDown}
        className="flex gap-1 border-b border-border px-2 pt-1.5"
      >
        {TABS.map((t) => {
          const selected = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(t.key)}
              className={`engraved -mb-px border-b-2 px-3 py-1.5 ${
                selected
                  ? "border-phosphor text-foreground"
                  : "border-transparent hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="min-h-0 flex-1"
      >
        {panels[tab]}
      </div>
    </section>
  );
}

// ---------- the three scan views, moved out of page.tsx ----------

type OnDemand<T> = PollState<T> & { run: () => Promise<void> };

export interface ScanViewProps {
  state: OnDemand<ScanResult>;
  killingPid: number | null;
  onKill: (pid: number, name: string) => void;
  onClose: () => void;
}

export function ScanView({ state, killingPid, onKill, onClose }: ScanViewProps) {
  return (
    <Panel
      id="scan"
      title="System scan"
      phase={state.phase}
      error={state.error}
      stale={state.stale}
      lastUpdated={state.lastUpdated}
      loadingMessage="Analysing processes, launch agents and resource usage…"
      onRefresh={state.run}
      onClose={onClose}
      badges={
        state.data && (
          <ScorePill label="Health" score={state.data.healthScore} complete={state.data.complete} />
        )
      }
    >
      {state.data && (
        <div className="space-y-3">
          <UnavailableNotice items={state.data.unavailable} />
          {state.data.summary && (
            <div className="flex flex-wrap gap-2 border-b border-border pb-2">
              <Badge variant="outline" className="font-mono text-xs">
                {state.data.summary.totalProcesses} processes
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                {state.data.summary.electronApps} Electron apps (
                {state.data.summary.electronProcesses} procs)
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                {state.data.summary.browsers} browser{state.data.summary.browsers === 1 ? "" : "s"}
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                {state.data.summary.launchItems} startup items
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                {state.data.summary.swapUsedMB} MB swap
              </Badge>
            </div>
          )}
          {state.data.findings.length === 0 ? (
            <p className="py-4 text-center font-mono text-sm text-muted-foreground">
              No findings from the checks that ran.
            </p>
          ) : (
            <ScrollArea className="h-[400px]">
              <div className="space-y-2 pr-3">
                {state.data.findings.map((f, i) => (
                  <article
                    key={`${f.category}-${i}`}
                    className={`space-y-1.5 rounded border px-3 py-2.5 ${severityCardClass(f.severity)}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${severityDotClass(f.severity)}`}
                        />
                        <h3 className="font-mono text-xs font-medium">{f.title}</h3>
                        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                          {f.category}
                        </Badge>
                        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                          {SEVERITY_LABEL[f.severity] ?? f.severity}
                        </Badge>
                      </div>
                      {f.processes[0] !== undefined && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Terminate ${f.processes[0].name}, PID ${f.processes[0].pid}`}
                          className="h-6 min-h-6 shrink-0 px-2 font-mono text-[10px] text-alarm hover:bg-alarm/10"
                          onClick={() => {
                            const lead = f.processes[0];
                            if (lead) onKill(lead.pid, lead.name);
                          }}
                          disabled={killingPid === f.processes[0].pid}
                        >
                          kill {f.processes[0].name}
                        </Button>
                      )}
                    </div>
                    <p className="pl-3.5 font-mono text-xs leading-relaxed text-muted-foreground">
                      {f.detail}
                    </p>
                    <p className="pl-3.5 font-mono text-xs">
                      <span className="text-phosphor/80">Recommendation:</span>{" "}
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
  );
}

export interface CleanupViewProps {
  state: OnDemand<CleanupResult>;
  cleaningId: string | null;
  cleanedIds: ReadonlySet<string>;
  onClean: (item: CleanupItem) => void;
  onClose: () => void;
}

export function CleanupView({ state, cleaningId, cleanedIds, onClean, onClose }: CleanupViewProps) {
  return (
    <Panel
      id="cleanup"
      title="Disk cleanup"
      phase={state.phase}
      error={state.error}
      stale={state.stale}
      lastUpdated={state.lastUpdated}
      loadingMessage="Measuring caches, logs and developer artifacts…"
      onRefresh={state.run}
      onClose={onClose}
      badges={
        state.data && (
          <Badge variant="outline" className="border-phosphor/30 font-mono text-xs text-phosphor">
            {state.data.totalFormatted} reclaimable
          </Badge>
        )
      }
    >
      {state.data && (
        <div className="space-y-2">
          <UnavailableNotice items={state.data.unavailable} />
          {state.data.items.length === 0 ? (
            <p className="py-4 text-center font-mono text-sm text-muted-foreground">
              Nothing significant to clear.
            </p>
          ) : (
            <ScrollArea className="h-[420px]">
              <div className="space-y-1.5 pr-3">
                {state.data.items.map((item) => {
                  const cleaned = cleanedIds.has(item.id);
                  const busy = cleaningId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`flex flex-wrap items-start justify-between gap-3 rounded border px-3 py-2 ${
                        cleaned
                          ? "border-phosphor/20 bg-phosphor/5 opacity-60"
                          : item.risk === "medium"
                            ? "border-amber/20 bg-amber/5"
                            : "border-border bg-muted/30"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-mono text-xs font-medium">
                            {cleaned ? `${item.name}, cleaned` : item.name}
                          </h3>
                          <span className="font-mono text-xs font-bold tabular-nums text-phosphor">
                            {item.sizeFormatted}
                          </span>
                          {item.risk === "medium" && (
                            <Badge
                              variant="outline"
                              className="border-amber/30 px-1.5 py-0 font-mono text-[10px] text-amber"
                            >
                              review first
                            </Badge>
                          )}
                          {item.requiresRoot && (
                            <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                              needs admin
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {item.description}
                        </p>
                        <p
                          className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/60"
                          title={item.path}
                        >
                          {item.path}
                          {item.fileCount !== null
                            ? `, ${item.fileCount.toLocaleString()} files`
                            : ", file count unavailable"}
                        </p>
                      </div>
                      {!cleaned && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Clean ${item.name}, freeing about ${item.sizeFormatted}`}
                          className="h-6 min-h-6 shrink-0 px-2 font-mono text-xs text-phosphor hover:bg-phosphor/10"
                          onClick={() => onClean(item)}
                          disabled={busy || item.requiresRoot || cleaningId !== null}
                          title={
                            item.requiresRoot
                              ? "Requires administrator rights; run manually"
                              : undefined
                          }
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
  );
}

export interface PrivacyViewProps {
  state: OnDemand<PrivacyResult>;
  onClose: () => void;
}

export function PrivacyView({ state, onClose }: PrivacyViewProps) {
  return (
    <Panel
      id="privacy"
      title="Privacy scan"
      phase={state.phase}
      error={state.error}
      stale={state.stale}
      lastUpdated={state.lastUpdated}
      loadingMessage="Checking connections, resolving endpoints, reading permissions…"
      onRefresh={state.run}
      onClose={onClose}
      badges={
        state.data && (
          <>
            <ScorePill
              label="Privacy"
              score={state.data.privacyScore}
              complete={state.data.complete}
            />
            <Badge variant="outline" className="font-mono text-xs">
              {state.data.connectionCount} connections, {state.data.resolvedCount} resolved,{" "}
              {state.data.unknownCount} unknown
            </Badge>
            {state.data.trackerCount > 0 && (
              <Badge variant="outline" className="border-alarm/30 font-mono text-xs text-alarm">
                {state.data.trackerCount} tracker connection(s)
              </Badge>
            )}
          </>
        )
      }
    >
      {state.data && (
        <div className="space-y-2">
          <UnavailableNotice items={state.data.unavailable} />
          <ScrollArea className="h-[420px]">
            <div className="space-y-2 pr-3">
              {state.data.findings.length === 0 ? (
                <p className="py-4 text-center font-mono text-sm text-muted-foreground">
                  No findings from the checks that ran.
                </p>
              ) : (
                state.data.findings.map((f, i) => (
                  <article
                    key={`${f.category}-${i}`}
                    className={`space-y-1.5 rounded border px-3 py-2.5 ${severityCardClass(f.severity)}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${severityDotClass(f.severity)}`}
                      />
                      <h3 className="font-mono text-xs font-medium">{f.title}</h3>
                      <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                        {f.category}
                      </Badge>
                      <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                        {SEVERITY_LABEL[f.severity] ?? f.severity}
                      </Badge>
                    </div>
                    {f.items.length > 0 && (
                      <ul className="space-y-0.5 pl-3.5">
                        {f.items.slice(0, 6).map((item, j) => (
                          <li
                            key={j}
                            className="truncate font-mono text-xs text-muted-foreground"
                            title={item}
                          >
                            {item}
                          </li>
                        ))}
                        {f.items.length > 6 && (
                          <li className="font-mono text-xs text-muted-foreground/60">
                            and {f.items.length - 6} more
                          </li>
                        )}
                      </ul>
                    )}
                    <p className="pl-3.5 font-mono text-xs">
                      <span className="text-phosphor/80">Fix:</span>{" "}
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
  );
}
