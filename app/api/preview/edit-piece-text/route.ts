import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { editPieceText, freetextSwatches } from "../../../../lib/edit/edit-piece-text";

/**
 * Edit an INSERTED free-text box — its copy and/or its formatting. Deterministic, NO LLM.
 *
 * An inserted text box's copy lives as a literal in its own piece body (marked
 * data-rb-freetext), not in the fixed SceneContent key set, so /edit-element can't
 * reach it. This re-emits the span and reassembles Composition.tsx.
 *
 * GET  ?scriptId=…            → { swatches } — the video's own palette for the toolbar
 * POST { scriptId, sceneIndex, pieceId, value?, format? }
 *   format: { size?, weight?, italic?, underline?, color?, align? }
 * Returns: { ok, sceneIndex, pieceId, format } | { ok:false, error }
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  try {
    const swatches = await freetextSwatches(path.join(process.cwd(), "src", "generated", scriptId));
    return NextResponse.json({ swatches });
  } catch {
    return NextResponse.json({ swatches: [] });
  }
}
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { scriptId?: string; sceneIndex?: number; pieceId?: string; value?: string; format?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, value, format } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }
  if (value !== undefined && typeof value !== "string") {
    return NextResponse.json({ error: "value must be a string" }, { status: 400 });
  }
  if (value === undefined && (!format || typeof format !== "object")) {
    return NextResponse.json({ error: "value or format required" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  // normalizeFormat in lib/edit/freetext.ts clamps + sanitizes every field, so an
  // arbitrary object here can't inject anything into the emitted source.
  const result = await editPieceText({
    genDir,
    sceneIndex,
    pieceId,
    ...(value !== undefined ? { value } : {}),
    ...(format && typeof format === "object" ? { format: format as Record<string, never> } : {}),
  });
  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  return NextResponse.json(
    result.ok ? { ok: true, sceneIndex, pieceId, format: result.format } : { ok: false, error: result.error },
    { status },
  );
}
