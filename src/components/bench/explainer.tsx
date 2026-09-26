"use client";

import { useEffect } from "react";

import { useOnDemand } from "@/hooks/use-polling";
import { explainTrust } from "@/lib/process-model";
import { parseExplanation, type Explanation, type ProcessInfo } from "@/lib/schemas";

const SOURCE_LABEL: Record<Explanation["source"], string> = {
  "knowledge-base": "from the knowledge base",
  "man-page": "from Apple's manual page",
  heuristic: "inferred from the path and signature",
};

const KILL_LABEL: Record<NonNullable<Explanation["kill"]>, { text: string; state: string }> = {
  safe: { text: "safe to quit", state: "ok" },
  restarts: { text: "relaunches on its own", state: "info" },
  avoid: { text: "do not terminate", state: "alarm" },
};

function explainUrl(p: ProcessInfo): string {
  const q = new URLSearchParams({
    name: p.command,
    path: p.path,
    trust: p.trust,
    publisher: p.publisher ?? "",
    bundleId: p.bundleId ?? "",
  });
  return `/api/explain?${q.toString()}`;
}

/**
 * "What it is": the explanation for the inspected process, fetched when the
 * process changes, with its source named, then the trust line.
 */
export function Explainer({ proc }: { proc: ProcessInfo }) {
  const url = explainUrl(proc);
  const state = useOnDemand(url, parseExplanation);
  const run = state.run;

  useEffect(() => {
    void run();
  }, [run, url]);

  const e = state.data;
  return (
    <section aria-labelledby="insp-what" className="mt-3">
      <h3 id="insp-what" className="engraved">
        What it is
      </h3>
      {state.phase === "loading" && !e && (
        <p role="status" className="mt-1 font-mono text-xs text-muted-foreground">
          Looking it up…
        </p>
      )}
      {state.error && !e && (
        <p role="alert" className="mt-1 font-mono text-xs text-amber">
          Could not look it up: {state.error}
        </p>
      )}
      {e && (
        <div className="mt-1 space-y-1.5">
          <p className="leading-relaxed">{e.what}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-sans text-xs">
            {e.normal && (
              <>
                <dt className="text-muted-foreground">normally</dt>
                <dd>{e.normal}</dd>
              </>
            )}
            {e.worry && (
              <>
                <dt className="text-muted-foreground">worry when</dt>
                <dd>{e.worry}</dd>
              </>
            )}
            {e.check && (
              <>
                <dt className="text-muted-foreground">check</dt>
                <dd>{e.check}</dd>
              </>
            )}
          </dl>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            {e.kill && (
              <span className="lamp" data-state={KILL_LABEL[e.kill].state}>
                <span>{KILL_LABEL[e.kill].text}</span>
              </span>
            )}
            <span>{SOURCE_LABEL[e.source]}</span>
          </p>
        </div>
      )}
      <p className="mt-2 font-sans text-xs text-muted-foreground">{explainTrust(proc)}</p>
    </section>
  );
}
