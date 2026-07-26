import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
import { promises as fs } from "fs";
import path from "path";
import {
  loadScript,
  loadBriefByScriptId,
  saveScript,
} from "../../../../lib/store";
import { getCurrentUser } from "../../../../lib/auth";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { takeRegenSlot } from "../../../../lib/edit/op-cap";
import {
  regenerateScene,
  buildAgentInputFromBrief,
} from "../../../../lib/agents/pipeline";
import { decomposeGenDir } from "../../../../lib/agents/lego-store";
import { withGenDirLock } from "../../../../lib/edit/gendir-lock";
import { recordUsage } from "../../../../lib/usage";
import { checkTokenAllowance, recordTokenUsage } from "../../../../lib/metering";
import { MODELS } from "../../../../lib/anthropic";

/**
 * Per-scene regenerate endpoint backing the /preview/[id] page's
 * "Regenerate scene N" button.
 *
 * POST body: { scriptId: string, sceneIndex: number, instruction?: string }
 *
 * Flow:
 *   1. Load the script + the brief that points at it (for brand context).
 *   2. Read the existing src/generated/<id>/Composition.tsx.
 *   3. Re-run Design + Choreography agents for one scene only.
 *   4. Overwrite Composition.tsx + Composition.design.tsx on disk.
 *   5. Mark the scene with `regenerated_at` so the next MP4 render
 *      uses the latest version.
 *
 * The Preview client reloads the page on success so webpack re-imports
 * the updated module.
 */
export async function POST(request: Request) {
  // Dev-only gate matches the existing /api/dev/* pattern.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Balance circuit breaker — scene regen is real LLM spend (2 passes); fail
  // fast and friendly while the z.ai account is dry.
  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) {
      return NextResponse.json({ error: err.friendly }, { status: 503 });
    }
    throw err;
  }

  // Token allowance (pivot pricing, RB_METERING) — before the hourly cap so
  // the out-of-tokens message (actionable) wins over the rate-limit one.
  const gate = await checkTokenAllowance(user.id);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason ?? "token allowance exhausted" }, { status: 402 });
  }

  // Per-owner hourly cap — this route checks auth but not entitlement, so a
  // scripted loop was unbounded GLM spend (launch audit P0).
  const cap = takeRegenSlot(user.id);
  if (!cap.allowed) {
    return NextResponse.json(
      { error: `Regeneration limit reached for this hour — try again in ~${cap.retryAfterMin} min.` },
      { status: 429 },
    );
  }

  let body: { scriptId?: string; sceneIndex?: number; instruction?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const { scriptId, sceneIndex, instruction } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json(
      { error: "scriptId required" },
      { status: 400 },
    );
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json(
      { error: "sceneIndex must be a non-negative number" },
      { status: 400 },
    );
  }
  // Doctrine (2026-07-14): a user regen must say what to change — a blind
  // reroll re-gambles quality instead of steering it. The lib layer keeps
  // instruction optional for internal repair paths; the user boundary enforces.
  if (typeof instruction !== "string" || !instruction.trim()) {
    return NextResponse.json(
      { error: "Say what to change — regeneration needs an instruction." },
      { status: 400 },
    );
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json(
      {
        error: `sceneIndex ${sceneIndex} out of range (script has ${script.scenes.length} scenes)`,
      },
      { status: 400 },
    );
  }

  const brief = await loadBriefByScriptId(scriptId, user.id);
  // brief is optional — if not found we still try with empty brand context.

  const generatedDir = await documentDir(scriptId);
  const compPath = path.join(generatedDir, "Composition.tsx");
  let existingCode: string;
  try {
    existingCode = await fs.readFile(compPath, "utf-8");
  } catch (err) {
    return NextResponse.json(
      {
        error: `Composition.tsx not found at ${compPath}. Run the full build pass first via the review page.`,
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 404 },
    );
  }

  const result = await regenerateScene(
    buildAgentInputFromBrief(brief, script),
    existingCode,
    sceneIndex,
    instruction,
  );

  // Every scene regen lands in the cost ledger — billed whether or not it
  // succeeded (editor regens were previously invisible to .data/usage.jsonl).
  if (result.usage) {
    void recordUsage({
      op: "regen-scene",
      model: MODELS.codingAgent,
      scriptId,
      usage: result.usage,
      ...(result.ok ? {} : { failed: true }),
    });
    // Pivot token counter: scene regens spend tokens whether or not they succeed.
    await recordTokenUsage({ ownerId: user.id, usage: result.usage, op: "regen-scene" });
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, stage: result.stage },
      { status: 500 },
    );
  }

  // Write the updated files back to disk — under the genDir lock so a concurrent
  // editor op can't interleave, and RE-DECOMPOSE the lego store: piece edits
  // reassemble Composition.tsx from genDir/lego/, so a stale manifest would make
  // the FIRST piece edit after this regen silently revert the whole scene.
  await withGenDirLock(generatedDir, async () => {
    await fs.writeFile(compPath, result.code, "utf-8");
    await fs.writeFile(
      path.join(generatedDir, "Composition.design.tsx"),
      result.designCode,
      "utf-8",
    );
    try {
      await decomposeGenDir(generatedDir);
    } catch (err) {
      // Best-effort: decompose is guarded by its byte-identical round-trip check;
      // a failure leaves piece editing unavailable for this scene, never corrupt.
      console.warn(
        `[regenerate-scene] lego re-decompose failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  });

  // Mark scene as regenerated so downstream code can track freshness.
  (script.scenes[sceneIndex] as unknown as Record<string, string>).regenerated_at =
    new Date().toISOString();
  await saveScript(script, user.id);

  return NextResponse.json({
    ok: true,
    scriptId,
    sceneIndex,
    usage: result.usage,
    warnings: result.warnings,
  });
}
