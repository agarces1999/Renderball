/**
 * ACCEPTANCE V6 — the FULL comparable build on a NEW brand, entirely on the
 * v5 stack (GLM-5.2 @ Fireworks cast). Nothing reused from prior acceptance
 * runs: the script, the design system, and the blueprints are all GENERATED
 * this run. Two gate leaks measured in v5 are fixed in production code and
 * wired here as blocking:
 *
 *   LEAK 1 (fixed in lib/render/density-gates.ts): clause (a) passed a scene
 *     when ANY diegetic piece met the floor — v5's scene-2 hero shipped as a
 *     lone element in a void (s2.hero = 1el/0tx) while s2.throughline carried
 *     the scene. NEW clause (a2): any ".hero" piece must ITSELF meet the hero
 *     floor (≥15el/≥1tx, calibrated so the Duolingo reference hero 34el/2tx
 *     passes). Finding kind "thin-hero", routed to the NAMED hero.
 *   LEAK 2 (new lib/render/hero-contrast.ts): v5's scene-0 hero — a desk
 *     tableau painted pale-blue-on-pale-blue — passed vision's readability
 *     clause. Opinion failed, so v6 measures: luminance spread/std-dev of the
 *     hero's rendered region (floors 45/19, calibrated on the real v5 +
 *     reference PNGs). Finding kind "hero-washout", BLOCKING, routed to the
 *     named hero with the measured numbers.
 *
 * BRAND: Klarna — brief in the store (project 01KWTTE1XSW6BXXKSXPTBX9HDH,
 * brand_extract cached) + a GLM reference build on disk
 * (01KWTTHKKECT0GGZ6D7HBQP1R5, lego artifacts present, reassembles + SSRs
 * clean on all 5 scenes). Not HubSpot, not Duolingo.
 *
 * PIPELINE (every head phase GENERATED):
 *   1. SCRIPT     — GLM-5.2 @ Fireworks (accounts/fireworks/models/glm-5p2,
 *                   effort "high" → thinking budget 8192), production Agent-1
 *                   prompt + the FULL production validator chain (richness
 *                   bar: ungrounded claims, stage labels, type-only scenes,
 *                   duration/scene-count) in a ≤3-attempt repair loop quoting
 *                   errors VERBATIM. Reference-script fallback ONLY on
 *                   terminal failure, reported loudly.
 *   2. DESIGN SYS — one head call, same model/effort (full-spike's DS
 *                   pattern: contract parse + required-keyframe merge from
 *                   the reference block + ONE repair retry) → themeFromDs →
 *                   neutralizeInk (corrections reported).
 *   3. BLUEPRINTS — generateComposition (lib/agents/composition-head.ts) on
 *                   gpt-oss-120b @ Cerebras, effort high (the proven
 *                   blueprint author), validate=checkSceneComposition, ≤3
 *                   attempts, every error logged verbatim.
 *   4. CAST       — full GLM-5.2 @ Fireworks (RB_CAST_MODEL_HERO and
 *                   RB_CAST_MODEL_LEAVES both glm-5p2; cast-build's native
 *                   routing sends thinking-OFF per element), v5's caching +
 *                   feedback caller.
 *   5. GATES      — v5's loop (density BLOCKING incl. the NEW per-hero floor,
 *                   structural, render-truth production BLOCKING_KINDS,
 *                   per-scene vision) + the NEW hero-washout check as
 *                   BLOCKING (a washout routes a hero regen carrying the
 *                   finding text). Retries ≤2 rounds; sequence vision ONCE
 *                   after the final round.
 *
 * GALLERY (.data/acceptance6/index.html): v6 row vs the Klarna GLM reference
 * row (reference REASSEMBLED from lego and re-rendered through the same
 * measure path), per-scene density + hero-contrast stats on both rows, phase
 * timeline, gate log, script richness-loop log, blueprint attempt log, and
 * the cost split (Fireworks / Cerebras / z.ai vision).
 *
 * BUDGET: ≤80 TOTAL LLM calls (Fireworks + Cerebras + z.ai vision all count).
 * The guard aborts retries honestly; every exit path writes a partial report.
 *
 *   set -a && source .env.local && set +a && node scripts/acceptance6-spike.mjs
 *
 * Footprint: this file + scripts/acceptance6-spike.mjs + .data/acceptance6/ +
 * src/generated/CAST_SPIKE_A6_KLARNA. Reads everything, modifies nothing else.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { castBuild, neutralizeInk, type CastBuildResult } from "../lib/agents/cast-build";
import { castCall, castConfigured, type CastResult } from "../lib/llm/cast-provider";
import { generateComposition, type CompositionCaller } from "../lib/agents/composition-head";
import type { Theme } from "../lib/edit/piece-model";
import type { Script, Scene } from "../src/schema";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
import { injectLogoSrc } from "../lib/agents/logo-inject";
import { finalizeUndefinedRefs, assessInvalidLucideImports } from "../lib/agents/finalize-refs";
import type { Manifest } from "../lib/agents/lego-store";
import { readDecomposed } from "../lib/agents/lego-store";
import { reassemble } from "../lib/agents/lego-decompose";
import { measureScenes, type SceneMeasurement, type MeasuredElement } from "../lib/render/measure-scene";
import {
  findRenderTruthFailures,
  type RenderTruthFinding,
  type RenderTruthKind,
} from "../lib/render/render-truth-gates";
import {
  assessDensity,
  renderSectionsForAnalysis,
  parseHtmlStructure,
  pieceStats,
  maxDomDepth,
  gradientSignatures,
  imgSrcs,
  DIEGETIC_MIN_ELEMENTS,
  DIEGETIC_MIN_TEXT_NODES,
  HERO_MIN_ELEMENTS,
  HERO_MIN_TEXT_NODES,
  DEPTH_FLOOR,
  MIN_GRADIENT_SIGNATURES,
  MAX_SCENES_PER_SIGNATURE,
  IMG_SRC_WHITELIST,
  type DensityFinding,
  type HtmlNode,
} from "../lib/render/density-gates";
import {
  assessHeroWashout,
  heroRegionsFromMeasurement,
  luminanceStatsForRegions,
  WASHOUT_SPREAD_FLOOR,
  WASHOUT_STDDEV_FLOOR,
  type HeroContrastResult,
  type HeroLuminanceStats,
  type HeroWashoutFinding,
} from "../lib/render/hero-contrast";
import {
  buildRubric,
  parseVerdict,
  isSanctionedChromeFinding,
  judgeSequence,
  type SequenceJudge,
  type VisionFinding,
} from "../lib/render/vision-gate";
import { callZaiVision } from "../lib/render/zai-vision";
import { VISION_MODEL } from "../lib/anthropic";
import { costUsd, addUsage, EMPTY_USAGE, type Usage } from "../lib/usage";
import { resolveCanvasPlan, signatureWithLogoFallback } from "../lib/crawl/brand-identity";
import { SCRIPT_GENERATOR_SYSTEM_PROMPT } from "../lib/agents/prompts/script-generator";
import {
  buildUserMessage,
  claimGroundingSources,
  sceneClaimCopy,
  type AgentBrief,
  type AgentBrandExtract,
  type PreallocatedAsset,
} from "../lib/agents/script-generator";
import {
  validateScript,
  normalizeScriptContent,
  backfillSceneRegisters,
  findUngroundedClaims,
  findUngroundedStageLabels,
  findTypeOnlyScenes,
  checkSceneComposition,
} from "../lib/agents/schema-validator";
import {
  findOverflowingElements,
  findDuplicateLogos,
  hasCornerLogoSuppression,
  findUndefinedJsxComponents,
  findUnboundCopy,
  findPlaceholderData,
  findProvidedComponentRedefinitions,
  type AspectRatio,
} from "../lib/agents/quality-gates";
import { sectionRanges } from "../lib/agents/section-splice";
import { loadBriefByScriptId, DEV_OWNER_ID, type StoredBrief } from "../lib/store";
import { withDbRetry } from "../lib/db";
import { ulid } from "../lib/ulid";

// ── constants ────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const BRAND = "Klarna";
const REF_BUILD = "01KWTTHKKECT0GGZ6D7HBQP1R5"; // the Klarna GLM reference
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "acceptance6");
const GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_A6_KLARNA");
const SCENES = [0, 1, 2, 3, 4];
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

/** The v5 cast stack: GLM-5.2 served by Fireworks. effort "high" maps to
 *  thinking {enabled, budget_tokens: 8192} on this wire (cast-provider). */
const FIREWORKS_GLM = "accounts/fireworks/models/glm-5p2";
/** The proven blueprint author (acceptance v2): gpt-oss-120b @ Cerebras. */
const BLUEPRINT_MODEL = "gpt-oss-120b";
const HEAD_EFFORT = "high" as const;
const SCRIPT_MAX_TOKENS = 16000; // production Agent-1 cap
const DS_MAX_TOKENS = 10000;
const SCRIPT_MAX_ATTEMPTS = 3;

/** ≤80 TOTAL LLM calls — text (Fireworks + Cerebras) AND vision all count. */
const TOTAL_LLM_CEILING = 80;
const MAX_RETRY_ROUNDS = 2;

/** $/M tokens for per-call cost accounting (v5's table). */
const MODEL_PRICES: Record<string, [number, number]> = {
  "accounts/fireworks/models/glm-5p2": [1.4, 4.4],
  "gpt-oss-120b": [0.35, 0.75],
};

// The production blocking set — verbatim from run-preview-build.ts (as v5).
const BLOCKING_KINDS: RenderTruthKind[] = [
  "overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness", "stranded-hero",
];
// The pipeline's vision action threshold — SEVERE_RX verbatim (as v5).
const SEVERE_RX =
  /unreadable|clipped|cut ?off|overlap|invisible|missing|broken|empty|flat|illegible|placeholder|masked|blank|loading|frozen|nav bar|pagination/i;

// ── timeline instrumentation ─────────────────────────────────────────────────

const T0 = Date.now();
const nowS = (): number => Math.round(((Date.now() - T0) / 1000) * 10) / 10;
interface PhaseMark { phase: string; startS: number; endS: number; note?: string }
const marks: PhaseMark[] = [];
const phase = async <T>(name: string, fn: () => Promise<T>, note?: string): Promise<T> => {
  const startS = nowS();
  console.log(`\n▶ ${name} (t=${startS}s)`);
  try {
    return await fn();
  } finally {
    marks.push({ phase: name, startS, endS: nowS(), ...(note ? { note } : {}) });
  }
};

// ── budgeted transport: ONE ceiling over Fireworks + Cerebras + vision ───────

class BudgetExceeded extends Error {}
interface CallLogRow {
  label: string; model: string; secs: number; in: number; out: number; stop: string | null; cached: boolean;
}
const callLog: CallLogRow[] = [];
let totalLlmCalls = 0; // text + vision — the 80-call ceiling
let budgetExhausted = false;
const perModel: Record<string, { calls: number; in: number; out: number }> = {};

const ensureBudget = (at: string): void => {
  if (totalLlmCalls >= TOTAL_LLM_CEILING) {
    budgetExhausted = true;
    throw new BudgetExceeded(`TOTAL LLM ceiling (${TOTAL_LLM_CEILING}) reached at "${at}" — aborted honestly`);
  }
};

const budgetedCast = async (
  label: string,
  args: { system: string; user: string; maxTokens: number; model: string; effort?: "none" | "low" | "medium" | "high" },
): Promise<CastResult> => {
  ensureBudget(label);
  totalLlmCalls += 1;
  const r = await castCall(args);
  const pm = (perModel[args.model] ??= { calls: 0, in: 0, out: 0 });
  pm.calls += 1;
  pm.in += r.inputTokens;
  pm.out += r.outputTokens;
  callLog.push({ label, model: args.model, secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, cached: false });
  return r;
};

// z.ai vision spend — counts against the SAME total-call ceiling.
let zaiUsage: Usage = { ...EMPTY_USAGE };
let zaiCalls = 0;
/** True when a vision call may fire; false = budget spent (skip honestly). */
const visionBudgetOk = (): boolean => totalLlmCalls < TOTAL_LLM_CEILING;
const countVisionCall = (): void => {
  totalLlmCalls += 1;
  zaiCalls += 1;
};

// ── caching + feedback caller for castBuild (v5's retry machinery) ──────────

const pieceCache = new Map<string, string>(); // pieceId → last raw emission (stripped)
let pieceTargets = new Map<string, string[]>(); // pieceId → gate feedback lines
let castRoundLabel = "cast-r0";

