import { NextResponse } from "next/server";
import { sessionOwner, toResponse } from "../../../../lib/api/route-owner";
import {
  listEditableFields,
  applyElementTextEdit,
  type EditElementBody,
} from "../../../../lib/api/handlers/edit-element";

/**
 * Inline text edit for the signed-in editor. The work lives in
 * lib/api/handlers/edit-element (shared with the dev lane); this file is the
 * session boundary and nothing else.
 *
 * GET  ?scriptId=..&sceneIndex=..  → { ok, sceneIndex, fields: [{ path, label, value }] }
 * POST { scriptId, sceneIndex, path|matchText, op: "edit"|"delete", value? }
 *      or { scriptId, sceneIndex, edits: [...] } for a multi-field save.
 */
export async function GET(request: Request) {
  const owner = await sessionOwner();
  if (!owner.ok) return owner.response;
  return toResponse(await listEditableFields(new URL(request.url), owner.ownerId));
}

export async function POST(request: Request) {
  const owner = await sessionOwner();
  if (!owner.ok) return owner.response;
  let body: EditElementBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return toResponse(await applyElementTextEdit(body, owner.ownerId));
}
