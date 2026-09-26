import { NextResponse } from "next/server";

import { explainProcess } from "@/lib/explain";
import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { TRUST_STATES, type TrustState } from "@/lib/schemas";

const MAX_LEN = 512;

/**
 * GET /api/explain?name=&path=&trust=&publisher=&bundleId=
 *
 * The client passes what it already knows about a process; the server
 * consults the knowledge base, the manual pages and its heuristics. Inputs
 * are length-capped and only ever reach argv (`man -w <name>`), never a shell.
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

  const q = new URL(request.url).searchParams;
  const str = (key: string): string => (q.get(key) ?? "").slice(0, MAX_LEN);
  const name = str("name");
  if (name.length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const trustRaw = str("trust");
  const trust: TrustState = (TRUST_STATES as readonly string[]).includes(trustRaw)
    ? (trustRaw as TrustState)
    : "unknown";
  const publisher = str("publisher");
  const bundleId = str("bundleId");

  const explanation = await explainProcess({
    name,
    path: str("path"),
    trust,
    publisher: publisher.length ? publisher : null,
    bundleId: bundleId.length ? bundleId : null,
  });
  return NextResponse.json(explanation);
}
