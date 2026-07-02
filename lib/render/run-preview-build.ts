import path from "path";
import { loadScript, loadBriefByScriptId } from "../store";
import {
  buildAnimatedSections,
  buildAgentInputFromBrief,
  regenerateScene,
  repairSceneRenderErrors,
} from "../agents/pipeline";
import { writeGeneratedFiles } from "./build-wrapper";
import { decomposeGenDir } from "../agents/lego-store";
import { verifyScenesRender } from "./ssr-render";
import { measureScenes } from "./measure-scene";
import { findRenderTruthFailures, measureOutDir } from "./render-truth-gates";
import { repairRenderTruth } from "./render-truth-repair";
import {
  runVisionGate,
  makeVisionJudge,
  checkBrandColorFidelity,
  type VisionFinding,
} from "./vision-gate";
import { MODELS, VISION_MODEL } from "../anthropic";
import { callZaiVision, callZaiText } from "./zai-vision";
import { recordUsage, costUsd, addUsage, EMPTY_USAGE } from "../usage";

export type BuildRouteResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * The full preview-build pipeline — Design + Choreography agents → SSR gate →
 * render-truth gate (repair ladder) → advisory vision gate — extracted from the
 * route so it can run under EITHER caller with identical, gated behavior:
 *   • /api/preview/build  (ownerId = the signed-in user.id)
 *   • /api/dev/build      (ownerId = DEV_OWNER_ID — the headless validation loop,
 *                          which has no Clerk session and is blocked by the auth
 *                          middleware on /api/preview/*; the dev route is excluded).
 * Keeping ONE implementation means the loop validates the exact same build the
 * product ships — no drift between the dev harness and the user flow.
 *
 * Returns a transport-agnostic { status, body }; each route maps it to a
 * NextResponse. The preview IS the MP4 — this runs the EXACT same gated pipeline,
 * no shortcuts; the MP4 render path reuses the composition written here.
 */
export async function runPreviewBuild(
  scriptId: string,
  ownerId: string,
): Promise<BuildRouteResult> {
  const script = await loadScript(scriptId, ownerId);
  if (!script) {
    return { status: 404, body: { error: "script not found" } };
  }

  const brief = await loadBriefByScriptId(scriptId, ownerId);
  // brief is optional — without it the agents fall back to empty brand context.

  const result = await buildAnimatedSections(
    buildAgentInputFromBrief(brief, script),
  );

  if (!result.ok) {
    // A failed attempt is not a free attempt — the tokens it burned are real
    // spend. Record them (failed: true) so the ledger never understates cost;
    // the report excludes failed rows from per-build averages.
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
    return { status: 500, body: { error: result.error, stage: result.stage } };
  }

  // Accumulate ALL build-model spend (initial build + every repair regen/rewrite)
  // into ONE bundle, recorded ONCE after the gates resolve.
  const model = MODELS.codingAgentBuild;
  let currentUsage = result.usage ?? EMPTY_USAGE;
  let currentWarnings = result.warnings;

  // Write the generated artifacts under src/generated/<scriptId>/ via the shared
  // writer — IDENTICAL layout to the MP4 path, so "Render to MP4" reuses this
  // exact composition rather than rebuilding a different one.
  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  await writeGeneratedFiles(genDir, {
    designCode: result.designCode,
    code: result.code,
    script,
    warnings: result.warnings,
    assetManifest: result.asset_manifest,
  });

  // SSR-render gate (QA): the pipeline's compile gate only checks that the comp
  // PARSES. Here we bundle + eval + SSR each Section — strictly stronger — so
  // ok:true means "every scene actually renders", not just "parses".
  let renderCheck = await verifyScenesRender(genDir, script.scenes.length, script);
  if (!renderCheck.ok) {
    console.error(
      "[preview/build] SSR render gate failed:",
      JSON.stringify(renderCheck.errors),
    );
    // RENDER-ERROR AUTO-REPAIR — a scene that PARSES can still THROW at render
    // (an unguarded access to an optional content field). Surgically guard the
    // throwing section(s) and re-gate. Only per-scene throws are repairable.
    const repairable = renderCheck.errors.some((e) => e.scene >= 0);
    if (repairable) {
      const rr = await repairSceneRenderErrors(result.code!, renderCheck.errors);
      currentUsage = addUsage(currentUsage, rr.usage); // billed either way
      if (rr.repaired.length > 0) {
        await writeGeneratedFiles(genDir, {
          designCode: result.designCode,
          code: rr.code,
          script,
          warnings: result.warnings,
          assetManifest: result.asset_manifest,
        });
        renderCheck = await verifyScenesRender(genDir, script.scenes.length, script);
        console.warn(
          `[preview/build] render-repair: guarded scene(s) [${rr.repaired.join(", ")}], re-gate ${renderCheck.ok ? "PASSED" : "still failing"}`,
        );
      }
    }
    if (!renderCheck.ok) {
      await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: currentUsage, failed: true });
      return {
        status: 500,
        body: {
          error: "one or more scenes failed to render",
          stage: "render",
          render_errors: renderCheck.errors,
        },
      };
    }
  }

  // RENDER-TRUTH GATE (BLOCKING + self-repair ladder + $10 ceiling). We measure
  // the REAL browser render and BLOCK on correctness failures, escalating to fix
  // them: L1/L2 regenerate the failing scene's design → L3 lighten its
  // visual_concept + rebuild → L4 give up (hard-fail). A $10 cumulative ceiling
  // caps the loop. The L3-lightened concept is NEVER persisted to the canonical
  // script (the MP4 reuse reads genDir/script.json, not the canonical store).
  let currentCode = result.code;
  let currentDesign = result.designCode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentScript: any = script;

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
        // findRenderTruthFailures is ASYNC (contrast + dead-region run through
        // sharp) — it MUST be awaited. brandBackground enables the
        // canvas-brightness check (light brand shipped on a dark canvas).
        const gate = await findRenderTruthFailures(measurements, {
          brandBackground: brief?.brand_extract?.background_color,
          // Barbell (a >30% empty horizontal band) is a measured, high-precision
          // composition failure — block on the build path so the repair ladder
          // regenerates the scene with the empty-band reason, rather than shipping
          // it with only an advisory warning (the prior state: prose rules alone).
          blockingKinds: ["overflow", "measure-error", "barbell"],
        });
        return { ...gate, measurements };
      },
      regenScene: async (sceneIndex, instruction) => {
        const r = await regenerateScene(
          buildAgentInputFromBrief(brief, currentScript),
          currentCode,
          sceneIndex,
          instruction,
        );
        // Fold spend even on failure — a failed attempt is not a free attempt.
        if (!r.ok) {
          if (r.usage) currentUsage = addUsage(currentUsage, r.usage);
          return { ok: false, usage: r.usage, error: r.error };
        }
        currentCode = r.code;
        currentDesign = r.designCode;
        currentWarnings = r.warnings;
        if (r.usage) currentUsage = addUsage(currentUsage, r.usage);
        await writeCurrent(r.warnings, r.asset_manifest);
        return { ok: true, usage: r.usage };
      },
      rewriteScript: async (sceneIndexes, reason) => {
        // L3: surgically lighten ONLY the failing scenes' visual_concept and
        // rebuild — keeps the narrative + other scenes intact. In-memory + genDir
        // only, NEVER persisted to the canonical script.
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
        if (!rb.ok) {
          if (rb.usage) currentUsage = addUsage(currentUsage, rb.usage);
          return { ok: false, usage: rb.usage, error: rb.error };
        }
        currentScript = lighter;
        currentCode = rb.code;
        currentDesign = rb.designCode;
        currentWarnings = rb.warnings;
        if (rb.usage) currentUsage = addUsage(currentUsage, rb.usage);
        await writeCurrent(rb.warnings, rb.asset_manifest);
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
    await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: currentUsage, failed: true });
    return {
      status: 422,
      body: {
        error: `render-truth gate: ${repair.reason}`,
        stage: "render-truth",
        render_truth: {
          reason: repair.reason,
          blocking: repair.blocking,
          steps: repair.steps,
          spentUsd: repair.spentUsd,
        },
      },
    };
  }

  // VISION GATE (ADVISORY). Findings surface as warnings, never block — runs
  // AFTER and OUTSIDE the $10 repair ceiling, recorded separately as "vision-qa".
  // GLM-5V-Turbo via the NATIVE z.ai endpoint (the Anthropic-compat client drops
  // images, so vision MUST use callZaiVision). Disable with RB_VISION_GATE=off.
  let visionFindings: VisionFinding[] = [];
  let visionCostUsd = 0;
  const VISION_GATE_ENABLED = process.env.RB_VISION_GATE !== "off";
  try {
    // Reuse the screenshots from repair's FINAL measure instead of launching
    // Chromium again — repair threads them out on RepairResult.measurements.
    const measurements =
      repair.measurements ??
      (await measureScenes(genDir, currentScript, measureOutDir(genDir)));
    const measured = measurements.filter((m) => m.screenshotPath);
    if (measured.length === 0 && measurements.length > 0) {
      console.warn(
        `[preview/build] vision gate (advisory) could not run: 0/${measurements.length} scenes produced a screenshot`,
        JSON.stringify(
          measurements.filter((m) => m.error).map((m) => ({ scene: m.scene, error: m.error })),
        ),
      );
    }
    const be = brief?.brand_extract;
    const brandTruth = {
      name: be?.title,
      backgroundColor: be?.background_color,
      accent: be?.logo_color ?? be?.palette?.[0],
      fonts: [be?.font_roles?.display, be?.font_roles?.body].filter(
        (f): f is string => !!f,
      ),
    };
    let visionUsage = { ...EMPTY_USAGE };
    const judge = makeVisionJudge(async (imageBase64, rubric) => {
      const { text, usage } = await callZaiVision(imageBase64, rubric);
      visionUsage = addUsage(visionUsage, usage);
      return text;
    });
    visionFindings = VISION_GATE_ENABLED
      ? await runVisionGate(
          measured.map((m) => ({ scene: m.scene, screenshotPath: m.screenshotPath })),
          brandTruth,
          judge,
        )
      : [];
    // Brand-color fidelity backstop — TEXT-ONLY (brand name + extracted palette,
    // NO image) so the model's color recall can't anchor to a wrong frame.
    if (VISION_GATE_ENABLED && brandTruth.name) {
      try {
        const palette =
          be?.palette && be.palette.length
            ? be.palette
            : [brandTruth.backgroundColor, brandTruth.accent].filter(
                (c): c is string => !!c,
              );
        const fid = await checkBrandColorFidelity({ name: brandTruth.name }, palette, async (p) => {
          const { text, usage } = await callZaiText(p, { disableThinking: true, maxTokens: 600 });
          visionUsage = addUsage(visionUsage, usage);
          return text;
        });
        if (!fid.onBrand && fid.issue) {
          visionFindings.push({ scene: 0, issue: `BRAND-COLOR: ${fid.issue}` });
          console.warn(`[preview/build] brand-color fidelity flagged: ${fid.issue}`);
        }
      } catch {
        /* advisory — never block on the backstop */
      }
    }
    if (visionUsage.input_tokens || visionUsage.output_tokens) {
      visionCostUsd = costUsd(VISION_MODEL, visionUsage);
      await recordUsage({
        op: "vision-qa",
        model: VISION_MODEL,
        scriptId,
        url: brief?.brand_kit_url,
        usage: visionUsage,
      });
    }
    if (visionFindings.length) {
      console.warn(
        `[preview/build] vision gate (advisory) flagged ${visionFindings.length} issue(s):`,
        JSON.stringify(visionFindings),
      );
    }
  } catch (err) {
    console.warn("[preview/build] vision gate (advisory) skipped:", err);
  }

  // The build shipped — record the full build-model spend (initial + every
  // repair regen/rewrite) as ONE successful row.
  await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: currentUsage });

  // LEGO engine: split the shipped composition into editable per-piece artifacts
  // under genDir/lego/ for the visual editor. Best-effort + byte-identity-guarded —
  // it never touches the render source, so a failure just means "not piece-editable".
  try {
    const lego = await decomposeGenDir(genDir);
    console.log(`[preview/build] lego decompose: ${lego.ok ? `${lego.pieces} pieces` : `skipped (${lego.reason})`}`);
  } catch (err) {
    console.warn("[preview/build] lego decompose skipped:", err);
  }

  return {
    status: 200,
    body: {
      ok: true,
      scriptId,
      usage: currentUsage,
      warnings: currentWarnings,
      totalCostUsd: Number((repair.spentUsd + visionCostUsd).toFixed(6)),
      render_truth: {
        findings: repair.findings,
        steps: repair.steps,
        spentUsd: repair.spentUsd,
        vision: visionFindings,
      },
    },
  };
}
