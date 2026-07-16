/**
 * PARITY ACCEPTANCE BUILD — the first full brief→preview run with ALL FOUR
 * parity workstreams live, on a brand the workstreams were NOT tuned on
 * (Duolingo, not HubSpot):
 *
 *   WS-A  density gates            lib/render/density-gates.ts   (BLOCKING)
 *   WS-B  hardened cast orchestrator lib/agents/cast-build.ts    (post-passes,
 *         enriched briefs, connector piece, effort routing)
 *   WS-C  script richness contract  schema-validator checkScriptRichness,
 *         default-on inside validateScript — first LIVE test on generation
 *   WS-D  vision upgrades           lib/render/vision-gate.ts    (density/craft
 *         rubric clause, per-element plan fidelity, sequence judge)
 *
 *   set -a && source .env.local && set +a && node scripts/acceptance-spike.mjs
 *
 * BRAND SELECTION: Duolingo. It is the only preferred brand satisfying BOTH
 * criteria checked live: store brief 01KWTMDDMS2R3H794YW43BW0D9 (dev-local)
 * with cached brand_extract.ok=true AND reference GLM build
 * 01KWTMK9WXRZNF7X553R9AN63M on disk with lego/manifest.json + script.json.
 * (Klarna + Linear also qualify; Duolingo was first preference.)
 *
 * Pipeline (every phase wall-clock instrumented, canary call first):
 *   1. SCRIPT   on gpt-oss — production Agent-1 contract (real system prompt +
 *               real buildUserMessage), the FULL production post-parse chain,
 *               and validateScript with the richness contract ON BY DEFAULT.
 *               Repair loop: up to 3 repair attempts, every validation error
 *               logged VERBATIM (the richness errors ARE the WS-C data).
 *               Terminal failure → reference script fallback, recorded.
 *   2. DESIGN   one head call emitting the full-spike DS contract (PALETTE /
 *               SHARED_KEYFRAMES / THROUGHLINE_TABS / ThroughlineMotif).
 *               ADAPTATION (documented): the Duolingo reference build PREDATES
 *               the choreographer preamble contract — its preamble has no
 *               SHARED_KEYFRAMES/THROUGHLINE_TABS/ThroughlineMotif/CHOREO_CSS
 *               consts and its PALETTE keys are brand-named, so the full-spike
 *               "swap consts into the reference preamble" validation is
 *               impossible here. The DS is instead validated STANDALONE
 *               (4-decl parse, 7-key PALETTE, data-throughline, esbuild
 *               compile), and the castBuild Theme is derived from the SAME
 *               emitted DS (themeFromManifest's mapping, adapted): palette =
 *               emitted PALETTE camelCase→CONST_CASE, keyframes = emitted
 *               SHARED_KEYFRAMES, fonts + LOGO_SRC = reference preamble
 *               verbatim (locked brand identity), grammar = the cast-spike
 *               derived defaults keyed to the contract consts.
 *               THROUGHLINE_TABS/ThroughlineMotif are contract-validated but
 *               not consumed — the cast throughline element re-invents the
 *               motif from the script text (cast-spike mapping note).
 *   3. SCENES   via the HARDENED castBuild() — real castCall, default
 *               concurrency. Cast path, not scene-parallel: the parity audit
 *               concluded density = sum of pieces.
 *   4. GATES    (a) density: assessDensity — NEW, blocking; plus a per-scene
 *               per-clause numeric profile (both rows, reference = the bar);
 *               (b) structural (standalone production set) + render-truth
 *               (production BLOCKING_KINDS); (c) per-scene vision with the NEW
 *               rubric (density/craft + per-element fidelity, scene concepts
 *               passed); (d) SEQUENCE vision: judgeSequence over ALL scene
 *               screenshots in ONE call. MULTI-IMAGE CHOICE (documented):
 *               callZaiVision natively accepts string | string[] and maps each
 *               entry to an OpenAI image_url block on the native paas endpoint
 *               (lib/render/zai-vision.ts) — the frames go up as a real
 *               multi-image message; no tiling needed.
 *   5. RETRIES  scene-scoped blocking findings (density / render-truth
 *               blocking / severe vision) route to the OWNED PIECE and
 *               regenerate via a re-run of castBuild with a CACHING CALLER:
 *               untargeted pieces replay their cached raw emission at zero
 *               token cost; targeted pieces get ONE real call with the gate
 *               feedback + their previous body appended verbatim. The hardened
 *               orchestrator's own deterministic post-passes, assembler,
 *               choreographer, and final compile gate re-run every round —
 *               this IS castBuild's repair machinery, scoped (the cheapest
 *               sound loop: N-failing-pieces calls per round, not N-elements).
 *               Max 2 retry rounds. Sequence-scope findings are LOGGED ONLY
 *               (head-level fixes are next session's work).
 *   6. RENDER   final scenes vs the reference build (readDecomposed →
 *               reassemble → same measureScenes path). Gallery with two rows,
 *               phase timeline, round-by-round gate log, per-scene density
 *               numbers for BOTH rows, cost split, total wall.
 *
 * Budget guard: ≤60 REAL Cerebras calls (cached replays are free); the guard
 * aborts retries honestly and the report ships with everything so far.
 *
 * Footprint: this file + scripts/acceptance-spike.mjs + .data/acceptance/ +
 * src/generated/CAST_SPIKE_ACCEPT_*. Reads everything, modifies nothing else.
 */
