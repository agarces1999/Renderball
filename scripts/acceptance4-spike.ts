/**
 * ACCEPTANCE V4 — THE CASTING DECISION. Same Duolingo blueprints as v2, cast
 * executed by two NEW candidate models on Cerebras. The question: does
 * GLM-family craft (drawing quality, typography confidence, color discipline)
 * survive at Cerebras speed?
 *
 * CONTROLLED EXPERIMENT — REUSE, don't regenerate:
 *   - SCRIPT: the same Duolingo reference script.json v2 used (script gen
 *     skipped; hybrid-head decision from v1).
 *   - BLUEPRINTS: .data/acceptance2/composition.json loaded VERBATIM and
 *     attached to scenes by index — exactly the compositions the v2 gpt-oss
 *     run consumed. The casting model is the ONLY variable.
 *   - DESIGN SYSTEM: .data/acceptance2/design-system-emission.tsx re-parsed
 *     through the same parseDsEmission → themeFromDs path v2 used. Zero head
 *     calls this run — v3 spends Cerebras tokens on ELEMENT CASTING only.
 *
 * TWO CAST ROWS (sequential, one model at a time):
 *   Row A: RB_CAST_MODEL=zai-glm-4.7 — every call's reasoning_effort is
 *          rewritten to "none" (GLM-4.7 on Cerebras supports the off switch
 *          but NOT the graded low/medium levels — those are gpt-oss features).
 *          If the API 400s on "none", that call retries ONCE with effort
 *          omitted entirely and the fallback is noted in the report.
 *   Row B: RB_CAST_MODEL=gemma-4-31b — effort OMITTED entirely (reasoning is
 *          off by default on gemma per Cerebras docs).
 *   Per row: castBuild on the composed scenes → the FULL v2 gate loop
 *   (density BLOCKING, structural, render-truth with production
 *   BLOCKING_KINDS, per-scene vision, scoped retries ≤2 rounds; sequence
 *   vision ONCE post-final) → final measure shots copied to
 *   .data/acceptance4/<model>/scene{0..4}.png.
 *
 * GALLERY (.data/acceptance4/index.html): FOUR rows — zai-glm-4.7,
 * gemma-4-31b, gpt-oss (v2 images + numbers reused from ../acceptance2/),
 * GLM-5.2 reference (reused from ../acceptance/reference/) — same script on
 * all four, same blueprints on A/B/gpt-oss.
 *
 * BUDGET: ≤70 REAL Cerebras calls across BOTH rows; a row that hits 35 is
 * aborted honestly (remaining elements degrade to placeholders, the loop
 * stops, the report says so). Same partial-report honesty as v2: a row's
 * terminal failure ships that row's partial report and the other row still
 * runs.
 *
 *   set -a && source .env.local && set +a && node scripts/acceptance4-spike.mjs
 *
 * Footprint: this file + scripts/acceptance4-spike.mjs + .data/acceptance4/ +
 * src/generated/CAST_SPIKE_A4_*. Reads everything, modifies nothing else.
 */
import { promises as fs } from "fs";
import path from "path";
import { castBuild, type CastBuildResult } from "../lib/agents/cast-build";
import { type CastEffort, castCall, castConfigured, CastProviderError, type CastResult } from "../lib/llm/cast-provider";
import type { Theme } from "../lib/edit/piece-model";
import type { Script, Scene } from "../src/schema";
import { stripCodeFence } from "../lib/agents/code-extraction";
import { injectLogoSrc } from "../lib/agents/logo-inject";
import { finalizeUndefinedRefs, assessInvalidLucideImports } from "../lib/agents/finalize-refs";
import type { Manifest } from "../lib/agents/lego-store";
import { measureScenes, type SceneMeasurement } from "../lib/render/measure-scene";
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
  DEPTH_FLOOR,
  MIN_GRADIENT_SIGNATURES,
  MAX_SCENES_PER_SIGNATURE,
  IMG_SRC_WHITELIST,
  type DensityFinding,
  type HtmlNode,
} from "../lib/render/density-gates";
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
import type { AgentBrandExtract } from "../lib/agents/script-generator";
import {
  normalizeScriptContent,
  backfillSceneRegisters,
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

// ── constants ────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const BRAND = "Duolingo";
const REF_BUILD = "01KWTMK9WXRZNF7X553R9AN63M"; // the Duolingo GLM reference
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "acceptance4");
const A2_DIR = path.join(ROOT, ".data", "acceptance2"); // v2 blueprints + DS + gpt-oss row (reused read-only)
const V1_DIR = path.join(ROOT, ".data", "acceptance"); // v1 outputs — the GLM-5.2 reference row lives here
const SCENES = [0, 1, 2, 3, 4];
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

const GLOBAL_CALL_CEILING = 70; // REAL Cerebras calls across BOTH rows
const ROW_CALL_CEILING = 35; // a row that hits this is aborted honestly
const MAX_RETRY_ROUNDS = 2;

/** The two candidates. Effort policy per Cerebras docs: GLM-4.7 supports
 *  reasoning_effort "none" (the off switch) but NOT graded low/medium (gpt-oss
 *  features); gemma has no reasoning dial at all (off by default) → omit. */
interface RowSpec {
  model: string;
  /** Output subdir name (.data/acceptance4/<dir>/sceneN.png). */
  dir: string;
  genDir: string;
  /** "passthrough": cast-build's native model-aware routing (5ab5a7a) sets
   *  call.model + call.effort per element — the transport forwards VERBATIM.
   *  Cost is accumulated per call from the model actually sent. */
  effortPolicy: "none" | "omit" | "passthrough";
  usdPerMIn: number;
  usdPerMOut: number;
}
/** V4: ONE mixed row — GLM-4.7 hands on heroes/connectors, gemma on leaves.
 *  Routing is native (RB_CAST_MODEL_HERO / RB_CAST_MODEL_LEAVES). */
const ROWS: RowSpec[] = [
  {
    model: "mixed: zai-glm-4.7 heroes + gemma-4-31b leaves",
    dir: "mixed",
    genDir: path.join(ROOT, "src", "generated", "CAST_SPIKE_A4_MIXED"),
    effortPolicy: "passthrough",
    usdPerMIn: 0, // unused for passthrough — per-call pricing via MODEL_PRICES
    usdPerMOut: 0,
  },
];
/** Per-model pricing for passthrough cost accounting ($/M in, $/M out). */
const MODEL_PRICES: Record<string, [number, number]> = {
  "zai-glm-4.7": [2.25, 2.75],
  "gemma-4-31b": [0.99, 1.49],
  "gpt-oss-120b": [0.35, 0.75],
};

// The production blocking set — verbatim from run-preview-build.ts (as v2).
const BLOCKING_KINDS: RenderTruthKind[] = [
  "overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness", "stranded-hero",
];
// The pipeline's vision action threshold — SEVERE_RX verbatim (as v2).
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

// ── budgeted, effort-policied cast transport (per-row state) ─────────────────

class BudgetExceeded extends Error {}
interface CallLogRow {
  label: string;
  secs: number;
  in: number;
  out: number;
  stop: string | null;
  cached: boolean;
  /** What was actually SENT: "none" | "omitted" (the row's effort policy). */
  effortSent: string;
}
interface EffortFallbackNote { label: string; error: string }

let globalRealCalls = 0; // across both rows — the 70-call ceiling

