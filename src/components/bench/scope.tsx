"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";

import { alertTicks, buildTraces, describeScope, tracePoints } from "@/lib/scope-model";
import type { HistoryPoint, ProcessAlert } from "@/lib/schemas";

export interface ScopeProps {
  history: HistoryPoint[];
  alerts: ProcessAlert[];
  cores: number;
  net: { inKBps: number; outKBps: number };
}

const HEIGHT = 168;

/**
 * The vector scope: four traces over the five-minute window on one phosphor
 * grid. Drawn on a canvas per sample; afterglow comes from painting a
 * translucent tube-coloured wash before each trace pass, so the previous
 * frame persists faintly, like phosphor. Alert onsets are ticks on the time
 * axis. Time is the animation; nothing moves between samples. Under reduced
 * motion the wash is opaque, so there is no ghosting at all.
 */
export function Scope({ history, alerts, cores, net }: ScopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const traces = useMemo(() => buildTraces(history, cores), [history, cores]);
  const summary = describeScope(traces, history.length);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const css = getComputedStyle(canvas);
    const colour = (token: string) => css.getPropertyValue(token).trim() || "#5dff9e";
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = HEIGHT;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Afterglow wash.
    // Strong enough that a trace fades within a few samples; while the window
    // is still filling, earlier frames are stretched and would otherwise fan out.
    ctx.globalAlpha = reduced ? 1 : 0.7;
    ctx.fillStyle = colour("--tube");
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;

    // Grid: 25% horizontals, one-minute verticals.
    ctx.strokeStyle = colour("--edge");
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    for (let i = 1; i < 4; i++) {
      const y = Math.round((height * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      const x = Math.round((width * i) / 5) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Traces, drawn thinnest to boldest so CPU sits on top.
    for (const t of [...traces].reverse()) {
      const pts = tracePoints(t.values, t.max, width, height);
      if (pts.length === 0) continue;
      const stroke = t.color.startsWith("var(") ? colour(t.color.slice(4, -1)) : t.color;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = t.id === "cpu" ? 1.8 : 1.2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      const last = pts[pts.length - 1];
      ctx.fillStyle = stroke;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Alert onsets on the time axis.
    const ticks = alertTicks(alerts, history, width, Date.now());
    ctx.strokeStyle = colour("--alarm");
    ctx.lineWidth = 2;
    for (const tick of ticks) {
      ctx.beginPath();
      ctx.moveTo(tick.x, height - 8);
      ctx.lineTo(tick.x, height);
      ctx.stroke();
    }
  }, [traces, alerts, history, reduced]);

  return (
    <section
      aria-label="Vector scope"
      className="tube-fx rounded-md border border-border bg-card px-3 pb-2 pt-2.5"
    >
      <h2 className="engraved flex flex-wrap items-center justify-between gap-2">
        <span>Scope, last five minutes</span>
        <span className="flex flex-wrap gap-x-3 normal-case tracking-normal">
          {traces.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 font-mono text-[11px]">
              <span
                aria-hidden="true"
                className="inline-block h-[2px] w-3"
                style={{ background: t.color }}
              />
              <span className="text-muted-foreground">{t.label}</span>
              <span className="tabular-nums text-foreground">{t.now}</span>
            </span>
          ))}
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            in {Math.round(net.inKBps)} out {Math.round(net.outKBps)} KB/s
          </span>
        </span>
      </h2>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={summary}
        className="mt-2 block w-full rounded-sm bg-tube"
        style={{ height: HEIGHT }}
      />
      <p className="sr-only">{summary}</p>
    </section>
  );
}
