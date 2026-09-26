import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { singleFlight } from "@/lib/single-flight";
import { permissionsReport } from "@/lib/tcc";

/** GET /api/permissions: TCC grants per service (see src/lib/tcc.ts). */
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
  return NextResponse.json(data);
}
