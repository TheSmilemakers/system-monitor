import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { persistenceReport } from "@/lib/persistence";
import { singleFlight } from "@/lib/single-flight";

/** GET /api/persistence: launch agents and daemons, profiles (see src/lib/persistence.ts). */
export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
  const data = await singleFlight("persistence", () => persistenceReport());
  return NextResponse.json(data);
}
