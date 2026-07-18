/**
 * FULL-PIPELINE runner — the REAL product path, script GENERATED (not held
 * constant). Loads the stored Klarna brief, builds the AgentBrief exactly as
 * app/new/actions.ts does for a moments/wizard brief, runs generateScript
 * (crawl-grounded), then the SAME frame-authoring head + cast + shared quality
 * loop the isolation runner uses. This is the test that closes the loop: does a
 * REAL generated script + the frame-authoring/hollow-hero/clutter fixes land
 * at/near the 60-min reference? Vision OFF (deterministic gates only).
 *
 *   set -a && source .env.local && set +a && node scripts/fullpipe-render.mjs
 */
import { promises as fs } from "fs";
import path from "path";
import { loadBrief, DEV_OWNER_ID } from "../lib/store";
import { withDbRetry } from "../lib/db";
import { resolveCanvasPlan, signatureWithLogoFallback } from "../lib/crawl/brand-identity";
import { deriveCrawlTheme } from "../lib/render/crawl-theme";
import { neutralizeInk } from "../lib/agents/cast-build";
import { generateComposition, type CompositionCaller } from "../lib/agents/composition-head";
import { checkSceneComposition } from "../lib/agents/schema-validator";
import { generateScript, claimGroundingSources, sceneClaimCopyByStrictness } from "../lib/agents/script-generator";
import { findUngroundedClaims } from "../lib/agents/schema-validator";
import { resolveCornerBrandMark } from "../lib/agents/logo-inject";
import { castCall } from "../lib/llm/cast-provider";
import { measureScenes } from "../lib/render/measure-scene";
import {
  IMG_SHIM_SOURCE,
  PIECE_SHIM_SOURCE,
  VIDEO_SHIM_SOURCE,
  LOTTIE_SHIM_SOURCE,
  BRAND_CHROME_SOURCE,
} from "../lib/render/build-wrapper";
import { runQualityLoop, type LoopScript, type BrandTruthLite } from "../lib/render/quality-loop";
import type { Script, Scene } from "../src/schema";

const BRIEF_ID = process.env.RB_FA_BRIEF ?? "01KWTTE1XSW6BXXKSXPTBX9HDH";
const OUT = process.env.RB_FP_OUT ?? path.join(process.cwd(), ".data", "dogfood", "fullpipe-klarna");
const GEN_DIR = path.join(process.cwd(), "src", "generated", "FULLPIPE_KLARNA");
const CAST_MODEL = process.env.RB_CAST_MODEL ?? "accounts/fireworks/routers/glm-5p2-fast";

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

