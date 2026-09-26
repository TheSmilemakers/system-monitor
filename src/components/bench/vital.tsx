"use client";

import { Sparkline } from "@/components/dashboard/sparkline";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
  /** What the figure means and when to worry; opens from the small mark by the title. */
  hint?: string;
  meter: { value: number; max: number; warnAt: number; critAt: number };
  trace?: { data: number[]; max: number; unit?: string; warnAt?: number; critAt?: number };
}

const LEVEL_HUE: Record<Level, string> = {
  ok: "var(--phosphor)",
  warn: "var(--amber)",
  critical: "var(--alarm)",
};

export function Vital({ label, level, value, unit, breakdown, hint, meter, trace }: VitalProps) {
  return (
    <section
      aria-label={`${label}, status ${LEVEL_TEXT[level]}`}
      className="rounded-md border border-border bg-card px-3 py-2.5"
    >
      <h2 className="engraved flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          {label}
          {hint && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  aria-label={`About ${label}`}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border font-mono text-[10px] normal-case tracking-normal text-muted-foreground hover:text-foreground"
                >
                  ?
                </TooltipTrigger>
                <TooltipContent className="font-sans normal-case tracking-normal">
                  {hint}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </span>
        <span
          className="lamp"
          data-state={level === "ok" ? "ok" : level === "warn" ? "caution" : "alarm"}
        >
          <span aria-hidden="true">{LEVEL_TEXT[level]}</span>
        </span>
      </h2>
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