/** Everything one row mutates while it runs. */
interface RowCtx {
  spec: RowSpec;
  realCalls: number;
  cerebrasIn: number;
  cerebrasOut: number;
  /** Passthrough rows: cost accumulated per call from the model actually sent. */
  costUsd: number;
  perModel: Record<string, { calls: number; in: number; out: number }>;
  budgetExhausted: boolean;
  callLog: CallLogRow[];
  effortFallbacks: EffortFallbackNote[];
  pieceCache: Map<string, string>; // pieceId → last raw emission (stripped)
  pieceTargets: Map<string, string[]>; // pieceId → gate feedback lines
  castRoundLabel: string;
  zaiUsage: Usage;
  zaiCalls: number;
}
const newRowCtx = (spec: RowSpec): RowCtx => ({
  spec,
  realCalls: 0,
  cerebrasIn: 0,
  cerebrasOut: 0,
    costUsd: 0,
    perModel: {},
  budgetExhausted: false,
  callLog: [],
  effortFallbacks: [],
  pieceCache: new Map(),
  pieceTargets: new Map(),
  castRoundLabel: "cast-r0",
  zaiUsage: { ...EMPTY_USAGE },
  zaiCalls: 0,
});

/** Is this the "our request is wrong" class (4xx except 429)? castCall throws
 *  these immediately without burning its internal retries. */
const isHardClientError = (e: unknown): e is CastProviderError =>
  e instanceof CastProviderError && e.status !== null && e.status >= 400 && e.status < 500 && e.status !== 429;

const budgetedCast = async (
  ctx: RowCtx,
  label: string,
  args: { system: string; user: string; maxTokens: number; model?: string; effort?: CastEffort },
): Promise<CastResult> => {
  const ensureBudget = (at: string): void => {
    if (ctx.realCalls >= ROW_CALL_CEILING) {
      ctx.budgetExhausted = true;
      throw new BudgetExceeded(`row ceiling (${ROW_CALL_CEILING}) reached at "${at}" — row aborted honestly`);
    }
    if (globalRealCalls >= GLOBAL_CALL_CEILING) {
      ctx.budgetExhausted = true;
      throw new BudgetExceeded(`GLOBAL ceiling (${GLOBAL_CALL_CEILING}) reached at "${at}" — runaway guard`);
    }
  };
  const fire = async (effortSent: string, fireLabel: string): Promise<CastResult> => {
    ensureBudget(fireLabel);
    ctx.realCalls += 1;
    globalRealCalls += 1;
    const passthrough = ctx.spec.effortPolicy === "passthrough";
    const modelSent = passthrough ? (args.model ?? process.env.RB_CAST_MODEL ?? "gpt-oss-120b") : ctx.spec.model;
    const r = await castCall({
      system: args.system,
      user: args.user,
      maxTokens: args.maxTokens,
      // Passthrough: cast-build's native routing decided model + effort — forward verbatim.
      ...(passthrough ? { ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}) }
        : effortSent === "none" ? { effort: "none" as const } : {}),
    });
    ctx.cerebrasIn += r.inputTokens;
    ctx.cerebrasOut += r.outputTokens;
    const [pin, pout] = MODEL_PRICES[modelSent] ?? [0, 0];
    ctx.costUsd += (r.inputTokens * pin + r.outputTokens * pout) / 1e6;
    const pm = (ctx.perModel[modelSent] ??= { calls: 0, in: 0, out: 0 });
    pm.calls += 1; pm.in += r.inputTokens; pm.out += r.outputTokens;
    ctx.callLog.push({ label: `${fireLabel} [${modelSent}]`, secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, cached: false, effortSent });
    return r;
  };

  if (ctx.spec.effortPolicy === "passthrough") return fire(args.effort ?? "omitted", label);
  if (ctx.spec.effortPolicy === "omit") return fire("omitted", label);
  // effortPolicy "none": send the off switch; if the API 400s on it, retry
  // that call ONCE with effort omitted entirely and note the fallback.
  try {
    return await fire("none", label);
  } catch (e) {
    if (!isHardClientError(e)) throw e;
    const note = { label, error: e.message.slice(0, 300) };
    ctx.effortFallbacks.push(note);
    console.warn(`  [effort-fallback] ${label}: 4xx on reasoning_effort "none" (${note.error.split("\n")[0]}) — retrying ONCE with effort omitted`);
    return fire("omitted", `${label}:effort-omitted`);
  }
};

// ── caching + feedback caller for castBuild (v2's retry machinery) ──────────

const makeCachingCaller = (ctx: RowCtx): typeof castCall => async (call) => {
  const pieceId = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
  const feedback = ctx.pieceTargets.get(pieceId);
  const cached = ctx.pieceCache.get(pieceId);
  if (!feedback && cached !== undefined) {
    ctx.callLog.push({ label: `${ctx.castRoundLabel}:${pieceId}`, secs: 0, in: 0, out: 0, stop: "cached-replay", cached: true, effortSent: "n/a" });
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
    const res = await budgetedCast(ctx, `${ctx.castRoundLabel}:${pieceId}${feedback ? ":regen" : ""}`, {
      system: call.system,
      user,
      maxTokens: call.maxTokens,
      // cast-build's native routing decided these — forward for passthrough rows.
      model: call.model,
      effort: call.effort,
    });
    if (res.text && res.text.trim().length >= 8) ctx.pieceCache.set(pieceId, stripCodeFence(res.text));
    return res;
  } catch (e) {
    // A targeted regen whose call failed (budget/transport) falls back to the
    // previous body instead of downgrading a shipped piece to a placeholder.
    if (feedback && cached !== undefined) {
      ctx.callLog.push({ label: `${ctx.castRoundLabel}:${pieceId}:regen-failed-kept-previous`, secs: 0, in: 0, out: 0, stop: "regen-failed", cached: true, effortSent: "n/a" });
      console.warn(`  [retry] ${pieceId}: regen call failed (${e instanceof Error ? e.message.split("\n")[0] : e}) — previous body kept`);
      return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "regen-failed-replayed-previous" };
    }
    throw e;
  }
};

// ── small utilities (v2's, verbatim) ─────────────────────────────────────────

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

// ── design-system REUSE: parse v2's emission → the same Theme derivation ─────

const DS_DECLS = ["PALETTE", "SHARED_KEYFRAMES", "THROUGHLINE_TABS", "ThroughlineMotif"] as const;

interface DsParse {
  ok: boolean;
  error?: string;
  decls?: Record<(typeof DS_DECLS)[number], string>;
}

