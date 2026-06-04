import { NextResponse } from "next/server";
import path from "path";
import {
  loadScript,
  loadBriefByScriptId,
} from "../../../../lib/store";
import {
  buildAnimatedSections,
  buildAgentInputFromBrief,
} from "../../../../lib/agents/pipeline";
import { writeGeneratedFiles } from "../../../../lib/render/build-wrapper";

/**
 * Preview-only build endpoint. Runs the Design + Choreography agents
 * and writes the generated React/CSS to `src/generated/<scriptId>/`
 * — but stops short of bundling or capturing to MP4.
 *
 * The /preview/[id] page calls this when Composition.tsx doesn't yet
 * exist for the script. Iteration cost: ~30-60s for the agents only,
 * vs ~90-180s for the full MP4 path. Once the user is happy with the
 * preview, the "Render to MP4 →" link runs the full pipeline.
 *
 * POST body: { scriptId: string }
 *
 * Returns: { ok: true, scriptId, usage } on success.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  let body: { scriptId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const { scriptId } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json(
      { error: "scriptId required" },
      { status: 400 },
    );
  }

  const script = await loadScript(scriptId);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  const brief = await loadBriefByScriptId(scriptId);
  // brief is optional — without it the agents fall back to empty brand context.

  // The preview IS the MP4 — it must run the EXACT same gated pipeline, no
  // shortcuts. (This previously passed skipRetries:true for speed, which
  // shipped a degraded, ungated preview that differed from the rendered
  // MP4 — the source of the cropped-element / duplicate-logo bugs that
  // survived every "fix".) The MP4 render path now REUSES this composition,
  // so all gating happens here, once.
  const result = await buildAnimatedSections(
    buildAgentInputFromBrief(brief, script),
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, stage: result.stage },
      { status: 500 },
    );
  }

  // Write the generated artifacts under src/generated/<scriptId>/ via the
  // shared writer — IDENTICAL layout to the MP4 path, so "Render to MP4"
  // reuses this exact composition (script.json + warnings.json drive the
  // reuse check) rather than rebuilding a different one.
  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  await writeGeneratedFiles(genDir, {
    designCode: result.designCode,
    code: result.code,
    script,
    warnings: result.warnings,
    assetManifest: result.asset_manifest,
  });

  return NextResponse.json({
    ok: true,
    scriptId,
    usage: result.usage,
    warnings: result.warnings,
  });
}
