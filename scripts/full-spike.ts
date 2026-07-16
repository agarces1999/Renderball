/**
 * FULL-PIPELINE SPIKE — the first complete brief→preview build where BOTH the
 * script and all generation run on Cerebras gpt-oss-120b, followed by the
 * ENTIRE production QA stack (structural gates → render-truth measurement →
 * vision QA) with bounded gate-triggered retries. Deliverable: the honest
 * end-to-end wall-clock number and the QA'd result.
 *
 *   set -a && source .env.local && set +a && node scripts/full-spike.mjs
 *
 * Pipeline (every phase wall-clock instrumented):
 *   1. BRIEF   — load the HubSpot brief from the store (Project whose scriptId
 *                is the 01KXEAF0… reference build). Crawl is CACHED on the
 *                brief (brand_extract) — live-crawl time (~15-30s) is excluded
 *                from this run and noted in the report.
 *   2. SCRIPT  — NEW script on gpt-oss using the production Agent-1 contract:
 *                the real SCRIPT_GENERATOR_SYSTEM_PROMPT + the real
 *                buildUserMessage() (text-only; no vision inputs exist in that
 *                path anyway). Validated with the production validator chain
 *                (normalize → backfill registers → validateScript → duration /
 *                ungrounded-claims / stage-label / type-only guards). ONE
 *                repair retry quoting the exact failure; else fall back to the
 *                reference script.json (recorded honestly).
 *   3. DESIGN  — one head call (adapted from scripts/model-bakeoff.mjs's
 *                HEAD_TASK, DS part only — see DESIGN DECISION below) emitting
 *                the CREATIVE consts (PALETTE / SHARED_KEYFRAMES /
 *                THROUGHLINE_TABS / ThroughlineMotif); deterministically
 *                templated into the reference preamble's non-creative
 *                boilerplate (SECTION_FRAME, Chrome, fonts, helpers) verbatim.
 *                CHOREO_CSS is re-compiled from the NEW script via the
 *                production choreographer (zero-token compile step).
 *   4. SCENES  — scene-parallel generation exactly like scripts/scene-spike.ts
 *                (5 whole-Section calls, effort low, 8k caps, one
 *                compile-repair each) against the NEW script + NEW preamble,
 *                with normalizeElementColors + the cast-spike
 *                keyframe-interpolation rewrite.
 *   5. GATES   — (a) the standalone-runnable structural validators
 *                assessStructuralGates composes (quality-gates.ts +
 *                finalize-refs.ts exports; assessContrast/findInventedClaims
 *                are pipeline-private and not runnable standalone — claims are
 *                gated at the script stage instead, same detector);
 *                (b) render-truth: measureScenes → findRenderTruthFailures
 *                with the production BLOCKING_KINDS + brandBackground +
 *                registers (run-preview-build.ts wiring, verbatim);
 *                (c) vision QA: the production rubric (buildRubric) judged by
 *                GLM vision via callZaiVision on the NATIVE endpoint —
 *                per-scene verdicts, sanctioned-chrome findings dropped
 *                post-hoc exactly as production does; plus the text-only
 *                brand-color fidelity backstop (advisory).
 *   6. RETRIES — per scene with BLOCKING findings (structural, render-truth
 *                blocking, or vision issues matching the pipeline's SEVERE_RX
 *                action threshold): regenerate THAT scene, one call with the
 *                failure feedback appended verbatim, max 2 rounds per scene,
 *                re-measure after each round. Runaway guard: hard ceiling of
 *                40 total Cerebras calls.
 *   7. REPORT  — .data/full-spike/build-report.json + index.html (final QA'd
 *                row vs the reference row, phase-timeline bar, gate log).
 *
 * DESIGN DECISION (script + DS as TWO head calls, not one merged call):
 * the bake-off's merged HEAD_TASK was a throughput probe. Here the script must
 * pass the production validator chain with a repair retry quoting the exact
 * error — merging TSX into that response would force the schema-repair path to
 * re-emit the design system too (more failure surface, muddier validation),
 * and the DS call benefits from receiving the VALIDATED script (its motif is
 * designed for the throughline that actually shipped, not one that may have
 * been repaired away). Both calls run effort "high" — the doctrine's "think at
 * the head" is preserved; it just thinks twice at the head, ~10-30s each.
 *
 * Footprint: this file + scripts/full-spike.mjs + .data/full-spike/ +
 * src/generated/CAST_SPIKE_FULL_HUBSPOT/. Reads everything, modifies nothing.
 */
import { promises as fs } from "fs";
import path from "path";
import * as esbuild from "esbuild";
import { castCall, castConfigured, type CastResult } from "../lib/llm/cast-provider";
import { normalizeElementColors } from "../lib/agents/normalize-element";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
import { measureScenes, type SceneMeasurement } from "../lib/render/measure-scene";
import {
  findRenderTruthFailures,
  type RenderTruthFinding,
  type RenderTruthKind,
} from "../lib/render/render-truth-gates";
import {
  buildRubric,
  parseVerdict,
  isSanctionedChromeFinding,
  checkBrandColorFidelity,
} from "../lib/render/vision-gate";
import { callZaiVision, callZaiText } from "../lib/render/zai-vision";
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
} from "../lib/agents/schema-validator";
import {
  CHOREO_KEYFRAMES,
  fieldsOf,
  scheduleScene,
  buildSceneCss,
  type MotionSignal,
} from "../lib/agents/choreograph";
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
import { assessInvalidLucideImports } from "../lib/agents/finalize-refs";
import { sectionRanges } from "../lib/agents/section-splice";
import { loadBriefByScriptId, DEV_OWNER_ID, type StoredBrief } from "../lib/store";
import { withDbRetry } from "../lib/db";
import { ulid } from "../lib/ulid";
import type { Manifest } from "../lib/agents/lego-store";

// ── constants ────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const REF_BUILD = "01KXEAF0SNT0RR079Z1SJZ1KWZ";
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "full-spike");
const GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_FULL_HUBSPOT");
const SCENES = [0, 1, 2, 3, 4];
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

// Cerebras caps are pre-debited against the TPM bucket — keep them honest.
const SCENE_MAX_TOKENS = 8000; // scene-spike's validated whole-Section cap
const SCENE_EFFORT = "low" as const; // emit at the leaves
const SCRIPT_MAX_TOKENS = 16000; // production Agent-1 max_tokens
const HEAD_EFFORT = "high" as const; // think at the head
const DS_MAX_TOKENS = 10000;

// Runaway guard (spike guardrail): abort generation retries past this.
const CALL_CEILING = 40;
const MAX_RETRY_ROUNDS_PER_SCENE = 2;

// Projected pricing ($/M tokens): gpt-oss-120b on Cerebras (scene-spike's nums).
const USD_PER_M_IN = 0.35;
const USD_PER_M_OUT = 0.75;

// The production blocking set — copied verbatim from run-preview-build.ts.
const BLOCKING_KINDS: RenderTruthKind[] = [
  "overflow", "measure-error", "barbell", "cross-piece-overlap", "canvas-brightness", "stranded-hero",
];
// The pipeline's vision action threshold — SEVERE_RX verbatim from
// run-preview-build.ts (issues matching it drive the vision-loop regen).
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
interface CallLogRow { label: string; secs: number; in: number; out: number; stop: string | null }
const callLog: CallLogRow[] = [];
let cerebrasCalls = 0;
let cerebrasIn = 0;
let cerebrasOut = 0;

