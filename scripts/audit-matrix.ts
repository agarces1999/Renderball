/**
 * AUDIT MATRIX — controlled prompt-stack × reasoning-effort experiment on
 * Cerebras gpt-oss-120b, answering: is the ~4.7/10 "thin" full-spike result a
 * MODEL ceiling or a PROMPT asymmetry?
 *
 *   set -a && source .env.local && set +a && node scripts/audit-matrix.mjs
 *
 * Design: 6 conditions × 2 scenes (reference script scenes 1 "The Tool Chaos"
 * and 2 "The Turn"), one whole-Section call each, IDENTICAL scene content and
 * design-system preamble (the 01KXEAF0… reference build's — same controlled
 * theme as scripts/scene-spike.ts):
 *
 *   A  spike prompt as-is            · effort low     (baseline — the thin result)
 *   B  spike prompt as-is            · effort medium
 *   C  spike prompt as-is            · effort high
 *   D  ENRICHED prompt               · effort low
 *   E  ENRICHED prompt               · effort medium
 *   F  ENRICHED prompt + 1 exemplar  · effort medium  (register-matched golden scene)
 *
 * The ENRICHED prompt ports the portable taste stack the forensic audit found
 * missing from the spike (present in every GLM design call): the machine-checked
 * CONSTRAINTS lines (NO PLACEHOLDER DATA, taste contract, text floors, accent
 * discipline, lower-third anchor), the density bar (6-10+ elements, anti-void /
 * anti-barbell), the diegetic-mock interior checklist (≥6 labeled interior
 * elements, the primitive vocabulary), the register→archetype map + treatments,
 * and the atmosphere MENU + per-register variety directive (with scene-local
 * atmosphere layers explicitly permitted). Condition F additionally appends the
 * production exemplarPromptBlock (QA-2 sanitized golden scene, register-keyed).
 *
 * Each cell: generate → hue-lock (normalizeElementColors) → compile probe with
 * ONE repair retry → compose into a scratch genDir (stub Sections 0/3/4) →
 * render + measure via the production render-truth path (measureScenes) →
 * DENSITY METRICS off the measured DOM walk:
 *   domEls            visible elements painting in the 1920×1080 frame
 *   diegeticInterior  elements inside kind="diegetic" pieces (mock interiors —
 *                     the "empty container" symptom, quantified)
 *   textEls           elements carrying their own text
 *   svgRoots/svgPrims inline-SVG structure (illustration/chart effort)
 * The same metrics are measured on the REFERENCE build's scenes 1-2 (the GLM
 * ~9/10 bar) so "reference-grade density" is a number, not a vibe.
 *
 * Outputs: .data/audit-matrix/{index.html, build-report.json, {cond}-scene{N}.png}
 * Budget: 1 canary + 12 generation calls + ≤12 repairs ≤ 25 Cerebras calls.
 */
import { promises as fs } from "fs";
import path from "path";
import * as esbuild from "esbuild";
import { castCall, castConfigured, type CastResult, type CastEffort } from "../lib/llm/cast-provider";
import { normalizeElementColors } from "../lib/agents/normalize-element";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
import { measureScenes, type SceneMeasurement } from "../lib/render/measure-scene";
import { exemplarPromptBlock } from "../lib/agents/exemplars";
import type { Manifest } from "../lib/agents/lego-store";

const ROOT = process.cwd();
const REF_BUILD = "01KXEAF0SNT0RR079Z1SJZ1KWZ";
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "audit-matrix");
const GEN_ROOT = path.join(OUT_DIR, "gen");
const SCENES = [1, 2] as const; // "The Tool Chaos" (list) · "The Turn" (stat)
// Uniform, deliberately non-binding cap (SOURCE-0: 8k never bound on the thin
// baseline; high-effort reasoning + dense output need headroom — same cap for
// every condition so the ceiling is never a confound).
const MAX_TOKENS = 14000;
const USD_PER_M_IN = 0.35;
const USD_PER_M_OUT = 0.75;

// Same elision scene-spike/model-bakeoff use: base64 font payloads are noise.
const elide = (s: string): string => s.replace(/data:[a-zA-Z0-9/+;=,._-]{200,}/g, "data:ELIDED");

const extractPalette = (preamble: string): string[] => {
  const start = preamble.indexOf("const PALETTE");
  if (start === -1) return [];
  const close = preamble.indexOf("}", start);
  const block = preamble.slice(start, close === -1 ? start + 2000 : close);
  return [...new Set(block.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [])];
};

