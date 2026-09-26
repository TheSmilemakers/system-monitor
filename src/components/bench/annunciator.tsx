"use client";

import { useState } from "react";

import type { PostureReport } from "@/lib/schemas";

/**
 * The annunciator strip: security posture as a row of labelled lamps.
 * Lit phosphor is good, amber wants attention, alarm is failing, cathode is
 * informational, dark means not checked. Press a lamp to read what it means
 * and what to do; the same lamp again closes it. State is also in the text.
 */
export function Annunciator({
  report,
  error,
}: {
  report: PostureReport | null;
  error: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (!report) {
    return (
      <div
        role="status"
        className="border-b border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground sm:px-4"
      >
        {error ? `Posture check failed: ${error}` : "Checking security posture…"}
      </div>
    );
  }

  const open = report.lamps.find((l) => l.id === openId) ?? null;
  const worst = report.lamps.some((l) => l.state === "alarm")
    ? "alarm"
    : report.lamps.some((l) => l.state === "caution")
      ? "caution"
      : "ok";

  return (
    <section aria-label="Security posture" className="border-b border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5 sm:px-4">
        <span className="engraved">Posture</span>
        <span className="sr-only">
          {worst === "ok"
            ? "All checks normal."
            : worst === "caution"
              ? "Some checks want attention."
              : "A check is failing."}
        </span>
        {report.lamps.map((lamp) => {
          const isOpen = lamp.id === openId;
          return (
            <button
              key={lamp.id}
              type="button"
              onClick={() => setOpenId(isOpen ? null : lamp.id)}
              aria-expanded={isOpen}
              aria-controls="posture-detail"
              className={`lamp rounded px-1 py-0.5 hover:bg-accent ${isOpen ? "bg-accent" : ""}`}
              data-state={lamp.state}
              title={lamp.summary}
            >
              <span>{lamp.label}</span>
              <span className="sr-only">
                :{" "}
                {lamp.state === "ok" ? "normal" : lamp.state === "off" ? "not checked" : lamp.state}
                . {lamp.summary}
              </span>
            </button>
          );
        })}
        {!report.complete && (
          <span className="lamp ml-auto" data-state="off">
            <span>{report.unavailable.length} check(s) could not run</span>
          </span>
        )}
      </div>
      <div id="posture-detail" aria-live="polite">
        {open && (
          <div className="border-t border-border/60 px-3 py-2 sm:px-4">
            <p className="font-mono text-xs">
              <span className="lamp" data-state={open.state}>
                <span>{open.label}</span>
              </span>
              <span className="ml-3 text-foreground">{open.summary}</span>
            </p>
            <p className="mt-1 max-w-3xl font-sans text-sm leading-relaxed text-muted-foreground">
              {open.detail}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