import { promises as fs } from "fs";
import path from "path";
import { castBuild, type CastBuildResult } from "../lib/agents/cast-build";
import { castCall, castConfigured, type CastResult } from "../lib/llm/cast-provider";
import type { Theme } from "../lib/edit/piece-model";
import type { Script } from "../src/schema";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
import { injectLogoSrc } from "../lib/agents/logo-inject";
import { finalizeUndefinedRefs, assessInvalidLucideImports } from "../lib/agents/finalize-refs";
import { readDecomposed, type Manifest } from "../lib/agents/lego-store";
import { reassemble } from "../lib/agents/lego-decompose";
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
const BRAND = "Duolingo";
const REF_BUILD = "01KWTMK9WXRZNF7X553R9AN63M"; // the Duolingo GLM reference
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "acceptance");
const GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_ACCEPT_DUOLINGO");
const REF_GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_ACCEPT_REFERENCE");
const SCENES = [0, 1, 2, 3, 4];
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

const SCRIPT_MAX_TOKENS = 16000; // production Agent-1 max_tokens
const DS_MAX_TOKENS = 10000;
const HEAD_EFFORT = "high" as const; // think at the head
const SCRIPT_REPAIRS_MAX = 3; // repair attempts after the first call

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

// ── caching + feedback caller for castBuild ──────────────────────────────────
// The retry mechanism: castBuild is deterministic in its contracts (same
// script + theme + aspect → same jobs, same piece ids, same briefs), so a
// re-run with this caller replays every UNTARGETED piece's cached raw emission
// at zero cost and only TARGETED pieces (gate failures) earn real calls, with
// the gate feedback + the previous body appended verbatim. The orchestrator's
// deterministic post-passes / assembler / choreographer / compile gate re-run
// on every round — this is castBuild's own repair machinery, scoped.

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

/** Balanced scanner for a top-level `const NAME = …;` declaration (full-spike's). */
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
}
interface LooseScript {
  scenes: ScriptScene[];
  narrative?: { throughline?: string; arc?: string; logline?: string };
  config?: { aspect_ratio?: string; duration_seconds?: number };
  brief?: { about?: string; purpose?: string; cta?: string };
  assets?: unknown;
}

// ── PHASE 1: script on gpt-oss (production Agent-1 contract, richness ON) ────
// injectIdentity / mergePreallocatedAssets replicate script-generator.ts's
// module-private post-parse steps (same as scripts/full-spike.ts).

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

/** The full production post-parse chain + guards. validateScript enforces the
 *  richness contract BY DEFAULT — the first live test of WS-C. */
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
  const validation = validateScript(normalized); // richness contract ON by default
  if (!validation.ok) return { ok: false, error: validation.error };
  const script = validation.script as unknown as LooseScript;

  const wantSec = brief.duration_seconds;
  const gotSec = script.config?.duration_seconds ?? 0;
  if (typeof wantSec === "number" && wantSec > 0 && Math.abs(gotSec - wantSec) > 0.5) {
    return { ok: false, error: `config.duration_seconds is ${gotSec}s but the brief requires EXACTLY ${wantSec}s. Set config.duration_seconds = ${wantSec} and re-tile ALL scenes to fill 0→${wantSec} with no gaps.` };
  }
  if (script.scenes.length !== 5) {
    return { ok: false, error: `Script has ${script.scenes.length} scenes but the brief requires EXACTLY 5 sections (one per moment).` };
  }
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
  const typeOnly = findTypeOnlyScenes(script.scenes as { visual_concept?: string }[]);
  if (typeOnly.length > 0) {
    return { ok: false, error: `Type-only scenes (visual_concept is just a headline plus ambient decoration, nothing to look at): ${typeOnly.map((i) => `scene ${i}`).join(", ")}. EVERY scene must specify a concrete non-text/diegetic visual (a product mock, dashboard, diagram, chart, annotated illustration).` };
  }
  return { ok: true, script };
};