const parseDsEmission = (raw: string): DsParse => {
  const text = stripCodeFence(raw.trim());
  const decls = {} as Record<(typeof DS_DECLS)[number], string>;
  for (const name of DS_DECLS) {
    const loc = findConstDecl(text, name);
    if (!loc) return { ok: false, error: `missing top-level declaration \`const ${name}\`` };
    decls[name] = text.slice(loc.start, loc.end).replace(/^export /, "");
  }
  for (const key of ["canvas", "ink", "accent", "muted", "softNeutral", "cardFill", "white"]) {
    if (!new RegExp(`\\b${key}\\s*:`).test(decls.PALETTE)) {
      return { ok: false, error: `PALETTE is missing the required key "${key}"` };
    }
  }
  const kf = extractTemplateConst(decls.SHARED_KEYFRAMES, "SHARED_KEYFRAMES");
  if (kf === null) return { ok: false, error: `SHARED_KEYFRAMES must be a template-literal CSS string` };
  return { ok: true, decls };
};

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
    `palette: v2's design-system-emission.tsx re-parsed VERBATIM (keys ${Object.keys(byOriginalKey).map((k) => `${k}→${camelToConst(k)}`).join(", ")}) — zero head calls this run.`,
  );
  const keyframes = extractTemplateConst(decls.SHARED_KEYFRAMES, "SHARED_KEYFRAMES") ?? "";
  notes.push("keyframes: v2's SHARED_KEYFRAMES carried verbatim.");
  const fonts = fontsFromReference(refPreamble);
  notes.push("fonts: FONT_DISPLAY/FONT_BODY/FONT_MONO + BRAND_FONTS_CSS carried VERBATIM from the reference preamble (locked brand identity — same as v2).");
  const grammar = grammarDefaults();
  notes.push("grammar: same derivation as v2 (hairline=SOFT_NEUTRAL, panelBg=CARD_FILL, radiusScale=[6,12,20], 1px strokes, neutral shadow, dataFont=mono).");
  for (const need of ["CANVAS", "INK", "ACCENT", grammar.hairline, grammar.panelBg]) {
    if (!(need in palette)) throw new Error(`themeFromDs: expected palette const ${need} missing`);
  }
  const dsHexes = Object.values(byOriginalKey).filter((v) => /^#[0-9a-fA-F]{3,8}$/.test(v));
  const paletteHexes = [...new Set([...dsHexes, ...brandPalette])];
  notes.push(`hue-lock vocabulary: union of DS PALETTE hexes + crawled brand palette (${paletteHexes.length} hexes) — same as v2.`);
  const logoSrc = extractStringConst(refPreamble, "LOGO_SRC") ?? undefined;
  return {
    theme: { palette, fonts, keyframes, grammar },
    paletteHexes,
    signatureAccent: byOriginalKey["accent"],
    logoSrc,
    mappingNotes: notes,
  };
};

// ── density profile (per scene, per clause — the comparison table's numbers) ─

