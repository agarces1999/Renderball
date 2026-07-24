import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../lib/auth";
import { getTokenUsageSummary } from "../../../lib/metering";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage — the account page's token meter (docs/METERING.md).
 * Returns the SAME numbers the allowance gate enforces:
 *   { usedTokens, freeTokens, freeRemaining, billingActive }
 * In RB_METERING=off this reports zeros against the allowance (the UI hides
 * the meter); 503 when the summary read fails so the client can hide rather
 * than render wrong numbers.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await getTokenUsageSummary(user.id);
  if (!summary) {
    return NextResponse.json({ error: "usage temporarily unavailable" }, { status: 503 });
  }
  return NextResponse.json(summary);
}
