import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { takeRegenSlot } from "../../../../lib/edit/op-cap";
import { loadScript } from "../../../../lib/store";
import { insertElement, parseInsertBody, type InsertMode } from "../../../../lib/edit/insert-element";

/**
 * Insert a NEW element into a built scene — the editor "add" path.
 *
 * POST body:
 *   { scriptId, sceneIndex, bounds:{x,y,w,h},
 *     mode:"primitive", primitive:"text"|"image"|"icon", text?|src?|icon? }
 *   { scriptId, sceneIndex, bounds:{x,y,w,h}, mode:"generate", prompt, kind? }
 * Returns: { ok, sceneIndex, pieceId, usage? } | { ok:false, error }
 *
 * Primitive mode is deterministic (no LLM, no spend). Generate mode is the marquee
 * killer feature and reuses the element-regen guards: z.ai breaker + per-owner cap +
 * usage ledger. Both rewrite Composition.tsx, which the iframe + MP4 both consume.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = parseInsertBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { scriptId, sceneIndex, bounds, spec } = parsed;

  // Generate mode is LLM spend — apply the same breaker + per-owner cap as regen.
  if (spec.mode === "generate") {
    try {
      assertZaiAvailable();
    } catch (err) {
      if (err instanceof ZaiUnavailableError) {
        return NextResponse.json({ error: err.friendly }, { status: 503 });
      }
      throw err;
    }
    const cap = takeRegenSlot(user.id);
    if (!cap.allowed) {
      return NextResponse.json(
        { error: `Generation limit reached for this hour — try again in ~${cap.retryAfterMin} min.` },
        { status: 429 },
      );
    }
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result = await insertElement({ genDir, scriptId, sceneIndex, bounds, spec: spec as InsertMode });
  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  return NextResponse.json(
    result.ok
      ? { ok: true, sceneIndex, pieceId: result.pieceId, usage: result.usage }
      : { ok: false, error: result.error },
    { status },
  );
}
