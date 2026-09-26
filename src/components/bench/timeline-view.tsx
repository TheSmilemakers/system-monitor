"use client";

import { Button } from "@/components/ui/button";
import { usePolling } from "@/hooks/use-polling";
import { parseTimeline, type TimelineEvent } from "@/lib/schemas";

const CATEGORY_HUE: Record<string, string> = {
  process: "var(--phosphor)",
  network: "var(--cathode)",
  port: "var(--cathode)",
  persistence: "var(--amber)",
  posture: "var(--amber)",
  monitor: "var(--muted-foreground)",
};

function when(ts: number, now: number): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString(undefined, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * The timeline: a chart-recorder strip of what changed on the machine, newest
 * at the top, one pen colour per category, the severity spoken as text and
 * the rule that fired shown so it can be judged. Polls every fifteen
 * seconds while the tab is showing.
 */
export function TimelineView({
  active,
  onResetBaseline,
}: {
  active: boolean;
  onResetBaseline: () => void;
}) {
  const state = usePolling({
    url: "/api/timeline",
    intervalMs: 15_000,
    parse: parseTimeline,
    enabled: active,
  });
  const data = state.data;
  // Server time from the response; with no data there are no rows to date.
  const now = data?.timestamp ?? 0;

  return (
    <section aria-labelledby="timeline-heading" className="flex h-[640px] min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="timeline-heading" className="engraved">
          Timeline
          {data?.baselineAt && (
            <span className="ml-3 normal-case tracking-normal text-muted-foreground">
              baseline {new Date(data.baselineAt).toLocaleString()}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <span role="status" className="font-mono text-[11px] text-muted-foreground">
            {data
              ? `${data.events.length} event${data.events.length === 1 ? "" : "s"}`
              : state.error
                ? `unavailable: ${state.error}`
                : "loading"}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 font-mono text-xs"
            onClick={onResetBaseline}
            title="What is running and connected now becomes normal; new things after this are reported"
          >
            Reset baseline
          </Button>
        </div>
      </div>
      <ol
        className="min-h-0 flex-1 overflow-auto font-mono text-xs"
        aria-label="Events, newest first"
      >
        {data && data.events.length === 0 && (
          <li className="px-3 py-6 text-center text-muted-foreground">
            Nothing has changed since the baseline. The monitor checks every minute while the app is
            open.
          </li>
        )}
        {data?.events.map((e: TimelineEvent) => (
          <li
            key={e.id}
            className="flap grid grid-cols-[auto_auto_1fr] items-start gap-x-3 border-b border-border/60 px-3 py-1.5"
          >
            <span className="tabular-nums text-muted-foreground">{when(e.ts, now)}</span>
            <span
              className="lamp"
              data-state={
                e.severity === "alarm" ? "alarm" : e.severity === "caution" ? "caution" : "info"
              }
              style={{
                ["--lamp" as string]: CATEGORY_HUE[e.category] ?? "var(--muted-foreground)",
              }}
            >
              <span>{e.category}</span>
              <span className="sr-only">, {e.severity}</span>
            </span>
            <span>
              <span
                className={
                  e.severity === "alarm"
                    ? "text-alarm"
                    : e.severity === "caution"
                      ? "text-amber"
                      : ""
                }
              >
                {e.message}
              </span>
              <span className="ml-2 text-muted-foreground" title={e.subject}>
                {e.rule}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
