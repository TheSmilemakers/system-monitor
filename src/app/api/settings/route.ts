import { NextResponse } from "next/server";

import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { loadSettings, saveSettings } from "@/lib/settings";

/**
 * GET /api/settings: what the server keeps for the user.
 * POST /api/settings {"notifications": boolean}: change it. The native shell
 * uses this for its Mute item; the bench uses the server action.
 */
async function guard(): Promise<Response | null> {
  try {
    await assertLocalRequest();
    return null;
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }
}

export async function GET() {
  const refused = await guard();
  if (refused) return refused;
  return NextResponse.json(await loadSettings());
}

export async function POST(request: Request) {
  const refused = await guard();
  if (refused) return refused;
  const body: unknown = await request.json().catch(() => null);
  const notifications =
    typeof body === "object" && body !== null && "notifications" in body
      ? (body as { notifications: unknown }).notifications
      : undefined;
  if (typeof notifications !== "boolean") {
    return NextResponse.json({ error: "notifications must be true or false" }, { status: 400 });
  }
  return NextResponse.json(await saveSettings({ notifications }));
}
