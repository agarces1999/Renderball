/**
 * ACCEPTANCE V8 — the RETRY-ELIMINATION batch on the v7 FAST-tier stack,
 * verified against v7's measured 307.4s Klarna build. Same brand, same brief,
 * same reference (01KWTTHKKECT0GGZ6D7HBQP1R5); everything head-side GENERATED
 * again. SUCCESS CRITERION: pass every blocking gate on ROUND 0 (no run ever
 * has) with script attempts ≈ 1.
 *
 * Every fix is from the file:line-verified RETRY ROOT-CAUSE AUDIT
 * (speed-quality-pivot memory, 2026-07-16): retries were dominated by OUR OWN
 * defects — validator false-positives, contract self-contradictions, stale
 * caps, harness bugs — not model weakness.
 *
 * PRODUCTION fixes (landed with tests; this spike consumes them):
 *   1. schema-validator ATMOS_UNIT_TOKENS += motion-mechanics vocab — the
 *      prompt-MANDATED loop idiom no longer reads as copy-paste (run 2's
 *      TERMINAL reference fallback was the gram "breathes infinite loop
 *      scale" — three scenes each writing the idiom correctly).
 *   2. schema-validator: pure-numeral stat headlines ("4", "30%", "3x") pass.
 *   3. script prompt: both legacy worked examples rewritten into the current
 *      Composition/Animations format with ABSOLUTE beats ≥60% of scene
 *      duration (the prompt's exemplars now pass the prompt's own validator);
 *      relative idioms ("at end-0.5s") gone; buildUserMessage injects the
 *      COMPUTED per-scene beat floor.
 *   5/6. composition-head prompt states the interior-vs-ownsCopy rule the
 *      validator enforces + the bookend-hero density contract (≥4
 *      text-bearing interior items, nested structure); checkSceneComposition
 *      enforces the new clause; the Brewline worked example complies.
 *   7. cast-build element gate: PRE-RENDER static hero density (15el/4tx) +
 *      img-src whitelist with asset-id substitution — hollow heroes and
 *      blank-rectangle imgs repair IN-ROUND (~10s) instead of burning a
 *      44-100s render+vision gate round.
 *   9. cast-build hero cap is provider-aware (11000 on Fireworks — no TPM
 *      pre-debit there; 6000 stays honest on Cerebras).
 *  10. zai-vision: timeoutMs/maxTokens opts + a reasoning_content JSON
 *      fallback for the empty-content class (3/5 builds shipped sequence-QA
 *      BLIND on it).
 *
 * SPIKE-SIDE changes vs acceptance7:
 *   4. SURGICAL-REPAIR GROUNDING — the field-patch call carries an "ALLOWED
 *      NUMBERS" block (claimGroundingSources) and the system rule forbids
 *      adding any ungrounded digit-bearing claim (v7 patches invented
 *      $120 / 4x / $30 twice; the validator re-pass caught them at 1 attempt
 *      of wall each).
 *   8. NO-PROGRESS BREAKER + the run-1 SWAP-BUG fix — diagnosis: a piece
 *      whose element gate failed through repair shipped cast-build's
 *      PLACEHOLDER (the 1el/0tx density signature) while its gate-failed,
 *      syntax-valid emission stayed CACHED; every later round regenerated
 *      against a body that never rendered and re-measured the placeholder,
 *      byte-identical, three rounds running (run-1 s0.hero). Fixes:
 *      castBuild.elementOutcomes now busts disproven entries the moment a
 *      placeholder ships, and a regen-targeted piece whose density does not
 *      improve is never re-targeted with the same feedback — ONE escalation
 *      (fresh full emission, blueprint authoritative, previous failure
 *      named), then accept-and-flag.
 *   9b. stop=length is handled GENERICALLY in budgetedCast: one immediate
 *      cap-raise retry (×1.8, bounded 40k); truncated text is never parsed.
 *  10b. sequence vision runs OFF the critical path — concurrent with the
 *      comparison-row/gallery assembly (its findings are advisory) — with
 *      timeoutMs 120s + maxTokens 6000.
 *  11. a fast-router error earns ONE jittered in-spike retry ON FAST before
 *      any std fallback (castCall already retried 4x in-provider; a
 *      synchronized burst exhausts those together), and a transport-failure
 *      repair can no longer bust a good cache entry.
 *  12. script policy: attempt 1 at effort LOW + json:true (post-fix yield
 *      projected 70-85%); ladder low→medium→high, surgical repairs, and the
 *      salvage parser all kept.
 *
 * GALLERY (.data/acceptance8/index.html): v8 row vs the v7 row vs the Klarna
 * GLM reference row (v7 + reference frames copied from .data/acceptance7 —
 * same artifacts, no re-render), the v7-vs-v8 phase-timeline table (v7
 * baseline: script 85.2 · DS 41.7 · comp 17.5 · cast+gates 110.2 ·
 * seq-vision 65.9 · total 307.4), and a RETRY/ATTEMPT TELEMETRY panel:
 * round-0 gate result, script/blueprint attempts, cache/cap events, 429s,
 * no-progress breaker events.
 *
 * BUDGET: ≤80 TOTAL LLM calls (Fireworks + Cerebras + z.ai vision all count).
 * The guard aborts retries honestly; every exit path writes a partial report.
 *
 *   set -a && source .env.local && set +a && node scripts/acceptance8-spike.mjs
 *
 * Footprint: this file + scripts/acceptance8-spike.mjs + .data/acceptance8/ +
 * src/generated/CAST_SPIKE_A8_KLARNA. Reads everything, modifies nothing else.
 */
import { promises as fs } from "fs";
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
const OUT_DIR = path.join(ROOT, ".data", "acceptance8");
/** The v7 run's artifacts — v7 + reference rows are COPIED, never re-rendered. */
const V7_DIR = path.join(ROOT, ".data", "acceptance7");
const GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_A8_KLARNA");
const SCENES = [0, 1, 2, 3, 4];
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

/** STANDARD tier — the per-call fallback when the fast router errors or
 *  degrades. effort "high" maps to thinking {enabled, budget 8192} on this
 *  wire; "none" is a true off switch (cast-provider). */
const FIREWORKS_GLM = "accounts/fireworks/models/glm-5p2";
/** FAST tier (change A) — same GLM-5.2 weights, speculative decoding +
 *  prefill/decode separation. Measured 232-274 tok/s single-stream (A/B
 *  2026-07-16 vs standard's 45-60 that evening). Separate rate-limit bucket.
 *  isFireworksModel matches the "accounts/fireworks/" prefix, and cast-build's
 *  effortFor matches "/glm-5p" → elements run thinking-OFF — no provider or
 *  routing change needed. */
const FIREWORKS_GLM_FAST = "accounts/fireworks/routers/glm-5p2-fast";
/** Below this sustained (median, sizeable calls) tok/s the fast tier is not
 *  paying for itself — degrade to standard per-call, loudly. */
