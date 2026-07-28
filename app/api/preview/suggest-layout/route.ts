import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { documentDir } from "../../../../lib/render/gen-store";
import { dimensionsForScript } from "../../../../lib/render/build-wrapper";
import { readDecomposed } from "../../../../lib/agents/lego-store";
import { readDocumentBrand } from "../../../../lib/brand/document-brand";
import { brandPromptBlock } from "../../../../lib/brand/brand-prompt";
import { suggestLayout, parseOccupied } from "../../../../lib/agents/suggest-layout";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { takeRegenSlot } from "../../../../lib/edit/op-cap";
import { checkTokenAllowance, recordTokenUsage } from "../../../../lib/metering";

/**
 * Propose a layout for one page — the "Suggest" box above the slide.
 *
 * Answers the question that comes before the marquee: the marquee assumes you
 * already know where a thing goes, this proposes the composition. It returns
 * REGIONS ONLY — boxes plus the prompt that would build each one — and creates
 * nothing. The user accepts a region and the normal marquee flow takes over with
 * the box and the words pre-filled, so the expensive step stays behind an
 * explicit click.
 *
 * POST { scriptId, sceneIndex, prompt } → { ok, suggestions:[{label,prompt,bounds}] }
 *
 * Gated like the other spend paths: breaker, token allowance, per-owner cap. It
 * is much cheaper than generating (one small JSON reply, no element code), but it
 * is still a model call and still bills.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { scriptId?: string; sceneIndex?: number; prompt?: string; occupied?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const scriptId = typeof body.scriptId === "string" ? body.scriptId : "";
  const sceneIndex = Number(body.sceneIndex);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!scriptId || !Number.isInteger(sceneIndex) || sceneIndex < 0 || !prompt) {
    return NextResponse.json(
      { error: "scriptId, sceneIndex and prompt are required" },
      { status: 400 },
    );
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
  const cap = takeRegenSlot(user.id);
  if (!cap.allowed) {
    return NextResponse.json(
      { error: `Generation limit reached for this hour — try again in ~${cap.retryAfterMin} min.` },
      { status: 429 },
    );
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "document not found" }, { status: 404 });
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json({ error: "page not found" }, { status: 404 });
  }

  try {
    const genDir = await documentDir(scriptId);
    const dims = dimensionsForScript(script);

    // The piece BODIES, as read-only context so proposals match the page's
    // grammar. Their geometry does not exist server-side — built pieces carry no
    // machine-readable boxes — so the real rectangles are measured in the browser
    // and arrive in `occupied`.
    const decomposed = await readDecomposed(genDir);
    const scene = decomposed.scenes.find((s) => s.sceneIndex === sceneIndex);

    const brandBlock = brandPromptBlock(await readDocumentBrand(genDir));

    const result = await suggestLayout({
      sceneIndex,
      canvas: { w: dims.width, h: dims.height },
      existing: scene?.pieces ?? [],
      // Measured in the browser — built pieces carry no geometry server-side.
      occupied: parseOccupied(body.occupied),
      prompt,
      brandBlock,
    });

    if (result.usage) {
      await recordTokenUsage({ ownerId: user.id, usage: result.usage, op: "suggest-layout" });
    }
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    // The canvas the bounds are expressed in. Returned so the editor can place
    // the regions as PERCENTAGES of the slide instead of measuring the rendered
    // canvas — a live DOM measurement has to happen at exactly the right instant
    // (the iframe reports zero size until it lays out) and silently mis-places
    // every region when it doesn't.
    return NextResponse.json({
      ok: true,
      suggestions: result.suggestions,
      canvas: { w: dims.width, h: dims.height },
    });
  } catch (err) {
    console.error(
      `[suggest-layout] failed for owner=${user.id} script=${scriptId} scene=${sceneIndex}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return NextResponse.json(
      { ok: false, error: "could not suggest a layout — nothing was changed. Please try again." },
      { status: 500 },
    );
  }
}
