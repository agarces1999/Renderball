/**
 * CAST ORCHESTRATOR — the element-cast build path on the Cerebras provider
 * (speed-quality pivot, 2026-07-14).
 *
 * Doctrine: elements generate INDEPENDENTLY and in parallel against
 * PRE-SETTLED contracts — correctness comes from construction, not
 * detect-and-retry. This module owns no cleverness of its own; it sequences
 * the modules that each make one defect class unrepresentable:
 *
 *   - layout-composer  settles every element's territory (bounds, content
 *     ownership, palette roles, declared overlaps) BEFORE any code exists,
 *     so two blind generators can never claim the same pixels.
 *   - cast-provider    is the transport (OpenAI-wire, tight token caps,
 *     effort dial — "think at the head, emit at the leaves").
 *   - normalize-element hue-locks every emitted color into the brand's
 *     vocabulary, so off-brand hues cannot ship.
 *   - assemble         re-inlines the bodies into the exact Composition.tsx
 *     contract the whole validated render stack consumes.
 *   - choreograph      compiles motion deterministically (zero tokens),
 *     pacing correct by construction.
 *
 * COMPOSITION CONSUMPTION (2026-07-16): when a scene carries a
 * SceneComposition blueprint (authored by composition-head.ts, attached as
 * scene.composition), element briefs LEAD with it — subject + verbatim
 * interior inventory + explicit copy ownership + motion beat — and the
 * generic checklist/archetype/menu text stays out. Spec presence also
 * OVERRIDES the connector keyword heuristic and strengthens the unowned-copy
 * guard's ownership inputs. Scenes without a composition build exactly as
 * before (back-compat by construction).
 *
 * On top of the sequencing, this module owns the DETERMINISTIC POST-PASSES
 * that close the four measured gpt-oss defect classes (cast spike run 1 +
 * parity audit, 2026-07-15) at zero tokens: `${keyframe}` interpolation
 * rewrite, canvas-scale self-positioning rebase, unowned-copy strip, and the
 * paint-time color-mutation (invert/hue-rotate) guard. Same doctrine as
 * normalize-element: rewrite the defect out, don't ask nicely and retry.
 *
 * Failure posture: an element that stays broken after ONE surgical repair is
 * substituted with a minimal safe placeholder and COUNTED — the build
 * completes degraded rather than dying, and telemetry reports it honestly.
 * A final composition that does not compile, by contrast, THROWS: that is an
 * orchestrator bug, never a runtime condition.
 */
import type { Script, ElementSpec } from "../../src/schema";
import type { Theme, SceneManifest, Piece } from "../edit/piece-model";
import { castCall, type CastEffort } from "../llm/cast-provider";
import { composeSceneLayout, CANVAS, type Aspect, type ElementSlot, type ScenePlan } from "./layout-composer";
import { normalizeElementColors, assessAccentPresence } from "./normalize-element";
import { assembleComposition } from "./assemble";
import { applyChoreography } from "./choreograph";
import { stripCodeFence, verifyCompilable } from "./code-extraction";
import { AccountLimiter } from "./account-limiter";

// ─── Public contract ────────────────────────────────────────────────────────

export interface CastBuildInput {
  /** From the existing script agent — unchanged by the cast path. */
  script: Script;
  /** The frozen design system. The caller supplies it (head workload / stored
   *  theme); the orchestrator never derives one. */
  theme: Theme;
  /** Brand hex palette — the hue vocabulary normalize-element locks to. */
  palette: string[];
  /** Brand signature hex; drives the accent-presence check (detection only). */
  signatureAccent?: string;
  aspect: Aspect;
}

export interface CastBuildResult {
  /** Final Composition.tsx — assembled, choreographed, compile-verified. */
  code: string;
  /** The manifests the assembler consumed (piece ids, bounds, slugs). */
  scenes: SceneManifest[];
  telemetry: {
    /** Non-chrome slots that earned a generation call. */
    elements: number;
    /** Elements that ended as placeholders (broken through the one repair). */
    failures: number;
    /** Elements the ONE repair retry actually recovered. */
    repairs: number;
    /** Output tokens across every call, including failed + repair calls. */
    tokensOut: number;
    wallSeconds: number;
    /** Total off-brand color rewrites in shipped bodies ("what would have
     *  shipped off-brand"). */
    normalizedColors: number;
  };
}

// ─── Per-slot output ceilings ───────────────────────────────────────────────

/**
 * Honest per-slot output caps. Cerebras PRE-DEBITS max_completion_tokens
 * against the TPM bucket BEFORE generating (see cast-provider.ts) — a lazy
 * 40k cap on a 3k element starves the rest of the burst — so each slot gets
 * the measured shape of its workload and nothing more.
 */
const MAX_TOKENS_BY_SLOT: Record<string, number> = {
  atmosphere: 2000, // gradient washes / glow / grain — compact
  connector: 3000, // the full-bleed SVG connector system (≥12 primitives)
  copy: 2500, // the editorial text stack
  // The diegetic visual — the dense one. Enriched-brief mocks measured ~5.7k
  // tokens out at effort medium (audit-matrix condition E); Cerebras
  // pre-debits this cap against TPM, so 6000 is the honest measured shape,
  // not lazy headroom.
  hero: 6000,
  throughline: 1500, // one small motif
};
const maxTokensFor = (slotId: string): number => MAX_TOKENS_BY_SLOT[slotId] ?? 4000;

/**
 * Reasoning-effort routing, measured on gpt-oss (parity audit 2026-07-15):
 * effort MEDIUM is the sweet spot for DIEGETIC pieces — the enriched-brief
 * interior gain (3.3x) needs it. Effort HIGH is HARMFUL (≈80k reasoning chars,
 * broken markers) — never route anything there. LOW is fine for the
 * copy/atmosphere/throughline workloads ("think at the head, emit at the
 * leaves" — these leaves barely need to think).
 */