const FAST_SUSTAINED_FLOOR_TOKS = 150;
/** The proven blueprint author (acceptance v2): gpt-oss-120b @ Cerebras. */
const BLUEPRINT_MODEL = "gpt-oss-120b";
const HEAD_EFFORT = "high" as const;
/** Fix 12 — script policy: ATTEMPT 1 at effort "low" + json:true. The audit
 *  killed the failure classes that made low a coin flip (the atmosphere
 *  4-gram false positive, the stat-headline reject, the beat-floor
 *  arithmetic now injected into the user message), so post-fix first-attempt
 *  yield projects 70-85%. Repair RE-EMISSIONS keep the low→medium→high
 *  ladder; surgical patches stay low (small, field-scoped edits) and are
 *  grounding-locked (fix 4). */
const SCRIPT_EFFORT = "low" as const;
const SCRIPT_EFFORT_LADDER: ("low" | "medium" | "high")[] = ["low", "medium", "high"];
const SCRIPT_MAX_TOKENS = 16000; // production Agent-1 cap
const DS_MAX_TOKENS = 10000;
const SCRIPT_MAX_ATTEMPTS = 3;
/** Surgical field-patch repairs before falling back to full re-emission (D3). */
const SCRIPT_MAX_SURGICAL = 2;

/** ≤80 TOTAL LLM calls — text (Fireworks + Cerebras) AND vision all count. */
const TOTAL_LLM_CEILING = 80;
const MAX_RETRY_ROUNDS = 2;

/** $/M tokens for per-call cost accounting (v5's table + the fast router). */
const MODEL_PRICES: Record<string, [number, number]> = {
  "accounts/fireworks/models/glm-5p2": [1.4, 4.4],
  "accounts/fireworks/routers/glm-5p2-fast": [2.1, 6.6], // A/B verified 2026-07-16
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
  label: string; model: string; secs: number; in: number; out: number; stop: string | null; cached: boolean; tokPerSec?: number;
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

// ── fast-router health (change A): observe, degrade loudly, never die ───────
/** Every sizeable fast-tier call's observed decode rate. Tiny calls (canary,
 *  sub-300-token patches) measure queueing, not decode — excluded. */
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
        `Every subsequent fast-routed call FALLS BACK to the standard tier. This is a KEY FINDING, not a footnote.\n`,
    );
  }
};

/** Spike-local sleep for the jittered fast retry (fix 11). */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Fix 11 evidence: jittered in-spike fast retries and whether they recovered. */
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
  // Fix 9b — GENERIC stop=length rule: truncated output is NEVER parsed. One
  // immediate cap-raise retry (×1.8, bounded 40k — the Cerebras output hard
  // cap) and the retry result wins either way; a still-truncated survivor is
  // rejected by the caller's own gates, never accepted silently.
  const fireLengthAware = async (model: string): Promise<CastResult> => {
    const first = await fire(model);
    if (first.stopReason !== "length") return first;
    const retryCap = Math.min(Math.ceil(args.maxTokens * 1.8), 40000);
    console.warn(`  [stop=length] ${label}: truncated at cap ${args.maxTokens} — ONE cap-raise retry at ${retryCap} (truncated text is never parsed)`);
    const retry = await fire(model, retryCap);
    stopLengthEvents.push({ label, cap: args.maxTokens, retryCap, recovered: retry.stopReason !== "length" });
    return retry;
  };
  try {
    return await fireLengthAware(wantFast && fastRouterDegraded ? FIREWORKS_GLM : args.model);
  } catch (e) {
    if (!wantFast || fastRouterDegraded || e instanceof BudgetExceeded) throw e;
    // Fix 11: castCall already retried 429s 4x in-provider (retry-after
    // honored) — but a synchronized 14-wide burst can exhaust those retries
    // TOGETHER. ONE extra jittered in-spike attempt on FAST after the burst
    // drains recovers most of them; v7 fell straight back to standard (3x
    // slower, and it split the per-replica prompt-cache key space).
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
/** True when a vision call may fire; false = budget spent (skip honestly). */
const visionBudgetOk = (): boolean => totalLlmCalls < TOTAL_LLM_CEILING;
const countVisionCall = (): void => {
  totalLlmCalls += 1;
  zaiCalls += 1;
};

// ── caching + feedback caller for castBuild — v7's verified-emission cache
//    + the v8 fixes: outcome-driven busts (the run-1 swap bug), the
//    no-progress ESCALATION path, and transport-failure repairs that can no
//    longer bust a good entry (fix 11). stop=length now lives generically in
//    budgetedCast (fix 9b). ────────────────────────────────────────────────

const pieceCache = new Map<string, string>(); // pieceId → last VERIFIED emission (stripped)
let pieceTargets = new Map<string, string[]>(); // pieceId → gate feedback lines
let castRoundLabel = "cast-r0";

/** stop=length retries + cache-population refusals + no-progress events —
 *  the report's evidence for fixes 8/9b. */
const stopLengthEvents: { label: string; cap: number; retryCap: number; recovered: boolean }[] = [];
const cacheBustEvents: { pieceId: string; reason: string }[] = [];
/** Fix 8: pieceId → last measured density metric of a regen-targeted piece. */
const regenHistory = new Map<string, { metric: string; escalated: boolean }>();
const noProgressEvents: { pieceId: string; round: number; action: "escalated" | "accepted-and-flagged"; metric: string }[] = [];
const ESCALATION_MARK = "[NO-PROGRESS ESCALATION]";

/** The same fragment harness cast-build verifies with (verifyFragment is
 *  module-private there): syntax success is the cache key — a truncated or
 *  broken emission must NEVER populate its entry (the v6-era poison). */
const verifyFragmentCheap = (body: string): Promise<string | null> =>
  verifyCompilable(`const __CastPiece = () => (\n<div>\n${body}\n</div>\n);`);

const cachingCaller: typeof castCall = async (call) => {
  const pieceId = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
  const feedback = pieceTargets.get(pieceId);
  let cached = pieceCache.get(pieceId);
  const isRepair = call.user.includes("Your previous attempt failed");
  // Fix 11: a repair whose cause was the CALL failing (transport/429 through
  // both tiers) disproves NOTHING about the cached body — v7 busted good
  // entries here. Replay the cached body; cast-build re-gates it for free.
  const isTransportRepair = isRepair && call.user.includes("(the call itself failed)");
  if (isTransportRepair && cached !== undefined) {
    callLog.push({ label: `${castRoundLabel}:${pieceId}:transport-repair-replayed-cache`, model: "(cache)", secs: 0, in: 0, out: 0, stop: "cached-replay", cached: true });
    console.warn(`  [cache] ${pieceId}: repair caused by a failed CALL, not a failed body — cached emission replayed, entry kept`);
    return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "cached-replay" };
  }
  // A CONTENT repair means the body it carries just failed cast-build's full
  // element gate — the cached emission is disproven; bust it, hit the model
  // fresh (v7 change B, kept).
  if (isRepair && cached !== undefined) {
    pieceCache.delete(pieceId);
    cached = undefined;
    cacheBustEvents.push({ pieceId, reason: "repair call — cached emission failed cast-build's full element gate; entry busted" });
    console.warn(`  [cache-bust] ${pieceId}: cached emission disproven by a repair call — model hit fresh`);
  }
  if (!feedback && !isRepair && cached !== undefined) {
    callLog.push({ label: `${castRoundLabel}:${pieceId}`, model: "(cache)", secs: 0, in: 0, out: 0, stop: "cached-replay", cached: true });
    return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "cached-replay" };
  }
  // Fix 8: an ESCALATED target gets a FRESH full emission — no previous-
  // version block (two variants of it already measured byte-identical); the
  // brief itself carries the blueprint inventory verbatim (cast-build
  // blueprintLines), and the previous failures ride along, named.
  const escalated = !!feedback && feedback[0].startsWith(ESCALATION_MARK);
  const user = feedback
    ? escalated
      ? [
          call.user,
          ``,
          `════ NO-PROGRESS ESCALATION ════`,
          ...feedback,
          ``,
          `Ignore everything you produced for this element before — do NOT emit a variant of it. Re-emit this element FRESH from the brief above: the blueprint inventory is authoritative and every named item must be visibly present, nested inside real structure.`,
        ].join("\n")
      : [
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
    // cast-build's native routing decided model + effort — forward verbatim.
    const label = `${castRoundLabel}:${pieceId}${feedback ? (escalated ? ":escalation" : ":regen") : ""}${isRepair ? ":repair" : ""}`;
    const res = await budgetedCast(label, {
      system: call.system,
      user,
      maxTokens: call.maxTokens,
      model: call.model ?? FIREWORKS_GLM_FAST,
      ...(call.effort ? { effort: call.effort } : {}),
    });
    // The cache keys on emission sanity + fragment-syntax SUCCESS (v7 change
    // B, kept). stop=length was already retried once inside budgetedCast
    // (fix 9b) — a still-truncated survivor is refused here.
    const stripped = stripCodeFence(res.text);
    const sane =
      res.stopReason !== "length" &&
      stripped.trim().length >= 8 &&
      stripped.includes("<") &&
      !/^\s*(?:import|export)\b/.test(stripped);
    if (sane && (await verifyFragmentCheap(stripped)) === null) {
      pieceCache.set(pieceId, stripped);
    } else if (res.text) {
      cacheBustEvents.push({ pieceId, reason: `emission not cache-worthy (stop=${res.stopReason}, sane=${sane}) — entry NOT populated` });
    }
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

/** D2: salvage parser — when JSON.parse rejects the whole output, scan to the
 *  first '{', brace-balance (string-aware), and try the span. json:true makes
 *  this rare; the salvage catches the residual prose-wrapped class. */
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

/** D3: the failure classes a surgical field-patch can fix — each line names a
 *  scene and exactly one content field or the visual_concept. Structural
 *  failures (shape, timing tiling, scene count, duration) re-emit in full. */
const FIELD_SCOPED_ERROR_RX: RegExp[] = [
  /^Section \d+ content\.headline /, // readability / length / two-sentence cram
  /^Scene \d+: latest timed beat /, // beat coverage (visual_concept)
  /^Scene \d+: visual_concept too thin /,
  /^Scene \d+: names "/, // container furnishing (visual_concept)
  /^Scenes [\d, ]+ share the same atmosphere phrase/, // atmosphere copy-paste
  /^These numeric claims are NOT grounded/, // copy fields
  /^These funding-stage labels aren't stated/, // copy fields
  /^Type-only scenes /, // visual_concept
];
const isFieldScoped = (error: string): boolean => {
  const lines = error.split(/\n| \| /).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => FIELD_SCOPED_ERROR_RX.some((rx) => rx.test(line)));
};

