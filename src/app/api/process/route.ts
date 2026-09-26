import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { finiteInt } from "@/lib/probe";
import { processDetail } from "@/lib/process-detail";
import { singleFlight } from "@/lib/single-flight";

/** GET /api/process?pid=N: live detail for one process (see src/lib/process-detail.ts). */
export async function GET(request: Request) {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const pid = finiteInt(new URL(request.url).searchParams.get("pid"), 0);
  if (pid <= 0) {
    return NextResponse.json({ error: "pid must be a positive integer" }, { status: 400 });
  }

  const data = await singleFlight(`process-${pid}`, () => processDetail(pid));
  return NextResponse.json(data);
}