/** Which richness clauses fired in a validation error (for the WS-C log). */
const richnessClausesIn = (error: string): string[] => {
  const clauses: [string, RegExp][] = [
    ["beat-coverage", /latest timed beat/],
    ["visual-concept-floor", /visual_concept too thin/],
    ["interior-furnishing", /interior detail/],
    ["atmosphere-anti-copy", /same atmosphere phrase/],
  ];
  return clauses.filter(([, rx]) => rx.test(error)).map(([name]) => name);
};

// ── PHASE 2: design-system head call, validated standalone ──────────────────

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

/** Parse + contract-check the DS emission STANDALONE (the reference preamble
 *  predates the templating contract — see file header). */
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

// ── Theme derivation (adapted from scripts/cast-spike.ts themeFromManifest) ──
// The head-emitted DS carries palette + keyframes; the LOCKED brand identity
// (fonts incl. embedded @font-face payloads, logo) comes from the reference
// preamble verbatim; the grammar is the cast-spike derived default keyed to
// the contract consts (SOFT_NEUTRAL hairlines on CARD_FILL surfaces).

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
  notes.push("THROUGHLINE_TABS + ThroughlineMotif: contract-validated but NOT consumed by the cast path — the cast throughline element re-invents the motif from the script's throughline text (cast-spike mapping note).");
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

/** Deterministic neutral keyframe set — DS-fallback path only. */
const FALLBACK_KEYFRAMES = `
@keyframes fadeRise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
@keyframes drawWidth { from { width: 0; } }
@keyframes glowBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes drift1 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(14px, -10px); } }
@keyframes drift2 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-12px, 8px); } }
@keyframes drift3 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(8px, 12px); } }
`;

/** DS terminal-failure fallback: synthesize the contract palette from the
 *  reference build's own PALETTE + the canvas plan + signature (recorded
 *  honestly — this is NOT the head's design system). */
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

// ── structural gates (the standalone-runnable production set, full-spike's) ──

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

// ── per-scene vision (the NEW rubric: density/craft + per-element fidelity) ──

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
        // buildRubric now carries the density/craft clause + per-element plan
        // fidelity (extractPlannedElements) — the WS-D per-scene upgrade.
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

// ── sequence vision (WS-D whole-video pass, one native multi-image call) ─────

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

// ── finding → piece routing (the retry targeting) ────────────────────────────

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
    // density-measure-error is unroutable (castBuild compile-gates) — log only.
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
    if (f.kind === "measure-error" || f.scene < 0) continue;
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
  sequence: VisionFinding[];
  targets: { pieceId: string; feedback: string[] }[];
}