const cast = async (
  label: string,
  args: { system: string; user: string; maxTokens: number; effort: "low" | "high" },
): Promise<CastResult> => {
  if (cerebrasCalls >= CALL_CEILING) {
    throw new BudgetExceeded(`call ceiling (${CALL_CEILING}) reached at "${label}" — runaway guard`);
  }
  cerebrasCalls += 1;
  const r = await castCall(args);
  cerebrasIn += r.inputTokens;
  cerebrasOut += r.outputTokens;
  callLog.push({ label, secs: r.seconds, in: r.inputTokens, out: r.outputTokens, stop: r.stopReason });
  return r;
};

// z.ai vision spend (the QA side of the cost split).
let zaiUsage: Usage = { ...EMPTY_USAGE };
let zaiCalls = 0;

// ── small utilities ──────────────────────────────────────────────────────────

// Same elision model-bakeoff.mjs / scene-spike.ts use: base64 font payloads are
// noise to the model — family names and every const stay visible.
const elide = (s: string): string => s.replace(/data:[a-zA-Z0-9/+;=,._-]{200,}/g, "data:ELIDED");

/** Brand hexes from the preamble's PALETTE block (scene-spike's parser). */
const extractPalette = (preamble: string): string[] => {
  const start = preamble.indexOf("const PALETTE");
  if (start === -1) return [];
  const close = preamble.indexOf("}", start);
  const block = preamble.slice(start, close === -1 ? start + 2000 : close);
  return [...new Set(block.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [])];
};

/**
 * Locate a top-level `const NAME = …;` declaration with a balanced scanner
 * (strings, template literals incl. ${} nesting, comments, all bracket kinds).
 * Used both to slice the reference preamble's creative consts and to parse the
 * DS head call's emission.
 */
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

const replaceConstDecl = (src: string, name: string, replacement: string): string | null => {
  const loc = findConstDecl(src, name);
  if (!loc) return null;
  return src.slice(0, loc.start) + replacement + src.slice(loc.end);
};

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

// SPIKE-SIDE repair copied from scripts/cast-spike.ts (its run-1 finding):
// gpt-oss generalizes the palette-const pattern to shared @keyframes names and
// writes `animation: \`${fadeRise} …\`` — parses, throws ReferenceError at
// render. Deterministic rewrite: `${name}` → literal CSS name for names
// declared in the composition's own @keyframes.
const repairKeyframeInterpolations = (
  code: string,
): { code: string; rewrites: number; byName: Record<string, number> } => {
  const names = new Set(
    [...code.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]),
  );
  let rewrites = 0;
  const byName: Record<string, number> = {};
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue;
    code = code.replace(new RegExp(`\\$\\{\\s*${n}\\s*\\}`, "g"), () => {
      rewrites++;
      byName[n] = (byName[n] ?? 0) + 1;
      return n;
    });
  }
  return { code, rewrites, byName };
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── loose script shape (the validated Script is structurally richer) ─────────

interface ScriptScene {
  index?: number;
  label: string;
  register?: string;
  description?: string;
  visual_concept?: string;
  start_seconds?: number;
  end_seconds?: number;
  content: Record<string, unknown>;
}
interface LooseScript {
  scenes: ScriptScene[];
  narrative?: { throughline?: string; arc?: string; logline?: string };
  config?: { aspect_ratio?: string; duration_seconds?: number };
  brief?: { about?: string; purpose?: string; cta?: string };
  assets?: unknown;
}

// ── PHASE 2: script on gpt-oss (production Agent-1 contract) ─────────────────

// Replicates script-generator.ts's private injectIdentity (the identity fields
// validateScript's consumers expect) — module-private there, so copied.
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

/** The full production post-parse chain + guards. Returns the validated script
 *  or the exact failure text (fed back verbatim on the repair retry). */
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
  // Scene-count contract for THIS spike's composition tail (Section0..4).
  if (script.scenes.length !== 5) {
    return { ok: false, error: `Script has ${script.scenes.length} scenes but the brief requires EXACTLY 5 sections (one per moment).` };
  }
  // Invented-claim + stage-label guards (production, QA S5/G5).
  const sourceText = claimGroundingSources(brief);
  const copy = sceneClaimCopy(script.scenes);
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

// ── PHASE 3: design system head call + deterministic preamble templating ─────

const DS_DECLS = ["PALETTE", "SHARED_KEYFRAMES", "THROUGHLINE_TABS", "ThroughlineMotif"] as const;
// Keyframe names the reference preamble's NON-creative helpers reference — a
// swapped SHARED_KEYFRAMES must keep them resolvable, so any the head call
// omits are merged back in deterministically from the reference block.
const REQUIRED_KEYFRAMES = ["glowBreathe", "drift1", "drift2", "drift3", "drawWidth", "fadeRise", "scaleIn"];

const dsSystemPrompt = `You are the creative director designing the SHARED DESIGN SYSTEM for one 30-second animated brand video (1920x1080, 5 scenes). Downstream, five scene-builder calls will reference your consts EXACTLY as you define them — this is the video's entire visual grammar, so make it rich, coherent, and unmistakably on-brand.

OUTPUT CONTRACT — emit ONLY a TSX block containing EXACTLY these four top-level declarations, in this order, nothing before/between/after (no imports, no prose, no markdown fences):

1. \`const PALETTE = { canvas: "#……", ink: "#……", accent: "#……", muted: "#……", softNeutral: "#……", cardFill: "#……", white: "#ffffff" } as const;\`
   — EXACTLY those seven keys. Every value is a 6-digit hex grounded in the brand truth you are given (canvas MUST be the stated brand canvas; accent MUST be the stated signature color). Never invent off-brand hues.
2. \`const SHARED_KEYFRAMES = \\\`…\\\`;\` — a CSS template literal defining ALL shared @keyframes: (a) the throughline-motif keyframes your component below uses; (b) entry keyframes (≤1s class); (c) 6-10 sustained/infinite loops for atmosphere and diegetic life; (d) it MUST include definitions named exactly: glowBreathe, drift1, drift2, drift3, drawWidth, fadeRise, scaleIn (shared helpers depend on those names). Plain CSS only — NO \${…} interpolations.
3. \`const THROUGHLINE_TABS = [ … ];\` — 5-7 data objects driving the motif's scattered phase: { label: string, angle: number, dx: number, dy: number, color: "#……", dur: number, delay: number }. Labels/geometry must fit YOUR motif concept; colors from PALETTE's hexes.
4. \`const ThroughlineMotif: React.FC<{ phase: "chaos" | "converge" | "unified" }> = ({ phase }) => { … };\` — the ONE recurring visual motif, built from the narrative throughline you are given. HARD RULES: root element is \`<div data-throughline="<short-slug>" style={{ position: "absolute", left: 1360, top: 540, width: 0, height: 0, pointerEvents: "none", zIndex: 6 }}>\`; three visually distinct phases (chaos = scattered/drifting, converge = pulling inward, unified = locked/resolved); CSS animation only using names from YOUR SHARED_KEYFRAMES; reference PALETTE.* / FONT_DISPLAY / FONT_BODY / FONT_MONO (already in scope) — never invent colors or fonts; no hooks, no Math.random, no Date.now; valid TSX.

The following are ALREADY DEFINED and in scope — do NOT redefine them: React, FONT_DISPLAY, FONT_BODY, FONT_MONO, LOGO_SRC, Img, Piece, BrandChrome.`;

