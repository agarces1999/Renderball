/**
 * FRAME-AUTHORING isolation runner. Holds the SCRIPT constant (the 60-min GLM
 * reference build's own script.json) and runs the NEW frame-authoring head +
 * cast + the shared quality loop over it — so the ONLY variable vs the
 * reference frames is the composition/emission code this PR changed. Vision is
 * off (deterministic gates only); frames land in $OUT/frames/scene{0..4}.png.
 *
 *   set -a && source .env.local && set +a && node scripts/frameauth-render.mjs
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
import { castCall } from "../lib/llm/cast-provider";
import { resolveCornerBrandMark } from "../lib/agents/logo-inject";
import { measureScenes } from "../lib/render/measure-scene";
import {
  IMG_SHIM_SOURCE,
  PIECE_SHIM_SOURCE,
  VIDEO_SHIM_SOURCE,
  LOTTIE_SHIM_SOURCE,
  BRAND_CHROME_SOURCE,
} from "../lib/render/build-wrapper";
import {
  runQualityLoop,
  type LoopScript,
  type BrandTruthLite,
} from "../lib/render/quality-loop";
import type { Script, Scene } from "../src/schema";

const BRIEF_ID = process.env.RB_FA_BRIEF ?? "01KWTTE1XSW6BXXKSXPTBX9HDH";
const REF_SCRIPT = process.env.RB_FA_SCRIPT ?? "src/generated/01KWTTHKKECT0GGZ6D7HBQP1R5/script.json";
const OUT = process.env.RB_FA_OUT ?? path.join(process.cwd(), ".data", "dogfood", "frameauth-klarna");
const GEN_DIR = path.join(process.cwd(), "src", "generated", "FRAMEAUTH_KLARNA");
const CAST_MODEL = process.env.RB_CAST_MODEL ?? "accounts/fireworks/routers/glm-5p2-fast";

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

(async () => {
  await fs.mkdir(path.join(OUT, "frames"), { recursive: true });
  await fs.mkdir(GEN_DIR, { recursive: true });

  const brief = await withDbRetry(() => loadBrief(BRIEF_ID, DEV_OWNER_ID));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const be: any = (brief as any)?.brand_extract?.ok ? (brief as any).brand_extract : undefined;
  const brand = (be?.title as string | undefined)?.trim() || "Klarna";
  log(`brief ${BRIEF_ID} loaded — brand "${brand}"`);

  // The reference build's OWN script — strip any attached composition so the
  // NEW head re-authors the frame from scratch.
  const raw = JSON.parse(await fs.readFile(path.resolve(REF_SCRIPT), "utf8")) as Script;
  const script: Script = { ...raw, scenes: raw.scenes.map((s) => ({ ...s, composition: undefined })) };
  const aspect = (["16:9", "9:16", "1:1"].includes(script.config?.aspect_ratio ?? "")
    ? script.config!.aspect_ratio
    : "16:9") as "16:9" | "9:16" | "1:1";
  log(`reference script: ${script.scenes.length} scenes, aspect ${aspect}, scene-0 headline ${JSON.stringify(script.scenes[0]?.content?.headline)}`);

  const canvasPlan = resolveCanvasPlan(be);
  const signature =
    signatureWithLogoFallback(be?.palette ?? [], be?.theme_color, be?.logo_color) ??
    be?.theme_color ??
    (be?.palette ?? [])[0] ??
    "#666666";
  const derived = deriveCrawlTheme(be, canvasPlan.background, canvasPlan.mode, signature, be?.palette ?? []);
  const inkGuard = neutralizeInk(derived.theme);
  const theme = inkGuard.theme;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userLogo = (brief as any)?.brand_files?.find((f: { is_logo?: boolean }) => f.is_logo);
  // App-icon-only brands (Klarna: appIcon.png) → corner wordmark, not a blank
  // silhouetted square (resolveCornerBrandMark demotes apple_touch_icon/favicon).
  const { logoSrc } = resolveCornerBrandMark({ userLogoUrl: userLogo?.url, logoHd: be?.logo_hd, brandName: brand });

  let usage = { input: 0, output: 0 };
  const track = (r: { inputTokens: number; outputTokens: number }) => {
    usage = { input: usage.input + r.inputTokens, output: usage.output + r.outputTokens };
  };

  // ── HEAD (frame-authoring) ──
  log("composition head (frame-authoring) starting…");
  const headCaller: CompositionCaller = async (call) => {
    const r = await castCall({ system: call.system, user: call.user, maxTokens: call.maxTokens, model: CAST_MODEL, effort: call.effort === "none" ? "low" : call.effort });
    track(r);
    return { text: r.text };
  };
  const composed = await generateComposition({
    script,
    caller: headCaller,
    // R7 (audit-2): pass the RESOLVED canvas so the surface-contrast arm keys off
    // real luminance (the keyword fallback is deleted).
    validate: (scenes: Scene[]) => checkSceneComposition(scenes, { aspect, canvasBackground: canvasPlan.background }),
    aspect,
    brandName: brand,
    paletteHint: `canvas ${canvasPlan.background} (${canvasPlan.mode}), signature accent ${signature}, brand palette: ${(be?.palette ?? []).join(", ")}`,
    designNotes: `Design system consts downstream: PALETTE (CANVAS/INK/ACCENT/MUTED/SOFT_NEUTRAL/CARD_FILL/WHITE), shared keyframes (glowBreathe, drift1-3, drawWidth, fadeRise, scaleIn). Fonts: display ${theme.fonts.display}, body ${theme.fonts.body}.`,
  });
  const composedScript = { ...script, scenes: composed.scenes };
  const residual = checkSceneComposition(composed.scenes, { aspect, canvasBackground: canvasPlan.background });
  log(`head: ${composed.attempts} attempt(s), ${residual.length} residual validation error(s)`);
  await fs.writeFile(
    path.join(OUT, "composition.json"),
    JSON.stringify(composed.scenes.map((s, i) => ({ scene: i, composition: s.composition ?? null })), null, 2),
    "utf8",
  );

  const accentHexes = [
    ...new Set([derived.signatureAccent, theme.palette.ACCENT].filter((h): h is string => typeof h === "string" && /^#[0-9a-fA-F]{3,8}$/.test(h))),
  ];
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
      runPerSceneVision: undefined, // vision OFF — deterministic gates only
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

  // ── frames: RE-RENDER from the shipped finalCode so the deterministic
  //    excisions applied in the final round (motif clutter, stray fragments)
  //    show — the loop's finalMeasurements are captured BEFORE that round's
  //    excision, so they would eyeball as stale. ──
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
    path.join(OUT, "frameauth-summary.json"),
    JSON.stringify({ brand, aspect, headAttempts: composed.attempts, headResidual: residual, rounds: loop.rounds + 1, round0Clean: loop.round0?.passed ?? false, telemetry: loop.roundTelemetry[loop.roundTelemetry.length - 1] ?? null, usage, wallSeconds: (Date.now() - t0) / 1000 }, null, 2),
    "utf8",
  );
  log(`DONE — frames in ${path.join(OUT, "frames")}; tokens in/out ${usage.input}/${usage.output}`);
  process.exit(0);
})().catch((e) => { console.error("FRAMEAUTH RUNNER FAILED:", e); process.exit(1); });