// ── prompts ──────────────────────────────────────────────────────────────────
// BASE = scripts/scene-spike.ts systemPrompt VERBATIM (the prompt that produced
// the thin 4.7/10 spike — conditions A-C reproduce it at three efforts).

const baseSystemPrompt = (preamble: string): string => `You BUILD one complete scene ("Section") of a 30-second animated brand video (1920x1080) as a SINGLE self-contained React component.

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

/**
 * The portable taste stack, ported from the production GLM prompt system
 * (lib/agents/prompts/design-agent.ts + lib/agents/design-constraints.ts),
 * ADAPTED to the spike's no-import whole-Section contract. ~3.5k tokens —
 * the "portable 80%" of the 35k-token asymmetry, condensed.
 */
const ENRICHMENT = `
TASTE SYSTEM — ported from the production design stack. Every line below has the same force as the HARD RULES above; production builds are REJECTED on violations.

## The density bar (NON-NEGOTIABLE)
Every section must carry at least 6-10 DISTINCT visual elements. A premium product-page section typically stacks ~15: eyebrow + display headline + lede + 3-4 meta/bullet items + 1-2 substantive content structures + 2-3 atmosphere layers + grain + brand chrome + a footer/meta row. If you can count fewer than 6, you are not done. Render EVERY content field provided (eyebrow, headline, lede, every bullet, caption, cta) — a present-but-unrendered field is a broken layout.

## Anti-void / anti-barbell (negative space is EARNED, not a default)
If more than ~40% of the frame is bare background with no structure, the composition is under-scaled. Fix BOTH ways: (a) scale the hero up — the hero number/mock/visual should command 30-50% of the canvas (≥320px tall on 16:9), never float small and centered; and (b) add REAL supporting structure toward the edges: a chart/sparkline, KPI tiles, a labeled grid, a baseline rule, an aligned caption/meta row. Faint atmosphere (glow, drift dots, grain) does NOT count as filling the frame — it is backdrop, not content. Anchor real content (caption row, meta footer, chart base, CTA) into the LOWER THIRD (top ≥ 670px) — an empty lower band is flagged. Primary content elements ≤1760px wide; left+width ≤1920.

## Diegetic mock interiors — what goes INSIDE a mock (the empty-container rule)
A mock (app window, browser, dashboard, phone, terminal) whose interior is an empty or sparsely-filled box is REJECTED. EVERY mock ships at least 6 labeled interior elements, drawn from this vocabulary (all buildable as plain divs/spans/SVG — no imports needed):
- window/browser header: traffic-light dots + URL/title bar with a REAL address ("app.hubspot.com")
- sidebar nav: 4-6 icon+label rows, ONE active (accent left-rail or fill)
- filled data rows: ≥3 rows of name + value + status chip ("Renewal — Acme Corp · $12,400 · Won")
- KPI tiles: number + label + delta ("47 deals · +12% WoW"), 2-4 tiles in a row
- a small chart: 5-8 bars or a sparkline drawn as divs/SVG, with 2-3 axis/series labels
- activity feed / inbox lines: avatar-initial circle + one-line message + timestamp
- status pills (Live/Pending/Won), tabs with one active, toggles, checkbox rows, kanban columns with 2-3 cards, table with header + 4-6 rows, timeline dots, funnel bars
NO PLACEHOLDER DATA — every price, stat, metric, and label inside a mock is a CONCRETE literal value (invented-but-specific diegetic detail is ENCOURAGED: "$128.00", "Meeting booked · 2:30 PM", "1,204 contacts"). Masked or unresolved values — "$•••.00", "XX%", "Loading", "TBD", lorem, blank grey slab-bars standing in for text — are REJECTED; they render as a broken half-loaded product. Interior mock text is diegetic chrome: 11-16px is correct there (realism over legibility inside the prop).

## Signature animated hero elements (pick one when the message invites it)
Hand-code at hero size (140-280px) in brand colors with self-contained @keyframes: analog clock (rotating hands), radial gauge (needle swings to value), progress ring (stroke-dashoffset draw), map with connection arcs (stroke-dashoffset draw-in + pulsing endpoint dots), orbit/satellite rings, signal pulse (expanding fading rings), pipeline flow (nodes + a bright dot traveling the edges), bar chart draw-in (scaleY from 0, staggered). These read as "they BUILT this", not "text on a card".

