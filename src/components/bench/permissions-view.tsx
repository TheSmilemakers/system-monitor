"use client";

import { usePolling } from "@/hooks/use-polling";
import { parsePermissions } from "@/lib/schemas";

/**
 * The Permissions view: which apps hold which privacy grants, high-risk
 * services first. Without Full Disk Access the database is unreadable and the
 * view says so rather than showing an empty, reassuring table.
 */
export function PermissionsView({ active }: { active: boolean }) {
  const state = usePolling({
    url: "/api/permissions",
    intervalMs: 60_000,
    parse: parsePermissions,
    enabled: active,
  });
  const data = state.data;
  const shortName = (client: string) => client.split(".").pop() || client;

  return (
    <section aria-labelledby="permissions-heading" className="flex h-[640px] min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="permissions-heading" className="engraved">
          Permissions
        </h2>
        <span role="status" className="font-mono text-[11px] text-muted-foreground">
          {data
            ? data.readable
              ? `${data.highRiskGrants} high-risk grant${data.highRiskGrants === 1 ? "" : "s"}`
              : "database not readable"
            : state.error
              ? `unavailable: ${state.error}`
              : "loading"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {data && !data.readable && (
          <div role="status" className="m-3 rounded border border-amber/30 bg-amber/5 p-3">
            <p className="font-medium text-amber">The permission database could not be read.</p>
            <p className="mt-1 font-sans text-sm text-muted-foreground">
              macOS protects it. Grant Full Disk Access to the terminal or app that runs this server
              (System Settings, Privacy &amp; Security, Full Disk Access) and this view will fill
              in. No conclusion about granted permissions is drawn until then.
            </p>
          </div>
        )}
        {data && data.readable && (
          <table className="w-full border-collapse">
            <caption className="sr-only">
              Privacy grants by service, high-risk services first
            </caption>
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="w-64 px-3 py-1.5 font-medium">
                  Service
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Granted to
                </th>
              </tr>
            </thead>
            <tbody>
              {data.grants.map((g) => (
                <tr key={g.service} className="border-b border-border/60 align-top">
                  <td className="px-3 py-1.5">
                    <span
                      className="lamp"
                      data-state={g.highRisk ? (g.clients.length ? "caution" : "ok") : "info"}
                    >
                      <span>{g.name}</span>
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    {g.clients.length === 0 ? (
                      <span className="text-muted-foreground">nothing</span>
                    ) : (
                      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {g.clients.map((c) => (
                          <li key={c} title={c}>
                            {shortName(c)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.recent.length > 0 && (
          <section aria-labelledby="permission-history-heading" className="px-3 py-2">
            <h3 id="permission-history-heading" className="engraved">
              Changes, last seven days
            </h3>
            <ol className="mt-1 space-y-0.5">
              {data.recent.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="tabular-nums text-muted-foreground">
                    {new Date(e.ts).toLocaleString()}
                  </span>
                  <span
                    className={
                      e.severity === "alarm"
                        ? "text-alarm"
                        : e.severity === "caution"
                          ? "text-amber"
                          : ""
                    }
                  >
                    {e.message}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {data && data.readable && data.recent.length === 0 && (
          <p className="px-3 py-2 text-muted-foreground">
            No grant has changed in the last seven days. The monitor compares grants every minute
            while the app is open.
          </p>
        )}
      </div>
    </section>
  );
}
