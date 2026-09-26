import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { recentEvents } from "@/lib/monitor";
import { singleFlight } from "@/lib/single-flight";
import { permissionsReport } from "@/lib/tcc";

const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

/** GET /api/permissions: TCC grants per service (see src/lib/tcc.ts), and the last week of grant changes. */
export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
  const data = await singleFlight("permissions", () => permissionsReport());
  const recent = (await recentEvents(Date.now() - HISTORY_MS)).filter(
    (e) => e.category === "permission",
  );
  return NextResponse.json({ ...data, recent });
}