const dsUserPrompt = (script: LooseScript, be: AgentBrandExtract | undefined): string => {
  const canvas = resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]);
  const signature = signatureWithLogoFallback(be?.palette ?? [], be?.theme_color, be?.logo_color) ?? be?.theme_color ?? "#ff7a59";
  return [
    `Design the shared design system for this video.`,
    ``,
    `BRAND TRUTH (crawled from ${be?.url ?? "the brand site"} — authoritative):`,
    `- Brand: ${be?.title ?? "HubSpot"}`,
    `- Canvas/background (ENFORCED): ${canvas.background} (a ${canvas.mode} canvas — PALETTE.canvas MUST be this hex)`,
    `- SIGNATURE accent (PALETTE.accent MUST be this hex): ${signature}`,
    `- Full brand palette: ${(be?.palette ?? []).join(", ")}`,
    `- Fonts (locked, already defined — design WITH them, do not redefine): display "HubSpot Serif", body "HubSpot Sans"`,
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

/** Parse the DS emission, enforce the contract, merge missing required
 *  keyframes from the reference block. */
const parseDsEmission = (raw: string, refKeyframesCss: string): DsParse => {
  const text = stripCodeFence(raw.trim());
  const decls = {} as Record<(typeof DS_DECLS)[number], string>;
  for (const name of DS_DECLS) {
    const loc = findConstDecl(text, name);
    if (!loc) return { ok: false, error: `missing top-level declaration \`const ${name}\` — the output must contain exactly the four contract declarations` };
    decls[name] = text.slice(loc.start, loc.end).replace(/^export /, "");
  }
  // PALETTE key contract (boilerplate references these members).
  for (const key of ["canvas", "ink", "accent", "muted", "softNeutral", "cardFill", "white"]) {
    if (!new RegExp(`\\b${key}\\s*:`).test(decls.PALETTE)) {
      return { ok: false, error: `PALETTE is missing the required key "${key}" — it must have exactly the seven contract keys` };
    }
  }
  if (!/data-throughline=/.test(decls.ThroughlineMotif)) {
    return { ok: false, error: `ThroughlineMotif's root element must carry data-throughline="<slug>" (the assemble/choreography contract)` };
  }
  // Merge required keyframes the model omitted (deterministic, from reference).
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

/** Swap the creative consts into the reference preamble (boilerplate verbatim). */
const templatePreamble = (
  refPreamble: string,
  decls: Record<(typeof DS_DECLS)[number], string>,
): string | null => {
  let out: string | null = refPreamble;
  for (const name of DS_DECLS) {
    out = replaceConstDecl(out!, name, decls[name]);
    if (out === null) return null;
  }
  return out;
};

/** Re-compile CHOREO_CSS from the NEW script — the production zero-token
 *  choreography step (choreograph.ts), spliced over the reference const. */
const templateChoreography = (preamble: string, script: LooseScript, signal: MotionSignal): string | null => {
  const lastScene = script.scenes.length - 1;
  const parts: string[] = [CHOREO_KEYFRAMES];
  for (let i = 0; i < script.scenes.length; i++) {
    const s = script.scenes[i];
    const T = typeof s.start_seconds === "number" && typeof s.end_seconds === "number" ? s.end_seconds - s.start_seconds : 0;
    parts.push(buildSceneCss(i, scheduleScene(fieldsOf(s.content), T, signal, { exits: i < lastScene }), signal));
  }
  const decl = `const CHOREO_CSS = \`\n${parts.join("\n")}\n\`;`;
  return replaceConstDecl(preamble, "CHOREO_CSS", decl);
};

// ── PHASE 4: scene generation (scripts/scene-spike.ts machinery, verbatim) ───
// scene-spike.ts executes its main() at module load, so its prompt + helpers
// are copied here rather than imported. Contract text is UNCHANGED.

const sceneSystemPrompt = (preamble: string): string => `You BUILD one complete scene ("Section") of a 30-second animated brand video (1920x1080) as a SINGLE self-contained React component.

You are given the video's shared design system — a TSX module preamble whose consts and components are ALREADY IN SCOPE where your code is inlined — and the brief for ONE scene. Emit the complete Section component for that scene.

HARD RULES — the output contract:
- Output ONLY TSX — no imports, no prose, no markdown fences, nothing before or after the component.
- Export EXACTLY \`export const Section{N}: React.FC<{ script: Script }> = ({ script }) => { … }\` for the scene index N you are given. Read copy via \`const c = script.scenes[N].content;\`.
- Root element: \`<div data-scene={N} style={{ animation: "choreoAmbient 8s ease-in-out infinite", ...SECTION_FRAME, background: PALETTE.canvas, fontFamily: FONT_BODY }}>\`.
- Its FIRST child is the style mount: \`<style dangerouslySetInnerHTML={{ __html: CHOREO_CSS + BRAND_FONTS_CSS + "\\n" + SHARED_KEYFRAMES }} />\`. You MAY append scene-specific @keyframes to that string (+ \`…\`) — never redefine a shared keyframe name.
- Reference the preamble consts/components (PALETTE.*, FONT_DISPLAY/BODY/MONO, LOGO_SRC, SECTION_FRAME, Chrome, LogoMark, ThroughlineMotif, THROUGHLINE_TABS, GrainOverlay, RadialGlow, DriftDot, Eyebrow, AccentBar, GlassCard, BrowserTabCard, Piece, Img, the shared @keyframes names) EXACTLY as defined. NEVER invent colors, fonts, or redefine preamble consts.
- Composition is absolutely positioned inside the 1920x1080 frame: every major block places itself with explicit left/top/width (px). No top-level flow layout.
- Wrap EVERY major element in a \`<Piece id="s{N}.<role>" kind="<kind>">…</Piece>\` marker (it renders display:contents — zero layout cost). Kinds: "atmosphere" (full-bleed decorative layer), "text" (the copy stack), "diegetic" (hero visual / product mock), "image" (logo/photo), "chrome" (the bottom brand bar). A scene has 4-5 pieces: one atmosphere, one text, one or two diegetic/image, one chrome. Role names are short slugs (atmos, copy, tabs, app, logo, chrome, …).
- COPY IS VERBATIM: render every provided copy field exactly as given, read from \`c.*\`, and tag the element that renders it with data-content-path using DOT-form paths: "eyebrow", "headline", "lede", "bullets.0", "bullets.1", …, "caption", "cta.primary", "cta.secondary". Example: \`<span data-content-path="bullets.0">{c.bullets[0]}</span>\`. Never invent numbers or claims.
- Emit the brand chrome inside the chrome piece: \`<Chrome sceneIndex={N} />\` (plus its props where the brief calls for them).
- The narrative throughline motif MUST appear in the scene, anchored at (left 1360, top 540), inside a \`<div data-throughline="…">\` wrapper. The preamble's \`<ThroughlineMotif phase="chaos" | "converge" | "unified" />\` does exactly this — pick the phase that fits this scene's story beat, or build a variation on THROUGHLINE_TABS keeping the anchor + data-throughline wrapper.
- Animation: CSS only — animation/@keyframes with seconds-based delays/durations from the brief's Animations spec, "both" fill for entrances. No Remotion hooks, no useState/useEffect, no Math.random, no Date.now.
- Rich, dense, production-grade — a premium brand-video frame, not a wireframe: layered atmosphere (glow, grain, drift), editorial copy hierarchy, a concrete detailed hero visual.
- Valid TSX that compiles as a module-level statement: balanced tags, nothing after the component's closing \`};\`.

SHARED DESIGN SYSTEM (in scope at inline time; base64 font payloads elided here for brevity — the real consts are complete):
\`\`\`tsx
${preamble}
\`\`\``;

/** Verbatim copy fields as tagged lines (scene-spike's copyLines). */
const copyLines = (c: Record<string, unknown>): string => {
  const out: string[] = [];
  const push = (path_: string, v: unknown) => {
    if (typeof v === "string" && v) out.push(`${path_}: ${JSON.stringify(v)} (data-content-path="${path_}")`);
  };
  push("eyebrow", c.eyebrow);
  push("headline", c.headline);
  push("lede", c.lede);
  if (Array.isArray(c.bullets)) c.bullets.forEach((b, i) => push(`bullets.${i}`, b));
  push("caption", c.caption);
  const cta = c.cta as { primary?: string; secondary?: string } | undefined;
  if (cta) {
    push("cta.primary", cta.primary);
    push("cta.secondary", cta.secondary);
  }
  if (typeof c.illustration === "string" && c.illustration)
    out.push(`illustration hint (a visual to build, NOT copy to render as text): "${c.illustration}"`);
  return out.join("\n");
};

const MOTIF_PHASE = ["chaos", "chaos", "converge", "unified", "unified"];

const sceneUserPrompt = (script: LooseScript, i: number): string => {
  const s = script.scenes[i];
  return [
    `BUILD Section${i} — scene ${i} of 5, "${s.label}", register ${s.register ?? "n/a"}, ${s.start_seconds ?? "?"}s-${s.end_seconds ?? "?"}s of the video.`,
    ``,
    `Scene intent: ${s.description ?? s.label}`,
    ``,
    `Visual concept (follow the composition and its Animations spec):`,
    String(s.visual_concept ?? ""),
    ``,
    `SCENE COPY (verbatim, tagged with data-content-path):`,
    copyLines(s.content) || "(no copy fields — visual scene)",
    ``,
    `NARRATIVE THROUGHLINE (the recurring motif across all 5 scenes): ${script.narrative?.throughline ?? ""}`,
    `Story position for the motif in THIS scene: phase "${MOTIF_PHASE[i]}".`,
    ``,
    `Emit ONLY the complete \`export const Section${i}\` component.`,
  ].join("\n");
};

const compileRepairPrompt = (i: number, code: string, error: string): string => [
  `Your Section${i} component failed to compile when inlined after the design-system preamble.`,
  ``,
  `COMPILER ERROR:`,
  error,
  ``,
  `THE CODE YOU EMITTED:`,
  "```tsx",
  code,
  "```",
  ``,
  `Fix ONLY what is needed to compile — keep the design, layout, and copy identical.`,
  `Emit ONLY the corrected complete \`export const Section${i}\` component — no prose, no fences.`,
].join("\n");

/** Syntax + contract probe for one emitted Section (scene-spike's). */
const sectionError = async (i: number, code: string): Promise<string | null> => {
  if (!new RegExp(`export\\s+const\\s+Section${i}\\b`).test(code))
    return `missing \`export const Section${i}\` — the component must be exported under exactly that name`;
  try {
    await esbuild.transform(code, { loader: "tsx", jsx: "automatic", logLevel: "silent" });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n").slice(0, 6).join("\n") : String(err);
  }
};

/** Loudly-labeled placeholder Section (scene-spike's honest failure surface). */
const placeholderSection = (i: number, reason: string): string => {
  const label = `Section${i} PLACEHOLDER — ${reason.split("\n")[0].slice(0, 160)}`;
  return [
    `export const Section${i}: React.FC<{ script: Script }> = () => (`,
    `  <div data-scene={${i}} style={{ ...SECTION_FRAME, background: PALETTE.canvas }}>`,
    `    <div style={{ position: "absolute", left: 40, top: 40, right: 40, bottom: 40, boxSizing: "border-box", border: "4px dashed #e0245e", background: "rgba(224,36,94,0.05)" }}>`,
    `      <div style={{ position: "absolute", left: 24, top: 24, maxWidth: 1700, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 26, fontWeight: 700, color: "#ffffff", background: "#e0245e", padding: "10px 18px", borderRadius: 6 }}>{${JSON.stringify(label)}}</div>`,
    `    </div>`,
    `  </div>`,
    `);`,
  ].join("\n");
};

interface SceneGen {
  scene: number;
  code: string;
  ok: boolean;
  placeholder: boolean;
  repaired: boolean;
  secs: number;
  outputTokens: number;
  hueLocked: number;
  failReason?: string;
}

/** One whole-Section call + one compile repair; hue-lock on success. */
const generateSection = async (
  label: string,
  system: string,
  user: string,
  i: number,
  palette: string[],
): Promise<SceneGen> => {
  const t0 = Date.now();
  const gen: SceneGen = { scene: i, code: "", ok: false, placeholder: false, repaired: false, secs: 0, outputTokens: 0, hueLocked: 0 };
  try {
    const first = await cast(label, { system, user, maxTokens: SCENE_MAX_TOKENS, effort: SCENE_EFFORT });
    gen.outputTokens += first.outputTokens;
    let code = stripCodeFence(first.text);
    let err = await sectionError(i, code);
    if (err !== null) {
      console.warn(`  scene ${i}: compile fail — repairing (${err.split("\n")[0]})`);
      const fix = await cast(`${label}-compile-repair`, { system, user: compileRepairPrompt(i, code, err), maxTokens: SCENE_MAX_TOKENS, effort: SCENE_EFFORT });
      gen.outputTokens += fix.outputTokens;
      gen.repaired = true;
      const fixed = stripCodeFence(fix.text);
      const err2 = await sectionError(i, fixed);
      if (err2 === null) {
        code = fixed;
        err = null;
      } else {
        gen.failReason = `after repair: ${err2.split("\n")[0]}`;
      }
    }
    if (err === null) {
      gen.ok = true;
      if (palette.length > 0) {
        const norm = normalizeElementColors(code, palette);
        code = norm.code;
        gen.hueLocked = norm.changes.reduce((n, c) => n + c.count, 0);
      }
      gen.code = code;
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    gen.failReason = `call failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`;
  }
  if (!gen.ok) {
    gen.code = placeholderSection(i, gen.failReason ?? "unknown failure");
    gen.placeholder = true;
  }
  gen.secs = (Date.now() - t0) / 1000;
  return gen;
};

// ── PHASE 5a: structural gates (the standalone-runnable production set) ──────

interface StructuralFinding {
  scene: number; // -1 = composition-level / unattributable (logged, not retried)
  key: string;
  detail: string;
}

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
      out.push({ scene, key: "provided_component_redefined", detail: `${name} is a PROVIDED component — import/configure it via props; DELETE your own definition (re-creating provided components is rejected).` });
  }
  for (const p of findPlaceholderData(composition)) {
    out.push({ scene: p.section, key: "placeholder_data", detail: `Placeholder/unresolved data on screen: ${p.token} (…${p.context}…). Every price, stat, and label must be a CONCRETE literal.` });
  }
  for (const icon of assessInvalidLucideImports(composition)) {
    for (const scene of attributed(`<${icon}`))
      out.push({ scene, key: "invalid_lucide_imports", detail: `Invalid lucide-react import — ${icon} is a brand/company logo that DOES NOT EXIST in lucide-react and will crash the render. Use a neutral Lucide icon or simple-icons.` });
  }
  for (const tag of findUndefinedJsxComponents(composition)) {
    for (const scene of attributed(`<${tag}`))
      out.push({ scene, key: "undefined_jsx_components", detail: `Undefined JSX component <${tag}> — rendered but never defined in scope and never imported; resolves to undefined at runtime → "Element type is invalid" white screen. Replace it with an existing preamble component or plain elements.` });
  }
  for (const u of findUnboundCopy(composition, (script.scenes ?? []) as never)) {
    out.push({ scene: u.scene, key: "unbound_copy", detail: `Baked-in script copy — scene ${u.scene} ${u.field} ("${u.excerpt}") is retyped as literal JSX. Bind content ONCE (const c = script.scenes[N].content) and render every field as an expression: {c.${u.field}}.` });
  }
  const aspect = (script.config?.aspect_ratio ?? "16:9") as AspectRatio;
  for (const w of findOverflowingElements(composition, aspect)) {
    for (const scene of attributed(String(w)))
      out.push({ scene, key: "overflow_crop", detail: `Off-canvas crop — element with width ${w}px crosses the ${aspect} canvas edge (left+width spills past the frame). Cap primary elements at ≤1760px and keep left+width inside the frame.` });
  }
  const logoCount = findDuplicateLogos(composition);
  if (logoCount > 1 && !hasCornerLogoSuppression(composition)) {
    const re = /<Img\b[^>]*\bsrc=\{?\s*["'`]?[^}"'`>\s]*logo/i;
    const hits = ranges.filter((r) => re.test(composition.slice(r.start, r.end))).map((r) => r.index);
    for (const scene of hits.length > 0 ? hits : [-1])
      out.push({ scene, key: "duplicate_logo", detail: `Duplicate brand logo — the logo image appears at ${logoCount} sites. Chrome already carries the brand mark on every scene; remove the scene-level logo <Img>, or pass showCornerLogo={false} to Chrome for a deliberate logo-led scene.` });
  }
  return out;
};

// ── PHASE 5c: vision QA (production rubric + native-endpoint judge) ──────────

interface SceneVisionVerdict {
  scene: number;
  ok: boolean;
  issues: string[];
  actionable: string[]; // sanctioned-chrome findings dropped (production post-hoc)
  severe: string[]; // the pipeline's action threshold (SEVERE_RX)
  error?: string;
}

const runVisionRound = async (
  measurements: SceneMeasurement[],
  script: LooseScript,
  be: AgentBrandExtract | undefined,
): Promise<SceneVisionVerdict[]> => {
  const brandTruth = {
    name: be?.title,
    backgroundColor: resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]).background,
    accent: be?.logo_color ?? be?.palette?.[0],
    fonts: [be?.font_roles?.display, be?.font_roles?.body].filter((f): f is string => !!f),
  };
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
  for (const [k, r] of judged.entries()) {
    if (r.status === "fulfilled") out.push(r.value);
    else out.push({ scene: measurements.filter((m) => m.screenshotPath)[k]?.scene ?? -1, ok: true, issues: [], actionable: [], severe: [], error: String(r.reason).slice(0, 200) });
  }
  return out.sort((a, b) => a.scene - b.scene);
};

// ── report + gallery ─────────────────────────────────────────────────────────

interface RetryLogRow {
  scene: number;
  round: number;
  feedback: string[];
  secs: number;
  outputTokens: number;
  compiled: boolean;
  adopted: boolean;
  note?: string;
}

interface GateRound {
  round: number;
  structural: StructuralFinding[];
  renderTruthAll: RenderTruthFinding[];
  renderTruthBlocking: RenderTruthFinding[];
  vision: SceneVisionVerdict[];
  failingScenes: number[];
  retriedScenes: number[];
  durations: { structuralS: number; measureS: number; renderTruthS: number; visionS: number };
}

const galleryHtml = (report: Record<string, unknown>, rounds: GateRound[], perScene: { scene: number; png?: string; label: string; note: string }[]): string => {
  const cost = report.cost as { cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
  const wall = report.wall as { totalRunSeconds: number; scriptToPreviewSeconds: number };
  const cells = perScene
    .map((s) => {
      const visual = s.png
        ? `<a href="${s.png}" target="_blank"><img src="${s.png}" alt="scene ${s.scene}"></a>`
        : `<div class="err">NO RENDER</div>`;
      return `<div class="cell"><div class="cell-title">scene ${s.scene} — ${esc(s.label)}</div>${visual}<div class="stat">${esc(s.note)}</div></div>`;
    })
    .join("\n");
  const refCells = SCENES.map(
    (i) => `<div class="cell"><div class="cell-title">reference scene ${i} (production GLM build)</div><a href="../cast-spike/reference/scene${i}.png" target="_blank"><img src="../cast-spike/reference/scene${i}.png" alt="ref ${i}"></a></div>`,
  ).join("\n");
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
  const gateLog = rounds
    .map((r) => {
      const rows: string[] = [];
      for (const f of r.structural) rows.push(`<li><b>structural/${esc(f.key)}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const f of r.renderTruthAll) rows.push(`<li><b>render-truth/${esc(f.kind)}${r.renderTruthBlocking.includes(f) ? " (BLOCKING)" : " (advisory)"}</b> scene ${f.scene}: ${esc(f.detail.slice(0, 220))}</li>`);
      for (const v of r.vision) {
        if (v.error) rows.push(`<li><b>vision</b> scene ${v.scene}: judge error — ${esc(v.error)}</li>`);
        else if (v.actionable.length === 0) rows.push(`<li><b>vision</b> scene ${v.scene}: CLEAN${v.issues.length ? ` (sanctioned-chrome findings dropped: ${v.issues.length})` : ""}</li>`);
        else for (const issue of v.actionable) rows.push(`<li><b>vision${v.severe.includes(issue) ? " (SEVERE)" : ""}</b> scene ${v.scene}: ${esc(issue.slice(0, 220))}</li>`);
      }
      return `<h3>gate round ${r.round} — failing scenes: [${r.failingScenes.join(", ") || "none"}] → retried: [${r.retriedScenes.join(", ") || "none"}]</h3><ul>${rows.join("\n") || "<li>all clean</li>"}</ul>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Full-pipeline spike — brief→preview on Cerebras + full production QA</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; }
  h2 { font-size: 15px; font-weight: 700; margin: 26px 0 10px; color: #c9cad1; }
  h3 { font-size: 12px; font-family: ui-monospace, Menlo, monospace; margin: 14px 0 6px; color: #a9aab3; }
  .sub { font-family: ui-monospace, Menlo, monospace; color: #9a9aa3; margin: 8px 0 8px; font-size: 12px; }
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
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 1100px; }
</style>
</head>
<body>
  <h1>Full-pipeline spike — brief→preview entirely on Cerebras gpt-oss-120b, gated by the full production QA stack</h1>
  <div class="sub">${esc(String(report.headline ?? ""))}</div>
  <div class="sub">script→preview wall <b>${wall.scriptToPreviewSeconds.toFixed(1)}s</b> · run total ${wall.totalRunSeconds.toFixed(1)}s · cost: Cerebras $${cost.cerebras.usd.toFixed(4)} + z.ai vision $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)} · live-crawl (~15-30s) excluded (cached brand_extract)</div>

  <h2>Phase timeline</h2>
  <div class="timeline">${bars}</div>
  <div>${legend}</div>

  <h2>Final QA'd row (this spike)</h2>
  <div class="row">
${cells}
  </div>

  <h2>Reference row — the production GLM build (same brief)</h2>
  <div class="row">
${refCells}
  </div>

  <h2>Gate log</h2>
  ${gateLog}

  <div class="foot">
    Script (Agent-1 contract, effort high, 16k cap) + design system (head call, effort high) + 5 parallel whole-Section
    calls (effort low, 8k caps, one compile-repair each) — all on Cerebras gpt-oss-120b — then the production gate stack:
    standalone structural validators, render-truth measurement (production BLOCKING_KINDS), and the production vision
    rubric on GLM vision (native z.ai endpoint). Scenes failing a blocking gate or the vision SEVERE threshold were
    regenerated with the gate feedback appended verbatim, max ${MAX_RETRY_ROUNDS_PER_SCENE} rounds per scene, hard ceiling ${CALL_CEILING} Cerebras calls.
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/full-spike.mjs");
    process.exitCode = 1;
    return;
  }
  const model = process.env.RB_CAST_MODEL || "gpt-oss-120b";
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Mutable report skeleton — written on EVERY exit path (partial evidence
  // beats none, per the spike guardrails).
  const report: Record<string, unknown> = {
    experiment: "full-pipeline: brief→script→design-system→scenes on Cerebras gpt-oss-120b + full production QA stack with bounded retries",
    ref: REF_BUILD,
    model,
    generatedAt: new Date().toISOString(),
    crawlNote: "brand_extract was CACHED on the brief — live-crawl time (~15-30s) is excluded from every wall number here",
    terminalError: null,
  };
  const gateRounds: GateRound[] = [];
  const retryLog: RetryLogRow[] = [];
  let script: LooseScript | null = null;
  let finalMeasurements: SceneMeasurement[] = [];
  let sections: string[] = [];
  let compositionChars = 0;
  let compositionCompileError: string | null = null;
  let sceneStats: SceneGen[] = [];
  let scriptToPreviewEndS: number | null = null;
  let scriptStartS: number | null = null;

  const writeOut = async (): Promise<void> => {
    const cerebrasUsd = (cerebrasIn * USD_PER_M_IN + cerebrasOut * USD_PER_M_OUT) / 1e6;
    const zaiUsd = costUsd(VISION_MODEL, zaiUsage);
    report.phases = marks;
    report.gates = gateRounds;
    report.retries = retryLog;
    report.calls = callLog;
    report.budget = { cerebrasCalls, ceiling: CALL_CEILING };
    report.cost = {
      cerebras: { calls: cerebrasCalls, inputTokens: cerebrasIn, outputTokens: cerebrasOut, usdPerMIn: USD_PER_M_IN, usdPerMOut: USD_PER_M_OUT, usd: cerebrasUsd },
      zaiVision: { calls: zaiCalls, inputTokens: zaiUsage.input_tokens, outputTokens: zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
      totalUsd: cerebrasUsd + zaiUsd,
    };
    report.wall = {
      totalRunSeconds: nowS(),
      scriptToPreviewSeconds:
        scriptStartS !== null && scriptToPreviewEndS !== null ? Math.round((scriptToPreviewEndS - scriptStartS) * 10) / 10 : null,
    };
    report.final = {
      compositionChars,
      compositionCompileError,
      genDir: GEN_DIR,
    };
    await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  };

  try {
    // ── inputs: reference manifest (preamble boilerplate + tail) + fallback ──
    const manifest: Manifest = JSON.parse(await fs.readFile(path.join(REF_DIR, "lego", "manifest.json"), "utf8"));
    const refScript: LooseScript = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));

    // ── PHASE 1: brief from the store ────────────────────────────────────────
    const stored = await phase("brief-load", async (): Promise<StoredBrief> => {
      const b = await withDbRetry(() => loadBriefByScriptId(REF_BUILD, DEV_OWNER_ID));
      if (!b) throw new Error(`no Project row found for scriptId ${REF_BUILD}`);
      console.log(`  brief ${b.id} (owner ${b.owner_id}) — ${b.brand_kit_url}, brand_extract.ok=${b.brand_extract?.ok}`);
      return b;
    });
    const be = stored.brand_extract as unknown as AgentBrandExtract | undefined;
    report.brief = {
      projectId: stored.id,
      url: stored.brand_kit_url,
      brandExtractCached: !!be?.ok,
      canvasPlan: resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]),
    };

    // ── canary (proves transport + key + model before any real spend) ────────
    await phase("canary", async () => {
      const c = await cast("canary", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, effort: SCENE_EFFORT });
      console.log(`  canary ok — ${c.seconds.toFixed(1)}s, ${c.outputTokens} tok out, stop=${c.stopReason}`);
    });

    // ── PHASE 2: SCRIPT on gpt-oss ───────────────────────────────────────────
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
      const first = await cast("script", { system: SCRIPT_GENERATOR_SYSTEM_PROMPT, user: userMsg, maxTokens: SCRIPT_MAX_TOKENS, effort: HEAD_EFFORT });
      const attempt1 = processScriptAttempt(first.text, agentBrief, briefId);
      if (attempt1.ok) {
        console.log(`  script valid FIRST TRY — ${first.seconds.toFixed(1)}s, ${first.outputTokens} tok out`);
        return { script: attempt1.script, firstTryValid: true, repaired: false, fellBack: false, errors: [] as string[] };
      }
      console.warn(`  script invalid: ${attempt1.error.split("\n")[0]} — ONE repair retry`);
      // castCall is single-turn; the production multi-turn repair is adapted to
      // one concatenated user message quoting the previous output + exact error.
      const repairUser = [
        userMsg,
        ``,
        `════ YOUR PREVIOUS OUTPUT (INVALID) ════`,
        stripCodeFence(first.text.trim()).slice(0, 40000),
        ``,
        `════ VALIDATION FAILURE ════`,
        attempt1.error,
        ``,
        `Fix the issue and re-emit the COMPLETE Script JSON. Common gotchas to recheck:`,
        `- Every section has visual_concept (1-3 sentences of prose) AND content with headline + asset_ids array.`,
        `- scenes tile [0, total_duration_seconds] exactly: first.start_seconds=0, last.end_seconds=total, adjacent boundaries match.`,
        `- EXACTLY 5 sections. Do NOT emit scene.elements[], scene.background, or scene.audio_cues.`,
        `Output ONLY the JSON object. No prose, no fence.`,
      ].join("\n");
      const second = await cast("script-repair", { system: SCRIPT_GENERATOR_SYSTEM_PROMPT, user: repairUser, maxTokens: SCRIPT_MAX_TOKENS, effort: HEAD_EFFORT });
      const attempt2 = processScriptAttempt(second.text, agentBrief, briefId);
      if (attempt2.ok) {
        console.log(`  script valid after ONE repair — ${second.seconds.toFixed(1)}s`);
        return { script: attempt2.script, firstTryValid: false, repaired: true, fellBack: false, errors: [attempt1.error] };
      }
      console.error(`  script STILL invalid after repair (${attempt2.error.split("\n")[0]}) — falling back to the reference script.json (recorded honestly)`);
      return { script: refScript, firstTryValid: false, repaired: true, fellBack: true, errors: [attempt1.error, attempt2.error] };
    });
    script = scriptResult.script;
    report.script = {
      firstTryValid: scriptResult.firstTryValid,
      repaired: scriptResult.repaired,
      fellBackToReference: scriptResult.fellBack,
      validationErrors: scriptResult.errors,
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
      headlines: script.scenes.map((s) => s.content?.headline),
    };

    // ── PHASE 3: DESIGN SYSTEM head call + deterministic templating ─────────
    const refKfLoc = findConstDecl(manifest.preamble, "SHARED_KEYFRAMES");
    const refKeyframesCss = refKfLoc ? manifest.preamble.slice(refKfLoc.start, refKfLoc.end) : "";
    const ds = await phase("design-system", async () => {
      const user = dsUserPrompt(script!, be);
      const first = await cast("design-system", { system: dsSystemPrompt, user, maxTokens: DS_MAX_TOKENS, effort: HEAD_EFFORT });
      let parsed = parseDsEmission(first.text, refKeyframesCss);
      let preamble = parsed.ok ? templatePreamble(manifest.preamble, parsed.decls!) : null;
      let compileErr = preamble ? await verifyCompilable(preamble) : parsed.error ?? "parse failed";
      let repaired = false;
      if (!parsed.ok || compileErr) {
        const why = parsed.ok ? `the assembled design-system module failed to compile:\n${compileErr}` : parsed.error!;
        console.warn(`  DS invalid (${String(why).split("\n")[0]}) — ONE repair retry`);
        repaired = true;
        const fix = await cast("design-system-repair", {
          system: dsSystemPrompt,
          user: `${user}\n\n════ YOUR PREVIOUS OUTPUT (INVALID) ════\n${stripCodeFence(first.text.trim()).slice(0, 30000)}\n\n════ FAILURE ════\n${why}\n\nRe-emit the four contract declarations, corrected. Nothing else.`,
          maxTokens: DS_MAX_TOKENS,
          effort: HEAD_EFFORT,
        });
        parsed = parseDsEmission(fix.text, refKeyframesCss);
        preamble = parsed.ok ? templatePreamble(manifest.preamble, parsed.decls!) : null;
        compileErr = preamble ? await verifyCompilable(preamble) : parsed.error ?? "parse failed";
      }
      if (!parsed.ok || compileErr) {
        console.error(`  DS STILL invalid (${String(parsed.error ?? compileErr).split("\n")[0]}) — falling back to the REFERENCE creative consts (recorded honestly)`);
        return { preamble: manifest.preamble, ok: false, repaired, fellBack: true, error: parsed.error ?? compileErr, requiredKeyframesInjected: [] as string[] };
      }
      console.log(`  DS accepted${repaired ? " after ONE repair" : " first try"}${parsed.requiredKeyframesInjected!.length ? ` (required keyframes merged from reference: ${parsed.requiredKeyframesInjected!.join(", ")})` : ""}`);
      await fs.writeFile(path.join(OUT_DIR, "design-system-emission.tsx"), Object.values(parsed.decls!).join("\n\n"), "utf8");
      return { preamble: preamble!, ok: true, repaired, fellBack: false, error: null as string | null, requiredKeyframesInjected: parsed.requiredKeyframesInjected! };
    });
    report.designSystem = {
      mergedWithScriptHead: false,
      rationale: "script + DS as two effort-high head calls: the Agent-1 contract needs JSON-only output for the validator/repair loop, and the DS call receives the VALIDATED script so its motif matches the shipped throughline (see file header).",
      acceptedFromModel: ds.ok,
      repaired: ds.repaired,
      fellBackToReferenceConsts: ds.fellBack,
      error: ds.error,
      requiredKeyframesInjected: ds.requiredKeyframesInjected,
    };

    // Choreography: the production zero-token compile step, on the NEW script.
    const signal = (be?.motion_signal ?? "medium") as MotionSignal;
    let preamble = ds.preamble;
    await phase("choreography-compile", async () => {
      const rechoreo = templateChoreography(preamble, script!, signal);
      if (rechoreo) {
        preamble = rechoreo;
        console.log(`  CHOREO_CSS recompiled from the new script (motion signal ${signal})`);
      } else {
        console.warn("  CHOREO_CSS const not found in preamble — keeping the reference choreography");
      }
      report.choreography = { recompiled: !!rechoreo, motionSignal: signal };
    });
    const palette = extractPalette(preamble);
    const sceneSystem = sceneSystemPrompt(elide(preamble.trim()));

    // ── PHASE 4: scenes, 5 whole-Section calls in parallel ───────────────────
    sceneStats = await phase("scenes", async () => {
      console.log("  firing 5 whole-Section calls in parallel …");
      const results = await Promise.all(
        SCENES.map((i) => generateSection(`scene${i}`, sceneSystem, sceneUserPrompt(script!, i), i, palette)),
      );
      for (const s of results)
        console.log(`  scene ${s.scene}: ${s.placeholder ? `PLACEHOLDER (${s.failReason})` : "ok"} · ${s.secs.toFixed(1)}s · ${s.outputTokens} tok out${s.repaired ? " · compile-repaired" : ""}${s.hueLocked ? ` · ${s.hueLocked} hue-locked` : ""}`);
      return results;
    });
    sections = sceneStats.map((s) => s.code);
    report.scenes = sceneStats.map(({ code: _c, ...rest }) => rest);

    // ── compose + write helper ───────────────────────────────────────────────
    let kfRewritesTotal = 0;
    const composeAndWrite = async (firstWrite: boolean): Promise<string> => {
      let comp = preamble + (preamble.endsWith("\n") ? "" : "\n") + sections.map((s) => s.trim()).join("\n\n") + "\n\n" + manifest.tail;
      const kf = repairKeyframeInterpolations(comp);
      comp = kf.code;
      kfRewritesTotal += kf.rewrites;
      if (kf.rewrites > 0) console.log(`  ${kf.rewrites} \${keyframe} interpolation(s) rewritten to literal CSS names (cast-spike repair)`);
      compositionChars = comp.length;
      compositionCompileError = await verifyCompilable(comp);
      if (compositionCompileError) console.error(`  COMPOSITION DOES NOT COMPILE: ${compositionCompileError.split("\n")[0]}`);
      if (firstWrite) {
        await fs.rm(GEN_DIR, { recursive: true, force: true });
        await fs.mkdir(GEN_DIR, { recursive: true });
        for (const shim of SHIMS) await fs.copyFile(path.join(REF_DIR, shim), path.join(GEN_DIR, shim)).catch(() => {});
      }
      await fs.writeFile(path.join(GEN_DIR, "Composition.tsx"), comp, "utf8");
      await fs.writeFile(path.join(GEN_DIR, "script.json"), JSON.stringify(script, null, 2), "utf8");
      return comp;
    };

    // ── PHASES 5+6: the gate stack with bounded gate-triggered retries ──────
    const retriesUsed = new Map<number, number>();
    let round = 0;
    let budgetAborted = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const composition = await phase(`compose-r${round}`, () => composeAndWrite(round === 0));

      const tS = Date.now();
      const structural = runStructuralGates(composition, script);
      const structuralS = (Date.now() - tS) / 1000;

      const tM = Date.now();
      const measurements = await phase(`measure-r${round}`, () => measureScenes(GEN_DIR, script, GEN_DIR));
      const measureS = (Date.now() - tM) / 1000;
      finalMeasurements = measurements;

      const tR = Date.now();
      const rt = await phase(`render-truth-r${round}`, () =>
        findRenderTruthFailures(measurements, {
          brandBackground: resolveCanvasPlan(be as Parameters<typeof resolveCanvasPlan>[0]).background,
          blockingKinds: BLOCKING_KINDS,
          registers: script!.scenes.map((s) => s.register),
        }),
      );
      const renderTruthS = (Date.now() - tR) / 1000;

      const tV = Date.now();
      const vision = await phase(`vision-r${round}`, () => runVisionRound(measurements, script!, be));
      const visionS = (Date.now() - tV) / 1000;

      // Brand-color fidelity backstop — text-only, once, advisory (production).
      if (round === 0 && be?.title) {
        try {
          const fid = await checkBrandColorFidelity({ name: be.title }, be.palette ?? [], async (p) => {
            const { text, usage } = await callZaiText(p, { disableThinking: true, maxTokens: 600 });
            zaiUsage = addUsage(zaiUsage, usage);
            zaiCalls += 1;
            return text;
          });
          report.brandColorFidelity = fid;
          if (!fid.onBrand) console.warn(`  brand-color fidelity flagged (advisory): ${fid.issue}`);
        } catch { /* advisory */ }
      }

      // Failing scenes: structural (attributable) ∪ render-truth BLOCKING ∪
      // vision SEVERE (the pipeline's action threshold).
      const failing = new Set<number>();
      for (const f of structural) if (f.scene >= 0) failing.add(f.scene);
      for (const f of rt.blocking) if (f.scene >= 0) failing.add(f.scene);
      for (const v of vision) if (v.severe.length > 0) failing.add(v.scene);
      const failingScenes = [...failing].sort((a, b) => a - b);

      const eligible = failingScenes.filter((i) => (retriesUsed.get(i) ?? 0) < MAX_RETRY_ROUNDS_PER_SCENE);
      const roundReport: GateRound = {
        round,
        structural,
        renderTruthAll: rt.findings,
        renderTruthBlocking: rt.blocking,
        vision,
        failingScenes,
        retriedScenes: [],
        durations: { structuralS, measureS, renderTruthS, visionS },
      };
      gateRounds.push(roundReport);
      scriptToPreviewEndS = nowS();

      console.log(
        `  round ${round}: structural ${structural.length} · render-truth ${rt.findings.length} (${rt.blocking.length} blocking) · ` +
          `vision actionable ${vision.reduce((n, v) => n + v.actionable.length, 0)} (severe on scenes [${vision.filter((v) => v.severe.length).map((v) => v.scene).join(", ")}]) · failing [${failingScenes.join(", ") || "none"}]`,
      );

      if (eligible.length === 0) {
        if (failingScenes.length > 0)
          console.warn(`  scenes [${failingScenes.join(", ")}] still failing but retry budget spent (max ${MAX_RETRY_ROUNDS_PER_SCENE}/scene) — shipping with residual findings (honest)`);
        break;
      }

      // ── retries: one call per failing scene, feedback appended VERBATIM ──
      try {
        await phase(`retry-r${round + 1}`, async () => {
          const jobs = eligible.map(async (i) => {
            const used = (retriesUsed.get(i) ?? 0) + 1;
            retriesUsed.set(i, used);
            roundReport.retriedScenes.push(i);
            const feedback: string[] = [
              ...structural.filter((f) => f.scene === i).map((f) => `[structural/${f.key}] ${f.detail}`),
              ...rt.blocking.filter((f) => f.scene === i).map((f) => `[render-truth/${f.kind}] ${f.detail}`),
              ...vision.filter((v) => v.scene === i).flatMap((v) => v.severe.map((s) => `[vision] ${s}`)),
            ];
            const prevCode = sections[i];
            const regenUser = [
              sceneUserPrompt(script!, i),
              ``,
              `════ PREVIOUS ATTEMPT FAILED QA — REGENERATE (round ${used}/${MAX_RETRY_ROUNDS_PER_SCENE}) ════`,
              `The production quality gates measured your previous Section${i} on the RENDERED 1920x1080 frame and found these defects. Fix EVERY one while keeping the scene brief above:`,
              ...feedback.map((f) => `- ${f}`),
              ``,
              `YOUR PREVIOUS CODE:`,
              "```tsx",
              prevCode.slice(0, 24000),
              "```",
              ``,
              `Emit ONLY the complete corrected \`export const Section${i}\` component.`,
            ].join("\n");
            const t0 = Date.now();
            const row: RetryLogRow = { scene: i, round: used, feedback, secs: 0, outputTokens: 0, compiled: false, adopted: false };
            try {
              const gen = await generateSection(`retry-r${used}-scene${i}`, sceneSystem, regenUser, i, palette);
              row.secs = (Date.now() - t0) / 1000;
              row.outputTokens = gen.outputTokens;
              row.compiled = gen.ok;
              if (gen.ok) {
                sections[i] = gen.code;
                row.adopted = true;
                row.note = `regenerated${gen.repaired ? " (with compile repair)" : ""}${gen.hueLocked ? `, ${gen.hueLocked} hue-locked` : ""}`;
              } else {
                row.note = `regen did not compile (${gen.failReason}) — previous code kept`;
              }
            } catch (e) {
              row.secs = (Date.now() - t0) / 1000;
              row.note = e instanceof BudgetExceeded ? `aborted: ${e.message}` : `regen call failed: ${e instanceof Error ? e.message : String(e)}`;
              if (e instanceof BudgetExceeded) throw e;
            } finally {
              retryLog.push(row);
              console.log(`  retry scene ${i} (round ${used}): ${row.note}`);
            }
          });
          await Promise.all(jobs);
        });
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          console.error(`  ${e.message} — finishing with what exists`);
          budgetAborted = true;
          // Re-measure once so the report reflects the last adopted state.
          await composeAndWrite(false);
          finalMeasurements = await measureScenes(GEN_DIR, script, GEN_DIR);
          scriptToPreviewEndS = nowS();
          break;
        }
        throw e;
      }
      round += 1;
    }
    report.budgetAborted = budgetAborted;
    report.kfInterpolationRewrites = kfRewritesTotal;

    // ── PHASE 7: final PNGs + gallery ────────────────────────────────────────
    await phase("gallery", async () => {
      const finalVision = gateRounds[gateRounds.length - 1]?.vision ?? [];
      const finalRt = gateRounds[gateRounds.length - 1];
      const perScene = SCENES.map((i) => {
        const m = finalMeasurements.find((mm) => mm.scene === i);
        const v = finalVision.find((vv) => vv.scene === i);
        const rtb = finalRt?.renderTruthBlocking.filter((f) => f.scene === i) ?? [];
        const st = finalRt?.structural.filter((f) => f.scene === i) ?? [];
        const retries = retryLog.filter((r) => r.scene === i).length;
        const noteParts = [
          `${sceneStats[i]?.secs.toFixed(1)}s initial · ${retries} retr${retries === 1 ? "y" : "ies"}`,
          v ? (v.actionable.length === 0 ? "vision: CLEAN" : `vision: ${v.actionable.length} issue(s)${v.severe.length ? ` (${v.severe.length} severe)` : ""}`) : "vision: n/a",
          rtb.length ? `render-truth blocking: ${rtb.map((f) => f.kind).join(", ")}` : "render-truth: clean",
          st.length ? `structural: ${st.map((f) => f.key).join(", ")}` : "",
        ].filter(Boolean);
        return { scene: i, label: script!.scenes[i]?.label ?? `scene ${i}`, m, note: noteParts.join("\n") };
      });
      const cells: { scene: number; png?: string; label: string; note: string }[] = [];
      for (const p of perScene) {
        const shot = path.join(GEN_DIR, `measure-scene-${p.scene}.png`);
        const exists = await fs.stat(shot).then(() => true).catch(() => false);
        if (exists && !p.m?.error) {
          await fs.copyFile(shot, path.join(OUT_DIR, `scene${p.scene}.png`));
          cells.push({ scene: p.scene, png: `scene${p.scene}.png`, label: p.label, note: p.note });
        } else {
          cells.push({ scene: p.scene, label: p.label, note: `${p.m?.error ?? "no screenshot"}\n${p.note}` });
        }
      }
      report.headline = [
        `model ${model}`,
        `script ${scriptResult.firstTryValid ? "valid first try" : scriptResult.fellBack ? "FELL BACK to reference" : "valid after 1 repair"}`,
        `DS ${ds.ok ? (ds.repaired ? "ok after 1 repair" : "ok first try") : "FELL BACK to reference consts"}`,
        `${gateRounds.length} gate round(s) · ${retryLog.length} scene retr${retryLog.length === 1 ? "y" : "ies"}`,
        `${sceneStats.filter((s) => s.placeholder).length} placeholder(s)`,
      ].join(" · ");
      await writeOut();
      await fs.writeFile(path.join(OUT_DIR, "index.html"), galleryHtml(report, gateRounds, cells), "utf8");
    });

    // ── console summary ──────────────────────────────────────────────────────
    const wall = report.wall as { totalRunSeconds: number; scriptToPreviewSeconds: number };
    const cost = report.cost as { cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
    console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
    console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
    console.log(`genDir:  ${GEN_DIR}`);
    console.log(
      `script→preview ${wall.scriptToPreviewSeconds}s · run total ${wall.totalRunSeconds}s · ` +
        `Cerebras ${cerebrasCalls} calls $${cost.cerebras.usd.toFixed(4)} + vision ${zaiCalls} calls $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)}`,
    );
    console.log("\nPHASE TIMELINE:");
    for (const m of marks) console.log(`  ${m.phase.padEnd(24)} ${String(m.startS).padStart(7)}s → ${String(m.endS).padStart(7)}s  (${(m.endS - m.startS).toFixed(1)}s)`);
  } catch (err) {
    // Terminal failure: write the report with everything up to this point.
    report.terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nTERMINAL: ${report.terminalError}`);
    await writeOut().catch(() => {});
    process.exitCode = 1;
  }
};

await main();
