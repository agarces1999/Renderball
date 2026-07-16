/**
 * ACCEPTANCE V2 — the BLUEPRINT-DRIVEN pipeline on Duolingo. Same brand, same
 * reference build, same gate stack as acceptance v1 (scripts/acceptance-spike.ts),
 * with the three operational changes the v1 report earned:
 *
 *   1. SCRIPT: gpt-oss script generation is SKIPPED. v1 measured gpt-oss
 *      cannot clear the richness bar on this brand (4/4 attempts invalid →
 *      reference fallback); the hybrid-head decision is made. This run uses
 *      the Duolingo reference script.json directly and says so in the report.
 *   2. COMPOSITION HEAD (the point of this run): after design-system emission,
 *      generateComposition (lib/agents/composition-head.ts) runs on gpt-oss
 *      with caller=castCall at effort "high" and validate=checkSceneComposition
 *      (lib/agents/schema-validator.ts) — the FIRST LIVE test of the blueprint
 *      contract. Every attempt + every validation error is logged VERBATIM.
 *      Terminal validation failure → proceed with the last attempt's scenes
 *      AND record the residual errors (the downstream gates are the backstop);
 *      that outcome is itself a key finding (blueprint needs the thinking
 *      model too) and is reported loudly, not hidden.
 *   3. CAST consumes the composed scenes natively (cast-build.ts leads each
 *      element brief with the head's blueprint).
 *   4. GATES as v1 (density BLOCKING, structural, render-truth with production
 *      BLOCKING_KINDS, per-scene vision) with TWO fixes:
 *      (a) retry routing — a measure-error ("no SectionN / render failed",
 *          and density's SSR-failure twin) routes to a FULL RE-CAST of that
 *          scene's non-chrome pieces, not silence. v1 shipped scene 4 broken
 *          for three rounds because measure-error was unroutable.
 *      (b) sequence vision runs ONCE, after the final per-scene round — v1
 *          spent ~40-60s per round re-judging the whole sequence it never
 *          acted on.
 *   5. GALLERY (.data/acceptance2/index.html): THREE rows — v2 (this run),
 *      v1 (reusing ../acceptance/scene*.png), GLM reference (reusing
 *      ../acceptance/reference/*.png) — with per-scene density numbers on all
 *      three rows (v1 + reference numbers come from v1's build-report.json,
 *      reused honestly, not re-measured), the phase timeline, the gate log,
 *      the composition-head attempt log, and the scene-2 blueprint VERBATIM
 *      in a <details> block.
 *
 *   set -a && source .env.local && set +a && node scripts/acceptance2-spike.mjs
 *
 * Budget guard: ≤60 REAL Cerebras calls (cached replays are free); the guard
 * aborts retries honestly and the report ships with everything so far. Same
 * honesty guarantees as v1: terminal failure still writes a partial report.
 *
 * Footprint: this file + scripts/acceptance2-spike.mjs + .data/acceptance2/ +
 * src/generated/CAST_SPIKE_ACCEPT2_*. Reads everything, modifies nothing else.
 */
import { promises as fs } from "fs";
import path from "path";
import { castBuild, type CastBuildResult } from "../lib/agents/cast-build";
import { castCall, castConfigured, type CastResult } from "../lib/llm/cast-provider";
import { generateComposition, type CompositionCaller } from "../lib/agents/composition-head";
import type { Theme } from "../lib/edit/piece-model";
import type { Script, Scene } from "../src/schema";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
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
  checkBrandColorFidelity,
  judgeSequence,
  type SequenceJudge,
  type VisionFinding,
} from "../lib/render/vision-gate";
import { callZaiVision, callZaiText } from "../lib/render/zai-vision";
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
const OUT_DIR = path.join(ROOT, ".data", "acceptance2");
const V1_DIR = path.join(ROOT, ".data", "acceptance"); // v1 outputs, reused read-only
const GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_ACCEPT2_DUOLINGO");
const SCENES = [0, 1, 2, 3, 4];
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

const DS_MAX_TOKENS = 10000;
const HEAD_EFFORT = "high" as const;

const CALL_CEILING = 60; // REAL Cerebras calls (cached replays are free)
const MAX_RETRY_ROUNDS = 2;

// gpt-oss-120b on Cerebras, published pricing per M tokens.
const USD_PER_M_IN = 0.35;
const USD_PER_M_OUT = 0.75;

// The production blocking set — verbatim from run-preview-build.ts.
const BLOCKING_KINDS: RenderTruthKind[] = [
  "overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness", "stranded-hero",
];
// The pipeline's vision action threshold — SEVERE_RX verbatim.
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

// ── budgeted cast transport ──────────────────────────────────────────────────

class BudgetExceeded extends Error {}
interface CallLogRow {
  label: string; secs: number; in: number; out: number; stop: string | null; cached: boolean;
}
const callLog: CallLogRow[] = [];
let realCalls = 0;
let cerebrasIn = 0;
let cerebrasOut = 0;
let budgetExhausted = false;

const budgetedCast = async (
  label: string,
  args: { system: string; user: string; maxTokens: number; effort: "low" | "medium" | "high" },
): Promise<CastResult> => {
  if (realCalls >= CALL_CEILING) {
    budgetExhausted = true;
    throw new BudgetExceeded(`call ceiling (${CALL_CEILING}) reached at "${label}" — runaway guard`);
  }
  realCalls += 1;
  const r = await castCall(args);
  cerebrasIn += r.inputTokens;
  cerebrasOut += r.outputTokens;
  callLog.push({ label, secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason, cached: false });
  return r;
};

// z.ai vision spend (the QA side of the cost split).
let zaiUsage: Usage = { ...EMPTY_USAGE };
let zaiCalls = 0;