type ScriptCheck =
  | { ok: true; script: LooseScript }
  | { ok: false; error: string; fieldScoped: boolean; normalized: unknown };

/** The full production post-parse chain + richness guards, on a PARSED object
 *  (v7's processScriptAttempt minus the JSON parse — the salvage parser and
 *  the surgical-merge path both feed this). Failures carry the normalized
 *  script so a field patch has a base to merge into. */
const processScriptObject = (parsed: unknown, brief: AgentBrief, briefId: string): ScriptCheck => {
  const withIdentity = injectIdentity(parsed, brief, briefId);
  const withAssets = mergePreallocatedAssets(withIdentity, brief);
  const normalized = backfillSceneRegisters(normalizeScriptContent(withAssets));
  const fail = (error: string): ScriptCheck => ({ ok: false, error, fieldScoped: isFieldScoped(error), normalized });
  const validation = validateScript(normalized);
  if (!validation.ok) return fail(validation.error);
  const script = validation.script as unknown as LooseScript;

  // Duration guard (production): the requested duration is authoritative.
  const wantSec = brief.duration_seconds;
  const gotSec = script.config?.duration_seconds ?? 0;
  if (typeof wantSec === "number" && wantSec > 0 && Math.abs(gotSec - wantSec) > 0.5) {
    return fail(`config.duration_seconds is ${gotSec}s but the brief requires EXACTLY ${wantSec}s. Set config.duration_seconds = ${wantSec} and re-tile ALL scenes to fill 0→${wantSec} with no gaps.`);
  }
  // Scene-count contract for the Section0..4 composition tail.
  if (script.scenes.length !== 5) {
    return fail(`Script has ${script.scenes.length} scenes but the brief requires EXACTLY 5 sections (one per moment).`);
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
    return fail(parts.join("\n"));
  }
  // Visual-richness guard (production): no type-only scenes.
  const typeOnly = findTypeOnlyScenes(script.scenes as { visual_concept?: string }[]);
  if (typeOnly.length > 0) {
    return fail(`Type-only scenes (visual_concept is just a headline plus ambient decoration, nothing to look at): ${typeOnly.map((i) => `scene ${i}`).join(", ")}. EVERY scene must specify a concrete non-text/diegetic visual (a product mock, dashboard, diagram, chart, annotated illustration).`);
  }
  return { ok: true, script };
};

// ── D3: surgical field-patch repair — never re-emit a whole script for a
//    field-scoped failure ────────────────────────────────────────────────────