const cachingCaller: typeof castCall = async (call) => {
  const pieceId = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
  const feedback = pieceTargets.get(pieceId);
  const cached = pieceCache.get(pieceId);
  if (!feedback && cached !== undefined) {
    callLog.push({ label: `${castRoundLabel}:${pieceId}`, model: "(cache)", secs: 0, in: 0, out: 0, stop: "cached-replay", cached: true });
    return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "cached-replay" };
  }
  const user = feedback
    ? [
        call.user,
        ``,
        `════ YOUR PREVIOUS VERSION FAILED PRODUCTION QA ════`,
        `The production gates measured your previous version of THIS element on the rendered 1920x1080 frame and found these defects. Rebuild the element fixing EVERY finding while honoring the brief above:`,
        ...feedback.map((f) => `- ${f}`),
        ``,
        `--- YOUR PREVIOUS VERSION ---`,
        (cached ?? "(none survived)").slice(0, 6000),
        ``,
        `Emit ONLY the corrected JSX for this element.`,
      ].join("\n")
    : call.user;
  try {
    // cast-build's native routing decided model + effort — forward verbatim
    // (RB_CAST_MODEL_HERO/LEAVES are both glm-5p2 this run).
    const res = await budgetedCast(`${castRoundLabel}:${pieceId}${feedback ? ":regen" : ""}`, {
      system: call.system,
      user,
      maxTokens: call.maxTokens,
      model: call.model ?? FIREWORKS_GLM,
      ...(call.effort ? { effort: call.effort } : {}),
    });
    if (res.text && res.text.trim().length >= 8) pieceCache.set(pieceId, stripCodeFence(res.text));
    return res;
  } catch (e) {
    // A targeted regen whose call failed (budget/transport) falls back to the
    // previous body instead of downgrading a shipped piece to a placeholder.
    if (feedback && cached !== undefined) {
      callLog.push({ label: `${castRoundLabel}:${pieceId}:regen-failed-kept-previous`, model: "(cache)", secs: 0, in: 0, out: 0, stop: "regen-failed", cached: true });
      console.warn(`  [retry] ${pieceId}: regen call failed (${e instanceof Error ? e.message.split("\n")[0] : e}) — previous body kept`);
      return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "regen-failed-replayed-previous" };
    }
    throw e;
  }
};

// ── small utilities (v5's, verbatim) ─────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Balanced scanner for a top-level `const NAME = …;` declaration. */
const findConstDecl = (src: string, name: string): { start: number; end: number } | null => {
  const m = new RegExp(`^(?:export )?const ${name}\\b`, "m").exec(src);
  if (!m) return null;
  let depth = 0;
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  const tplStack: number[] = [];
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "line") { if (c === "\n") state = "code"; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = "code"; i++; } continue; }
    if (state === "sq") { if (c === "\\") i++; else if (c === "'") state = "code"; continue; }
    if (state === "dq") { if (c === "\\") i++; else if (c === '"') state = "code"; continue; }
    if (state === "tpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { state = "code"; continue; }
      if (c === "$" && n === "{") { tplStack.push(depth); depth++; state = "code"; i++; continue; }
      continue;
    }
    if (c === "/" && n === "/") { state = "line"; i++; continue; }
    if (c === "/" && n === "*") { state = "block"; i++; continue; }
    if (c === "'") { state = "sq"; continue; }
    if (c === '"') { state = "dq"; continue; }
    if (c === "`") { state = "tpl"; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (tplStack.length > 0 && depth === tplStack[tplStack.length - 1]) { tplStack.pop(); state = "tpl"; }
      continue;
    }
    if (c === ";" && depth === 0) return { start: m.index, end: i + 1 };
  }
  return null;
};

/** `const NAME = \`…\`;` → the runtime string. */
const extractTemplateConst = (src: string, name: string): string | null => {
  const marker = `const ${name} = \``;
  const at = src.indexOf(marker);
  if (at === -1) return null;
  let i = at + marker.length;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { out += ch + (src[i + 1] ?? ""); i += 2; continue; }
    if (ch === "`") return out.replace(/\\([`$\\])/g, "$1");
    out += ch;
    i++;
  }
  return null;
};

const extractStringConst = (src: string, name: string): string | null => {
  const m2 = new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`).exec(src);
  if (m2) return m2[1];
  const m3 = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"`).exec(src);
  return m3 ? m3[1] : null;
};

/** PALETTE.cardFill → CARD_FILL — the assemble bare-const spelling. */
const camelToConst = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/** One `@keyframes name { … }` block (balanced braces) from a CSS string. */
const cssKeyframeBlock = (css: string, name: string): string | null => {
  const m = new RegExp(`@keyframes\\s+${name}\\b`).exec(css);
  if (!m) return null;
  const open = css.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(m.index, i + 1);
    }
  }
  return null;
};

// ── loose script shape ───────────────────────────────────────────────────────

interface ScriptScene {
  index?: number;
  label: string;
  register?: string;
  description?: string;
  visual_concept?: string;
  start_seconds?: number;
  end_seconds?: number;
  content: Record<string, unknown>;
  composition?: unknown;
}
interface LooseScript {
  scenes: ScriptScene[];
  narrative?: { throughline?: string; arc?: string; logline?: string };
  config?: { aspect_ratio?: string; duration_seconds?: number };
  brief?: { about?: string; purpose?: string; cta?: string };
  assets?: unknown;
}

// ── SCRIPT phase helpers (full-spike's production replicas) ──────────────────

// Replicates script-generator.ts's private injectIdentity (module-private
// there, so copied — same as full-spike).
const injectIdentity = (parsed: unknown, brief: AgentBrief, briefId: string): unknown => {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const p = parsed as Record<string, unknown>;
  const agentBrief = typeof p.brief === "object" && p.brief !== null ? (p.brief as Record<string, unknown>) : {};
  return {
    ...p,
    id: ulid(),
    customer_id: "local-dev",
    brand_kit_id: brief.brand_kit_url ? `bk_${briefId}` : null,
    created_at: new Date().toISOString(),
    schema_version: "1.0",
    brief: {
      purpose: brief.purpose ?? (agentBrief.purpose as string | undefined) ?? "",
      about: brief.freeform_prompt ?? "",
      cta: brief.cta ?? (agentBrief.cta as string | undefined) ?? "",
    },
    status: "draft",
  };
};

// Replicates script-generator.ts's private mergePreallocatedAssets.
const mergePreallocatedAssets = (script: unknown, brief: AgentBrief): unknown => {
  if (typeof script !== "object" || script === null) return script;
  if (!brief.preallocated_assets || brief.preallocated_assets.length === 0) return script;
  const s = script as Record<string, unknown>;
  const assets = (s.assets as Record<string, unknown> | undefined) ?? {};
  const existing = Array.isArray(assets.images) ? (assets.images as Array<Record<string, unknown>>) : [];
  const ids = new Set(existing.map((a) => a.id as string).filter(Boolean));
  const merged = [...existing];
  for (const a of brief.preallocated_assets) {
    if (ids.has(a.id)) continue;
    merged.push({
      id: a.id, src: a.url, width: 0, height: 0,
      format: a.mime.includes("svg") ? "svg" : a.mime.includes("jpeg") || a.mime.includes("jpg") ? "jpg" : a.mime.includes("webp") ? "webp" : "png",
      license_id: "lic_user_provided", alt_text: a.label,
    });
  }
  return { ...s, assets: { ...(typeof assets === "object" && assets !== null ? assets : {}), images: merged } };
};

// Crawl-only preallocated assets — replicates app/api/dev/generate/route.ts.
const buildPreallocatedFromCrawl = (be: AgentBrandExtract | undefined): PreallocatedAsset[] => {
  const out: PreallocatedAsset[] = [];
  if (!be?.ok) return out;
  if (be.logo_hd) {
    out.push({ id: "site_logo", url: be.logo_hd, mime: be.logo_hd.endsWith(".svg") ? "image/svg+xml" : "image/png", source: "crawl", label: "site logo (HD — preferred over favicon for opening/closing)" });
  } else if (be.apple_touch_icon) {
    out.push({ id: "site_logo", url: be.apple_touch_icon, mime: "image/png", source: "crawl", label: "site apple-touch-icon (medium-res brand mark)" });
  } else if (be.favicon) {
    out.push({ id: "site_logo", url: be.favicon, mime: "image/x-icon", source: "crawl", label: "site favicon (low-res; only logo available)" });
  }
  if (be.og_image) out.push({ id: "site_og_image", url: be.og_image, mime: "image/png", source: "crawl", label: "site OG image (hero / share image)" });
  (be.page_images ?? []).slice(0, 6).forEach((img, i) => {
    const ext = img.src.match(/\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i)?.[1]?.toLowerCase() ?? "";
    const mime =
      ext === "svg" ? "image/svg+xml"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : ext === "avif" ? "image/avif"
      : "image/png";
    out.push({ id: `site_img_${i}`, url: img.src, mime, source: "crawl", label: img.alt ? `site image: ${img.alt}` : `site image #${i + 1}` });
  });
  return out;
};

/** The full production post-parse chain + richness guards. Returns the
 *  validated script or the exact failure text (fed back VERBATIM on repair). */
const processScriptAttempt = (
  raw: string,
  brief: AgentBrief,
  briefId: string,
): { ok: true; script: LooseScript } | { ok: false; error: string } => {
  const cleaned = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `Output was not valid JSON (${err instanceof Error ? err.message : String(err)}). Emit ONLY the Script JSON object. No prose, no markdown fence.` };
  }
  const withIdentity = injectIdentity(parsed, brief, briefId);
  const withAssets = mergePreallocatedAssets(withIdentity, brief);
  const normalized = backfillSceneRegisters(normalizeScriptContent(withAssets));
  const validation = validateScript(normalized);
  if (!validation.ok) return { ok: false, error: validation.error };
  const script = validation.script as unknown as LooseScript;

  // Duration guard (production): the requested duration is authoritative.
  const wantSec = brief.duration_seconds;
  const gotSec = script.config?.duration_seconds ?? 0;
  if (typeof wantSec === "number" && wantSec > 0 && Math.abs(gotSec - wantSec) > 0.5) {
    return { ok: false, error: `config.duration_seconds is ${gotSec}s but the brief requires EXACTLY ${wantSec}s. Set config.duration_seconds = ${wantSec} and re-tile ALL scenes to fill 0→${wantSec} with no gaps.` };
  }
  // Scene-count contract for the Section0..4 composition tail.
  if (script.scenes.length !== 5) {
    return { ok: false, error: `Script has ${script.scenes.length} scenes but the brief requires EXACTLY 5 sections (one per moment).` };
  }
  // Invented-claim + stage-label guards (production, QA S5/G5).
  const sourceText = claimGroundingSources(brief);
  const copy = sceneClaimCopy(script.scenes as never);
  const ungrounded = findUngroundedClaims(copy, sourceText);
  const stages = findUngroundedStageLabels(copy, sourceText);
  if (ungrounded.length > 0 || stages.length > 0) {
    const parts: string[] = [];
    if (ungrounded.length > 0)
      parts.push(`These numeric claims are NOT grounded in any allowed source (the user's brief, verified claims, or the crawled site content): ${ungrounded.join(", ")}. For EACH exact token, either replace it with qualitative copy or with a fact that appears VERBATIM in the crawled content — never invent stats.`);
    if (stages.length > 0)
      parts.push(`These funding-stage labels aren't stated anywhere in the brief or crawled content: ${stages.join(", ")}. Drop the invented label.`);
    return { ok: false, error: parts.join("\n") };
  }
  // Visual-richness guard (production): no type-only scenes.
  const typeOnly = findTypeOnlyScenes(script.scenes as { visual_concept?: string }[]);
  if (typeOnly.length > 0) {
    return { ok: false, error: `Type-only scenes (visual_concept is just a headline plus ambient decoration, nothing to look at): ${typeOnly.map((i) => `scene ${i}`).join(", ")}. EVERY scene must specify a concrete non-text/diegetic visual (a product mock, dashboard, diagram, chart, annotated illustration).` };
  }
  return { ok: true, script };
};

// ── DESIGN SYSTEM phase (acceptance2's contract + full-spike's kf merge) ─────

const DS_DECLS = ["PALETTE", "SHARED_KEYFRAMES", "THROUGHLINE_TABS", "ThroughlineMotif"] as const;
const REQUIRED_KEYFRAMES = ["glowBreathe", "drift1", "drift2", "drift3", "drawWidth", "fadeRise", "scaleIn"];

const dsSystemPrompt = `You are the creative director designing the SHARED DESIGN SYSTEM for one 30-second animated brand video (1920x1080, 5 scenes). Downstream, element-builder calls will reference your consts EXACTLY as you define them — this is the video's entire visual grammar, so make it rich, coherent, and unmistakably on-brand.

OUTPUT CONTRACT — emit ONLY a TSX block containing EXACTLY these four top-level declarations, in this order, nothing before/between/after (no imports, no prose, no markdown fences):

1. \`const PALETTE = { canvas: "#……", ink: "#……", accent: "#……", muted: "#……", softNeutral: "#……", cardFill: "#……", white: "#ffffff" } as const;\`
   — EXACTLY those seven keys. Every value is a 6-digit hex grounded in the brand truth you are given (canvas MUST be the stated brand canvas; accent MUST be the stated signature color). Never invent off-brand hues.
2. \`const SHARED_KEYFRAMES = \\\`…\\\`;\` — a CSS template literal defining ALL shared @keyframes: (a) the throughline-motif keyframes your component below uses; (b) entry keyframes (≤1s class); (c) 6-10 sustained/infinite loops for atmosphere and diegetic life; (d) include definitions named exactly: glowBreathe, drift1, drift2, drift3, drawWidth, fadeRise, scaleIn (the shared vocabulary downstream elements animate with). Plain CSS only — NO \${…} interpolations.
3. \`const THROUGHLINE_TABS = [ … ];\` — 5-7 data objects driving the motif's scattered phase: { label: string, angle: number, dx: number, dy: number, color: "#……", dur: number, delay: number }. Labels/geometry must fit YOUR motif concept; colors from PALETTE's hexes.
4. \`const ThroughlineMotif: React.FC<{ phase: "chaos" | "converge" | "unified" }> = ({ phase }) => { … };\` — the ONE recurring visual motif, built from the narrative throughline you are given. HARD RULES: root element is \`<div data-throughline="<short-slug>" style={{ position: "absolute", left: 1360, top: 540, width: 0, height: 0, pointerEvents: "none", zIndex: 6 }}>\`; three visually distinct phases (chaos = scattered/drifting, converge = pulling inward, unified = locked/resolved); CSS animation only using names from YOUR SHARED_KEYFRAMES; reference PALETTE.* / FONT_DISPLAY / FONT_BODY / FONT_MONO (already in scope) — never invent colors or fonts; no hooks, no Math.random, no Date.now; valid TSX.

The following are ALREADY DEFINED and in scope — do NOT redefine them: React, FONT_DISPLAY, FONT_BODY, FONT_MONO, LOGO_SRC, Img, Piece, BrandChrome.`;

