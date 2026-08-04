import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { takeRegenSlot } from "../../../../lib/edit/op-cap";
import { loadScript } from "../../../../lib/store";
import { regenerateElement } from "../../../../lib/edit/regenerate-element";
import { checkTokenAllowance, recordTokenUsage } from "../../../../lib/metering";

/**
 * M2 element-regenerate endpoint — the ONE LLM op of the visual editor.
 *
 * Regenerates a SINGLE piece (element) of a built scene against the scene's frozen
 * design system + its read-only siblings, then rewrites exactly one piece file and
 * reassembles Composition.tsx. Every sibling is byte-identical, so "regenerate this
 * card" provably cannot disturb its neighbors. The preview iframe and the MP4 render
 * both consume Composition.tsx, so the change shows in both.
 *
 * POST body: { scriptId, sceneIndex, pieceId, instruction }
 * Returns: { ok, sceneIndex, pieceId, usage? } | { ok:false, error }
 *
 * `instruction` is REQUIRED (doctrine 2026-07-14): a user regen must say what
 * to change — a blind reroll re-gambles quality instead of steering it. The
 * lib layer keeps instruction optional for internal repair paths; this user
 * boundary enforces it.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Balance circuit breaker — element regen is LLM spend; fail fast and
  // friendly while the z.ai account is dry.
  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) {
      return NextResponse.json({ error: err.friendly }, { status: 503 });
    }
    throw err;
  }

  // Token allowance (pivot pricing, RB_METERING) — checked BEFORE the hourly
  // cap so an out-of-tokens user gets the actionable upgrade message, not a
  // confusing rate-limit one.
  const gate = await checkTokenAllowance(user.id);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason ?? "token allowance exhausted" }, { status: 402 });
  }

  // Per-owner hourly cap — this route checks auth but not entitlement, so a
  // scripted loop was unbounded GLM spend (launch audit P0).
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
      { error: "Say what to change — regeneration needs an instruction." },
      { status: 400 },
    );
  }

  // Ownership check — loadScript is scoped to the caller.
  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  // Same guard insert-element carries: anything below can throw (filesystem,
  // storage hydration, the model call), and uncaught it reached the user as a
  // bare "request failed (500)" with no server-side trace.
  try {
  const genDir = await documentDir(scriptId);
  const result = await regenerateElement({ genDir, sceneIndex, pieceId, instruction });
  // Pivot token counter: regens spend tokens whether or not they succeed.
  if (result.usage) await recordTokenUsage({ ownerId: user.id, usage: result.usage, op: "regen-element" });
  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  return NextResponse.json(
    result.ok
      ? { ok: true, sceneIndex, pieceId, usage: result.usage }
      : { ok: false, error: result.error },
    { status },
  );
  } catch (err) {
    console.error(
      `[regenerate-element] failed for owner=${user.id} script=${scriptId} scene=${sceneIndex}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return NextResponse.json(
      { ok: false, error: "could not regenerate that element — nothing was changed. Please try again." },
      { status: 500 },
    );
  }
}
