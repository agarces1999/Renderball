import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { parseUploadForm, uploadImageElement } from "../../../../lib/edit/upload-image";

/**
 * Upload an image and insert it as a canvas element — the insert-image
 * toolbar's real path (was placeholder-only). Deterministic: magic-byte
 * validation, document-asset storage, primitive insert. No LLM, no spend,
 * so no breaker/cap — auth + ownership only (same posture as edit-layout).
 *
 * POST multipart/form-data: file, scriptId, sceneIndex, bounds (JSON {x,y,w,h})
 * Returns: { ok, sceneIndex, pieceId } | { ok:false, error }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }

  const parsed = parseUploadForm(form);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const script = await loadScript(parsed.scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  const genDir = await documentDir(parsed.scriptId);
  const result = await uploadImageElement(genDir, parsed);
  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  return NextResponse.json(
    result.ok
      ? { ok: true, sceneIndex: parsed.sceneIndex, pieceId: result.pieceId }
      : { ok: false, error: result.error },
    { status },
  );
}
