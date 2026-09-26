"use client";

import { Sparkline } from "@/components/dashboard/sparkline";

import { LedMeter, LEVEL_TEXT, type Level } from "./led-meter";

/**
 * One instrument on the vitals rail: an engraved title, a numeral (seven
 * segment at retro level 1 and above), a ten-segment meter, the breakdown
 * beneath, and the five-minute trace. Status is spoken as text after the
 * label so it reads "CPU, status elevated".
 */
export interface VitalProps {
  label: string;
  level: Level;
  /** The numeral as text; keep it short (digits, one separator, one unit). */
  value: string;
  unit?: string;
  breakdown: string;
  meter: { value: number; max: number; warnAt: number; critAt: number };
  trace?: { data: number[]; max: number; unit?: string; warnAt?: number; critAt?: number };
}

const LEVEL_HUE: Record<Level, string> = {
  ok: "var(--phosphor)",
  warn: "var(--amber)",
  critical: "var(--alarm)",
};

export function Vital({ label, level, value, unit, breakdown, meter, trace }: VitalProps) {
  return (
    <section
      aria-label={`${label}, status ${LEVEL_TEXT[level]}`}
      className="rounded-md border border-border bg-card px-3 py-2.5"
    >
      <h3 className="engraved flex items-center justify-between">
        <span>{label}</span>
        <span
          className="lamp"
          data-state={level === "ok" ? "ok" : level === "warn" ? "caution" : "alarm"}
        >
          <span aria-hidden="true">{LEVEL_TEXT[level]}</span>
        </span>
      </h3>
      <p className="mt-1 flex items-baseline gap-1">
        <span
          className="segment text-[28px] leading-none"
          style={{ color: LEVEL_HUE[level] }}
          aria-hidden="true"
        >
          {value}
        </span>
        {unit && (
          <span className="font-mono text-xs text-muted-foreground" aria-hidden="true">
            {unit}
          </span>
        )}
        <span className="sr-only">
          {value}
          {unit ?? ""}
        </span>
      </p>
      <div className="mt-2">
        <LedMeter
          value={meter.value}
          max={meter.max}
          warnAt={meter.warnAt}
          critAt={meter.critAt}
          label={`${label} meter`}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{breakdown}</p>
      {trace && (
        <div className="mt-1.5">
          <Sparkline
            data={trace.data}
            max={trace.max}
            color={LEVEL_HUE[level]}
            label={label}
            unit={trace.unit ?? ""}
            warnAt={trace.warnAt}
            critAt={trace.critAt}
          />
        </div>
      )}
    </section>
  );
}