const EFFORT_BY_SLOT: Record<string, CastEffort> = {
  hero: "medium",
  connector: "medium",
};
const effortFor = (slotId: string): CastEffort => EFFORT_BY_SLOT[slotId] ?? "low";

// ─── Shared conventions ─────────────────────────────────────────────────────

/**
 * Mirrors pipeline.ts `slugify` — the slug the throughline presence/drift
 * gates count off `data-throughline`. Mirrored, not imported: pipeline.ts
 * pulls the SDK/store world and this module must stay a testable leaf (the
 * same reasoning layout-composer applies to CANVAS_DIMS).
 */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Palette-role → theme-const aliases. The composer speaks ROLES (canvas/ink/
 *  accent); the theme's palette keys are whatever const names the head emitted
 *  (BG, ACCENT, INK, …) — grammar carries the surface tokens explicitly. */
const ROLE_ALIASES: Record<string, string[]> = {
  canvas: ["bg", "canvas", "background"],
  ink: ["ink", "fg", "text"],
  accent: ["accent", "primary", "brand"],
};

/** Resolve a composer palette ROLE to the actual theme const NAME an element
 *  must paint with. grammar owns the surface tokens; the rest resolve by
 *  alias against the palette keys (exact match first, then substring),
 *  falling back to the first key so a sparse theme degrades, not dies. */
const tokenForRole = (theme: Theme, role: string): string => {
  if (role === "panelBg") return theme.grammar.panelBg;
  if (role === "hairline") return theme.grammar.hairline;
  const keys = Object.keys(theme.palette);
  for (const alias of ROLE_ALIASES[role] ?? [role.toLowerCase()]) {
    const hit =
      keys.find((k) => k.toLowerCase() === alias) ??
      keys.find((k) => k.toLowerCase().includes(alias));
    if (hit) return hit;
  }
  return keys[0];
};

// ─── Deterministic post-passes ──────────────────────────────────────────────
// Each pass makes one MEASURED gpt-oss element defect unrepresentable, at zero
// tokens, before the fragment gate runs. Exported for tests.

/**
 * (a) Keyframe-interpolation rewrite. gpt-oss generalizes the palette-const
 * pattern to the shared @keyframes names and emits
 * `animation: \`${fadeRise} 0.6s …\`` — a JS identifier interpolation. It
 * PASSES esbuild (the fragment gate binds no identifiers) but throws
 * ReferenceError the moment a Section renders, killing every scene — 54 hits
 * in cast-spike run 1 (scripts/cast-spike.ts, where this rewrite was proven
 * spike-side). `${name}` → the literal CSS name, for every name declared in
 * the theme's shared keyframes or in the body itself.
 */
export const rewriteKeyframeInterpolations = (
  body: string,
  themeKeyframes: string,
): { code: string; rewrites: number } => {
  const names = new Set<string>();
  for (const src of [themeKeyframes, body]) {
    for (const m of src.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) names.add(m[1]);
  }
  let rewrites = 0;
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue; // hyphenated names can't be `${}` refs
    body = body.replace(new RegExp(`\\$\\{\\s*${n}\\s*\\}`, "g"), () => {
      rewrites++;
      return n;
    });
  }
  return { code: body, rewrites };
};

/**
 * (b) Self-positioning strip. The contract says the WRAPPER owns placement —
 * an element that absolutely positions its own root at CANVAS coordinates
 * (left/top too large to be a local offset inside its own w×h wrapper) gets
 * double-offset and paints outside its slot. Rebase such a root to the
 * wrapper origin; the wrapper (assemble.ts) already sits at the slot's canvas
 * position. Local offsets (left/top within the wrapper's extent) pass through.
 */
