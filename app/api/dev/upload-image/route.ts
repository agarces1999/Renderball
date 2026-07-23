import { NextResponse } from "next/server";
import path from "path";
import { parseUploadForm, uploadImageElement } from "../../../../lib/edit/upload-image";

/**
 * Dev-only upload-image route — headless counterpart to
 * /api/preview/upload-image (no Clerk session). NODE_ENV-gated (404 in prod).
 *
 * POST multipart/form-data: file, scriptId, sceneIndex, bounds (JSON {x,y,w,h})
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
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

  const genDir = path.join(process.cwd(), "src", "generated", parsed.scriptId);
  const result = await uploadImageElement(genDir, parsed);
  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  return NextResponse.json(
    result.ok
      ? { ok: true, sceneIndex: parsed.sceneIndex, pieceId: result.pieceId }
      : { ok: false, error: result.error },
    { status },
  );
}