// ── caching + feedback caller for castBuild (v1's retry machinery, verbatim) ─

const pieceCache = new Map<string, string>(); // pieceId → last raw emission (stripped)
let pieceTargets = new Map<string, string[]>(); // pieceId → gate feedback lines
let castRoundLabel = "cast-r0";

const cachingCaller: typeof castCall = async (call) => {
  const pieceId = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
  const feedback = pieceTargets.get(pieceId);
  const cached = pieceCache.get(pieceId);
  if (!feedback && cached !== undefined) {
    callLog.push({ label: `${castRoundLabel}:${pieceId}`, secs: 0, in: 0, out: 0, stop: "cached-replay", cached: true });
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
    const res = await budgetedCast(
      `${castRoundLabel}:${pieceId}${feedback ? ":regen" : ""}`,
      { system: call.system, user, maxTokens: call.maxTokens, effort: (call.effort ?? "low") as "low" | "medium" | "high" },
    );
    if (res.text && res.text.trim().length >= 8) pieceCache.set(pieceId, stripCodeFence(res.text));
    return res;
  } catch (e) {
    // A targeted regen whose call failed (budget/transport) falls back to the
    // previous body instead of downgrading a shipped piece to a placeholder.
    if (feedback && cached !== undefined) {
      callLog.push({ label: `${castRoundLabel}:${pieceId}:regen-failed-kept-previous`, secs: 0, in: 0, out: 0, stop: "regen-failed", cached: true });
      console.warn(`  [retry] ${pieceId}: regen call failed (${e instanceof Error ? e.message.split("\n")[0] : e}) — previous body kept`);
      return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "regen-failed-replayed-previous" };
    }
    throw e;
  }
};

// ── small utilities ──────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Balanced scanner for a top-level `const NAME = …;` declaration (v1's). */
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

/** `const NAME = \`…\`;` → the runtime string (cast-spike's extractor). */
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

// ── PHASE 2: design-system head call, validated standalone (v1's, verbatim) ──

const DS_DECLS = ["PALETTE", "SHARED_KEYFRAMES", "THROUGHLINE_TABS", "ThroughlineMotif"] as const;
const REQUESTED_KEYFRAMES = ["glowBreathe", "drift1", "drift2", "drift3", "drawWidth", "fadeRise", "scaleIn"];

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
  missingRequestedKeyframes?: string[];
}

const parseDsEmission = (raw: string): DsParse => {
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
  const missing = REQUESTED_KEYFRAMES.filter((n) => !new RegExp(`@keyframes\\s+${n}\\b`).test(kf));
  return { ok: true, decls, missingRequestedKeyframes: missing };
};

// ── Theme derivation (v1's, verbatim) ────────────────────────────────────────

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
  notes.push("keyframes: head-emitted SHARED_KEYFRAMES carried verbatim — the element system prompt advertises exactly these names.");
  const fonts = fontsFromReference(refPreamble);
  notes.push("fonts: FONT_DISPLAY/FONT_BODY/FONT_MONO + BRAND_FONTS_CSS carried VERBATIM from the reference preamble (locked brand identity — the head call does not own fonts).");
  const grammar = grammarDefaults();
  notes.push("grammar (DERIVED — the DS contract has no grammar decls): hairline=SOFT_NEUTRAL, panelBg=CARD_FILL (contract consts), radiusScale=[6,12,20], 1px strokes, neutral ink-tinted shadow, dataFont=mono (cast-spike defaults).");
  notes.push("THROUGHLINE_TABS + ThroughlineMotif: contract-validated but NOT consumed by the cast path — the cast throughline element builds from the composition head's blueprint (v2) or the script throughline text.");
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

// ── structural gates (the standalone-runnable production set, v1's) ──────────

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