export const stripCanvasSelfPositioning = (
  body: string,
  bounds: { w: number; h: number },
): { code: string; stripped: boolean } => {
  const start = body.indexOf("<");
  if (start === -1) return { code: body, stripped: false };
  // Find the root tag's closing ">" with a brace/quote-aware scan — style
  // expressions legally contain ">" (arrow fns, comparisons).
  let depth = 0;
  let quote: string | null = null;
  let tagEnd = -1;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) {
      tagEnd = i;
      break;
    }
  }
  if (tagEnd === -1) return { code: body, stripped: false };
  const rootTag = body.slice(start, tagEnd);
  if (!/position\s*:\s*["'`]absolute["'`]/.test(rootTag)) return { code: body, stripped: false };
  const num = (prop: string): number | null => {
    const m = new RegExp(`\\b${prop}\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)(?:px)?"?`).exec(rootTag);
    return m ? Number(m[1]) : null;
  };
  const left = num("left");
  const top = num("top");
  // Canvas-scale: an offset no local child could have inside this wrapper.
  const canvasScale = (left !== null && left > bounds.w) || (top !== null && top > bounds.h);
  if (!canvasScale) return { code: body, stripped: false };
  const rebased = rootTag
    .replace(/\bleft\s*:\s*"?-?\d+(?:\.\d+)?(?:px)?"?/, "left: 0")
    .replace(/\btop\s*:\s*"?-?\d+(?:\.\d+)?(?:px)?"?/, "top: 0");
  return { code: body.slice(0, start) + rebased + body.slice(tagEnd), stripped: true };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * (c) Unowned-copy guard. Content-field ownership lives in the SLOT (layout
 * composer invariant d): a piece that renders another element's copy verbatim
 * forks the text — it paints twice, and a later content edit updates only the
 * owner. Where the offense is a text node EXACTLY equal to the unowned value
 * (the measured form — bare or a quoted string expression), strip it
 * deterministically; anything subtler stays in `residual` for the caller to
 * route to the surgical-repair retry with a verbatim error.
 */
export const stripUnownedCopy = (
  body: string,
  unownedValues: string[],
): { code: string; stripped: string[]; residual: string[] } => {
  const stripped: string[] = [];
  const residual: string[] = [];
  for (const value of unownedValues) {
    const v = value.trim();
    if (!v || !body.includes(v)) continue;
    const esc = escapeRegExp(v);
    const next = body
      .replace(new RegExp(`>\\s*${esc}\\s*<`, "g"), "><") // >VALUE<
      .replace(new RegExp(`>\\s*\\{\\s*(["'\`])${esc}\\1\\s*\\}\\s*<`, "g"), "><"); // >{"VALUE"}<
    if (next !== body) {
      stripped.push(v);
      body = next;
    }
    if (body.includes(v)) residual.push(v);
  }
  return { code: body, stripped, residual };
};

/**
 * (d) Paint-time color-mutation guard. `filter: invert(…)` / `hue-rotate(…)`
 * flip brand colors AFTER the hue-lock has run — the emitted hexes read
 * on-brand to normalize-element while painting off-brand pixels, invisibly to
 * the whole color stack. Strip those declarations; benign filters
 * (blur/drop-shadow/…) survive untouched.
 */
const MUTATING_FILTER = /(?:invert|hue-rotate)\s*\(/i;

export const stripColorMutationFilters = (body: string): { code: string; stripped: number } => {
  let stripped = 0;
  // Style-object form: filter: "…" / WebkitFilter: '…' / backdropFilter: `…`.
  // The optional trailing comma is consumed; a leftover trailing comma on the
  // previous prop is legal TSX either way.
  let out = body.replace(
    /\b(?:filter|WebkitFilter|backdropFilter)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)\s*,?/g,
    (m, val: string) => {
      if (!MUTATING_FILTER.test(val)) return m;
      stripped++;
      return "";
    },
  );
  // CSS-string form (inside appended keyframes / style strings).
  out = out.replace(
    /(?:-webkit-|backdrop-)?filter\s*:\s*[^;{}"'`\n]*(?:invert|hue-rotate)\s*\([^;{}]*;?/gi,
    () => {
      stripped++;
      return "";
    },
  );
  return { code: out, stripped };
};

// ─── The element system prompt ──────────────────────────────────────────────

/**
 * One shared system prompt for every element call — adapted from the bake-off
 * harness (scripts/model-bakeoff.mjs ELEMENT_SYSTEM) and tightened for
 * production:
 *   - the WRAPPER owns placement (the bake-off asked elements to self-position;
 *     under assemble.ts each body is inlined into a positioned wrapper div),
 *   - data-content-path values match choreograph.ts `fieldsOf` exactly
 *     (bullets.0, meta.0.value, cta.primary) — those are the selectors the
 *     deterministic motion rules target,
 *   - copy binds through `c` so text edits stay LLM-free (piece-model doctrine).
 */
const buildElementSystem = (theme: Theme): string => {
  const paletteLines = Object.entries(theme.palette)
    .map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`)
    .join("\n");
  const keyframeNames = [...theme.keyframes.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)].map(
    (m) => m[1],
  );
  const g = theme.grammar;
  return [
    `You CREATE one element ("piece") of an animated brand-video scene from a brief.`,
    `The scene's shared design system is already in scope as module consts. Emit ONLY the JSX for this ONE element.`,
    `HARD RULES:`,
    `- Output ONLY JSX — no imports, no exports, no prose, no markdown fence, nothing at module scope.`,
    `- Your JSX is inlined into a positioned wrapper div at the exact BOUNDS in the brief. FILL the wrapper (width/height 100%; text flows inside its max width). NEVER position yourself with canvas coordinates — the wrapper owns placement.`,
    `- Paint ONLY with the palette roles the brief grants, via the const names below. Never invent colors — off-vocabulary hues are rewritten.`,
    `- Copy renders VERBATIM from the \`c\` binding (this scene's content object): {c.headline}, {c.bullets[0]}, … Tag every copy node with the exact data-content-path the brief gives it. Never invent numbers or claims.`,
    `- CSS animation only, using ONLY the shared @keyframes names listed below${keyframeNames.length ? "" : " (none exist — emit static; the choreographer adds motion)"}. No Remotion hooks, no Math.random, no undefined components.`,
    `- Follow the design grammar: radii ${JSON.stringify(g.radiusScale)}, ${g.strokeWeight}px hairlines via ${g.hairline}, surfaces via ${g.panelBg}, shadow "${g.shadowRecipe}", ${g.dataFont === "mono" ? "FONT_MONO" : "FONT_BODY"} for data.`,
    `- Rich, production-grade, dense — an element of a premium brand video.`,
    `- Valid TSX that compiles when inlined as a JSX child.`,
    `IN SCOPE: the palette consts below; FONT_DISPLAY / FONT_BODY / FONT_MONO; GRAMMAR (frozen); lastWordAccent(text, color); <Img>; \`c\` (scene content).`,
    `PALETTE CONSTS:`,
    paletteLines,
    keyframeNames.length ? `SHARED @keyframes: ${keyframeNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

// ─── Enriched brief blocks ──────────────────────────────────────────────────
// Ported from scripts/audit-matrix.ts's ENRICHED prompt (conditions D/E) — the
// live experiment measured this taste stack 3.3x-ing mock-interior density on
// gpt-oss, and reference-grade scenes run up to 87 interior elements. Adapted
// per element kind: diegetic briefs carry the interior checklist + the
// no-placeholder contract + register→archetype guidance; atmosphere briefs
// carry the menu + a variety directive; copy briefs stay LEAN on purpose (the
// copy stack was never the thin part, and brief tokens are input cost).

const NO_PLACEHOLDER_DATA = `NO PLACEHOLDER DATA — every price, stat, metric, label, and timestamp is a CONCRETE literal value (invented-but-specific diegetic detail is ENCOURAGED: "$128.00", "Meeting booked · 2:30 PM", "1,204 contacts"). Masked or unresolved values — "$•••.00", "XX%", "Loading", "TBD", lorem, blank grey slab-bars standing in for text — are REJECTED; they render as a broken half-loaded product.`;

const MOCK_INTERIOR_CHECKLIST = [
  `MOCK INTERIOR (the empty-container rule): a mock (app window, browser, dashboard, phone, terminal) with an empty or sparse interior is REJECTED. Ship at least 15 labeled interior elements, including at least 4 concrete text values — realistic labels/values/timestamps — drawn from this vocabulary (all plain divs/spans/SVG):`,
  `- window/browser header: traffic-light dots + URL/title bar with a REAL address`,
  `- sidebar nav: 4-6 icon+label rows, ONE active (accent left-rail or fill)`,
  `- filled data rows: ≥3 rows of name + value + status chip ("Renewal — Acme Corp · $12,400 · Won")`,
  `- KPI tiles: number + label + delta ("47 deals · +12% WoW"), 2-4 tiles in a row`,
  `- a small chart: 5-8 bars or a sparkline as divs/SVG, with 2-3 axis/series labels`,
  `- activity feed / inbox lines: avatar-initial circle + one-line message + timestamp`,
  `- status pills (Live/Pending/Won), tabs with one active, toggles, kanban columns with 2-3 cards, table with header + 4-6 rows, timeline dots, funnel bars`,
  `Interior mock text is diegetic chrome: 11-16px is correct there (realism over legibility inside the prop).`,
  NO_PLACEHOLDER_DATA,
].join("\n");

/** Register→archetype guidance, adapted to the HERO element's role in the
 *  scene shape (the scene-level map lives in the audit-matrix enrichment). */
const REGISTER_ARCHETYPE: Record<string, string> = {
  stat: `Register "stat" → the scene is a KPI hero (ONE massive metric in the copy column); you are its SUPPORTING structure: a radial gauge / sparkline / delta chips / a labeled baseline rule — substantive, never a bare card marooned in space.`,
  list: `Register "list" → the copy column is a REAL list; you are its diegetic echo: a dashboard/table/kanban mock whose filled rows mirror the list's subject matter.`,
  split: `Register "split" → asymmetric split; you are the substantive diegetic prop opposite the copy: a full product mock (browser/app window) with a real interior, commanding your whole slot.`,
  quote: `Register "quote" → a manifesto pull-quote scene; stay quiet and compositional — a modest chart/motif band that never competes with the words.`,
  "full-bleed": `Register "full-bleed" → you ARE the canvas: an edge-to-edge treatment (dashboard wall, oversized mock, immersive field) the copy sits on top of; design the full frame.`,
  centered: `Register "centered" → centered editorial; you are a wide band beneath the copy: a horizontal mock strip, timeline, or labeled chart.`,
};

export const ATMOSPHERE_MENU = [
  "orbital rings (thin concentric ellipses, slow rotation)",
  "floating embers (small accent dots drifting upward at varied speeds)",
  "faint vertical light rays",
  "vignette glow (dark edges, luminous center)",
  "parallax bands (wide translucent diagonal bands drifting at different speeds)",
  "film grain",
  "multi-stop gradient backdrop",
  "slow linear-gradient shimmer sweep",
] as const;

/**
 * Deterministic per-scene atmosphere variety: rotate the menu by scene index
 * so adjacent scenes are STEERED toward different combinations. The reference
 * bar is 8 distinct gradient signatures video-wide; near-identical washes on
 * every scene was a measured cast defect.
 */
export const atmosphereDirective = (sceneIndex: number, register: string): string => {
  const n = ATMOSPHERE_MENU.length;
  const lean = [0, 1, 2].map((k) => ATMOSPHERE_MENU[(sceneIndex * 3 + k) % n]);
  return [
    `ATMOSPHERE MENU — build 2-3 layers from: ${ATMOSPHERE_MENU.join(" · ")}.`,
    `VARIETY (scene ${sceneIndex}, register ${register}): adjacent scenes must NOT reuse the same combination — this scene leans toward: ${lean.join(" · ")}. Match the register's energy: tension/chaos beats scatter and dissonate; resolution beats order and converge.`,
    `Include ≥2 infinite-loop animations on decorative layers (gradient pulse 4s, drift 9-11s, shimmer 8s) so the scene never freezes after entry.`,
  ].join("\n");
};

// ─── The SVG connector layer ────────────────────────────────────────────────
// Reference-grade scenes tie relationship concepts together with SVG connector
// SYSTEMS (~69 primitives in the reference's chaos scene); raw cast scenes had
// none. Scenes whose visual_concept speaks in relationships earn a dedicated
// full-bleed decorative piece painted between atmosphere and content.

const CONNECTOR_CONCEPT_RE = /\b(?:connect|network|flow|scatter|link|converg|chaos)/i;

/** Does this scene's visual concept imply a relationship system? */
export const wantsConnector = (visualConcept: unknown): boolean =>
  typeof visualConcept === "string" && CONNECTOR_CONCEPT_RE.test(visualConcept);

/** The connector's synthetic slot. Kind "atmosphere" on purpose: the assembler
 *  emits it full-bleed with pointerEvents none — no layout-composer changes.
 *  Same numeric z as the base layer but later in paint order, so it sits above
 *  the atmosphere wash and below all z≥1 content. */
const connectorSlot = (aspect: Aspect): ElementSlot => {
  const { w, h } = CANVAS[aspect];
  return {
    id: "connector",
    kind: "atmosphere",
    bounds: { x: 0, y: 0, w, h, z: 0 },
    contentFields: [],
    paletteRoles: ["hairline", "accent"],
    allowedOverlaps: [],
  };
};

// ─── Element briefs ─────────────────────────────────────────────────────────

type SceneContent = Script["scenes"][number]["content"];

/** The copy fields an element owns, as brief lines carrying the VERBATIM
 *  values + the choreograph-consistent data-content-path for each. */
const copyLines = (content: SceneContent | undefined, owned: string[]): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const scalar = (field: string) => {
    const v = c[field];
    if (owned.includes(field) && typeof v === "string" && v.trim()) {
      out.push(`${field}: ${JSON.stringify(v)} (data-content-path="${field}")`);
    }
  };
  scalar("eyebrow");
  scalar("headline");
  scalar("lede");
  if (owned.includes("bullets") && Array.isArray(c.bullets)) {
    c.bullets.forEach((b, i) => out.push(`bullets.${i}: ${JSON.stringify(b)} (data-content-path="bullets.${i}")`));
  }
  scalar("caption");
  if (owned.includes("meta") && Array.isArray(c.meta)) {
    (c.meta as Array<{ label?: string; value?: string }>).forEach((m, i) =>
      out.push(`meta.${i}: label ${JSON.stringify(m?.label ?? "")}, value ${JSON.stringify(m?.value ?? "")} (tag the value data-content-path="meta.${i}.value")`),
    );
  }
  if (owned.includes("cta") && c.cta && typeof c.cta === "object") {
    const cta = c.cta as { primary?: string; secondary?: string };
    if (cta.primary) out.push(`cta.primary: ${JSON.stringify(cta.primary)} (data-content-path="cta.primary")`);
    if (cta.secondary) out.push(`cta.secondary: ${JSON.stringify(cta.secondary)} (data-content-path="cta.secondary")`);
  }
  if (owned.includes("texts") && Array.isArray(c.texts)) {
    // Deprecated legacy field — still rendered so nothing is orphaned.
    c.texts.forEach((t, i) => out.push(`texts.${i}: ${JSON.stringify(t)} (data-content-path="texts.${i}")`));
  }
  return out;
};

/** The scene copy VALUES (headline/lede/bullets — the measured leak fields) a
 *  slot does NOT own. These are what the unowned-copy guard hunts for in the
 *  slot's generated body: ownership lives in the slot's contentFields. */
const unownedCopyValues = (content: SceneContent | undefined, owned: string[]): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const field of ["headline", "lede"]) {
    const v = c[field];
    if (!owned.includes(field) && typeof v === "string" && v.trim()) out.push(v.trim());
  }
  if (!owned.includes("bullets") && Array.isArray(c.bullets)) {
    for (const bItem of c.bullets) if (typeof bItem === "string" && bItem.trim()) out.push(bItem.trim());
  }
  return out;
};

