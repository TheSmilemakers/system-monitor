"use client";

import { Sparkline } from "@/components/dashboard/sparkline";
import { formatBytes, formatDuration } from "@/lib/format";
import type { ProcessAlert, ProcessDetail, ProcessInfo } from "@/lib/schemas";

/**
 * "Right now": live detail for the inspected process. CPU trace, state and
 * priority, threads and energy, open files, and network connections with
 * resolved hosts. A check that could not run is named, not shown as zero.
 */
export function LiveDetail({
  proc,
  alert,
  detail,
  error,
}: {
  proc: ProcessInfo;
  alert: ProcessAlert | null;
  detail: ProcessDetail | null;
  error: string | null;
}) {
  const d = detail;
  const cpuTone = proc.cpu > 50 ? "text-alarm" : proc.cpu > 20 ? "text-amber" : "";

  return (
    <section aria-labelledby="insp-now" className="mt-3">
      <h3 id="insp-now" className="engraved flex items-center justify-between">
        <span>Right now</span>
        {d?.suspended && (
          <span className="lamp normal-case tracking-normal" data-state="caution">
            <span>suspended</span>
          </span>
        )}
        {d && !d.alive && (
          <span className="lamp normal-case tracking-normal" data-state="off">
            <span>exited</span>
          </span>
        )}
      </h3>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
        <dt className="text-muted-foreground">cpu</dt>
        <dd className={cpuTone}>
          {proc.cpu.toFixed(1)}% of one core
          {alert && ` for ${formatDuration(alert.duration)}`}
        </dd>
        <dt className="text-muted-foreground">memory</dt>
        <dd>
          {formatBytes(proc.rss)} resident, {proc.mem.toFixed(1)}% of RAM
        </dd>
        {d && (
          <>
            <dt className="text-muted-foreground">threads</dt>
            <dd>
              {d.threads ?? "unknown"}
              {d.energy !== null && `, energy impact ${d.energy.toFixed(1)}`}
              {d.nice !== 0 && `, priority ${d.nice > 0 ? "lowered" : "raised"} (nice ${d.nice})`}
            </dd>
            <dt className="text-muted-foreground">open files</dt>
            <dd>{d.openFiles ?? "unknown"}</dd>
            <dt className="text-muted-foreground">network</dt>
            <dd>
              {d.connections.length === 0 ? (
                "no connections"
              ) : (
                <ul className="space-y-0.5">
                  {d.connections.slice(0, 8).map((c, i) => (
                    <li key={i} className="truncate" title={`${c.local} to ${c.remote}`}>
                      <span className="text-cathode">{c.proto}</span>{" "}
                      {c.remote ? (c.host ?? c.remote) : `listening on ${c.local}`}
                      {c.state && (
                        <span className="text-muted-foreground"> {c.state.toLowerCase()}</span>
                      )}
                    </li>
                  ))}
                  {d.connections.length > 8 && (
                    <li className="text-muted-foreground">and {d.connections.length - 8} more</li>
                  )}
                </ul>
              )}
            </dd>
          </>
        )}
      </dl>
      {d && d.history.length >= 2 && (
        <div className="mt-2">
          <Sparkline
            data={d.history.map((h) => h.cpu)}
            max={100}
            color="var(--phosphor)"
            label={`${proc.command} CPU`}
            unit="%"
            warnAt={50}
          />
        </div>
      )}
      {d && d.unavailable.length > 0 && (
        <p role="status" className="mt-1 font-mono text-[11px] text-amber">
          Could not check: {d.unavailable.map((u) => `${u.check} (${u.reason})`).join(", ")}
        </p>
      )}
      {error && !d && (
        <p role="alert" className="mt-1 font-mono text-[11px] text-amber">
          Live detail unavailable: {error}
        </p>
      )}
    </section>
  );
}