interface RichnessAttempt { attempt: number; secs: number; tokensOut: number; ok: boolean; error?: string; richnessClauses?: string[] }

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
  richness: RichnessAttempt[];
  accCells: { scene: number; png?: string; label: string; note: string }[];
  refCells: { scene: number; png?: string; label: string; note: string }[];
  accProfile: DensityProfile | null;
  refProfile: DensityProfile | null;
  refDensityFindings: DensityFinding[];
}): string => {
  const { report, rounds, richness, accCells, refCells, accProfile, refProfile, refDensityFindings } = g;
  const cost = report.cost as { cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
  const wall = report.wall as { totalRunSeconds: number; scriptToPreviewSeconds: number | null };

  const row = (cells: { scene: number; png?: string; label: string; note: string }[]): string =>
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

  const richnessRows = richness
    .map((r) => `<li><b>attempt ${r.attempt}</b> (${r.secs.toFixed(1)}s, ${r.tokensOut} tok): ${r.ok ? "VALID" : `INVALID${r.richnessClauses?.length ? ` [richness: ${r.richnessClauses.join(", ")}]` : ""} — ${esc((r.error ?? "").slice(0, 700))}`}</li>`)
    .join("\n");

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
      for (const f of r.sequence) rows.push(`<li><b>sequence-vision (log-only)</b>: ${esc(f.issue.slice(0, 300))}</li>`);
      const targets = r.targets.map((t) => t.pieceId).join(", ") || "none";
      return `<h3>gate round ${r.round} — ${r.realCalls} real Cerebras calls this round · retry targets: [${esc(targets)}]</h3><ul>${rows.join("\n") || "<li>all clean</li>"}</ul>`;
    })
    .join("\n");

  const densityTable = `
  <table>
    <tr>
      <th rowspan="2">scene</th>
      <th colspan="4">ACCEPTANCE (this build)</th>
      <th colspan="4">REFERENCE (GLM — the bar)</th>
    </tr>
    <tr>
      <th>diegetic el/txt (≥${DIEGETIC_MIN_ELEMENTS}/${DIEGETIC_MIN_TEXT_NODES})</th><th>depth (≥${DEPTH_FLOOR})</th><th>grad sigs</th><th>bad img</th>
      <th>diegetic el/txt</th><th>depth</th><th>grad sigs</th><th>bad img</th>
    </tr>
    ${SCENES.map((i) => `<tr><td>scene ${i}</td>${densityCellHtml(accProfile?.scenes.find((s) => s.scene === i))}${densityCellHtml(refProfile?.scenes.find((s) => s.scene === i))}</tr>`).join("\n")}
    <tr>
      <td>video-level</td>
      <td colspan="4" class="${accProfile && accProfile.varietyPass ? "ok" : "bad"}">${accProfile ? `${accProfile.distinctSignatures} distinct gradient signatures (≥${MIN_GRADIENT_SIGNATURES}); ${accProfile.repeated.length} repeated-verbatim violation(s)` : "n/a"}</td>
      <td colspan="4" class="${refProfile && refProfile.varietyPass ? "ok" : "bad"}">${refProfile ? `${refProfile.distinctSignatures} distinct; ${refProfile.repeated.length} repeated violation(s)` : "n/a"}</td>
    </tr>
  </table>
  <div class="sub">reference assessDensity findings: ${refDensityFindings.length === 0 ? "CLEAN (the bar holds)" : esc(refDensityFindings.map((f) => `${f.kind}@${f.scene}`).join(", "))}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parity acceptance build — ${esc(BRAND)} on Cerebras + all four parity workstreams</title>
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
  table { border-collapse: collapse; margin: 8px 0; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  th, td { border: 1px solid #26272e; padding: 5px 9px; text-align: center; color: #b9bac2; }
  th { background: #16171c; color: #8a8a93; }
  td.ok { color: #6cb56c; }
  td.bad { color: #e0245e; font-weight: 700; }
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 1100px; }
</style>
</head>
<body>
  <h1>Parity acceptance build — ${esc(BRAND)}: brief→preview with all four parity workstreams live</h1>
  <div class="sub">${esc(String(report.headline ?? ""))}</div>
  <div class="sub">script→preview wall <b>${wall.scriptToPreviewSeconds === null ? "—" : `${wall.scriptToPreviewSeconds.toFixed(1)}s`}</b> · run total ${wall.totalRunSeconds.toFixed(1)}s · cost: Cerebras $${cost.cerebras.usd.toFixed(4)} + z.ai vision $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)} · live-crawl excluded (cached brand_extract) · reference build ${esc(REF_BUILD)}</div>

  <h2>Phase timeline</h2>
  <div class="timeline">${bars}</div>
  <div>${legend}</div>

  <h2>Density comparison — per scene, per clause (reference numbers are the bar)</h2>
  ${densityTable}

  <h2>Final QA'd row (acceptance build — cast path on gpt-oss)</h2>
  <div class="row">
${row(accCells)}
  </div>

  <h2>Reference row — the production GLM build (same brand + brief)</h2>
  <div class="row">
${row(refCells)}
  </div>

  <h2>Script richness loop (WS-C, first live test)</h2>
  <ul>${richnessRows || "<li>no attempts logged</li>"}</ul>

  <h2>Gate log (round by round)</h2>
  ${gateLog}

  <div class="foot">
    Script (production Agent-1 contract + richness validator, ≤${1 + SCRIPT_REPAIRS_MAX} attempts) + DS head call (validated standalone,
    themed into the cast Theme) + hardened castBuild() (enriched briefs, connector piece, effort routing, deterministic
    post-passes) — all on Cerebras gpt-oss — then density gates (BLOCKING) + structural + render-truth (production
    BLOCKING_KINDS) + the upgraded per-scene vision rubric + the one-call multi-image sequence judge on GLM vision
    (native z.ai endpoint). Piece-scoped retries: castBuild re-runs with cached replays, only gate-failing pieces earn
    real calls (max ${MAX_RETRY_ROUNDS} rounds, hard ceiling ${CALL_CEILING} real Cerebras calls). Sequence findings are logged, never looped.
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/acceptance-spike.mjs");
    process.exitCode = 1;
    return;
  }
  const model = process.env.RB_CAST_MODEL || "gpt-oss-120b";
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const report: Record<string, unknown> = {
    experiment: "PARITY ACCEPTANCE: brief→script→DS→castBuild on Cerebras gpt-oss + density gates + richness contract + upgraded vision (per-scene + sequence), piece-scoped retries",
    brand: BRAND,
    ref: REF_BUILD,
    model,
    generatedAt: new Date().toISOString(),
    crawlNote: "brand_extract was CACHED on the brief — live-crawl time is excluded from every wall number here",
    multiImageChoice: "judgeSequence sends all frames in ONE native multi-image call — callZaiVision accepts string[] and maps each entry to an image_url block on the z.ai paas endpoint (lib/render/zai-vision.ts); no tiling needed",
    terminalError: null,
  };
  const gateRounds: GateRoundReport[] = [];
  const richnessLog: RichnessAttempt[] = [];
  let script: LooseScript | null = null;
  let finalMeasurements: SceneMeasurement[] = [];
  let accProfile: DensityProfile | null = null;
  let refProfile: DensityProfile | null = null;
  let refDensityFindings: DensityFinding[] = [];
  let scriptStartS: number | null = null;
  let scriptToPreviewEndS: number | null = null;

  const writeOut = async (): Promise<void> => {
    const cerebrasUsd = (cerebrasIn * USD_PER_M_IN + cerebrasOut * USD_PER_M_OUT) / 1e6;
    const zaiUsd = costUsd(VISION_MODEL, zaiUsage);
    report.phases = marks;
    report.gateRounds = gateRounds;
    report.richnessLoop = richnessLog;
    report.calls = callLog;
    report.budget = { realCerebrasCalls: realCalls, ceiling: CALL_CEILING, budgetExhausted };
    report.cost = {
      cerebras: { calls: realCalls, inputTokens: cerebrasIn, outputTokens: cerebrasOut, usdPerMIn: USD_PER_M_IN, usdPerMOut: USD_PER_M_OUT, usd: cerebrasUsd },
      zaiVision: { calls: zaiCalls, inputTokens: zaiUsage.input_tokens, outputTokens: zaiUsage.output_tokens, model: VISION_MODEL, usd: zaiUsd },
      totalUsd: cerebrasUsd + zaiUsd,
    };
    report.wall = {
      totalRunSeconds: nowS(),
      scriptToPreviewSeconds:
        scriptStartS !== null && scriptToPreviewEndS !== null ? Math.round((scriptToPreviewEndS - scriptStartS) * 10) / 10 : null,
    };
    report.densityProfiles = { acceptance: accProfile, reference: refProfile, referenceFindings: refDensityFindings };
    await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  };

  try {
    // ── inputs: reference manifest (fonts/logo + reassembly) + fallback ─────
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
      signatureWithLogoFallback(be.palette ?? [], be.theme_color, be.logo_color) ?? be.theme_color ?? (be.palette ?? [])[0] ?? "#57cc02";
    report.brief = { projectId: stored.id, url: stored.brand_kit_url, brandExtractCached: true, canvasPlan, signature };

    // ── canary (proves transport + key + model before any real spend) ────────
    await phase("canary", async () => {
      const c = await budgetedCast("canary", { system: "You are a connectivity canary. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 256, effort: "low" });
      console.log(`  canary ok — ${c.seconds.toFixed(1)}s, ${c.outputTokens} tok out, stop=${c.stopReason}`);
    });

    // ── PHASE 1: SCRIPT (richness contract live) ────────────────────────────
    const agentBrief: AgentBrief = {
      duration_seconds: stored.duration_seconds ?? 30,
      distribution_format: stored.distribution_format ?? "landscape",
      moment_count: 5,
      brand_kit_url: stored.brand_kit_url,
      verified_claims: stored.verified_claims,
      brand_extract: be,
      preallocated_assets: buildPreallocatedFromCrawl(be),
      freeform_prompt: refScript.brief?.about ?? stored.purpose,
    };
    const briefId = stored.id;
    scriptStartS = nowS();
    const scriptResult = await phase("script", async () => {
      const userMsg = buildUserMessage(agentBrief);
      let lastRaw = "";
      let lastError = "";
      for (let attempt = 1; attempt <= 1 + SCRIPT_REPAIRS_MAX; attempt++) {
        const user =
          attempt === 1
            ? userMsg
            : [
                userMsg,
                ``,
                `════ YOUR PREVIOUS OUTPUT (INVALID) ════`,
                stripCodeFence(lastRaw.trim()).slice(0, 40000),
                ``,
                `════ VALIDATION FAILURE (fix EVERY error) ════`,
                lastError,
                ``,
                `Fix the issues and re-emit the COMPLETE Script JSON. Common gotchas to recheck:`,
                `- Every section has visual_concept (1-3 sentences of prose) AND content with headline + asset_ids array.`,
                `- scenes tile [0, total_duration_seconds] exactly: first.start_seconds=0, last.end_seconds=total, adjacent boundaries match.`,
                `- EXACTLY 5 sections. Do NOT emit scene.elements[], scene.background, or scene.audio_cues.`,
                `- RICHNESS: each scene's visual_concept needs explicit timed beats reaching ≥60% of the scene's duration ("at 4.2s", "from 3.8s"); ≥120 chars naming ≥3 concrete drawable elements; every named mock/window/panel/card/dashboard/browser must name ≥2 interior specifics (rows, labels, values, tabs, chart, avatars); and each scene's sustained/looping motion must be phrased for THAT scene's own elements, never copy-pasted ambience.`,
                `Output ONLY the JSON object. No prose, no fence.`,
              ].join("\n");
        const res = await budgetedCast(attempt === 1 ? "script" : `script-repair-${attempt - 1}`, {
          system: SCRIPT_GENERATOR_SYSTEM_PROMPT,
          user,
          maxTokens: SCRIPT_MAX_TOKENS,
          effort: HEAD_EFFORT,
        });
        lastRaw = res.text;
        const outcome = processScriptAttempt(res.text, agentBrief, briefId);
        if (outcome.ok) {
          richnessLog.push({ attempt, secs: res.seconds, tokensOut: res.outputTokens, ok: true });
          console.log(`  script VALID on attempt ${attempt} — ${res.seconds.toFixed(1)}s, ${res.outputTokens} tok out`);
          return { script: outcome.script, attempts: attempt, fellBack: false };
        }
        lastError = outcome.error;
        richnessLog.push({ attempt, secs: res.seconds, tokensOut: res.outputTokens, ok: false, error: outcome.error, richnessClauses: richnessClausesIn(outcome.error) });
        console.warn(`  script attempt ${attempt} INVALID${richnessClausesIn(outcome.error).length ? ` [richness: ${richnessClausesIn(outcome.error).join(", ")}]` : ""}:`);
        for (const line of outcome.error.split(" | ")) console.warn(`    · ${line.split("\n")[0].slice(0, 220)}`);
      }
      console.error(`  script STILL invalid after ${SCRIPT_REPAIRS_MAX} repairs — falling back to the reference script.json (recorded honestly)`);
      const fallback = backfillSceneRegisters(normalizeScriptContent(refScript)) as LooseScript;
      return { script: fallback, attempts: 1 + SCRIPT_REPAIRS_MAX, fellBack: true };
    });
    script = scriptResult.script;
    report.script = {
      attempts: scriptResult.attempts,
      fellBackToReference: scriptResult.fellBack,
      labels: script.scenes.map((s) => s.label),
      registers: script.scenes.map((s) => s.register),
      throughline: script.narrative?.throughline,
      headlines: script.scenes.map((s) => s.content?.headline),
    };

    // ── PHASE 2: DESIGN SYSTEM head call → Theme ────────────────────────────
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
        derived.mappingNotes.push(`requested shared keyframes MISSING from the emission (warn only — no helper depends on them in the cast path): ${parsed.missingRequestedKeyframes!.join(", ")}`);
      }
      console.log(`  DS accepted${repaired ? " after ONE repair" : " first try"} — palette ${Object.keys(derived.theme.palette).join("/")}${parsed.missingRequestedKeyframes!.length ? ` · missing requested keyframes: ${parsed.missingRequestedKeyframes!.join(", ")}` : ""}`);
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

    // ── PHASES 3–5: castBuild + gate stack + piece-scoped retries ────────────
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
        // castBuild throwing = orchestrator-level failure. Keep the previous
        // round's state (if any) and stop — report honestly.
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

      // Production finalize steps every build gets before render/SSR: the
      // pipeline owns LOGO_SRC (Chrome references it), undefined refs are
      // stubbed rather than fatal.
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

      // (a) density gates — NEW, blocking.
      const density = await phase(`density-r${round}`, async () => assessDensity(finalCode, script));
      accProfile = buildDensityProfile(finalCode, script);
      console.log(`  density: ${density.length} blocking finding(s) · video distinct sigs ${accProfile.distinctSignatures} · depths [${accProfile.scenes.map((s) => s.depth).join(", ")}]`);

      // (b) structural + render-truth.
      const structural = runStructuralGates(finalCode, script);
      const measurements = await phase(`measure-r${round}`, () => measureScenes(GEN_DIR, script, GEN_DIR));
      finalMeasurements = measurements;
      const rt = await phase(`render-truth-r${round}`, () =>
        findRenderTruthFailures(measurements, {
          brandBackground: canvasPlan.background,
          blockingKinds: BLOCKING_KINDS,
          registers: script!.scenes.map((s) => s.register),
        }),
      );

      // (c) per-scene vision (new rubric) + (d) sequence vision (one call).
      const vision = await phase(`vision-r${round}`, () => runVisionRound(measurements, script!, brandTruth));
      const sequence = await phase(`sequence-vision-r${round}`, () => runSequenceRound(measurements, brandTruth));
      for (const f of sequence) console.log(`  sequence: ${f.issue.slice(0, 160)}`);

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
      const targets = computeTargets({ validPieceIds, density, profile: accProfile, rtBlocking: rt.blocking, vision });

      const roundReport: GateRoundReport = {
        round,
        realCalls: realCalls - callsBefore,
        castTelemetry: castResult.telemetry,
        density,
        profile: accProfile,
        structural,
        renderTruthAll: rt.findings,
        renderTruthBlocking: rt.blocking,
        vision,
        sequence,
        targets: [...targets.entries()].map(([pieceId, feedback]) => ({ pieceId, feedback })),
      };
      gateRounds.push(roundReport);
      scriptToPreviewEndS = nowS();

      console.log(
        `  round ${round}: density ${density.length} · structural ${structural.length} · render-truth ${rt.findings.length} (${rt.blocking.length} blocking) · ` +
          `vision actionable ${vision.reduce((n, v) => n + v.actionable.length, 0)} (severe on [${vision.filter((v) => v.severe.length).map((v) => v.scene).join(", ")}]) · ` +
          `sequence ${sequence.length} (log-only) · retry targets [${[...targets.keys()].join(", ") || "none"}]`,
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
    if (finalCode) await fs.writeFile(path.join(OUT_DIR, "Composition.acceptance.tsx"), finalCode, "utf8");

    // ── PHASE 6a: reference row (reassembled untouched, same measure path) ───
    const refRow = await phase("reference-row", async () => {
      const d = await readDecomposed(REF_DIR);
      const refComposition = reassemble(d);
      await fs.rm(REF_GEN_DIR, { recursive: true, force: true });
      await fs.mkdir(REF_GEN_DIR, { recursive: true });
      for (const shim of SHIMS) await fs.copyFile(path.join(REF_DIR, shim), path.join(REF_GEN_DIR, shim)).catch(() => {});
      await fs.writeFile(path.join(REF_GEN_DIR, "Composition.tsx"), refComposition, "utf8");
      await fs.writeFile(path.join(REF_GEN_DIR, "script.json"), JSON.stringify(refScript, null, 2), "utf8");
      refDensityFindings = assessDensity(refComposition, refScript);
      refProfile = buildDensityProfile(refComposition, refScript);
      const ms = await measureScenes(REF_GEN_DIR, refScript, REF_GEN_DIR);
      console.log(`  reference: ${ms.filter((m) => m.screenshotPath && !m.error).length}/5 scenes rendered · density findings ${refDensityFindings.length} · distinct sigs ${refProfile.distinctSignatures}`);
      return ms;
    });

    // ── PHASE 6b: gallery ────────────────────────────────────────────────────
    await phase("gallery", async () => {
      const finalRound = gateRounds[gateRounds.length - 1];
      const accCells: { scene: number; png?: string; label: string; note: string }[] = [];
      for (const i of SCENES) {
        const m = finalMeasurements.find((mm) => mm.scene === i);
        const v = finalRound?.vision.find((vv) => vv.scene === i);
        const dens = finalRound?.density.filter((f) => f.scene === i) ?? [];
        const rtb = finalRound?.renderTruthBlocking.filter((f) => f.scene === i) ?? [];
        const note = [
          v ? (v.actionable.length === 0 ? "vision: CLEAN" : `vision: ${v.actionable.length} issue(s)${v.severe.length ? ` (${v.severe.length} severe)` : ""}`) : "vision: n/a",
          dens.length ? `density: ${dens.map((f) => f.kind).join(", ")}` : "density: clean",
          rtb.length ? `render-truth blocking: ${rtb.map((f) => f.kind).join(", ")}` : "render-truth: clean",
        ].join("\n");
        const shot = path.join(GEN_DIR, `measure-scene-${i}.png`);
        const exists = await fs.stat(shot).then(() => true).catch(() => false);
        if (exists && !m?.error) {
          await fs.copyFile(shot, path.join(OUT_DIR, `scene${i}.png`));
          accCells.push({ scene: i, png: `scene${i}.png`, label: script!.scenes[i]?.label ?? `scene ${i}`, note });
        } else {
          accCells.push({ scene: i, label: script!.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
        }
      }
      await fs.mkdir(path.join(OUT_DIR, "reference"), { recursive: true });
      const refCells: { scene: number; png?: string; label: string; note: string }[] = [];
      for (const i of SCENES) {
        const m = refRow.find((mm) => mm.scene === i);
        const p = refProfile?.scenes.find((s) => s.scene === i);
        const note = p ? `diegetic ${p.bestDiegetic ? `${p.bestDiegetic.elements}el/${p.bestDiegetic.textNodes}txt` : "none"} · depth ${p.depth}` : "";
        const shot = path.join(REF_GEN_DIR, `measure-scene-${i}.png`);
        const exists = await fs.stat(shot).then(() => true).catch(() => false);
        if (exists && !m?.error) {
          await fs.copyFile(shot, path.join(OUT_DIR, "reference", `scene${i}.png`));
          refCells.push({ scene: i, png: `reference/scene${i}.png`, label: refScript.scenes[i]?.label ?? `scene ${i}`, note });
        } else {
          refCells.push({ scene: i, label: refScript.scenes[i]?.label ?? `scene ${i}`, note: `${m?.error ?? "no screenshot"}\n${note}` });
        }
      }

      const sr = report.script as { attempts: number; fellBackToReference: boolean };
      report.headline = [
        `brand ${BRAND} (ref ${REF_BUILD})`,
        `model ${model}`,
        `script ${sr.fellBackToReference ? "FELL BACK to reference" : `valid on attempt ${sr.attempts}`}`,
        `DS ${ds.ok ? (ds.repaired ? "ok after 1 repair" : "ok first try") : "FELL BACK"}`,
        `${gateRounds.length} gate round(s)`,
        `${gateRounds[gateRounds.length - 1]?.density.length ?? "?"} residual density finding(s)`,
        `${realCalls} real Cerebras calls`,
      ].join(" · ");
      await writeOut();
      await fs.writeFile(
        path.join(OUT_DIR, "index.html"),
        galleryHtml({ report, rounds: gateRounds, richness: richnessLog, accCells, refCells, accProfile, refProfile, refDensityFindings }),
        "utf8",
      );
    });

    // ── console summary ──────────────────────────────────────────────────────
    const wall = report.wall as { totalRunSeconds: number; scriptToPreviewSeconds: number | null };
    const cost = report.cost as { cerebras: { usd: number }; zaiVision: { usd: number }; totalUsd: number };
    console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
    console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
    console.log(`genDir:  ${GEN_DIR}`);
    console.log(
      `script→preview ${wall.scriptToPreviewSeconds}s · run total ${wall.totalRunSeconds}s · ` +
        `Cerebras ${realCalls} real calls $${cost.cerebras.usd.toFixed(4)} + vision ${zaiCalls} calls $${cost.zaiVision.usd.toFixed(4)} = $${cost.totalUsd.toFixed(4)}`,
    );
    console.log("\nPHASE TIMELINE:");
    for (const m of marks) console.log(`  ${m.phase.padEnd(24)} ${String(m.startS).padStart(7)}s → ${String(m.endS).padStart(7)}s  (${(m.endS - m.startS).toFixed(1)}s)`);
  } catch (err) {
    report.terminalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\nTERMINAL: ${report.terminalError}`);
    await writeOut().catch(() => {});
    process.exitCode = 1;
  }
};

await main();