// ─── Composition-blueprint consumption ──────────────────────────────────────
// The thinking head (composition-head.ts) authors a per-scene SceneComposition
// — what each element IS + its interior inventory with REAL brand/scene
// values. When a scene carries one, briefs LEAD with that blueprint and the
// generic checklist/archetype text stays out (the head already did the
// inventing; the leaves transcribe). Scenes without a composition keep the
// generic-brief path unchanged — back-compat by construction.

type CastScene = Script["scenes"][number];

/** Map a spec element to its cast slot by role — roles are the slot ids
 *  (hero/copy/atmosphere/connector/throughline), so the mapping is a find. */
const specForSlot = (scene: CastScene | undefined, slotId: string): ElementSpec | undefined =>
  scene?.composition?.elements.find((e) => e.role === slotId);

/**
 * The copy fields an element OWNS, for both its brief and the unowned-copy
 * guard. With a composition present the spec is the ownership source of
 * truth: `ownsCopy` is explicit and exclusive, so a hero spec that owns
 * nothing makes ALL copy values unowned for the hero — stronger guard inputs
 * than slot.contentFields (which never carried copy fields for the hero
 * anyway, but DID let an under-specified world be ambiguous). Fields NO spec
 * claims fall back to their slot owner, so an incomplete composition can
 * never strip the headline out of the copy element that structurally owns it.
 */
