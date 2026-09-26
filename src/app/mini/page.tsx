"use client";

import Link from "next/link";

import { LedMeter, levelFor } from "@/components/bench/led-meter";
import { usePolling } from "@/hooks/use-polling";
import { parsePosture, parseStats, parseTimeline } from "@/lib/schemas";

/**
 * The mini window: the constant-monitor surface. Posture lamps, CPU and
 * memory meters, and the latest timeline event, sized for a small always-on
 * window (see README for opening it as an app window). Same probes, same
 * cadence discipline; nothing here is interactive except the link back to
 * the bench.
 */
export default function Mini() {
  const stats = usePolling({ url: "/api/stats", intervalMs: 10_000, parse: parseStats });
  const posture = usePolling({ url: "/api/posture", intervalMs: 60_000, parse: parsePosture });
  const timeline = usePolling({ url: "/api/timeline", intervalMs: 30_000, parse: parseTimeline });

  const s = stats.data;
  const latest = timeline.data?.events[0] ?? null;
  const lamps = posture.data?.lamps ?? [];
  const worst = lamps.some((l) => l.state === "alarm")
    ? "alarm"
    : lamps.some((l) => l.state === "caution")
      ? "caution"
      : lamps.length
        ? "ok"
        : "off";

  return (
    <main className="flex min-h-screen flex-col gap-2 bg-background p-3 text-foreground">
      <h1 className="sr-only">System Monitor, mini window</h1>
      <header className="flex items-center justify-between">
        <Link href="/" className="font-display text-sm font-semibold tracking-wide hover:underline">
          System Monitor
        </Link>
        <span className="lamp" data-state={worst}>
          <span>
            {worst === "ok"
              ? "normal"
              : worst === "caution"
                ? "attention"
                : worst === "alarm"
                  ? "failing"
                  : "checking"}
          </span>
        </span>
      </header>

      <div role="group" className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Security posture">
        {lamps.map((l) => (
          <span key={l.id} className="lamp" data-state={l.state} title={l.summary}>
            <span>{l.label}</span>
          </span>
        ))}
        {stats.error && !s && (
          <span role="alert" className="font-mono text-[11px] text-alarm">
            {stats.error}
          </span>
        )}
      </div>

      {s && (
        <div className="grid grid-cols-2 gap-3">
          <section aria-label={`CPU ${s.cpu.used.toFixed(0)} percent`}>
            <div className="flex items-baseline justify-between">
              <span className="engraved">CPU</span>
              <span
                className="segment text-lg"
                style={{
                  color:
                    levelFor(s.cpu.used, 60, 85) === "ok"
                      ? "var(--phosphor)"
                      : levelFor(s.cpu.used, 60, 85) === "warn"
                        ? "var(--amber)"
                        : "var(--alarm)",
                }}
              >
                {s.cpu.used.toFixed(0)}
              </span>
            </div>
            <LedMeter value={s.cpu.used} max={100} warnAt={60} critAt={85} label="CPU meter" />
          </section>
          <section aria-label={`Memory ${s.memory.percent} percent`}>
            <div className="flex items-baseline justify-between">
              <span className="engraved">Memory</span>
              <span
                className="segment text-lg"
                style={{
                  color:
                    levelFor(s.memory.percent, 70, 90) === "ok"
                      ? "var(--phosphor)"
                      : levelFor(s.memory.percent, 70, 90) === "warn"
                        ? "var(--amber)"
                        : "var(--alarm)",
                }}
              >
                {s.memory.percent}
              </span>
            </div>
            <LedMeter
              value={s.memory.percent}
              max={100}
              warnAt={70}
              critAt={90}
              label="Memory meter"
            />
          </section>
        </div>
      )}

      <p
        role="status"
        className="truncate font-mono text-[11px] text-muted-foreground"
        title={latest?.message}
      >
        {latest ? (
          <>
            <span
              className={
                latest.severity === "alarm"
                  ? "text-alarm"
                  : latest.severity === "caution"
                    ? "text-amber"
                    : ""
              }
            >
              {latest.message}
            </span>{" "}
            <span>{new Date(latest.ts).toLocaleTimeString()}</span>
          </>
        ) : (
          "No events yet."
        )}
      </p>
    </main>
  );
}