## Scene register → layout archetype (anti-repetition — the #1 AI-slop tell is one template repeated)
The scene's register names its SHAPE — honor it with a DISTINCT archetype:
- stat — ONE massive number/metric (200-360px) dominates; TWO-TONE, never flat: magnitude in display face + ink, the unit/suffix or key digit in the SIGNATURE accent. Pair it with supporting structure (thin baseline rule, sparkline, delta chip, small label cluster) so it is not marooned in negative space. A stat scene is a KPI hero, not a card grid.
- list — a REAL list: 3-5 marker/pill/numbered rows or a labeled grid, one marker per row — NOT prose, NOT a paragraph.
- split — asymmetric: editorial copy stack one side, substantive diegetic prop (mock/chart/animated element) the other.
- quote — large centered pull-quote (60-110px), generous margins, small attribution.
- full-bleed — edge-to-edge color field/image, text on a scrim.
- centered — centered headline + lede; the default, so do NOT overuse it.
Adjacent scenes MUST NOT share an archetype. The archetype changes the whole composition, not just one element.

## Atmosphere MENU + variety (the monotone-atmosphere rule)
Build atmosphere as 2-3 LAYERS chosen from this menu — the preamble's RadialGlow/GrainOverlay/DriftDot are shortcuts, but you MAY (and should, for variety) build scene-local atmosphere layers from plain divs/SVG with scene-local @keyframes appended to the style string: multi-stop gradient backdrop · drifting accent dots · orbital rings · faint vertical light rays · vignette glow · parallax bands · grain · floating embers · a slow linear-gradient shimmer sweep. ADJACENT SCENES MUST NOT REUSE THE SAME ATMOSPHERE COMBINATION — pick the combination that matches THIS scene's register and story beat (chaos scenes: scattered/dissonant layers; resolution scenes: ordered/converging layers). Include ≥2 infinite-loop animations on decorative layers (gradient pulse 4s, drift 9-11s, shimmer 8s, card breathe 5s) so the scene never freezes after entry.

## Taste contract (reviewed scene-by-scene in production)
- In any grid of 3+ same-size cards exactly ONE is featured (larger/live/dominant) — a uniform grid is decoration, not design.
- A card interior is canvas too: no card may be a mostly-empty box; every card carries real content.
- A chart earns its place: it ships with axis/series labels at a size where the data reads (roughly a quarter of the canvas or more) — otherwise omit it.
- TEXT FLOORS (canvas-level copy, not mock interiors): any <p> with inline fontSize ≥24px, any <li> ≥18px. Mono/eyebrow caption chrome is exempt when it reads as chrome (letterSpacing ≥0.12em, uppercase, or mono).
- ACCENT DISCIPLINE: the signature brand color borders AT MOST 4 elements per section — it marks THE focal element; give non-focal containers neutral hairlines.
- Icons/ornaments are ANCHORED, never free-floating in empty canvas: every glyph lives inside a bullet row, card, tile, or label cluster.
- NO WEB CHROME on the canvas: no website nav bars, pagination dots, cookie banners, scroll indicators. Browser/phone chrome lives ONLY inside an explicit diegetic device mock.`;

interface ScriptScene {
  index: number;
  label: string;
  register?: string;
  description?: string;
  visual_concept?: string;
  start_seconds?: number;
  end_seconds?: number;
  content: Record<string, unknown>;
}
interface Script {
  scenes: ScriptScene[];
  narrative?: { throughline?: string; arc?: string; logline?: string };
  config?: { aspect_ratio?: string };
  assets?: unknown;
}

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

const userPrompt = (script: Script, i: number, exemplar: string): string => {
  const s = script.scenes[i];
  const parts = [
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
  ];
  if (exemplar) {
    parts.push(
      ``,
      exemplar,
      ``,
      `EXEMPLAR NOTE: the exemplar above is from a DIFFERENT build — its const names (SHARED_CSS, ANIMATIONS_CSS, PALETTE.bgDeep, …) do NOT exist here. Match its DENSITY, structural completeness, and fill-the-frame composition — not its content, names, or colors. YOUR output contract is unchanged: this preamble's consts only, no imports.`,
    );
  }
  parts.push(``, `Emit ONLY the complete \`export const Section${i}\` component.`);
  return parts.join("\n");
};

