import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
import { getCurrentUser } from "../../../../lib/auth";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { takeRegenSlot } from "../../../../lib/edit/op-cap";
import { loadScript } from "../../../../lib/store";
import { mergeProvenance } from "../../../../lib/edit/provenance";
import { regenerateElement } from "../../../../lib/edit/regenerate-element";
import { checkTokenAllowance, recordTokenUsage } from "../../../../lib/metering";

/**
 * Element-ANIMATE endpoint (founder, 2026-09-03: "just like we have regenerate
 * for elements let's have animate for elements as well with prompts").
 *
 * The regenerate op in motion-only mode: the model re-emits ONE piece with its
 * content, layout and styles byte-identical and only its motion changed —
 * self-contained @keyframes inside the piece, entrances that rest on the
 * element's own static styles (lib/agents/regenerate-piece.ts ANIMATE_SYSTEM).
 * Same zero-neighbor guarantee, same render check, same rollback on refusal.
 * Guarded exactly like regenerate: it is LLM spend, so the breaker, the token
 * allowance, and the per-owner hourly regen cap all apply.
 *
 * POST body: { scriptId, sceneIndex, pieceId, instruction }
 * Returns: { ok, sceneIndex, pieceId, usage? } | { ok:false, error }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) {
      return NextResponse.json({ error: err.friendly }, { status: 503 });
    }
    throw err;
  }

  const gate = await checkTokenAllowance(user.id);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason ?? "token allowance exhausted" }, { status: 402 });
  }

  const cap = await takeRegenSlot(user.id);
  if (!cap.allowed) {
    return NextResponse.json(
      { error: `Regeneration limit reached for this hour — try again in ~${cap.retryAfterMin} min.` },
      { status: 429 },
    );
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    pieceId?: string;
    instruction?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, instruction } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }
  if (typeof instruction !== "string" || !instruction.trim()) {
    return NextResponse.json(
      { error: "Say how it should move — animating needs an instruction." },
      { status: 400 },
    );
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  try {
    const genDir = await documentDir(scriptId);
    const result = await regenerateElement({ genDir, sceneIndex, pieceId, instruction, mode: "animate" });
    if (result.usage) await recordTokenUsage({ ownerId: user.id, usage: result.usage, op: "animate-element" });
    // Its own provenance field: the motion ask must not overwrite the
    // instruction that MADE the element (the panel seeds "Edit the prompt"
    // from that one).
    if (result.ok) await mergeProvenance(genDir, pieceId, { motion: instruction });
    const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
    return NextResponse.json(
      result.ok
        ? { ok: true, sceneIndex, pieceId, usage: result.usage }
        : { ok: false, error: result.error },
      { status },
    );
  } catch (err) {
    console.error(
      `[animate-element] failed for owner=${user.id} script=${scriptId} scene=${sceneIndex}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return NextResponse.json(
      { ok: false, error: "could not animate that element — nothing was changed. Please try again." },
      { status: 500 },
    );
  }
}
