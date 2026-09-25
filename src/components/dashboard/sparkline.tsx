"use client";

/**
 * Responsive sparkline (M-09, M-10).
 *
 * Scales to its container via `viewBox` + `width: 100%` instead of a fixed
 * 280px, which previously overflowed an `overflow-hidden` card on small
 * screens. Carries a textual summary for assistive technology, so the trend is
 * not conveyed by shape and colour alone.
 */

const VIEW_W = 280;
const VIEW_H = 48;
const PAD = 2;

export interface SparklineProps {
  data: number[];
  max: number;
  color: string;
  label: string;
  unit?: string;
  warnAt?: number;
  critAt?: number;
}

export function Sparkline({ data, max, color, label, unit = "", warnAt, critAt }: SparklineProps) {
  if (data.length < 2) {
    return (
      <div
        className="flex h-12 items-center justify-center font-mono text-xs text-muted-foreground"
        role="status"
      >
        collecting {label} history…
      </div>
    );
  }

  const h = VIEW_H - PAD * 2;
  const w = VIEW_W - PAD * 2;
  const step = w / (data.length - 1);
  const scale = Math.max(max, ...data, 1);

  const y = (v: number) => PAD + h - (Math.min(v, scale) / scale) * h;
  const points = data.map((v, i) => `${PAD + i * step},${y(v)}`).join(" ");
  const area = `${PAD},${PAD + h} ${points} ${PAD + (data.length - 1) * step},${PAD + h}`;

  const first = data[0];
  const last = data[data.length - 1];
  const peak = Math.max(...data);
  const direction = last > first * 1.1 ? "rising" : last < first * 0.9 ? "falling" : "steady";
  const summary = `${label} ${direction}. Now ${last.toFixed(1)}${unit}, peak ${peak.toFixed(1)}${unit} over the last ${data.length} samples.`;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-12 w-full"
        role="img"
        aria-label={summary}
      >
        {warnAt !== undefined && warnAt < scale && (
          <line
            x1={PAD}
            y1={y(warnAt)}
            x2={PAD + w}
            y2={y(warnAt)}
            stroke="oklch(0.828 0.189 84.429)"
            strokeWidth="0.5"
            strokeDasharray="3,3"
            opacity="0.4"
          />
        )}
        {critAt !== undefined && critAt < scale && (
          <line
            x1={PAD}
            y1={y(critAt)}
            x2={PAD + w}
            y2={y(critAt)}
            stroke="oklch(0.704 0.191 22.216)"
            strokeWidth="0.5"
            strokeDasharray="3,3"
            opacity="0.4"
          />
        )}
        <polygon points={area} fill={color} opacity="0.1" />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={PAD + (data.length - 1) * step} cy={y(last)} r="2.5" fill={color} />
      </svg>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}
