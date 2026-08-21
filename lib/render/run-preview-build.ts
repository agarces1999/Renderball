import path from "path";
import { promises as fs } from "fs";
import { loadScript, loadBriefByScriptId, saveScript } from "../store";
import {
  buildAnimatedSections,
  buildAgentInputFromBrief,
  regenerateScene,
  repairSceneRenderErrors,
} from "../agents/pipeline";
import {
  writeGeneratedFiles,
  IMG_SHIM_SOURCE,
  PIECE_SHIM_SOURCE,
  VIDEO_SHIM_SOURCE,
  LOTTIE_SHIM_SOURCE,
  BRAND_CHROME_SOURCE,
} from "./build-wrapper";
import { decomposeGenDir } from "../agents/lego-store";
import { persistGenDir } from "./gen-store";
import { resolveCornerBrandMark } from "../agents/logo-inject";
import { verifyScenesRender } from "./ssr-render";
import { measureScenes } from "./measure-scene";
import { cachedThumbnail } from "./thumbnail";
import {
  awaitArtifact,
  clearInflight,
  scriptHash,
  writeArtifact,
  writeInflight,
} from "./prescaffold";
import { findFlooredCopy, applyShortened, shortenPrompt } from "./semantic-shorten";
import { findRenderTruthFailures, measureOutDir, advisoryFindings, BLOCKING_RENDER_TRUTH_KINDS } from "./render-truth-gates";
import { resolveCanvasPlan, canvasBrandFidelityAdvisory, signatureWithLogoFallback, brandShortName } from "../crawl/brand-identity";
import { preflightBrandTruth } from "../crawl/brand-truth";
import { repairRenderTruth } from "./render-truth-repair";
import {
  runVisionGate,
  makeVisionJudge,
  checkBrandColorFidelity,
  buildRubric,
  parseVerdict,
  isSanctionedChromeFinding,
  type VisionFinding,
} from "./vision-gate";
import { MODELS, VISION_MODEL } from "../anthropic";
import { callZaiVision, callZaiText } from "./zai-vision";
import { recordUsage, costUsd, addUsage, EMPTY_USAGE, type Usage } from "../usage";
import { withSpend } from "../spend/context";
import { tallyGateFires, recordGateTelemetry } from "./gate-telemetry";
import { recordMeteredUsage } from "../entitlement";
import { recordTokenUsage } from "../metering";
import { assertZaiAvailable, ZaiUnavailableError } from "../zai-breaker";
import { BuildTimeline } from "../agents/build-timeline";
import {
  BuildCancelledError,
  buildCancelRequested,
  reportBuildProgress,
} from "./build-jobs";
import { runQualityLoop, type SceneVisionVerdict, type GateRoundReport, type LoopScript, type BrandTruthLite } from "./quality-loop";
import { deriveCrawlTheme } from "./crawl-theme";
import { castCall, castConfigured } from "../llm/cast-provider";
import { neutralizeInk } from "../agents/cast-build";
import { generateComposition, type CompositionCaller } from "../agents/composition-head";
import { checkSceneComposition } from "../agents/schema-validator";
import { planValidationErrors, enforcePlanFallback } from "../agents/plan-validate";
import type { Script, Scene } from "../../src/schema";

/** v10 edge-crop clamp breath — a clamped piece never sits flush to the edge. */
const EDGE_CLAMP_MARGIN_PX = 12;
const CAST_MAX_RETRY_ROUNDS = 2;
/** The cast path's hard cumulative-spend ceiling (mirrors the monolithic $10). */
const CAST_SPEND_CEILING_USD = 10;
const CAST_SEVERE_RX =
  /unreadable|clipped|cut ?off|overlap|invisible|missing|broken|empty|flat|illegible|placeholder|masked|blank|loading|frozen|nav bar|pagination/i;

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
/**
 * Speculative scaffold job — fired by the approval beat, runs the pipeline's
 * OWN prep + scaffold stage (scaffoldOnly) and persists the artifact the
 * next build resumes from. Fire-and-forget; every failure path just means
 * the build scaffolds for itself.
 */
