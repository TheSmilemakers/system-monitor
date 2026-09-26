import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { finiteInt } from "@/lib/probe";
import { tapeFrame, tapeIndex } from "@/lib/sampler";

/**
 * GET /api/tape: the timestamps of every recorded frame (the last hour).
 * GET /api/tape?at=<ms>: the frame nearest that time: the top processes as
 * they were, so the table can be rewound alongside the scope.
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

  const at = finiteInt(new URL(request.url).searchParams.get("at"), 0);
  if (at > 0) {
    const frame = tapeFrame(at);
    if (!frame)
      return NextResponse.json({ error: "No frame recorded near that time" }, { status: 404 });
    return NextResponse.json(frame);
  }
  return NextResponse.json({ frames: tapeIndex(), timestamp: Date.now() });
}
