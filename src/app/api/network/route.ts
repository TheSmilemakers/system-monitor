import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { networkReport } from "@/lib/network";
import { singleFlight } from "@/lib/single-flight";

/** GET /api/network: connections by process and destination, listeners (see src/lib/network.ts). */
export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
  const data = await singleFlight("network", () => networkReport());
  return NextResponse.json(data);
}
