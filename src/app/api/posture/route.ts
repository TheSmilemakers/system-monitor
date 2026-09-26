import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { posture } from "@/lib/posture";
import { singleFlight } from "@/lib/single-flight";

/** Security posture lamps. Read-only probes; see src/lib/posture.ts. */
export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const data = await singleFlight("posture", () => posture());
  return NextResponse.json(data);
}