(async () => {
  await fs.mkdir(path.join(OUT, "frames"), { recursive: true });
  await fs.mkdir(GEN_DIR, { recursive: true });

  const brief = await withDbRetry(() => loadBrief(BRIEF_ID, DEV_OWNER_ID));
  if (!brief) throw new Error("brief not found");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = brief;
  const be = b?.brand_extract?.ok ? b.brand_extract : undefined;
  const brand = (be?.title as string | undefined)?.trim() || "Klarna";
  log(`brief ${BRIEF_ID} loaded — brand "${brand}", freeform=${JSON.stringify(b.freeform_prompt)}, moments=${b.moments?.length ?? 0}`);

  // ── SCRIPT GENERATION (the product path — NOT held constant) ──
  const agentBrief = {
    duration_seconds: b.duration_seconds ?? 30,
    distribution_format: b.distribution_format ?? "landscape",
    moment_count: (b.moments?.length ?? 5) || 5,
    brand_kit_url: b.brand_kit_url,
    verified_claims: b.verified_claims,
    brand_extract: be,
    purpose: b.purpose,
    moments: b.moments,
    cta: b.cta,
  };
  log("generateScript starting (real product path)…");
  const gen = await generateScript(agentBrief, BRIEF_ID);
  if (!gen.ok) {
    log(`SCRIPT-GEN FAILED: ${gen.error}`);
    process.exit(2);
  }
  const src = claimGroundingSources(agentBrief);
  const split = sceneClaimCopyByStrictness(gen.script.scenes);
  const ung = [
    ...findUngroundedClaims(split.strict, src),
    ...findUngroundedClaims(split.caption, src, { exemptDiegeticPrices: true }),
  ];
  log(`script generated: ${gen.script.scenes.length} scenes; residual ungrounded (post-fix): ${JSON.stringify(ung)}`);
  log(`script stage tokens (Fireworks GLM-5.2): in=${gen.usage.input_tokens} out=${gen.usage.output_tokens}`);
  await fs.writeFile(path.join(OUT, "script.generated.json"), JSON.stringify(gen.script, null, 2), "utf8");
  for (const [i, sc] of gen.script.scenes.entries()) {
    const c = (sc.content ?? {}) as Record<string, unknown>;
    log(`  S${i} [${sc.register ?? "?"}] HL=${JSON.stringify(c.headline)}`);
  }

  const raw = gen.script as Script;
  const script: Script = { ...raw, scenes: raw.scenes.map((s) => ({ ...s, composition: undefined })) };
  const aspect = (["16:9", "9:16", "1:1"].includes(script.config?.aspect_ratio ?? "")
    ? script.config!.aspect_ratio
    : "16:9") as "16:9" | "9:16" | "1:1";

  const canvasPlan = resolveCanvasPlan(be);
  const signature =
    signatureWithLogoFallback(be?.palette ?? [], be?.theme_color, be?.logo_color) ??
    be?.theme_color ?? (be?.palette ?? [])[0] ?? "#666666";
  const derived = deriveCrawlTheme(be, canvasPlan.background, canvasPlan.mode, signature, be?.palette ?? []);
  const theme = neutralizeInk(derived.theme).theme;
  const userLogo = b?.brand_files?.find((f: { is_logo?: boolean }) => f.is_logo);
  const { logoSrc } = resolveCornerBrandMark({ userLogoUrl: userLogo?.url, logoHd: be?.logo_hd, brandName: brand });
  log(`corner logo resolved: ${logoSrc ? logoSrc : "(none → wordmark fallback)"}`);

  // Seed the token meter with the SCRIPT stage (now on Fireworks GLM-5.2 via
  // generateScript) so the summary's cost total is complete — script gen used to
  // be excluded, which undercounted spend by the whole first stage.
  const scriptUsage = { input: gen.usage.input_tokens, output: gen.usage.output_tokens };
  let usage = { input: scriptUsage.input, output: scriptUsage.output };
  const track = (r: { inputTokens: number; outputTokens: number }) => {
    usage = { input: usage.input + r.inputTokens, output: usage.output + r.outputTokens };
  };

  // ── HEAD (frame-authoring) ──
  log("composition head starting…");
  const headCaller: CompositionCaller = async (call) => {
    const r = await castCall({ system: call.system, user: call.user, maxTokens: call.maxTokens, model: CAST_MODEL, effort: call.effort === "none" ? "low" : call.effort });
    track(r);
    return { text: r.text };
  };
  const composed = await generateComposition({
    script,
    caller: headCaller,
    validate: (scenes: Scene[]) => checkSceneComposition(scenes, { aspect }),
    aspect,
    brandName: brand,
    paletteHint: `canvas ${canvasPlan.background} (${canvasPlan.mode}), signature accent ${signature}, brand palette: ${(be?.palette ?? []).join(", ")}`,
    designNotes: `Design system consts downstream: PALETTE (CANVAS/INK/ACCENT/MUTED/SOFT_NEUTRAL/CARD_FILL/WHITE), shared keyframes (glowBreathe, drift1-3, drawWidth, fadeRise, scaleIn). Fonts: display ${theme.fonts.display}, body ${theme.fonts.body}.`,
  });
  const composedScript = { ...script, scenes: composed.scenes };
  const residual = checkSceneComposition(composed.scenes, { aspect });
  log(`head: ${composed.attempts} attempt(s), ${residual.length} residual validation error(s)`);
  await fs.writeFile(path.join(OUT, "composition.json"), JSON.stringify(composed.scenes.map((s, i) => ({ scene: i, composition: s.composition ?? null })), null, 2), "utf8");

  const accentHexes = [...new Set([derived.signatureAccent, theme.palette.ACCENT].filter((h): h is string => typeof h === "string" && /^#[0-9a-fA-F]{3,8}$/.test(h)))];
  const brandTruth: BrandTruthLite = { name: brand, backgroundColor: canvasPlan.background, accent: signature, fonts: [be?.font_roles?.display, be?.font_roles?.body].filter((f: unknown): f is string => !!f) };

  // ── CAST + shared quality loop (vision OFF; deterministic gates on) ──
  log("cast + quality loop starting…");
  const loop = await runQualityLoop(
    {
      castInput: { script: composedScript as unknown as Script, theme, palette: derived.paletteHexes, signatureAccent: derived.signatureAccent, aspect },
      script: composedScript as unknown as LoopScript,
      genDir: GEN_DIR,
      brand,
      logoSrc,
      canvasBackground: canvasPlan.background,
      accentHexes,
      brandTruth,
      registers: composedScript.scenes.map((s: { register?: string }) => s.register),
      maxRetryRounds: 2,
      blockingKinds: ["overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness", "stranded-hero"],
      edgeClampMarginPx: 12,
      defaultCastModel: CAST_MODEL,
    },
    {
      transport: async (a) => {
        const r = await castCall({ system: a.system, user: a.user, maxTokens: a.maxTokens, model: a.model ?? CAST_MODEL, effort: a.effort, json: a.json });
        track(r);
        return r;
      },
      runPerSceneVision: undefined,
      ensureGenDir: async () => {
        await fs.mkdir(GEN_DIR, { recursive: true });
        await fs.writeFile(path.join(GEN_DIR, "Img.tsx"), IMG_SHIM_SOURCE, "utf8");
        await fs.writeFile(path.join(GEN_DIR, "Piece.tsx"), PIECE_SHIM_SOURCE, "utf8");
        await fs.writeFile(path.join(GEN_DIR, "Video.tsx"), VIDEO_SHIM_SOURCE, "utf8");
        await fs.writeFile(path.join(GEN_DIR, "Lottie.tsx"), LOTTIE_SHIM_SOURCE, "utf8");
        await fs.writeFile(path.join(GEN_DIR, "BrandChrome.tsx"), BRAND_CHROME_SOURCE, "utf8");
        await fs.writeFile(path.join(GEN_DIR, "script.json"), JSON.stringify(composedScript, null, 2), "utf8");
      },
      writeComposition: async (code) => { await fs.writeFile(path.join(GEN_DIR, "Composition.tsx"), code, "utf8"); },
      shouldStopForBudget: () => false,
      log: (m) => log(m),
      warn: (m) => log(`WARN ${m}`),
    },
  );
  log(`cast loop done — ${loop.rounds + 1} round(s), round0 ${loop.round0?.passed ? "CLEAN" : "failed"}, castError=${loop.castRoundError?.error ?? "none"}`);
  log(`motif-clutter events: ${JSON.stringify(loop.events.motifClutterEvents?.map((e) => `${e.pieceId}:${e.form}→${e.action}`) ?? [])}`);

  // Re-render frames from the shipped finalCode so deterministic excisions show.
  await fs.writeFile(path.join(GEN_DIR, "Composition.tsx"), loop.finalCode, "utf8");
  const outMeasure = path.join(OUT, "_measure");
  await fs.mkdir(outMeasure, { recursive: true });
  const frames = await measureScenes(GEN_DIR, composedScript, outMeasure);
  for (const m of frames) {
    if (m.screenshotPath) {
      await fs.copyFile(m.screenshotPath, path.join(OUT, "frames", `scene${m.scene}.png`));
      log(`scene ${m.scene}: rendered (${m.elements?.length ?? 0} measured elements)`);
    } else {
      log(`scene ${m.scene}: NO screenshot (${m.error ?? "unknown"})`);
    }
  }

  await fs.writeFile(
    path.join(OUT, "fullpipe-summary.json"),
    JSON.stringify({ brand, aspect, scriptScenes: gen.script.scenes.length, residualUngrounded: ung, headAttempts: composed.attempts, headResidual: residual, rounds: loop.rounds + 1, round0Clean: loop.round0?.passed ?? false, motifClutter: loop.events.motifClutterEvents ?? [], telemetry: loop.roundTelemetry[loop.roundTelemetry.length - 1] ?? null, usage, scriptUsage, wallSeconds: (Date.now() - t0) / 1000 }, null, 2),
    "utf8",
  );
  log(`DONE — frames in ${path.join(OUT, "frames")}; tokens in/out ${usage.input}/${usage.output}`);
  process.exit(0);
})().catch((e) => { console.error("FULLPIPE RUNNER FAILED:", e); process.exit(1); });