const dsUserPrompt = (
  script: LooseScript,
  be: AgentBrandExtract | undefined,
  fonts: { display: string; body: string },
  signature: string,
): string => {
  const canvas = resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]);
  return [
    `Design the shared design system for this video.`,
    ``,
    `BRAND TRUTH (crawled from ${be?.url ?? "the brand site"} — authoritative):`,
    `- Brand: ${be?.title ?? BRAND}`,
    `- Canvas/background (ENFORCED): ${canvas.background} (a ${canvas.mode} canvas — PALETTE.canvas MUST be this hex)`,
    `- SIGNATURE accent (PALETTE.accent MUST be this hex): ${signature}`,
    `- Full brand palette: ${(be?.palette ?? []).join(", ")}`,
    `- Fonts (locked, already defined — design WITH them, do not redefine): display ${JSON.stringify(fonts.display)}, body ${JSON.stringify(fonts.body)}`,
    `- Motion signal: ${be?.motion_signal ?? "medium"}`,
    ``,
    `THE SCRIPT you are designing for:`,
    `- Logline: ${script.narrative?.logline ?? ""}`,
    `- Arc: ${script.narrative?.arc ?? ""}`,
    `- THROUGHLINE (your ThroughlineMotif embodies THIS): ${script.narrative?.throughline ?? ""}`,
    `- Scenes:`,
    ...script.scenes.map(
      (s, i) => `    ${i}. "${s.label}" (register ${s.register ?? "n/a"}) — ${String(s.visual_concept ?? "").slice(0, 220)}`,
    ),
    ``,
    `Emit ONLY the four declarations per the output contract.`,
  ].join("\n");
};

interface DsParse {
  ok: boolean;
  error?: string;
  decls?: Record<(typeof DS_DECLS)[number], string>;
  requiredKeyframesInjected?: string[];
}

/** Parse the DS emission, enforce the contract, merge any missing required
 *  keyframes deterministically from the reference block (full-spike). */
