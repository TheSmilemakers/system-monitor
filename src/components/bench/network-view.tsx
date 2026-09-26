"use client";

import { useState } from "react";

import { usePolling } from "@/hooks/use-polling";
import { parseNetwork, type NetConnection } from "@/lib/schemas";

type Group = "destination" | "process";

/**
 * The Network view: connections grouped by destination or by process, with
 * resolved hosts, tracker matches, and a "new" lamp for destinations absent
 * from the baseline; network-bound listeners beneath. Polls every fifteen
 * seconds while showing.
 */
export function NetworkView({
  active,
  onInspect,
}: {
  active: boolean;
  onInspect: (pid: number) => void;
}) {
  const [group, setGroup] = useState<Group>("destination");
  const state = usePolling({
    url: "/api/network",
    intervalMs: 15_000,
    parse: parseNetwork,
    enabled: active,
  });
  const data = state.data;

  const byProcess = new Map<string, NetConnection[]>();
  for (const c of data?.connections ?? []) {
    const list = byProcess.get(`${c.process}:${c.pid}`) ?? [];
    list.push(c);
    byProcess.set(`${c.process}:${c.pid}`, list);
  }

  return (
    <section aria-labelledby="network-heading" className="flex h-[640px] min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="network-heading" className="engraved">
          Network
        </h2>
        <div role="group" aria-label="Group connections" className="flex gap-1">
          {(["destination", "process"] as Group[]).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              aria-pressed={group === g}
              className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                group === g
                  ? "border-phosphor/60 bg-phosphor/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              by {g}
            </button>
          ))}
        </div>
        <span role="status" className="font-mono text-[11px] text-muted-foreground">
          {data
            ? `${data.connections.length} connections, ${data.destinations.length} destinations, ${data.listeners.length} listeners`
            : state.error
              ? `unavailable: ${state.error}`
              : "loading"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {data && data.unavailable.length > 0 && (
          <p role="status" className="border-b border-border px-3 py-1.5 text-amber">
            Could not check: {data.unavailable.map((u) => `${u.check} (${u.reason})`).join(", ")}
          </p>
        )}

        {group === "destination" && data && (
          <table className="w-full border-collapse">
            <caption className="sr-only">Destinations, most connections first</caption>
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Destination
                </th>
                <th scope="col" className="w-12 px-2 py-1.5 text-right font-medium">
                  Conns
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Processes
                </th>
                <th scope="col" className="w-40 px-2 py-1.5 font-medium">
                  Note
                </th>
              </tr>
            </thead>
            <tbody>
              {data.destinations.map((d) => (
                <tr key={d.host} className="border-b border-border/60">
                  <td className="truncate px-3 py-1" title={d.host}>
                    {d.host}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{d.connections}</td>
                  <td className="truncate px-2 py-1 text-muted-foreground">
                    {d.processes.join(", ")}
                  </td>
                  <td className="px-2 py-1">
                    {d.tracker && (
                      <span className="lamp" data-state="alarm">
                        <span>
                          {d.tracker.category}: {d.tracker.description}
                        </span>
                      </span>
                    )}
                    {d.newSinceBaseline && (
                      <span className="lamp ml-2" data-state="caution">
                        <span>new since baseline</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {data.destinations.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    No outbound connections.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {group === "process" && data && (
          <ul aria-label="Connections by process">
            {[...byProcess.entries()].map(([key, conns]) => {
              const first = conns[0];
              return (
                <li key={key} className="border-b border-border/60 px-3 py-1.5">
                  <button
                    type="button"
                    className="font-medium hover:underline"
                    onClick={() => onInspect(first.pid)}
                    aria-label={`Inspect ${first.process}, PID ${first.pid}`}
                  >
                    {first.process}
                  </button>
                  <span className="ml-2 text-muted-foreground">PID {first.pid}</span>
                  <ul className="mt-0.5 space-y-0.5 pl-3">
                    {conns.map((c, i) => (
                      <li key={i} className="truncate">
                        <span className="text-cathode">{c.proto}</span>{" "}
                        {c.remote ? (c.host ?? c.remote) : `listening on ${c.local}`}
                        {c.state && (
                          <span className="text-muted-foreground"> {c.state.toLowerCase()}</span>
                        )}
                        {c.tracker && (
                          <span className="lamp ml-2" data-state="alarm">
                            <span>{c.tracker.description}</span>
                          </span>
                        )}
                        {c.newSinceBaseline && (
                          <span className="lamp ml-2" data-state="caution">
                            <span>new</span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}

        {data && (
          <section aria-labelledby="listeners-heading" className="border-t border-border px-3 py-2">
            <h3 id="listeners-heading" className="engraved">
              Listening on the network
            </h3>
            {data.listeners.length === 0 ? (
              <p className="mt-1 text-muted-foreground">No ports bound to the network.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {data.listeners.map((l) => (
                  <li key={l.port} className="lamp" data-state={l.name ? "caution" : "info"}>
                    <span>
                      {l.port}
                      {l.name ? ` ${l.name}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
