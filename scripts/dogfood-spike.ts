/**
 * DOGFOOD RUNNER (v12) — the acceptance8 pipeline, GENERALIZED to any stored
 * brief. Same stack, same gates, same retry discipline; the Klarna-specific
 * scaffolding (reference build, v7 comparison rows) is gone or optional.
 *
 * v12 (dogfood cycle 4 batch):
 *   - CLASS-MATCHED no-progress breaker: retry progress is measured on the
 *     finding class that TARGETED the piece (washout → the gate's measured
 *     spread/std; render-truth → that piece's blocking-finding count;
 *     density → el/tx; accent-fill → largest-rect frac). One escalation max;
 *     a same-class failure after escalation ACCEPTS-AND-FLAGS — never a third
 *     identical round (cycle 3 escalated a 148el/54tx hero for "density
 *     unmoved" while its real problem was cross-piece overlap).
 *   - GATE→BACKSTOP washout closure: when the render-side washout gate fires,
 *     the runner FORCES the surface lift (cast-build forceHeroSurfaceLift)
 *     using the MEASURED screenshot colors — gradients/rgba/unparseable
 *     styles included (root-override arm) — then re-measures; only residuals
 *     route to regen, with an EXPLICIT lighten/darken instruction. Invariant:
 *     a washout finding on round N produces a lift or an explicit regen by
 *     round N+1, never a no-op (cycle 3's s4.hero washed out 3 rounds with
 *     heroSurfaceCorrections=0).
 *   - CROSS-PIECE text collision generalized (render-truth-gates Case D):
 *     copy-class canvas text overlapping ANOTHER piece's text nodes at any
 *     size pairing = blocking, routed to BOTH pieces with role-split repair
 *     instructions (hero shrinks into its slot / copy gets an opaque panel);
 *     composition head gains the MOCK TERRITORY clause (a full-canvas app
 *     shell forfeits the copy column).
 *   - BROKEN-IMAGE swap at measure time: any <img> whose decoded
 *     naturalWidth === 0 (the browser's own verdict — cycle 3 shipped three
 *     differently-corrupted logo data: URIs that all probed "fetchable")
 *     swaps deterministically to a text wordmark in the display face
 *     (image-integrity swapBrokenImagesForWordmark) + structural finding
 *     img_broken.
 *
 * v11 (dogfood cycle 3 batch):
 *   - META-TEXT LEAK gate (cast-build stripMetaText): reasoning prose rendered
 *     as JSX text nodes strips deterministically at the element gate; a body
 *     dominated by its own reasoning rejects (cycle-2 s2's shipped paragraph).
 *   - Unowned-copy BINDING check (cast-build stripUnownedBindings): c.<field>
 *     references for unowned fields strip/reject in-round; the literal value
 *     guard widens to eyebrow/caption/cta with punct/case variants (cycle-2
 *     s4's duplicated headline+CTA class).
 *   - CLAMP-VS-SLOT routing (render-truth-gates planEdgeCropMoves): a piece
 *     >25% oversized for its slot, or whose clamp would land on a neighbor's
 *     territory, routes DIRECTLY to regen (cycle-2's clamp ricochet).
 *   - Full-bleed vertical-fill clause at the composition head + register-aware
 *     barbell repair (full-bleed barbells route to the HERO).
 *   - Logo-glyph count finding (>1 brand mark per hero mock) + interior-clip
 *     advisory (text protruding >30% past its piece union).
 *   - The detached sequence verdict fires on round-0 frames and THREADS into
 *     round-1+ regen prompts as "sequence notes to avoid".
 *
 * v10 (dogfood cycle 2 batch):
 *   - ACCENT-AS-FILL blocking gate (lib/render/accent-fill.ts): the largest
 *     flat accent-colored rectangle inside each hero region must stay under
 *     30% of the piece area (cycle-1 s3's #00ff00 slab class).
 *   - PIECE-EDGE-CROP: measured pieces clipping the canvas bottom/right by
 *     >2% of their own size are CLAMPED deterministically in the assembled
 *     code (assemble.ts clampPieceOffsets) and re-measured; only residuals
 *     route to a regen. Composer side: the bottom-reserve invariant.
 *   - SEQUENCE VISION fully detached: the gallery + report are written FIRST
 *     with a pending marker; the verdict patches them in when/if it lands
 *     (wall never includes it), and one abort SKIPS it (no retry).
 *   - Blueprint validation adds the narrow ungrounded mock-value deny-list
 *     (EST-dates / %-OFF against the grounding sources).
 *
 * PARAMS (env or argv):
 *   RB_DOGFOOD_BRIEF / --brief=<briefId>   the stored brief to build (loadBrief)
 *   RB_DOGFOOD_TAG   / --tag=<brand>       short brand slug for output paths
 *   RB_DOGFOOD_CYCLE / --cycle=<N>         dogfood cycle number (default 1)
 *   RB_DOGFOOD_OUT   / (optional)          override the full output dir
 *
 * Output: .data/dogfood/cycle<N>-<tag>/ — build-report.json, scene PNGs,
 * index.html (single-row gallery + the full telemetry panels: phase timeline,
 * retry/attempt panel, density + hero-contrast tables, script/blueprint logs,
 * gate log, per-call log).
 *
 * DIFFERENCES vs scripts/acceptance8-spike.ts (everything else is identical —
 * fast router + std fallback, ≤80-call ceiling, all blocking gates incl. the
 * per-hero floor and hero-washout, script surgical repairs + effort ladder,
 * blueprint head, no-progress breaker, sequence vision off the critical path):
 *   - brief loads by ID via loadBrief (not loadBriefByScriptId) — no reference
 *     build required; when none exists nothing is compared against (reference
 *     row skipped gracefully).
 *   - Theme fonts come from the CRAWL (font_roles + @font-face srcs), not a
 *     reference preamble; brand font URLs are data:-inlined at finalize
 *     (inlineFontFaces) so the measure/vision path sees the real faces.
 *   - Shims (Img/Piece/BrandChrome/Lottie/Video) are written from
 *     build-wrapper's canonical sources, not copied from a reference build.
 *   - The DS fallback theme is synthesized from the canvas plan + signature
 *     (no reference PALETTE to borrow).
 *   - v9 surgical patches may also correct a scene's `register` (the new
 *     archetype-variety validator class is field-scoped).
 *
 *   set -a && source .env.local && set +a && \
 *     RB_DOGFOOD_BRIEF=<id> RB_DOGFOOD_TAG=<brand> node scripts/dogfood-spike.mjs
 *
 * Footprint: this file + scripts/dogfood-spike.mjs + .data/dogfood/cycle* +
 * src/generated/CAST_SPIKE_DOGFOOD_<TAG>. Reads everything, modifies nothing else.
 */
import { promises as fs } from "fs";
import path from "path";
import { neutralizeInk, type CastBuildResult } from "../lib/agents/cast-build";
import { castCall, castConfigured, type CastResult } from "../lib/llm/cast-provider";
import { generateComposition, type CompositionCaller } from "../lib/agents/composition-head";
import type { Theme } from "../lib/edit/piece-model";
import type { Script, Scene } from "../src/schema";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
import { type SceneMeasurement } from "../lib/render/measure-scene";
import { type RenderTruthKind } from "../lib/render/render-truth-gates";
import {
  DIEGETIC_MIN_ELEMENTS,
  DIEGETIC_MIN_TEXT_NODES,
  HERO_MIN_ELEMENTS,
  HERO_MIN_TEXT_NODES,
  DEPTH_FLOOR,
  MIN_GRADIENT_SIGNATURES,
} from "../lib/render/density-gates";
import {
  WASHOUT_SPREAD_FLOOR,
  WASHOUT_STDDEV_FLOOR,
  HERO_UNDERSCALE_MIN_FRAC,
  type HeroContrastResult,
  type HeroLuminanceStats,
} from "../lib/render/hero-contrast";
import { ACCENT_FILL_MAX_FRAC, type AccentFillResult } from "../lib/render/accent-fill";
import {
  buildRubric,
  parseVerdict,
  isSanctionedChromeFinding,
  judgeSequence,
  stampSceneIndexBadge,
  type SequenceJudge,
  type VisionFinding,
} from "../lib/render/vision-gate";
import { callZaiVision } from "../lib/render/zai-vision";
import { VISION_MODEL } from "../lib/anthropic";
import { costUsd, addUsage, EMPTY_USAGE, type Usage } from "../lib/usage";
import { resolveCanvasPlan, signatureWithLogoFallback } from "../lib/crawl/brand-identity";
import { preflightBrandTruth, type BrandTruthReport } from "../lib/crawl/brand-truth";
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
  findUngroundedMockValues,
} from "../lib/agents/schema-validator";
import {
  IMG_SHIM_SOURCE,
  PIECE_SHIM_SOURCE,
  VIDEO_SHIM_SOURCE,
  LOTTIE_SHIM_SOURCE,
  BRAND_CHROME_SOURCE,
} from "../lib/render/build-wrapper";
import { loadBrief, DEV_OWNER_ID, type StoredBrief } from "../lib/store";
import { withDbRetry } from "../lib/db";
import { ulid } from "../lib/ulid";
import {
  runQualityLoop,
  type QualityLoopTransport,
  type FailureClass,
  type StructuralFinding,
  type SceneVisionVerdict,
  type BrandTruthLite,
  type DensityProfile,
  type SceneDensityProfile,
  type GateRoundReport,
  type EdgeCropEvent,
  type WashoutLiftEvent,
  type ImgSwapEvent,
  type StrayFragmentEvent,
  type BindCopyEvent,
  type NoProgressEvent,
  type CacheBustEvent,
  type LoopScript,
} from "../lib/render/quality-loop";

// ── params ───────────────────────────────────────────────────────────────────

const argOf = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const BRIEF_ID = argOf("brief") ?? process.env.RB_DOGFOOD_BRIEF ?? "";
const TAG = (argOf("tag") ?? process.env.RB_DOGFOOD_TAG ?? "brand")
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "");
const CYCLE = argOf("cycle") ?? process.env.RB_DOGFOOD_CYCLE ?? "1";

// ── constants (a8's, minus the reference scaffolding) ────────────────────────

const ROOT = process.cwd();
const OUT_DIR =
  process.env.RB_DOGFOOD_OUT ?? path.join(ROOT, ".data", "dogfood", `cycle${CYCLE}-${TAG}`);
const GEN_DIR = path.join(
  ROOT,
  "src",
  "generated",
  `CAST_SPIKE_DOGFOOD_${TAG.toUpperCase().replace(/-/g, "_") || "BRAND"}`,
);
const SCENES = [0, 1, 2, 3, 4];
/** Brand display name — set from the crawl title after the brief loads. */
let BRAND = TAG || "brand";

/** STANDARD tier — the per-call fallback when the fast router errors or
 *  degrades. */
const FIREWORKS_GLM = "accounts/fireworks/models/glm-5p2";
/** FAST tier — same GLM-5.2 weights, measured 232-274 tok/s single-stream. */
const FIREWORKS_GLM_FAST = "accounts/fireworks/routers/glm-5p2-fast";
const FAST_SUSTAINED_FLOOR_TOKS = 150;
/** The proven blueprint author (acceptance v2): gpt-oss-120b @ Cerebras. */
const BLUEPRINT_MODEL = "gpt-oss-120b";
const HEAD_EFFORT = "high" as const;
const SCRIPT_EFFORT = "low" as const;
const SCRIPT_EFFORT_LADDER: ("low" | "medium" | "high")[] = ["low", "medium", "high"];
const SCRIPT_MAX_TOKENS = 16000;
const DS_MAX_TOKENS = 10000;
const SCRIPT_MAX_ATTEMPTS = 3;
const SCRIPT_MAX_SURGICAL = 2;

/** ≤80 TOTAL LLM calls — text (Fireworks + Cerebras) AND vision all count. */
const TOTAL_LLM_CEILING = 80;
const MAX_RETRY_ROUNDS = 2;

const MODEL_PRICES: Record<string, [number, number]> = {
  "accounts/fireworks/models/glm-5p2": [1.4, 4.4],
  "accounts/fireworks/routers/glm-5p2-fast": [2.1, 6.6],
  "gpt-oss-120b": [0.35, 0.75],
};

const BLOCKING_KINDS: RenderTruthKind[] = [
  "overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness", "stranded-hero",
];
/** v10 edge-crop clamp: pieces shift up/left by the measured overflow PLUS
 *  this breath, so a clamped piece never sits flush against the frame edge. */
const EDGE_CLAMP_MARGIN_PX = 12;
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
  label: string; model: string; secs: number; in: number; out: number; stop: string | null; cached: boolean; tokPerSec?: number;
}
const callLog: CallLogRow[] = [];
let totalLlmCalls = 0;
let budgetExhausted = false;
const perModel: Record<string, { calls: number; in: number; out: number }> = {};

const ensureBudget = (at: string): void => {
  if (totalLlmCalls >= TOTAL_LLM_CEILING) {
    budgetExhausted = true;
    throw new BudgetExceeded(`TOTAL LLM ceiling (${TOTAL_LLM_CEILING}) reached at "${at}" — aborted honestly`);
  }
};

// ── fast-router health: observe, degrade loudly, never die ──────────────────