const parseDsEmission = (raw: string, refKeyframesCss: string): DsParse => {
  const text = stripCodeFence(raw.trim());
  const decls = {} as Record<(typeof DS_DECLS)[number], string>;
  for (const name of DS_DECLS) {
    const loc = findConstDecl(text, name);
    if (!loc) return { ok: false, error: `missing top-level declaration \`const ${name}\` — the output must contain exactly the four contract declarations` };
    decls[name] = text.slice(loc.start, loc.end).replace(/^export /, "");
  }
  for (const key of ["canvas", "ink", "accent", "muted", "softNeutral", "cardFill", "white"]) {
    if (!new RegExp(`\\b${key}\\s*:`).test(decls.PALETTE)) {
      return { ok: false, error: `PALETTE is missing the required key "${key}" — it must have exactly the seven contract keys` };
    }
  }
  if (!/data-throughline=/.test(decls.ThroughlineMotif)) {
    return { ok: false, error: `ThroughlineMotif's root element must carry data-throughline="<slug>"` };
  }
  const kf = extractTemplateConst(decls.SHARED_KEYFRAMES, "SHARED_KEYFRAMES");
  if (kf === null) return { ok: false, error: `SHARED_KEYFRAMES must be a template-literal CSS string: const SHARED_KEYFRAMES = \`…\`;` };
  if (/\$\{/.test(kf)) return { ok: false, error: `SHARED_KEYFRAMES contains a \${…} interpolation — it must be PLAIN CSS only` };
  const injected: string[] = [];
  let kfDecl = decls.SHARED_KEYFRAMES;
  const lastTick = kfDecl.lastIndexOf("`");
  for (const name of REQUIRED_KEYFRAMES) {
    if (new RegExp(`@keyframes\\s+${name}\\b`).test(kfDecl)) continue;
    const block = cssKeyframeBlock(refKeyframesCss, name);
    if (block && lastTick !== -1) {
      kfDecl = kfDecl.slice(0, lastTick) + `\n  ${block}\n` + kfDecl.slice(lastTick);
      injected.push(name);
    }
  }
  decls.SHARED_KEYFRAMES = kfDecl;
  return { ok: true, decls, requiredKeyframesInjected: injected };
};

// ── Theme derivation (acceptance2's, verbatim) ───────────────────────────────

interface DerivedTheme {
  theme: Theme;
  paletteHexes: string[];
  signatureAccent: string | undefined;
  logoSrc: string | undefined;
  mappingNotes: string[];
}

const grammarDefaults = (): Theme["grammar"] => ({
  radiusScale: [6, 12, 20],
  strokeWeight: 1,
  hairline: "SOFT_NEUTRAL",
  panelBg: "CARD_FILL",
  shadowRecipe: "0 24px 60px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06)",
  dataFont: "mono",
});

const fontsFromReference = (refPreamble: string): Theme["fonts"] => {
  const display = extractStringConst(refPreamble, "FONT_DISPLAY");
  const body = extractStringConst(refPreamble, "FONT_BODY");
  const mono = extractStringConst(refPreamble, "FONT_MONO");
  const fontFaceCss = extractTemplateConst(refPreamble, "BRAND_FONTS_CSS") ?? "";
  if (!display || !body || !mono) throw new Error("reference preamble is missing FONT_DISPLAY/FONT_BODY/FONT_MONO");
  return { display, body, mono, fontFaceCss };
};

const themeFromDs = (
  decls: Record<(typeof DS_DECLS)[number], string>,
  refPreamble: string,
  brandPalette: string[],
): DerivedTheme => {
  const notes: string[] = [];
  const palette: Record<string, string> = {};
  const byOriginalKey: Record<string, string> = {};
  for (const m of decls.PALETTE.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g)) {
    palette[camelToConst(m[1])] = m[2];
    byOriginalKey[m[1]] = m[2];
  }
  if (Object.keys(palette).length === 0) throw new Error("themeFromDs: PALETTE parsed to zero entries");
  notes.push(
    `palette: head-emitted PALETTE keys re-spelled camelCase→CONST_CASE (${Object.keys(byOriginalKey).map((k) => `${k}→${camelToConst(k)}`).join(", ")}) — the cast/assemble contract emits BARE consts; hex values carried verbatim.`,
  );
  const keyframes = extractTemplateConst(decls.SHARED_KEYFRAMES, "SHARED_KEYFRAMES") ?? "";
  notes.push("keyframes: head-emitted SHARED_KEYFRAMES carried verbatim (+ any required keyframes merged from the reference block).");
  const fonts = fontsFromReference(refPreamble);
  notes.push("fonts: FONT_DISPLAY/FONT_BODY/FONT_MONO + BRAND_FONTS_CSS carried VERBATIM from the reference preamble (locked brand identity).");
  const grammar = grammarDefaults();
  notes.push("grammar (DERIVED — the DS contract has no grammar decls): hairline=SOFT_NEUTRAL, panelBg=CARD_FILL, radiusScale=[6,12,20], 1px strokes, neutral shadow, dataFont=mono.");
  for (const need of ["CANVAS", "INK", "ACCENT", grammar.hairline, grammar.panelBg]) {
    if (!(need in palette)) throw new Error(`themeFromDs: expected palette const ${need} missing`);
  }
  const dsHexes = Object.values(byOriginalKey).filter((v) => /^#[0-9a-fA-F]{3,8}$/.test(v));
  const paletteHexes = [...new Set([...dsHexes, ...brandPalette])];
  notes.push(`hue-lock vocabulary: union of DS PALETTE hexes + crawled brand palette (${paletteHexes.length} hexes).`);
  const logoSrc = extractStringConst(refPreamble, "LOGO_SRC") ?? undefined;
  return {
    theme: { palette, fonts, keyframes, grammar },
    paletteHexes,
    signatureAccent: byOriginalKey["accent"],
    logoSrc,
    mappingNotes: notes,
  };
};

const FALLBACK_KEYFRAMES = `
@keyframes fadeRise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
@keyframes drawWidth { from { width: 0; } }
@keyframes glowBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes drift1 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(14px, -10px); } }
@keyframes drift2 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-12px, 8px); } }
@keyframes drift3 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(8px, 12px); } }
`;

const fallbackThemeFromReference = (
  refPreamble: string,
  canvasBg: string,
  signature: string,
  brandPalette: string[],
): DerivedTheme => {
  const byKey: Record<string, string> = {};
  const palStart = refPreamble.indexOf("const PALETTE");
  if (palStart !== -1) {
    const palEnd = refPreamble.indexOf("}", palStart);
    const block = refPreamble.slice(palStart, palEnd === -1 ? palStart + 2000 : palEnd);
    for (const m of block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g)) byKey[m[1]] = m[2];
  }
  const palette: Record<string, string> = {
    CANVAS: canvasBg,
    INK: byKey.ink ?? "rgba(0,0,0,0.88)",
    ACCENT: signature,
    MUTED: byKey.muted ?? "rgba(0,0,0,0.5)",
    SOFT_NEUTRAL: byKey.hairline ?? "rgba(0,0,0,0.1)",
    CARD_FILL: byKey.surface ?? "#f7f8fa",
    WHITE: "#ffffff",
  };
  return {
    theme: { palette, fonts: fontsFromReference(refPreamble), keyframes: FALLBACK_KEYFRAMES, grammar: grammarDefaults() },
    paletteHexes: [...new Set([...Object.values(palette).filter((v) => /^#/.test(v)), ...brandPalette])],
    signatureAccent: signature,
    logoSrc: extractStringConst(refPreamble, "LOGO_SRC") ?? undefined,
    mappingNotes: ["FALLBACK theme: contract consts synthesized from the reference build's PALETTE + canvas plan + signature; neutral deterministic keyframes. The head's DS did not ship."],
  };
};

// ── density profile (v5's — the comparison table's numbers) ──────────────────

interface SceneDensityProfile {
  scene: number;
  ssrError?: string;
  bestDiegetic: { id: string; elements: number; textNodes: number } | null;
  diegeticPass: boolean;
  hero: { id: string; elements: number; textNodes: number } | null;
  heroPass: boolean;
  depth: number;
  depthPass: boolean;
  gradientSignatures: string[];
  badImgSrcs: string[];
}
interface DensityProfile {
  scenes: SceneDensityProfile[];
  distinctSignatures: number;
  repeated: { signature: string; scenes: number[] }[];
  varietyPass: boolean;
}

const buildDensityProfile = (code: string, script: unknown): DensityProfile => {
  const renders = renderSectionsForAnalysis(code, script);
  const scenes: SceneDensityProfile[] = [];
  const bySig = new Map<string, number[]>();
  for (const r of renders) {
    if (r.html == null) {
      scenes.push({ scene: r.scene, ssrError: r.error, bestDiegetic: null, diegeticPass: false, hero: null, heroPass: false, depth: 0, depthPass: false, gradientSignatures: [], badImgSrcs: [] });
      continue;
    }
    const roots: (HtmlNode | string)[] = parseHtmlStructure(r.html);
    const pieces = pieceStats(roots);
    const diegetics = pieces.filter((p) => p.kind === "diegetic");
    const best = diegetics.slice().sort((a, b) => b.elements + b.textNodes * 2 - (a.elements + a.textNodes * 2))[0] ?? null;
    const heroes = pieces.filter((p) => p.id.endsWith(".hero"));
    const hero = heroes[0] ?? null;
    const sigs = [...gradientSignatures(roots)];
    for (const sig of sigs) bySig.set(sig, [...(bySig.get(sig) ?? []), r.scene]);
    scenes.push({
      scene: r.scene,
      bestDiegetic: best ? { id: best.id, elements: best.elements, textNodes: best.textNodes } : null,
      diegeticPass: !!diegetics.find((p) => p.elements >= DIEGETIC_MIN_ELEMENTS && p.textNodes >= DIEGETIC_MIN_TEXT_NODES),
      hero: hero ? { id: hero.id, elements: hero.elements, textNodes: hero.textNodes } : null,
      heroPass: heroes.length === 0 || heroes.every((h) => h.elements >= HERO_MIN_ELEMENTS && h.textNodes >= HERO_MIN_TEXT_NODES),
      depth: maxDomDepth(roots),
      depthPass: maxDomDepth(roots) >= DEPTH_FLOOR,
      gradientSignatures: sigs,
      badImgSrcs: imgSrcs(roots).filter((src) => !IMG_SRC_WHITELIST.test(src)),
    });
  }
  const repeated = [...bySig.entries()]
    .filter(([, list]) => new Set(list).size > MAX_SCENES_PER_SIGNATURE)
    .map(([signature, list]) => ({ signature, scenes: [...new Set(list)].sort((a, b) => a - b) }));
  return {
    scenes: scenes.sort((a, b) => a.scene - b.scene),
    distinctSignatures: bySig.size,
    repeated,
    varietyPass: bySig.size >= MIN_GRADIENT_SIGNATURES && repeated.length === 0,
  };
};

// ── structural gates (the standalone-runnable production set, v5's) ──────────

interface StructuralFinding { scene: number; key: string; detail: string }

const runStructuralGates = (composition: string, script: LooseScript): StructuralFinding[] => {
  const out: StructuralFinding[] = [];
  const ranges = sectionRanges(composition);
  const scenesContaining = (needle: string): number[] =>
    ranges.filter((r) => composition.slice(r.start, r.end).includes(needle)).map((r) => r.index);
  const attributed = (needle: string): number[] => {
    const hits = scenesContaining(needle);
    return hits.length > 0 ? hits : [-1];
  };
  for (const name of findProvidedComponentRedefinitions(composition)) {
    for (const scene of attributed(`const ${name}`))
      out.push({ scene, key: "provided_component_redefined", detail: `${name} is a PROVIDED component — re-creating provided components is rejected.` });
  }
  for (const p of findPlaceholderData(composition)) {
    out.push({ scene: p.section, key: "placeholder_data", detail: `Placeholder/unresolved data on screen: ${p.token} (…${p.context}…). Every price, stat, and label must be a CONCRETE literal.` });
  }
  for (const icon of assessInvalidLucideImports(composition)) {
    for (const scene of attributed(`<${icon}`))
      out.push({ scene, key: "invalid_lucide_imports", detail: `Invalid lucide-react import — ${icon} does not exist in lucide-react and will crash the render.` });
  }
  for (const tag of findUndefinedJsxComponents(composition)) {
    for (const scene of attributed(`<${tag}`))
      out.push({ scene, key: "undefined_jsx_components", detail: `Undefined JSX component <${tag}> — resolves to undefined at runtime → white screen.` });
  }
  for (const u of findUnboundCopy(composition, (script.scenes ?? []) as never)) {
    out.push({ scene: u.scene, key: "unbound_copy", detail: `Baked-in script copy — scene ${u.scene} ${u.field} ("${u.excerpt}") is retyped as literal JSX instead of bound via c.${u.field}.` });
  }
  const aspect = (script.config?.aspect_ratio ?? "16:9") as AspectRatio;
  for (const w of findOverflowingElements(composition, aspect)) {
    for (const scene of attributed(String(w)))
      out.push({ scene, key: "overflow_crop", detail: `Off-canvas crop — element with width ${w}px crosses the ${aspect} canvas edge.` });
  }
  const logoCount = findDuplicateLogos(composition);
  if (logoCount > 1 && !hasCornerLogoSuppression(composition)) {
    const re = /<Img\b[^>]*\bsrc=\{?\s*["'`]?[^}"'`>\s]*logo/i;
    const hits = ranges.filter((r) => re.test(composition.slice(r.start, r.end))).map((r) => r.index);
    for (const scene of hits.length > 0 ? hits : [-1])
      out.push({ scene, key: "duplicate_logo", detail: `Duplicate brand logo — the logo image appears at ${logoCount} sites; Chrome already carries the brand mark on every scene.` });
  }
  return out;
};

// ── per-scene vision (v5's rubric path, budget-aware) ────────────────────────

interface SceneVisionVerdict {
  scene: number;
  ok: boolean;
  issues: string[];
  actionable: string[];
  severe: string[];
  error?: string;
}

interface BrandTruthLite { name?: string; backgroundColor?: string; accent?: string; fonts?: string[] }

const runVisionRound = async (
  measurements: SceneMeasurement[],
  script: LooseScript,
  brandTruth: BrandTruthLite,
): Promise<SceneVisionVerdict[]> => {
  const withShots = measurements.filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath);
  const judged = await Promise.allSettled(
    withShots.map(async (m) => {
      if (!visionBudgetOk()) {
        return { scene: m.scene, ok: true, issues: [], actionable: [], severe: [], error: "vision skipped — total LLM budget exhausted" } satisfies SceneVisionVerdict;
      }
      countVisionCall();
      const b64 = (await fs.readFile(m.screenshotPath)).toString("base64");
      const rubric = buildRubric(brandTruth, script.scenes[m.scene]?.visual_concept);
      const { text, usage } = await callZaiVision(b64, rubric);
      zaiUsage = addUsage(zaiUsage, usage);
      const verdict = parseVerdict(text);
      const actionable = verdict.issues.filter((issue) => !isSanctionedChromeFinding(issue));
      return {
        scene: m.scene,
        ok: verdict.ok || actionable.length === 0,
        issues: verdict.issues,
        actionable,
        severe: actionable.filter((issue) => SEVERE_RX.test(issue)),
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

// ── sequence vision — ONCE, after the final per-scene round ──────────────────

const runSequenceRound = async (
  measurements: SceneMeasurement[],
  brandTruth: BrandTruthLite,
): Promise<VisionFinding[]> => {
  if (!visionBudgetOk()) {
    console.warn("  sequence vision skipped — total LLM budget exhausted");
    return [];
  }
  const sequenceJudge: SequenceJudge = async (imagesB64, prompt) => {
    countVisionCall();
    const { text, usage } = await callZaiVision(imagesB64, prompt, { maxTokens: 2500 });
    zaiUsage = addUsage(zaiUsage, usage);
    return text;
  };
  const ordered = measurements
    .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
    .sort((a, b) => a.scene - b.scene);
  const imagesB64 = await Promise.all(ordered.map(async (m) => (await fs.readFile(m.screenshotPath)).toString("base64")));
  return judgeSequence(imagesB64, brandTruth, sequenceJudge);
};

// ── finding → piece routing (v5's + thin-hero + hero-washout) ────────────────

const PIECE_ID_RX = /\bs\d+\.(?:hero|copy|atmosphere|connector|throughline)\b/g;
const VISION_COPY_RX = /\b(head(?:line)?|lede|bullet|caption|copy|paragraph|typograph|font|wall of type|text\b)/i;
const VISION_ATMOS_RX = /\b(background|canvas|atmosphere|glow|gradient|vignette|grain|wash)\b/i;

const computeTargets = (args: {
  validPieceIds: Set<string>;
  density: DensityFinding[];
  profile: DensityProfile;
  rtBlocking: RenderTruthFinding[];
  washout: HeroWashoutFinding[];
  vision: SceneVisionVerdict[];
}): Map<string, string[]> => {
  const { validPieceIds, density, profile, rtBlocking, washout, vision } = args;
  const targets = new Map<string, string[]>();
  const add = (pieceId: string, sceneFallback: number, feedback: string): void => {
    let id = pieceId;
    if (!validPieceIds.has(id)) id = `s${sceneFallback}.hero`;
    if (!validPieceIds.has(id)) return; // no cast slot to route to — logged upstream
    targets.set(id, [...(targets.get(id) ?? []), feedback]);
  };

  // A whole-scene render failure routes to a FULL RE-CAST of that scene's
  // non-chrome pieces (v2 fix a, carried through v5).
  const measureErrorScenes = new Map<number, string[]>();
  for (const f of density) {
    if (f.kind === "density-measure-error" && f.scene >= 0) {
      measureErrorScenes.set(f.scene, [...(measureErrorScenes.get(f.scene) ?? []), `${f.detail}`]);
    }
  }
  for (const f of rtBlocking) {
    if (f.kind === "measure-error" && f.scene >= 0) {
      measureErrorScenes.set(f.scene, [...(measureErrorScenes.get(f.scene) ?? []), `${f.detail}`]);
    }
  }
  for (const [scene, details] of measureErrorScenes) {
    const scenePieces = [...validPieceIds].filter((id) => id.startsWith(`s${scene}.`));
    const feedback = [
      `[render-truth/measure-error → FULL SCENE RE-CAST] scene ${scene} failed to render ENTIRELY: ${[...new Set(details)].join(" · ")}.`,
      `The assembled Section${scene} component threw at render time, so every element in this scene is being regenerated (yours included — the defect may live in any of them).`,
      `Re-emit this element as fully SELF-CONTAINED, render-safe JSX: define inline (inside this element) every array/object you index; never index a possibly-undefined value (no data[0] on data that might not exist); no references to variables this element does not itself define (beyond the provided design-system consts and components); balanced tags; valid inline styles.`,
    ].join("\n");
    for (const id of scenePieces) add(id, scene, feedback);
  }

  for (const f of density) {
    if (f.kind === "thin-diegetic" || f.kind === "shallow-dom") {
      add(`s${f.scene}.hero`, f.scene, `[density/${f.kind}] ${f.detail}\n${f.repairInstruction}`);
    } else if (f.kind === "thin-hero") {
      // NEW (v6): the per-hero floor names the hero — route to it exactly.
      const named = /"(s\d+\.[^"]*hero)"/.exec(f.detail)?.[1];
      add(named ?? `s${f.scene}.hero`, f.scene, `[density/thin-hero] ${f.detail}\n${f.repairInstruction}`);
    } else if (f.kind === "img-src") {
      const badTokens = [...f.detail.matchAll(/"([^"]{1,60})"/g)].map((m) => m[1]);
      let owner: string | null = null;
      for (const [pieceId, body] of pieceCache) {
        if (!pieceId.startsWith(`s${f.scene}.`)) continue;
        if (badTokens.some((t) => body.includes(t))) { owner = pieceId; break; }
      }
      add(owner ?? `s${f.scene}.hero`, f.scene, `[density/img-src] ${f.detail}\n${f.repairInstruction}`);
    }
  }
  const monotony = density.filter((f) => f.kind === "atmosphere-monotony");
  if (monotony.length > 0) {
    const scenesToVary = new Set<number>();
    for (const rep of profile.repeated) for (const s of rep.scenes.slice(MAX_SCENES_PER_SIGNATURE)) scenesToVary.add(s);
    if (scenesToVary.size === 0 && profile.distinctSignatures < MIN_GRADIENT_SIGNATURES) {
      scenesToVary.add(1);
      scenesToVary.add(3);
    }
    const fb = monotony.map((f) => `[density/atmosphere-monotony] ${f.detail}\n${f.repairInstruction}`).join("\n");
    for (const s of scenesToVary) {
      add(`s${s}.atmosphere`, s, `${fb}\nTHIS scene (${s}) must get a visibly DIFFERENT atmospheric treatment from the other scenes — change the gradient geometry (type, origin, angle, stops), not the brand colors.`);
    }
  }
  // NEW (v6): hero-washout is BLOCKING — the finding routes a hero regen
  // carrying the measured numbers verbatim.
  for (const f of washout) {
    add(f.pieceId, f.scene, `[hero-contrast/hero-washout] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of rtBlocking) {
    if (f.kind === "measure-error" || f.scene < 0) continue; // routed above
    const named = (f.detail.match(PIECE_ID_RX) ?? []).filter((id) => !/\.chrome$/.test(id));
    if (named.length > 0) {
      for (const id of new Set(named)) add(id, f.scene, `[render-truth/${f.kind}] ${f.detail}`);
    } else {
      const slot = f.kind === "canvas-brightness" ? "atmosphere" : f.kind === "barbell" ? "copy" : "hero";
      add(`s${f.scene}.${slot}`, f.scene, `[render-truth/${f.kind}] ${f.detail}`);
    }
  }
  for (const v of vision) {
    for (const issue of v.severe) {
      const slot = VISION_COPY_RX.test(issue) && !/mock|dashboard|window|panel|chart/i.test(issue)
        ? "copy"
        : VISION_ATMOS_RX.test(issue) && !/mock|dashboard|window|panel|chart|logo|image/i.test(issue)
          ? "atmosphere"
          : "hero";
      add(`s${v.scene}.${slot}`, v.scene, `[vision] ${issue}`);
    }
  }
  return targets;
};

// ── reference-row contrast: hero regions, else main-diegetic proxy ───────────

interface ContrastCell extends HeroLuminanceStats {
  proxy: boolean;
  washout: boolean;
}

/** Union region per diegetic piece from measured elements (probe geometry —
 *  same union/clamp as heroRegionsFromMeasurement, but for any diegetic id). */
const diegeticProxyRegion = (m: SceneMeasurement): { pieceId: string; x: number; y: number; w: number; h: number } | null => {
  const byPiece = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const el of m.elements as MeasuredElement[]) {
    if (!el.piece || el.pieceKind !== "diegetic") continue;
    if (el.w <= 0 || el.h <= 0) continue;
    const b = byPiece.get(el.piece) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, el.x); b.y0 = Math.min(b.y0, el.y);
    b.x1 = Math.max(b.x1, el.x + el.w); b.y1 = Math.max(b.y1, el.y + el.h);
    byPiece.set(el.piece, b);
  }
  let best: { pieceId: string; x: number; y: number; w: number; h: number } | null = null;
  for (const [pieceId, b] of byPiece) {
    const x = Math.max(0, Math.floor(b.x0));
    const y = Math.max(0, Math.floor(b.y0));
    const w = Math.min(m.width, Math.ceil(b.x1)) - x;
    const h = Math.min(m.height, Math.ceil(b.y1)) - y;
    if (w < 8 || h < 8) continue;
    if (!best || w * h > best.w * best.h) best = { pieceId, x, y, w, h };
  }
  return best;
};

/** Contrast stats for every scene: hero region(s) when present, otherwise the
 *  LARGEST diegetic piece as a documented proxy (the Klarna reference's lego
 *  pieces are content-named — s0.checkout, s3.grid — not ".hero"). */
const sampleContrast = async (measurements: SceneMeasurement[]): Promise<{ cells: ContrastCell[]; errors: string[] }> => {
  const cells: ContrastCell[] = [];
  const errors: string[] = [];
  const pw = (await import("playwright")) as unknown as {
    chromium?: typeof import("playwright").chromium;
    default?: { chromium?: typeof import("playwright").chromium };
  };
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) return { cells, errors: ["playwright chromium export missing"] };
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    for (const m of measurements) {
      if (!m.screenshotPath) continue;
      const heroRegions = heroRegionsFromMeasurement(m);
      const regions = heroRegions.length > 0
        ? heroRegions.map((r) => ({ ...r, proxy: false }))
        : (() => {
            const p = diegeticProxyRegion(m);
            return p ? [{ scene: m.scene, pieceId: p.pieceId, x: p.x, y: p.y, w: p.w, h: p.h, proxy: true }] : [];
          })();
      if (regions.length === 0) continue;
      const png = await fs.readFile(m.screenshotPath);
      const raw = await luminanceStatsForRegions(page, png, regions);
      for (const [i, r] of raw.entries()) {
        const region = regions[i];
        if (r.error || r.mean === undefined) {
          errors.push(`scene ${m.scene} ${region.pieceId}: ${r.error ?? "no stats"}`);
          continue;
        }
        const spread = (r.p95 ?? 0) - (r.p05 ?? 0);
        const stdDev = Math.round((r.stdDev ?? 0) * 10) / 10;
        cells.push({
          scene: m.scene,
          pieceId: region.pieceId,
          region: { x: region.x, y: region.y, w: region.w, h: region.h },
          mean: Math.round((r.mean ?? 0) * 10) / 10,
          stdDev,
          p05: r.p05 ?? 0,
          p95: r.p95 ?? 0,
          spread,
          sampledPixels: r.sampledPixels ?? 0,
          proxy: region.proxy,
          washout: spread < WASHOUT_SPREAD_FLOOR && stdDev < WASHOUT_STDDEV_FLOOR,
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { cells, errors };
};

// ── report shapes ────────────────────────────────────────────────────────────

interface ScriptAttemptRow { attempt: number; secs: number; in: number; out: number; stop: string | null; error: string | null }
interface BlueprintAttemptRow { attempt: number; secs: number; tokensIn: number; tokensOut: number; stop: string | null; errors: string[] }

interface GateRoundReport {
  round: number;
  llmCallsThisRound: number;
  castTelemetry: CastBuildResult["telemetry"] | null;
  density: DensityFinding[];
  profile: DensityProfile;
  structural: StructuralFinding[];
  renderTruthAll: RenderTruthFinding[];
  renderTruthBlocking: RenderTruthFinding[];
  heroContrast: { stats: HeroLuminanceStats[]; findings: HeroWashoutFinding[]; errors: string[] };
  vision: SceneVisionVerdict[];
  targets: { pieceId: string; feedback: string[] }[];
}

interface RowCell { scene: number; png?: string; label: string; note: string }

// ── gallery ──────────────────────────────────────────────────────────────────

const densityCellHtml = (p: SceneDensityProfile | undefined): string => {
  if (!p) return `<td class="bad" colspan="5">no data</td>`;
  if (p.ssrError) return `<td class="bad" colspan="5">SSR error: ${esc(p.ssrError.slice(0, 80))}</td>`;
  const dieg = p.bestDiegetic ? `${p.bestDiegetic.elements}el / ${p.bestDiegetic.textNodes}txt` : "none";
  const hero = p.hero ? `${p.hero.id.split(".").pop() === "hero" ? p.hero.id : p.hero.id} ${p.hero.elements}el/${p.hero.textNodes}tx` : "(no .hero piece)";
  return [
    `<td class="${p.diegeticPass ? "ok" : "bad"}">${esc(dieg)}</td>`,
    `<td class="${p.heroPass ? "ok" : "bad"}">${esc(hero)}</td>`,
    `<td class="${p.depthPass ? "ok" : "bad"}">${p.depth}</td>`,
    `<td>${p.gradientSignatures.length}</td>`,
    `<td class="${p.badImgSrcs.length === 0 ? "ok" : "bad"}">${p.badImgSrcs.length}</td>`,
  ].join("");
};

const contrastCellHtml = (cells: ContrastCell[], scene: number): string => {
  const cs = cells.filter((c) => c.scene === scene);
  if (cs.length === 0) return `<td colspan="2">n/a</td>`;
  return cs
    .map((c) => [
      `<td class="${c.washout ? "bad" : "ok"}">${esc(c.pieceId)}${c.proxy ? " (proxy)" : ""}</td>`,
      `<td class="${c.washout ? "bad" : "ok"}">spread ${c.spread} · std ${c.stdDev}</td>`,
    ].join(""))
    .join("");
};

const rowGrid = (cells: RowCell[]): string =>
  cells
    .map((s) => {
      const visual = s.png
        ? `<a href="${esc(s.png)}" target="_blank"><img src="${esc(s.png)}" alt="scene ${s.scene}"></a>`
        : `<div class="err">NO RENDER</div>`;
      return `<div class="cell"><div class="cell-title">scene ${s.scene} — ${esc(s.label)}</div>${visual}<div class="stat">${esc(s.note)}</div></div>`;
    })
    .join("\n");

const gateLogHtml = (gateRounds: GateRoundReport[], sequenceFinal: VisionFinding[]): string => {
  const rounds = gateRounds
    .map((g) => {
      const rows: string[] = [];
      for (const f of g.density) rows.push(`<li><b>density/${esc(f.kind)} (BLOCKING)</b> scene ${f.scene}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const f of g.heroContrast.findings) rows.push(`<li><b>hero-contrast/hero-washout (BLOCKING)</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const e of g.heroContrast.errors) rows.push(`<li><b>hero-contrast</b> sampling error: ${esc(e.slice(0, 200))}</li>`);
      for (const f of g.structural) rows.push(`<li><b>structural/${esc(f.key)}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const f of g.renderTruthAll) rows.push(`<li><b>render-truth/${esc(f.kind)}${g.renderTruthBlocking.includes(f) ? " (BLOCKING)" : " (advisory)"}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const v of g.vision) {
        if (v.error) rows.push(`<li><b>vision</b> scene ${v.scene}: ${esc(v.error)}</li>`);
        else if (v.actionable.length === 0) rows.push(`<li><b>vision</b> scene ${v.scene}: CLEAN${v.issues.length ? ` (sanctioned-chrome findings dropped: ${v.issues.length})` : ""}</li>`);
        else for (const issue of v.actionable) rows.push(`<li><b>vision${v.severe.includes(issue) ? " (SEVERE)" : ""}</b> scene ${v.scene}: ${esc(issue.slice(0, 260))}</li>`);
      }
      const targets = g.targets.map((t) => t.pieceId).join(", ") || "none";
      return `<h3>gate round ${g.round} — ${g.llmCallsThisRound} LLM calls this round · retry targets: [${esc(targets)}]</h3><ul>${rows.join("\n") || "<li>all clean</li>"}</ul>`;
    })
    .join("\n");
  const seq = sequenceFinal.length
    ? sequenceFinal.map((f) => `<li><b>sequence-vision (log-only, ran ONCE after the final round)</b>: ${esc(f.issue.slice(0, 320))}</li>`).join("\n")
    : "<li>sequence vision: CLEAN</li>";
  return `${rounds}<h3>final sequence-vision pass</h3><ul>${seq}</ul>`;
};

const callLogHtml = (): string => {
  const rows = callLog
    .map((c) => `<tr><td style="text-align:left">${esc(c.label)}</td><td style="text-align:left">${esc(c.model)}</td><td>${c.secs.toFixed(1)}s</td><td>${c.in}</td><td>${c.out}</td><td>${esc(String(c.stop))}</td></tr>`)
    .join("\n");
  return `<div class="scroll"><table><tr><th>call</th><th>model</th><th>secs</th><th>tok in</th><th>tok out</th><th>stop</th></tr>${rows}</table></div>`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/acceptance6-spike.mjs");
    process.exitCode = 1;
    return;
  }
  if (!process.env.RB_FIREWORKS_KEY) {
    console.error("RB_FIREWORKS_KEY missing — the v5 cast stack (GLM-5.2 @ Fireworks) needs it");
    process.exitCode = 1;
    return;
  }
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT_DIR, "v6"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "reference"), { recursive: true });

  // Cast routing: HERO+LEAVES both GLM-5.2 @ Fireworks (v5's winning row).
  delete process.env.RB_CAST_MODEL;
  process.env.RB_CAST_MODEL_HERO = FIREWORKS_GLM;
  process.env.RB_CAST_MODEL_LEAVES = FIREWORKS_GLM;

  const report: Record<string, unknown> = {
    experiment:
      "ACCEPTANCE V6: FULL comparable build on Klarna — script + design system + blueprints all GENERATED (script/DS on GLM-5.2 @ Fireworks effort high; blueprints on gpt-oss-120b @ Cerebras effort high), cast on GLM-5.2 @ Fireworks (v5 stack), v5 gate loop + NEW per-hero density floor + NEW hero-washout contrast gate (both BLOCKING)",
    brand: BRAND,
    ref: REF_BUILD,
    generatedAt: new Date().toISOString(),
    gateFixes: {
      perHeroFloor: `density-gates clause (a2): any ".hero" piece must itself measure ≥${HERO_MIN_ELEMENTS}el/≥${HERO_MIN_TEXT_NODES}tx (kind thin-hero, blocking)`,
      heroWashout: `hero-contrast: hero region luminance spread<${WASHOUT_SPREAD_FLOOR} AND stdDev<${WASHOUT_STDDEV_FLOOR} → hero-washout (blocking), routed to the named hero`,
    },
    terminalError: null,
  };

  const gateRounds: GateRoundReport[] = [];
  const roundTelemetry: CastBuildResult["telemetry"][] = [];
  const finalize: Record<string, unknown> = {};
  let sequenceFinal: VisionFinding[] = [];
  let profile: DensityProfile | null = null;
  let finalMeasurements: SceneMeasurement[] = [];
  let finalContrast: HeroContrastResult | null = null;
  let script: LooseScript | null = null;
  let scriptStartS: number | null = null;
  let castStartS: number | null = null;
  let previewEndS: number | null = null;
  const scriptAttemptLog: ScriptAttemptRow[] = [];
  const blueprintAttempts: BlueprintAttemptRow[] = [];

  const writeOut = async (): Promise<void> => {
    const usd = (model: string): number => {
      const [pin, pout] = MODEL_PRICES[model] ?? [0, 0];
      const pm = perModel[model] ?? { calls: 0, in: 0, out: 0 };
      return (pm.in * pin + pm.out * pout) / 1e6;
    };
    const fwUsd = usd(FIREWORKS_GLM);
    const cbUsd = usd(BLUEPRINT_MODEL);
    const zaiUsd = costUsd(VISION_MODEL, zaiUsage);
    report.phases = marks;
    report.scriptAttemptLog = scriptAttemptLog;
    report.blueprintAttemptLog = blueprintAttempts;
    report.castRounds = roundTelemetry;
    report.gateRounds = gateRounds;
    report.sequenceFinal = sequenceFinal;
    report.densityProfile = profile;
    report.finalContrast = finalContrast;
    report.finalize = finalize;
    report.calls = callLog;
    report.budget = { totalLlmCalls, ceiling: TOTAL_LLM_CEILING, budgetExhausted, visionCalls: zaiCalls };
    report.cost = {
      fireworks: { model: FIREWORKS_GLM, ...(perModel[FIREWORKS_GLM] ?? { calls: 0, in: 0, out: 0 }), usdPerMIn: MODEL_PRICES[FIREWORKS_GLM][0], usdPerMOut: MODEL_PRICES[FIREWORKS_GLM][1], usd: fwUsd },
      cerebras: { model: BLUEPRINT_MODEL, ...(perModel[BLUEPRINT_MODEL] ?? { calls: 0, in: 0, out: 0 }), usdPerMIn: MODEL_PRICES[BLUEPRINT_MODEL][0], usdPerMOut: MODEL_PRICES[BLUEPRINT_MODEL][1], usd: cbUsd },
      zaiVision: { calls: zaiCalls, inputTokens: zaiUsage.input_tokens, outputTokens: zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
      totalUsd: fwUsd + cbUsd + zaiUsd,
    };
    report.wall = {
      totalRunSeconds: nowS(),
      scriptToPreviewSeconds:
        scriptStartS !== null && previewEndS !== null ? Math.round((previewEndS - scriptStartS) * 10) / 10 : null,
      castToPreviewSeconds:
        castStartS !== null && previewEndS !== null ? Math.round((previewEndS - castStartS) * 10) / 10 : null,
      castWallSeconds: Math.round(roundTelemetry.reduce((n, t) => n + t.wallSeconds, 0) * 10) / 10,
    };
    await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  };

  try {
    // ── inputs: reference manifest (fonts/logo/boilerplate) + ref script ─────
    const manifest: Manifest = JSON.parse(await fs.readFile(path.join(REF_DIR, "lego", "manifest.json"), "utf8"));
    const refScript: LooseScript = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));

    // ── brief from the store ─────────────────────────────────────────────────
    const stored = await phase("brief-load", async (): Promise<StoredBrief> => {
      const b = await withDbRetry(() => loadBriefByScriptId(REF_BUILD, DEV_OWNER_ID));
      if (!b) throw new Error(`no Project row found for scriptId ${REF_BUILD}`);
      console.log(`  brief ${b.id} (owner ${b.owner_id}) — ${b.brand_kit_url}, brand_extract.ok=${b.brand_extract?.ok}`);
      return b;
    });
    const be = stored.brand_extract as unknown as AgentBrandExtract | undefined;
    if (!be?.ok) throw new Error("brief has no cached brand_extract — brand selection contract violated");
    const canvasPlan = resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]);
    const signature =
      signatureWithLogoFallback(be.palette ?? [], be.theme_color, be.logo_color) ?? be.theme_color ?? (be.palette ?? [])[0] ?? "#ffb3c7";
    report.brief = { projectId: stored.id, url: stored.brand_kit_url, brandExtractCached: true, canvasPlan, signature };

    // ── canaries: BOTH transports before any real spend ──────────────────────
    await phase("canary", async () => {
      const fw = await budgetedCast("canary-fireworks", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: FIREWORKS_GLM, effort: "none" });
      console.log(`  fireworks glm-5p2 ok — ${fw.seconds.toFixed(1)}s, stop=${fw.stopReason}`);
      const cb = await budgetedCast("canary-cerebras", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: BLUEPRINT_MODEL, effort: "low" });
      console.log(`  cerebras gpt-oss-120b ok — ${cb.seconds.toFixed(1)}s, stop=${cb.stopReason}`);
    });

    // ── PHASE 1: SCRIPT — GENERATED on GLM-5.2 @ Fireworks, effort high ──────
    const agentBrief: AgentBrief = {
      duration_seconds: stored.duration_seconds ?? 30,
      distribution_format: stored.distribution_format ?? "landscape",
      moment_count: 5,
      brand_kit_url: stored.brand_kit_url,
      verified_claims: stored.verified_claims,
      brand_extract: be,
      preallocated_assets: buildPreallocatedFromCrawl(be),
      // The original brief was freeform; its prompt survives verbatim as the
      // reference script's brief.about (injectIdentity's contract).
      freeform_prompt: refScript.brief?.about ?? stored.purpose,
    };
    const briefId = stored.id;
    scriptStartS = nowS();
    const scriptResult = await phase("script", async () => {
      const userMsg = buildUserMessage(agentBrief);
      let nextUser = userMsg;
      let lastError = "";
      for (let attempt = 1; attempt <= SCRIPT_MAX_ATTEMPTS; attempt++) {
        const r = await budgetedCast(`script-attempt-${attempt}`, {
          system: SCRIPT_GENERATOR_SYSTEM_PROMPT,
          user: nextUser,
          maxTokens: SCRIPT_MAX_TOKENS,
          model: FIREWORKS_GLM,
          effort: HEAD_EFFORT, // Fireworks: thinking {enabled, budget 8192}
        });
        const res = processScriptAttempt(r.text, agentBrief, briefId);
        scriptAttemptLog.push({ attempt, secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, error: res.ok ? null : res.error });
        if (res.ok) {
          console.log(`  script valid on attempt ${attempt}/${SCRIPT_MAX_ATTEMPTS} — ${r.seconds.toFixed(1)}s, ${r.outputTokens} tok out`);
          return { script: res.script, attempts: attempt, fellBack: false };
        }
        lastError = res.error;
        console.warn(`  script attempt ${attempt} INVALID: ${res.error.split("\n")[0]}${attempt < SCRIPT_MAX_ATTEMPTS ? " — repair retry with the error verbatim" : ""}`);
        nextUser = [
          userMsg,
          ``,
          `════ YOUR PREVIOUS OUTPUT (INVALID) ════`,
          stripCodeFence(r.text.trim()).slice(0, 40000),
          ``,
          `════ VALIDATION FAILURE (verbatim) ════`,
          res.error,
          ``,
          `Fix the issue and re-emit the COMPLETE Script JSON. Common gotchas to recheck:`,
          `- Every section has visual_concept (1-3 sentences of prose) AND content with headline + asset_ids array.`,
          `- scenes tile [0, total_duration_seconds] exactly: first.start_seconds=0, last.end_seconds=total, adjacent boundaries match.`,
          `- EXACTLY 5 sections. Do NOT emit scene.elements[], scene.background, or scene.audio_cues.`,
          `Output ONLY the JSON object. No prose, no fence.`,
        ].join("\n");
      }
      console.error(`  ▲▲▲ SCRIPT TERMINAL after ${SCRIPT_MAX_ATTEMPTS} attempts (${lastError.split("\n")[0]}) — FALLING BACK to the reference script.json. This is a KEY FINDING, not a footnote: GLM-5.2 @ Fireworks could not clear the richness bar on this brand.`);
      return { script: backfillSceneRegisters(normalizeScriptContent(refScript)) as LooseScript, attempts: SCRIPT_MAX_ATTEMPTS, fellBack: true };
    });
    script = scriptResult.script;
    report.script = {
      source: scriptResult.fellBack ? "REFERENCE FALLBACK (terminal validation failure — see scriptAttemptLog)" : `GENERATED on ${FIREWORKS_GLM} (effort high), valid on attempt ${scriptResult.attempts}`,
      generated: !scriptResult.fellBack,
      attempts: scriptResult.attempts,
      fellBackToReference: scriptResult.fellBack,
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
      headlines: script.scenes.map((s) => s.content?.headline),
    };
    await writeOut();

    // ── PHASE 2: DESIGN SYSTEM — same model/effort, full-spike's pattern ─────
    const refFonts = fontsFromReference(manifest.preamble);
    const refKfLoc = findConstDecl(manifest.preamble, "SHARED_KEYFRAMES");
    const refKeyframesCss = refKfLoc ? manifest.preamble.slice(refKfLoc.start, refKfLoc.end) : "";
    const ds = await phase("design-system", async () => {
      const user = dsUserPrompt(script!, be, { display: refFonts.display, body: refFonts.body }, signature);
      const first = await budgetedCast("design-system", { system: dsSystemPrompt, user, maxTokens: DS_MAX_TOKENS, model: FIREWORKS_GLM, effort: HEAD_EFFORT });
      let parsed = parseDsEmission(first.text, refKeyframesCss);
      let compileErr = parsed.ok ? await verifyCompilable(Object.values(parsed.decls!).join("\n\n")) : parsed.error ?? "parse failed";
      let repaired = false;
      if (!parsed.ok || compileErr) {
        const why = parsed.ok ? `the design-system declarations failed to compile:\n${compileErr}` : parsed.error!;
        console.warn(`  DS invalid (${String(why).split("\n")[0]}) — ONE repair retry`);
        repaired = true;
        const fix = await budgetedCast("design-system-repair", {
          system: dsSystemPrompt,
          user: `${user}\n\n════ YOUR PREVIOUS OUTPUT (INVALID) ════\n${stripCodeFence(first.text.trim()).slice(0, 30000)}\n\n════ FAILURE ════\n${why}\n\nRe-emit the four contract declarations, corrected. Nothing else.`,
          maxTokens: DS_MAX_TOKENS,
          model: FIREWORKS_GLM,
          effort: HEAD_EFFORT,
        });
        parsed = parseDsEmission(fix.text, refKeyframesCss);
        compileErr = parsed.ok ? await verifyCompilable(Object.values(parsed.decls!).join("\n\n")) : parsed.error ?? "parse failed";
      }
      if (!parsed.ok || compileErr) {
        console.error(`  DS STILL invalid (${String(parsed.error ?? compileErr).split("\n")[0]}) — FALLBACK theme from the reference build (recorded honestly)`);
        return { derived: fallbackThemeFromReference(manifest.preamble, canvasPlan.background, signature, be.palette ?? []), ok: false, repaired, error: String(parsed.error ?? compileErr), kfInjected: [] as string[] };
      }
      await fs.writeFile(path.join(OUT_DIR, "design-system-emission.tsx"), Object.values(parsed.decls!).join("\n\n"), "utf8");
      const derived = themeFromDs(parsed.decls!, manifest.preamble, be.palette ?? []);
      console.log(`  DS accepted${repaired ? " after ONE repair" : " first try"}${parsed.requiredKeyframesInjected!.length ? ` (required keyframes merged from reference: ${parsed.requiredKeyframesInjected!.join(", ")})` : ""} — palette ${Object.keys(derived.theme.palette).join("/")}`);
      return { derived, ok: true, repaired, error: null as string | null, kfInjected: parsed.requiredKeyframesInjected! };
    });
    // Ink guard — castBuild applies it internally too; running it here makes
    // the correction VISIBLE in the report as the task demands.
    const inkGuard = neutralizeInk(ds.derived.theme);
    if (inkGuard.corrected) console.warn(`  neutralizeInk CORRECTED the DS ink (a saturated brand hue was cast as text ink → neutral #1a1a1a)`);
    const theme = inkGuard.theme;
    const { paletteHexes, signatureAccent, logoSrc, mappingNotes } = ds.derived;
    report.designSystem = {
      acceptedFromModel: ds.ok,
      repaired: ds.repaired,
      error: ds.error,
      inkNeutralized: inkGuard.corrected,
      requiredKeyframesInjected: ds.kfInjected,
      themeMappingNotes: mappingNotes,
      logoSrc,
    };
    await writeOut();

    const brandTruth: BrandTruthLite = {
      name: be.title ?? BRAND,
      backgroundColor: canvasPlan.background,
      accent: signature,
      fonts: [be.font_roles?.display, be.font_roles?.body].filter((f): f is string => !!f),
    };

    // ── PHASE 3: BLUEPRINTS — generateComposition on gpt-oss @ Cerebras ──────
    let headAttemptN = 0;
    const headCaller: CompositionCaller = async (call) => {
      headAttemptN += 1;
      const res = await budgetedCast(`composition-head-attempt-${headAttemptN}`, {
        system: call.system,
        user: call.user,
        maxTokens: call.maxTokens,
        model: BLUEPRINT_MODEL,
        effort: call.effort === "none" ? "low" : call.effort,
      });
      blueprintAttempts.push({ attempt: headAttemptN, secs: res.seconds, tokensIn: res.inputTokens, tokensOut: res.outputTokens, stop: res.stopReason, errors: [] });
      return res;
    };
    await phase("composition-head", async () => {
      try {
        const result = await generateComposition({
          script: script as unknown as Script,
          caller: headCaller,
          validate: checkSceneComposition,
          brandName: be.title ?? BRAND,
          paletteHint: `canvas ${canvasPlan.background} (${canvasPlan.mode}), signature accent ${signature}, brand palette: ${(be.palette ?? []).join(", ")}`,
          designNotes: `Design system consts available downstream: PALETTE (canvas/ink/accent/muted/softNeutral/cardFill/white), shared keyframes (glowBreathe, drift1-3, drawWidth, fadeRise, scaleIn). Fonts locked: display ${refFonts.display}, body ${refFonts.body}.`,
        });
        for (const e of result.errors) {
          const m = /^attempt (\d+): ([\s\S]*)$/.exec(e);
          const bucket = m ? blueprintAttempts.find((a) => a.attempt === Number(m[1])) : undefined;
          if (bucket) bucket.errors.push(m![2]);
          else blueprintAttempts.push({ attempt: -1, secs: 0, tokensIn: 0, tokensOut: 0, stop: null, errors: [e] });
        }
        const residual = checkSceneComposition(result.scenes);
        const validatedClean = residual.length === 0;
        report.blueprints = {
          author: `${BLUEPRINT_MODEL} @ Cerebras, effort high (the proven blueprint author — acceptance v2)`,
          attempts: result.attempts,
          validatedClean,
          threw: false,
          residualErrors: residual,
        };
        script = { ...script!, scenes: result.scenes as unknown as ScriptScene[] };
        console.log(`  composition head: ${result.attempts} attempt(s) — ${validatedClean ? "VALIDATED CLEAN" : `TERMINAL: ${residual.length} residual error(s) (shipping anyway; gates are the backstop)`}`);
        for (const e of result.errors) console.log(`    · ${e.slice(0, 200)}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.blueprints = { author: BLUEPRINT_MODEL, attempts: headAttemptN, validatedClean: false, threw: true, residualErrors: [msg] };
        console.error(`  ▲▲▲ composition head THREW: ${msg} — proceeding with UN-COMPOSED scenes (generic-brief path)`);
      }
      const compositions = script!.scenes.map((s, i) => ({ scene: i, composition: s.composition ?? null }));
      await fs.writeFile(path.join(OUT_DIR, "composition.json"), JSON.stringify(compositions, null, 2), "utf8");
    });
    await writeOut();

    // ── PHASES 4–5: cast (GLM-5.2 @ Fireworks) + the v6 gate loop ────────────
    const castInput = {
      script: script as unknown as Script,
      theme,
      palette: paletteHexes,
      signatureAccent,
      aspect: "16:9" as const,
    };
    let castResult: CastBuildResult | null = null;
    let finalCode = "";
    let round = 0;
    let genDirReady = false;
    castStartS = nowS();

    while (true) {
      castRoundLabel = `cast-r${round}`;
      const callsBefore = totalLlmCalls;
      try {
        castResult = await phase(`cast-r${round}`, () => castBuild(castInput, { caller: cachingCaller }));
      } catch (e) {
        console.error(`  castBuild THREW on round ${round}: ${e instanceof Error ? e.message : e}`);
        finalize[`castRound${round}Error`] = e instanceof Error ? e.message : String(e);
        pieceTargets = new Map();
        break;
      }
      pieceTargets = new Map(); // consumed — gates decide the next round's targets
      roundTelemetry.push(castResult.telemetry);
      console.log(
        `  cast r${round}: ${castResult.telemetry.elements} elements · ${castResult.telemetry.repairs} repairs · ${castResult.telemetry.failures} placeholders · ` +
          `${castResult.telemetry.tokensOut} tok out · ${castResult.telemetry.normalizedColors} hue-locked · ${castResult.telemetry.wallSeconds}s · ${totalLlmCalls - callsBefore} LLM calls`,
      );

      finalCode = await phase(`finalize-r${round}`, async () => {
        let code = injectLogoSrc(castResult!.code, logoSrc);
        const fin = await finalizeUndefinedRefs(code);
        finalize[`r${round}`] = { logoInjected: Boolean(logoSrc), added: fin.added, stubbed: fin.stubbed, neutralized: fin.neutralized };
        return fin.code;
      });

      if (!genDirReady) {
        await fs.rm(GEN_DIR, { recursive: true, force: true });
        await fs.mkdir(GEN_DIR, { recursive: true });
        for (const shim of SHIMS) await fs.copyFile(path.join(REF_DIR, shim), path.join(GEN_DIR, shim)).catch(() => {});
        genDirReady = true;
      }
      await fs.writeFile(path.join(GEN_DIR, "Composition.tsx"), finalCode, "utf8");
      await fs.writeFile(path.join(GEN_DIR, "script.json"), JSON.stringify(script, null, 2), "utf8");

      // (a) density gates — blocking, NOW INCLUDING the per-hero floor.
      const density = await phase(`density-r${round}`, async () => assessDensity(finalCode, script));
      profile = buildDensityProfile(finalCode, script);
      console.log(`  density: ${density.length} blocking finding(s) [${density.map((f) => f.kind).join(", ") || "clean"}] · distinct sigs ${profile.distinctSignatures} · depths [${profile.scenes.map((s) => s.depth).join(", ")}]`);

      // (b) structural + render-truth.
      const structural = runStructuralGates(finalCode, script!);
      const measurements = await phase(`measure-r${round}`, () => measureScenes(GEN_DIR, script, GEN_DIR));
      finalMeasurements = measurements;
      const rt = await phase(`render-truth-r${round}`, () =>
        findRenderTruthFailures(measurements, {
          brandBackground: canvasPlan.background,
          blockingKinds: BLOCKING_KINDS,
          registers: script!.scenes.map((s) => s.register),
        }),
      );

      // (b2) NEW: hero-washout — deterministic contrast on the hero regions.
      const contrast = await phase(`hero-contrast-r${round}`, () => assessHeroWashout(measurements));
      finalContrast = contrast;
      console.log(
        `  hero-contrast: ${contrast.stats.length} hero region(s) sampled · ${contrast.findings.length} washout(s)` +
          `${contrast.findings.length ? ` [${contrast.findings.map((f) => f.pieceId).join(", ")}]` : ""}` +
          `${contrast.errors.length ? ` · errors: ${contrast.errors.join(" | ")}` : ""}`,
      );

      // (c) per-scene vision. (Sequence vision runs ONCE, after the final round.)
      const vision = await phase(`vision-r${round}`, () => runVisionRound(measurements, script!, brandTruth));

      const validPieceIds = new Set(castResult.scenes.flatMap((s) => s.pieces.filter((p) => p.kind !== "chrome").map((p) => p.id)));
      const targets = computeTargets({ validPieceIds, density, profile, rtBlocking: rt.blocking, washout: contrast.findings, vision });

      gateRounds.push({
        round,
        llmCallsThisRound: totalLlmCalls - callsBefore,
        castTelemetry: castResult.telemetry,
        density,
        profile,
        structural,
        renderTruthAll: rt.findings,
        renderTruthBlocking: rt.blocking,
        heroContrast: { stats: contrast.stats, findings: contrast.findings, errors: contrast.errors },
        vision,
        targets: [...targets.entries()].map(([pieceId, feedback]) => ({ pieceId, feedback })),
      });
      previewEndS = nowS();
      await writeOut();

      console.log(
        `  round ${round}: density ${density.length} · washout ${contrast.findings.length} · structural ${structural.length} · render-truth ${rt.findings.length} (${rt.blocking.length} blocking) · ` +
          `vision actionable ${vision.reduce((n, v) => n + v.actionable.length, 0)} (severe on [${vision.filter((v) => v.severe.length).map((v) => v.scene).join(", ")}]) · ` +
          `retry targets [${[...targets.keys()].join(", ") || "none"}]`,
      );

      if (targets.size === 0) {
        console.log(`  all scene-scoped blocking gates clean — done after round ${round}`);
        break;
      }
      if (round >= MAX_RETRY_ROUNDS) {
        console.warn(`  targets remain [${[...targets.keys()].join(", ")}] but the ${MAX_RETRY_ROUNDS}-round retry budget is spent — shipping with residual findings (honest)`);
        break;
      }
      if (budgetExhausted || totalLlmCalls >= TOTAL_LLM_CEILING) {
        console.warn(`  total LLM ceiling reached — shipping with residual findings (honest)`);
        break;
      }
      pieceTargets = targets;
      round += 1;
    }

    if (finalCode) await fs.writeFile(path.join(OUT_DIR, "Composition.acceptance6.tsx"), finalCode, "utf8");

    // Sequence vision — ONCE, after the final per-scene round.
    if (finalMeasurements.some((m) => m.screenshotPath)) {
      sequenceFinal = await phase("sequence-vision-final", () => runSequenceRound(finalMeasurements, brandTruth));
      for (const f of sequenceFinal) console.log(`  sequence: ${f.issue.slice(0, 160)}`);
    } else {
      console.warn("  no screenshots — sequence vision skipped");
    }
    await writeOut();

    // ── v6 final renders → .data/acceptance6/v6/scene{0..4}.png ─────────────
    const finalRound = gateRounds[gateRounds.length - 1];
    const v6Cells: RowCell[] = [];
    for (const i of SCENES) {
      const m = finalMeasurements.find((mm) => mm.scene === i);
      const v = finalRound?.vision.find((vv) => vv.scene === i);
      const dens = finalRound?.density.filter((f) => f.scene === i) ?? [];
      const rtb = finalRound?.renderTruthBlocking.filter((f) => f.scene === i) ?? [];
      const wash = finalRound?.heroContrast.findings.filter((f) => f.scene === i) ?? [];
      const cst = finalRound?.heroContrast.stats.filter((s) => s.scene === i) ?? [];
      const p = profile?.scenes.find((s) => s.scene === i);
      const note = [
        p ? (p.ssrError ? `density: SSR ERROR` : `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · hero ${p.hero ? `${p.hero.elements}el/${p.hero.textNodes}tx` : "none"} · depth ${p.depth}`) : "density: n/a",
        cst.length ? `contrast: ${cst.map((c) => `${c.pieceId} spread ${c.spread}/std ${c.stdDev}`).join(" · ")}` : "contrast: no hero region",
        wash.length ? `HERO-WASHOUT: ${wash.map((f) => f.pieceId).join(", ")}` : "washout: clean",
        dens.length ? `density findings: ${dens.map((f) => f.kind).join(", ")}` : "density findings: clean",
        rtb.length ? `render-truth blocking: ${rtb.map((f) => f.kind).join(", ")}` : "render-truth: clean",
        v ? (v.actionable.length === 0 ? "vision: CLEAN" : `vision: ${v.actionable.length} issue(s)${v.severe.length ? ` (${v.severe.length} severe)` : ""}`) : "vision: n/a",
      ].join("\n");
      const shot = path.join(GEN_DIR, `measure-scene-${i}.png`);
      const exists = await fs.stat(shot).then(() => true).catch(() => false);
      if (exists && !m?.error) {
        await fs.copyFile(shot, path.join(OUT_DIR, "v6", `scene${i}.png`));
        v6Cells.push({ scene: i, png: `v6/scene${i}.png`, label: script.scenes[i]?.label ?? `scene ${i}`, note });
      } else {
        v6Cells.push({ scene: i, label: script.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
      }
    }

    // ── REFERENCE ROW: reassemble + re-render via the same measure path ──────
    const reference = await phase("reference-row", async () => {
      const refCode = reassemble(await readDecomposed(REF_DIR));
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rb-a6-ref-"));
      await fs.writeFile(path.join(tmp, "Composition.tsx"), refCode, "utf8");
      for (const shim of SHIMS) await fs.copyFile(path.join(REF_DIR, shim), path.join(tmp, shim)).catch(() => {});
      const refMeasurements = await measureScenes(tmp, refScript, path.join(OUT_DIR, "reference"));
      const refProfile = buildDensityProfile(refCode, refScript);
      const refContrast = await sampleContrast(refMeasurements);
      await fs.rm(tmp, { recursive: true, force: true });
      const cells: RowCell[] = [];
      for (const i of SCENES) {
        const src = path.join(OUT_DIR, "reference", `measure-scene-${i}.png`);
        const dst = path.join(OUT_DIR, "reference", `scene${i}.png`);
        const ok = await fs.rename(src, dst).then(() => true).catch(() => false);
        const p = refProfile.scenes.find((s) => s.scene === i);
        const cst = refContrast.cells.filter((c) => c.scene === i);
        const note = [
          p ? (p.ssrError ? "SSR ERROR" : `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · depth ${p.depth}`) : "no data",
          cst.length ? `contrast${cst[0].proxy ? " (main-diegetic proxy — the reference's lego pieces are content-named, no .hero ids)" : ""}: ${cst.map((c) => `${c.pieceId} spread ${c.spread}/std ${c.stdDev}`).join(" · ")}` : "contrast: n/a",
        ].join("\n");
        cells.push({ scene: i, ...(ok ? { png: `reference/scene${i}.png` } : {}), label: refScript.scenes[i]?.label ?? `scene ${i}`, note });
      }
      console.log(`  reference re-rendered: ${cells.filter((c) => c.png).length}/5 scenes · contrast cells ${refContrast.cells.length}${refContrast.errors.length ? ` · errors ${refContrast.errors.join(" | ")}` : ""}`);
      return { cells, profile: refProfile, contrast: refContrast.cells, contrastErrors: refContrast.errors };
    });
    report.reference = { densityProfile: reference.profile, contrast: reference.contrast, contrastErrors: reference.contrastErrors };

    // v6 contrast cells for the gallery table (heroes only — cast builds
    // always carry .hero pieces).
    const v6ContrastCells: ContrastCell[] = (finalContrast?.stats ?? []).map((s) => ({
      ...s,
      proxy: false,
      washout: !!finalContrast?.findings.find((f) => f.scene === s.scene && f.pieceId === s.pieceId),
    }));

    // ── GALLERY ──────────────────────────────────────────────────────────────
    await phase("gallery", async () => {
      const cost = report.cost as { fireworks: { usd: number; calls: number }; cerebras: { usd: number; calls: number }; zaiVision: { usd: number; calls: number }; totalUsd: number };
      const wall = report.wall as { totalRunSeconds: number; scriptToPreviewSeconds: number | null; castWallSeconds: number };
      const scriptRep = report.script as Record<string, unknown>;
      const dsRep = report.designSystem as Record<string, unknown>;
      const bpRep = report.blueprints as Record<string, unknown>;

      const phases = marks;
      const total = Math.max(1, ...phases.map((p) => p.endS));
      const palette = ["#4f8cc9", "#c98a4f", "#6cb56c", "#b5646c", "#8a6cb5", "#5fb0a8", "#b0a85f", "#c9654f", "#4fc9a1", "#7d8fc9", "#c94f9e", "#9ec94f"];
      const bars = phases
        .map((p, i) => {
          const left = (p.startS / total) * 100;
          const width = Math.max(0.4, ((p.endS - p.startS) / total) * 100);
          return `<div class="bar" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${palette[i % palette.length]}" title="${esc(p.phase)}: ${p.startS}s → ${p.endS}s (${(p.endS - p.startS).toFixed(1)}s)"></div>`;
        })
        .join("");
      const legend = phases
        .map((p, i) => `<span class="lg"><i style="background:${palette[i % palette.length]}"></i>${esc(p.phase)} ${(p.endS - p.startS).toFixed(1)}s</span>`)
        .join(" ");

      const scriptLogHtml = scriptAttemptLog
        .map((a) => `<li><b>attempt ${a.attempt}</b> — ${a.secs.toFixed(1)}s · ${a.in} in / ${a.out} out · stop ${esc(String(a.stop))} · ${a.error ? `<span class="bad-line">INVALID</span>: ${esc(a.error.slice(0, 400))}` : `<span class="ok-line">VALID</span>`}</li>`)
        .join("\n");
      const bpLogHtml = blueprintAttempts
        .map((a) => `<li><b>attempt ${a.attempt}</b> — ${a.secs.toFixed(1)}s · ${a.tokensIn} in / ${a.tokensOut} out · stop ${esc(String(a.stop))}${a.errors.length ? `<ul>${a.errors.map((e) => `<li>${esc(e.slice(0, 300))}</li>`).join("")}</ul>` : ` · <span class="ok-line">clean</span>`}</li>`)
        .join("\n");

      const densityTable = `
  <div class="scroll"><table>
    <tr>
      <th rowspan="2">scene</th>
      <th colspan="5">v6 — GLM-5.2 @ Fireworks (this run, all heads generated)</th>
      <th colspan="5">Klarna GLM reference (reassembled + re-measured)</th>
    </tr>
    <tr>
      ${[0, 1].map(() => `<th>best diegetic (≥${DIEGETIC_MIN_ELEMENTS}/${DIEGETIC_MIN_TEXT_NODES})</th><th>hero (≥${HERO_MIN_ELEMENTS}/${HERO_MIN_TEXT_NODES})</th><th>depth (≥${DEPTH_FLOOR})</th><th>grad sigs</th><th>bad img</th>`).join("")}
    </tr>
    ${SCENES.map(
      (i) => `<tr><td>scene ${i}</td>${densityCellHtml(profile?.scenes.find((s) => s.scene === i))}${densityCellHtml(reference.profile.scenes.find((s) => s.scene === i))}</tr>`,
    ).join("\n")}
    <tr>
      <td>video-level</td>
      <td colspan="5" class="${profile && profile.varietyPass ? "ok" : "bad"}">${profile ? `${profile.distinctSignatures} distinct sigs (≥${MIN_GRADIENT_SIGNATURES}); ${profile.repeated.length} repeated violation(s)` : "n/a"}</td>
      <td colspan="5" class="${reference.profile.varietyPass ? "ok" : "bad"}">${reference.profile.distinctSignatures} distinct sigs; ${reference.profile.repeated.length} repeated violation(s)</td>
    </tr>
  </table></div>`;

      const contrastTable = `
  <div class="scroll"><table>
    <tr><th rowspan="2">scene</th><th colspan="2">v6 hero region</th><th colspan="2">reference (hero or main-diegetic proxy)</th></tr>
    <tr><th>piece</th><th>luminance (washout = spread&lt;${WASHOUT_SPREAD_FLOOR} AND std&lt;${WASHOUT_STDDEV_FLOOR})</th><th>piece</th><th>luminance</th></tr>
    ${SCENES.map((i) => `<tr><td>scene ${i}</td>${contrastCellHtml(v6ContrastCells, i)}${contrastCellHtml(reference.contrast, i)}</tr>`).join("\n")}
  </table></div>`;

      const headline = [
        `brand ${BRAND} (ref ${REF_BUILD})`,
        `script ${scriptRep.generated ? `GENERATED (attempt ${scriptRep.attempts})` : "REFERENCE FALLBACK"}`,
        `DS ${dsRep.acceptedFromModel ? (dsRep.repaired ? "ok after 1 repair" : "ok first try") : "FELL BACK"}${dsRep.inkNeutralized ? " · ink neutralized" : ""}`,
        `blueprints ${bpRep.validatedClean ? `clean on attempt ${bpRep.attempts}` : `RESIDUALS after ${bpRep.attempts}`}`,
        `${gateRounds.length} gate round(s)`,
        `${totalLlmCalls}/${TOTAL_LLM_CEILING} LLM calls`,
        `$${cost.totalUsd.toFixed(3)}`,
      ].join(" · ");
      report.headline = headline;

      const finalG = gateRounds[gateRounds.length - 1];
      const summary = finalG
        ? `final residuals: density ${finalG.density.length} · washout ${finalG.heroContrast.findings.length} · structural ${finalG.structural.length} · rt-blocking ${finalG.renderTruthBlocking.length} · vision-severe scenes [${finalG.vision.filter((v) => v.severe.length).map((v) => v.scene).join(", ") || "none"}] · sequence findings ${sequenceFinal.length}`
        : "NO GATE ROUNDS";

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceptance v6 — ${esc(BRAND)}: full generated build (GLM-5.2 @ Fireworks) vs the GLM reference</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; }
  h2 { font-size: 15px; font-weight: 700; margin: 26px 0 10px; color: #c9cad1; }
  h3 { font-size: 12px; font-family: ui-monospace, Menlo, monospace; margin: 14px 0 6px; color: #a9aab3; }
  .banner { background: #1a2620; border: 1px solid #2c4a38; border-radius: 8px; padding: 12px 14px; margin: 14px 0; color: #9fd8b4; font-size: 13px; }
  .sub { font-family: ui-monospace, Menlo, monospace; color: #9a9aa3; margin: 8px 0 8px; font-size: 12px; }
  .ok-line { color: #6cb56c; }
  .bad-line { color: #e0245e; font-weight: 700; }
  .row { display: grid; grid-template-columns: repeat(5, minmax(280px, 1fr)); gap: 14px; align-items: start; }
  .cell { background: #16171c; border: 1px solid #26272e; border-radius: 8px; padding: 8px; }
  .cell-title { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-bottom: 6px; }
  .cell img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 4px; background: #000; }
  .cell a { display: block; }
  .stat { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-top: 8px; white-space: pre-wrap; }
  .err { aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; border: 2px dashed #e0245e; border-radius: 4px; color: #e0245e; font-weight: 700; }
  .timeline { position: relative; height: 34px; background: #16171c; border: 1px solid #26272e; border-radius: 6px; overflow: hidden; margin: 6px 0 8px; }
  .bar { position: absolute; top: 4px; bottom: 4px; border-radius: 3px; opacity: .9; }
  .lg { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-right: 10px; white-space: nowrap; display: inline-block; }
  .lg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
  ul { margin: 4px 0 4px 18px; }
  li { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #b9bac2; margin: 3px 0; }
  table { border-collapse: collapse; margin: 8px 0; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  th, td { border: 1px solid #26272e; padding: 5px 9px; text-align: center; color: #b9bac2; }
  th { background: #16171c; color: #8a8a93; }
  td.ok { color: #6cb56c; }
  td.bad { color: #e0245e; font-weight: 700; }
  details { margin: 8px 0; }
  summary { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #c9cad1; cursor: pointer; }
  .scroll { overflow-x: auto; }
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 1100px; }
</style>
</head>
<body>
  <h1>Acceptance v6 — ${esc(BRAND)}: the full generated build on the v5 stack</h1>
  <div class="banner"><b>NOTHING REUSED:</b> script, design system, and blueprints were all GENERATED this run
  (script + DS on GLM-5.2 @ Fireworks effort high; blueprints on gpt-oss-120b @ Cerebras effort high; cast on
  GLM-5.2 @ Fireworks — the v5 stack). Two v5 gate leaks are fixed and wired BLOCKING: the per-hero density floor
  (≥${HERO_MIN_ELEMENTS}el/≥${HERO_MIN_TEXT_NODES}tx in the hero ITSELF) and the deterministic hero-washout contrast check
  (spread&lt;${WASHOUT_SPREAD_FLOOR} AND std&lt;${WASHOUT_STDDEV_FLOOR} on the hero's rendered pixels).</div>
  <div class="sub">${esc(headline)}</div>
  <div class="sub">${esc(summary)}</div>
  <div class="sub">wall: script→preview ${wall.scriptToPreviewSeconds ?? "—"}s · cast wall ${wall.castWallSeconds}s · run total ${wall.totalRunSeconds.toFixed(1)}s ·
  cost split: Fireworks $${cost.fireworks.usd.toFixed(4)} (${cost.fireworks.calls} calls) + Cerebras $${cost.cerebras.usd.toFixed(4)} (${cost.cerebras.calls} calls) + z.ai vision $${cost.zaiVision.usd.toFixed(4)} (${cost.zaiVision.calls} calls) = <b>$${cost.totalUsd.toFixed(4)}</b></div>

  <h2>Row — v6 (this run)</h2>
  <div class="row">
${rowGrid(v6Cells)}
  </div>

  <h2>Row — ${esc(BRAND)} GLM reference (reassembled from lego, re-rendered through the same measure path)</h2>
  <div class="row">
${rowGrid(reference.cells)}
  </div>

  <h2>Density — per scene per clause, both rows (incl. the NEW per-hero floor)</h2>
  ${densityTable}

  <h2>Hero contrast — luminance spread / std-dev per scene, both rows</h2>
  ${contrastTable}
  <div class="sub">reference row: the lego pieces are content-named (s0.checkout, s3.grid…) with no ".hero" ids — its
  cells sample the LARGEST diegetic piece as a documented proxy for the scene's hero.</div>

  <h2>Script richness loop (${esc(String(scriptRep.source ?? ""))})</h2>
  <ul>${scriptLogHtml || "<li>no attempts logged</li>"}</ul>

  <h2>Blueprint attempts (gpt-oss-120b @ Cerebras, validate=checkSceneComposition)</h2>
  <ul>${bpLogHtml || "<li>no attempts logged</li>"}</ul>
  <div class="sub">${esc(String((bpRep.validatedClean ? "validated clean" : `residuals: ${JSON.stringify(bpRep.residualErrors).slice(0, 300)}`)))}</div>

  <h2>Design system</h2>
  <div class="sub">${dsRep.acceptedFromModel ? `accepted from the model${dsRep.repaired ? " after ONE repair" : " first try"}` : `FELL BACK to reference consts (${esc(String(dsRep.error)).slice(0, 200)})`} ·
  ink ${dsRep.inkNeutralized ? "<b>NEUTRALIZED by neutralizeInk (saturated brand hue was cast as text ink)</b>" : "passed neutralizeInk unchanged"} ·
  required keyframes merged: ${esc(((dsRep.requiredKeyframesInjected as string[]) ?? []).join(", ") || "none")}</div>

  <details><summary>gate log — round by round (density · hero-contrast · structural · render-truth · vision)</summary>${gateLogHtml(gateRounds, sequenceFinal)}</details>
  <details><summary>per-call log (label / model / secs / tokens / stop)</summary>${callLogHtml()}</details>

  <h2>Phase timeline</h2>
  <div class="timeline">${bars}</div>
  <div>${legend}</div>

  <div class="foot">
    v6 = the FULL pipeline, nothing reused: generated script (production Agent-1 contract + richness validators,
    ≤${SCRIPT_MAX_ATTEMPTS} attempts, reference fallback only on terminal failure) → generated design system (ONE repair retry,
    reference-const fallback) → generated blueprints (composition head on gpt-oss, ≤3 attempts, residuals ship with
    the gates as backstop) → GLM-5.2 @ Fireworks element cast → the v5 gate loop with the two NEW blocking gates.
    Budget: ≤${TOTAL_LLM_CEILING} TOTAL LLM calls (text + vision); retries ≤${MAX_RETRY_ROUNDS} rounds; sequence vision ONCE post-final.
    brandColorFidelity advisory skipped (palette-driven; not this run's question).
  </div>
</body>
</html>
`;
      await writeOut();
      await fs.writeFile(path.join(OUT_DIR, "index.html"), html, "utf8");
    });

    // ── console summary ──────────────────────────────────────────────────────
    const cost = report.cost as { fireworks: { usd: number }; cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
    console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
    console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
    console.log(`genDir:  ${GEN_DIR}`);
    console.log(
      `${totalLlmCalls}/${TOTAL_LLM_CEILING} LLM calls · Fireworks $${cost.fireworks.usd.toFixed(4)} + Cerebras $${cost.cerebras.usd.toFixed(4)} + vision $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)}`,
    );
    console.log("\nPHASE TIMELINE:");
    for (const m of marks) console.log(`  ${m.phase.padEnd(34)} ${String(m.startS).padStart(7)}s → ${String(m.endS).padStart(7)}s  (${(m.endS - m.startS).toFixed(1)}s)`);
  } catch (err) {
    report.terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nTERMINAL: ${report.terminalError}`);
    await writeOut().catch(() => {});
    process.exitCode = 1;
  }
};

await main();