const ownedCopyFields = (scene: CastScene | undefined, slot: ElementSlot): string[] => {
  const comp = scene?.composition;
  if (!comp) return slot.contentFields;
  const owned = new Set(specForSlot(scene, slot.id)?.ownsCopy ?? []);
  const claimed = new Set(comp.elements.flatMap((e) => e.ownsCopy ?? []));
  for (const f of slot.contentFields) if (!claimed.has(f)) owned.add(f);
  return [...owned];
};

/**
 * The blueprint lead for a composed element: subject + the verbatim interior
 * inventory + owned-copy render instructions + the motion beat. Transcription
 * doctrine (src/schema.ts ElementSpec): the head authored these values for
 * THIS brand and scene — the element furnishes what the spec names, never
 * template examples.
 */
const blueprintLines = (spec: ElementSpec, content: SceneContent | undefined, owned: string[]): string[] => {
  const lines: string[] = [
    `BLUEPRINT (authored by the composition head — TRANSCRIBE it, do not re-invent):`,
    `This element IS: ${spec.subject}`,
  ];
  if (spec.interior.length > 0) {
    lines.push(
      `TRANSCRIBE this interior inventory — every item below must be visibly present, verbatim values:`,
      ...spec.interior.map((item) => `- ${item}`),
      `The inventory is the FLOOR, not the ceiling: furnish supporting chrome in the same diegetic register, but every named value ships verbatim — never substituted, never rounded.`,
    );
  }
  const copy = copyLines(content, owned);
  if (copy.length > 0) {
    lines.push(
      `COPY THIS ELEMENT OWNS — render each field VERBATIM from the \`c\` binding, tagged with its data-content-path:`,
      ...copy,
    );
  } else {
    lines.push(
      `This element owns NO scene copy — the headline/lede/bullets belong to other elements; render none of that text.`,
    );
  }
  if (spec.motion) lines.push(`MOTION BEAT (sustained, tied to the named interior item): ${spec.motion}`);
  return lines;
};

/**
 * One element's brief: ONLY what that element owns — its role, its wrapper
 * geometry, the content-field values it renders, the palette roles it may
 * paint with (mapped to real const names), and the motif description when it
 * IS the throughline. Scene intent + register ride along for flavor; nothing
 * about any OTHER element leaks in (independence is the contract).
 */
