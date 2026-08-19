import { NextResponse } from "next/server";
import { devOwner } from "../../../../lib/api/route-owner";
import { runPrescaffold } from "../../../../lib/render/run-preview-build";

/** Dev-lane twin (NODE_ENV-gated in devOwner) — the witness harness's entry. */
export async function POST(request: Request) {
  const owner = devOwner();
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
