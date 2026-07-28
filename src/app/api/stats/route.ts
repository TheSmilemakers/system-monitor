import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { sample } from "@/lib/sampler";
import { singleFlight } from "@/lib/single-flight";

/** Core probes — if these fail there is no meaningful dashboard to render. */
const CORE_CHECKS = ["cpu/load (top)", "memory (vm_stat)", "processes (ps)"];

export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const data = await singleFlight("stats-sample", sample);

  // H-03: a failed core collection must not be served as zero-filled "healthy"
  // data. Report it as a service failure instead.
  const coreFailures = data.unavailable.filter((u) => CORE_CHECKS.includes(u.check));
  if (coreFailures.length === CORE_CHECKS.length) {
    return NextResponse.json(
      {
        error: "System metrics are unavailable",
        unavailable: data.unavailable,
        timestamp: data.timestamp,
      },
      { status: 503 },
    );
  }

  return NextResponse.json(data);
}