const fastSamples: { label: string; toks: number; out: number; secs: number }[] = [];
let fastRouterDegraded = false;
const fastFallbacks: { label: string; reason: string }[] = [];
const noteFastSample = (label: string, r: CastResult): void => {
  if (r.outputTokens < 300 || r.seconds <= 0.5) return;
  const toks = Math.round((r.outputTokens / r.seconds) * 10) / 10;
  fastSamples.push({ label, toks, out: r.outputTokens, secs: r.seconds });
  if (fastRouterDegraded || fastSamples.length < 4) return;
  const recent = fastSamples.slice(-6).map((s) => s.toks).sort((a, b) => a - b);
  const median = recent[Math.floor(recent.length / 2)];
  if (median < FAST_SUSTAINED_FLOOR_TOKS) {
    fastRouterDegraded = true;
    console.error(
      `\n▲▲▲ FAST ROUTER UNDERPERFORMING: median ${median} tok/s across the last ${recent.length} sizeable calls (floor ${FAST_SUSTAINED_FLOOR_TOKS}). ` +
        `Every subsequent fast-routed call FALLS BACK to the standard tier.\n`,
    );
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const fastRetryEvents: { label: string; reason: string; recovered: boolean }[] = [];

const budgetedCast = async (
  label: string,
  args: { system: string; user: string; maxTokens: number; model: string; effort?: "none" | "low" | "medium" | "high"; json?: boolean },
): Promise<CastResult> => {
  const wantFast = args.model === FIREWORKS_GLM_FAST;
  if (wantFast && fastRouterDegraded) fastFallbacks.push({ label, reason: `sustained tok/s under the ${FAST_SUSTAINED_FLOOR_TOKS} floor` });
  const fire = async (model: string, capOverride?: number): Promise<CastResult> => {
    ensureBudget(label);
    totalLlmCalls += 1;
    const r = await castCall({ ...args, maxTokens: capOverride ?? args.maxTokens, model });
    const pm = (perModel[model] ??= { calls: 0, in: 0, out: 0 });
    pm.calls += 1;
    pm.in += r.inputTokens;
    pm.out += r.outputTokens;
    callLog.push({
      label: `${model === args.model ? label : `${label}:std-fallback`}${capOverride ? ":len-retry" : ""}`,
      model,
      secs: r.seconds,
      in: r.inputTokens,
      out: r.outputTokens,
      stop: r.stopReason,
      cached: false,
      ...(r.seconds > 0 ? { tokPerSec: Math.round((r.outputTokens / r.seconds) * 10) / 10 } : {}),
    });
    if (model === FIREWORKS_GLM_FAST) noteFastSample(label, r);
    return r;
  };
  // GENERIC stop=length rule: truncated output is NEVER parsed. One immediate
  // cap-raise retry (×1.8, bounded 40k) — the retry result wins either way.
  const fireLengthAware = async (model: string): Promise<CastResult> => {
    const first = await fire(model);
    if (first.stopReason !== "length") return first;
    const retryCap = Math.min(Math.ceil(args.maxTokens * 1.8), 40000);
    console.warn(`  [stop=length] ${label}: truncated at cap ${args.maxTokens} — ONE cap-raise retry at ${retryCap}`);
    const retry = await fire(model, retryCap);
    stopLengthEvents.push({ label, cap: args.maxTokens, retryCap, recovered: retry.stopReason !== "length" });
    return retry;
  };
  try {
    return await fireLengthAware(wantFast && fastRouterDegraded ? FIREWORKS_GLM : args.model);
  } catch (e) {
    if (!wantFast || fastRouterDegraded || e instanceof BudgetExceeded) throw e;
    const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.warn(`  ▲ fast router error on "${label}" (${reason}) — ONE jittered fast retry before any std fallback`);
    await sleep(1500 + Math.random() * 2500);
    try {
      const r = await fireLengthAware(args.model);
      fastRetryEvents.push({ label, reason, recovered: true });
      return r;
    } catch (e2) {
      if (e2 instanceof BudgetExceeded) throw e2;
      fastRetryEvents.push({ label, reason, recovered: false });
      const reason2 = e2 instanceof Error ? e2.message.split("\n")[0] : String(e2);
      console.error(`  ▲▲▲ fast retry failed too on "${label}" (${reason2}) — per-call fallback to the STANDARD tier`);
      fastFallbacks.push({ label, reason: reason2 });
      return fireLengthAware(FIREWORKS_GLM);
    }
  }
};

// z.ai vision spend — counts against the SAME total-call ceiling.
let zaiUsage: Usage = { ...EMPTY_USAGE };
let zaiCalls = 0;
const visionBudgetOk = (): boolean => totalLlmCalls < TOTAL_LLM_CEILING;
const countVisionCall = (): void => {
  totalLlmCalls += 1;
  zaiCalls += 1;
};

// ── report sinks for the shared quality loop (v16: the caching caller, piece
// cache, class-matched breaker, and gate battery all live in
// lib/render/quality-loop.ts — runQualityLoop; these arrays receive the loop's
// returned telemetry so writeOut + the gallery are unchanged) ────────────────

/** v11 (#7): the detached sequence verdict, persisted into the run context the
 *  moment it lands — every SUBSEQUENT regen prompt carries these as negative
 *  guidance ("sequence notes to avoid"). Read by the loop via getSequenceNotes;
 *  set here by the detached sequence judge (fireSequenceDetached). */
let sequenceNotes: string[] = [];
const stopLengthEvents: { label: string; cap: number; retryCap: number; recovered: boolean }[] = [];
const cacheBustEvents: CacheBustEvent[] = [];
const noProgressEvents: NoProgressEvent[] = [];
const washoutLiftEvents: WashoutLiftEvent[] = [];
const imgSwapEvents: ImgSwapEvent[] = [];
const strayFragmentEvents: StrayFragmentEvent[] = [];
const bindCopyEvents: BindCopyEvent[] = [];

// ── small utilities (a8's, verbatim) ─────────────────────────────────────────

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

// ── SCRIPT phase helpers (production replicas, a8's) ─────────────────────────

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

/** Salvage parser — when JSON.parse rejects the whole output, scan to the
 *  first '{', brace-balance (string-aware), and try the span. */
const salvageParse = (raw: string): { parsed: unknown; salvaged: boolean } | { error: string } => {
  const cleaned = stripCodeFence(raw.trim());
  let firstErr: string;
  try {
    return { parsed: JSON.parse(cleaned), salvaged: false };
  } catch (err) {
    firstErr = err instanceof Error ? err.message : String(err);
  }
  const start = cleaned.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return { parsed: JSON.parse(cleaned.slice(start, i + 1)), salvaged: true };
          } catch {
            /* span didn't parse either — fall through to the error */
          }
          break;
        }
      }
    }
  }
  return { error: `Output was not valid JSON (${firstErr}). Emit ONLY the Script JSON object. No prose, no markdown fence.` };
};

/** The failure classes a surgical field-patch can fix. v9 adds the register
 *  archetype-variety class (patchable: `{"index":N,"register":"stat"}`). */
const FIELD_SCOPED_ERROR_RX: RegExp[] = [
  /^Section \d+ content\.headline /,
  /^Scene \d+: latest timed beat /,
  /^Scene \d+: visual_concept too thin /,
  /^Scene \d+: names "/,
  /^Scenes [\d, ]+ share the same atmosphere phrase/,
  /^Scenes \d+-\d+ all use register /, // v9: archetype variety
  /^These numeric claims are NOT grounded/,
  /^These funding-stage labels aren't stated/,
  /^Type-only scenes /,
];
const isFieldScoped = (error: string): boolean => {
  const lines = error.split(/\n| \| /).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => FIELD_SCOPED_ERROR_RX.some((rx) => rx.test(line)));
};

type ScriptCheck =
  | { ok: true; script: LooseScript }
  | { ok: false; error: string; fieldScoped: boolean; normalized: unknown };

const processScriptObject = (parsed: unknown, brief: AgentBrief, briefId: string): ScriptCheck => {
  const withIdentity = injectIdentity(parsed, brief, briefId);
  const withAssets = mergePreallocatedAssets(withIdentity, brief);
  const normalized = backfillSceneRegisters(normalizeScriptContent(withAssets));
  const fail = (error: string): ScriptCheck => ({ ok: false, error, fieldScoped: isFieldScoped(error), normalized });
  const validation = validateScript(normalized);
  if (!validation.ok) return fail(validation.error);
  const script = validation.script as unknown as LooseScript;

  const wantSec = brief.duration_seconds;
  const gotSec = script.config?.duration_seconds ?? 0;
  if (typeof wantSec === "number" && wantSec > 0 && Math.abs(gotSec - wantSec) > 0.5) {
    return fail(`config.duration_seconds is ${gotSec}s but the brief requires EXACTLY ${wantSec}s. Set config.duration_seconds = ${wantSec} and re-tile ALL scenes to fill 0→${wantSec} with no gaps.`);
  }
  if (script.scenes.length !== 5) {
    return fail(`Script has ${script.scenes.length} scenes but the brief requires EXACTLY 5 sections (one per moment).`);
  }
  const sourceText = claimGroundingSources(brief);
  const copy = sceneClaimCopy(script.scenes as never);
  const ungrounded = findUngroundedClaims(copy, sourceText);
  const stages = findUngroundedStageLabels(copy, sourceText);
  if (ungrounded.length > 0 || stages.length > 0) {
    const parts: string[] = [];
    if (ungrounded.length > 0)
      parts.push(`These numeric claims are NOT grounded in any allowed source (the user's brief, verified claims, or the crawled site content): ${ungrounded.join(", ")}. For EACH exact token, either replace it with qualitative copy or with a fact that appears VERBATIM in the crawled content — never invent stats. (These tokens live in viewer-facing copy fields; plausible mock values inside a diegetic UI described in visual_concept are exempt set dressing — keep those concrete, never masked.)`);
    if (stages.length > 0)
      parts.push(`These funding-stage labels aren't stated anywhere in the brief or crawled content: ${stages.join(", ")}. Drop the invented label.`);
    return fail(parts.join("\n"));
  }
  const typeOnly = findTypeOnlyScenes(script.scenes as { visual_concept?: string }[]);
  if (typeOnly.length > 0) {
    return fail(`Type-only scenes (visual_concept is just a headline plus ambient decoration, nothing to look at): ${typeOnly.map((i) => `scene ${i}`).join(", ")}. EVERY scene must specify a concrete non-text/diegetic visual (a product mock, dashboard, diagram, chart, annotated illustration).`);
  }
  return { ok: true, script };
};

// ── surgical field-patch repair (a8's + v9 register support) ─────────────────

const SCENE_REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered"] as const;

const SURGICAL_SYSTEM = [
  `You repair ONE validation failure in an otherwise-valid animated-video Script JSON with a MINIMAL field patch.`,
  `You are given the full Script JSON and the validation errors verbatim. Reply with ONLY a JSON object of this exact shape — nothing else:`,
  `{"scenes":[{"index":<scene index>, "content":{<ONLY the corrected content fields>}, "visual_concept":"<the FULL corrected string — include ONLY when the error names visual_concept, timed beats, atmosphere phrasing, or a type-only scene>", "register":"<one of stat|quote|full-bleed|split|list|centered — include ONLY when the error names a register run>"}]}`,
  `Rules: patch ONLY the scenes and fields the errors name; leave every other word of the script untouched.`,
  `GROUNDING (HARD): any digit-bearing CLAIM token you ADD to a viewer-facing copy field (headline, lede, bullets, caption, eyebrow, meta, cta) — a price, percent, multiplier, count, or latency — must appear VERBATIM in the user message's "ALLOWED NUMBERS" block. If the number you want is not there, write the copy QUALITATIVELY instead; never invent stats. Exempt: timing beats ("at 2.4s") and diegetic mock-UI set-dressing values INSIDE visual_concept (prices/balances shown inside a rendered fake UI) — write those plausible and concrete, never masked ("$— — —"/"$X,XXX" are rejected).`,
  `A corrected visual_concept keeps its timed beats ("at 2.4s", "from 3.1s") reaching late into the scene and stays concrete (named drawable elements, real values, furnished containers).`,
].join("\n");

const applySurgicalPatch = (
  base: LooseScript,
  patch: unknown,
): { merged: unknown; touched: string[] } | { error: string } => {
  if (!Array.isArray(base?.scenes)) return { error: "no scene array to patch" };
  if (typeof patch !== "object" || patch === null || !Array.isArray((patch as { scenes?: unknown }).scenes)) {
    return { error: 'patch is not { "scenes": [...] }' };
  }
  const touched: string[] = [];
  const scenes = base.scenes.map((s) => ({ ...s, content: { ...(s.content ?? {}) } }));
  for (const entry of (patch as { scenes: unknown[] }).scenes) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const idx = typeof e.index === "number" ? e.index : -1;
    if (idx < 0 || idx >= scenes.length) return { error: `patch names scene index ${String(e.index)} — out of range` };
    if (e.content && typeof e.content === "object" && !Array.isArray(e.content)) {
      scenes[idx].content = { ...scenes[idx].content, ...(e.content as Record<string, unknown>) };
      touched.push(`s${idx}.content.{${Object.keys(e.content as object).join(",")}}`);
    }
    if (typeof e.visual_concept === "string" && e.visual_concept.trim()) {
      scenes[idx].visual_concept = e.visual_concept;
      touched.push(`s${idx}.visual_concept`);
    }
    // v9: register runs are field-scoped — a patch may reassign one.
    if (typeof e.register === "string" && (SCENE_REGISTERS as readonly string[]).includes(e.register)) {
      scenes[idx].register = e.register;
      touched.push(`s${idx}.register`);
    }
  }
  if (touched.length === 0) return { error: "patch touched no scene fields" };
  return { merged: { ...(base as unknown as Record<string, unknown>), scenes }, touched };
};

