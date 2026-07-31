import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { takeRegenSlot } from "../../../../lib/edit/op-cap";
import { loadScript } from "../../../../lib/store";
import { insertElement, parseInsertBody, type InsertMode } from "../../../../lib/edit/insert-element";
import { checkTokenAllowance, recordTokenUsage } from "../../../../lib/metering";

/**
 * Insert a NEW element into a built scene — the editor "add" path.
 *
 * POST body:
 *   { scriptId, sceneIndex, bounds:{x,y,w,h},
 *     mode:"primitive", primitive:"text"|"image"|"icon", text?|src?|icon? }
 *   { scriptId, sceneIndex, bounds:{x,y,w,h}, mode:"generate", prompt, kind? }
 *   { scriptId, sceneIndex, bounds:{x,y,w,h}, mode:"generate-image", prompt }
 * Returns: { ok, sceneIndex, pieceId, usage? } | { ok:false, error }
 *
 * Primitive mode is deterministic (no LLM, no spend). Generate mode is the marquee
 * killer feature and reuses the element-regen guards: z.ai breaker + per-owner cap +
 * usage ledger. Generate-image bills per image on the Fireworks image service —
 * per-owner cap applies, the LLM breaker does not (different substrate). All modes
 * rewrite Composition.tsx, which the iframe + exports both consume.
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

  // Both generate modes are spend — per-owner cap + token allowance. The LLM
  // breaker guards only the LLM path; image generation runs on a separate
  // Fireworks service. Primitive mode stays free/ungated ("editing is free").
  if (spec.mode === "generate" || spec.mode === "generate-image") {
    if (spec.mode === "generate") {
      try {
        assertZaiAvailable();
      } catch (err) {
        if (err instanceof ZaiUnavailableError) {
          return NextResponse.json({ error: err.friendly }, { status: 503 });
        }
        throw err;
      }
    }
    const gate = await checkTokenAllowance(user.id);
    if (!gate.allowed) {
      return NextResponse.json({ error: gate.reason ?? "token allowance exhausted" }, { status: 402 });
    }
    const cap = await takeRegenSlot(user.id);
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

  // Anything below can throw — filesystem, storage hydration, the model call.
  // Uncaught, that reached the user as a bare "request failed (500)" with no
  // server-side trace, which is exactly how a missing lego manifest hid.
  try {
    const genDir = await documentDir(scriptId);
    const result = await insertElement({ genDir, scriptId, sceneIndex, bounds, spec: spec as InsertMode });
    // Pivot token counter: only generate-mode inserts produce usage; primitive
    // inserts never reach here with tokens.
    if (result.usage) await recordTokenUsage({ ownerId: user.id, usage: result.usage, op: "insert-element" });
    const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
    return NextResponse.json(
      result.ok
        ? { ok: true, sceneIndex, pieceId: result.pieceId, usage: result.usage }
        : { ok: false, error: result.error },
      { status },
    );
  } catch (err) {
    console.error(
      `[insert-element] ${spec.mode} failed for owner=${user.id} script=${scriptId} scene=${sceneIndex}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return NextResponse.json(
      { ok: false, error: "could not add that element — nothing was changed. Please try again." },
      { status: 500 },
    );
  }
}