// ── per-scene vision (v1's upgraded rubric) ──────────────────────────────────

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
  const judged = await Promise.allSettled(
    measurements
      .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
      .map(async (m) => {
        const b64 = (await fs.readFile(m.screenshotPath)).toString("base64");
        const rubric = buildRubric(brandTruth, script.scenes[m.scene]?.visual_concept);
        const { text, usage } = await callZaiVision(b64, rubric);
        zaiUsage = addUsage(zaiUsage, usage);
        zaiCalls += 1;
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

// ── sequence vision — v2 CHANGE: runs ONCE, after the final per-scene round ──

const sequenceJudge: SequenceJudge = async (imagesB64, prompt) => {
  const { text, usage } = await callZaiVision(imagesB64, prompt, { maxTokens: 2500 });
  zaiUsage = addUsage(zaiUsage, usage);
  zaiCalls += 1;
  return text;
};

const runSequenceRound = async (
  measurements: SceneMeasurement[],
  brandTruth: BrandTruthLite,
): Promise<VisionFinding[]> => {
  const ordered = measurements
    .filter((m): m is SceneMeasurement & { screenshotPath: string } => !!m.screenshotPath)
    .sort((a, b) => a.scene - b.scene);
  const imagesB64 = await Promise.all(ordered.map(async (m) => (await fs.readFile(m.screenshotPath)).toString("base64")));
  return judgeSequence(imagesB64, brandTruth, sequenceJudge);
};

// ── finding → piece routing (v2 CHANGE: measure-error → full scene re-cast) ──

const PIECE_ID_RX = /\bs\d+\.(?:hero|copy|atmosphere|connector|throughline)\b/g;
const VISION_COPY_RX = /\b(head(?:line)?|lede|bullet|caption|copy|paragraph|typograph|font|wall of type|text\b)/i;
const VISION_ATMOS_RX = /\b(background|canvas|atmosphere|glow|gradient|vignette|grain|wash)\b/i;

const computeTargets = (args: {
  validPieceIds: Set<string>;
  density: DensityFinding[];
  profile: DensityProfile;
  rtBlocking: RenderTruthFinding[];
  vision: SceneVisionVerdict[];
}): Map<string, string[]> => {
  const { validPieceIds, density, profile, rtBlocking, vision } = args;
  const targets = new Map<string, string[]>();
  const add = (pieceId: string, sceneFallback: number, feedback: string): void => {
    let id = pieceId;
    if (!validPieceIds.has(id)) id = `s${sceneFallback}.hero`;
    if (!validPieceIds.has(id)) return; // no cast slot to route to — logged upstream
    targets.set(id, [...(targets.get(id) ?? []), feedback]);
  };

  // v2 FIX (a): a whole-scene render failure — render-truth "measure-error"
  // ("no SectionN / render failed") or density's SSR-failure twin — routes to
  // a FULL RE-CAST of that scene's non-chrome pieces. v1 skipped both kinds
  // (unroutable → silence) and shipped scene 4 broken through every round.
  const measureErrorScenes = new Map<number, string[]>(); // scene → detail lines
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
      // Route to the piece whose emission carries the offending src, else hero.
      const badTokens = [...f.detail.matchAll(/"([^"]{1,60})"/g)].map((m) => m[1]);
      let owner: string | null = null;
      for (const [pieceId, body] of pieceCache) {
        if (!pieceId.startsWith(`s${f.scene}.`)) continue;
        if (badTokens.some((t) => body.includes(t))) { owner = pieceId; break; }
      }
      add(owner ?? `s${f.scene}.hero`, f.scene, `[density/img-src] ${f.detail}\n${f.repairInstruction}`);
    }
    // atmosphere-monotony is routed from the numeric profile below;
    // density-measure-error is handled by the full-scene re-cast above.
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

// ── gallery ──────────────────────────────────────────────────────────────────

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

interface CompositionAttempt {
  attempt: number;
  secs: number;
  tokensIn: number;
  tokensOut: number;
  stop: string | null;
  errors: string[]; // verbatim validation/parse errors for THIS attempt
}

interface RowCell { scene: number; png?: string; label: string; note: string }

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

const galleryHtml = (g: {
  report: Record<string, unknown>;
  rounds: GateRoundReport[];
  compositionAttempts: CompositionAttempt[];
  compositionSummary: { attempts: number; validatedClean: boolean; threw: boolean; residualErrors: string[]; note: string };
  scene2Blueprint: string | null;
  sequenceFinal: VisionFinding[];
  v2Cells: RowCell[];
  v1Cells: RowCell[];
  refCells: RowCell[];
  v2Profile: DensityProfile | null;
  v1Profile: DensityProfile | null;
  refProfile: DensityProfile | null;
  refDensityFindings: DensityFinding[];
}): string => {
  const {
    report, rounds, compositionAttempts, compositionSummary, scene2Blueprint, sequenceFinal,
    v2Cells, v1Cells, refCells, v2Profile, v1Profile, refProfile, refDensityFindings,
  } = g;
  const cost = report.cost as { cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
  const wall = report.wall as { totalRunSeconds: number; compositionToPreviewSeconds: number | null };

  const row = (cells: RowCell[]): string =>
    cells
      .map((s) => {
        const visual = s.png
          ? `<a href="${esc(s.png)}" target="_blank"><img src="${esc(s.png)}" alt="scene ${s.scene}"></a>`
          : `<div class="err">NO RENDER</div>`;
        return `<div class="cell"><div class="cell-title">scene ${s.scene} — ${esc(s.label)}</div>${visual}<div class="stat">${esc(s.note)}</div></div>`;
      })
      .join("\n");

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

  const compRows = compositionAttempts
    .map((a) => {
      const verdict = a.errors.length === 0 ? "VALID" : `INVALID — ${a.errors.length} error(s)`;
      const errList = a.errors.map((e) => `<li>${esc(e)}</li>`).join("\n");
      return `<li><b>attempt ${a.attempt}</b> (${a.secs.toFixed(1)}s, ${a.tokensOut} tok out, stop=${esc(String(a.stop))}): ${verdict}${a.errors.length ? `<ul>${errList}</ul>` : ""}</li>`;
    })
    .join("\n");
  const compResidual = compositionSummary.residualErrors.length
    ? `<div class="sub bad-line">TERMINAL: the shipped blueprint STILL carries ${compositionSummary.residualErrors.length} validation error(s) — the downstream gates were the backstop:</div><ul>${compositionSummary.residualErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
    : `<div class="sub ok-line">blueprint validated CLEAN (attempt ${compositionSummary.attempts})</div>`;

  const gateLog = rounds
    .map((r) => {
      const rows: string[] = [];
      for (const f of r.density) rows.push(`<li><b>density/${esc(f.kind)} (BLOCKING)</b> scene ${f.scene}: ${esc(f.detail.slice(0, 260))}</li>`);
      for (const f of r.structural) rows.push(`<li><b>structural/${esc(f.key)}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const f of r.renderTruthAll) rows.push(`<li><b>render-truth/${esc(f.kind)}${r.renderTruthBlocking.includes(f) ? " (BLOCKING)" : " (advisory)"}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const v of r.vision) {
        if (v.error) rows.push(`<li><b>vision</b> scene ${v.scene}: judge error — ${esc(v.error)}</li>`);
        else if (v.actionable.length === 0) rows.push(`<li><b>vision</b> scene ${v.scene}: CLEAN${v.issues.length ? ` (sanctioned-chrome findings dropped: ${v.issues.length})` : ""}</li>`);
        else for (const issue of v.actionable) rows.push(`<li><b>vision${v.severe.includes(issue) ? " (SEVERE)" : ""}</b> scene ${v.scene}: ${esc(issue.slice(0, 260))}</li>`);
      }
      const targets = r.targets.map((t) => t.pieceId).join(", ") || "none";
      return `<h3>gate round ${r.round} — ${r.realCalls} real Cerebras calls this round · retry targets: [${esc(targets)}]</h3><ul>${rows.join("\n") || "<li>all clean</li>"}</ul>`;
    })
    .join("\n");
  const seqLog = sequenceFinal.length
    ? sequenceFinal.map((f) => `<li><b>sequence-vision (log-only, ran ONCE after the final round)</b>: ${esc(f.issue.slice(0, 320))}</li>`).join("\n")
    : "<li>sequence vision: CLEAN</li>";

  const densityTable = `
  <table>
    <tr>
      <th rowspan="2">scene</th>
      <th colspan="4">V2 — blueprint-driven (this run)</th>
      <th colspan="4">V1 — acceptance (no blueprint)</th>
      <th colspan="4">REFERENCE (GLM — the bar)</th>
    </tr>
    <tr>
      <th>diegetic el/txt (≥${DIEGETIC_MIN_ELEMENTS}/${DIEGETIC_MIN_TEXT_NODES})</th><th>depth (≥${DEPTH_FLOOR})</th><th>grad sigs</th><th>bad img</th>
      <th>diegetic el/txt</th><th>depth</th><th>grad sigs</th><th>bad img</th>
      <th>diegetic el/txt</th><th>depth</th><th>grad sigs</th><th>bad img</th>
    </tr>
    ${SCENES.map((i) => `<tr><td>scene ${i}</td>${densityCellHtml(v2Profile?.scenes.find((s) => s.scene === i))}${densityCellHtml(v1Profile?.scenes.find((s) => s.scene === i))}${densityCellHtml(refProfile?.scenes.find((s) => s.scene === i))}</tr>`).join("\n")}
    <tr>
      <td>video-level</td>
      <td colspan="4" class="${v2Profile && v2Profile.varietyPass ? "ok" : "bad"}">${v2Profile ? `${v2Profile.distinctSignatures} distinct gradient signatures (≥${MIN_GRADIENT_SIGNATURES}); ${v2Profile.repeated.length} repeated-verbatim violation(s)` : "n/a"}</td>
      <td colspan="4" class="${v1Profile && v1Profile.varietyPass ? "ok" : "bad"}">${v1Profile ? `${v1Profile.distinctSignatures} distinct; ${v1Profile.repeated.length} repeated violation(s)` : "n/a"}</td>
      <td colspan="4" class="${refProfile && refProfile.varietyPass ? "ok" : "bad"}">${refProfile ? `${refProfile.distinctSignatures} distinct; ${refProfile.repeated.length} repeated violation(s)` : "n/a"}</td>
    </tr>
  </table>
  <div class="sub">v1 + reference numbers reused from ../acceptance/build-report.json (not re-measured) · reference assessDensity findings: ${refDensityFindings.length === 0 ? "CLEAN" : esc(refDensityFindings.map((f) => `${f.kind}@${f.scene}`).join(", "))}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceptance v2 — ${esc(BRAND)}: blueprint-driven pipeline (composition head live)</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; }
  h2 { font-size: 15px; font-weight: 700; margin: 26px 0 10px; color: #c9cad1; }
  h3 { font-size: 12px; font-family: ui-monospace, Menlo, monospace; margin: 14px 0 6px; color: #a9aab3; }
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
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 1100px; }
</style>
</head>
<body>
  <h1>Acceptance v2 — ${esc(BRAND)}: blueprint-driven pipeline (composition head, first live test)</h1>
  <div class="sub">${esc(String(report.headline ?? ""))}</div>
  <div class="sub">composition→preview wall <b>${wall.compositionToPreviewSeconds === null ? "—" : `${wall.compositionToPreviewSeconds.toFixed(1)}s`}</b> · run total ${wall.totalRunSeconds.toFixed(1)}s · cost: Cerebras $${cost.cerebras.usd.toFixed(4)} + z.ai vision $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)} · script phase SKIPPED (reference script; hybrid-head decision from v1) · reference build ${esc(REF_BUILD)}</div>

  <h2>Phase timeline</h2>
  <div class="timeline">${bars}</div>
  <div>${legend}</div>

  <h2>Composition head — attempt log (first live test of the blueprint contract)</h2>
  <div class="sub">${esc(compositionSummary.note)}</div>
  <ul>${compRows || "<li>no attempts logged</li>"}</ul>
  ${compositionSummary.threw ? `<div class="sub bad-line">HEAD THREW (unparseable after all attempts) — proceeded with UN-COMPOSED scenes (generic-brief path)</div>` : compResidual}
  ${scene2Blueprint ? `<details open><summary>Scene 2 blueprint — VERBATIM, as the head authored it</summary><pre>${esc(scene2Blueprint)}</pre></details>` : `<div class="sub bad-line">no scene-2 blueprint shipped (head threw or scene un-composed)</div>`}

  <h2>Density comparison — v2 vs v1 vs reference, per scene per clause</h2>
  ${densityTable}

  <h2>V2 row — blueprint-driven (this run)</h2>
  <div class="row">
${row(v2Cells)}
  </div>

  <h2>V1 row — acceptance v1 (no blueprint; reused from ../acceptance/)</h2>
  <div class="row">
${row(v1Cells)}
  </div>

  <h2>Reference row — the production GLM build (reused from ../acceptance/reference/)</h2>
  <div class="row">
${row(refCells)}
  </div>

  <h2>Gate log (round by round; sequence vision ran ONCE after the final round)</h2>
  ${gateLog}
  <h3>final sequence-vision pass</h3>
  <ul>${seqLog}</ul>

  <div class="foot">
    v2 changes vs v1: (1) script generation SKIPPED — reference script used directly (v1 measured gpt-oss 0/4 on the
    richness bar; hybrid-head decision made); (2) NEW composition head (generateComposition, effort high, validated by
    checkSceneComposition with verbatim-error repairs, ≤3 attempts) authors the per-scene blueprint castBuild consumes
    natively; (3) measure-error now routes to a FULL re-cast of the failing scene's non-chrome pieces; (4) sequence
    vision runs once, after the final per-scene round. Same budget guard (≤${CALL_CEILING} real Cerebras calls), same honesty
    posture (terminal failure ships a partial report).
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/acceptance2-spike.mjs");
    process.exitCode = 1;
    return;
  }
  const model = process.env.RB_CAST_MODEL || "gpt-oss-120b";
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const report: Record<string, unknown> = {
    experiment: "ACCEPTANCE V2: blueprint-driven pipeline — reference script (script gen SKIPPED) → DS → composition head (FIRST LIVE TEST) → castBuild consuming scene.composition → gates with measure-error full-scene re-cast routing + sequence vision once",
    brand: BRAND,
    ref: REF_BUILD,
    model,
    generatedAt: new Date().toISOString(),
    scriptNote:
      "HONESTY: gpt-oss script generation was SKIPPED by design. Acceptance v1 measured gpt-oss 0/4 attempts against the richness contract on this brand (it fell back to the reference script anyway); the hybrid-head decision is made. This run uses the Duolingo reference script.json directly — script-generation wall/cost are NOT represented here.",
    crawlNote: "brand_extract was CACHED on the brief — live-crawl time is excluded from every wall number here",
    v1ReuseNote: "v1 row images + v1/reference density numbers are REUSED from .data/acceptance/ (v1's build-report.json), not re-measured",
    terminalError: null,
  };
  const gateRounds: GateRoundReport[] = [];
  const compositionAttempts: CompositionAttempt[] = [];
  let compositionSummary = { attempts: 0, validatedClean: false, threw: false, residualErrors: [] as string[], note: "" };
  let script: LooseScript | null = null;
  let finalMeasurements: SceneMeasurement[] = [];
  let sequenceFinal: VisionFinding[] = [];
  let v2Profile: DensityProfile | null = null;
  let compositionStartS: number | null = null;
  let previewEndS: number | null = null;

  const writeOut = async (): Promise<void> => {
    const cerebrasUsd = (cerebrasIn * USD_PER_M_IN + cerebrasOut * USD_PER_M_OUT) / 1e6;
    const zaiUsd = costUsd(VISION_MODEL, zaiUsage);
    report.phases = marks;
    report.gateRounds = gateRounds;
    report.compositionHead = { ...compositionSummary, attemptLog: compositionAttempts };
    report.calls = callLog;
    report.budget = { realCerebrasCalls: realCalls, ceiling: CALL_CEILING, budgetExhausted };
    report.cost = {
      cerebras: { calls: realCalls, inputTokens: cerebrasIn, outputTokens: cerebrasOut, usdPerMIn: USD_PER_M_IN, usdPerMOut: USD_PER_M_OUT, usd: cerebrasUsd },
      zaiVision: { calls: zaiCalls, inputTokens: zaiUsage.input_tokens, outputTokens: zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
      totalUsd: cerebrasUsd + zaiUsd,
    };
    report.wall = {
      totalRunSeconds: nowS(),
      compositionToPreviewSeconds:
        compositionStartS !== null && previewEndS !== null ? Math.round((previewEndS - compositionStartS) * 10) / 10 : null,
    };
    report.sequenceFinal = sequenceFinal;
    report.densityProfileV2 = v2Profile;
    await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  };

  try {
    // ── inputs: reference manifest (fonts/logo) + reference script ──────────
    const manifest: Manifest = JSON.parse(await fs.readFile(path.join(REF_DIR, "lego", "manifest.json"), "utf8"));
    const refScript: LooseScript = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));

    // v1 artifacts for the gallery's v1 + reference rows (reused, read-only).
    let v1Report: Record<string, unknown> | null = null;
    try {
      v1Report = JSON.parse(await fs.readFile(path.join(V1_DIR, "build-report.json"), "utf8"));
    } catch {
      console.warn("  v1 build-report.json missing — v1/reference gallery rows will be empty");
    }
    const v1Profiles = (v1Report?.densityProfiles ?? null) as
      | { acceptance?: DensityProfile; reference?: DensityProfile; referenceFindings?: DensityFinding[] }
      | null;
    const v1Profile = v1Profiles?.acceptance ?? null;
    const refProfile = v1Profiles?.reference ?? null;
    const refDensityFindings = v1Profiles?.referenceFindings ?? [];

    // ── brief from the store (brand_extract for canvas/signature/DS prompt) ─
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

    // ── canary (proves transport + key + model before any real spend) ────────
    await phase("canary", async () => {
      const c = await budgetedCast("canary", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, effort: "low" });
      console.log(`  canary ok — ${c.seconds.toFixed(1)}s, ${c.outputTokens} tok out, stop=${c.stopReason}`);
    });

    // ── PHASE 1 (v2): reference script, DIRECTLY — no gpt-oss script gen ─────
    script = await phase("script-load", async () => {
      const s = backfillSceneRegisters(normalizeScriptContent(refScript)) as LooseScript;
      console.log(`  reference script loaded — ${s.scenes.length} scenes: ${s.scenes.map((x) => x.label).join(" · ")}`);
      console.log(`  (script generation SKIPPED — v1 measured gpt-oss 0/4 on the richness bar; hybrid-head decision)`);
      return s;
    });
    report.script = {
      source: "reference script.json (gpt-oss script generation SKIPPED — see scriptNote)",
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
      headlines: script.scenes.map((s) => s.content?.headline),
    };

    // ── PHASE 2: DESIGN SYSTEM head call → Theme (as v1) ────────────────────
    const refFonts = fontsFromReference(manifest.preamble);
    const ds = await phase("design-system", async () => {
      const user = dsUserPrompt(script!, be, { display: refFonts.display, body: refFonts.body }, signature);
      const first = await budgetedCast("design-system", { system: dsSystemPrompt, user, maxTokens: DS_MAX_TOKENS, effort: HEAD_EFFORT });
      let parsed = parseDsEmission(first.text);
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
          effort: HEAD_EFFORT,
        });
        parsed = parseDsEmission(fix.text);
        compileErr = parsed.ok ? await verifyCompilable(Object.values(parsed.decls!).join("\n\n")) : parsed.error ?? "parse failed";
      }
      if (!parsed.ok || compileErr) {
        console.error(`  DS STILL invalid (${String(parsed.error ?? compileErr).split("\n")[0]}) — FALLBACK theme from the reference build (recorded honestly)`);
        return { derived: fallbackThemeFromReference(manifest.preamble, canvasPlan.background, signature, be.palette ?? []), ok: false, repaired, error: String(parsed.error ?? compileErr) };
      }
      await fs.writeFile(path.join(OUT_DIR, "design-system-emission.tsx"), Object.values(parsed.decls!).join("\n\n"), "utf8");
      const derived = themeFromDs(parsed.decls!, manifest.preamble, be.palette ?? []);
      if (parsed.missingRequestedKeyframes!.length > 0) {
        derived.mappingNotes.push(`requested shared keyframes MISSING from the emission (warn only): ${parsed.missingRequestedKeyframes!.join(", ")}`);
      }
      console.log(`  DS accepted${repaired ? " after ONE repair" : " first try"} — palette ${Object.keys(derived.theme.palette).join("/")}`);
      return { derived, ok: true, repaired, error: null as string | null };
    });
    const { theme, paletteHexes, signatureAccent, logoSrc, mappingNotes } = ds.derived;
    report.designSystem = { acceptedFromModel: ds.ok, repaired: ds.repaired, error: ds.error, themeMappingNotes: mappingNotes, logoSrc };

    const brandTruth: BrandTruthLite = {
      name: be.title ?? BRAND,
      backgroundColor: canvasPlan.background,
      accent: signature,
      fonts: [be.font_roles?.display, be.font_roles?.body].filter((f): f is string => !!f),
    };

    // ── PHASE 2.5 (NEW — the point of this run): COMPOSITION HEAD ───────────
    // generateComposition on gpt-oss (caller=castCall via the budget guard) at
    // effort "high", validated by checkSceneComposition, verbatim-error
    // repairs, ≤3 attempts. Terminal validation failure → last attempt's
    // scenes ship anyway (gates are the backstop) and the residuals are
    // recorded LOUDLY. gpt-oss authoring the blueprint is itself under test.
    compositionStartS = nowS();
    let headAttemptN = 0;
    const headCaller: CompositionCaller = async (call) => {
      headAttemptN += 1;
      const res = await budgetedCast(`composition-head-attempt-${headAttemptN}`, {
        system: call.system,
        user: call.user,
        maxTokens: call.maxTokens,
        effort: call.effort === "none" ? "low" : call.effort,
      });
      compositionAttempts.push({ attempt: headAttemptN, secs: res.seconds, tokensIn: res.inputTokens, tokensOut: res.outputTokens, stop: res.stopReason, errors: [] });
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
        // Distribute the verbatim errors onto their attempts (they arrive as "attempt N: …").
        for (const e of result.errors) {
          const m = /^attempt (\d+): ([\s\S]*)$/.exec(e);
          const bucket = m ? compositionAttempts.find((a) => a.attempt === Number(m[1])) : undefined;
          if (bucket) bucket.errors.push(m![2]);
          else compositionAttempts.push({ attempt: -1, secs: 0, tokensIn: 0, tokensOut: 0, stop: null, errors: [e] });
        }
        // Ground truth on what actually ships: re-validate the final scenes.
        const residual = checkSceneComposition(result.scenes);
        const validatedClean = residual.length === 0;
        compositionSummary = {
          attempts: result.attempts,
          validatedClean,
          threw: false,
          residualErrors: residual,
          note: validatedClean
            ? `blueprint VALIDATED on attempt ${result.attempts} of 3 (checkSceneComposition clean on the shipped scenes)`
            : `TERMINAL VALIDATION FAILURE after ${result.attempts} attempts — shipping the LAST attempt's scenes with ${residual.length} residual error(s); downstream gates are the backstop. KEY FINDING: gpt-oss could not author a contract-clean blueprint → the blueprint likely needs the thinking model too.`,
        };
        script = { ...script!, scenes: result.scenes as unknown as ScriptScene[] };
        console.log(`  composition head: ${result.attempts} attempt(s) — ${validatedClean ? "VALIDATED CLEAN" : `TERMINAL: ${residual.length} residual error(s) (shipping anyway; gates are the backstop)`}`);
        for (const e of result.errors) console.log(`    · ${e.slice(0, 200)}`);
        if (!validatedClean) {
          console.error(`  ▲▲▲ KEY FINDING: gpt-oss blueprints failed validation terminally — the blueprint may need the thinking model. Residuals:`);
          for (const e of residual) console.error(`    ▲ ${e}`);
        }
      } catch (e) {
        // Unparseable after all attempts — head/transport defect. Proceed
        // UN-COMPOSED (generic-brief path) and report loudly.
        const msg = e instanceof Error ? e.message : String(e);
        compositionSummary = {
          attempts: headAttemptN,
          validatedClean: false,
          threw: true,
          residualErrors: [msg],
          note: `HEAD THREW (unparseable after ${headAttemptN} attempts): ${msg} — proceeding with UN-COMPOSED scenes (generic-brief path). KEY FINDING: gpt-oss could not emit a parseable blueprint at all.`,
        };
        console.error(`  ▲▲▲ composition head THREW: ${msg} — proceeding un-composed (generic-brief path)`);
      }
      const compositions = script!.scenes.map((s, i) => ({ scene: i, composition: s.composition ?? null }));
      await fs.writeFile(path.join(OUT_DIR, "composition.json"), JSON.stringify(compositions, null, 2), "utf8");
    });

    // ── PHASES 3–5: castBuild (composed scenes) + gates + scoped retries ─────
    const castInput = {
      script: script as unknown as Script,
      theme,
      palette: paletteHexes,
      signatureAccent,
      aspect: "16:9" as const,
    };
    const roundTelemetry: CastBuildResult["telemetry"][] = [];
    let castResult: CastBuildResult | null = null;
    let finalCode = "";
    let round = 0;
    let genDirReady = false;

    while (true) {
      castRoundLabel = `cast-r${round}`;
      const callsBefore = realCalls;
      try {
        castResult = await phase(castRoundLabel, () => castBuild(castInput, { caller: cachingCaller }));
      } catch (e) {
        console.error(`  castBuild THREW on round ${round}: ${e instanceof Error ? e.message : e}`);
        report[`castRound${round}Error`] = e instanceof Error ? e.message : String(e);
        pieceTargets = new Map();
        break;
      }
      pieceTargets = new Map(); // consumed — gates decide the next round's targets
      roundTelemetry.push(castResult.telemetry);
      console.log(
        `  cast r${round}: ${castResult.telemetry.elements} elements · ${castResult.telemetry.repairs} repairs · ${castResult.telemetry.failures} placeholders · ` +
          `${castResult.telemetry.tokensOut} tok out · ${castResult.telemetry.normalizedColors} hue-locked · ${castResult.telemetry.wallSeconds}s · ${realCalls - callsBefore} real calls`,
      );

      finalCode = await phase(`finalize-r${round}`, async () => {
        let code = injectLogoSrc(castResult!.code, logoSrc);
        const fin = await finalizeUndefinedRefs(code);
        report[`finalizeR${round}`] = { logoInjected: Boolean(logoSrc), added: fin.added, stubbed: fin.stubbed, neutralized: fin.neutralized };
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

      // (a) density gates — blocking.
      const density = await phase(`density-r${round}`, async () => assessDensity(finalCode, script));
      v2Profile = buildDensityProfile(finalCode, script);
      console.log(`  density: ${density.length} blocking finding(s) · video distinct sigs ${v2Profile.distinctSignatures} · depths [${v2Profile.scenes.map((s) => s.depth).join(", ")}]`);

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

      // (c) per-scene vision. (Sequence vision moved OUT of the loop — v2 fix b.)
      const vision = await phase(`vision-r${round}`, () => runVisionRound(measurements, script!, brandTruth));

      if (round === 0 && brandTruth.name) {
        try {
          const fid = await checkBrandColorFidelity({ name: brandTruth.name }, be.palette ?? [], async (p) => {
            const { text, usage } = await callZaiText(p, { disableThinking: true, maxTokens: 600 });
            zaiUsage = addUsage(zaiUsage, usage);
            zaiCalls += 1;
            return text;
          });
          report.brandColorFidelity = fid;
          if (!fid.onBrand) console.warn(`  brand-color fidelity flagged (advisory): ${fid.issue}`);
        } catch { /* advisory */ }
      }

      const validPieceIds = new Set(castResult.scenes.flatMap((s) => s.pieces.filter((p) => p.kind !== "chrome").map((p) => p.id)));
      const targets = computeTargets({ validPieceIds, density, profile: v2Profile, rtBlocking: rt.blocking, vision });

      const roundReport: GateRoundReport = {
        round,
        realCalls: realCalls - callsBefore,
        castTelemetry: castResult.telemetry,
        density,
        profile: v2Profile,
        structural,
        renderTruthAll: rt.findings,
        renderTruthBlocking: rt.blocking,
        vision,
        targets: [...targets.entries()].map(([pieceId, feedback]) => ({ pieceId, feedback })),
      };
      gateRounds.push(roundReport);
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
      if (budgetExhausted) {
        console.warn(`  Cerebras call ceiling reached — shipping with residual findings (honest)`);
        break;
      }
      pieceTargets = targets;
      round += 1;
    }
    report.castRounds = roundTelemetry;
    report.pieceRetryRounds = gateRounds.map((r) => ({ round: r.round, targets: r.targets.map((t) => t.pieceId) }));
    if (finalCode) await fs.writeFile(path.join(OUT_DIR, "Composition.acceptance2.tsx"), finalCode, "utf8");

    // ── SEQUENCE VISION — ONCE, after the final per-scene round (v2 fix b) ───
    if (finalMeasurements.some((m) => m.screenshotPath)) {
      sequenceFinal = await phase("sequence-vision-final", () => runSequenceRound(finalMeasurements, brandTruth));
      for (const f of sequenceFinal) console.log(`  sequence: ${f.issue.slice(0, 160)}`);
    } else {
      console.warn("  no screenshots — sequence vision skipped");
    }

    // ── PHASE 6: gallery (three rows) ────────────────────────────────────────
    await phase("gallery", async () => {
      const finalRound = gateRounds[gateRounds.length - 1];
      const v2Cells: RowCell[] = [];
      for (const i of SCENES) {
        const m = finalMeasurements.find((mm) => mm.scene === i);
        const v = finalRound?.vision.find((vv) => vv.scene === i);
        const dens = finalRound?.density.filter((f) => f.scene === i) ?? [];
        const rtb = finalRound?.renderTruthBlocking.filter((f) => f.scene === i) ?? [];
        const p = v2Profile?.scenes.find((s) => s.scene === i);
        const note = [
          p ? (p.ssrError ? `density: SSR ERROR` : `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · depth ${p.depth}`) : "density: n/a",
          v ? (v.actionable.length === 0 ? "vision: CLEAN" : `vision: ${v.actionable.length} issue(s)${v.severe.length ? ` (${v.severe.length} severe)` : ""}`) : "vision: n/a",
          dens.length ? `density findings: ${dens.map((f) => f.kind).join(", ")}` : "density findings: clean",
          rtb.length ? `render-truth blocking: ${rtb.map((f) => f.kind).join(", ")}` : "render-truth: clean",
        ].join("\n");
        const shot = path.join(GEN_DIR, `measure-scene-${i}.png`);
        const exists = await fs.stat(shot).then(() => true).catch(() => false);
        if (exists && !m?.error) {
          await fs.copyFile(shot, path.join(OUT_DIR, `scene${i}.png`));
          v2Cells.push({ scene: i, png: `scene${i}.png`, label: script!.scenes[i]?.label ?? `scene ${i}`, note });
        } else {
          v2Cells.push({ scene: i, label: script!.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
        }
      }

      // v1 + reference rows: reuse v1's images + numbers (recorded honestly).
      const v1Labels = ((v1Report?.script as { labels?: string[] } | undefined)?.labels ?? script!.scenes.map((s) => s.label));
      const v1Cells: RowCell[] = [];
      const refCells: RowCell[] = [];
      for (const i of SCENES) {
        const p1 = v1Profile?.scenes.find((s) => s.scene === i);
        const note1 = p1
          ? p1.ssrError
            ? `SSR error (v1 shipped this broken): ${p1.ssrError.slice(0, 60)}`
            : `diegetic ${p1.bestDiegetic ? `${p1.bestDiegetic.elements}el/${p1.bestDiegetic.textNodes}txt` : "none"} · depth ${p1.depth}`
          : "no v1 data";
        const v1Png = path.join(V1_DIR, `scene${i}.png`);
        const v1Exists = await fs.stat(v1Png).then(() => true).catch(() => false);
        v1Cells.push({ scene: i, ...(v1Exists ? { png: `../acceptance/scene${i}.png` } : {}), label: v1Labels[i] ?? `scene ${i}`, note: note1 });

        const pr = refProfile?.scenes.find((s) => s.scene === i);
        const noteR = pr
          ? `diegetic ${pr.bestDiegetic ? `${pr.bestDiegetic.elements}el/${pr.bestDiegetic.textNodes}txt` : "none"} · depth ${pr.depth}`
          : "no reference data";
        const refPng = path.join(V1_DIR, "reference", `scene${i}.png`);
        const refExists = await fs.stat(refPng).then(() => true).catch(() => false);
        refCells.push({ scene: i, ...(refExists ? { png: `../acceptance/reference/scene${i}.png` } : {}), label: refScript.scenes[i]?.label ?? `scene ${i}`, note: noteR });
      }

      const scene2Blueprint = script!.scenes[2]?.composition
        ? JSON.stringify(script!.scenes[2].composition, null, 2)
        : null;

      report.headline = [
        `brand ${BRAND} (ref ${REF_BUILD})`,
        `model ${model}`,
        `script SKIPPED (reference; hybrid-head decision)`,
        `DS ${ds.ok ? (ds.repaired ? "ok after 1 repair" : "ok first try") : "FELL BACK"}`,
        `blueprint ${compositionSummary.threw ? "HEAD THREW (un-composed)" : compositionSummary.validatedClean ? `validated on attempt ${compositionSummary.attempts}` : `TERMINAL after ${compositionSummary.attempts} attempts (${compositionSummary.residualErrors.length} residuals)`}`,
        `${gateRounds.length} gate round(s)`,
        `${gateRounds[gateRounds.length - 1]?.density.length ?? "?"} residual density finding(s)`,
        `${realCalls} real Cerebras calls`,
      ].join(" · ");
      await writeOut();
      await fs.writeFile(
        path.join(OUT_DIR, "index.html"),
        galleryHtml({
          report,
          rounds: gateRounds,
          compositionAttempts,
          compositionSummary,
          scene2Blueprint,
          sequenceFinal,
          v2Cells,
          v1Cells,
          refCells,
          v2Profile,
          v1Profile,
          refProfile,
          refDensityFindings,
        }),
        "utf8",
      );
    });

    // ── console summary ──────────────────────────────────────────────────────
    const wall = report.wall as { totalRunSeconds: number; compositionToPreviewSeconds: number | null };
    const cost = report.cost as { cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
    console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
    console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
    console.log(`genDir:  ${GEN_DIR}`);
    console.log(
      `composition→preview ${wall.compositionToPreviewSeconds}s · run total ${wall.totalRunSeconds}s · ` +
        `Cerebras ${realCalls} real calls $${cost.cerebras.usd.toFixed(4)} + vision ${zaiCalls} calls $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)}`,
    );
    console.log("\nPHASE TIMELINE:");
    for (const m of marks) console.log(`  ${m.phase.padEnd(26)} ${String(m.startS).padStart(7)}s → ${String(m.endS).padStart(7)}s  (${(m.endS - m.startS).toFixed(1)}s)`);
  } catch (err) {
    report.terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nTERMINAL: ${report.terminalError}`);
    await writeOut().catch(() => {});
    process.exitCode = 1;
  }
};

await main();