export async function runPrescaffold(scriptId: string, ownerId: string): Promise<void> {
  const script = await loadScript(scriptId, ownerId);
  if (!script || script.config.kind !== "deck") return;
  const brief = await loadBriefByScriptId(scriptId, ownerId);
  if (!brief) return;
  await writeInflight(scriptId);
  try {
    const result = await withSpend(
      { stage: "build", scriptId, ownerId, runId: `${scriptId}-prescaffold-${Date.now()}` },
      () =>
        buildAnimatedSections(buildAgentInputFromBrief(brief, script), {
          scaffoldOnly: true,
        }),
    );
    const r = result as unknown as { ok?: boolean; scaffoldOnly?: boolean; scaffoldCode?: string; spliceable?: boolean };
    if (r.ok && r.scaffoldOnly && r.spliceable && r.scaffoldCode) {
      await writeArtifact(scriptId, { hash: scriptHash(script), code: r.scaffoldCode, at: Date.now() });
      console.log(`[prescaffold] ${scriptId}: artifact ready (${r.scaffoldCode.length} bytes)`);
    } else {
      console.warn(`[prescaffold] ${scriptId}: not spliceable — discarded (build will scaffold itself)`);
    }
  } catch (e) {
    console.warn(`[prescaffold] ${scriptId} failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    await clearInflight(scriptId).catch(() => {});
  }
}

export async function runPreviewBuild(
  scriptId: string,
  ownerId: string,
  opts?: {
    /** Per-call build-mode override (canvas pivot: lets the deck path pick
     *  cast without touching the process env). Falls back to RB_BUILD_MODE. */
    buildMode?: "cast" | "parallel" | "monolithic";
  },
): Promise<BuildRouteResult> {
  // ONE wrap attributes every provider call a build makes — scaffold, scene
  // fills (which fan out with Promise.all), motion, repairs, gate retries and
  // the vision judgments — to this deck and this owner, without any of those
  // ~15 modules knowing the ledger exists. runId groups them into one attempt
  // so "what did this build cost" is a single query.
  //
  // The wrapper exists because AsyncLocalStorage needs a callback boundary and
  // the body below is 900 lines with a dozen returns; splitting it is safer
  // than threading a try/finally through all of them.
  const result = await withSpend(
    { stage: "build", scriptId, ownerId, runId: `${scriptId}-${Date.now()}` },
    () => runPreviewBuildInner(scriptId, ownerId, opts),
  );
  /**
   * WARM THE GALLERY THUMBNAIL while everything is hot (founder, 2026-08-18:
   * "previews take a lot to load, makes our product feel pretty bad"). The
   * genDir is local, chromium is warm, and cachedThumbnail write-throughs to
   * R2 — so the gallery card is instant from the first visit and survives
   * the deploy that would have wiped a disk-only cache. Guarded hard: capped
   * at 45s and failure-blind, because a thumbnail must never fail (or hold)
   * a build that already succeeded — one capture in the offline harness hung
   * past 3 minutes, and that class of hang must land on the next lazy
   * request, not on the build response.
   */
  if ((result.body as { ok?: boolean } | undefined)?.ok) {
    try {
      const script = await loadScript(scriptId, ownerId);
      if (script) {
        await Promise.race([
          cachedThumbnail(scriptId, script),
          new Promise((r) => setTimeout(r, 45_000)),
        ]);
      }
    } catch (e) {
      console.warn(`[preview/build] thumbnail warm skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
  return result;
}

async function runPreviewBuildInner(
  scriptId: string,
  ownerId: string,
  opts?: { buildMode?: "cast" | "parallel" | "monolithic" },
): Promise<BuildRouteResult> {
  // Balance circuit breaker (the twice-proven [1113] outage): while the z.ai
  // account is dry, fail fast with a friendly message BEFORE any spend or
  // quota consumption — never burn a customer's build slot on a dead account.
  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) {
      return { status: 503, body: { error: err.friendly } };
    }
    throw err;
  }
  const buildT0 = Date.now();
  const script = await loadScript(scriptId, ownerId);
  if (!script) {
    return { status: 404, body: { error: "script not found" } };
  }

  const brief = await loadBriefByScriptId(scriptId, ownerId);
  // brief is optional — without it the agents fall back to empty brand context.

  // ── v14 BRAND-TRUTH PREFLIGHT (build entry, against the CACHED extract) ──
  // Stored briefs carry cached extracts the crawl-time checks never saw, and
  // even a healthy crawl goes stale (a logo URL that 200'd at crawl time can be
  // dead at build time — the naturalWidth=0 class). Verify over the network
  // (time-boxed), refuse on hardFail BEFORE any spend, act on the verification
  // (drop dead photos / blank dead logo candidates, in-memory only), and carry
  // degradations into the build warnings.
  let brandTruthDegraded: string[] | undefined;
  if (brief?.brand_extract?.ok) {
    const userLogo = brief.brand_files?.find((f) => f.is_logo);
    const truth = await preflightBrandTruth(brief.brand_extract, {
      userLogoUrl: userLogo?.url,
    });
    if (truth.hardFail) {
      console.error(
        "[preview/build] brand-truth preflight HARD FAIL:",
        truth.degraded.join(" · "),
      );
      return {
        status: 422,
        body: {
          error: `The brand extract failed the brand-truth preflight: ${truth.degraded.join("; ")}. Re-crawl the brand's site (it may have been down or parked when crawled) or upload a logo and pick a brand color, then rebuild.`,
          stage: "brand-truth-preflight",
          brand_truth: truth as unknown as Record<string, unknown>,
        },
      };
    }
    if (truth.degraded.length > 0) {
      console.warn("[preview/build] brand-truth DEGRADED:", truth.degraded.join(" · "));
      brandTruthDegraded = truth.degraded;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bx = brief.brand_extract as any;
    const deadPhotos = new Set(truth.signals.photos.deadUrls);
    if (deadPhotos.size > 0 && Array.isArray(bx.page_images)) {
      bx.page_images = bx.page_images.filter(
        (p: { src?: string }) => !p?.src || !deadPhotos.has(p.src),
      );
    }
    const rejectedLogos = new Set(truth.signals.logo.rejected.map((r) => r.url));
    if (!userLogo && rejectedLogos.size > 0) {
      if (bx.logo_hd && rejectedLogos.has(bx.logo_hd)) {
        bx.logo_hd = undefined;
        bx.logo_confidence = undefined;
        bx.logo_source = undefined;
      }
      if (bx.apple_touch_icon && rejectedLogos.has(bx.apple_touch_icon)) bx.apple_touch_icon = undefined;
      if (bx.favicon && rejectedLogos.has(bx.favicon)) bx.favicon = undefined;
    }
  }

  // Phase-boundary clock, persisted as <genDir>/build-timeline.json at the
  // end — the 57-min HubSpot run was unattributable because the only phase
  // data lived in discarded console logs. Never again.
  //
  // onMark is the live half (2026-08-12, founder watching a Klarna build):
  // every boundary is reported to the polling client — the ceremony's steps
  // used to be a 48-second pacing animation while the repair ladder ground
  // for ten real minutes under "Opening the editor" — and the same hook is
  // the cooperative STOP checkpoint, so a cancel lands at the next boundary
  // without threading a flag through every pipeline stage.
  const timeline = new BuildTimeline({
    onMark: (e) => {
      reportBuildProgress(scriptId, e.phase);
      if (buildCancelRequested(scriptId)) throw new BuildCancelledError();
    },
  });

  // ── RB_BUILD_MODE=cast: the LEGO product path (head → cast → assemble →
  // runQualityLoop) instead of the monolithic buildAnimatedSections. Unset →
  // production behavior UNCHANGED (the monolithic path stays default until the
  // cast path is validated). Task #205 (cycle 8) — the entire piece-level gate
  // battery the dogfood loop built lives ONLY in the cast path.
  if ((opts?.buildMode ?? process.env.RB_BUILD_MODE) === "cast") {
    return runCastPreviewBuild({
      script,
      brief,
      scriptId,
      ownerId,
      genDir: path.join(process.cwd(), "src", "generated", scriptId),
      timeline,
      buildT0,
      brandTruthDegraded,
    });
  }

  // Hoisted above the build: the onSectionAssembled hook below fires DURING
  // buildAnimatedSections, and a const declared after the call is TDZ when
  // the first fill lands.
  const genDir = path.join(process.cwd(), "src", "generated", scriptId);

  // Speculative scaffold: wait briefly for an in-flight run (clicking Build
  // during the scaffold's own runtime is the common case), then hand a fresh
  // matching artifact to the pipeline — which skips its paid scaffold call.
  const prescaffold = await awaitArtifact(scriptId, script as Script).catch(() => null);
  if (prescaffold) console.log(`[preview/build] speculative scaffold HIT (${prescaffold.code.length} bytes)`);

  const result = await buildAnimatedSections(
    buildAgentInputFromBrief(brief, script),
    {
      timeline,
      ...(prescaffold ? { prescaffold: { code: prescaffold.code } } : {}),
      // Each landed page reaches disk immediately so the ceremony can show
      // the REAL page materializing (the blank family already on disk makes
      // the scene renderable the moment its section is real). Display path
      // only — the authoritative write of the full family still happens
      // below when the pipeline returns.
      onSectionAssembled: async (_scene, code) => {
        const { promises: fsp } = await import("fs");
        await fsp.mkdir(genDir, { recursive: true });
        // RESOLVE REFS BEFORE THE PREVIEW SEES IT (founder, 2026-08-20:
        // "Render error: GitPullRequest is not defined" on a mid-build page).
        // A freshly-spliced section can name a lucide icon the file has not
        // imported yet; the pipeline's deterministic repair only runs at the
        // END, so the live view was rendering un-finalized code and crashing
        // on a deck that would ship perfectly fine. Zero-token, and it never
        // blocks the write: on any failure we persist the raw splice exactly
        // as before.
        let display = code;
        try {
          const { finalizeUndefinedRefs } = await import("../agents/finalize-refs");
          display = (await finalizeUndefinedRefs(code)).code;
        } catch (err) {
          // NOT a silent degrade: if this ever throws, the live page can show
          // a render error again, so it must be visible in the logs rather
          // than quietly reverting to the broken behavior. We still write —
          // refusing to write would cost the user the page entirely, which is
          // strictly worse than a page that might render.
          console.error(
            "[preview/build] progressive ref-finalize FAILED — live page may show a render error:",
            err instanceof Error ? err.message : err,
          );
        }
        await fsp.writeFile(path.join(genDir, "Composition.tsx"), display, "utf8");
      },
      // The foundation reaches disk the moment it exists, so the ceremony can
      // put the REAL branded canvas on screen while the pages are still being
      // designed — instead of a white rectangle for the whole build.
      onScaffold: async (code) => {
        const { promises: fsp } = await import("fs");
        await fsp.mkdir(genDir, { recursive: true });
        let display = code;
        try {
          const { finalizeUndefinedRefs } = await import("../agents/finalize-refs");
          display = (await finalizeUndefinedRefs(code)).code;
        } catch (err) {
          console.error(
            "[preview/build] scaffold ref-finalize FAILED — foundation may show a render error:",
            err instanceof Error ? err.message : err,
          );
        }
        await fsp.writeFile(path.join(genDir, "Composition.tsx"), display, "utf8");
      },
    },
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
      // Pivot token counter (RB_METERING): failed attempts still spent tokens.
      await recordTokenUsage({ ownerId, usage: result.usage, op: "build" });
    }
    return { status: 500, body: { error: result.error, stage: result.stage } };
  }

  // Accumulate ALL build-model spend (initial build + every repair regen/rewrite)
  // into ONE bundle, recorded ONCE after the gates resolve.
  const model = MODELS.codingAgentBuild;
  let currentUsage = result.usage ?? EMPTY_USAGE;
  let currentWarnings = result.warnings;
  // Surface brand-truth degradations as build warnings (preview quality chips).
  if (brandTruthDegraded && brandTruthDegraded.length > 0) {
    currentWarnings = { ...(currentWarnings ?? {}), brand_truth_degraded: brandTruthDegraded };
  }

  // Write the generated artifacts under src/generated/<scriptId>/ via the shared
  // writer — IDENTICAL layout to the MP4 path, so "Render to MP4" reuses this
  // exact composition rather than rebuilding a different one.
  // Persist the phase timeline (best-effort, on success AND failure paths) so
  // wall-clock attribution survives lost consoles and dead HTTP clients.
  const persistTimeline = async () => {
    try {
      const { promises: fsp } = await import("fs");
      await fsp.writeFile(
        path.join(genDir, "build-timeline.json"),
        JSON.stringify(timeline.toJSON(), null, 2),
      );
    } catch { /* attribution is never worth failing a build over */ }
  };
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
      timeline.mark("gate:ssr-render:failed");
      await persistTimeline();
      await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: currentUsage, failed: true });
    await recordMeteredUsage({
      ownerId,
      operation: "build",
      model,
      costUsd: costUsd(model, currentUsage),
      inputTokens: currentUsage.input_tokens,
      outputTokens: currentUsage.output_tokens,
      failed: true,
    });
    await recordTokenUsage({ ownerId, usage: currentUsage, op: "build" });
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

  // Barbell (a >30% empty horizontal band), cross-piece overlap (a title
  // colliding with a diegetic mock — shipped in 2 of 3 brands in one batch),
  // canvas-brightness (a light brand shipped on dark canvases — 5/5 scenes in
  // the Duolingo QA), and stranded-hero (the layout composer contract: a small
  // diegetic hero alone in a corner is unshippable — Fuse scene-1 doctrine;
  // split scenes must honor the numeric column contract) are measured,
  // high-precision failures — block on the build path so the repair ladder
  // regenerates the scene with the concrete reason. Shared by the repair gate
  // AND the vision-loop verify below so the two can't drift. R2 (audit-3): this
  // is the ONE canonical set imported from render-truth-gates (was a hand-copied
  // literal that drifted from the standalone dogfood spike).
  const BLOCKING_KINDS = BLOCKING_RENDER_TRUTH_KINDS;
  // Audit-1 P0 #1: the ONE brand-name source of truth (was raw be.title — leaked
  // Faire's whole "Your one-stop shop for whole" tagline into gate feedback).
  const brandNameForGates = brandShortName(brief?.brand_extract);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registersOf = (s: any): (string | undefined)[] =>
    (s?.scenes ?? []).map((sc: { register?: string }) => sc?.register);

  /**
   * SEMANTIC SHORTEN, BEFORE THE LADDER (TEXT_FIT layer 3). One measure pass
   * reads the fit runtime's floor marks; copy that stayed overfull at the
   * readability floor gets ONE bounded shorten call targeting a length
   * COMPUTED from the measured overfullness. Fields are bound (unbound_copy
   * work, 2026-08-16), so the shortened script re-renders with zero
   * regeneration — the ladder then starts from honest, fitted pages instead
   * of burning paid rounds on copy no layout could ever hold. Persisted to
   * BOTH stores: the canonical script (the editor's text panel must show
   * what the pixels show) and genDir/script.json (what renders).
   */
  try {
    const preMeasure = await measureScenes(genDir, currentScript, measureOutDir(genDir), {
      screenshots: false, // rect-only: fitFloor + contentPath need no pixels
    });
    const floored = findFlooredCopy(preMeasure, currentScript.scenes ?? []);
    if (floored.length > 0) {
      console.warn(
        `[preview/build] fit floor hit on ${floored.length} field(s): ${floored
          .map((f) => `s${f.scene}.${f.path} ${f.fullness}x → ≤${f.target}`)
          .join(", ")} — one semantic shorten`,
      );
      const r = await castCall({
        stage: "design",
        timeoutMs: 120_000,
        system:
          "You shorten presentation copy to fit measured boxes. Keep meaning, brand voice, and the language of the original.",
        user: shortenPrompt(floored),
        maxTokens: 4000,
        json: true,
        // Thinking OFF — probe-verified 2026-08-18 on this wire: baseline
        // 6790ms/768 tokens vs 663ms/8 tokens with reasoning disabled, same
        // task quality on compression work. Shortening copy is not creative
        // composition; it must not pay the reasoning tax.
        effort: "none",
        model: MODELS.codingAgentBuild,
      });
      const arr = JSON.parse((r.text?.match(/\[[\s\S]*\]/) ?? ["[]"])[0]) as unknown[];
      const applied = applyShortened(floored, arr, currentScript.scenes ?? []);
      console.warn(`[preview/build] semantic shorten applied ${applied}/${floored.length}`);
      if (applied > 0) {
        await fs.writeFile(
          path.join(genDir, "script.json"),
          JSON.stringify(currentScript, null, 2),
          "utf8",
        );
        await saveScript(currentScript as Script, ownerId).catch((e: unknown) =>
          console.warn(`[preview/build] canonical script save failed (genDir is updated): ${e}`),
        );
      }
    }
  } catch (e) {
    console.warn(
      `[preview/build] semantic shorten skipped (${e instanceof Error ? e.message : e}) — ladder proceeds on the original copy`,
    );
  }

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
          blockingKinds: BLOCKING_KINDS,
          registers: registersOf(currentScript),
          brandName: brandNameForGates,
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
        // The directive text must follow `reason` — for a stranded hero the
        // fix is a BIGGER, recomposed hero, not "fewer, smaller elements"
        // (which the repair ladder already tailors in l3Reason). Only append
        // the shrink guidance when the reason is about density/overflow.
        const isStrandedReason = /hero|stranded|composer contract|recompose/i.test(reason);
        const directive = isStrandedReason
          ? `RECOMPOSE (must fit 1920×1080 — ${reason}): make the main visual a real hero — larger, anchored in the frame, vertically centered in its column; keep every element on-canvas.`
          : `SIMPLIFY (must fit 1920×1080 — ${reason}): reduce to fewer, smaller elements; narrow or stack wide rows; NO element may extend off-canvas.`;
        const lighter = {
          ...currentScript,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          scenes: currentScript.scenes.map((sc: any, i: number) =>
            sceneIndexes.includes(i)
              ? { ...sc, visual_concept: `${sc.visual_concept}\n\n${directive}` }
              : sc,
          ),
        };
        const rb = await buildAnimatedSections(buildAgentInputFromBrief(brief, lighter), { timeline });
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
      // The ladder's steps ARE the invisible minutes (a measured Klarna
      // build: two repair rounds, a full rebuild, two more rounds — all under
      // one held ceremony step). Marking them makes each round visible to
      // the polling client AND makes every round a stop checkpoint.
      onStep: (m) => {
        console.warn(`[preview/build] render-truth: ${m}`);
        timeline.mark(`repair:${m}`);
      },
    },
    { spentSoFarUsd: costUsd(model, result.usage), model },
  );

  timeline.mark(
    `gate:render-truth:${repair.ok ? "passed" : repair.reason} (${repair.steps.length} step(s))`,
  );

  if (!repair.ok && repair.reason === "measure-error") {
    // The one still-fatal class: the deck could not even be rendered and
    // measured, so there is nothing verifiable to hand over. Everything else
    // ships flagged below.
    await persistTimeline();
    console.error(
      `[preview/build] render-truth gate could not MEASURE after $${repair.spentUsd.toFixed(2)}:`,
      JSON.stringify(repair.blocking),
    );
    await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: currentUsage, failed: true });
    await recordMeteredUsage({
      ownerId,
      operation: "build",
      model,
      costUsd: costUsd(model, currentUsage),
      inputTokens: currentUsage.input_tokens,
      outputTokens: currentUsage.output_tokens,
      failed: true,
    });
    await recordTokenUsage({ ownerId, usage: currentUsage, op: "build" });
    await recordGateTelemetry({
      scriptId,
      genDir,
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

  if (!repair.ok) {
    // SHIP FLAGGED (founder, 2026-08-13, after paying twice for the same deck
    // and owning nothing: "this is unacceptable"). The ladder is bounded and
    // measured non-convergent past two rounds — at this point six finished
    // pages exist and one or two carry a layout finding the EDITOR fixes in
    // a click, which is the product's entire thesis. Refusing delivery
    // protected a quality bar at the price of everything the user paid for.
    // The deck ships; the failing pages arrive FLAGGED (same warnings
    // channel structural_unresolved ships through), the telemetry still
    // records the residual honestly, and the usage records as delivered.
    // RB_SHIP_FLAGGED=off restores the old refusal.
    const shipFlagged = !["off", "0", "false"].includes(
      String(process.env.RB_SHIP_FLAGGED ?? "").trim().toLowerCase(),
    );
    if (!shipFlagged) {
      await persistTimeline();
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
    const noun = (currentScript?.config?.kind ?? "deck") === "deck" ? "Page" : "Scene";
    const issues = repair.blocking.map(
      (f) => `${noun} ${f.scene + 1}: ${f.detail || f.kind} — flagged for a hand fix; the rest of the ${noun === "Page" ? "deck" : "video"} is clean.`,
    );
    currentWarnings = {
      ...(currentWarnings ?? {}),
      render_truth_unresolved: issues,
    };
    timeline.mark(`gate:render-truth:shipped-flagged (${repair.blocking.length} finding(s))`);
    console.warn(
      `[preview/build] shipping FLAGGED (${repair.reason}) — ${repair.blocking.length} finding(s) carried as warnings:`,
      JSON.stringify(repair.blocking.map((f) => ({ scene: f.scene, kind: f.kind }))),
    );
  }

  // ADVISORY RENDER-TRUTH FINDINGS — the ones the gate SAW and was not allowed
  // to block on.
  //
  // findRenderTruthFailures demotes a text-metric finding (overflow,
  // cross-piece-overlap, covered-text-cluster, intra-piece-overlap) to advisory
  // whenever the scene it fired on could not vouch for its own text metrics —
  // brand fonts that did not load, a fit pass that did not settle. That rule is
  // right and stays: a measurement that cannot trust its own glyph widths must
  // not buy repairs or refuse delivery.
  //
  // What was missing is the other half. Its comment promised untrusted findings
  // "flag, they inform" — but every warnings write below reads repair.blocking,
  // and `render_truth_unresolved` is only written when the ladder returns !ok.
  // A demoted finding therefore reached nothing a human ever sees: not the
  // quality panel, not warnings.json, only the HTTP response and a telemetry
  // ledger that a deploy erases.
  //
  // Measured 2026-08-21 on the deck that surfaced this. Its three brand
  // webfonts come from a remote CDN; repointing them at a 404 and re-measuring
  // turns cross-piece-overlap from FOUND 4 / BLOCKING 4 into FOUND 4 /
  // BLOCKING 0 — the page-2 collision the founder reported, seen by the gate,
  // silently dropped, and shipped as "checks passed".
  //
  // So: advisory findings are now written too, in their own key, worded so the
  // difference is legible — this was not repaired, and it was not verified
  // either; here is what the gate saw and why it could not act.
  {
    const advisory = advisoryFindings(repair.findings, repair.blocking, BLOCKING_KINDS);
    if (advisory.length > 0) {
      const noun = (currentScript?.config?.kind ?? "deck") === "deck" ? "Page" : "Scene";
      currentWarnings = {
        ...(currentWarnings ?? {}),
        render_truth_advisory: advisory.map(
          (f) =>
            `${noun} ${f.scene + 1}: ${f.detail || f.kind} — seen but not repaired: this page's ` +
            `text could not be measured reliably (brand fonts or text-fit did not settle), so the ` +
            `check was not allowed to act on it. Worth a look by eye.`,
        ),
      };
      console.warn(
        `[preview/build] ${advisory.length} render-truth finding(s) DEMOTED to advisory (untrusted text metrics):`,
        JSON.stringify(advisory.map((f) => ({ scene: f.scene, kind: f.kind }))),
      );
      timeline.mark(`gate:render-truth:advisory (${advisory.length} finding(s))`);
    }
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
      name: brandShortName(be), // Audit-1 P0 #1 (SSOT — was raw be.title)
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
      await recordTokenUsage({ ownerId, usage: visionUsage, op: "vision-qa" });
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
    await recordTokenUsage({ ownerId, usage: visionUsage, op: "vision-qa" });
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
          blockingKinds: BLOCKING_KINDS,
          registers: registersOf(currentScript),
          brandName: brandNameForGates,
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

  timeline.mark(`gate:vision:${visionRan ? `done (${visionFindings.length} finding(s))` : "skipped"}`);
  await persistTimeline();

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
  // Entitlement counter (no-op for DEV_OWNER_ID) — the quota that the
  // metering gate checks BEFORE the next build's spend.
  await recordMeteredUsage({
    ownerId,
    operation: "build",
    model,
    costUsd: costUsd(model, currentUsage),
    inputTokens: currentUsage.input_tokens,
    outputTokens: currentUsage.output_tokens,
  });
  await recordTokenUsage({ ownerId, usage: currentUsage, op: "build" });

  // Gate fire-rate telemetry — the deletion criterion (QUALITY-ARCHITECTURE.md).
  // `fires` tallies the FIRST measure (what the gates caught — repaired findings
  // must still count or the deletion criterion undercounts); `residual` tallies
  // the final measure (advisory findings that shipped). firstPassClean = no
  // blocking finding fired AND the ladder took zero steps.
  await recordGateTelemetry({
    scriptId,
    genDir,
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
    // RE-PERSIST. writeGeneratedFiles snapshots the genDir to R2, and every one
    // of its call sites above runs BEFORE this decompose — so without this the
    // durable copy carries the store that predated the build (for a deck made
    // from a blank document, the one-scene `s0.hint` scaffold). The next deploy
    // wipes the container, the document rehydrates from that snapshot, and every
    // editor operation reads a store describing a document that no longer
    // exists: move/delete/insert find no piece, page-ops refuses with
    // "store/script scene mismatch", re-skin reports it would stop the later
    // pages rendering. Measured 2026-08-21 on 3 of 94 stored decks.
    if (lego.ok) await persistGenDir(scriptId);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedScript = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedBrief = any;

/**
 * The LEGO product path (RB_BUILD_MODE=cast). Derives a deterministic theme
 * from the crawl, runs the composition head (best-effort blueprints), then
 * drives castBuild + the SHARED runQualityLoop — the exact piece-level gate
 * battery the dogfood loop built (washout+lift, hero-underscale, skeleton,
 * accent-fill, edge-crop+clamp, broken-img+swap, logo-glyph, occupancy,
 * text-contrast, stray-fragment, per-piece render-truth, class-matched breaker,
 * bind-in-place, per-scene vision). Preserves production's spend ceiling, usage
 * telemetry, entitlement metering, gen-dir persistence, gate telemetry, and the
 * lego decompose — nothing about the surrounding contract changes.
 */
async function runCastPreviewBuild(args: {
  script: LoadedScript;
  brief: LoadedBrief;
  scriptId: string;
  ownerId: string;
  genDir: string;
  timeline: BuildTimeline;
  buildT0: number;
  brandTruthDegraded: string[] | undefined;
}): Promise<BuildRouteResult> {
  const { script, brief, scriptId, ownerId, genDir, timeline, buildT0, brandTruthDegraded } = args;
  const model = MODELS.codingAgentBuild;

  if (!castConfigured()) {
    return {
      status: 500,
      body: { error: "RB_BUILD_MODE=cast but the cast provider is not configured (RB_CAST_KEY missing)", stage: "cast-config" },
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const be: any = brief?.brand_extract?.ok ? brief.brand_extract : undefined;
    const canvasPlan = resolveCanvasPlan(be);
    const signature =
      signatureWithLogoFallback(be?.palette ?? [], be?.theme_color, be?.logo_color, be?.named) ??
      be?.theme_color ??
      (be?.palette ?? [])[0] ??
      "#666666";
    const brand = brandShortName(be); // Audit-1 P0 #1 (SSOT — was raw be.title)
    const canvasAdvisory = canvasBrandFidelityAdvisory(canvasPlan, signature);
    if (canvasAdvisory) console.warn(`[run-preview-build] canvas brand-fidelity advisory (non-blocking): ${canvasAdvisory}`);
    const derived = deriveCrawlTheme(be, canvasPlan.background, canvasPlan.mode, signature, be?.palette ?? []);
    const inkGuard = neutralizeInk(derived.theme);
    const theme = inkGuard.theme;

    const userLogo = brief?.brand_files?.find((f: { is_logo?: boolean }) => f.is_logo);
    // Corner mark: a user logo / logo_hd renders as the image; an app-icon
    // (apple_touch_icon / favicon) would silhouette to a blank white square, so
    // it is demoted to the brand wordmark text (resolveCornerBrandMark). The
    // app icon stays available to the hero as a preallocated asset.
    const { logoSrc } = resolveCornerBrandMark({
      userLogoUrl: userLogo?.url,
      logoHd: be?.logo_hd,
      brandName: brand,
    });

    const aspect = (["16:9", "9:16", "1:1"].includes(script.config?.aspect_ratio ?? "")
      ? script.config!.aspect_ratio
      : "16:9") as "16:9" | "9:16" | "1:1";

    // ── spend tracking against the $10 ceiling (glm-5.2 pricing, the build model) ──
    let castUsage: Usage = { ...EMPTY_USAGE };
    const track = (r: { inputTokens: number; outputTokens: number }): void => {
      castUsage = addUsage(castUsage, {
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    };
    const overCeiling = (): boolean => costUsd(model, castUsage) >= CAST_SPEND_CEILING_USD;

    // ── HEAD: composition blueprints (best-effort — castBuild builds fine
    // without them; on any failure we proceed with un-composed scenes). ──
    let composedScript: LoadedScript = script;
    timeline.mark("cast:head:start");
    try {
      const headCaller: CompositionCaller = async (call) => {
        const r = await castCall({
          system: call.system,
          user: call.user,
          maxTokens: call.maxTokens,
          effort: call.effort === "none" ? "low" : call.effort,
        });
        track(r);
        return { text: r.text };
      };
      // P1 (spatial): the CONSUMED ScenePlan is validated (and deterministically
      // repaired) at AUTHOR time, inside the head's existing retry loop — so a
      // containment / undeclared-overlap / stranded-hero / budget violation is
      // caught and fixed BEFORE any leaf element is emitted, not measured after.
      const hasThroughline = !!(script as unknown as Script).narrative?.throughline?.trim();
      const composed = await generateComposition({
        script: script as unknown as Script,
        caller: headCaller,
        validate: (scenes: Scene[]) => [
          ...checkSceneComposition(scenes, { aspect, canvasBackground: canvasPlan.background }),
          ...planValidationErrors(scenes, { aspect, hasThroughline, label: "preview/build:cast" }),
        ],
        aspect,
        brandName: brand,
        paletteHint: `canvas ${canvasPlan.background} (${canvasPlan.mode}), signature accent ${signature}, brand palette: ${(be?.palette ?? []).join(", ")}`,
        designNotes: `Design system consts available downstream: PALETTE (CANVAS/INK/ACCENT/MUTED/SOFT_NEUTRAL/CARD_FILL/WHITE), shared keyframes (glowBreathe, drift1-3, drawWidth, fadeRise, scaleIn). Fonts: display ${theme.fonts.display}, body ${theme.fonts.body}.`,
      });
      // Terminal: anything the head still ships violating loses its head bounds
      // and falls back to the composer's guaranteed-valid geometry tables — a
      // plainer frame beats a broken one.
      enforcePlanFallback(composed.scenes, { aspect, hasThroughline, label: "preview/build:cast" });
      composedScript = { ...script, scenes: composed.scenes };
      console.log(`[preview/build:cast] composition head: ${composed.attempts} attempt(s)`);
    } catch (err) {
      console.warn("[preview/build:cast] composition head failed — building with un-composed scenes:", err);
    }
    timeline.mark("cast:head:done");

    const accentHexes = [
      ...new Set(
        [derived.signatureAccent, theme.palette.ACCENT].filter(
          (h): h is string => typeof h === "string" && /^#[0-9a-fA-F]{3,8}$/.test(h),
        ),
      ),
    ];
    const brandTruth = {
      name: brand,
      backgroundColor: canvasPlan.background,
      accent: signature,
      fonts: [be?.font_roles?.display, be?.font_roles?.body].filter((f: unknown): f is string => !!f),
    };

    // ── per-scene vision (advisory driver of severe→regen targets) ──
    let visionUsage: Usage = { ...EMPTY_USAGE };
    let visionRan = false;
    const runPerSceneVision =
      process.env.RB_VISION_GATE === "off"
        ? undefined
        : async (
            measurements: { scene: number; screenshotPath?: string }[],
            scr: LoopScript,
            bt: BrandTruthLite,
          ): Promise<SceneVisionVerdict[]> => {
            const withShots = measurements.filter(
              (m): m is { scene: number; screenshotPath: string } => !!m.screenshotPath,
            );
            const judged = await Promise.allSettled(
              withShots.map(async (m) => {
                visionRan = true;
                const b64 = (await fs.readFile(m.screenshotPath)).toString("base64");
                const rubric = buildRubric(bt, scr.scenes[m.scene]?.visual_concept);
                const { text, usage } = await callZaiVision(b64, rubric);
                visionUsage = addUsage(visionUsage, usage);
                const verdict = parseVerdict(text);
                const actionable = verdict.issues.filter((issue) => !isSanctionedChromeFinding(issue));
                return {
                  scene: m.scene,
                  ok: verdict.ok || actionable.length === 0,
                  issues: verdict.issues,
                  actionable,
                  severe: actionable.filter((issue) => CAST_SEVERE_RX.test(issue)),
                } satisfies SceneVisionVerdict;
              }),
            );
            const out: SceneVisionVerdict[] = [];
            for (const [k, r] of judged.entries()) {
              if (r.status === "fulfilled") out.push(r.value);
              else out.push({ scene: withShots[k]?.scene ?? -1, ok: true, issues: [], actionable: [], severe: [], error: String(r.reason).slice(0, 200) });
            }
            return out.sort((a, b) => a.scene - b.scene);
          };

    timeline.mark("cast:loop:start");
    const loop = await runQualityLoop(
      {
        castInput: {
          script: composedScript as unknown as Script,
          theme,
          palette: derived.paletteHexes,
          signatureAccent: derived.signatureAccent,
          aspect,
        },
        script: composedScript as unknown as LoopScript,
        genDir,
        brand,
        logoSrc,
        canvasBackground: canvasPlan.background,
        accentHexes,
        brandTruth,
        registers: (composedScript.scenes ?? []).map((s: { register?: string }) => s.register),
        maxRetryRounds: CAST_MAX_RETRY_ROUNDS,
        blockingKinds: BLOCKING_RENDER_TRUTH_KINDS,
        edgeClampMarginPx: EDGE_CLAMP_MARGIN_PX,
        defaultCastModel: process.env.RB_CAST_MODEL,
      },
      {
        transport: async (a) => {
          const r = await castCall({
            system: a.system,
            user: a.user,
            maxTokens: a.maxTokens,
            model: a.model,
            effort: a.effort,
            json: a.json,
          });
          track(r);
          return r;
        },
        runPerSceneVision,
        ensureGenDir: async () => {
          await fs.mkdir(genDir, { recursive: true });
          await fs.writeFile(path.join(genDir, "Img.tsx"), IMG_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(genDir, "Piece.tsx"), PIECE_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(genDir, "Video.tsx"), VIDEO_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(genDir, "Lottie.tsx"), LOTTIE_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(genDir, "BrandChrome.tsx"), BRAND_CHROME_SOURCE, "utf8");
          await fs.writeFile(path.join(genDir, "script.json"), JSON.stringify(composedScript, null, 2), "utf8");
        },
        writeComposition: async (code) => {
          await fs.writeFile(path.join(genDir, "Composition.tsx"), code, "utf8");
        },
        shouldStopForBudget: overCeiling,
        log: (m) => console.log(m),
        warn: (m) => console.warn(m),
      },
    );
    timeline.mark(`cast:loop:done (${loop.rounds + 1} round(s), round0 ${loop.round0?.passed ? "clean" : "failed"})`);

    if (loop.castRoundError) {
      await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: castUsage, failed: true });
      await recordTokenUsage({ ownerId, usage: castUsage, op: "build" });
      return {
        status: 500,
        body: { error: `cast build failed: ${loop.castRoundError.error}`, stage: "cast-build" },
      };
    }

    // ── canonical persistence (identical layout to the MP4 path). The cast
    // composition is self-contained (theme inlined), so designCode is empty. ──
    const warnings = brandTruthDegraded?.length
      ? { brand_truth_degraded: brandTruthDegraded }
      : undefined;
    await writeGeneratedFiles(genDir, {
      designCode: "",
      code: loop.finalCode,
      script: composedScript,
      warnings,
      assetManifest: undefined,
    });

    // ── usage + entitlement metering (build-model spend = head + cast + repairs) ──
    await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: castUsage });
    await recordMeteredUsage({
      ownerId,
      operation: "build",
      model,
      costUsd: costUsd(model, castUsage),
      inputTokens: castUsage.input_tokens,
      outputTokens: castUsage.output_tokens,
    });
    await recordTokenUsage({ ownerId, usage: castUsage, op: "build" });
    let visionCostUsd = 0;
    if (visionRan && (visionUsage.input_tokens || visionUsage.output_tokens)) {
      visionCostUsd = costUsd(VISION_MODEL, visionUsage);
      await recordUsage({ op: "vision-qa", model: VISION_MODEL, scriptId, url: brief?.brand_kit_url, usage: visionUsage });
      await recordTokenUsage({ ownerId, usage: visionUsage, op: "vision-qa" });
    }

    // ── gate telemetry tallies (fire-rate is the gate-deletion criterion).
    // Computed BEFORE the SSR gate below so the fail-closed path records the
    // same ledger rows a shipped build would. ──
    const fires: Record<string, number> = {};
    const residual: Record<string, number> = {};
    const tallyRound = (g: GateRoundReport | undefined, into: Record<string, number>): void => {
      if (!g) return;
      const bump = (k: string, n = 1): void => { if (n > 0) into[k] = (into[k] ?? 0) + n; };
      for (const f of g.density) bump(`density/${f.kind}`);
      for (const f of g.renderTruthBlocking) bump(`render-truth/${f.kind}`);
      bump("hero-washout", g.heroContrast.findings.length);
      bump("hero-underscale", g.heroUnderscale.length);
      bump("accent-fill", g.accentFill.findings.length);
      bump("edge-crop", g.edgeCrop.residual.length);
      bump("occupancy-void", g.occupancy.findings.filter((x) => x.blocking).length);
      bump("text-contrast", g.textContrast.blocking.length);
      bump("skeleton", g.skeletonBars.filter((s) => s.blocking).length);
      bump("icon-font-strip", g.iconFontStrips.length);
      bump("orphaned-fragment", g.orphanedFragments.length);
      bump("cross-piece-stat-dup", g.crossPieceStatDups.length);
      bump("brand-mark-defect", g.brandMarkDefects.length);
      bump("accented-glyph-gap", g.accentedGlyphGaps.length);
      for (const v of g.vision) bump("vision", v.severe.length);
    };
    tallyRound(loop.gateRounds[0], fires);
    tallyRound(loop.gateRounds[loop.gateRounds.length - 1], residual);
    // Repair #4 (undefined-value-ref stubs) lives in the loop's finalize
    // telemetry, not in GateRoundReport — tally it from there.
    const valueStubsIn = (key: string): number => {
      const info = loop.finalize[key] as { valueStubbed?: unknown[] } | undefined;
      return info?.valueStubbed?.length ?? 0;
    };
    if (valueStubsIn("r0") > 0) fires["finalize/undefined-value-ref"] = valueStubsIn("r0");
    if (valueStubsIn(`r${loop.rounds}`) > 0) residual["finalize/undefined-value-ref"] = valueStubsIn(`r${loop.rounds}`);

    // ── FAIL-CLOSED SSR RENDER GATE — the exact gate the parallel path runs
    // (run-preview-build ~:240). The quality loop's measure pass surfaces an
    // unrenderable scene as measure-error and re-casts it, but when the retry
    // budget is spent the loop ships "with residual findings (honest)" — and a
    // scene that THROWS at SSR is not a residual advisory, it is a white frame
    // in the preview and a dead /api/dev/export. The 01KY86J312SRPDXY6D58MSXJ81
    // build (s2.hero referencing an undefined `rows`) returned ok:true exactly
    // this way. A build with a scene that cannot render must never be ok:true. ──
    const renderCheck = await verifyScenesRender(genDir, composedScript.scenes.length, composedScript);
    timeline.mark(`cast:gate:ssr-render:${renderCheck.ok ? "passed" : "failed"}`);
    if (!renderCheck.ok) {
      console.error(
        "[preview/build:cast] SSR render gate failed:",
        JSON.stringify(renderCheck.errors),
      );
      fires["ssr-render/render-error"] = (fires["ssr-render/render-error"] ?? 0) + renderCheck.errors.length;
      residual["ssr-render/render-error"] = renderCheck.errors.length;
      // A failed attempt is not a free attempt — record the full spend, failed.
      await recordUsage({ op: "build", model, scriptId, url: brief?.brand_kit_url, usage: castUsage, failed: true });
      await recordMeteredUsage({
        ownerId,
        operation: "build",
        model,
        costUsd: costUsd(model, castUsage),
        inputTokens: castUsage.input_tokens,
        outputTokens: castUsage.output_tokens,
        failed: true,
      });
      if (visionRan && (visionUsage.input_tokens || visionUsage.output_tokens)) {
        await recordUsage({ op: "vision-qa", model: VISION_MODEL, scriptId, url: brief?.brand_kit_url, usage: visionUsage });
      }
      await recordGateTelemetry({
        scriptId,
        genDir,
        fires,
        residual,
        repairSteps: loop.rounds,
        firstPassClean: false,
        buildWallMs: Date.now() - buildT0,
      });
      try {
        await fs.writeFile(path.join(genDir, "build-timeline.json"), JSON.stringify(timeline.toJSON(), null, 2));
      } catch { /* attribution is never worth failing a build over */ }
      return {
        status: 500,
        body: {
          error: "one or more scenes failed to render",
          stage: "render",
          render_errors: renderCheck.errors,
        },
      };
    }

    await recordGateTelemetry({
      scriptId,
      genDir,
      fires,
      residual,
      repairSteps: loop.rounds,
      firstPassClean: loop.round0?.passed ?? false,
      buildWallMs: Date.now() - buildT0,
    });

    // ── build timeline (best-effort) ──
    try {
      await fs.writeFile(path.join(genDir, "build-timeline.json"), JSON.stringify(timeline.toJSON(), null, 2));
    } catch { /* attribution is never worth failing a build over */ }

    // ── LEGO engine: split into editable per-piece artifacts for the editor. ──
    try {
      const lego = await decomposeGenDir(genDir);
      console.log(`[preview/build:cast] lego decompose: ${lego.ok ? `${lego.pieces} pieces` : `skipped (${lego.reason})`}`);
      // Same re-persist as the main path — see the comment there.
      if (lego.ok) await persistGenDir(scriptId);
    } catch (err) {
      console.warn("[preview/build:cast] lego decompose skipped:", err);
    }

    return {
      status: 200,
      body: {
        ok: true,
        scriptId,
        mode: "cast",
        usage: castUsage,
        warnings,
        totalCostUsd: Number((costUsd(model, castUsage) + visionCostUsd).toFixed(6)),
        round0: loop.round0,
        rounds: loop.rounds + 1,
        gate_summary: {
          firstPassClean: loop.round0?.passed ?? false,
          fires,
          residual,
          noProgress: loop.events.noProgressEvents,
        },
      },
    };
  } catch (err) {
    console.error("[preview/build:cast] build threw:", err);
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err), stage: "cast" },
    };
  }
}