// ── DESIGN SYSTEM phase (a8's contract; keyframe donor = FALLBACK block) ─────

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

const parseDsEmission = (raw: string, donorKeyframesCss: string): DsParse => {
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
    const block = cssKeyframeBlock(donorKeyframesCss, name);
    if (block && lastTick !== -1) {
      kfDecl = kfDecl.slice(0, lastTick) + `\n  ${block}\n` + kfDecl.slice(lastTick);
      injected.push(name);
    }
  }
  decls.SHARED_KEYFRAMES = kfDecl;
  return { ok: true, decls, requiredKeyframesInjected: injected };
};

// ── Theme derivation — fonts come from the CRAWL, not a reference build ──────

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

/** CSS format() names per crawled font-format token. */
const CSS_FONT_FORMAT: Record<string, string> = {
  woff2: "woff2", woff: "woff", otf: "opentype", ttf: "truetype",
  eot: "embedded-opentype", svg: "svg", opentype: "opentype", truetype: "truetype",
};
const quoteFamily = (f: string): string => (/[^a-zA-Z0-9-]/.test(f) ? JSON.stringify(f) : f);

/** Theme fonts from the brand crawl: role-classified families lead their
 *  stacks; @font-face CSS is built from the crawled srcs (later data:-inlined
 *  at finalize so the measure/vision path loads them CORS-free). */
const fontsFromCrawl = (be: AgentBrandExtract | undefined): Theme["fonts"] => {
  const fam = be?.fonts ?? [];
  const roles = be?.font_roles ?? {};
  const display = roles.display ?? fam[0]?.family;
  const body = roles.body ?? roles.display ?? fam[1]?.family ?? fam[0]?.family;
  const mono = roles.mono;
  const stack = (primary: string | undefined, fallback: string): string =>
    primary ? `${quoteFamily(primary)}, ${fallback}` : fallback;
  const faces = fam
    .filter((f) => f.family && f.src)
    .map((f) => {
      const fmt = f.format ? CSS_FONT_FORMAT[f.format.toLowerCase()] ?? f.format : undefined;
      return `@font-face { font-family: ${JSON.stringify(f.family)}; src: url("${f.src}")${fmt ? ` format("${fmt}")` : ""};${f.weight ? ` font-weight: ${f.weight};` : ""}${f.style ? ` font-style: ${f.style};` : ""} font-display: swap; }`;
    });
  return {
    display: stack(display, "Inter, system-ui, sans-serif"),
    body: stack(body, "Inter, system-ui, sans-serif"),
    mono: stack(mono, 'ui-monospace, "SF Mono", Menlo, monospace'),
    fontFaceCss: faces.join("\n"),
  };
};