const elementBrief = (args: {
  theme: Theme;
  script: Script;
  sceneIndex: number;
  register: string;
  slot: ElementSlot;
  pieceId: string;
  throughline: string;
}): string => {
  const { theme, script, sceneIndex, register, slot, pieceId, throughline } = args;
  const scene = script.scenes[sceneIndex];
  const spec = specForSlot(scene, slot.id);
  const owned = ownedCopyFields(scene, slot);
  const b = slot.bounds;
  const lines: string[] = [
    `CREATE this element — scene ${sceneIndex} ("${scene.label}", register ${register}), piece id "${pieceId}", kind "${slot.kind}".`,
    `Scene intent: ${scene.description ?? scene.label}`,
    `Visual concept (this element's role within it): ${String(scene.visual_concept ?? "").slice(0, 600)}`,
    `BOUNDS: your wrapper is ${b.w}×${b.h}px at canvas (${b.x},${b.y})${slot.kind === "text" ? " — width is a MAX, height flows" : ""}. Fill it.`,
    `PALETTE ROLES you may paint with: ${slot.paletteRoles.map((r) => `${r} → ${tokenForRole(theme, r)}`).join(", ")}.`,
  ];

  // Composed scenes: the brief LEADS with the head's blueprint. The generic
  // checklist/archetype/menu text below is the FALLBACK for un-composed scenes.
  if (spec) lines.push(...blueprintLines(spec, scene.content, owned));

  if (slot.id === "atmosphere") {
    lines.push(
      `Full-bleed decorative BASE layer (z0) under all content: gradient washes, glow, grain. The accent role may appear at LOW ALPHA only (a glow, never a fill). No text, no UI.`,
    );
    if (scene.composition) {
      lines.push(
        `ATMOSPHERE TREATMENT (authored for THIS scene — adjacent scenes carry different treatments): ${scene.composition.atmosphere}`,
        `Include ≥2 infinite-loop animations on decorative layers (gradient pulse 4s, drift 9-11s, shimmer 8s) so the scene never freezes after entry.`,
      );
    } else {
      lines.push(atmosphereDirective(sceneIndex, register));
    }
  } else if (slot.id === "connector") {
    lines.push(
      `Full-bleed decorative CONNECTOR layer between the atmosphere and the content: ONE inline SVG relationship system (root <svg viewBox="0 0 ${b.w} ${b.h}" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>) that ties this scene's concept together visually.`,
      `Requirements: at least 12 SVG primitives; dashed connector paths (strokeDasharray) linking node positions; small node marks (circles/rects) at path endpoints and junctions; curved paths over straight lines where they read better.`,
      spec
        ? `Derive the topology FROM the blueprint above — the subject and inventory name the system.`
        : `Derive the topology FROM the visual concept above (scattered chaos → tangled crossing paths; convergence → paths meeting at a hub; flow → a directed left-to-right run).`,
      `Paint structure with the hairline role, accent SPARINGLY (1-3 focal paths/nodes). Keep the center-of-frame copy zone visually calm. No text, no UI — this layer is connective tissue, not content.`,
    );
  } else if (slot.id === "copy") {
    if (spec) {
      lines.push(`ONE flow column, top to bottom — render EXACTLY the owned fields in the blueprint above, each tagged with its data-content-path.`);
    } else {
      lines.push(`The scene's editorial text stack — ONE flow column, top to bottom, each field tagged:`, ...copyLines(scene.content, owned));
    }
  } else if (slot.id === "throughline") {
    lines.push(
      `This element IS the story's throughline motif: ${JSON.stringify(throughline)}. It recurs at this exact anchor in EVERY scene and must read as ONE continuous object that evolves along the arc — never a fresh object per cut. The wrapper already carries the data-throughline tag and the pinned anchor; render only the motif itself.`,
    );
  } else {
    // hero — the diegetic visual. Composed: the blueprint above IS the visual
    // (subject + inventory); asset mounting stays contractual either way.
    // Un-composed: it renders its owned visual fields when the scene brings
    // them, otherwise it INVENTS the visual from the concept, steered by the
    // generic taste stack (the composer keeps the slot either way).
    const c = scene.content ?? ({} as SceneContent);
    if (slot.contentFields.includes("illustration") && c.illustration) {
      lines.push(`Illustration intent: ${JSON.stringify(c.illustration)} — draw it as inline SVG.`);
    }
    if (slot.contentFields.includes("asset_ids") && Array.isArray(c.asset_ids) && c.asset_ids.length > 0) {
      const imagesById = new Map((script.assets?.images ?? []).map((img) => [img.id, img]));
      for (const id of c.asset_ids) {
        const img = imagesById.get(id);
        if (img) lines.push(`Image ${id}: mount with <Img src=${JSON.stringify(img.src)} /> (${img.width}×${img.height}${img.alt_text ? `, ${img.alt_text}` : ""}).`);
      }
    }
    if (!spec) {
      if (slot.contentFields.length === 0) {
        lines.push(`No visual fields given — invent the diegetic visual (a browser mock, chart, panel, KPI cluster…) from the visual concept above.`);
      }
      const archetype = REGISTER_ARCHETYPE[register];
      if (archetype) lines.push(archetype);
      lines.push(MOCK_INTERIOR_CHECKLIST);
    }
  }

  lines.push("", "Emit ONLY the JSX for THIS element.");
  return lines.join("\n");
};

// ─── Fragment verification + placeholder ────────────────────────────────────

/**
 * FRAGMENT-VERIFICATION CHOICE: wrap the body the same way assemble.ts will —
 * a JSX child inside a wrapper div, inside a component arrow body — and run
 * `verifyCompilable` on THAT harness, per element. Chosen over compile-checking
 * the assembled scene per result because it is cheaper (one ~1ms esbuild
 * transform per element instead of re-assembling N times) and equally sound
 * for the defect class a syntax gate can catch (truncation, unbalanced tags,
 * leaked prose): esbuild's transform binds no identifiers either way, and any
 * fragment that parses in this child position parses identically inside
 * assemble's wrapper. It also localizes the compiler error to the one element,
 * which is exactly what the repair prompt needs to quote. The assembled whole
 * still gets a final `verifyCompilable` before return as the backstop.
 */