const SURGICAL_SYSTEM = [
  `You repair ONE validation failure in an otherwise-valid animated-video Script JSON with a MINIMAL field patch.`,
  `You are given the full Script JSON and the validation errors verbatim. Reply with ONLY a JSON object of this exact shape — nothing else:`,
  `{"scenes":[{"index":<scene index>, "content":{<ONLY the corrected content fields>}, "visual_concept":"<the FULL corrected string — include ONLY when the error names visual_concept, timed beats, atmosphere phrasing, or a type-only scene>"}]}`,
  `Rules: patch ONLY the scenes and fields the errors name; leave every other word of the script untouched.`,
  `GROUNDING (HARD): any digit-bearing CLAIM token you ADD anywhere in the patch — a price, percent, multiplier, count, or latency — must appear VERBATIM in the user message's "ALLOWED NUMBERS" block. If the number you want is not there, write the copy QUALITATIVELY instead; never invent stats. (Timing beats like "at 2.4s" are the only exception.)`,
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
  }
  if (touched.length === 0) return { error: "patch touched no scene fields" };
  return { merged: { ...(base as unknown as Record<string, unknown>), scenes }, touched };
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
  /** Every measured piece's interior stats — the no-progress breaker's metric. */
  pieces: { id: string; elements: number; textNodes: number }[];
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
      scenes.push({ scene: r.scene, ssrError: r.error, bestDiegetic: null, diegeticPass: false, hero: null, heroPass: false, depth: 0, depthPass: false, gradientSignatures: [], badImgSrcs: [], pieces: [] });
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
      pieces: pieces.map((p) => ({ id: p.id, elements: p.elements, textNodes: p.textNodes })),
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

// ── sequence vision — ONCE, after the final per-scene round; advisory and
//    OFF the critical path in v8 (fix 10b). Keeps v7's malformed-verdict
//    retry; adds the 120s/6k transport opts (fix 10). ──────────────────────

let sequenceRetried = false;

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
    // Fix 10: 120s timeout (60s measurably killed the 5-image judgment
    // mid-generation) + 6000 tokens (thinking ate the old cap and content
    // came back empty; zai-vision now also reads reasoning_content as a
    // fallback).
    const { text, usage } = await callZaiVision(imagesB64, prompt, { maxTokens: 6000, timeoutMs: 120_000 });
    zaiUsage = addUsage(zaiUsage, usage);
    return text;
  };
  const ordered = measurements
    .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
    .sort((a, b) => a.scene - b.scene);
  const imagesB64 = await Promise.all(ordered.map(async (m) => (await fs.readFile(m.screenshotPath)).toString("base64")));
  let findings = await judgeSequence(imagesB64, brandTruth, sequenceJudge);
  // v8 (change F): a malformed/no-JSON verdict earns ONE retry — v7 paid for
  // the whole multi-image pass and discarded it on a bad parse.
  if (findings.some((f) => f.issue.startsWith("SEQUENCE-JUDGE-ERROR:")) && visionBudgetOk()) {
    console.warn(`  sequence verdict malformed (${findings[0]?.issue.slice(0, 120)}) — ONE retry`);
    sequenceRetried = true;
    findings = await judgeSequence(imagesB64, brandTruth, sequenceJudge);
  }
  return findings;
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
      // (a6) the per-hero floor names the hero — route to it exactly.
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
  // (a6) hero-washout is BLOCKING — the finding routes a hero regen
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

// ── contrast-cell shape (v8 heroes measured live; reference cells come from
//    the v7 report — its lego pieces are content-named, proxy-sampled there) ──

interface ContrastCell extends HeroLuminanceStats {
  proxy: boolean;
  washout: boolean;
}