const repairPrompt = (i: number, code: string, error: string): string => [
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

// ── validation / stubs ───────────────────────────────────────────────────────

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

/** Bare-canvas stub for the scenes this matrix does not exercise (0, 3, 4) —
 *  the tail's Generated mounts all five Sections, so all five must exist. */
const stubSection = (i: number): string =>
  `export const Section${i}: React.FC<{ script: Script }> = () => (\n` +
  `  <div data-scene={${i}} style={{ ...SECTION_FRAME, background: PALETTE.canvas }} />\n` +
  `);`;

// ── conditions ───────────────────────────────────────────────────────────────

interface Condition {
  id: string;
  label: string;
  enriched: boolean;
  effort: CastEffort;
  exemplar: boolean;
}
const CONDITIONS: Condition[] = [
  { id: "A", label: "spike prompt · effort low (baseline)", enriched: false, effort: "low", exemplar: false },
  { id: "B", label: "spike prompt · effort medium", enriched: false, effort: "medium", exemplar: false },
  { id: "C", label: "spike prompt · effort high", enriched: false, effort: "high", exemplar: false },
  { id: "D", label: "enriched prompt · effort low", enriched: true, effort: "low", exemplar: false },
  { id: "E", label: "enriched prompt · effort medium", enriched: true, effort: "medium", exemplar: false },
  { id: "F", label: "enriched + exemplar · effort medium", enriched: true, effort: "medium", exemplar: true },
];

interface CellStat {
  cond: string;
  scene: number;
  ok: boolean;
  placeholder: boolean;
  repaired: boolean;
  secs: number;
  inputTokens: number;
  outputTokens: number;
  codeChars: number;
  thinkingChars: number;
  stopReason: string | null;
  hueLocked: number;
  failReason?: string;
}

let castCalls = 0;
const CALL_BUDGET = 25;
const budgetedCall = async (args: Parameters<typeof castCall>[0]): Promise<CastResult> => {
  if (castCalls >= CALL_BUDGET) throw new Error(`call budget (${CALL_BUDGET}) exhausted`);
  castCalls++;
  return castCall(args);
};

const generateCell = async (
  script: Script,
  cond: Condition,
  system: string,
  exemplarBlock: string,
  palette: string[],
  i: number,
): Promise<{ code: string; stat: CellStat }> => {
  const stat: CellStat = {
    cond: cond.id, scene: i, ok: false, placeholder: false, repaired: false,
    secs: 0, inputTokens: 0, outputTokens: 0, codeChars: 0, thinkingChars: 0,
    stopReason: null, hueLocked: 0,
  };
  const t0 = Date.now();
  const account = (r: CastResult) => {
    stat.inputTokens += r.inputTokens;
    stat.outputTokens += r.outputTokens;
    stat.thinkingChars += r.thinking.length;
    stat.stopReason = r.stopReason;
  };

  let code = "";
  try {
    const first = await budgetedCall({
      system,
      user: userPrompt(script, i, cond.exemplar ? exemplarBlock : ""),
      maxTokens: MAX_TOKENS,
      effort: cond.effort,
    });
    account(first);
    code = stripCodeFence(first.text);
    const e1 = await sectionError(i, code);
    if (e1 === null) {
      stat.ok = true;
    } else {
      console.warn(`  ${cond.id}/scene${i}: compile fail — repairing (${e1.split("\n")[0]})`);
      const fix = await budgetedCall({
        system, user: repairPrompt(i, code, e1), maxTokens: MAX_TOKENS, effort: cond.effort,
      });
      account(fix);
      const fixed = stripCodeFence(fix.text);
      const e2 = await sectionError(i, fixed);
      stat.repaired = true;
      if (e2 === null) {
        code = fixed;
        stat.ok = true;
      } else {
        stat.failReason = `after repair: ${e2.split("\n")[0]}`;
      }
    }
  } catch (e) {
    stat.failReason = `call failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`;
  }

  if (!stat.ok) {
    code = placeholderSection(i, stat.failReason ?? "unknown failure");
    stat.placeholder = true;
  } else if (palette.length > 0) {
    const norm = normalizeElementColors(code, palette);
    code = norm.code;
    stat.hueLocked = norm.changes.reduce((n, c) => n + c.count, 0);
  }
  stat.codeChars = code.length;
  stat.secs = (Date.now() - t0) / 1000;
  return { code, stat };
};

// ── density metrics (the SOURCE-0 thinness symptoms, quantified) ─────────────

const SVG_PRIMS = new Set(["path", "rect", "circle", "line", "ellipse", "polyline", "polygon"]);

interface Density {
  domEls: number;
  diegeticInterior: number;
  textEls: number;
  svgRoots: number;
  svgPrims: number;
  pieces: number;
  error?: string;
}

const densityOf = (m: SceneMeasurement | undefined): Density => {
  if (!m || m.error) {
    return { domEls: 0, diegeticInterior: 0, textEls: 0, svgRoots: 0, svgPrims: 0, pieces: 0, error: m?.error ?? "no measurement" };
  }
  const els = m.elements;
  return {
    domEls: els.length,
    diegeticInterior: els.filter((e) => e.pieceKind === "diegetic").length,
    textEls: els.filter((e) => e.text).length,
    svgRoots: els.filter((e) => e.tag === "svg").length,
    svgPrims: els.filter((e) => SVG_PRIMS.has(e.tag)).length,
    pieces: new Set(els.map((e) => e.piece).filter(Boolean)).size,
  };
};

/** Density parity vs the reference: mean of the two symptom ratios, capped at 2. */
const parityOf = (d: Density, ref: Density): number => {
  const r = (a: number, b: number) => (b > 0 ? Math.min(a / b, 2) : 1);
  return (r(d.domEls, ref.domEls) + r(d.diegeticInterior, ref.diegeticInterior)) / 2;
};

// ── compose + render one condition ───────────────────────────────────────────

const composeAndMeasure = async (
  condId: string,
  codes: Map<number, string>,
  manifest: Manifest,
  script: Script,
): Promise<{ measurements: SceneMeasurement[]; compileError: string | null }> => {
  const sections = [0, 1, 2, 3, 4]
    .map((i) => (codes.has(i) ? codes.get(i)!.trim() : stubSection(i)))
    .join("\n\n");
  const preamble = manifest.preamble;
  const composition = preamble + (preamble.endsWith("\n") ? "" : "\n") + sections + "\n\n" + manifest.tail;
  const compileError = await verifyCompilable(composition);
  if (compileError) console.error(`  ${condId}: COMPOSITION DOES NOT COMPILE: ${compileError.split("\n")[0]}`);

  const genDir = path.join(GEN_ROOT, condId);
  await fs.rm(genDir, { recursive: true, force: true });
  await fs.mkdir(genDir, { recursive: true });
  await fs.writeFile(path.join(genDir, "Composition.tsx"), composition, "utf8");
  for (const shim of ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"]) {
    await fs.copyFile(path.join(REF_DIR, shim), path.join(genDir, shim)).catch(() => {});
  }
  await fs.copyFile(path.join(REF_DIR, "script.json"), path.join(genDir, "script.json")).catch(() => {});

  const measurements = await measureScenes(genDir, script, genDir);
  return { measurements, compileError };
};

// ── gallery ──────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Row {
  cond: Condition | null; // null = reference row
  cells: {
    scene: number;
    png: string;
    density: Density;
    parity: number;
    stat?: CellStat;
    renderError?: string;
  }[];
}

