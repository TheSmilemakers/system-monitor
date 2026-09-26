import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { loadBaseline, recentEvents } from "@/lib/monitor";
import { finiteInt } from "@/lib/probe";

/**
 * GET /api/timeline?since=<ms>: the monitor's events, newest first, and when
 * the baseline was recorded. The monitor itself ticks from the stats route
 * (see src/app/api/stats/route.ts), so this only reads the log.
 */
export async function GET(request: Request) {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const since = Math.max(0, finiteInt(new URL(request.url).searchParams.get("since"), 0));
  const [events, baseline] = await Promise.all([recentEvents(since), loadBaseline()]);
  return NextResponse.json({
    events,
    baselineAt: baseline?.createdAt ?? null,
    timestamp: Date.now(),
  });
}