const verifyFragment = (body: string): Promise<string | null> =>
  verifyCompilable(`const __CastPiece = () => (\n<div>\n${body}\n</div>\n);`);

/**
 * Degraded-but-shippable substitute for an element that stayed broken through
 * its repair: a neutral surface in the theme's own grammar — or, when the
 * element owns the headline, the headline itself (the one piece of content a
 * scene cannot silently lose). Referenced consts (FONT_DISPLAY + the theme
 * tokens) are always emitted by the assembler, so the placeholder compiles by
 * construction.
 */
const placeholderBody = (theme: Theme, slot: ElementSlot): string =>
  slot.contentFields.includes("headline")
    ? `<div data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 56, fontWeight: 600, lineHeight: 1.1, color: ${tokenForRole(theme, "ink")} }}>{c.headline}</div>`
    : `<div style={{ width: "100%", height: "100%", borderRadius: 12, background: ${theme.grammar.panelBg}, border: "1px solid", borderColor: ${theme.grammar.hairline} }} />`;

// ─── The orchestrator ───────────────────────────────────────────────────────

interface ElementJob {
  sceneIndex: number;
  slot: ElementSlot;
  pieceId: string;
  brief: string;
}

interface ElementOutcome {
  pieceId: string;
  body: string;
  outputTokens: number;
  repaired: boolean;
  failed: boolean;
  colorRewrites: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Drive one full element-cast build: settle contracts, fire every element
 * call in parallel through a semaphore, hue-lock + verify each body (one
 * surgical repair, then placeholder), assemble, choreograph, compile-verify.
 *
 * `opts.caller` is dependency injection for tests (canned bodies, no network);
 * production uses the real `castCall`. `opts.concurrency` is the burst width —
 * a per-build FIFO semaphore (AccountLimiter, the tested pattern) sized for
 * Cerebras. Deliberately NOT `fillLimiter`: that singleton is sized for the
 * z.ai account ceiling and would strangle a Cerebras burst.
 */
export const castBuild = async (
  input: CastBuildInput,
  opts?: { caller?: typeof castCall; concurrency?: number },
): Promise<CastBuildResult> => {
  const t0 = Date.now();
  const { script, theme, palette, aspect } = input;
  if (Object.keys(theme.palette).length === 0) {
    throw new Error("cast-build: theme.palette is empty — nothing for elements to paint with");
  }
  const caller = opts?.caller ?? castCall;
  const width = Math.max(1, Math.floor(opts?.concurrency ?? (Number(process.env.RB_CAST_CONCURRENCY) || 14)));
  const limiter = new AccountLimiter(width);

  // ── 1. Settle the contracts: one deterministic plan per scene ────────────
  // Every scene carries the motif when the script has one: the choreographer's
  // match cut needs it visible at t=0 in EVERY scene, and the presence gate
  // needs a ≥60% majority — all-scenes satisfies both by construction, and the
  // composer keeps the slot clear of copy/chrome at every register × aspect.
  const throughline = script.narrative?.throughline?.trim() ?? "";
  const hasThroughline = throughline.length > 0;
  const slug = slugify(throughline);

  const plans = script.scenes.map((scene) =>
    composeSceneLayout({ register: scene.register, content: scene.content }, aspect, { hasThroughline }),
  );

  // Connector casting. A scene WITH a composition is decided by the head:
  // it carries the connector iff the spec cast one (spec presence OVERRIDES
  // the keyword heuristic — the head sees the whole story; the regex sees one
  // string). Un-composed scenes keep the heuristic: relationship concepts earn
  // the SVG connector layer, and when nothing does, ONE mid-video scene still
  // gets it (reference-grade builds always carry at least one connector
  // system) — unless the head composed that mid scene and cast none, in which
  // case that IS the decision.
  const connectorScenes = new Set<number>(
    script.scenes.flatMap((scene, i) => {
      if (scene.composition) return specForSlot(scene, "connector") ? [i] : [];
      return wantsConnector(scene.visual_concept) ? [i] : [];
    }),
  );
  if (connectorScenes.size === 0 && script.scenes.length > 0) {
    const mid = Math.floor(script.scenes.length / 2);
    if (!script.scenes[mid]?.composition) connectorScenes.add(mid);
  }
  /** The composer's slots + the synthetic connector slot, in paint order
   *  (connector directly after the base atmosphere layer). */
  const slotsFor = (plan: ScenePlan, i: number): ElementSlot[] => {
    if (!connectorScenes.has(i)) return plan.elements;
    const slots = [...plan.elements];
    slots.splice(1, 0, connectorSlot(aspect));
    return slots;
  };

  const scenes: SceneManifest[] = plans.map((plan, i) => ({
    scene: i,
    background: tokenForRole(theme, "canvas"),
    pieces: slotsFor(plan, i).map(
      (slot): Piece => ({
        id: `s${i}.${slot.id}`, // the Piece id convention (see ElementSlot.id)
        kind: slot.kind,
        // Virtual path — cast bodies stay in-memory (the resolver below); this
        // is the manifest slot a future decompose-to-disk step will fill.
        file: `scene${i}/${slot.id}.tsx`,
        bounds: slot.bounds,
        ...(slot.kind === "text" ? { contentRef: `scenes[${i}].content` } : {}),
        ...(slot.id === "throughline" ? { throughlineSlug: slug } : {}),
      }),
    ),
  }));

  // ── 2. Element briefs — chrome earns NO call (Section emits Chrome itself,
  //       see assemble.ts) ──────────────────────────────────────────────────
  const system = buildElementSystem(theme);
  const jobs: ElementJob[] = plans.flatMap((plan, i) =>
    slotsFor(plan, i)
      .filter((slot) => slot.kind !== "chrome")
      .map((slot) => ({
        sceneIndex: i,
        slot,
        pieceId: `s${i}.${slot.id}`,
        brief: elementBrief({ theme, script, sceneIndex: i, register: plan.register, slot, pieceId: `s${i}.${slot.id}`, throughline }),
      })),
  );

  // ── 3+4. Fire ALL calls through the semaphore; per result: extract →
  //         hue-lock → fragment-verify → one repair → placeholder ──────────
  const runElement = async (job: ElementJob): Promise<ElementOutcome> => {
    let tokens = 0;
    const effort = effortFor(job.slot.id);
    // Verbatim copy this element does NOT own. Ownership lives in the slot —
    // and when the scene carries a composition, the spec's explicit ownsCopy
    // is the stronger source of truth (see ownedCopyFields).
    const unowned = unownedCopyValues(
      script.scenes[job.sceneIndex]?.content,
      ownedCopyFields(script.scenes[job.sceneIndex], job.slot),
    );

    // One attempt: call, extract, deterministic post-passes, hue-lock,
    // syntax-verify. A transport throw (castCall retries internally first) is
    // treated like a broken result — the build completes degraded rather than
    // dying on one element.
    const attempt = async (
      user: string,
    ): Promise<{ ok: true; body: string; rewrites: number } | { ok: false; raw: string; error: string }> => {
      let text: string;
      try {
        const res = await caller({ system, user, maxTokens: maxTokensFor(job.slot.id), effort });
        tokens += res.outputTokens;
        text = res.text;
      } catch (err) {
        return { ok: false, raw: "", error: err instanceof Error ? err.message : String(err) };
      }
      const raw = stripCodeFence(text);
      if (raw.length < 8 || !raw.includes("<") || /^\s*(?:import|export)\b/.test(raw)) {
        return { ok: false, raw, error: "output is not a JSX fragment (empty, no markup, or a module)" };
      }
      // Deterministic post-passes — each closes a measured defect class at
      // zero tokens (see the pass docs above), BEFORE the fragment gate.
      let body = rewriteKeyframeInterpolations(raw, theme.keyframes).code;
      body = stripCanvasSelfPositioning(body, job.slot.bounds).code;
      body = stripColorMutationFilters(body).code;
      const { code: locked, changes } = normalizeElementColors(body, palette);
      // Unowned-copy guard: exact text nodes strip deterministically inside
      // stripUnownedCopy; anything subtler routes to the surgical repair with
      // a verbatim error naming the stolen copy.
      const guard = stripUnownedCopy(locked, unowned);
      if (guard.residual.length > 0) {
        return {
          ok: false,
          raw,
          error: `element renders copy it does not own: ${guard.residual.map((v) => JSON.stringify(v)).join(", ")} — those fields belong to another element (ownership is fixed by the layout contract); remove that text entirely`,
        };
      }
      const compileErr = await verifyFragment(guard.code);
      if (compileErr) return { ok: false, raw, error: compileErr };
      return { ok: true, body: guard.code, rewrites: changes.reduce((n, ch) => n + ch.count, 0) };
    };

    const first = await attempt(job.brief);
    if (first.ok) {
      return { pieceId: job.pieceId, body: first.body, outputTokens: tokens, repaired: false, failed: false, colorRewrites: first.rewrites };
    }

    // ONE surgical repair: the same brief + the broken output + the exact
    // error. A syntax failure is mechanical, not creative — one pointed retry
    // recovers most of them (repairCompile doctrine, code-extraction.ts).
    const second = await attempt(
      [
        job.brief,
        "",
        "Your previous attempt failed:",
        first.raw ? `--- previous attempt ---\n${first.raw}` : "(the call itself failed)",
        `--- error ---\n${first.error}`,
        "Emit corrected JSX only.",
      ].join("\n"),
    );
    if (second.ok) {
      return { pieceId: job.pieceId, body: second.body, outputTokens: tokens, repaired: true, failed: false, colorRewrites: second.rewrites };
    }

    console.warn(`[cast-build] ${job.pieceId}: broken through repair — shipping placeholder (${second.error.slice(0, 120)})`);
    return { pieceId: job.pieceId, body: placeholderBody(theme, job.slot), outputTokens: tokens, repaired: false, failed: true, colorRewrites: 0 };
  };

  const outcomes = await Promise.all(jobs.map((job) => limiter.with(() => runElement(job))));
  const bodies = new Map(outcomes.map((o) => [o.pieceId, o.body]));

  // ── 5. Assemble → choreograph (motion is a compile step, invoked exactly
  //       like pipeline.ts's parallel branch) → final compile gate ─────────
  const assembled = assembleComposition({ theme, scenes, pieceBody: (p) => bodies.get(p.id) ?? "<div />" });
  // CastBuildInput carries no brand_extract, so the motion signal is the
  // pipeline's own fallback: "medium".
  const code = applyChoreography(assembled, script, "medium");

  const finalErr = await verifyCompilable(code);
  if (finalErr) {
    // Every body was fragment-verified and the assembler is deterministic —
    // reaching here is an orchestrator bug, never a runtime condition.
    throw new Error(`cast-build: assembled composition does not compile: ${finalErr}`);
  }

  // Accent PRESENCE is the complement of hue-locking (normalize-element.ts):
  // all-neutral output sails through the lock. Detection only — log loudly,
  // let the vision gate / caller decide what absence costs.
  const accent = assessAccentPresence(code, palette, input.signatureAccent);
  if (!accent.present) {
    console.warn(`[cast-build] brand accent hue ${accent.accentHue?.toFixed(0)}° absent from the final composition`);
  }

  return {
    code,
    scenes,
    telemetry: {
      elements: jobs.length,
      failures: outcomes.filter((o) => o.failed).length,
      repairs: outcomes.filter((o) => o.repaired).length,
      tokensOut: outcomes.reduce((n, o) => n + o.outputTokens, 0),
      wallSeconds: round2((Date.now() - t0) / 1000),
      normalizedColors: outcomes.reduce((n, o) => n + o.colorRewrites, 0),
    },
  };
};
