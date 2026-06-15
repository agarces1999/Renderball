import { NextResponse } from "next/server";
import path from "path";
import {
  loadScript,
  loadBriefByScriptId,
  saveScript,
} from "../../../../lib/store";
import {
  buildAnimatedSections,
  buildAgentInputFromBrief,
  regenerateScene,
} from "../../../../lib/agents/pipeline";
import { writeGeneratedFiles } from "../../../../lib/render/build-wrapper";
import { verifyScenesRender } from "../../../../lib/render/ssr-render";
import { measureScenes } from "../../../../lib/render/measure-scene";
import {
  findRenderTruthFailures,
  measureOutDir,
} from "../../../../lib/render/render-truth-gates";
import { repairRenderTruth } from "../../../../lib/render/render-truth-repair";
import { MODELS } from "../../../../lib/anthropic";
import { recordUsage, costUsd } from "../../../../lib/usage";

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
    // A failed attempt is not a free attempt — the Opus tokens it burned are
    // real spend. Record them (failed: true) so the ledger never understates
    // cost; the report excludes failed rows from per-build averages.
    if (result.usage) {
      await recordUsage({
        op: "build",
        model: MODELS.codingAgentBuild,
        scriptId,
        url: brief?.brand_kit_url,
        usage: result.usage,
        failed: true,
      });
    }
    return NextResponse.json(
      { error: result.error, stage: result.stage },
      { status: 500 },
    );
  }

  // Persist token usage for this build (design + choreography + retries, Opus) —
  // cache-aware cost. Best-effort; never blocks the build.
  await recordUsage({
    op: "build",
    model: MODELS.codingAgentBuild,
    scriptId,
    url: brief?.brand_kit_url,
    usage: result.usage,
  });

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

  // SSR-render gate (QA): the pipeline's compile gate only checks that the comp
  // PARSES (esbuild.transform). The preview/MP4 path actually bundles + evals +
  // SSRs each Section — strictly stronger. A scene can parse yet throw at render
  // ("Cannot read properties of undefined (reading 'hex')") or export the wrong
  // name, and the user would see a broken preview. Verify every scene renders
  // (same path the preview uses) before reporting success — so ok:true means
  // "every scene actually renders", not just "parses".
  // NOTE on the gate's limit — SSR proves each scene EVALUATES, not that its
  // content ever PAINTS in the export. CSS animations the agents emit can play
  // in the browser preview yet never fire in the MP4 render (the sentry build
  // shipped a scene whose text — opacity:0 + long-delay `animation ... forwards`
  // — was invisible at every exported timestamp while the preview looked fine).
  // Pixel-truth verification needs real rendered frames, which is too slow for
  // this build path: it lives in the stills pipeline instead. See
  // scripts/dogfood-stills.mjs + lib/render/painted-content.ts
  // (verifyPaintedScenes): every dogfood run scores per-scene ink from frames
  // of an actual MP4 render and flags scenes whose content never paints.
  const renderCheck = await verifyScenesRender(genDir, script.scenes.length, script);
  if (!renderCheck.ok) {
    console.error(
      "[preview/build] SSR render gate failed:",
      JSON.stringify(renderCheck.errors),
    );
    return NextResponse.json(
      {
        error: "one or more scenes failed to render",
        stage: "render",
        render_errors: renderCheck.errors,
      },
      { status: 500 },
    );
  }

  // RENDER-TRUTH GATE (Phase 2: BLOCKING + self-repair ladder + $10 ceiling).
  // The SSR gate proves each scene EVALUATES; it cannot see the rendered LAYOUT,
  // so clipped/off-canvas content sails through (every static gate approximates
  // this from declared geometry and keeps missing it). We measure the REAL
  // browser render and BLOCK on correctness failures, escalating to fix them:
  //   L1/L2 regenerate the failing scene's design → L3 lighten its visual_concept
  //   + rebuild → L4 give up (hard-fail, do not ship). A $10 cumulative ceiling
  //   caps the loop. The agent-emitted Composition files mutate in place as the
  //   ladder runs; `script.json` is re-saved if L3 lightens a concept so the
  //   preview/MP4 reuse stays consistent.
  let currentCode = result.code;
  let currentDesign = result.designCode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentScript: any = script;
  const model = MODELS.codingAgentBuild;

  const writeCurrent = async (warnings?: typeof result.warnings, assetManifest?: typeof result.asset_manifest) =>
    writeGeneratedFiles(genDir, {
      designCode: currentDesign,
      code: currentCode,
      script: currentScript,
      warnings,
      assetManifest,
    });

  const repair = await repairRenderTruth(
    {
      measure: async () => {
        const measurements = await measureScenes(genDir, currentScript, measureOutDir(genDir));
        return findRenderTruthFailures(measurements);
      },
      regenScene: async (sceneIndex, instruction) => {
        const r = await regenerateScene(
          buildAgentInputFromBrief(brief, currentScript),
          currentCode,
          sceneIndex,
          instruction,
        );
        if (!r.ok) return { ok: false, usage: r.usage, error: r.error };
        currentCode = r.code;
        currentDesign = r.designCode;
        await writeCurrent(r.warnings, r.asset_manifest);
        await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: r.usage });
        return { ok: true, usage: r.usage };
      },
      rewriteScript: async (sceneIndexes, reason) => {
        // L3: surgically lighten ONLY the failing scenes' visual_concept (their
        // render brief) and rebuild — keeps the narrative + other scenes intact.
        const lighter = {
          ...currentScript,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          scenes: currentScript.scenes.map((sc: any, i: number) =>
            sceneIndexes.includes(i)
              ? {
                  ...sc,
                  visual_concept: `${sc.visual_concept}\n\nSIMPLIFY (must fit 1920×1080 — ${reason}): reduce to fewer, smaller elements; narrow or stack wide rows; NO element may extend off-canvas.`,
                }
              : sc,
          ),
        };
        const rb = await buildAnimatedSections(buildAgentInputFromBrief(brief, lighter));
        if (!rb.ok) return { ok: false, usage: rb.usage, error: rb.error };
        currentScript = lighter;
        currentCode = rb.code;
        currentDesign = rb.designCode;
        await writeCurrent(rb.warnings, rb.asset_manifest);
        await saveScript(currentScript);
        await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: rb.usage });
        return { ok: true, usage: rb.usage };
      },
      onStep: (m) => console.warn(`[preview/build] render-truth: ${m}`),
    },
    { spentSoFarUsd: costUsd(model, result.usage), model },
  );

  if (!repair.ok) {
    console.error(
      `[preview/build] render-truth gate FAILED (${repair.reason}) after $${repair.spentUsd.toFixed(2)}:`,
      JSON.stringify(repair.blocking),
    );
    return NextResponse.json(
      {
        error: `render-truth gate: ${repair.reason}`,
        stage: "render-truth",
        render_truth: {
          reason: repair.reason,
          blocking: repair.blocking,
          steps: repair.steps,
          spentUsd: repair.spentUsd,
        },
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    scriptId,
    usage: result.usage,
    warnings: result.warnings,
    render_truth: {
      findings: repair.findings,
      steps: repair.steps,
      spentUsd: repair.spentUsd,
    },
  });
}