interface SceneDensityProfile {
  scene: number;
  ssrError?: string;
  bestDiegetic: { id: string; elements: number; textNodes: number } | null;
  diegeticPass: boolean;
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
      scenes.push({ scene: r.scene, ssrError: r.error, bestDiegetic: null, diegeticPass: false, depth: 0, depthPass: false, gradientSignatures: [], badImgSrcs: [] });
      continue;
    }
    const roots: (HtmlNode | string)[] = parseHtmlStructure(r.html);
    const diegetics = pieceStats(roots).filter((p) => p.kind === "diegetic");
    const best = diegetics.slice().sort((a, b) => b.elements + b.textNodes * 2 - (a.elements + a.textNodes * 2))[0] ?? null;
    const sigs = [...gradientSignatures(roots)];
    for (const sig of sigs) bySig.set(sig, [...(bySig.get(sig) ?? []), r.scene]);
    scenes.push({
      scene: r.scene,
      bestDiegetic: best ? { id: best.id, elements: best.elements, textNodes: best.textNodes } : null,
      diegeticPass: !!diegetics.find((p) => p.elements >= DIEGETIC_MIN_ELEMENTS && p.textNodes >= DIEGETIC_MIN_TEXT_NODES),
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

// ── structural gates (the standalone-runnable production set, v2's) ──────────

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

// ── per-scene vision (v2's rubric path) ──────────────────────────────────────

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
  ctx: RowCtx,
  measurements: SceneMeasurement[],
  script: LooseScript,
  brandTruth: BrandTruthLite,
): Promise<SceneVisionVerdict[]> => {
  const judged = await Promise.allSettled(
    measurements
      .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
      .map(async (m) => {
        const b64 = (await fs.readFile(m.screenshotPath)).toString("base64");
        const rubric = buildRubric(brandTruth, script.scenes[m.scene]?.visual_concept);
        const { text, usage } = await callZaiVision(b64, rubric);
        ctx.zaiUsage = addUsage(ctx.zaiUsage, usage);
        ctx.zaiCalls += 1;
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
  const withShots = measurements.filter((m) => m.screenshotPath);
  for (const [k, r] of judged.entries()) {
    if (r.status === "fulfilled") out.push(r.value);
    else out.push({ scene: withShots[k]?.scene ?? -1, ok: true, issues: [], actionable: [], severe: [], error: String(r.reason).slice(0, 200) });
  }
  return out.sort((a, b) => a.scene - b.scene);
};

// ── sequence vision — ONCE, after the final per-scene round (v2 semantics) ───

const runSequenceRound = async (
  ctx: RowCtx,
  measurements: SceneMeasurement[],
  brandTruth: BrandTruthLite,
): Promise<VisionFinding[]> => {
  const sequenceJudge: SequenceJudge = async (imagesB64, prompt) => {
    const { text, usage } = await callZaiVision(imagesB64, prompt, { maxTokens: 2500 });
    ctx.zaiUsage = addUsage(ctx.zaiUsage, usage);
    ctx.zaiCalls += 1;
    return text;
  };
  const ordered = measurements
    .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
    .sort((a, b) => a.scene - b.scene);
  const imagesB64 = await Promise.all(ordered.map(async (m) => (await fs.readFile(m.screenshotPath)).toString("base64")));
  return judgeSequence(imagesB64, brandTruth, sequenceJudge);
};

// ── finding → piece routing (v2's, with pieceCache passed explicitly) ────────

const PIECE_ID_RX = /\bs\d+\.(?:hero|copy|atmosphere|connector|throughline)\b/g;
const VISION_COPY_RX = /\b(head(?:line)?|lede|bullet|caption|copy|paragraph|typograph|font|wall of type|text\b)/i;
const VISION_ATMOS_RX = /\b(background|canvas|atmosphere|glow|gradient|vignette|grain|wash)\b/i;

const computeTargets = (args: {
  validPieceIds: Set<string>;
  density: DensityFinding[];
  profile: DensityProfile;
  rtBlocking: RenderTruthFinding[];
  vision: SceneVisionVerdict[];
  pieceCache: Map<string, string>;
}): Map<string, string[]> => {
  const { validPieceIds, density, profile, rtBlocking, vision, pieceCache } = args;
  const targets = new Map<string, string[]>();
  const add = (pieceId: string, sceneFallback: number, feedback: string): void => {
    let id = pieceId;
    if (!validPieceIds.has(id)) id = `s${sceneFallback}.hero`;
    if (!validPieceIds.has(id)) return; // no cast slot to route to — logged upstream
    targets.set(id, [...(targets.get(id) ?? []), feedback]);
  };

  // A whole-scene render failure — render-truth "measure-error" or density's
  // SSR-failure twin — routes to a FULL RE-CAST of that scene's non-chrome
  // pieces (v2 fix a).
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

// ── per-row run ──────────────────────────────────────────────────────────────

interface GateRoundReport {
  round: number;
  realCalls: number;
  castTelemetry: CastBuildResult["telemetry"] | null;
  density: DensityFinding[];
  profile: DensityProfile;
  structural: StructuralFinding[];
  renderTruthAll: RenderTruthFinding[];
  renderTruthBlocking: RenderTruthFinding[];
  vision: SceneVisionVerdict[];
  targets: { pieceId: string; feedback: string[] }[];
}

interface RowCell { scene: number; png?: string; label: string; note: string }

interface RowReport {
  model: string;
  dir: string;
  effortPolicy: string;
  genDir: string;
  terminalError: string | null;
  budgetExhausted: boolean;
  realCalls: number;
  effortFallbacks: EffortFallbackNote[];
  castRounds: CastBuildResult["telemetry"][];
  gateRounds: GateRoundReport[];
  sequenceFinal: VisionFinding[];
  densityProfile: DensityProfile | null;
  callLog: CallLogRow[];
  finalize: Record<string, unknown>;
  cost: {
    cerebras: { calls: number; inputTokens: number; outputTokens: number; usdPerMIn: number; usdPerMOut: number; usd: number };
    zaiVision: { calls: number; inputTokens: number; outputTokens: number; model: string; usd: number };
    totalUsd: number;
  };
  wall: { rowSeconds: number; castWallSeconds: number; castToPreviewSeconds: number | null };
  cells: RowCell[];
}

const runRow = async (
  spec: RowSpec,
  shared: {
    script: LooseScript;
    theme: Theme;
    paletteHexes: string[];
    signatureAccent: string | undefined;
    logoSrc: string | undefined;
    brandTruth: BrandTruthLite;
    canvasBackground: string;
  },
): Promise<RowReport> => {
  const ctx = newRowCtx(spec);
  const rowStartS = nowS();
  const rowOutDir = path.join(OUT_DIR, spec.dir);
  await fs.mkdir(rowOutDir, { recursive: true });

  const gateRounds: GateRoundReport[] = [];
  const roundTelemetry: CastBuildResult["telemetry"][] = [];
  const finalize: Record<string, unknown> = {};
  let sequenceFinal: VisionFinding[] = [];
  let profile: DensityProfile | null = null;
  let finalMeasurements: SceneMeasurement[] = [];
  let terminalError: string | null = null;
  let castStartS: number | null = null;
  let previewEndS: number | null = null;
  const cells: RowCell[] = [];

  // Mixed row: NATIVE per-kind routing (5ab5a7a) — hero/connector vs leaves.
  if (spec.effortPolicy === "passthrough") {
    delete process.env.RB_CAST_MODEL;
    process.env.RB_CAST_MODEL_HERO = "zai-glm-4.7";
    process.env.RB_CAST_MODEL_LEAVES = "gemma-4-31b";
  } else {
    process.env.RB_CAST_MODEL = spec.model;
  }
  console.log(`\n════════ ROW ${spec.dir} — ${spec.effortPolicy === "passthrough" ? "HERO=zai-glm-4.7 LEAVES=gemma-4-31b (native routing, effort per model)" : `RB_CAST_MODEL=${spec.model}, effort policy: ${spec.effortPolicy === "none" ? `reasoning_effort "none" (off switch)` : "effort OMITTED"}`} ════════`);

  try {
    // Canary: proves transport + key + THIS model id before castBuild spends.
    await phase(`${spec.dir}:canary`, async () => {
      const c = await budgetedCast(ctx, "canary", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, model: "zai-glm-4.7", effort: "none" });
      console.log(`  canary ok — ${c.seconds.toFixed(1)}s, ${c.outputTokens} tok out, stop=${c.stopReason}`);
    });

    const castInput = {
      script: shared.script as unknown as Script,
      theme: shared.theme,
      palette: shared.paletteHexes,
      signatureAccent: shared.signatureAccent,
      aspect: "16:9" as const,
    };
    const cachingCaller = makeCachingCaller(ctx);
    let castResult: CastBuildResult | null = null;
    let finalCode = "";
    let round = 0;
    let genDirReady = false;
    castStartS = nowS();

    while (true) {
      ctx.castRoundLabel = `cast-r${round}`;
      const callsBefore = ctx.realCalls;
      try {
        castResult = await phase(`${spec.dir}:cast-r${round}`, () => castBuild(castInput, { caller: cachingCaller }));
      } catch (e) {
        console.error(`  castBuild THREW on round ${round}: ${e instanceof Error ? e.message : e}`);
        finalize[`castRound${round}Error`] = e instanceof Error ? e.message : String(e);
        ctx.pieceTargets = new Map();
        break;
      }
      ctx.pieceTargets = new Map(); // consumed — gates decide the next round's targets
      roundTelemetry.push(castResult.telemetry);
      console.log(
        `  cast r${round}: ${castResult.telemetry.elements} elements · ${castResult.telemetry.repairs} repairs · ${castResult.telemetry.failures} placeholders · ` +
          `${castResult.telemetry.tokensOut} tok out · ${castResult.telemetry.normalizedColors} hue-locked · ${castResult.telemetry.wallSeconds}s · ${ctx.realCalls - callsBefore} real calls`,
      );

      finalCode = await phase(`${spec.dir}:finalize-r${round}`, async () => {
        let code = injectLogoSrc(castResult!.code, shared.logoSrc);
        const fin = await finalizeUndefinedRefs(code);
        finalize[`r${round}`] = { logoInjected: Boolean(shared.logoSrc), added: fin.added, stubbed: fin.stubbed, neutralized: fin.neutralized };
        return fin.code;
      });

      if (!genDirReady) {
        await fs.rm(spec.genDir, { recursive: true, force: true });
        await fs.mkdir(spec.genDir, { recursive: true });
        for (const shim of SHIMS) await fs.copyFile(path.join(REF_DIR, shim), path.join(spec.genDir, shim)).catch(() => {});
        genDirReady = true;
      }
      await fs.writeFile(path.join(spec.genDir, "Composition.tsx"), finalCode, "utf8");
      await fs.writeFile(path.join(spec.genDir, "script.json"), JSON.stringify(shared.script, null, 2), "utf8");

      // (a) density gates — blocking.
      const density = await phase(`${spec.dir}:density-r${round}`, async () => assessDensity(finalCode, shared.script));
      profile = buildDensityProfile(finalCode, shared.script);
      console.log(`  density: ${density.length} blocking finding(s) · video distinct sigs ${profile.distinctSignatures} · depths [${profile.scenes.map((s) => s.depth).join(", ")}]`);

      // (b) structural + render-truth.
      const structural = runStructuralGates(finalCode, shared.script);
      const measurements = await phase(`${spec.dir}:measure-r${round}`, () => measureScenes(spec.genDir, shared.script, spec.genDir));
      finalMeasurements = measurements;
      const rt = await phase(`${spec.dir}:render-truth-r${round}`, () =>
        findRenderTruthFailures(measurements, {
          brandBackground: shared.canvasBackground,
          blockingKinds: BLOCKING_KINDS,
          registers: shared.script.scenes.map((s) => s.register),
        }),
      );

      // (c) per-scene vision. (Sequence vision runs ONCE, after the final round.)
      const vision = await phase(`${spec.dir}:vision-r${round}`, () => runVisionRound(ctx, measurements, shared.script, shared.brandTruth));

      const validPieceIds = new Set(castResult.scenes.flatMap((s) => s.pieces.filter((p) => p.kind !== "chrome").map((p) => p.id)));
      const targets = computeTargets({ validPieceIds, density, profile, rtBlocking: rt.blocking, vision, pieceCache: ctx.pieceCache });

      gateRounds.push({
        round,
        realCalls: ctx.realCalls - callsBefore,
        castTelemetry: castResult.telemetry,
        density,
        profile,
        structural,
        renderTruthAll: rt.findings,
        renderTruthBlocking: rt.blocking,
        vision,
        targets: [...targets.entries()].map(([pieceId, feedback]) => ({ pieceId, feedback })),
      });
      previewEndS = nowS();

      console.log(
        `  round ${round}: density ${density.length} · structural ${structural.length} · render-truth ${rt.findings.length} (${rt.blocking.length} blocking) · ` +
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
      if (ctx.budgetExhausted) {
        console.warn(`  Cerebras call ceiling reached — shipping with residual findings (honest)`);
        break;
      }
      ctx.pieceTargets = targets;
      round += 1;
    }

    if (finalCode) await fs.writeFile(path.join(rowOutDir, `Composition.${spec.dir}.tsx`), finalCode, "utf8");

    // Sequence vision — ONCE, after the final per-scene round.
    if (finalMeasurements.some((m) => m.screenshotPath)) {
      sequenceFinal = await phase(`${spec.dir}:sequence-vision-final`, () => runSequenceRound(ctx, finalMeasurements, shared.brandTruth));
      for (const f of sequenceFinal) console.log(`  sequence: ${f.issue.slice(0, 160)}`);
    } else {
      console.warn("  no screenshots — sequence vision skipped");
    }

    // Final renders → .data/acceptance4/<model>/scene{0..4}.png.
    const finalRound = gateRounds[gateRounds.length - 1];
    for (const i of SCENES) {
      const m = finalMeasurements.find((mm) => mm.scene === i);
      const v = finalRound?.vision.find((vv) => vv.scene === i);
      const dens = finalRound?.density.filter((f) => f.scene === i) ?? [];
      const rtb = finalRound?.renderTruthBlocking.filter((f) => f.scene === i) ?? [];
      const p = profile?.scenes.find((s) => s.scene === i);
      const note = [
        p ? (p.ssrError ? `density: SSR ERROR` : `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · depth ${p.depth}`) : "density: n/a",
        v ? (v.actionable.length === 0 ? "vision: CLEAN" : `vision: ${v.actionable.length} issue(s)${v.severe.length ? ` (${v.severe.length} severe)` : ""}`) : "vision: n/a",
        dens.length ? `density findings: ${dens.map((f) => f.kind).join(", ")}` : "density findings: clean",
        rtb.length ? `render-truth blocking: ${rtb.map((f) => f.kind).join(", ")}` : "render-truth: clean",
      ].join("\n");
      const shot = path.join(spec.genDir, `measure-scene-${i}.png`);
      const exists = await fs.stat(shot).then(() => true).catch(() => false);
      if (exists && !m?.error) {
        await fs.copyFile(shot, path.join(rowOutDir, `scene${i}.png`));
        cells.push({ scene: i, png: `${spec.dir}/scene${i}.png`, label: shared.script.scenes[i]?.label ?? `scene ${i}`, note });
      } else {
        cells.push({ scene: i, label: shared.script.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
      }
    }
  } catch (err) {
    terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nROW ${spec.dir} TERMINAL: ${terminalError}`);
    // Partial-report honesty: whatever cells were not populated get error stubs.
    for (const i of SCENES) {
      if (!cells.find((c) => c.scene === i)) {
        cells.push({ scene: i, label: shared.script.scenes[i]?.label ?? `scene ${i}`, note: `row terminal: ${terminalError.slice(0, 120)}` });
      }
    }
  }

  const cerebrasUsd = ctx.spec.effortPolicy === "passthrough" ? ctx.costUsd : (ctx.cerebrasIn * spec.usdPerMIn + ctx.cerebrasOut * spec.usdPerMOut) / 1e6;
  const zaiUsd = costUsd(VISION_MODEL, ctx.zaiUsage);
  return {
    model: spec.model,
    dir: spec.dir,
    effortPolicy: spec.effortPolicy === "none" ? `reasoning_effort "none" (400 → retry once with effort omitted)` : "effort omitted entirely",
    genDir: spec.genDir,
    terminalError,
    budgetExhausted: ctx.budgetExhausted,
    realCalls: ctx.realCalls,
    effortFallbacks: ctx.effortFallbacks,
    castRounds: roundTelemetry,
    gateRounds,
    sequenceFinal,
    densityProfile: profile,
    callLog: ctx.callLog,
    finalize,
    cost: {
      cerebras: { calls: ctx.realCalls, inputTokens: ctx.cerebrasIn, outputTokens: ctx.cerebrasOut, usdPerMIn: spec.usdPerMIn, usdPerMOut: spec.usdPerMOut, usd: cerebrasUsd, perModel: ctx.perModel } as never,
      zaiVision: { calls: ctx.zaiCalls, inputTokens: ctx.zaiUsage.input_tokens, outputTokens: ctx.zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
      totalUsd: cerebrasUsd + zaiUsd,
    },
    wall: {
      rowSeconds: Math.round((nowS() - rowStartS) * 10) / 10,
      castWallSeconds: Math.round(roundTelemetry.reduce((n, t) => n + t.wallSeconds, 0) * 10) / 10,
      castToPreviewSeconds: castStartS !== null && previewEndS !== null ? Math.round((previewEndS - castStartS) * 10) / 10 : null,
    },
    cells,
  };
};

// ── gallery ──────────────────────────────────────────────────────────────────

interface ReusedRow {
  title: string;
  cells: RowCell[];
  profile: DensityProfile | null;
  summary: string;
}

const densityCellHtml = (p: SceneDensityProfile | undefined): string => {
  if (!p) return `<td class="bad" colspan="4">no data</td>`;
  if (p.ssrError) return `<td class="bad" colspan="4">SSR error: ${esc(p.ssrError.slice(0, 80))}</td>`;
  const dieg = p.bestDiegetic ? `${p.bestDiegetic.elements}el / ${p.bestDiegetic.textNodes}txt` : "none";
  return [
    `<td class="${p.diegeticPass ? "ok" : "bad"}">${esc(dieg)}</td>`,
    `<td class="${p.depthPass ? "ok" : "bad"}">${p.depth}</td>`,
    `<td>${p.gradientSignatures.length}</td>`,
    `<td class="${p.badImgSrcs.length === 0 ? "ok" : "bad"}">${p.badImgSrcs.length}</td>`,
  ].join("");
};

const videoLevelCell = (p: DensityProfile | null): string =>
  `<td colspan="4" class="${p && p.varietyPass ? "ok" : "bad"}">${p ? `${p.distinctSignatures} distinct sigs (≥${MIN_GRADIENT_SIGNATURES}); ${p.repeated.length} repeated violation(s)` : "n/a"}</td>`;

const rowGrid = (cells: RowCell[]): string =>
  cells
    .map((s) => {
      const visual = s.png
        ? `<a href="${esc(s.png)}" target="_blank"><img src="${esc(s.png)}" alt="scene ${s.scene}"></a>`
        : `<div class="err">NO RENDER</div>`;
      return `<div class="cell"><div class="cell-title">scene ${s.scene} — ${esc(s.label)}</div>${visual}<div class="stat">${esc(s.note)}</div></div>`;
    })
    .join("\n");

const gateSummaryLine = (r: RowReport): string => {
  const fin = r.gateRounds[r.gateRounds.length - 1];
  if (!fin) return `NO GATE ROUNDS${r.terminalError ? ` — terminal: ${r.terminalError.slice(0, 120)}` : ""}`;
  const severeScenes = fin.vision.filter((v) => v.severe.length).map((v) => v.scene);
  const repairs = r.castRounds.reduce((n, t) => n + t.repairs, 0);
  const failures = r.castRounds[r.castRounds.length - 1]?.failures ?? 0;
  return [
    `${r.gateRounds.length} gate round(s)`,
    `final residuals: density ${fin.density.length} · structural ${fin.structural.length} · render-truth blocking ${fin.renderTruthBlocking.length} · vision-severe scenes [${severeScenes.join(", ") || "none"}]`,
    `repairs ${repairs} · placeholders shipped ${failures}`,
    `sequence findings ${r.sequenceFinal.length}`,
    r.budgetExhausted ? "BUDGET EXHAUSTED (row aborted honestly)" : "",
    r.effortFallbacks.length ? `effort fallbacks: ${r.effortFallbacks.length} call(s) 400'd on "none" → retried with effort omitted` : "",
    r.terminalError ? `TERMINAL: ${r.terminalError.slice(0, 140)}` : "",
  ].filter(Boolean).join(" · ");
};

const gateLogHtml = (r: RowReport): string => {
  const rounds = r.gateRounds
    .map((g) => {
      const rows: string[] = [];
      for (const f of g.density) rows.push(`<li><b>density/${esc(f.kind)} (BLOCKING)</b> scene ${f.scene}: ${esc(f.detail.slice(0, 260))}</li>`);
      for (const f of g.structural) rows.push(`<li><b>structural/${esc(f.key)}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const f of g.renderTruthAll) rows.push(`<li><b>render-truth/${esc(f.kind)}${g.renderTruthBlocking.includes(f) ? " (BLOCKING)" : " (advisory)"}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const v of g.vision) {
        if (v.error) rows.push(`<li><b>vision</b> scene ${v.scene}: judge error — ${esc(v.error)}</li>`);
        else if (v.actionable.length === 0) rows.push(`<li><b>vision</b> scene ${v.scene}: CLEAN${v.issues.length ? ` (sanctioned-chrome findings dropped: ${v.issues.length})` : ""}</li>`);
        else for (const issue of v.actionable) rows.push(`<li><b>vision${v.severe.includes(issue) ? " (SEVERE)" : ""}</b> scene ${v.scene}: ${esc(issue.slice(0, 260))}</li>`);
      }
      const targets = g.targets.map((t) => t.pieceId).join(", ") || "none";
      return `<h3>gate round ${g.round} — ${g.realCalls} real Cerebras calls this round · retry targets: [${esc(targets)}]</h3><ul>${rows.join("\n") || "<li>all clean</li>"}</ul>`;
    })
    .join("\n");
  const seq = r.sequenceFinal.length
    ? r.sequenceFinal.map((f) => `<li><b>sequence-vision (log-only, ran ONCE after the final round)</b>: ${esc(f.issue.slice(0, 320))}</li>`).join("\n")
    : "<li>sequence vision: CLEAN</li>";
  const fallbacks = r.effortFallbacks.length
    ? `<h3>effort fallbacks (400 on reasoning_effort "none" → retried with effort omitted)</h3><ul>${r.effortFallbacks.map((f) => `<li><b>${esc(f.label)}</b>: ${esc(f.error)}</li>`).join("\n")}</ul>`
    : "";
  return `${rounds}<h3>final sequence-vision pass</h3><ul>${seq}</ul>${fallbacks}`;
};

const callLogHtml = (r: RowReport): string => {
  const rows = r.callLog
    .map((c) => `<tr><td style="text-align:left">${esc(c.label)}</td><td>${c.secs.toFixed(1)}s</td><td>${c.in}</td><td>${c.out}</td><td>${esc(String(c.stop))}</td><td>${esc(c.effortSent)}</td></tr>`)
    .join("\n");
  return `<div class="scroll"><table><tr><th>call</th><th>secs</th><th>tok in</th><th>tok out</th><th>stop</th><th>effort sent</th></tr>${rows}</table></div>`;
};

const galleryHtml = (g: {
  report: Record<string, unknown>;
  rows: RowReport[];
  gptOss: ReusedRow;
  reference: ReusedRow;
  blueprintNote: string;
}): string => {
  const { report, rows, gptOss, reference, blueprintNote } = g;
  const [a, b] = rows;

  const phases = (report.phases as PhaseMark[]) ?? [];
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

  const candidateSummary = (r: RowReport): string => [
    `<h3>${esc(r.model)} — effort policy: ${esc(r.effortPolicy)}</h3>`,
    `<div class="sub">Cerebras ${r.cost.cerebras.calls} real calls · ${r.cost.cerebras.inputTokens} in / ${r.cost.cerebras.outputTokens} out tok · $${r.cost.cerebras.usd.toFixed(4)} ($${r.cost.cerebras.usdPerMIn}/$${r.cost.cerebras.usdPerMOut} per M) + z.ai vision ${r.cost.zaiVision.calls} calls $${r.cost.zaiVision.usd.toFixed(4)} = <b>$${r.cost.totalUsd.toFixed(4)}</b></div>`,
    `<div class="sub">cast wall ${r.wall.castWallSeconds}s (sum of cast rounds) · cast→preview ${r.wall.castToPreviewSeconds === null ? "—" : `${r.wall.castToPreviewSeconds}s`} · row total ${r.wall.rowSeconds}s</div>`,
    `<div class="sub">${esc(gateSummaryLine(r))}</div>`,
  ].join("\n");

  const densityTable = `
  <div class="scroll"><table>
    <tr>
      <th rowspan="2">scene</th>
      <th colspan="4">MIXED — glm-4.7 heroes + gemma leaves (this run)</th>
      <th colspan="4">(unused)</th>
      <th colspan="4">gpt-oss-120b (v2, reused)</th>
      <th colspan="4">GLM-5.2 REFERENCE (the bar)</th>
    </tr>
    <tr>
      ${[0, 1, 2, 3].map(() => `<th>diegetic el/txt (≥${DIEGETIC_MIN_ELEMENTS}/${DIEGETIC_MIN_TEXT_NODES})</th><th>depth (≥${DEPTH_FLOOR})</th><th>grad sigs</th><th>bad img</th>`).join("")}
    </tr>
    ${SCENES.map(
      (i) =>
        `<tr><td>scene ${i}</td>${densityCellHtml(a?.densityProfile?.scenes.find((s) => s.scene === i))}${densityCellHtml(b?.densityProfile?.scenes.find((s) => s.scene === i))}${densityCellHtml(gptOss.profile?.scenes.find((s) => s.scene === i))}${densityCellHtml(reference.profile?.scenes.find((s) => s.scene === i))}</tr>`,
    ).join("\n")}
    <tr>
      <td>video-level</td>
      ${videoLevelCell(a?.densityProfile ?? null)}
      ${videoLevelCell(b?.densityProfile ?? null)}
      ${videoLevelCell(gptOss.profile)}
      ${videoLevelCell(reference.profile)}
    </tr>
  </table></div>
  <div class="sub">gpt-oss numbers reused from ../acceptance2/build-report.json; reference numbers from ../acceptance/build-report.json (not re-measured)</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceptance v3 — ${esc(BRAND)}: the casting decision (zai-glm-4.7 vs gemma-4-31b vs gpt-oss vs GLM-5.2)</title>
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
  pre { background: #16171c; border: 1px solid #26272e; border-radius: 6px; padding: 12px; font-size: 11px; overflow-x: auto; color: #b9bac2; margin-top: 6px; }
  .scroll { overflow-x: auto; }
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 1100px; }
</style>
</head>
<body>
  <h1>Acceptance v3 — ${esc(BRAND)}: the casting decision</h1>
  <div class="banner"><b>CONTROLLED EXPERIMENT:</b> all four rows built from the SAME Duolingo reference script, and rows
  A / B / gpt-oss consumed the SAME blueprints (.data/acceptance2/composition.json, attached verbatim) and the SAME
  v2 design system (.data/acceptance2/design-system-emission.tsx). Across A / B / gpt-oss the casting model is the
  ONLY variable. ${esc(blueprintNote)}</div>
  <div class="sub">${esc(String(report.headline ?? ""))}</div>

  <h2>Per-row summary — cost, cast wall, gates</h2>
  ${rows.map(candidateSummary).join("\n")}
  <h3>gpt-oss-120b (v2, reused)</h3>
  <div class="sub">${esc(gptOss.summary)}</div>
  <h3>GLM-5.2 reference (the bar)</h3>
  <div class="sub">${esc(reference.summary)}</div>

  <h2>Density comparison — per scene per clause, all four rows</h2>
  ${densityTable}

  ${rows
    .map(
      (r) => `<h2>Row — ${esc(r.model)} (this run)</h2>
  <div class="row">
${rowGrid(r.cells)}
  </div>
  <details><summary>${esc(r.model)} — gate log (round by round)</summary>${gateLogHtml(r)}</details>
  <details><summary>${esc(r.model)} — per-element call log (secs / tokens / stop / effort)</summary>${callLogHtml(r)}</details>`,
    )
    .join("\n")}

  <h2>Row — gpt-oss-120b (v2, reused from ../acceptance2/)</h2>
  <div class="row">
${rowGrid(gptOss.cells)}
  </div>

  <h2>Row — GLM-5.2 reference (the production build, reused from ../acceptance/reference/)</h2>
  <div class="row">
${rowGrid(reference.cells)}
  </div>

  <h2>Phase timeline (both rows, sequential)</h2>
  <div class="timeline">${bars}</div>
  <div>${legend}</div>

  <div class="foot">
    v4 = v2's pipeline with the HEAD PHASES REUSED (script, blueprints, design system all fixed to v2's artifacts;
    zero head calls) and the CAST MODEL swapped per row. Effort policies per Cerebras docs: zai-glm-4.7 supports
    reasoning_effort "none" only (the off switch — graded low/medium are gpt-oss features; a 400 on "none" retries
    once with effort omitted and is noted); gemma-4-31b takes no effort param (reasoning off by default). Same gate
    stack as v2 (density BLOCKING, structural, render-truth production BLOCKING_KINDS, per-scene vision, ≤${MAX_RETRY_ROUNDS}
    retry rounds, sequence vision once post-final). Budget: ≤${GLOBAL_CALL_CEILING} real Cerebras calls total, ≤${ROW_CALL_CEILING}/row (a row
    that hits its ceiling aborts honestly). brandColorFidelity advisory SKIPPED — palette-driven and
    model-independent; v2 already measured it for these exact inputs.
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/acceptance4-spike.mjs");
    process.exitCode = 1;
    return;
  }
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const report: Record<string, unknown> = {
    experiment:
      "ACCEPTANCE V4: the casting decision — v2's Duolingo blueprints/DS/script REUSED VERBATIM (zero head calls); cast executed by zai-glm-4.7 (effort none) and gemma-4-31b (effort omitted) on Cerebras, sequentially; full v2 gate loop per row; 4-row gallery vs gpt-oss (v2) and the GLM-5.2 reference",
    brand: BRAND,
    ref: REF_BUILD,
    generatedAt: new Date().toISOString(),
    reuseNote:
      "CONTROLLED: script = reference script.json (as v2); blueprints = .data/acceptance2/composition.json attached by scene index VERBATIM; design system = .data/acceptance2/design-system-emission.tsx re-parsed through v2's exact themeFromDs path. The casting model is the only variable across A/B/gpt-oss.",
    advisorySkips:
      "brandColorFidelity advisory SKIPPED — it judges the brand palette (identical inputs to v2, model-independent); v2's verdict stands.",
    terminalError: null,
  };
  const rowReports: RowReport[] = [];

  const writeOut = async (): Promise<void> => {
    report.phases = marks;
    report.rows = rowReports;
    report.budget = {
      globalCeiling: GLOBAL_CALL_CEILING,
      rowCeiling: ROW_CALL_CEILING,
      totalRealCerebrasCalls: globalRealCalls,
    };
    report.cost = {
      perRow: rowReports.map((r) => ({ model: r.model, usd: r.cost.totalUsd })),
      totalUsd: rowReports.reduce((n, r) => n + r.cost.totalUsd, 0),
    };
    report.wall = { totalRunSeconds: nowS() };
    await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  };

  try {
    // ── shared inputs: reference manifest + script, v2 blueprints + DS ───────
    const manifest: Manifest = JSON.parse(await fs.readFile(path.join(REF_DIR, "lego", "manifest.json"), "utf8"));
    const refScript: LooseScript = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));

    // v2 + v1 artifacts for the reused gallery rows (read-only).
    const a2Report = JSON.parse(await fs.readFile(path.join(A2_DIR, "build-report.json"), "utf8")) as Record<string, unknown>;
    let v1Report: Record<string, unknown> | null = null;
    try {
      v1Report = JSON.parse(await fs.readFile(path.join(V1_DIR, "build-report.json"), "utf8"));
    } catch {
      console.warn("  v1 build-report.json missing — the reference gallery row will carry images only");
    }
    const refProfile = ((v1Report?.densityProfiles ?? null) as { reference?: DensityProfile } | null)?.reference ?? null;

    // ── brief from the store (brand_extract for canvas/signature/vision) ────
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
      signatureWithLogoFallback(be.palette ?? [], be.theme_color, be.logo_color) ?? be.theme_color ?? (be.palette ?? [])[0] ?? "#57cc02";
    report.brief = { projectId: stored.id, url: stored.brand_kit_url, brandExtractCached: true, canvasPlan, signature };

    // ── script: the same reference script v2 used, loaded the same way ──────
    const script = await phase("script-load", async () => {
      const s = backfillSceneRegisters(normalizeScriptContent(refScript)) as LooseScript;
      console.log(`  reference script loaded — ${s.scenes.length} scenes: ${s.scenes.map((x) => x.label).join(" · ")}`);
      return s;
    });
    report.script = {
      source: "reference script.json (same as v2 — script generation skipped by design)",
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
    };

    // ── blueprints: v2's composition.json, attached VERBATIM by scene index ─
    const blueprintResiduals = await phase("blueprints-load", async () => {
      const comps = JSON.parse(await fs.readFile(path.join(A2_DIR, "composition.json"), "utf8")) as {
        scene: number;
        composition: unknown;
      }[];
      let attached = 0;
      for (const entry of comps) {
        const target = script.scenes[entry.scene];
        if (target && entry.composition) {
          target.composition = entry.composition;
          attached += 1;
        }
      }
      if (attached === 0) throw new Error("no blueprints attached — .data/acceptance2/composition.json carried no compositions");
      // Honesty check only: re-validate what v2 shipped (expected clean —
      // v2's head validated on attempt 1). Residuals are recorded, not fixed:
      // regenerating would break the controlled experiment.
      const residual = checkSceneComposition(script.scenes as unknown as Scene[]);
      console.log(`  ${attached}/${script.scenes.length} scenes carry v2 blueprints VERBATIM · checkSceneComposition residuals: ${residual.length}`);
      return residual;
    });
    report.blueprints = {
      source: ".data/acceptance2/composition.json (v2's gpt-oss-authored, validated blueprint — attached verbatim)",
      residualErrors: blueprintResiduals,
    };

    // ── design system: v2's emission, re-parsed through v2's exact path ─────
    const ds = await phase("design-system-load", async () => {
      const raw = await fs.readFile(path.join(A2_DIR, "design-system-emission.tsx"), "utf8");
      const parsed = parseDsEmission(raw);
      if (!parsed.ok) {
        // The controlled experiment REQUIRES v2's theme — regenerating would
        // add a second variable. Refusing is the honest failure.
        throw new Error(`v2 design-system emission failed to re-parse (${parsed.error}) — cannot hold the DS constant; aborting`);
      }
      const derived = themeFromDs(parsed.decls!, manifest.preamble, be.palette ?? []);
      console.log(`  v2 DS re-derived — palette ${Object.keys(derived.theme.palette).join("/")}`);
      return derived;
    });
    report.designSystem = { source: ".data/acceptance2/design-system-emission.tsx (v2's, reused verbatim)", themeMappingNotes: ds.mappingNotes, logoSrc: ds.logoSrc };

    const brandTruth: BrandTruthLite = {
      name: be.title ?? BRAND,
      backgroundColor: canvasPlan.background,
      accent: signature,
      fonts: [be.font_roles?.display, be.font_roles?.body].filter((f): f is string => !!f),
    };

    const shared = {
      script,
      theme: ds.theme,
      paletteHexes: ds.paletteHexes,
      signatureAccent: ds.signatureAccent,
      logoSrc: ds.logoSrc,
      brandTruth,
      canvasBackground: canvasPlan.background,
    };

    // ── the two cast rows, sequential — one model at a time ─────────────────
    for (const spec of ROWS) {
      const rowReport = await runRow(spec, shared);
      rowReports.push(rowReport);
      await writeOut(); // partial-report honesty: the report exists after EVERY row
      console.log(
        `\nrow ${spec.dir}: ${rowReport.realCalls} real calls · $${rowReport.cost.totalUsd.toFixed(4)} · cast wall ${rowReport.wall.castWallSeconds}s · ` +
          `${rowReport.gateRounds.length} gate round(s)${rowReport.terminalError ? ` · TERMINAL: ${rowReport.terminalError}` : ""}`,
      );
    }

    // ── gallery: FOUR rows ───────────────────────────────────────────────────
    await phase("gallery", async () => {
      // gpt-oss row (v2) — images + density + cost/wall reused, not re-measured.
      const a2Profile = (a2Report.densityProfileV2 ?? null) as DensityProfile | null;
      const a2Cost = a2Report.cost as { cerebras: { usd: number; calls: number }; zaiVision: { usd: number }; totalUsd: number } | undefined;
      const a2Wall = a2Report.wall as { totalRunSeconds: number; compositionToPreviewSeconds: number | null } | undefined;
      const a2Rounds = (a2Report.gateRounds ?? []) as { density: unknown[]; renderTruthBlocking: unknown[] }[];
      const a2CastRounds = (a2Report.castRounds ?? []) as CastBuildResult["telemetry"][];
      const gptOssCells: RowCell[] = [];
      for (const i of SCENES) {
        const p = a2Profile?.scenes.find((s) => s.scene === i);
        const note = p
          ? p.ssrError
            ? `SSR error: ${p.ssrError.slice(0, 60)}`
            : `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · depth ${p.depth}`
          : "no v2 data";
        const png = path.join(A2_DIR, `scene${i}.png`);
        const exists = await fs.stat(png).then(() => true).catch(() => false);
        gptOssCells.push({ scene: i, ...(exists ? { png: `../acceptance2/scene${i}.png` } : {}), label: script.scenes[i]?.label ?? `scene ${i}`, note });
      }
      const a2FinalRound = a2Rounds[a2Rounds.length - 1];
      const gptOss: ReusedRow = {
        title: "gpt-oss-120b (v2, reused)",
        cells: gptOssCells,
        profile: a2Profile,
        summary: a2Cost && a2Wall
          ? `v2 run (includes DS + composition-head calls v3 reuses for free): ${a2Cost.cerebras.calls} real calls · Cerebras $${a2Cost.cerebras.usd.toFixed(4)} ($0.35/$0.75 per M) + vision $${a2Cost.zaiVision.usd.toFixed(4)} = $${a2Cost.totalUsd.toFixed(4)} · composition→preview ${a2Wall.compositionToPreviewSeconds}s · ${a2Rounds.length} gate round(s), final residual density ${a2FinalRound?.density.length ?? "?"} · rt-blocking ${a2FinalRound?.renderTruthBlocking.length ?? "?"} · repairs ${a2CastRounds.reduce((n, t) => n + t.repairs, 0)} · placeholders ${a2CastRounds[a2CastRounds.length - 1]?.failures ?? "?"}`
          : "v2 build-report unavailable",
      };

      // Reference row — the production GLM-5.2 build (the bar).
      const refCells: RowCell[] = [];
      for (const i of SCENES) {
        const pr = refProfile?.scenes.find((s) => s.scene === i);
        const noteR = pr
          ? `diegetic ${pr.bestDiegetic ? `${pr.bestDiegetic.elements}el/${pr.bestDiegetic.textNodes}txt` : "none"} · depth ${pr.depth}`
          : "no reference data";
        const png = path.join(V1_DIR, "reference", `scene${i}.png`);
        const exists = await fs.stat(png).then(() => true).catch(() => false);
        refCells.push({ scene: i, ...(exists ? { png: `../acceptance/reference/scene${i}.png` } : {}), label: refScript.scenes[i]?.label ?? `scene ${i}`, note: noteR });
      }
      const reference: ReusedRow = {
        title: "GLM-5.2 reference (the bar)",
        cells: refCells,
        profile: refProfile,
        summary: `the production GLM-5.2 build (ref ${REF_BUILD}) — the craft bar; no cost/gate telemetry in this frame (it predates the cast path)`,
      };

      report.headline = [
        `brand ${BRAND} (ref ${REF_BUILD})`,
        ...rowReports.map(
          (r) =>
            `${r.model}: ${r.realCalls} calls · $${r.cost.totalUsd.toFixed(3)} · ${r.gateRounds.length} round(s)${r.budgetExhausted ? " · BUDGET-ABORTED" : ""}${r.terminalError ? " · TERMINAL" : ""}`,
        ),
        `global ${globalRealCalls}/${GLOBAL_CALL_CEILING} real Cerebras calls`,
      ].join(" · ");
      await writeOut();
      await fs.writeFile(
        path.join(OUT_DIR, "index.html"),
        galleryHtml({
          report,
          rows: rowReports,
          gptOss,
          reference,
          blueprintNote:
            blueprintResiduals.length === 0
              ? "Blueprint re-validated clean on load (checkSceneComposition: 0 residuals)."
              : `NOTE: blueprint re-validation found ${blueprintResiduals.length} residual(s) — shipped anyway (regenerating would break the controlled experiment).`,
        }),
        "utf8",
      );
    });

    // ── console summary ──────────────────────────────────────────────────────
    console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
    console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
    for (const r of rowReports) {
      console.log(
        `${r.model.padEnd(14)} ${r.realCalls} calls · Cerebras $${r.cost.cerebras.usd.toFixed(4)} + vision $${r.cost.zaiVision.usd.toFixed(4)} = $${r.cost.totalUsd.toFixed(4)} · ` +
          `cast wall ${r.wall.castWallSeconds}s · cast→preview ${r.wall.castToPreviewSeconds}s · ${gateSummaryLine(r)}`,
      );
    }
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
