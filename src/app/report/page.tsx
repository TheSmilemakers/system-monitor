"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The printout: the shift report on tractor-feed paper. Fetched as plain
 * text and shown in a monospace block; the print stylesheet strips the
 * chrome so "Print" or "Save as PDF" yields the report alone.
 */
export default function ReportPage() {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/report", { cache: "no-store", signal: ac.signal })
      .then(async (r) => {
        const body = await r.text();
        if (!r.ok) throw new Error(body.trim() || `Request failed (${r.status})`);
        setText(body);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Request failed");
      });
    return () => ac.abort();
  }, []);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground print:bg-white print:p-0 print:text-black">
      <header className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
        <Link href="/" className="font-display text-sm font-semibold tracking-wide hover:underline">
          System Monitor
        </Link>
        <span className="engraved">Shift report</span>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={text === null}
          className="rounded border border-border bg-bezel px-2 py-0.5 font-mono text-xs hover:text-foreground disabled:opacity-50"
        >
          Print or save as PDF
        </button>
        <button
          type="button"
          onClick={() => {
            if (text) void navigator.clipboard?.writeText(text);
          }}
          disabled={text === null}
          className="rounded border border-border bg-bezel px-2 py-0.5 font-mono text-xs hover:text-foreground disabled:opacity-50"
        >
          Copy text
        </button>
      </header>
      {error && (
        <p role="alert" className="font-mono text-sm text-alarm">
          {error}
        </p>
      )}
      {text === null && !error && (
        <p role="status" className="font-mono text-sm text-muted-foreground">
          Printing…
        </p>
      )}
      {text && (
        <pre className="printout max-w-[80ch] overflow-x-auto rounded-md border border-border bg-card p-4 font-mono text-[12px] leading-[1.35] print:border-0 print:bg-white print:p-0 print:text-[10.5pt]">
          {text}
        </pre>
      )}
    </main>
  );
}