// ── report shapes ────────────────────────────────────────────────────────────

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
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/acceptance8-spike.mjs");
    process.exitCode = 1;
    return;
  }
  if (!process.env.RB_FIREWORKS_KEY) {
    console.error("RB_FIREWORKS_KEY missing — the v5 cast stack (GLM-5.2 @ Fireworks) needs it");
    process.exitCode = 1;
    return;
  }
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT_DIR, "v8"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "v7"), { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "reference"), { recursive: true });

  // Cast routing (change A): HERO+LEAVES both on the FAST router. cast-build's
  // effortFor matches "/glm-5p" → thinking-OFF per element, unchanged.
  delete process.env.RB_CAST_MODEL;
  process.env.RB_CAST_MODEL_HERO = FIREWORKS_GLM_FAST;
  process.env.RB_CAST_MODEL_LEAVES = FIREWORKS_GLM_FAST;

  const report: Record<string, unknown> = {
    experiment:
      "ACCEPTANCE V8: the RETRY-ELIMINATION batch on Klarna — every fix from the file:line-verified retry root-cause audit: atmosphere 4-gram mechanics vocab + stat headlines + exemplar/beat-floor prompt fixes (script), surgical-repair grounding, composition-head ownership + bookend-hero density contract, PRE-RENDER hero/img gates in cast-build, no-progress breaker + run-1 swap-bug fix, provider-aware hero caps + generic stop=length rule, sequence vision off-critical-path (120s/6k + reasoning fallback), jittered fast-429 retry. SUCCESS CRITERION: ROUND 0 gate-clean, script attempts ≈1. Baseline: v7's 307.4s/$1.00.",
    brand: BRAND,
    ref: REF_BUILD,
    v7Baseline: { scriptS: 85.2, designSystemS: 41.7, compositionHeadS: 17.5, castAndGatesS: 110.2, sequenceVisionS: 65.9, totalS: 307.4, totalUsd: 1.0029 },
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
    // Change H: cost attribution keyed by the SERVED model id, derived from
    // perModel — the v5 report hard-bucketed Fireworks spend under 'cerebras';
    // here every model that actually served a call gets its own row (the fast
    // router and the standard tier report separately by construction).
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
    report.sequenceRetried = sequenceRetried;
    report.densityProfile = profile;
    report.finalContrast = finalContrast;
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

    // ── canaries: ALL THREE transports before any real spend (change A: the
    //    fast router is canaried too; a canary failure on fast falls back to
    //    standard inside budgetedCast — loudly, never dying) ─────────────────
    await phase("canary", async () => {
      const fast = await budgetedCast("canary-fireworks-fast", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: FIREWORKS_GLM_FAST, effort: "none" });
      console.log(`  fireworks glm-5p2-FAST ok — ${fast.seconds.toFixed(1)}s, stop=${fast.stopReason}`);
      const fw = await budgetedCast("canary-fireworks-standard", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: FIREWORKS_GLM, effort: "none" });
      console.log(`  fireworks glm-5p2 (standard, the fallback tier) ok — ${fw.seconds.toFixed(1)}s, stop=${fw.stopReason}`);
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
        // Change D: FAST router, effort "low" (bounded 1024 thinking),
        // json:true (response_format json_object — kills the parse-fail
        // class). If the serving stack rejects the json+thinking combo
        // outright, retry the SAME attempt once without json — loudly.
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
        if (parsed.salvaged) console.log(`  (salvage parser recovered the JSON span from prose-wrapped output — change D2 fired)`);
        let res = processScriptObject(parsed.parsed, agentBrief, briefId);
        scriptAttemptLog.push({ label: `attempt ${attempt}`, kind: "full", secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, error: res.ok ? null : res.error, salvaged: parsed.salvaged });
        if (res.ok) {
          console.log(`  script valid on attempt ${attempt}/${SCRIPT_MAX_ATTEMPTS} — ${r.seconds.toFixed(1)}s, ${r.outputTokens} tok out`);
          return { script: res.script, attempts: attempt, surgicalRepairs: surgicalUsed, fellBack: false };
        }
        lastError = res.error;
        console.warn(`  script attempt ${attempt} INVALID: ${res.error.split("\n")[0]}`);
        // Change D3: SURGICAL REPAIR — a field-scoped failure gets a minimal
        // field patch merged locally, never a whole-script re-emission. Full
        // re-emission only when surgical fails twice or the error is
        // structural.
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
              `════ ALLOWED NUMBERS — the ONLY digit-bearing claim tokens you may write ════`,
              `Any stat-shaped number in your patch (price, %, multiplier, count, latency) must appear VERBATIM below; otherwise write the copy qualitatively. Timing beats ("at 2.4s") are exempt.`,
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
            return { script: res.script, attempts: attempt, surgicalRepairs: surgicalUsed, fellBack: false };
          }
          lastError = res.error;
          console.warn(`  surgical repair ${surgicalUsed} did not clear validation: ${res.error.split("\n")[0]}`);
        }
        if (attempt < SCRIPT_MAX_ATTEMPTS) nextUser = fullRepairUser(r.text, lastError);
      }
      console.error(`  ▲▲▲ SCRIPT TERMINAL after ${SCRIPT_MAX_ATTEMPTS} attempts + ${surgicalUsed} surgical repair(s) (${lastError.split("\n")[0]}) — FALLING BACK to the reference script.json. This is a KEY FINDING, not a footnote: GLM-5.2-FAST could not clear the richness bar on this brand.`);
      return { script: backfillSceneRegisters(normalizeScriptContent(refScript)) as LooseScript, attempts: SCRIPT_MAX_ATTEMPTS, surgicalRepairs: surgicalUsed, fellBack: true };
    });
    script = scriptResult.script;
    report.script = {
      source: scriptResult.fellBack ? "REFERENCE FALLBACK (terminal validation failure — see scriptAttemptLog)" : `GENERATED on ${FIREWORKS_GLM_FAST} (effort ${SCRIPT_EFFORT}, json mode), valid on attempt ${scriptResult.attempts} after ${scriptResult.surgicalRepairs} surgical repair(s)`,
      generated: !scriptResult.fellBack,
      attempts: scriptResult.attempts,
      surgicalRepairs: scriptResult.surgicalRepairs,
      fellBackToReference: scriptResult.fellBack,
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
      headlines: script.scenes.map((s) => s.content?.headline),
    };
    await writeOut();

    // ── PHASES 2 ∥ 3: DESIGN SYSTEM ∥ BLUEPRINTS (change E) — the audit
    //    measured ZERO data dependencies between them, so both launch the
    //    moment the script validates and are awaited together (v7 serialized
    //    them for 21.3s of avoidable wall). DS runs on the FAST router.
    const refFonts = fontsFromReference(manifest.preamble);
    const refKfLoc = findConstDecl(manifest.preamble, "SHARED_KEYFRAMES");
    const refKeyframesCss = refKfLoc ? manifest.preamble.slice(refKfLoc.start, refKfLoc.end) : "";
    const dsPromise = phase("design-system", async () => {
      const user = dsUserPrompt(script!, be, { display: refFonts.display, body: refFonts.body }, signature);
      const first = await budgetedCast("design-system", { system: dsSystemPrompt, user, maxTokens: DS_MAX_TOKENS, model: FIREWORKS_GLM_FAST, effort: HEAD_EFFORT });
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
          model: FIREWORKS_GLM_FAST,
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
    // ── PHASE 3 (launched ∥ with DS): BLUEPRINTS — generateComposition on
    //    gpt-oss @ Cerebras; head cap now 28000 in PRODUCTION
    //    (lib/agents/composition-head.ts — change C; v7 truncated attempts
    //    1-2 at exactly the old 16k) ─────────────────────────────────────────
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
          author: `${BLUEPRINT_MODEL} @ Cerebras, effort high (the proven blueprint author — acceptance v2), HEAD_MAX_TOKENS 28000 (change C)`,
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

    // Change E: BOTH heads in flight together — one await.
    const [ds] = await Promise.all([dsPromise, compositionPromise]);

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

    // ── PHASES 4–5: cast (GLM-5.2-FAST @ Fireworks) + the v7 gate loop ───────
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
      // Fix 8(a) — the run-1 SWAP-BUG fix: a piece whose element gate failed
      // through repair shipped cast-build's PLACEHOLDER, so any cached
      // emission for it is DISPROVEN — bust it now, not on a later repair
      // call (run 1 kept s0.hero's gate-failed emission cached while the
      // 1el/0tx placeholder rendered, three rounds running).
      for (const o of castResult.elementOutcomes) {
        if (o.failed && pieceCache.has(o.pieceId)) {
          pieceCache.delete(o.pieceId);
          cacheBustEvents.push({ pieceId: o.pieceId, reason: "element gate failed through repair — placeholder shipped; cached emission disproven (run-1 swap-bug fix)" });
          console.warn(`  [cache-bust] ${o.pieceId}: placeholder shipped — stale emission evicted`);
        }
      }
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
      if (round === 0) {
        report.round0 = {
          passed: targets.size === 0,
          targets: [...targets.keys()],
          density: density.length,
          washouts: contrast.findings.length,
          structural: structural.length,
          rtBlocking: rt.blocking.length,
          visionSevereScenes: vision.filter((v) => v.severe.length > 0).map((v) => v.scene),
        };
        console.log(
          targets.size === 0
            ? "  ★★★ ROUND 0 PASSED — every blocking gate clean on the first cast (the v8 success criterion; no run has ever done this)"
            : `  ROUND 0 FAILED — ${targets.size} retry target(s): [${[...targets.keys()].join(", ")}]`,
        );
      }
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
      // Fix 8(b) — NO-PROGRESS BREAKER: a regen-targeted piece whose measured
      // density is byte-identical (or worse) after a round is never
      // re-targeted with the same feedback — ONE escalation (fresh full
      // emission; the brief's blueprint inventory is authoritative; previous
      // failure named), then accept-and-flag (run 1 shipped 3 unresolved
      // findings after three identical rounds on s0.hero).
      const metricOf = (pieceId: string): string => {
        const sceneIdx = Number(/^s(\d+)\./.exec(pieceId)?.[1] ?? -1);
        const st = profile?.scenes.find((s) => s.scene === sceneIdx)?.pieces.find((pp) => pp.id === pieceId);
        return st ? `${st.elements}el/${st.textNodes}tx` : "unmeasured";
      };
      const isProgress = (prevM: string, curM: string): boolean => {
        if (prevM === curM) return false;
        const p = /(\d+)el\/(\d+)tx/.exec(prevM);
        const c = /(\d+)el\/(\d+)tx/.exec(curM);
        if (!p || !c) return true; // shape changed (unmeasured ↔ measured) = movement
        return Number(c[1]) > Number(p[1]) || Number(c[2]) > Number(p[2]);
      };
      for (const [pieceId, feedback] of [...targets.entries()]) {
        const metric = metricOf(pieceId);
        const prev = regenHistory.get(pieceId);
        if (!prev) {
          regenHistory.set(pieceId, { metric, escalated: false });
          continue;
        }
        if (isProgress(prev.metric, metric)) {
          regenHistory.set(pieceId, { metric, escalated: prev.escalated });
          continue;
        }
        if (!prev.escalated) {
          pieceCache.delete(pieceId);
          cacheBustEvents.push({ pieceId, reason: "no-progress escalation — cached emission evicted for a FRESH re-emission" });
          targets.set(pieceId, [
            `${ESCALATION_MARK} two consecutive rounds measured this piece at ${metric} with the same blocking findings — a repaired variant of the previous approach is NOT working.`,
            `The previous round's failures, verbatim:`,
            ...feedback,
          ]);
          noProgressEvents.push({ pieceId, round, action: "escalated", metric });
          regenHistory.set(pieceId, { metric, escalated: true });
          console.warn(`  [no-progress] ${pieceId}: density unmoved at ${metric} — ESCALATED to a fresh full emission (cache busted, blueprint authoritative)`);
        } else {
          targets.delete(pieceId);
          noProgressEvents.push({ pieceId, round, action: "accepted-and-flagged", metric });
          console.warn(`  [no-progress] ${pieceId}: escalation did not move density (${metric}) — ACCEPTED AND FLAGGED (residual findings ship honestly)`);
        }
      }
      if (targets.size === 0) {
        console.log(`  every remaining target was accept-and-flagged by the no-progress breaker — done after round ${round}`);
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

    if (finalCode) await fs.writeFile(path.join(OUT_DIR, "Composition.acceptance8.tsx"), finalCode, "utf8");

    // Sequence vision — ONCE, after the final per-scene round, OFF the
    // critical path (fix 10b): its findings are advisory (log-only), so the
    // pass runs CONCURRENTLY with the v8-cell + comparison-row assembly below
    // and is awaited only where the gallery needs its findings.
    let sequencePromise: Promise<VisionFinding[]>;
    if (finalMeasurements.some((m) => m.screenshotPath)) {
      sequencePromise = phase("sequence-vision-final", () => runSequenceRound(finalMeasurements, brandTruth));
    } else {
      console.warn("  no screenshots — sequence vision skipped");
      sequencePromise = Promise.resolve([]);
    }
    await writeOut();

    // ── v8 final renders → .data/acceptance8/v8/scene{0..4}.png ─────────────
    const finalRound = gateRounds[gateRounds.length - 1];
    const v8Cells: RowCell[] = [];
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
        await fs.copyFile(shot, path.join(OUT_DIR, "v8", `scene${i}.png`));
        v8Cells.push({ scene: i, png: `v8/scene${i}.png`, label: script.scenes[i]?.label ?? `scene ${i}`, note });
      } else {
        v8Cells.push({ scene: i, label: script.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
      }
    }

    // ── COMPARISON ROWS: v7 + reference COPIED from .data/acceptance7 ────────
    // Same brand, same reference build — the v7 run's frames and measured
    // stats ARE the comparison; re-rendering them would spend wall re-proving
    // already-measured rows. Provenance is labeled in the gallery.
    const EMPTY_PROFILE: DensityProfile = { scenes: [], distinctSignatures: 0, repeated: [], varietyPass: false };
    const comparison = await phase("comparison-rows", async () => {
      interface V7Report {
        script?: { labels?: string[] };
        wall?: { totalRunSeconds?: number };
        cost?: { totalUsd?: number };
        densityProfile?: DensityProfile;
        finalContrast?: HeroContrastResult;
        reference?: { densityProfile?: DensityProfile; contrast?: ContrastCell[] };
      }
      let v7Report: V7Report | null = null;
      try {
        v7Report = JSON.parse(await fs.readFile(path.join(V7_DIR, "build-report.json"), "utf8")) as V7Report;
      } catch (e) {
        console.warn(`  v7 build-report unreadable (${e instanceof Error ? e.message : e}) — comparison rows will be sparse`);
      }
      const copyRow = async (sub: string): Promise<Map<number, string>> => {
        const out = new Map<number, string>();
        for (const i of SCENES) {
          const ok = await fs
            .copyFile(path.join(V7_DIR, sub, `scene${i}.png`), path.join(OUT_DIR, sub, `scene${i}.png`))
            .then(() => true)
            .catch(() => false);
          if (ok) out.set(i, `${sub}/scene${i}.png`);
        }
        return out;
      };
      const v7Pngs = await copyRow("v7");
      const refPngs = await copyRow("reference");
      const noteFor = (prof: DensityProfile | undefined, i: number): string => {
        const p = prof?.scenes.find((s) => s.scene === i);
        if (!p) return "no measured stats";
        if (p.ssrError) return "SSR ERROR";
        return `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · hero ${p.hero ? `${p.hero.elements}el/${p.hero.textNodes}tx` : "none"} · depth ${p.depth}`;
      };
      const v7Labels = v7Report?.script?.labels ?? [];
      const v7RowCells: RowCell[] = SCENES.map((i) => ({
        scene: i,
        ...(v7Pngs.has(i) ? { png: v7Pngs.get(i)! } : {}),
        label: v7Labels[i] ?? `scene ${i}`,
        note: noteFor(v7Report?.densityProfile, i),
      }));
      const refCells: RowCell[] = SCENES.map((i) => ({
        scene: i,
        ...(refPngs.has(i) ? { png: refPngs.get(i)! } : {}),
        label: refScript.scenes[i]?.label ?? `scene ${i}`,
        note: noteFor(v7Report?.reference?.densityProfile, i),
      }));
      console.log(`  comparison rows copied: v7 ${v7Pngs.size}/5 · reference ${refPngs.size}/5 (from ${V7_DIR})`);
      return {
        v7Cells: v7RowCells,
        cells: refCells,
        profile: v7Report?.reference?.densityProfile ?? EMPTY_PROFILE,
        contrast: v7Report?.reference?.contrast ?? [],
        v7Profile: v7Report?.densityProfile ?? EMPTY_PROFILE,
        v7Wall: v7Report?.wall?.totalRunSeconds ?? 307.4,
        v7Usd: v7Report?.cost?.totalUsd ?? 1.0029,
      };
    });
    const reference = comparison; // .cells/.profile/.contrast — the gallery's reference row
    report.reference = { densityProfile: reference.profile, contrast: reference.contrast, copiedFrom: V7_DIR };

    // v8 contrast cells for the gallery table (heroes only — cast builds
    // always carry .hero pieces).
    const v8ContrastCells: ContrastCell[] = (finalContrast?.stats ?? []).map((s) => ({
      ...s,
      proxy: false,
      washout: !!finalContrast?.findings.find((f) => f.scene === s.scene && f.pieceId === s.pieceId),
    }));

    // The advisory sequence pass rejoins here — the gallery prints its findings.
    sequenceFinal = await sequencePromise;
    for (const f of sequenceFinal) console.log(`  sequence: ${f.issue.slice(0, 160)}`);
    await writeOut();

    // ── GALLERY ──────────────────────────────────────────────────────────────
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

      // v7 → v8 phase comparison (the batch's headline table). v7 baseline
      // from the measured acceptance7 run; v8 aggregates from this run's marks.
      const durOf = (name: string): number => Math.round(marks.filter((p) => p.phase === name).reduce((n, p) => n + (p.endS - p.startS), 0) * 10) / 10;
      const headPhases = marks.filter((p) => p.phase === "design-system" || p.phase === "composition-head");
      const headWall = headPhases.length ? Math.round((Math.max(...headPhases.map((p) => p.endS)) - Math.min(...headPhases.map((p) => p.startS))) * 10) / 10 : 0;
      const castGatesWall = castStartS !== null && previewEndS !== null ? Math.round((previewEndS - castStartS) * 10) / 10 : 0;
      const v7b = report.v7Baseline as { scriptS: number; designSystemS: number; compositionHeadS: number; castAndGatesS: number; sequenceVisionS: number; totalS: number };
      const cmpRows: [string, number, number][] = [
        ["script", v7b.scriptS, durOf("script")],
        ["design-system", v7b.designSystemS, durOf("design-system")],
        ["composition-head", v7b.compositionHeadS, durOf("composition-head")],
        [`DS ∥ comp-head wall (E)`, Math.round((v7b.designSystemS + v7b.compositionHeadS) * 10) / 10, headWall],
        ["cast + gates", v7b.castAndGatesS, castGatesWall],
        ["sequence-vision", v7b.sequenceVisionS, durOf("sequence-vision-final")],
        ["TOTAL run", v7b.totalS, Math.round(wall.totalRunSeconds * 10) / 10],
      ];
      report.phaseComparison = cmpRows.map(([phaseName, v7s, v8s]) => ({ phase: phaseName, v7s, v8s, deltaS: Math.round((v8s - v7s) * 10) / 10 }));
      const cmpTable = `
  <div class="scroll"><table>
    <tr><th>phase</th><th>v7 (measured, s)</th><th>v8 (this run, s)</th><th>Δ</th><th>×</th></tr>
    ${cmpRows.map(([phaseName, v7s, v8s]) => `<tr><td style="text-align:left">${esc(phaseName)}</td><td>${v7s.toFixed(1)}</td><td class="${v8s <= v7s ? "ok" : "bad"}">${v8s.toFixed(1)}</td><td>${(v8s - v7s).toFixed(1)}</td><td>${v7s > 0 ? (v7s / Math.max(v8s, 0.1)).toFixed(1) : "—"}x</td></tr>`).join("\n")}
  </table></div>`;

      const fastTokRows = fastRep.samples
        .map((s) => `<tr><td style="text-align:left">${esc(s.label)}</td><td>${s.out}</td><td>${s.secs.toFixed(1)}s</td><td>${s.toks.toFixed(1)}</td></tr>`)
        .join("\n");
      const fastHtml = `
  <div class="sub">fast router (${esc(FIREWORKS_GLM_FAST)}): median <b>${fastRep.medianTokS ?? "n/a"}</b> tok/s · min ${fastRep.minTokS ?? "n/a"} · max ${fastRep.maxTokS ?? "n/a"} across ${fastRep.samples.length} sizeable calls (≥300 tok out) ·
  ${fastRep.degraded ? `<span class="bad-line">DEGRADED to standard mid-run (sustained &lt; ${FAST_SUSTAINED_FLOOR_TOKS} tok/s)</span>` : `<span class="ok-line">healthy all run (floor ${FAST_SUSTAINED_FLOOR_TOKS} tok/s)</span>`} ·
  error/degrade fallbacks to standard: ${fastRep.fallbacks.length}${fastRep.fallbacks.length ? ` (${esc(fastRep.fallbacks.map((f) => f.label).join(", ")).slice(0, 300)})` : ""}</div>
  <details><summary>fast-router per-call tok/s</summary><div class="scroll"><table><tr><th>call</th><th>tok out</th><th>secs</th><th>tok/s</th></tr>${fastTokRows || "<tr><td colspan=4>none</td></tr>"}</table></div></details>`;

      const cacheHtml = `
  <div class="sub">poisoned-cache fix (B): stop=length events <b>${stopLengthEvents.length}</b>${stopLengthEvents.length ? ` [${esc(stopLengthEvents.map((e) => `${e.label} ${e.cap}→${e.retryCap}${e.recovered ? " recovered" : " STILL TRUNCATED"}`).join(" · ")).slice(0, 400)}]` : ""} ·
  cache-bust / refuse-to-populate events <b>${cacheBustEvents.length}</b>${cacheBustEvents.length ? ` [${esc(cacheBustEvents.map((e) => e.pieceId).join(", ")).slice(0, 300)}]` : ""} ·
  sequence-vision retry fired: ${sequenceRetried ? "<b>yes</b>" : "no"}</div>`;

      const r0 = report.round0 as
        | { passed: boolean; targets: string[]; density: number; washouts: number; structural: number; rtBlocking: number; visionSevereScenes: number[] }
        | undefined;
      const round0Html = r0
        ? r0.passed
          ? `<span class="ok-line"><b>ROUND 0 PASSED</b> — every blocking gate clean on the first cast (success criterion met; no prior run ever has)</span>`
          : `<span class="bad-line"><b>ROUND 0 FAILED</b></span> — ${r0.targets.length} retry target(s): [${esc(r0.targets.join(", "))}] · density ${r0.density} · washouts ${r0.washouts} · structural ${r0.structural} · rt-blocking ${r0.rtBlocking} · vision-severe scenes [${r0.visionSevereScenes.join(", ") || "none"}]`
        : "no round-0 record (cast never ran)";
      const npEsc = noProgressEvents.filter((x) => x.action === "escalated");
      const npFlag = noProgressEvents.filter((x) => x.action === "accepted-and-flagged");
      const retryPanel = `
  <div class="sub">${round0Html}</div>
  <div class="sub">script FULL attempts <b>${scriptAttemptLog.filter((a) => a.kind === "full").length}</b> (+${scriptAttemptLog.filter((a) => a.kind === "surgical").length} surgical; success criterion ≈1) ·
  blueprint attempts <b>${blueprintAttempts.length}</b> ·
  stop=length cap-raises <b>${stopLengthEvents.length}</b> ·
  cache busts <b>${cacheBustEvents.length}</b> ·
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
      <th colspan="5">v8 — GLM-5.2-FAST @ Fireworks (this run, all heads generated)</th>
      <th colspan="5">Klarna GLM reference (stats from the v7 run's re-measure)</th>
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
    <tr><th rowspan="2">scene</th><th colspan="2">v8 hero region</th><th colspan="2">reference (hero or main-diegetic proxy, v7-run stats)</th></tr>
    <tr><th>piece</th><th>luminance (washout = spread&lt;${WASHOUT_SPREAD_FLOOR} AND std&lt;${WASHOUT_STDDEV_FLOOR})</th><th>piece</th><th>luminance</th></tr>
    ${SCENES.map((i) => `<tr><td>scene ${i}</td>${contrastCellHtml(v8ContrastCells, i)}${contrastCellHtml(reference.contrast, i)}</tr>`).join("\n")}
  </table></div>`;

      const costSplit = Object.entries(cost.models)
        .map(([model, m]) => `${esc(model.split("/").pop() ?? model)} $${m.usd.toFixed(4)} (${m.calls} calls)`)
        .concat([`z.ai vision $${cost.zaiVision.usd.toFixed(4)} (${cost.zaiVision.calls} calls)`])
        .join(" + ");

      const headline = [
        `brand ${BRAND} (ref ${REF_BUILD})`,
        `script ${scriptRep.generated ? `GENERATED (attempt ${scriptRep.attempts}, ${scriptRep.surgicalRepairs} surgical)` : "REFERENCE FALLBACK"}`,
        `DS ${dsRep.acceptedFromModel ? (dsRep.repaired ? "ok after 1 repair" : "ok first try") : "FELL BACK"}${dsRep.inkNeutralized ? " · ink neutralized" : ""}`,
        `blueprints ${bpRep.validatedClean ? `clean on attempt ${bpRep.attempts}` : `RESIDUALS after ${bpRep.attempts}`}`,
        `${gateRounds.length} gate round(s)`,
        `${totalLlmCalls}/${TOTAL_LLM_CEILING} LLM calls`,
        `$${cost.totalUsd.toFixed(3)}`,
        `${wall.totalRunSeconds.toFixed(0)}s vs v7's 307s`,
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
<title>Acceptance v8 — ${esc(BRAND)}: the FAST-tier build vs v7 vs the GLM reference</title>
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
  <h1>Acceptance v8 — ${esc(BRAND)}: the FAST-tier build vs v7 vs the GLM reference</h1>
  <div class="banner"><b>THE V8 RETRY-ELIMINATION BATCH:</b> every fix from the file:line-verified retry
  root-cause audit — atmosphere 4-gram mechanics vocab · pure-numeral stat headlines · worked examples rewritten to
  pass the prompt's own validator + computed per-scene beat floors · surgical-repair grounding (ALLOWED NUMBERS) ·
  composition-head ownership rule + bookend-hero density contract (≥4 text-bearing interior items) · PRE-RENDER
  hero-density/img-src gates inside the element cast (in-round ~10s repairs instead of 44-100s gate rounds) ·
  no-progress breaker + the run-1 swap-bug fix (placeholder shipped while a gate-failed emission stayed cached) ·
  provider-aware hero caps (11k on Fireworks) + generic stop=length cap-raise · sequence vision OFF the critical
  path (120s/6k + reasoning_content fallback) · jittered fast-429 retry before any std fallback. Same Klarna
  brand/brief/reference as v6/v7. <b>SUCCESS CRITERION: ROUND 0 gate-clean, script attempts ≈1.</b></div>
  <div class="sub">${esc(headline)}</div>
  <div class="sub">${esc(summary)}</div>
  <div class="sub">wall: script→preview ${wall.scriptToPreviewSeconds ?? "—"}s · cast wall ${wall.castWallSeconds}s · run total ${wall.totalRunSeconds.toFixed(1)}s ·
  cost split: ${costSplit} = <b>$${cost.totalUsd.toFixed(4)}</b></div>

  <h2>Phase timeline — v7 (measured baseline) vs v8 (this run)</h2>
  ${cmpTable}

  <h2>Fast-router health (change A)</h2>
  ${fastHtml}

  <h2>Retry / attempt telemetry — the v8 success criterion</h2>
  ${retryPanel}

  <h2>Cache + truncation events (poisoned-cache fix + fix 9b/10)</h2>
  ${cacheHtml}

  <h2>Row — v8 (this run, GLM-5.2-FAST cast + the retry-elimination batch)</h2>
  <div class="row">
${rowGrid(v8Cells)}
  </div>

  <h2>Row — v7 (copied from .data/acceptance7 — the 307.4s v7 retry-audit baseline)</h2>
  <div class="row">
${rowGrid(comparison.v7Cells)}
  </div>

  <h2>Row — ${esc(BRAND)} GLM reference (frames + stats from the v7 run's re-measure)</h2>
  <div class="row">
${rowGrid(reference.cells)}
  </div>

  <h2>Density — per scene per clause, v8 vs reference (incl. the per-hero floor)</h2>
  ${densityTable}

  <h2>Hero contrast — luminance spread / std-dev per scene, v8 vs reference</h2>
  ${contrastTable}
  <div class="sub">reference row: the lego pieces are content-named (s0.checkout, s3.grid…) with no ".hero" ids — its
  cells sample the LARGEST diegetic piece as a documented proxy for the scene's hero.</div>

  <h2>Script loop — attempts + surgical repairs (${esc(String(scriptRep.source ?? ""))})</h2>
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
    v8 = the v7 FAST-tier pipeline + the RETRY-ELIMINATION batch. Script: attempt 1 at effort low + json mode,
    ladder low→medium→high, ≤${SCRIPT_MAX_SURGICAL} surgical field-patch repairs (now grounding-locked to the
    ALLOWED NUMBERS block), salvage parser, reference fallback only on terminal failure. Heads: design system ∥
    composition blueprints (head cap 28k; the head prompt now states the ownership rule + the bookend-hero
    text-bearing floor its validator enforces). Cast: GLM-5.2-FAST elements with PRE-RENDER hero-density and
    img-src gates (asset ids substituted from the manifest), provider-aware hero cap 11k, stop=length handled by
    one generic cap-raise retry, emission cache invalidated by castBuild.elementOutcomes the moment a placeholder
    ships. Gate loop: the v6/v7 blocking set + the NO-PROGRESS BREAKER (one escalation, then accept-and-flag).
    Sequence vision runs once, advisory, off the critical path at 120s/6k with the reasoning_content fallback.
    v7 + reference rows are the acceptance7 artifacts, copied not re-rendered. Budget: ≤${TOTAL_LLM_CEILING} TOTAL
    LLM calls (text + vision); retries ≤${MAX_RETRY_ROUNDS} rounds.
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
    console.log("\nV7 → V8 COMPARISON:");
    for (const row of (report.phaseComparison as { phase: string; v7s: number; v8s: number; deltaS: number }[]) ?? []) {
      console.log(`  ${row.phase.padEnd(26)} v7 ${String(row.v7s).padStart(7)}s → v8 ${String(row.v8s).padStart(7)}s  (Δ ${row.deltaS}s)`);
    }
  } catch (err) {
    report.terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nTERMINAL: ${report.terminalError}`);
    await writeOut().catch(() => {});
    process.exitCode = 1;
  }
};

await main();
