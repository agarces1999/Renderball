import { NextResponse } from "next/server";
import path from "path";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { dimensionsForScript } from "../../../../lib/render/build-wrapper";
import { readDecomposed } from "../../../../lib/agents/lego-store";
import { readDocumentBrand } from "../../../../lib/brand/document-brand";
import { brandPromptBlock } from "../../../../lib/brand/brand-prompt";
import { suggestLayout, parseOccupied } from "../../../../lib/agents/suggest-layout";

/**
 * Dev-only suggest-layout route — headless counterpart to
 * /api/preview/suggest-layout (no Clerk session, no breaker / cap / metering),
 * so the Suggest loop can be driven on /dev/edit. NODE_ENV-gated (404 in prod).
 *
 * POST { scriptId, sceneIndex, prompt } → { ok, suggestions }
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

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

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: "document not found" }, { status: 404 });
  // Without this the scene lookup below silently returns undefined and we bill a
  // model call describing a page that does not exist. Production 404s; so does
  // this lane now.
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json({ error: "page not found" }, { status: 404 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const dims = dimensionsForScript(script);
  const decomposed = await readDecomposed(genDir);
  const scene = decomposed.scenes.find((s) => s.sceneIndex === sceneIndex);

  const result = await suggestLayout({
    sceneIndex,
    canvas: { w: dims.width, h: dims.height },
    existing: scene?.pieces ?? [],
    occupied: parseOccupied(body.occupied),
    prompt,
    brandBlock: brandPromptBlock(await readDocumentBrand(genDir)),
  });

  return NextResponse.json(
    result.ok
      ? { ok: true, suggestions: result.suggestions, canvas: { w: dims.width, h: dims.height } }
      : { ok: false, error: result.error },
    { status: result.ok ? 200 : 400 },
  );
}
