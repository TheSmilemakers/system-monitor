import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { loadBaseline, recentEvents } from "@/lib/monitor";
import { networkReport } from "@/lib/network";
import { posture } from "@/lib/posture";
import { getMachineInfo } from "@/lib/probe";
import { buildReport } from "@/lib/report";
import { lastProcesses, sample } from "@/lib/sampler";
import { singleFlight } from "@/lib/single-flight";

/**
 * GET /api/report: the shift report as plain text. Gathers the posture, the
 * latest sample, the network picture and the last day of events, and hands
 * them to the formatter. Marked no-store like every API response.
 */
export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return new Response(`Refused: ${e.message}\n`, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw e;
  }

  const text = await singleFlight("report", async () => {
    const now = Date.now();
    // A sample if none has been taken yet, so the report is never empty.
    const stats = lastProcesses().length > 0 ? null : await sample();
    const [machine, lamps, net, events, baseline] = await Promise.all([
      getMachineInfo(),
      posture(now).then((r) => r.lamps),
      networkReport(now),
      recentEvents(now - 24 * 60 * 60 * 1000),
      loadBaseline(),
    ]);
    return buildReport({
      now,
      machine: machine.model,
      uptime: stats?.uptime ?? "",
      lamps,
      processes: stats?.processes.top ?? lastProcesses(),
      events,
      baselineAt: baseline?.createdAt ?? null,
      destinations: net.destinations.map((d) => ({
        host: d.host,
        connections: d.connections,
        tracker: d.tracker ? d.tracker.description : null,
        fresh: d.newSinceBaseline,
      })),
      listeners: net.listeners,
    });
  });

  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
