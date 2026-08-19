import { NextResponse } from "next/server";
import { sessionOwner } from "../../../../lib/api/route-owner";
import { runPrescaffold } from "../../../../lib/render/run-preview-build";

/**
 * Fire the speculative scaffold for a document whose outline just reached
 * the approval beat. Fire-and-forget: 202 immediately, the job runs in this
 * long-lived process, and every failure path degrades to the build
 * scaffolding for itself. Spend lands in the normal build scope.
 */
export async function POST(request: Request) {
  const owner = await sessionOwner();
  if (!owner.ok) return owner.response;
  let body: { scriptId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { scriptId } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  void runPrescaffold(scriptId, owner.ownerId);
  return NextResponse.json({ ok: true, started: true }, { status: 202 });
}
