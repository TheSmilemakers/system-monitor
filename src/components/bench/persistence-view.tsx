"use client";

import { TrustLamp } from "@/components/bench/trust-lamp";
import { usePolling } from "@/hooks/use-polling";
import { parsePersistence, type LaunchItem } from "@/lib/schemas";

const SCOPE_LABEL: Record<LaunchItem["scope"], string> = {
  user: "user agents",
  "system-agent": "system agents",
  "system-daemon": "system daemons",
};

/**
 * The Persistence view: every launch agent and daemon with what it runs, when,
 * and who signed the program; new or changed since the baseline is flagged;
 * configuration profiles beneath. Polls once a minute while showing.
 */
export function PersistenceView({ active }: { active: boolean }) {
  const state = usePolling({
    url: "/api/persistence",
    intervalMs: 60_000,
    parse: parsePersistence,
    enabled: active,
  });
  const data = state.data;
  const scopes: LaunchItem["scope"][] = ["user", "system-agent", "system-daemon"];

  return (
    <section aria-labelledby="persistence-heading" className="flex h-[640px] min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="persistence-heading" className="engraved">
          Persistence
        </h2>
        <span role="status" className="font-mono text-[11px] text-muted-foreground">
          {data
            ? `${data.items.length} launch items, ${data.items.filter((i) => i.newSinceBaseline).length} new since baseline`
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
        {data &&
          scopes.map((scope) => {
            const items = data.items.filter((i) => i.scope === scope);
            return (
              <section
                key={scope}
                aria-labelledby={`persist-${scope}`}
                className="border-b border-border"
              >
                <h3 id={`persist-${scope}`} className="engraved px-3 pt-2">
                  {SCOPE_LABEL[scope]} ({items.length})
                </h3>
                {items.length === 0 ? (
                  <p className="px-3 pb-2 text-muted-foreground">none</p>
                ) : (
                  <ul className="pb-1">
                    {items.map((i) => (
                      <li key={i.file} className="grid grid-cols-[auto_1fr] gap-x-3 px-3 py-1.5">
                        <TrustLamp trust={i.trust} />
                        <div className="min-w-0">
                          <p className="truncate">
                            <span className={i.knownVendor ? "" : "font-medium"}>{i.label}</span>
                            {i.publisher && (
                              <span className="ml-2 text-muted-foreground">{i.publisher}</span>
                            )}
                            {!i.knownVendor && (
                              <span className="lamp ml-2" data-state="info">
                                <span>third party</span>
                              </span>
                            )}
                            {i.newSinceBaseline && (
                              <span className="lamp ml-2" data-state="alarm">
                                <span>new since baseline</span>
                              </span>
                            )}
                            {i.changedSinceBaseline && (
                              <span className="lamp ml-2" data-state="caution">
                                <span>changed since baseline</span>
                              </span>
                            )}
                          </p>
                          <p className="truncate text-muted-foreground" title={i.program ?? i.file}>
                            {i.program ?? "no program listed"}
                            {i.runAtLoad && ", runs at login"}
                            {i.keepAlive && ", kept alive"}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        {data && (
          <section aria-labelledby="profiles-heading" className="px-3 py-2">
            <h3 id="profiles-heading" className="engraved">
              Configuration profiles
            </h3>
            <p className="mt-1 text-muted-foreground">
              {data.profiles === null
                ? "could not be read"
                : data.profiles.length === 0
                  ? "none installed"
                  : data.profiles.join(", ")}
            </p>
          </section>
        )}
      </div>
    </section>
  );
}
