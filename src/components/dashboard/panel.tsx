"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { PollPhase } from "@/hooks/use-polling";
import type { Unavailable } from "@/lib/schemas";

/** Severity rendered as text, never colour alone (M-10). */
export const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  warning: "Warning",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export function severityDotClass(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "bg-red-500";
    case "warning":
    case "medium":
      return "bg-amber-500";
    case "low":
      return "bg-blue-400";
    default:
      return "bg-muted-foreground";
  }
}

export function severityCardClass(severity: string): string {
  switch (severity) {
    case "critical":
      return "bg-red-500/10 border-red-500/25";
    case "high":
      return "bg-red-500/5 border-red-500/20";
    case "warning":
    case "medium":
      return "bg-amber-500/5 border-amber-500/20";
    default:
      return "bg-muted/30 border-border";
  }
}

export interface ScorePillProps {
  label: string;
  score: number | null;
  complete: boolean;
}

/**
 * H-03 made visible: when evidence is missing the score is withheld outright
 * rather than rendered as a reassuring number.
 */
export function ScorePill({ label, score, complete }: ScorePillProps) {
  if (score === null || !complete) {
    return (
      <Badge variant="outline" className="border-amber-500/30 font-mono text-xs text-amber-400">
        {label}: unavailable — scan incomplete
      </Badge>
    );
  }
  const tone =
    score >= 80
      ? "border-emerald-500/30 text-emerald-400"
      : score >= 50
        ? "border-amber-500/30 text-amber-400"
        : "border-red-500/30 text-red-400";
  return (
    <Badge variant="outline" className={`font-mono text-xs ${tone}`}>
      {label}: {score}/100
    </Badge>
  );
}

export function UnavailableNotice({ items }: { items: Unavailable[] }) {
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 font-mono text-xs"
    >
      <p className="font-medium text-amber-400">
        {items.length} check{items.length === 1 ? "" : "s"} could not run — results are incomplete
      </p>
      <ul className="mt-1 space-y-0.5 pl-3 text-muted-foreground">
        {items.map((u) => (
          <li key={u.check}>
            {u.check}: {u.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface PanelProps {
  id: string;
  title: string;
  phase: PollPhase;
  error: string | null;
  stale: boolean;
  lastUpdated: number | null;
  loadingMessage: string;
  badges?: ReactNode;
  onRefresh: () => void;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Shared panel shell with explicit idle/loading/error/stale states (M-05).
 * Previously a failed scan cleared its result while leaving the card open,
 * rendering `null` — an empty box with no explanation and no way to retry.
 */
export function Panel({
  id,
  title,
  phase,
  error,
  stale,
  lastUpdated,
  loadingMessage,
  badges,
  onRefresh,
  onClose,
  children,
}: PanelProps) {
  const busy = phase === "loading";
  return (
    <Card className="border-border" aria-busy={busy}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 id={`${id}-heading`} className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          {title}
          {badges}
          {stale && (
            <Badge variant="outline" className="border-amber-500/30 font-mono text-xs text-amber-400">
              showing previous result
            </Badge>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-mono text-xs text-muted-foreground"
            onClick={onRefresh}
            disabled={busy}
            aria-label={`Re-run ${title}`}
          >
            {busy ? "…" : "Re-scan"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 font-mono text-xs text-muted-foreground"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {error && (
          <div
            role="alert"
            className="mb-3 rounded border border-red-500/20 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-400"
          >
            <p>{error}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-6 px-2 font-mono text-xs text-red-300"
              onClick={onRefresh}
            >
              Retry
            </Button>
          </div>
        )}

        {busy && phase === "loading" && (
          <p role="status" className="py-8 text-center font-mono text-sm text-muted-foreground motion-safe:animate-pulse">
            {loadingMessage}
          </p>
        )}

        {!busy && children}

        {lastUpdated && !busy && (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground/60">
            Last updated {new Date(lastUpdated).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