const themeFromDs = (
  decls: Record<(typeof DS_DECLS)[number], string>,
  fonts: Theme["fonts"],
  brandPalette: string[],
): Omit<DerivedTheme, "logoSrc"> => {
  const notes: string[] = [];
  const palette: Record<string, string> = {};
  const byOriginalKey: Record<string, string> = {};
  for (const m of decls.PALETTE.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g)) {
    palette[camelToConst(m[1])] = m[2];
    byOriginalKey[m[1]] = m[2];
  }
  if (Object.keys(palette).length === 0) throw new Error("themeFromDs: PALETTE parsed to zero entries");
  notes.push(
    `palette: head-emitted PALETTE keys re-spelled camelCase→CONST_CASE (${Object.keys(byOriginalKey).map((k) => `${k}→${camelToConst(k)}`).join(", ")}) — hex values carried verbatim.`,
  );
  const keyframes = extractTemplateConst(decls.SHARED_KEYFRAMES, "SHARED_KEYFRAMES") ?? "";
  notes.push("keyframes: head-emitted SHARED_KEYFRAMES carried verbatim (+ any required keyframes merged from the deterministic donor block).");
  notes.push("fonts: derived from the brand CRAWL (font_roles + @font-face srcs) — no reference build.");
  const grammar = grammarDefaults();
  notes.push("grammar (DERIVED — the DS contract has no grammar decls): hairline=SOFT_NEUTRAL, panelBg=CARD_FILL, radiusScale=[6,12,20], 1px strokes, neutral shadow, dataFont=mono.");
  for (const need of ["CANVAS", "INK", "ACCENT", grammar.hairline, grammar.panelBg]) {
    if (!(need in palette)) throw new Error(`themeFromDs: expected palette const ${need} missing`);
  }
  const dsHexes = Object.values(byOriginalKey).filter((v) => /^#[0-9a-fA-F]{3,8}$/.test(v));
  const paletteHexes = [...new Set([...dsHexes, ...brandPalette])];
  notes.push(`hue-lock vocabulary: union of DS PALETTE hexes + crawled brand palette (${paletteHexes.length} hexes).`);
  return {
    theme: { palette, fonts, keyframes, grammar },
    paletteHexes,
    signatureAccent: byOriginalKey["accent"],
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

/** DS-failure fallback: contract consts synthesized from the canvas plan +
 *  signature (there is no reference PALETTE to borrow on a fresh brand). */
const fallbackThemeFromCrawl = (
  fonts: Theme["fonts"],
  canvasBg: string,
  canvasMode: string,
  signature: string,
  brandPalette: string[],
): Omit<DerivedTheme, "logoSrc"> => {
  const dark = canvasMode === "dark";
  const palette: Record<string, string> = {
    CANVAS: canvasBg,
    INK: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.88)",
    ACCENT: signature,
    MUTED: dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)",
    SOFT_NEUTRAL: dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.1)",
    CARD_FILL: dark ? "#1a1a1e" : "#f7f8fa",
    WHITE: "#ffffff",
  };
  return {
    theme: { palette, fonts, keyframes: FALLBACK_KEYFRAMES, grammar: grammarDefaults() },
    paletteHexes: [...new Set([...Object.values(palette).filter((v) => /^#/.test(v)), ...brandPalette])],
    signatureAccent: signature,
    mappingNotes: ["FALLBACK theme: contract consts synthesized from the canvas plan + signature (no reference build on a fresh brand); neutral deterministic keyframes. The head's DS did not ship."],
  };
};

// ── per-scene vision (a8's, budget-aware) ────────────────────────────────────
// (the density profile, structural gates, and finding→piece routing moved to
//  lib/render/quality-loop.ts — the shared module both callers drive.)

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

// ── sequence vision — ONCE, advisory, FULLY DETACHED (v10) ──────────────────
// Cycle-1 evidence: two 120s aborts on the critical path cost 244s (46% of
// wall). v10 posture: the runner writes the gallery + report FIRST, the
// verdict patches them in when/if it lands, and ONE abort skips it entirely.

let sequenceAborted = false;

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
    const { text, usage } = await callZaiVision(imagesB64, prompt, { maxTokens: 6000, timeoutMs: 120_000 });
    zaiUsage = addUsage(zaiUsage, usage);
    return text;
  };
  const ordered = measurements
    .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
    .sort((a, b) => a.scene - b.scene);
  // v15 (#5): burn an unambiguous "SCENE N" badge into each frame before
  // judging so the verdict cites the badge index, not inferred position
  // (cycle 6's verdict swapped scenes 0/4). The badge is keyed to the TRUE
  // scene index (m.scene), never the array position.
  const imagesB64 = await Promise.all(
    ordered.map(async (m) => {
      const raw = await fs.readFile(m.screenshotPath);
      const stamped = await stampSceneIndexBadge(raw, m.scene);
      return stamped.toString("base64");
    }),
  );
  const findings = await judgeSequence(imagesB64, brandTruth, sequenceJudge);
  if (findings.some((f) => f.issue.startsWith("SEQUENCE-JUDGE-ERROR:"))) {
    // v10: SKIP after the FIRST abort — no retry. The judge is advisory; a
    // second 120s spin bought nothing in cycle 1 (it aborted again).
    sequenceAborted = true;
    console.warn(`  sequence verdict aborted (${findings[0]?.issue.slice(0, 120)}) — SKIPPED after first abort (no retry)`);
  }
  return findings;
};


// ── report shapes ────────────────────────────────────────────────────────────

interface ContrastCell extends HeroLuminanceStats {
  washout: boolean;
}

interface ScriptAttemptRow {
  label: string;
  kind: "full" | "surgical";
  secs: number;
  in: number;
  out: number;
  stop: string | null;
  error: string | null;
  salvaged: boolean;
}
interface BlueprintAttemptRow { attempt: number; secs: number; tokensIn: number; tokensOut: number; stop: string | null; errors: string[] }

interface RowCell { scene: number; png?: string; label: string; note: string }

// ── gallery ──────────────────────────────────────────────────────────────────

const densityCellHtml = (p: SceneDensityProfile | undefined): string => {
  if (!p) return `<td class="bad" colspan="5">no data</td>`;
  if (p.ssrError) return `<td class="bad" colspan="5">SSR error: ${esc(p.ssrError.slice(0, 80))}</td>`;
  const dieg = p.bestDiegetic ? `${p.bestDiegetic.elements}el / ${p.bestDiegetic.textNodes}txt` : "none";
  const hero = p.hero ? `${p.hero.id} ${p.hero.elements}el/${p.hero.textNodes}tx` : "(no .hero piece)";
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
      `<td class="${c.washout ? "bad" : "ok"}">${esc(c.pieceId)}</td>`,
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

const gateLogHtml = (gateRounds: GateRoundReport[]): string => {
  const rounds = gateRounds
    .map((g) => {
      const rows: string[] = [];
      for (const f of g.density) rows.push(`<li><b>density/${esc(f.kind)} (BLOCKING)</b> scene ${f.scene}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const f of g.heroContrast.findings) rows.push(`<li><b>hero-contrast/hero-washout (BLOCKING)</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const f of g.washoutNearMiss ?? []) rows.push(`<li><b>hero-contrast/washout-near-miss (ADVISORY, v13)</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const f of g.heroUnderscale ?? []) rows.push(`<li><b>hero-scale/hero-underscale (BLOCKING, v13)</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const f of g.skeletonBars ?? []) rows.push(`<li><b>skeleton-bars (${f.blocking ? "BLOCKING" : "advisory"}, v13)</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const e of g.heroContrast.errors) rows.push(`<li><b>hero-contrast</b> sampling error: ${esc(e.slice(0, 200))}</li>`);
      for (const e of g.washoutLifts ?? []) {
        rows.push(
          `<li><b>washout-lift/${esc(e.action)}</b> ${esc(e.pieceId)}: ${esc(e.via ?? "no-op")} → ${esc(e.targetToken ?? "-")} · spread/std ${e.before.spread}/${e.before.std}${e.after ? ` → ${e.after.spread}/${e.after.std}` : ""} · ${e.cleared === true ? "CLEARED (zero tokens)" : e.cleared === false ? "residual → regen (explicit direction)" : "regen-routed (explicit direction)"}</li>`,
        );
      }
      for (const e of g.imgSwaps ?? []) {
        rows.push(`<li><b>img-broken (v12)</b> scene ${e.scene} ${esc(e.pieceId || "(chrome)")}: …${esc(e.src.slice(-40))} → text wordmark (${esc(e.via)})</li>`);
      }
      for (const f of g.accentFill.findings) rows.push(`<li><b>accent-fill/accent-as-fill (BLOCKING)</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 280))}</li>`);
      for (const e of g.accentFill.errors) rows.push(`<li><b>accent-fill</b> sampling error: ${esc(e.slice(0, 200))}</li>`);
      for (const f of g.edgeCrop.initial) {
        const residual = g.edgeCrop.residual.some((r) => r.pieceId === f.pieceId && r.edge === f.edge);
        rows.push(`<li><b>piece-edge-crop${residual ? " (BLOCKING — residual after clamp)" : " (CLAMPED deterministically)"}</b> scene ${f.scene} → ${esc(f.pieceId)}: ${esc(f.detail.slice(0, 240))}</li>`);
      }
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
  // v10: sequence vision is DETACHED — the gallery ships with a pending marker
  // and the verdict is patched into this exact span when/if it lands.
  const seqPending = `<!--RB_SEQ_START--><li>sequence vision (detached, advisory): PENDING — the verdict patches in here when it lands; the wall never includes it</li><!--RB_SEQ_END-->`;
  return `${rounds}<h3>final sequence-vision pass (detached)</h3><ul>${seqPending}</ul>`;
};

const callLogHtml = (): string => {
  const rows = callLog
    .map((c) => `<tr><td style="text-align:left">${esc(c.label)}</td><td style="text-align:left">${esc(c.model)}</td><td>${c.secs.toFixed(1)}s</td><td>${c.in}</td><td>${c.out}</td><td>${esc(String(c.stop))}</td></tr>`)
    .join("\n");
  return `<div class="scroll"><table><tr><th>call</th><th>model</th><th>secs</th><th>tok in</th><th>tok out</th><th>stop</th></tr>${rows}</table></div>`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!BRIEF_ID) {
    console.error("RB_DOGFOOD_BRIEF (or --brief=<id>) missing — nothing to build");
    process.exitCode = 1;
    return;
  }
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/dogfood-spike.mjs");
    process.exitCode = 1;
    return;
  }
  if (!process.env.RB_FIREWORKS_KEY) {
    console.error("RB_FIREWORKS_KEY missing — the cast stack (GLM-5.2 @ Fireworks) needs it");
    process.exitCode = 1;
    return;
  }
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT_DIR, "frames"), { recursive: true });

  // Cast routing: HERO+LEAVES both on the FAST router (thinking-OFF per element).
  delete process.env.RB_CAST_MODEL;
  process.env.RB_CAST_MODEL_HERO = FIREWORKS_GLM_FAST;
  process.env.RB_CAST_MODEL_LEAVES = FIREWORKS_GLM_FAST;

  const report: Record<string, unknown> = {
    experiment:
      `DOGFOOD CYCLE ${CYCLE} (v14 batch): generalized acceptance8 runner on brief ${BRIEF_ID} (${TAG}) — BRAND-TRUTH INTEGRITY GATE (Lever A, production crawl code): failover/parked-page detection (URL tokens + outage boilerplate + sparse-core), logo decode-verification of the full fallback chain, accent sanity in HSL with logo-dominant-color fallback, page-image fetch+decode verification (dead entries dropped), all run at crawl time AND as a build-entry preflight against the CACHED extract (hardFail → build refused; degraded → report surfaced in build output + gallery). bindLiteralCopyInPlace extended to newline whole-node, exact re-case (toUpperCase/toLowerCase), and split-span slice-binding forms. All v9-v13 gates retained; same budget and retry discipline as acceptance8.`,
    briefId: BRIEF_ID,
    tag: TAG,
    cycle: CYCLE,
    generatedAt: new Date().toISOString(),
    gateFixes: {
      perHeroFloor: `density-gates clause (a2): any ".hero" piece must itself measure ≥${HERO_MIN_ELEMENTS}el/≥${HERO_MIN_TEXT_NODES}tx (kind thin-hero, blocking)`,
      heroWashout: `hero-contrast: hero region luminance spread<${WASHOUT_SPREAD_FLOOR} AND stdDev<${WASHOUT_STDDEV_FLOOR} → hero-washout (blocking), routed to the named hero`,
      v9: `washout killed at the HEAD (composition contract + checkSceneComposition mirror + cast-build ensureHeroSurfaceContrast backstop); register runs ≥3 rejected at script validation`,
      v10: `accent-as-fill: largest flat accent rect in a hero region ≤${ACCENT_FILL_MAX_FRAC * 100}% of the piece area (blocking); piece-edge-crop: measured pieces clipping canvas bottom/right >2% of own size → deterministic clamp, residuals blocking; hero surface contrast area-weighted (≥25% painted weight); washout static mirror canvas-AGNOSTIC (light canvas → dark surface); sequence vision detached + skip-after-abort`,
      v11: `meta-text leak: rendered text segments carrying repair vocabulary/coordinate-math prose strip deterministically at the element gate (dominant prose = reject); unowned-copy BINDING check: c.<field> references for unowned fields strip/reject in-round (+ value coverage widened to eyebrow/caption/cta, trailing-punct + case variants); clamp-vs-slot: oversized (>25% over slot) or neighbor-invading clamps route regen directly; full-bleed barbell routes to the HERO with a vertical-fill instruction (head carries the matching clause); logo-glyph count >1 per hero mock = finding; interior-clip advisory (text protruding >30% past its piece union); detached sequence verdict fires on round-0 frames and threads into round-1+ regen prompts`,
      v12: `class-matched breaker: retry progress judged on the targeting class (washout → measured spread/std delta; render-truth → per-piece blocking count; density → el/tx; accent-fill → largest-rect frac), one escalation max, same-class failure after escalation = accept-and-flag; washout gate→backstop closure: forceHeroSurfaceLift with MEASURED panel+canvas colors (gradients/rgba/root-override included) fires the moment the gate does, re-measures, residuals regen with an explicit lighten/darken direction (invariant: never a no-op); cross-piece text collision Case D: copy-class canvas text (≤32px) over ANOTHER piece's text nodes = blocking, routed to BOTH pieces role-split (hero shrinks into slot / copy takes an opaque panel) + composition-head MOCK TERRITORY clause (full-canvas app shell forfeits the copy column); broken-image swap: measured naturalWidth===0 → deterministic text-wordmark swap (tag sites + the chrome logoSrc binding) + structural img_broken`,
      v13: `register-aware richness vocabulary: quote/centered/full-bleed registers additionally accept TYPOGRAPHIC drawables (oversized numeral, type lockup, sticker, stamp, scribble...) in the script validator + prompt (floor unchanged; kills the type-poster brand-contract defect); hero-underscale: painted-union of a centered/quote hero <${HERO_UNDERSCALE_MIN_FRAC * 100}% of canvas = BLOCKING, routed "the artifact owns the frame — scale it up" (calibrated: Oatly s2 carton 0.33% fires, LiquidDeath s1 9.26% nearest pass); washout near-miss ADVISORY band (spread<floor AND std<floor+3, never blocking, appended to any regen of the piece); skeleton-bar measured detector: ≥3 sibling flat mid-grey rounded no-text bars >60px wide = structural skeleton_bars (advisory; ≥2 rows in a piece = blocking)`,
      v15: `OCCUPANCY BUDGET (Lever B): measured empty-column void band (pixel truth + diegetic-anchor exemption) on quote/centered scenes ≥${(0.23 * 100).toFixed(0)}% of frame width = BLOCKING "furnish the void" (split/stat/list ADVISE; card-interior furnish advisory rides along); PER-TEXT-NODE CONTRAST (Lever C): each text node vs its LOCAL sampled backdrop (dominant-cluster, glyphs excluded) — <2.5:1 at ≥14px on a solid backdrop = BLOCKING (the cycle-6 white-on-white ghost class), 2.5-4.5:1 advisory; the whole-box rt-contrast text arm is RETIRED (it averaged glyphs in → FP'd legible navy-on-cream at 1.15:1); LIFT INTERIOR REPAINT: forceHeroSurfaceLift recolors interior text that would ghost against the NEW surface in the SAME pass (invariant: a lift never creates a text-contrast finding); STRAY-FRAGMENT arm: thin accent bars crossing a panel edge or floating isolated from their piece → deterministic clip/remove where the span is unambiguous, else structural advisory; SEQUENCE-JUDGE INDEX STAMPING: a magenta "SCENE N" badge burned into each frame's bottom-left before judging (cycle 6 swapped scenes 0/4); carries: theme font-family names join the meta-text vocabulary (the "NIB PRO" chrome leak) + the split-span binder tolerates one appended trailing punctuation ("built for you." vs "…for you")`,
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
  let finalAccentFill: AccentFillResult | null = null;
  const edgeCropEvents: EdgeCropEvent[] = [];
  let script: LooseScript | null = null;
  let scriptStartS: number | null = null;
  let castStartS: number | null = null;
  let previewEndS: number | null = null;
  const scriptAttemptLog: ScriptAttemptRow[] = [];
  const blueprintAttempts: BlueprintAttemptRow[] = [];

  const writeOut = async (): Promise<void> => {
    const models: Record<string, { calls: number; in: number; out: number; usdPerMIn: number; usdPerMOut: number; usd: number }> = {};
    let textUsd = 0;
    for (const [model, pm] of Object.entries(perModel)) {
      const [pin, pout] = MODEL_PRICES[model] ?? [0, 0];
      const usd = (pm.in * pin + pm.out * pout) / 1e6;
      textUsd += usd;
      models[model] = { ...pm, usdPerMIn: pin, usdPerMOut: pout, usd: Math.round(usd * 1e6) / 1e6 };
    }
    const zaiUsd = costUsd(VISION_MODEL, zaiUsage);
    const sizeable = fastSamples.map((s) => s.toks).sort((a, b) => a - b);
    report.phases = marks;
    report.scriptAttemptLog = scriptAttemptLog;
    report.blueprintAttemptLog = blueprintAttempts;
    report.castRounds = roundTelemetry;
    report.gateRounds = gateRounds;
    report.sequenceFinal = sequenceFinal;
    report.sequenceSkippedAfterAbort = sequenceAborted;
    report.densityProfile = profile;
    report.finalContrast = finalContrast;
    report.finalAccentFill = finalAccentFill;
    report.edgeCropEvents = edgeCropEvents;
    report.bindCopyEvents = bindCopyEvents;
    report.finalize = finalize;
    report.calls = callLog;
    report.fastRouter = {
      model: FIREWORKS_GLM_FAST,
      sustainedFloorTokS: FAST_SUSTAINED_FLOOR_TOKS,
      degraded: fastRouterDegraded,
      fallbacks: fastFallbacks,
      samples: fastSamples,
      medianTokS: sizeable.length ? sizeable[Math.floor(sizeable.length / 2)] : null,
      minTokS: sizeable[0] ?? null,
      maxTokS: sizeable[sizeable.length - 1] ?? null,
    };
    report.castCacheEvents = { stopLength: stopLengthEvents, cacheBusts: cacheBustEvents };
    report.retryTelemetry = {
      scriptFullAttempts: scriptAttemptLog.filter((a) => a.kind === "full").length,
      scriptSurgicalRepairs: scriptAttemptLog.filter((a) => a.kind === "surgical").length,
      blueprintAttempts: blueprintAttempts.length,
      stopLengthEvents,
      fastRetryEvents,
      fastFallbacks,
      noProgressEvents,
      washoutLiftEvents,
      imgSwapEvents,
    };
    // v12 (#2): the washout-closure invariant, machine-checkable — every gate
    // fire produced a forced lift or an explicit regen route; no silent no-op.
    report.washoutClosure = {
      invariant: "every hero-washout finding on round N produces a forced surface lift (measured colors) or a regen with an explicit lighten/darken instruction — never a no-op",
      gateFires: washoutLiftEvents.length,
      forcedLifts: washoutLiftEvents.filter((e) => e.action === "forced-lift").length,
      liftsCleared: washoutLiftEvents.filter((e) => e.cleared === true).length,
      regenRouted: washoutLiftEvents.filter((e) => e.action === "lift-noop-regen-routed" || e.cleared === false).length,
      events: washoutLiftEvents,
    };
    report.budget = { totalLlmCalls, ceiling: TOTAL_LLM_CEILING, budgetExhausted, visionCalls: zaiCalls };
    report.cost = {
      models,
      zaiVision: { calls: zaiCalls, inputTokens: zaiUsage.input_tokens, outputTokens: zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
      totalUsd: textUsd + zaiUsd,
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
    // ── brief from the store (by ID — no reference build required) ───────────
    const stored = await phase("brief-load", async (): Promise<StoredBrief> => {
      const b = await withDbRetry(() => loadBrief(BRIEF_ID, DEV_OWNER_ID));
      if (!b) throw new Error(`no brief found for id ${BRIEF_ID} (owner ${DEV_OWNER_ID})`);
      console.log(`  brief ${b.id} (owner ${b.owner_id}) — ${b.brand_kit_url}, brand_extract.ok=${b.brand_extract?.ok}`);
      return b;
    });
    const be = stored.brand_extract as unknown as AgentBrandExtract | undefined;
    if (!be?.ok) throw new Error("brief has no cached brand_extract — crawl the brand first (brand selection contract)");

    // ── v14 BRAND-TRUTH PREFLIGHT (build entry, against the CACHED extract) ──
    // The Patagonia incident: cycle 5 built an entire video from a CDN-failover
    // page (accent #666666, logo null, zero photos). Stored briefs carry cached
    // extracts that crawl-time checks never saw — so the gate runs HERE, with
    // network verification (logo decode + photo probes, time-boxed).
    const truthReport = await phase("brand-truth-preflight", () => preflightBrandTruth(be));
    report.brandTruth = truthReport;
    if (truthReport.hardFail) {
      console.error(`  ✗ BRAND-TRUTH HARD FAIL — refusing to build:`);
      for (const r of truthReport.degraded) console.error(`    · ${r}`);
      throw new Error(
        `BRAND-TRUTH PREFLIGHT HARD FAIL: ${truthReport.degraded.join(" · ")}`,
      );
    }
    if (truthReport.degraded.length > 0) {
      console.warn(`  ⚠ brand-truth DEGRADED (build proceeds; report surfaced in output + gallery):`);
      for (const r of truthReport.degraded) console.warn(`    · ${r}`);
    } else {
      console.log(
        `  brand-truth preflight CLEAN — logo ${truthReport.signals.logo.status} · accent ${truthReport.signals.accent.resolved ?? "none"} · photos ${truthReport.signals.photos.verified ?? "?"}/${truthReport.signals.photos.listed} alive`,
      );
    }
    // Act on the verification: dead cached photos never reach preallocated
    // assets; the logo truth is the first candidate that actually DECODES.
    if (truthReport.signals.photos.deadUrls.length > 0 && be.page_images) {
      const deadSet = new Set(truthReport.signals.photos.deadUrls);
      be.page_images = be.page_images.filter((p) => !deadSet.has(p.src));
      console.warn(`  ⚠ dropped ${deadSet.size} dead page image(s) from the build input`);
    }

    BRAND = be.title?.trim() || TAG;
    const canvasPlan = resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]);
    const signature =
      signatureWithLogoFallback(be.palette ?? [], be.theme_color, be.logo_color) ?? be.theme_color ?? (be.palette ?? [])[0] ?? "#666666";
    const crawlFonts = fontsFromCrawl(be);
    const logoSrc = truthReport.signals.logo.effectiveUrl ?? undefined;
    report.brief = { projectId: stored.id, url: stored.brand_kit_url, brand: BRAND, brandExtractCached: true, canvasPlan, signature, fonts: { display: crawlFonts.display, body: crawlFonts.body, mono: crawlFonts.mono, fontFaces: (be.fonts ?? []).length }, logo: logoSrc ? logoSrc.slice(0, 120) : null };

    // ── canaries: ALL THREE transports before any real spend ─────────────────
    await phase("canary", async () => {
      const fast = await budgetedCast("canary-fireworks-fast", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: FIREWORKS_GLM_FAST, effort: "none" });
      console.log(`  fireworks glm-5p2-FAST ok — ${fast.seconds.toFixed(1)}s, stop=${fast.stopReason}`);
      const fw = await budgetedCast("canary-fireworks-standard", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: FIREWORKS_GLM, effort: "none" });
      console.log(`  fireworks glm-5p2 (standard, the fallback tier) ok — ${fw.seconds.toFixed(1)}s, stop=${fw.stopReason}`);
      const cb = await budgetedCast("canary-cerebras", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: BLUEPRINT_MODEL, effort: "low" });
      console.log(`  cerebras gpt-oss-120b ok — ${cb.seconds.toFixed(1)}s, stop=${cb.stopReason}`);
    });

    // ── PHASE 1: SCRIPT — GENERATED on GLM-5.2-FAST @ Fireworks ──────────────
    const freeform = [
      stored.purpose,
      ...(stored.moments ?? [])
        .filter((m) => m?.description)
        .map((m, i) => `${i + 1}. ${m.title ? `${m.title}: ` : ""}${m.description}`),
    ]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join("\n");
    const agentBrief: AgentBrief = {
      duration_seconds: stored.duration_seconds ?? 30,
      distribution_format: stored.distribution_format ?? "landscape",
      moment_count: 5,
      brand_kit_url: stored.brand_kit_url,
      verified_claims: stored.verified_claims,
      brand_extract: be,
      preallocated_assets: buildPreallocatedFromCrawl(be),
      freeform_prompt: freeform || `Launch video for ${BRAND}.`,
    };
    const briefId = stored.id;
    scriptStartS = nowS();
    const scriptResult = await phase("script", async () => {
      const userMsg = buildUserMessage(agentBrief);
      const fullRepairUser = (prevRaw: string, error: string): string =>
        [
          userMsg,
          ``,
          `════ YOUR PREVIOUS OUTPUT (INVALID) ════`,
          stripCodeFence(prevRaw.trim()).slice(0, 40000),
          ``,
          `════ VALIDATION FAILURE (verbatim) ════`,
          error,
          ``,
          `Fix the issue and re-emit the COMPLETE Script JSON. Common gotchas to recheck:`,
          `- Every section has visual_concept (1-3 sentences of prose) AND content with headline + asset_ids array.`,
          `- scenes tile [0, total_duration_seconds] exactly: first.start_seconds=0, last.end_seconds=total, adjacent boundaries match.`,
          `- EXACTLY 5 sections. Do NOT emit scene.elements[], scene.background, or scene.audio_cues.`,
          `Output ONLY the JSON object. No prose, no fence.`,
        ].join("\n");
      let nextUser = userMsg;
      let lastError = "";
      let surgicalUsed = 0;
      for (let attempt = 1; attempt <= SCRIPT_MAX_ATTEMPTS; attempt++) {
        const attemptEffort = SCRIPT_EFFORT_LADDER[Math.min(attempt, SCRIPT_EFFORT_LADDER.length) - 1];
        let r: CastResult;
        try {
          r = await budgetedCast(`script-attempt-${attempt}(${attemptEffort})`, {
            system: SCRIPT_GENERATOR_SYSTEM_PROMPT,
            user: nextUser,
            maxTokens: SCRIPT_MAX_TOKENS,
            model: FIREWORKS_GLM_FAST,
            effort: attemptEffort,
            json: true,
          });
        } catch (e) {
          if (e instanceof BudgetExceeded) throw e;
          console.error(`  ▲ script attempt ${attempt} call failed (${e instanceof Error ? e.message.split("\n")[0] : e}) — ONE retry without json mode`);
          r = await budgetedCast(`script-attempt-${attempt}-nojson`, {
            system: SCRIPT_GENERATOR_SYSTEM_PROMPT,
            user: nextUser,
            maxTokens: SCRIPT_MAX_TOKENS,
            model: FIREWORKS_GLM_FAST,
            effort: attemptEffort,
          });
        }
        const parsed = salvageParse(r.text);
        if ("error" in parsed) {
          scriptAttemptLog.push({ label: `attempt ${attempt}`, kind: "full", secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, error: parsed.error, salvaged: false });
          lastError = parsed.error;
          console.warn(`  script attempt ${attempt} UNPARSEABLE (even after the salvage scan) — repair retry`);
          nextUser = fullRepairUser(r.text, parsed.error);
          continue;
        }
        if (parsed.salvaged) console.log(`  (salvage parser recovered the JSON span from prose-wrapped output)`);
        let res = processScriptObject(parsed.parsed, agentBrief, briefId);
        scriptAttemptLog.push({ label: `attempt ${attempt}`, kind: "full", secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, error: res.ok ? null : res.error, salvaged: parsed.salvaged });
        if (res.ok) {
          console.log(`  script valid on attempt ${attempt}/${SCRIPT_MAX_ATTEMPTS} — ${r.seconds.toFixed(1)}s, ${r.outputTokens} tok out`);
          return { script: res.script, attempts: attempt, surgicalRepairs: surgicalUsed };
        }
        lastError = res.error;
        console.warn(`  script attempt ${attempt} INVALID: ${res.error.split("\n")[0]}`);
        while (!res.ok && res.fieldScoped && surgicalUsed < SCRIPT_MAX_SURGICAL) {
          surgicalUsed += 1;
          const base = res.normalized as LooseScript;
          console.log(`  surgical repair ${surgicalUsed}/${SCRIPT_MAX_SURGICAL} — field-scoped: ${res.error.split("\n")[0].slice(0, 110)}`);
          const sr = await budgetedCast(`script-surgical-${surgicalUsed}`, {
            system: SURGICAL_SYSTEM,
            user: [
              `THE SCRIPT (JSON):`,
              JSON.stringify(base),
              ``,
              `VALIDATION ERRORS (verbatim):`,
              res.error,
              ``,
              `════ ALLOWED NUMBERS — the ONLY digit-bearing claim tokens you may write in viewer-facing copy ════`,
              `Any stat-shaped number your patch adds to copy fields (price, %, multiplier, count, latency) must appear VERBATIM below; otherwise write the copy qualitatively. Timing beats ("at 2.4s") and mock-UI set-dressing values inside visual_concept are exempt.`,
              claimGroundingSources(agentBrief).slice(0, 6000),
              ``,
              `Emit ONLY the patch object.`,
            ].join("\n"),
            maxTokens: 4000,
            model: FIREWORKS_GLM_FAST,
            effort: SCRIPT_EFFORT,
            json: true,
          });
          const patchParsed = salvageParse(sr.text);
          if ("error" in patchParsed) {
            scriptAttemptLog.push({ label: `surgical ${surgicalUsed}`, kind: "surgical", secs: sr.seconds, in: sr.inputTokens, out: sr.outputTokens, stop: sr.stopReason, error: `patch unparseable: ${patchParsed.error.slice(0, 140)}`, salvaged: false });
            console.warn(`  surgical patch ${surgicalUsed} unparseable`);
            continue;
          }
          const merged = applySurgicalPatch(base, patchParsed.parsed);
          if ("error" in merged) {
            scriptAttemptLog.push({ label: `surgical ${surgicalUsed}`, kind: "surgical", secs: sr.seconds, in: sr.inputTokens, out: sr.outputTokens, stop: sr.stopReason, error: `patch rejected: ${merged.error}`, salvaged: patchParsed.salvaged });
            console.warn(`  surgical patch ${surgicalUsed} rejected: ${merged.error}`);
            continue;
          }
          res = processScriptObject(merged.merged, agentBrief, briefId);
          scriptAttemptLog.push({ label: `surgical ${surgicalUsed} → ${merged.touched.join(", ")}`, kind: "surgical", secs: sr.seconds, in: sr.inputTokens, out: sr.outputTokens, stop: sr.stopReason, error: res.ok ? null : res.error, salvaged: patchParsed.salvaged });
          if (res.ok) {
            console.log(`  script valid after surgical repair ${surgicalUsed} (touched ${merged.touched.join(", ")}) — no re-emission spent`);
            return { script: res.script, attempts: attempt, surgicalRepairs: surgicalUsed };
          }
          lastError = res.error;
          console.warn(`  surgical repair ${surgicalUsed} did not clear validation: ${res.error.split("\n")[0]}`);
        }
        if (attempt < SCRIPT_MAX_ATTEMPTS) nextUser = fullRepairUser(r.text, lastError);
      }
      // No reference script exists on a fresh brand — a terminal script failure
      // is a TERMINAL RUN failure, reported honestly.
      throw new Error(`SCRIPT TERMINAL after ${SCRIPT_MAX_ATTEMPTS} attempts + surgical repairs: ${lastError.split("\n")[0]}`);
    });
    script = scriptResult.script;
    report.script = {
      source: `GENERATED on ${FIREWORKS_GLM_FAST} (effort ladder from ${SCRIPT_EFFORT}, json mode), valid on attempt ${scriptResult.attempts} after ${scriptResult.surgicalRepairs} surgical repair(s)`,
      generated: true,
      attempts: scriptResult.attempts,
      surgicalRepairs: scriptResult.surgicalRepairs,
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
      headlines: script.scenes.map((s) => s.content?.headline),
    };
    await writeOut();

    // ── PHASES 2 ∥ 3: DESIGN SYSTEM ∥ BLUEPRINTS (zero data dependencies) ────
    const dsPromise = phase("design-system", async () => {
      const user = dsUserPrompt(script!, be, { display: crawlFonts.display, body: crawlFonts.body }, signature);
      const first = await budgetedCast("design-system", { system: dsSystemPrompt, user, maxTokens: DS_MAX_TOKENS, model: FIREWORKS_GLM_FAST, effort: HEAD_EFFORT });
      let parsed = parseDsEmission(first.text, FALLBACK_KEYFRAMES);
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
          model: FIREWORKS_GLM_FAST,
          effort: HEAD_EFFORT,
        });
        parsed = parseDsEmission(fix.text, FALLBACK_KEYFRAMES);
        compileErr = parsed.ok ? await verifyCompilable(Object.values(parsed.decls!).join("\n\n")) : parsed.error ?? "parse failed";
      }
      if (!parsed.ok || compileErr) {
        console.error(`  DS STILL invalid (${String(parsed.error ?? compileErr).split("\n")[0]}) — FALLBACK theme from the canvas plan (recorded honestly)`);
        return { derived: fallbackThemeFromCrawl(crawlFonts, canvasPlan.background, canvasPlan.mode, signature, be.palette ?? []), ok: false, repaired, error: String(parsed.error ?? compileErr), kfInjected: [] as string[] };
      }
      await fs.writeFile(path.join(OUT_DIR, "design-system-emission.tsx"), Object.values(parsed.decls!).join("\n\n"), "utf8");
      const derived = themeFromDs(parsed.decls!, crawlFonts, be.palette ?? []);
      console.log(`  DS accepted${repaired ? " after ONE repair" : " first try"}${parsed.requiredKeyframesInjected!.length ? ` (required keyframes merged from the donor block: ${parsed.requiredKeyframesInjected!.join(", ")})` : ""} — palette ${Object.keys(derived.theme.palette).join("/")}`);
      return { derived, ok: true, repaired, error: null as string | null, kfInjected: parsed.requiredKeyframesInjected! };
    });
    // ── PHASE 3 (∥ DS): BLUEPRINTS — generateComposition on gpt-oss ──────────
    // v10: blueprint validation = the composition contract + the narrow
    // ungrounded mock-value deny-list (EST-dates / %-OFF vs grounding sources).
    const groundingText = claimGroundingSources(agentBrief);
    const validateComposition = (scenes: Scene[]): string[] => [
      ...checkSceneComposition(scenes),
      ...findUngroundedMockValues(scenes, groundingText),
    ];
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
    const compositionPromise = phase("composition-head", async () => {
      try {
        const result = await generateComposition({
          script: script as unknown as Script,
          caller: headCaller,
          validate: validateComposition,
          brandName: BRAND,
          paletteHint: `canvas ${canvasPlan.background} (${canvasPlan.mode}), signature accent ${signature}, brand palette: ${(be.palette ?? []).join(", ")}`,
          designNotes: `Design system consts available downstream: PALETTE (canvas/ink/accent/muted/softNeutral/cardFill/white), shared keyframes (glowBreathe, drift1-3, drawWidth, fadeRise, scaleIn). Fonts locked: display ${crawlFonts.display}, body ${crawlFonts.body}.`,
        });
        for (const e of result.errors) {
          const m = /^attempt (\d+): ([\s\S]*)$/.exec(e);
          const bucket = m ? blueprintAttempts.find((a) => a.attempt === Number(m[1])) : undefined;
          if (bucket) bucket.errors.push(m![2]);
          else blueprintAttempts.push({ attempt: -1, secs: 0, tokensIn: 0, tokensOut: 0, stop: null, errors: [e] });
        }
        const residual = validateComposition(result.scenes);
        const validatedClean = residual.length === 0;
        report.blueprints = {
          author: `${BLUEPRINT_MODEL} @ Cerebras, effort high (validate=checkSceneComposition incl. the v9 washout + masked-value + placeholder clauses; v10: canvas-agnostic washout arm + ungrounded mock-value deny-list)`,
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

    const [ds] = await Promise.all([dsPromise, compositionPromise]);

    const inkGuard = neutralizeInk(ds.derived.theme);
    if (inkGuard.corrected) console.warn(`  neutralizeInk CORRECTED the DS ink (a saturated brand hue was cast as text ink → neutral #1a1a1a)`);
    const theme = inkGuard.theme;
    const { paletteHexes, signatureAccent, mappingNotes } = ds.derived;
    report.designSystem = {
      acceptedFromModel: ds.ok,
      repaired: ds.repaired,
      error: ds.error,
      inkNeutralized: inkGuard.corrected,
      requiredKeyframesInjected: ds.kfInjected,
      themeMappingNotes: mappingNotes,
      logoSrc: logoSrc ? logoSrc.slice(0, 120) : null,
    };
    await writeOut();

    const brandTruth: BrandTruthLite = {
      name: BRAND,
      backgroundColor: canvasPlan.background,
      accent: signature,
      fonts: [be.font_roles?.display, be.font_roles?.body].filter((f): f is string => !!f),
    };

    // v10 accent-as-fill vocabulary: the signature accent + the DS theme's
    // ACCENT token (deduped; only judgeable hexes survive accentSpecs anyway).
    const accentHexes = [
      ...new Set(
        [signatureAccent, theme.palette.ACCENT].filter(
          (h): h is string => typeof h === "string" && /^#[0-9a-fA-F]{3,8}$/.test(h),
        ),
      ),
    ];

    // ── PHASES 4–5: cast (GLM-5.2-FAST @ Fireworks) + the gate loop ──────────
    const aspect = (["16:9", "9:16", "1:1"].includes(script.config?.aspect_ratio ?? "")
      ? script.config!.aspect_ratio
      : "16:9") as "16:9" | "9:16" | "1:1";
    const castInput = {
      script: script as unknown as Script,
      theme,
      palette: paletteHexes,
      signatureAccent,
      aspect,
    };
    let finalCode = "";
    let round = 0;
    castStartS = nowS();

    // v11 (#7): the sequence verdict fires DETACHED as soon as the first
    // round's frames exist — still never awaited on the critical path — so
    // its notes can land IN-RUN and thread into round-1+ regen prompts as
    // negative guidance (archetype repetition / atmosphere monotony are
    // scene-level properties that persist across regen rounds, so a round-0
    // verdict stays true for later rounds).
    let sequenceStartS: number | null = null;
    let sequenceLandedAtS: number | null = null;
    let sequenceJudgedRound: number | null = null;
    let sequenceDone: Promise<VisionFinding[] | null> | null = null;
    const fireSequenceDetached = (measurements: SceneMeasurement[], atRound: number): void => {
      if (sequenceDone || !measurements.some((m) => m.screenshotPath)) return;
      sequenceStartS = nowS();
      sequenceJudgedRound = atRound;
      console.log(`\n▶ sequence-vision-detached (t=${sequenceStartS}s — fired on round-${atRound} frames, off the critical path)`);
      sequenceDone = runSequenceRound(measurements, brandTruth)
        .then((f) => {
          sequenceLandedAtS = nowS();
          sequenceNotes = f
            .filter((x) => !x.issue.startsWith("SEQUENCE-JUDGE-ERROR:"))
            .map((x) => x.issue);
          if (sequenceNotes.length > 0) {
            console.log(
              `  sequence verdict landed (t=${sequenceLandedAtS}s, detached) — ${sequenceNotes.length} note(s) threaded into every subsequent regen prompt as "sequence notes to avoid"`,
            );
          }
          return f;
        })
        .catch((e) => {
          sequenceAborted = true;
          console.warn(`  sequence vision threw (detached, advisory): ${e instanceof Error ? e.message.split("\n")[0] : e}`);
          sequenceLandedAtS = nowS();
          return [] as VisionFinding[];
        });
    };

    // ── the SHARED quality loop (v16, task #205): castBuild + the full gate
    // battery + deterministic repairs + class-matched breaker + retry ladder
    // now live in lib/render/quality-loop.ts (runQualityLoop). The spike wires
    // its transport (budgetedCast / fast router), its budget-aware vision, its
    // detached sequence judge, its genDir shims, and its report sinks; the loop
    // is byte-for-byte the SAME code the PRODUCT path (run-preview-build under
    // RB_BUILD_MODE=cast) runs. ──
    let callsAtLastRound = totalLlmCalls;
    const loop = await runQualityLoop(
      {
        castInput,
        script: script as unknown as LoopScript,
        genDir: GEN_DIR,
        brand: BRAND,
        logoSrc,
        canvasBackground: canvasPlan.background,
        accentHexes,
        brandTruth,
        registers: script!.scenes.map((s) => s.register),
        maxRetryRounds: MAX_RETRY_ROUNDS,
        blockingKinds: BLOCKING_KINDS,
        edgeClampMarginPx: EDGE_CLAMP_MARGIN_PX,
        defaultCastModel: FIREWORKS_GLM_FAST,
      },
      {
        transport: ((a) =>
          budgetedCast(a.label, {
            system: a.system,
            user: a.user,
            maxTokens: a.maxTokens,
            model: a.model ?? FIREWORKS_GLM_FAST,
            ...(a.effort ? { effort: a.effort } : {}),
          })) as QualityLoopTransport,
        runPerSceneVision: (measurements) => runVisionRound(measurements, script!, brandTruth),
        ensureGenDir: async () => {
          await fs.rm(GEN_DIR, { recursive: true, force: true });
          await fs.mkdir(GEN_DIR, { recursive: true });
          await fs.writeFile(path.join(GEN_DIR, "Img.tsx"), IMG_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(GEN_DIR, "Piece.tsx"), PIECE_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(GEN_DIR, "Video.tsx"), VIDEO_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(GEN_DIR, "Lottie.tsx"), LOTTIE_SHIM_SOURCE, "utf8");
          await fs.writeFile(path.join(GEN_DIR, "BrandChrome.tsx"), BRAND_CHROME_SOURCE, "utf8");
          await fs.writeFile(path.join(GEN_DIR, "script.json"), JSON.stringify(script, null, 2), "utf8");
        },
        writeComposition: async (code) => {
          await fs.writeFile(path.join(GEN_DIR, "Composition.tsx"), code, "utf8");
        },
        shouldStopForBudget: () => budgetExhausted || totalLlmCalls >= TOTAL_LLM_CEILING,
        getSequenceNotes: () => sequenceNotes,
        phase,
        onCacheReplay: ({ label, kind }) =>
          callLog.push({ label, model: "(cache)", secs: 0, in: 0, out: 0, stop: kind, cached: true }),
        onFinalize: (r, info) => {
          finalize[`r${r}`] = info;
        },
        onRoundComplete: async ({ gateRound, round: r, measurements, round0 }) => {
          gateRound.llmCallsThisRound = totalLlmCalls - callsAtLastRound;
          callsAtLastRound = totalLlmCalls;
          gateRounds.push(gateRound);
          if (gateRound.castTelemetry) roundTelemetry.push(gateRound.castTelemetry);
          if (round0) report.round0 = round0;
          fireSequenceDetached(measurements, r);
          previewEndS = nowS();
          await writeOut();
        },
        log: (m) => console.log(m),
        warn: (m) => console.warn(m),
      },
    );
    finalCode = loop.finalCode;
    finalMeasurements = loop.finalMeasurements;
    round = loop.rounds;
    profile = loop.profile;
    finalContrast = loop.finalContrast;
    finalAccentFill = loop.finalAccentFill;
    cacheBustEvents.push(...loop.events.cacheBustEvents);
    noProgressEvents.push(...loop.events.noProgressEvents);
    washoutLiftEvents.push(...loop.events.washoutLiftEvents);
    imgSwapEvents.push(...loop.events.imgSwapEvents);
    strayFragmentEvents.push(...loop.events.strayFragmentEvents);
    bindCopyEvents.push(...loop.events.bindCopyEvents);
    edgeCropEvents.push(...loop.events.edgeCropEvents);
    if (loop.castRoundError) finalize[`castRound${loop.castRoundError.round}Error`] = loop.castRoundError.error;

    if (finalCode) await fs.writeFile(path.join(OUT_DIR, "Composition.dogfood.tsx"), finalCode, "utf8");

    // Sequence vision — ONCE, advisory, FULLY DETACHED (v10; v11 fires it
    // in-loop on the FIRST round's frames so the verdict can thread into
    // later regen prompts — see fireSequenceDetached). This is only the
    // fallback for a run whose loop never produced frames. Never awaited
    // before the gallery/report: those are written with a pending marker,
    // and the verdict PATCHES them in when/if it lands. The recorded wall
    // never includes this call.
    if (!sequenceDone) fireSequenceDetached(finalMeasurements, round);
    if (!sequenceDone) {
      console.warn("  no screenshots — sequence vision skipped");
      sequenceDone = Promise.resolve([] as VisionFinding[]);
    }
    await writeOut();

    // ── final renders → OUT_DIR/frames/scene{0..4}.png ───────────────────────
    const finalRound = gateRounds[gateRounds.length - 1];
    const sceneCells: RowCell[] = [];
    for (const i of SCENES) {
      const m = finalMeasurements.find((mm) => mm.scene === i);
      const v = finalRound?.vision.find((vv) => vv.scene === i);
      const dens = finalRound?.density.filter((f) => f.scene === i) ?? [];
      const rtb = finalRound?.renderTruthBlocking.filter((f) => f.scene === i) ?? [];
      const wash = finalRound?.heroContrast.findings.filter((f) => f.scene === i) ?? [];
      const cst = finalRound?.heroContrast.stats.filter((s) => s.scene === i) ?? [];
      const afFind = finalRound?.accentFill.findings.filter((f) => f.scene === i) ?? [];
      const afStats = finalRound?.accentFill.stats.filter((s) => s.scene === i) ?? [];
      const ecInit = finalRound?.edgeCrop.initial.filter((f) => f.scene === i) ?? [];
      const ecRes = finalRound?.edgeCrop.residual.filter((f) => f.scene === i) ?? [];
      const p = profile?.scenes.find((s) => s.scene === i);
      const nearMiss = finalRound?.washoutNearMiss?.filter((f) => f.scene === i) ?? [];
      const usc = finalRound?.heroUnderscale?.filter((f) => f.scene === i) ?? [];
      const skel = finalRound?.skeletonBars?.filter((f) => f.scene === i) ?? [];
      const note = [
        p ? (p.ssrError ? `density: SSR ERROR` : `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · hero ${p.hero ? `${p.hero.elements}el/${p.hero.textNodes}tx` : "none"} · depth ${p.depth}`) : "density: n/a",
        cst.length ? `contrast: ${cst.map((c) => `${c.pieceId} spread ${c.spread}/std ${c.stdDev}`).join(" · ")}` : "contrast: no hero region",
        wash.length
          ? `HERO-WASHOUT: ${wash.map((f) => f.pieceId).join(", ")}`
          : nearMiss.length
            ? `washout: NEAR-MISS advisory on ${nearMiss.map((f) => f.pieceId).join(", ")}`
            : "washout: clean",
        usc.length ? `HERO-UNDERSCALE: ${usc.map((f) => `${f.pieceId} painted ${(f.paintedFrac * 100).toFixed(2)}%`).join(", ")}` : "underscale: clean",
        skel.length ? `SKELETON-BARS${skel.some((f) => f.blocking) ? " (BLOCKING)" : ""}: ${skel.map((f) => `${f.pieceId} ${f.rows}r/${f.bars}b`).join(", ")}` : "skeleton: clean",
        afFind.length
          ? `ACCENT-AS-FILL: ${afFind.map((f) => `${f.pieceId} ${(f.stats.largestRectFrac * 100).toFixed(0)}%`).join(", ")}`
          : afStats.length
            ? `accent-fill: ${afStats.map((s) => `${(s.largestRectFrac * 100).toFixed(1)}%`).join("/")} (≤${ACCENT_FILL_MAX_FRAC * 100}% ok)`
            : "accent-fill: no hero region",
        ecRes.length
          ? `EDGE-CROP residual: ${ecRes.map((f) => `${f.pieceId}:${f.edge}`).join(", ")}`
          : ecInit.length
            ? `edge-crop: ${ecInit.length} clamped deterministically`
            : "edge-crop: clean",
        dens.length ? `density findings: ${dens.map((f) => f.kind).join(", ")}` : "density findings: clean",
        rtb.length ? `render-truth blocking: ${rtb.map((f) => f.kind).join(", ")}` : "render-truth: clean",
        v ? (v.actionable.length === 0 ? "vision: CLEAN" : `vision: ${v.actionable.length} issue(s)${v.severe.length ? ` (${v.severe.length} severe)` : ""}`) : "vision: n/a",
      ].join("\n");
      const shot = path.join(GEN_DIR, `measure-scene-${i}.png`);
      const exists = await fs.stat(shot).then(() => true).catch(() => false);
      if (exists && !m?.error) {
        await fs.copyFile(shot, path.join(OUT_DIR, "frames", `scene${i}.png`));
        sceneCells.push({ scene: i, png: `frames/scene${i}.png`, label: script.scenes[i]?.label ?? `scene ${i}`, note });
      } else {
        sceneCells.push({ scene: i, label: script.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
      }
    }

    const contrastCells: ContrastCell[] = (finalContrast?.stats ?? []).map((s) => ({
      ...s,
      washout: !!finalContrast?.findings.find((f) => f.scene === s.scene && f.pieceId === s.pieceId),
    }));

    // v10: NO sequence await here — the gallery + report ship with a pending
    // marker; the detached verdict patches both after the run summary.
    await writeOut();

    // ── GALLERY (single row + telemetry panels) ──────────────────────────────
    await phase("gallery", async () => {
      const cost = report.cost as {
        models: Record<string, { usd: number; calls: number; in: number; out: number }>;
        zaiVision: { usd: number; calls: number };
        totalUsd: number;
      };
      const wall = report.wall as { totalRunSeconds: number; scriptToPreviewSeconds: number | null; castWallSeconds: number };
      const fastRep = report.fastRouter as { degraded: boolean; fallbacks: { label: string; reason: string }[]; samples: { label: string; toks: number; out: number; secs: number }[]; medianTokS: number | null; minTokS: number | null; maxTokS: number | null };
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

      const fastTokRows = fastRep.samples
        .map((s) => `<tr><td style="text-align:left">${esc(s.label)}</td><td>${s.out}</td><td>${s.secs.toFixed(1)}s</td><td>${s.toks.toFixed(1)}</td></tr>`)
        .join("\n");
      const fastHtml = `
  <div class="sub">fast router (${esc(FIREWORKS_GLM_FAST)}): median <b>${fastRep.medianTokS ?? "n/a"}</b> tok/s · min ${fastRep.minTokS ?? "n/a"} · max ${fastRep.maxTokS ?? "n/a"} across ${fastRep.samples.length} sizeable calls (≥300 tok out) ·
  ${fastRep.degraded ? `<span class="bad-line">DEGRADED to standard mid-run (sustained &lt; ${FAST_SUSTAINED_FLOOR_TOKS} tok/s)</span>` : `<span class="ok-line">healthy all run (floor ${FAST_SUSTAINED_FLOOR_TOKS} tok/s)</span>`} ·
  error/degrade fallbacks to standard: ${fastRep.fallbacks.length}${fastRep.fallbacks.length ? ` (${esc(fastRep.fallbacks.map((f) => f.label).join(", ")).slice(0, 300)})` : ""}</div>
  <details><summary>fast-router per-call tok/s</summary><div class="scroll"><table><tr><th>call</th><th>tok out</th><th>secs</th><th>tok/s</th></tr>${fastTokRows || "<tr><td colspan=4>none</td></tr>"}</table></div></details>`;

      const cacheHtml = `
  <div class="sub">stop=length events <b>${stopLengthEvents.length}</b>${stopLengthEvents.length ? ` [${esc(stopLengthEvents.map((e) => `${e.label} ${e.cap}→${e.retryCap}${e.recovered ? " recovered" : " STILL TRUNCATED"}`).join(" · ")).slice(0, 400)}]` : ""} ·
  cache-bust / refuse-to-populate events <b>${cacheBustEvents.length}</b>${cacheBustEvents.length ? ` [${esc(cacheBustEvents.map((e) => e.pieceId).join(", ")).slice(0, 300)}]` : ""} ·
  sequence-vision: DETACHED (never on the wall)${sequenceAborted ? " · <b>skipped after first abort</b>" : ""}</div>`;

      const r0 = report.round0 as
        | { passed: boolean; targets: string[]; density: number; washouts: number; accentFills: number; edgeCropsInitial: number; edgeCropsClamped: number; edgeCropsResidual: number; heroUnderscale?: number; washoutNearMiss?: number; skeletonBarsAdvisory?: number; skeletonBarsBlocking?: number; structural: number; rtBlocking: number; visionSevereScenes: number[] }
        | undefined;
      const round0Html = r0
        ? r0.passed
          ? `<span class="ok-line"><b>ROUND 0 PASSED</b> — every blocking gate clean on the first cast${r0.edgeCropsClamped ? ` (${r0.edgeCropsClamped} edge-crop(s) clamped deterministically en route)` : ""}${r0.washoutNearMiss ? ` · ${r0.washoutNearMiss} near-miss washout advisory(ies)` : ""}${r0.skeletonBarsAdvisory ? ` · ${r0.skeletonBarsAdvisory} skeleton-bar advisory(ies)` : ""}</span>`
          : `<span class="bad-line"><b>ROUND 0 FAILED</b></span> — ${r0.targets.length} retry target(s): [${esc(r0.targets.join(", "))}] · density ${r0.density} · washouts ${r0.washouts} · underscale ${r0.heroUnderscale ?? 0} · accent-as-fill ${r0.accentFills} · edge-crop ${r0.edgeCropsInitial}→${r0.edgeCropsResidual} residual (${r0.edgeCropsClamped} clamped) · skeleton ${(r0.skeletonBarsAdvisory ?? 0) + (r0.skeletonBarsBlocking ?? 0)} (${r0.skeletonBarsBlocking ?? 0} blocking) · near-miss ${r0.washoutNearMiss ?? 0} · structural ${r0.structural} · rt-blocking ${r0.rtBlocking} · vision-severe scenes [${r0.visionSevereScenes.join(", ") || "none"}]`
        : "no round-0 record (cast never ran)";
      const npEsc = noProgressEvents.filter((x) => x.action === "escalated");
      const npFlag = noProgressEvents.filter((x) => x.action === "accepted-and-flagged");
      const heroLifts = roundTelemetry.reduce((n, t) => n + t.heroSurfaceCorrections, 0);
      const ecClamps = edgeCropEvents.filter((e) => e.action === "clamped");
      const retryPanel = `
  <div class="sub">${round0Html}</div>
  <div class="sub">script FULL attempts <b>${scriptAttemptLog.filter((a) => a.kind === "full").length}</b> (+${scriptAttemptLog.filter((a) => a.kind === "surgical").length} surgical) ·
  blueprint attempts <b>${blueprintAttempts.length}</b> ·
  stop=length cap-raises <b>${stopLengthEvents.length}</b> ·
  cache busts <b>${cacheBustEvents.length}</b> ·
  hero surface lifts (area-weighted washout backstop): <b>${heroLifts}</b> ·
  edge-crop clamps (deterministic reposition): <b>${ecClamps.length}</b>${ecClamps.length ? ` [${esc(ecClamps.map((e) => e.pieceId).join(", "))}]` : ""} ·
  fast-tier 429/errors: ${fastRetryEvents.length} jittered retr${fastRetryEvents.length === 1 ? "y" : "ies"} (${fastRetryEvents.filter((x) => x.recovered).length} recovered) + ${fastFallbacks.length} std fallback(s) ·
  no-progress breaker: ${npEsc.length} escalation(s)${npEsc.length ? ` [${esc(npEsc.map((x) => x.pieceId).join(", "))}]` : ""}, ${npFlag.length} accept-and-flag${npFlag.length ? ` [${esc(npFlag.map((x) => x.pieceId).join(", "))}]` : ""}</div>`;

      const scriptLogHtml = scriptAttemptLog
        .map((a) => `<li><b>${esc(a.label)}</b> (${a.kind}) — ${a.secs.toFixed(1)}s · ${a.in} in / ${a.out} out · stop ${esc(String(a.stop))}${a.salvaged ? " · <b>salvage-parsed</b>" : ""} · ${a.error ? `<span class="bad-line">INVALID</span>: ${esc(a.error.slice(0, 400))}` : `<span class="ok-line">VALID</span>`}</li>`)
        .join("\n");
      const bpLogHtml = blueprintAttempts
        .map((a) => `<li><b>attempt ${a.attempt}</b> — ${a.secs.toFixed(1)}s · ${a.tokensIn} in / ${a.tokensOut} out · stop ${esc(String(a.stop))}${a.errors.length ? `<ul>${a.errors.map((e) => `<li>${esc(e.slice(0, 300))}</li>`).join("")}</ul>` : ` · <span class="ok-line">clean</span>`}</li>`)
        .join("\n");

      const densityTable = `
  <div class="scroll"><table>
    <tr>
      <th rowspan="2">scene</th>
      <th colspan="5">${esc(BRAND)} — this run (GLM-5.2-FAST cast, all heads generated)</th>
    </tr>
    <tr>
      <th>best diegetic (≥${DIEGETIC_MIN_ELEMENTS}/${DIEGETIC_MIN_TEXT_NODES})</th><th>hero (≥${HERO_MIN_ELEMENTS}/${HERO_MIN_TEXT_NODES})</th><th>depth (≥${DEPTH_FLOOR})</th><th>grad sigs</th><th>bad img</th>
    </tr>
    ${SCENES.map(
      (i) => `<tr><td>scene ${i}</td>${densityCellHtml(profile?.scenes.find((s) => s.scene === i))}</tr>`,
    ).join("\n")}
    <tr>
      <td>video-level</td>
      <td colspan="5" class="${profile && profile.varietyPass ? "ok" : "bad"}">${profile ? `${profile.distinctSignatures} distinct sigs (≥${MIN_GRADIENT_SIGNATURES}); ${profile.repeated.length} repeated violation(s)` : "n/a"}</td>
    </tr>
  </table></div>`;

      const contrastTable = `
  <div class="scroll"><table>
    <tr><th rowspan="2">scene</th><th colspan="2">hero region</th></tr>
    <tr><th>piece</th><th>luminance (washout = spread&lt;${WASHOUT_SPREAD_FLOOR} AND std&lt;${WASHOUT_STDDEV_FLOOR})</th></tr>
    ${SCENES.map((i) => `<tr><td>scene ${i}</td>${contrastCellHtml(contrastCells, i)}</tr>`).join("\n")}
  </table></div>`;

      const afRows = SCENES.map((i) => {
        const ss = (finalAccentFill?.stats ?? []).filter((s) => s.scene === i);
        if (ss.length === 0) return `<tr><td>scene ${i}</td><td colspan="3">n/a</td></tr>`;
        return ss
          .map((s) => {
            const bad = s.largestRectFrac > ACCENT_FILL_MAX_FRAC;
            return `<tr><td>scene ${i}</td><td class="${bad ? "bad" : "ok"}">${esc(s.pieceId)}</td><td class="${bad ? "bad" : "ok"}">${(s.largestRectFrac * 100).toFixed(1)}%</td><td>${(s.coverageFrac * 100).toFixed(1)}%</td></tr>`;
          })
          .join("");
      }).join("\n");
      const accentTable = `
  <div class="scroll"><table>
    <tr><th>scene</th><th>hero piece</th><th>largest flat accent rect (ceiling ${ACCENT_FILL_MAX_FRAC * 100}%)</th><th>total accent coverage</th></tr>
    ${afRows}
  </table></div>
  <div class="sub">accent vocabulary probed: ${esc((finalAccentFill?.stats[0]?.accents ?? accentHexes).join(", "))} — accent is punctuation (chips, rules, badges, highlights), never a panel fill.</div>`;

      const costSplit = Object.entries(cost.models)
        .map(([model, m]) => `${esc(model.split("/").pop() ?? model)} $${m.usd.toFixed(4)} (${m.calls} calls)`)
        .concat([`z.ai vision $${cost.zaiVision.usd.toFixed(4)} (${cost.zaiVision.calls} calls)`])
        .join(" + ");

      const headline = [
        `brand ${BRAND} (brief ${BRIEF_ID})`,
        `script attempt ${scriptRep.attempts} (${scriptRep.surgicalRepairs} surgical)`,
        `DS ${dsRep.acceptedFromModel ? (dsRep.repaired ? "ok after 1 repair" : "ok first try") : "FELL BACK"}${dsRep.inkNeutralized ? " · ink neutralized" : ""}`,
        `blueprints ${bpRep?.validatedClean ? `clean on attempt ${bpRep.attempts}` : `RESIDUALS after ${bpRep?.attempts}`}`,
        `${gateRounds.length} gate round(s)`,
        `${totalLlmCalls}/${TOTAL_LLM_CEILING} LLM calls`,
        `$${cost.totalUsd.toFixed(3)}`,
        `${wall.totalRunSeconds.toFixed(0)}s`,
      ].join(" · ");
      report.headline = headline;

      // v14: brand-truth preflight verdict — surfaced loudly in the gallery.
      const truthRep = report.brandTruth as BrandTruthReport | undefined;
      const brandTruthHtml = truthRep
        ? truthRep.degraded.length === 0
          ? `<div class="sub ok-line">brand-truth preflight: CLEAN — logo ${esc(truthRep.signals.logo.status)} · accent ${esc(truthRep.signals.accent.resolved ?? "none")} · photos ${truthRep.signals.photos.verified ?? "?"}/${truthRep.signals.photos.listed} alive${truthRep.signals.photos.timedOut ? ` (${truthRep.signals.photos.timedOut} probe timeout(s), kept)` : ""}</div>`
          : `<div class="banner" style="background:#2a2114;border-color:#6b511f;color:#e8c05f"><b>BRAND-TRUTH ${truthRep.hardFail ? "HARD FAIL" : "DEGRADED"} (v14 preflight):</b> ${truthRep.degraded.map((d) => esc(d)).join(" · ")}</div>`
        : `<div class="sub bad-line">brand-truth preflight: NOT RUN</div>`;

      const finalG = gateRounds[gateRounds.length - 1];
      const summary = finalG
        ? `final residuals: density ${finalG.density.length} · washout ${finalG.heroContrast.findings.length} · underscale ${finalG.heroUnderscale?.length ?? 0} · near-miss ${finalG.washoutNearMiss?.length ?? 0} · skeleton ${finalG.skeletonBars?.length ?? 0} · accent-as-fill ${finalG.accentFill.findings.length} · edge-crop ${finalG.edgeCrop.residual.length} · structural ${finalG.structural.length} · rt-blocking ${finalG.renderTruthBlocking.length} · vision-severe scenes [${finalG.vision.filter((v) => v.severe.length).map((v) => v.scene).join(", ") || "none"}] · sequence vision: detached (pending at publish)`
        : "NO GATE ROUNDS";

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dogfood cycle ${esc(CYCLE)} — ${esc(BRAND)}</title>
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
  <h1>Dogfood cycle ${esc(CYCLE)} — ${esc(BRAND)} (brief ${esc(BRIEF_ID)})</h1>
  <div class="banner"><b>V11 BATCH:</b> META-TEXT LEAK gate (leaked reasoning prose in JSX text nodes strips
  deterministically at the element gate; prose-dominated emissions reject — the cycle-2 s2 class) ·
  unowned-copy BINDING check (c.&lt;field&gt; references for unowned fields strip/reject in-round; value
  coverage widened to eyebrow/caption/cta with trailing-punct + case variants — the cycle-2 s4 duplicate
  class) · clamp-vs-slot routing (a piece &gt;25% oversized for its slot, or whose clamp would land on a
  neighbor's territory, regens directly — no more clamp ricochets) · full-bleed vertical-fill head clause +
  register-aware barbell repair (full-bleed barbells route to the HERO) · logo-glyph count finding (&gt;1
  brand mark per hero mock) · interior-clip advisory (text protruding &gt;30% past its piece union) ·
  sequence verdict fires on round-0 frames and threads into round-1+ regen prompts. All v10 gates retained.
  <b>V14:</b> BRAND-TRUTH integrity gate — failover/parked detection, logo decode, accent sanity, and photo
  verification run at crawl time AND as a build-entry preflight against the cached extract (hardFail refuses
  the build; degraded builds carry the report — the Patagonia-failover class).</div>
  ${brandTruthHtml}
  <div class="sub">${esc(headline)}</div>
  <div class="sub">${esc(summary)}</div>
  <div class="sub">wall: script→preview ${wall.scriptToPreviewSeconds ?? "—"}s · cast wall ${wall.castWallSeconds}s · run total ${wall.totalRunSeconds.toFixed(1)}s ·
  cost split: ${costSplit} = <b>$${cost.totalUsd.toFixed(4)}</b></div>

  <h2>Retry / attempt telemetry</h2>
  ${retryPanel}

  <h2>Fast-router health</h2>
  ${fastHtml}

  <h2>Cache + truncation events</h2>
  ${cacheHtml}

  <h2>Frames — ${esc(BRAND)} (this run)</h2>
  <div class="row">
${rowGrid(sceneCells)}
  </div>

  <h2>Density — per scene per clause (incl. the per-hero floor)</h2>
  ${densityTable}

  <h2>Hero contrast — luminance spread / std-dev per scene</h2>
  ${contrastTable}

  <h2>Accent-as-fill — largest flat accent rectangle per hero (v10)</h2>
  ${accentTable}

  <h2>Script loop — attempts + surgical repairs (${esc(String(scriptRep.source ?? ""))})</h2>
  <ul>${scriptLogHtml || "<li>no attempts logged</li>"}</ul>

  <h2>Blueprint attempts (gpt-oss-120b @ Cerebras, validate=checkSceneComposition)</h2>
  <ul>${bpLogHtml || "<li>no attempts logged</li>"}</ul>
  <div class="sub">${esc(String((bpRep?.validatedClean ? "validated clean" : `residuals: ${JSON.stringify(bpRep?.residualErrors).slice(0, 300)}`)))}</div>

  <h2>Design system</h2>
  <div class="sub">${dsRep.acceptedFromModel ? `accepted from the model${dsRep.repaired ? " after ONE repair" : " first try"}` : `FELL BACK to synthesized canvas-plan consts (${esc(String(dsRep.error)).slice(0, 200)})`} ·
  ink ${dsRep.inkNeutralized ? "<b>NEUTRALIZED by neutralizeInk</b>" : "passed neutralizeInk unchanged"} ·
  required keyframes merged: ${esc(((dsRep.requiredKeyframesInjected as string[]) ?? []).join(", ") || "none")}</div>

  <details><summary>gate log — round by round (density · hero-contrast · accent-fill · edge-crop · structural · render-truth · vision)</summary>${gateLogHtml(gateRounds)}</details>
  <details><summary>per-call log (label / model / secs / tokens / stop)</summary>${callLogHtml()}</details>

  <h2>Phase timeline</h2>
  <div class="timeline">${bars}</div>
  <div>${legend}</div>

  <div class="foot">
    Dogfood runner = the acceptance8 pipeline generalized to any stored brief: script attempt 1 at effort low +
    json mode with a low→medium→high ladder and ≤${SCRIPT_MAX_SURGICAL} surgical field-patch repairs (v9: register
    runs are patchable); DS ∥ composition blueprints; GLM-5.2-FAST element cast with pre-render hero-density,
    img-src, and area-weighted hero-surface-contrast gates; the v6/v7 blocking gate set + v10 accent-as-fill +
    piece-edge-crop (deterministic clamp first) + no-progress breaker; sequence vision detached entirely (this
    page is written before its verdict; the span above patches in). Fonts derive from the brand crawl and are
    data:-inlined at finalize. Budget: ≤${TOTAL_LLM_CEILING} TOTAL LLM calls (text + vision); retries
    ≤${MAX_RETRY_ROUNDS} rounds. No reference build required (reference row intentionally absent).
  </div>
</body>
</html>
`;
      await writeOut();
      await fs.writeFile(path.join(OUT_DIR, "index.html"), html, "utf8");
    });

    // ── console summary ──────────────────────────────────────────────────────
    const cost = report.cost as { models: Record<string, { usd: number; calls: number }>; zaiVision: { usd: number; calls: number }; totalUsd: number };
    console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
    console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
    console.log(`genDir:  ${GEN_DIR}`);
    const split = Object.entries(cost.models)
      .map(([model, m]) => `${model.split("/").pop()} $${m.usd.toFixed(4)} (${m.calls})`)
      .concat([`vision $${cost.zaiVision.usd.toFixed(4)} (${cost.zaiVision.calls})`])
      .join(" + ");
    console.log(`${totalLlmCalls}/${TOTAL_LLM_CEILING} LLM calls · ${split} = $${cost.totalUsd.toFixed(4)}`);
    const fr = report.fastRouter as { medianTokS: number | null; degraded: boolean; fallbacks: unknown[] };
    console.log(`fast router: median ${fr.medianTokS ?? "n/a"} tok/s · degraded=${fr.degraded} · fallbacks=${fr.fallbacks.length} · stop=length events ${stopLengthEvents.length} · cache-busts ${cacheBustEvents.length}`);
    console.log("\nPHASE TIMELINE:");
    for (const m of marks) console.log(`  ${m.phase.padEnd(34)} ${String(m.startS).padStart(7)}s → ${String(m.endS).padStart(7)}s  (${(m.endS - m.startS).toFixed(1)}s)`);

    // ── detached sequence-vision settlement (v10) ────────────────────────────
    // Everything above is DONE and on disk: wall, cost, gallery, report. Now —
    // and only now — wait (bounded) for the advisory sequence verdict and
    // PATCH it into the already-written artifacts. The recorded wall is never
    // touched; a hard stop after 180s abandons the verdict honestly.
    const SEQ_HARD_STOP_MS = 180_000;
    const landed = await Promise.race([
      sequenceDone,
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), SEQ_HARD_STOP_MS);
        t.unref?.();
      }),
    ]);
    if (landed !== null) sequenceFinal = landed;
    for (const f of sequenceFinal) console.log(`  sequence (detached): ${f.issue.slice(0, 160)}`);
    if (landed === null) console.warn(`  sequence vision never landed within ${SEQ_HARD_STOP_MS / 1000}s — abandoned (advisory; artifacts already shipped)`);

    // Patch the report JSON in place — targeted fields only, never writeOut
    // (writeOut would recompute the wall and swallow the detachment).
    try {
      const reportPath = path.join(OUT_DIR, "build-report.json");
      const j = JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<string, unknown>;
      j.sequenceFinal = sequenceFinal;
      j.sequenceSkippedAfterAbort = sequenceAborted;
      j.sequenceDetached = {
        startedAtS: sequenceStartS,
        landedAtS: sequenceLandedAtS,
        judgedOnRound: sequenceJudgedRound,
        notesThreadedIntoRegens: sequenceNotes,
        hardStopped: landed === null,
        offCriticalPath: true,
        note: "v11: fired detached on the FIRST round's frames; if the verdict landed before later regen rounds, its notes were threaded into those regen prompts as negative guidance. wall.totalRunSeconds never includes it.",
      };
      // The vision spend that settled after the report was written.
      j.budget = { totalLlmCalls, ceiling: TOTAL_LLM_CEILING, budgetExhausted, visionCalls: zaiCalls };
      const cost0 = j.cost as { models: Record<string, { usd: number }>; zaiVision: { usd: number }; totalUsd: number } | undefined;
      if (cost0?.zaiVision) {
        const zaiUsd = costUsd(VISION_MODEL, zaiUsage);
        const textUsd = cost0.totalUsd - cost0.zaiVision.usd;
        j.cost = {
          ...cost0,
          zaiVision: { calls: zaiCalls, inputTokens: zaiUsage.input_tokens, outputTokens: zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
          totalUsd: textUsd + zaiUsd,
        };
      }
      await fs.writeFile(reportPath, JSON.stringify(j, null, 2), "utf8");
    } catch (e) {
      console.warn(`  sequence patch: report update failed — ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }

    // Patch the gallery's pending span.
    try {
      const galleryPath = path.join(OUT_DIR, "index.html");
      const html0 = await fs.readFile(galleryPath, "utf8");
      const seqHtml =
        landed === null
          ? `<li><b>sequence-vision (detached)</b>: verdict never landed (${SEQ_HARD_STOP_MS / 1000}s hard stop) — advisory only, abandoned</li>`
          : sequenceAborted && sequenceFinal.some((f) => f.issue.startsWith("SEQUENCE-JUDGE-ERROR:"))
            ? `<li><b>sequence-vision (detached)</b>: aborted on the first attempt — SKIPPED (v10: no retry; advisory)</li>`
            : sequenceFinal.length
              ? sequenceFinal.map((f) => `<li><b>sequence-vision (detached, advisory)</b>: ${esc(f.issue.slice(0, 320))}</li>`).join("\n")
              : `<li>sequence vision (detached): CLEAN</li>`;
      await fs.writeFile(
        galleryPath,
        html0.replace(/<!--RB_SEQ_START-->[\s\S]*?<!--RB_SEQ_END-->/, `<!--RB_SEQ_START-->${seqHtml}<!--RB_SEQ_END-->`),
        "utf8",
      );
      console.log(`  sequence verdict patched into report + gallery (landed at t=${sequenceLandedAtS ?? "n/a"}s; wall unchanged)`);
    } catch (e) {
      console.warn(`  sequence patch: gallery update failed — ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  } catch (err) {
    report.terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nTERMINAL: ${report.terminalError}`);
    await writeOut().catch(() => {});
    process.exitCode = 1;
  }
};

await main();