const galleryHtml = (rows: Row[], refDensities: Map<number, Density>, report: Record<string, unknown>): string => {
  const cost = report.cost as { usd: number; inputTokens: number; outputTokens: number };
  const sceneLabels: Record<number, string> = { 1: "scene 1 — The Tool Chaos (list)", 2: "scene 2 — The Turn (stat)" };

  const summaryRows = rows
    .map((row) => {
      const name = row.cond ? `${row.cond.id} — ${esc(row.cond.label)}` : "REFERENCE (GLM-5.2 production build)";
      const cells = row.cells
        .map((c) => {
          const d = c.density;
          const tok = c.stat ? `${c.stat.outputTokens}` : "—";
          const secs = c.stat ? c.stat.secs.toFixed(1) : "—";
          return `<td>${tok}</td><td>${secs}</td><td>${d.domEls}</td><td>${d.diegeticInterior}</td><td>${d.svgRoots}/${d.svgPrims}</td><td>${d.textEls}</td><td class="${c.parity >= 0.8 ? "hit" : "miss"}">${(c.parity * 100).toFixed(0)}%</td>`;
        })
        .join("");
      return `<tr><th>${name}</th>${cells}</tr>`;
    })
    .join("\n");

  const grid = rows
    .map((row) => {
      const title = row.cond ? `${row.cond.id} — ${esc(row.cond.label)}` : "REFERENCE — GLM-5.2 production build (the ~9/10 bar)";
      const cells = row.cells
        .map((c) => {
          const d = c.density;
          const visual = c.renderError
            ? `<div class="err">RENDER FAILED<br><span>${esc(c.renderError)}</span></div>`
            // The condition lives on the ROW, not the cell (cells carry only
            // scene-level measurements). Reading `c.cond` made every alt text
            // read "ref scene N" no matter which condition rendered it.
            : `<a href="${c.png}" target="_blank"><img src="${c.png}" alt="${row.cond?.id ?? "ref"} scene ${c.scene}"></a>`;
          const statBits = [
            c.stat ? `${c.stat.secs.toFixed(1)}s · ${c.stat.outputTokens} tok out (${c.stat.codeChars} code chars)` : "reference build",
            `${d.domEls} DOM els · ${d.diegeticInterior} diegetic-interior · ${d.svgRoots} svg (${d.svgPrims} prims) · ${d.textEls} text els`,
            `density vs ref: ${(c.parity * 100).toFixed(0)}%` +
              (c.stat?.repaired ? " · repaired" : "") +
              (c.stat?.placeholder ? ` · PLACEHOLDER (${esc(c.stat.failReason ?? "")})` : "") +
              (c.stat?.hueLocked ? ` · ${c.stat.hueLocked} hue-locked` : "") +
              (c.stat?.stopReason && c.stat.stopReason !== "stop" ? ` · stop=${esc(c.stat.stopReason)}` : ""),
          ];
          return `<div class="cell"><div class="cell-title">${esc(sceneLabels[c.scene] ?? String(c.scene))}</div>${visual}<div class="stat">${statBits.map(esc).join("<br>")}</div></div>`;
        })
        .join("\n");
      return `<div class="cond"><h2>${title}</h2><div class="row2">${cells}</div></div>`;
    })
    .join("\n");

  const ref1 = refDensities.get(1)!;
  const ref2 = refDensities.get(2)!;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audit matrix — prompt stack × effort on gpt-oss-120b</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; }
  h2 { font-size: 14px; font-weight: 700; margin: 26px 0 8px; color: #cfd0d6; font-family: ui-monospace, Menlo, monospace; }
  .sub { font-family: ui-monospace, Menlo, monospace; color: #9a9aa3; margin: 8px 0 18px; font-size: 12px; }
  table { border-collapse: collapse; margin: 10px 0 6px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  th, td { border: 1px solid #26272e; padding: 5px 8px; text-align: right; }
  th { text-align: left; color: #a9aab3; font-weight: 600; }
  thead th { text-align: right; }
  thead th:first-child { text-align: left; }
  td.hit { color: #3ecf8e; font-weight: 700; }
  td.miss { color: #e0a24a; }
  .row2 { display: grid; grid-template-columns: repeat(2, minmax(360px, 760px)); gap: 14px; align-items: start; }
  .cell { background: #16171c; border: 1px solid #26272e; border-radius: 8px; padding: 8px; }
  .cell-title { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-bottom: 6px; }
  .cell img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 4px; background: #000; }
  .cell a { display: block; }
  .stat { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-top: 8px; }
  .err { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
         border: 2px dashed #e0245e; border-radius: 4px; color: #e0245e; font-weight: 700; text-align: center; padding: 12px; }
  .err span { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 400; color: #b06; word-break: break-word; }
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 1100px; }
</style>
</head>
<body>
  <h1>Audit matrix — prompt stack × reasoning effort, gpt-oss-120b vs the GLM reference</h1>
  <div class="sub">ref ${esc(String(report.ref))} · model ${esc(String(report.model))} · ${castCalls} Cerebras calls · ${cost.inputTokens} in / ${cost.outputTokens} out tok · projected $${cost.usd.toFixed(4)} · generated ${esc(String(report.generatedAt))}</div>
  <table>
    <thead><tr><th>condition</th>
      <th>s1 tok</th><th>s1 secs</th><th>s1 DOM</th><th>s1 dieg</th><th>s1 svg</th><th>s1 text</th><th>s1 vs ref</th>
      <th>s2 tok</th><th>s2 secs</th><th>s2 DOM</th><th>s2 dieg</th><th>s2 svg</th><th>s2 text</th><th>s2 vs ref</th>
    </tr></thead>
    <tbody>
${summaryRows}
    </tbody>
  </table>
  <div class="sub">reference bar: scene 1 = ${ref1.domEls} DOM / ${ref1.diegeticInterior} diegetic-interior els · scene 2 = ${ref2.domEls} DOM / ${ref2.diegeticInterior} diegetic-interior els. "vs ref" = mean of DOM-element and diegetic-interior ratios vs the reference scene (capped 200%); ≥80% (green) = reference-grade density.</div>
${grid}
  <div class="foot">
    Six conditions, one whole-Section Cerebras call per cell, identical scene content and design-system preamble (the
    01KXEAF0… reference build's). A-C = the full-spike prompt verbatim at effort low/medium/high. D-E = the ENRICHED
    prompt (portable production taste stack: density bar, anti-void, diegetic-interior checklist, register→archetype map,
    atmosphere menu + variety, taste contract) at low/medium. F = enriched + one register-matched sanitized golden-scene
    exemplar. Every cell: hue-lock → compile (1 repair) → composed with the real preamble/tail → production render-truth
    path (settled-state 1920×1080) → DOM-walk density metrics. Cost projected at $${USD_PER_M_IN}/M in, $${USD_PER_M_OUT}/M out.
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/audit-matrix.mjs");
    process.exitCode = 1;
    return;
  }
  const tRun = Date.now();
  const model = process.env.RB_CAST_MODEL || "gpt-oss-120b";

  const manifest: Manifest = JSON.parse(await fs.readFile(path.join(REF_DIR, "lego", "manifest.json"), "utf8"));
  const script: Script = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));
  const palette = extractPalette(manifest.preamble);
  const baseSystem = baseSystemPrompt(elide(manifest.preamble.trim()));
  const enrichedSystem = baseSystem + "\n\n" + ENRICHMENT.trim();

  // Register-matched golden exemplars (production QA-2 pattern) for condition F.
  const exemplarBySc = new Map<number, string>();
  for (const i of SCENES) {
    exemplarBySc.set(i, exemplarPromptBlock([script.scenes[i].register]));
  }
  console.log(
    `prompt sizes (chars): base system ${baseSystem.length} · enriched ${enrichedSystem.length} · ` +
      SCENES.map((i) => `exemplar s${i} ${exemplarBySc.get(i)?.length ?? 0}`).join(" · "),
  );

  await fs.mkdir(OUT_DIR, { recursive: true });

  // Canary: transport + key + model proof before spending matrix calls.
  console.log(`canary call (${model}) …`);
  const canary = await budgetedCall({
    system: "You are a connectivity canary. Reply with exactly: OK",
    user: "Reply with exactly: OK",
    maxTokens: 256,
    effort: "low",
  });
  console.log(`canary ok — ${canary.seconds.toFixed(1)}s, ${canary.outputTokens} tok out, stop=${canary.stopReason}`);

  // ── generate: conditions sequential, the 2 scenes of a condition parallel ──
  const allStats: CellStat[] = [];
  const codeByCell = new Map<string, string>(); // `${cond}:${scene}`
  for (const cond of CONDITIONS) {
    const system = cond.enriched ? enrichedSystem : baseSystem;
    console.log(`condition ${cond.id} (${cond.label}) — firing ${SCENES.length} calls …`);
    const results = await Promise.all(
      SCENES.map((i) => generateCell(script, cond, system, exemplarBySc.get(i) ?? "", palette, i)),
    );
    for (const r of results) {
      allStats.push(r.stat);
      codeByCell.set(`${cond.id}:${r.stat.scene}`, r.code);
      console.log(
        `  ${cond.id}/scene${r.stat.scene}: ${r.stat.placeholder ? "PLACEHOLDER" : "ok"} · ${r.stat.secs.toFixed(1)}s · ` +
          `${r.stat.outputTokens} tok out · ${r.stat.codeChars} code chars` +
          `${r.stat.repaired ? " · repaired" : ""}${r.stat.hueLocked ? ` · ${r.stat.hueLocked} hue-locked` : ""}` +
          `${r.stat.stopReason && r.stat.stopReason !== "stop" ? ` · stop=${r.stat.stopReason}` : ""}`,
      );
    }
  }
  console.log(`generation done — ${castCalls} Cerebras calls total`);

  // ── render: reference first (the bar), then each condition ────────────────
  console.log("measuring REFERENCE build scenes (the GLM bar) …");
  const refOut = path.join(GEN_ROOT, "reference");
  await fs.rm(refOut, { recursive: true, force: true });
  await fs.mkdir(refOut, { recursive: true });
  const refMeasurements = await measureScenes(REF_DIR, script, refOut);
  const refDensities = new Map<number, Density>();
  for (const i of SCENES) {
    const m = refMeasurements.find((mm) => mm.scene === i);
    refDensities.set(i, densityOf(m));
    const shot = path.join(refOut, `measure-scene-${i}.png`);
    await fs.copyFile(shot, path.join(OUT_DIR, `ref-scene${i}.png`)).catch(() => {});
    const d = refDensities.get(i)!;
    console.log(`  ref/scene${i}: ${d.domEls} DOM els · ${d.diegeticInterior} diegetic-interior · ${d.svgRoots} svg · ${d.textEls} text${d.error ? ` · ERROR ${d.error}` : ""}`);
  }

  // Reference per-section code size (chars), sliced from the real Composition.
  const refComp = await fs.readFile(path.join(REF_DIR, "Composition.tsx"), "utf8");
  const refCodeChars = new Map<number, number>();
  for (const i of SCENES) {
    const a = refComp.indexOf(`export const Section${i}`);
    const b = refComp.indexOf(`export const Section${i + 1}`);
    refCodeChars.set(i, a === -1 ? 0 : (b === -1 ? refComp.length : b) - a);
  }

  const rows: Row[] = [];
  const condReports: Record<string, unknown>[] = [];
  for (const cond of CONDITIONS) {
    console.log(`rendering condition ${cond.id} …`);
    const codes = new Map<number, string>(SCENES.map((i) => [i, codeByCell.get(`${cond.id}:${i}`) ?? stubSection(i)]));
    const { measurements, compileError } = await composeAndMeasure(cond.id, codes, manifest, script);
    const cells: Row["cells"] = [];
    for (const i of SCENES) {
      const m = measurements.find((mm) => mm.scene === i);
      const density = densityOf(m);
      const png = `${cond.id}-scene${i}.png`;
      const shot = path.join(GEN_ROOT, cond.id, `measure-scene-${i}.png`);
      const exists = await fs.stat(shot).then(() => true).catch(() => false);
      if (exists) await fs.copyFile(shot, path.join(OUT_DIR, png));
      const stat = allStats.find((s) => s.cond === cond.id && s.scene === i);
      const parity = parityOf(density, refDensities.get(i)!);
      cells.push({ scene: i, png, density, parity, stat, renderError: !exists ? (m?.error ?? "no screenshot") : undefined });
      console.log(
        `  ${cond.id}/scene${i}: ${density.domEls} DOM els · ${density.diegeticInterior} diegetic-interior · ` +
          `${density.svgRoots} svg · ${density.textEls} text · parity ${(parity * 100).toFixed(0)}%${density.error ? ` · ERROR ${density.error}` : ""}`,
      );
    }
    rows.push({ cond, cells });
    condReports.push({
      id: cond.id, label: cond.label, enriched: cond.enriched, effort: cond.effort, exemplar: cond.exemplar,
      compileError,
      cells: cells.map((c) => ({
        scene: c.scene, parityVsRef: Number(c.parity.toFixed(3)), density: c.density,
        stat: c.stat, renderError: c.renderError,
      })),
    });
  }

  // Reference row (no stat — it is the bar).
  rows.push({
    cond: null,
    cells: SCENES.map((i) => ({
      scene: i,
      png: `ref-scene${i}.png`,
      density: refDensities.get(i)!,
      parity: 1,
      renderError: refDensities.get(i)!.error,
    })),
  });

  // ── report ─────────────────────────────────────────────────────────────────
  const inputTokens = canary.inputTokens + allStats.reduce((n, s) => n + s.inputTokens, 0);
  const outputTokens = canary.outputTokens + allStats.reduce((n, s) => n + s.outputTokens, 0);
  const usd = (inputTokens * USD_PER_M_IN + outputTokens * USD_PER_M_OUT) / 1e6;
  const report: Record<string, unknown> = {
    experiment: "audit-matrix: prompt stack (spike vs enriched vs +exemplar) × reasoning effort, 2 scenes each",
    ref: REF_BUILD,
    model,
    maxTokensPerCall: MAX_TOKENS,
    generatedAt: new Date().toISOString(),
    castCalls,
    scenes: SCENES,
    reference: Object.fromEntries(
      [...refDensities.entries()].map(([i, d]) => [`scene${i}`, { ...d, codeChars: refCodeChars.get(i) }]),
    ),
    conditions: condReports,
    promptChars: { base: baseSystem.length, enriched: enrichedSystem.length, exemplars: Object.fromEntries([...exemplarBySc.entries()].map(([i, e]) => [`scene${i}`, e.length])) },
    cost: { inputTokens, outputTokens, usdPerMIn: USD_PER_M_IN, usdPerMOut: USD_PER_M_OUT, usd },
    wallTotalSeconds: (Date.now() - tRun) / 1000,
  };
  await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(path.join(OUT_DIR, "index.html"), galleryHtml(rows, refDensities, report), "utf8");

  console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
  console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
  console.log(
    `wall ${(report.wallTotalSeconds as number).toFixed(1)}s · ${castCalls} calls · ` +
      `${inputTokens} in / ${outputTokens} out tok · $${usd.toFixed(4)} projected`,
  );
};

await main();
