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
import { resolveCanvasPlan } from "../crawl/brand-identity";
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
import { tallyGateFires, recordGateTelemetry } from "./gate-telemetry";

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
  const buildT0 = Date.now();
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
          // ALWAYS-derived canvas (crawl bg → palette inference → white): the
          // raw background_color disarmed the brightness gate whenever the
          // crawl missed it — exactly how the Duolingo inversion shipped.
          brandBackground: resolveCanvasPlan(brief?.brand_extract).background,
          // Barbell (a >30% empty horizontal band), cross-piece overlap (a
          // title colliding with a diegetic mock — shipped in 2 of 3 brands in
          // one batch), and canvas-brightness (a light brand shipped on dark
          // canvases — 5/5 scenes in the Duolingo QA) are measured,
          // high-precision failures — block on the build path so the repair
          // ladder regenerates the scene with the concrete reason.
          blockingKinds: ["overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness"],
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
    await recordGateTelemetry({
      scriptId,
      fires: tallyGateFires({ findings: repair.initialFindings, warnings: currentWarnings }),
      residual: tallyGateFires({ findings: repair.findings }),
      repairSteps: repair.steps.length,
      firstPassClean: false,
      buildWallMs: Date.now() - buildT0,
    });
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
  // Ran-vs-found-nothing must be distinguishable downstream: a swallowed vision
  // failure used to look identical to a clean pass (no ledger row, no findings
  // key — the Duolingo build shipped an invisible-logo scene that way).
  let visionRan = false;
  let visionUsage = { ...EMPTY_USAGE };
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
      // Derived, never-undefined canvas — the raw background_color left the
      // rubric's canvas check toothless whenever the crawl missed it.
      backgroundColor: resolveCanvasPlan(be).background,
      accent: be?.logo_color ?? be?.palette?.[0],
      fonts: [be?.font_roles?.display, be?.font_roles?.body].filter(
        (f): f is string => !!f,
      ),
    };
    const judge = makeVisionJudge(async (imageBase64, rubric) => {
      const { text, usage } = await callZaiVision(imageBase64, rubric);
      visionUsage = addUsage(visionUsage, usage);
      return text;
    });
    visionFindings = VISION_GATE_ENABLED
      ? await runVisionGate(
          measured.map((m) => ({
            scene: m.scene,
            screenshotPath: m.screenshotPath,
            // Plan-fidelity: the rubric judges each frame against ITS concept —
            // degraded deliveries (blank hero card, inverted emotional beat)
            // shipped invisibly when the frame was only judged in isolation.
            concept: currentScript?.scenes?.[m.scene]?.visual_concept,
          })),
          brandTruth,
          judge,
        )
      : [];
    if (VISION_GATE_ENABLED && measured.length > 0) visionRan = true;
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
    // The ledger must show the gate DIDN'T run — absence of a vision-qa row
    // previously read as "ran clean". Records whatever partial usage the
    // failed pass accumulated (z.ai bills it either way).
    await recordUsage({
      op: "vision-qa",
      model: VISION_MODEL,
      scriptId,
      url: brief?.brand_kit_url,
      usage: visionUsage,
      failed: true,
    }).catch(() => {});
  }

  // VISION-IN-THE-LOOP (docs/QUALITY-ARCHITECTURE.md #2). One BOUNDED act on
  // the vision findings: the single worst scene with SEVERE issues gets one
  // scoped regen carrying the vision reasons, verified against the blocking
  // render-truth gates before adoption (rollback on regression). Default ON
  // since the 2026-07-06 QA — the exact defects it repairs (blank hero card,
  // invisible logo, placeholder prices) shipped to a customer while it sat
  // behind an opt-in flag. RB_VISION_LOOP=0 disables.
  let visionLoopActed: string | null = null;
  const SEVERE_RX = /unreadable|clipped|cut ?off|overlap|invisible|missing|broken|empty|flat|illegible|placeholder|masked|blank|loading|frozen|nav bar|pagination/i;
  if (process.env.RB_VISION_LOOP !== "0" && visionFindings.length > 0) {
    const severe = visionFindings.filter((f) => SEVERE_RX.test(f.issue));
    if (severe.length > 0) {
      const byScene = new Map<number, string[]>();
      for (const f of severe) byScene.set(f.scene, [...(byScene.get(f.scene) ?? []), f.issue]);
      const [worstScene, issues] = [...byScene.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      console.warn(`[preview/build] vision-loop: regenerating scene ${worstScene} for ${issues.length} severe issue(s)`);
      const before = { code: currentCode, design: currentDesign, warnings: currentWarnings };
      const r = await regenerateScene(
        buildAgentInputFromBrief(brief, currentScript),
        currentCode!,
        worstScene,
        `A visual review of the rendered scene found these problems — fix them:\n- ${issues.join("\n- ")}`,
      );
      if (r.usage) currentUsage = addUsage(currentUsage, r.usage);
      if (r.ok) {
        currentCode = r.code;
        currentDesign = r.designCode;
        currentWarnings = r.warnings;
        await writeCurrent(r.warnings, r.asset_manifest);
        // Verify-before-keep: the vision fix must not regress the blocking gates.
        const ms = await measureScenes(genDir, currentScript, measureOutDir(genDir));
        const regate = await findRenderTruthFailures(ms, {
          brandBackground: resolveCanvasPlan(brief?.brand_extract).background,
          blockingKinds: ["overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness"],
        });
        if (regate.blocking.length > 0) {
          console.warn(
            `[preview/build] vision-loop: regen regressed blocking gates (${regate.blocking.map((f) => f.kind).join(", ")}) — rolled back`,
          );
          currentCode = before.code;
          currentDesign = before.design;
          currentWarnings = before.warnings;
          // manifest untouched: scene regens don't produce one (leave disk as-is)
          await writeCurrent(before.warnings, undefined);
          visionLoopActed = `scene ${worstScene}: rolled back (regression)`;
        } else {
          visionLoopActed = `scene ${worstScene}: regenerated for ${issues.length} vision issue(s)`;
        }
      } else {
        console.warn(`[preview/build] vision-loop: regen failed — ${r.error}`);
        visionLoopActed = `scene ${worstScene}: regen failed`;
      }
    }
  }

  // Persist vision findings beside the other warnings so the dashboard/report and
  // the calibration telemetry see them (they previously lived only in the HTTP
  // response + console — calibration data evaporated). An empty array is written
  // when the gate RAN and found nothing — key absent means it never ran.
  if (visionRan) {
    try {
      const warnPath = path.join(genDir, "warnings.json");
      const existing = JSON.parse(await (await import("fs")).promises.readFile(warnPath, "utf8").catch(() => "{}"));
      existing.vision = visionFindings.map((f) => `scene ${f.scene}: ${f.issue}`);
      await (await import("fs")).promises.writeFile(warnPath, JSON.stringify(existing, null, 2));
    } catch {
      /* best-effort */
    }
  }

  // The build shipped — record the full build-model spend (initial + every
  // repair regen/rewrite) as ONE successful row.
  await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: currentUsage });

  // Gate fire-rate telemetry — the deletion criterion (QUALITY-ARCHITECTURE.md).
  // `fires` tallies the FIRST measure (what the gates caught — repaired findings
  // must still count or the deletion criterion undercounts); `residual` tallies
  // the final measure (advisory findings that shipped). firstPassClean = no
  // blocking finding fired AND the ladder took zero steps.
  await recordGateTelemetry({
    scriptId,
    fires: tallyGateFires({ findings: repair.initialFindings, warnings: currentWarnings, visionFindings }),
    residual: tallyGateFires({ findings: repair.findings }),
    repairSteps: repair.steps.length,
    firstPassClean: repair.blocking.length === 0 && repair.steps.length === 0,
    buildWallMs: Date.now() - buildT0,
  });

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
