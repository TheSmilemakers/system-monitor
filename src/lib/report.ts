import type { MonitorEvent } from "./monitor";
import type { PostureLamp } from "./posture";
import type { ProcessInfo } from "./sampler";

/**
 * The shift report: a plain-text printout of the machine's state and what
 * changed. Fixed-width, 78 columns, dot-matrix by design: it pastes into a
 * ticket, prints on anything, and reads without a screen. Pure: the route
 * gathers the inputs; this only formats them.
 */

export interface ReportInputs {
  now: number;
  machine: string;
  uptime: string;
  lamps: readonly PostureLamp[];
  processes: readonly ProcessInfo[];
  events: readonly MonitorEvent[];
  baselineAt: number | null;
  destinations: readonly {
    host: string;
    connections: number;
    tracker: string | null;
    fresh: boolean;
  }[];
  listeners: readonly { port: number; name: string | null }[];
}

const WIDTH = 78;
const line = (ch = "-") => ch.repeat(WIDTH);
const pad = (s: string, n: number) =>
  s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
const rpad = (s: string, n: number) =>
  s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;

function heading(title: string): string[] {
  return ["", title.toUpperCase(), line("=")];
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const STATE_MARK: Record<string, string> = {
  ok: "[ OK ]",
  caution: "[WARN]",
  alarm: "[FAIL]",
  info: "[INFO]",
  off: "[ -- ]",
};

export function buildReport(i: ReportInputs): string {
  const out: string[] = [];
  out.push(line("="));
  out.push("SYSTEM MONITOR  SHIFT REPORT");
  out.push(`${i.machine}   printed ${fmtTime(i.now)}   up ${i.uptime}`);
  out.push(line("="));

  out.push(...heading("Posture"));
  for (const l of i.lamps)
    out.push(`${STATE_MARK[l.state] ?? "[ ?? ]"} ${pad(l.label, 14)} ${l.summary}`.trimEnd());

  out.push(...heading("Top processes by CPU"));
  out.push(`${pad("PID", 7)}${pad("CPU%", 7)}${pad("MEM%", 6)}${pad("TRUST", 13)}PROCESS`);
  for (const p of [...i.processes].sort((a, b) => b.cpu - a.cpu).slice(0, 20)) {
    out.push(
      `${pad(String(p.pid), 7)}${pad(p.cpu.toFixed(1), 7)}${pad(p.mem.toFixed(1), 6)}${pad(p.trust, 13)}${p.command}${p.publisher && p.trust !== "apple" ? ` (${p.publisher})` : ""}`.slice(
        0,
        WIDTH,
      ),
    );
  }
  const suspect = i.processes.filter((p) => p.trust === "unsigned" || p.trust === "adhoc");
  if (suspect.length > 0) {
    out.push("");
    out.push(`Unsigned or ad-hoc signed executables running: ${suspect.length}`);
    for (const p of suspect.slice(0, 20))
      out.push(`  ${pad(p.trust, 9)} ${p.path || p.command}`.slice(0, WIDTH));
  }

  out.push(...heading("Network"));
  if (i.listeners.length > 0) {
    out.push(
      `Listening on the network: ${i.listeners.map((l) => (l.name ? `${l.port} (${l.name})` : String(l.port))).join(", ")}`.slice(
        0,
        WIDTH,
      ),
    );
  } else {
    out.push("No ports bound to the network.");
  }
  out.push(`${pad("CONNS", 7)}${pad("NEW", 5)}${pad("DESTINATION", 36)}NOTE`);
  for (const d of i.destinations.slice(0, 25)) {
    const note = d.tracker ? `tracker: ${d.tracker}` : "";
    out.push(
      `${rpad(String(d.connections), 5)}  ${pad(d.fresh ? "NEW" : "", 5)}${pad(d.host, 36)}${note}`
        .trimEnd()
        .slice(0, WIDTH),
    );
  }
  if (i.destinations.some((d) => d.fresh))
    out.push("NEW marks a destination not seen when the baseline was recorded.");

  out.push(...heading("Timeline, last 24 hours"));
  out.push(
    i.baselineAt === null
      ? "No baseline recorded yet."
      : `Baseline recorded ${fmtTime(i.baselineAt)}.`,
  );
  const dayAgo = i.now - 24 * 60 * 60 * 1000;
  const recent = i.events.filter((e) => e.ts >= dayAgo);
  if (recent.length === 0) out.push("No events.");
  for (const e of recent.slice(0, 60)) {
    const mark = e.severity === "alarm" ? "!!" : e.severity === "caution" ? " !" : "  ";
    out.push(
      `${fmtTime(e.ts).slice(11)} ${mark} ${pad(e.category, 12)}${e.message}`.slice(0, WIDTH),
    );
  }

  out.push("");
  out.push(line("="));
  out.push("Every figure above was read on this machine with read-only tools.");
  out.push("Nothing was sent anywhere.");
  out.push(line("="));
  return out.join("\n") + "\n";
}
