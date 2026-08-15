import { NextResponse } from "next/server";
import { devOwner, toResponse } from "../../../../lib/api/route-owner";
import {
  listEditableFields,
  applyElementTextEdit,
  type EditElementBody,
} from "../../../../lib/api/handlers/edit-element";

/**
 * Headless counterpart to /api/preview/edit-element for the QA editor harness
 * (no Clerk session). Same handler, different owner — see
 * lib/api/route-owner.ts for why that is the ONLY difference allowed.
 * NODE_ENV-gated inside devOwner(): 404 in production.
 */
export async function GET(request: Request) {
  const owner = devOwner();
  if (!owner.ok) return owner.response;
  return toResponse(await listEditableFields(new URL(request.url), owner.ownerId));
}

export async function POST(request: Request) {
  const owner = devOwner();
  if (!owner.ok) return owner.response;
  let body: EditElementBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return toResponse(await applyElementTextEdit(body, owner.ownerId));
}
