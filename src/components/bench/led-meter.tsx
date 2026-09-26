/**
 * A ten-segment LED bar meter. Instruments step; they do not ease: a meter
 * that glides is lying about the sample. Segments above the warn and critical
 * thresholds take those hues, so the thresholds are visible as steps even
 * when the value sits below them.
 */

export type Level = "ok" | "warn" | "critical";

export const LEVEL_TEXT: Record<Level, string> = {
  ok: "normal",
  warn: "elevated",
  critical: "critical",
};

export function levelFor(value: number, warn: number, critical: number): Level {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

export interface LedMeterProps {
  value: number;
  max: number;
  warnAt: number;
  critAt: number;
  label: string;
  segments?: number;
}

export function LedMeter({ value, max, warnAt, critAt, label, segments = 10 }: LedMeterProps) {
  const safeMax = max > 0 ? max : 1;
  const lit = Math.round(Math.min(Math.max(value / safeMax, 0), 1) * segments);
  const level = levelFor(value, warnAt, critAt);
  const pct = Math.round((value / safeMax) * 100);

  return (
    <div
      className="flex gap-[3px]"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeMax)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${pct}% of scale, ${LEVEL_TEXT[level]}`}
    >
      {Array.from({ length: segments }, (_, i) => {
        const at = ((i + 1) / segments) * safeMax;
        const hue =
          at >= critAt ? "var(--alarm)" : at >= warnAt ? "var(--amber)" : "var(--phosphor)";
        const on = i < lit;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="h-2 flex-1 rounded-[2px]"
            style={{
              background: on ? hue : "color-mix(in oklch, var(--edge) 70%, transparent)",
              boxShadow: on ? `0 0 4px color-mix(in oklch, ${hue} 45%, transparent)` : "none",
            }}
          />
        );
      })}
    </div>
  );
}
