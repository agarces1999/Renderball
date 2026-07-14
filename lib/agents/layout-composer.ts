/**
 * Deterministic LAYOUT COMPOSER — the contract issuer for element-level
 * generation. Zero LLM, zero I/O: register + aspect (+ throughline flag) in,
 * a ScenePlan of disjoint, pre-blessed element slots out.
 *
 * Why this exists: under the LEGO model, elements generate INDEPENDENTLY.
 * Independence is only safe when every element's territory is settled BEFORE
 * any code is written — otherwise two blind generators claim the same pixels
 * and we're back to accidental overlap, the exact defect class the
 * render-truth gates exist to catch after the fact. This module settles the
 * territory up front, so the gates pass BY CONSTRUCTION:
 *
 *   - Every slot's bounds live inside the canvas.
 *   - Non-atmosphere slots are pairwise DISJOINT unless the overlap is
 *     DECLARED (founder doctrine: intentional overlaps are declared via
 *     z-order + an explicit `allowedOverlaps` allowance, never accidental).
 *   - The "split" register satisfies the numeric stranded-hero contract that
 *     `findStrandedHero` (lib/render/render-truth-gates.ts) enforces as a
 *     blocking gate — same constants, solved forward instead of retried.
 *   - Every present content field is OWNED by exactly one element, so a text
 *     edit or a per-element regen has exactly one home and can never fork copy.
 *
 * `composeSceneLayout` throws if any invariant would be violated — a throw here
 * is a composer bug (a bad geometry table entry), never a runtime condition.
 */
import type { Bounds, PieceKind } from "../edit/piece-model";
import { throughlineAnchorFor } from "./choreograph";

// ─── Public contract ────────────────────────────────────────────────────────

export interface ElementSlot {
  /**
   * Role-only id ("atmosphere" | "hero" | "copy" | "throughline" | "chrome").
   * Deliberately NOT scene-prefixed: the composer is scene-index-agnostic, and
   * the Piece id convention ("s2.panel") is a caller concern — callers prefix
   * with their scene index (`s${i}.${slot.id}`) when minting Piece ids.
   */
  id: string;
  kind: PieceKind;
  /** Absolute canvas px. For the text slot, w is a MAX width (text flows). */
  bounds: Bounds;
  /**
   * The scene.content fields this element OWNS, exclusively. A field never
   * appears in two slots' lists — exclusive ownership is invariant (d).
   */
  contentFields: string[];
  /**
   * Theme palette roles this element may paint with. `accent` appears only
   * where the register declares it (stat metric, quote emphasis, the
   * throughline motif, atmosphere glow, diegetic data) — never by default.
   */
  paletteRoles: string[];
  /**
   * Ids of elements this one may INTENTIONALLY overlap. The disjointness
   * check is symmetric: an overlap between A and B is legal iff A lists B OR
   * B lists A. Every slot declares "atmosphere" (the full-bleed base layer is
   * overlappable by all); everything else must be earned explicitly.
   */
  allowedOverlaps: string[];
}

export interface ScenePlan {
  /** The NORMALIZED register the layout was composed for (unknown/absent → "centered"). */
  register: string;
  elements: ElementSlot[];
}

// ─── Canvas + gate constants ────────────────────────────────────────────────

export type Aspect = "16:9" | "9:16" | "1:1";

/**
 * Mirrors CANVAS_DIMS in lib/render/measure-scene.ts. Mirrored, not imported:
 * that module pulls React/esbuild/Playwright, and the composer must stay a
 * pure, dependency-free leaf (it runs inside tests and the build hot path).
 * The values are the fixed product canvases — they do not drift.
 */
export const CANVAS: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/**
 * The split-register numeric contract, verbatim from findStrandedHero
 * (lib/render/render-truth-gates.ts SH_MIN_W_FRAC / SH_VCENTER_FRAC). The gate
 * BLOCKS on these after measuring the rendered frame; the composer satisfies
 * them by construction so a split scene can never earn that retry.
 */
export const SPLIT_HERO_MIN_W_FRAC = 0.3; // hero width ≥ 30% of canvas width
export const SPLIT_HERO_VCENTER_FRAC = 0.25; // |heroCenterY − H/2| ≤ 25% of H

/** Side of the throughline motif box (square), matching the small, consistent
 *  cross-scene anchor contract (SEVERE_DRIFT_PX tolerance is 280px — a 200px
 *  box pinned to the exact anchor sits far inside it). */
const THROUGHLINE_SIZE = 200;

// ─── Content-field ownership ────────────────────────────────────────────────

/** Copy fields (src/schema.ts Scene.content) — owned by the "copy" text slot.
 *  `texts` is the deprecated legacy field; still owned so nothing is orphaned. */
const COPY_FIELDS = ["eyebrow", "headline", "lede", "bullets", "caption", "meta", "cta", "texts"] as const;
/** Visual-intent fields — owned by the diegetic "hero" slot when one exists. */
const VISUAL_FIELDS = ["illustration", "asset_ids"] as const;

/** A field is "present" when it would render something: non-empty string,
 *  non-empty array, or a truthy object (meta rows / cta). */
const isPresent = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

const presentOf = (content: Record<string, unknown> | undefined, fields: readonly string[]): string[] =>
  fields.filter((f) => isPresent(content?.[f]));

// ─── Registers ──────────────────────────────────────────────────────────────

const REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered"] as const;
type Register = (typeof REGISTERS)[number];

/** Unknown/absent register → "centered", matching the schema's documented default. */
const normalizeRegister = (r: string | undefined): Register =>
  (REGISTERS as readonly string[]).includes(r ?? "") ? (r as Register) : "centered";

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Per-register, per-aspect geometry for the two content slots. Explicit
 * literal tables (not formulas) on purpose: every rectangle below was checked
 * against every other rectangle it shares a frame with, and a literal table
 * is auditable at a glance where a formula hides a collision.
 *
 * Shared frame furniture the tables must respect:
 *   - chrome bar: bottom band (y ≥ H−72 @16:9/1:1, y ≥ 1840 @9:16) — content
 *     rects end above it.
 *   - throughline box: throughlineAnchorFor(aspect) + 200×200 — copy rects
 *     NEVER cross it (a motif over text is an undeclared collision waiting to
 *     paint); hero rects MAY contain it (visual-over-visual, declared by the
 *     throughline slot's allowedOverlaps).
 *
 * Register shapes (16:9 described; 9:16 restacks vertically copy-over-hero,
 * 1:1 is the compact hybrid):
 *   - centered:  copy column mid-frame, hero band beneath it.
 *   - stat:      copy (the massive metric) left, hero (supporting viz) right,
 *                both vertically centered — a soft split.
 *   - quote:     wide centered pull-quote high in frame; hero (only when the
 *                scene brings visual fields) as a modest band beneath.
 *   - full-bleed: hero IS the canvas (a treatment ≥85% area — the gate's own
 *                threshold for "not a placeable hero"), copy overlaid lower-left.
 *   - split:     text column and hero column on OPPOSITE horizontal halves,
 *                hero ≥30% W and vertically centered — the gate contract.
 *   - list:      tall copy column (the list) left, hero right, centered.
 */
const GEOMETRY: Record<Register, Record<Aspect, { copy: Rect; hero: Rect | null }>> = {
  centered: {
    "16:9": { copy: { x: 360, y: 160, w: 960, h: 480 }, hero: { x: 560, y: 700, w: 800, h: 280 } },
    "9:16": { copy: { x: 90, y: 260, w: 900, h: 800 }, hero: { x: 190, y: 1160, w: 700, h: 600 } },
    "1:1": { copy: { x: 140, y: 160, w: 800, h: 400 }, hero: { x: 240, y: 620, w: 600, h: 340 } },
  },
  stat: {
    // Hero cy = H/2 exactly — a stat's support viz reads as a peer column.
    "16:9": { copy: { x: 120, y: 280, w: 780, h: 520 }, hero: { x: 1020, y: 280, w: 780, h: 520 } },
    "9:16": { copy: { x: 90, y: 260, w: 900, h: 640 }, hero: { x: 190, y: 1000, w: 700, h: 700 } },
    "1:1": { copy: { x: 100, y: 160, w: 880, h: 360 }, hero: { x: 240, y: 580, w: 600, h: 380 } },
  },
  quote: {
    // Copy sits HIGH (ends above the throughline band at every aspect) so the
    // pull-quote never collides with the motif. Hero is emitted only when the
    // scene carries visual fields (see composeSceneLayout).
    "16:9": { copy: { x: 260, y: 180, w: 1400, h: 340 }, hero: { x: 360, y: 600, w: 800, h: 240 } },
    "9:16": { copy: { x: 90, y: 400, w: 900, h: 600 }, hero: { x: 240, y: 1080, w: 600, h: 180 } },
    "1:1": { copy: { x: 120, y: 180, w: 840, h: 380 }, hero: { x: 240, y: 640, w: 600, h: 280 } },
  },
  "full-bleed": {
    // Hero = the whole canvas (100% ≥ the gate's 85% "canvas treatment"
    // threshold, so findStrandedHero's split/corner rules don't apply). The
    // copy rect is the overlaid text block — overlap is DECLARED by the hero.
    "16:9": { copy: { x: 120, y: 560, w: 900, h: 380 }, hero: { x: 0, y: 0, w: 1920, h: 1080 } },
    "9:16": { copy: { x: 80, y: 360, w: 920, h: 800 }, hero: { x: 0, y: 0, w: 1080, h: 1920 } },
    "1:1": { copy: { x: 80, y: 560, w: 520, h: 380 }, hero: { x: 0, y: 0, w: 1080, h: 1080 } },
  },
  split: {
    // THE GATE CONTRACT, solved forward (constants above):
    //   16:9 hero w=768 = 0.40·1920 ≥ 0.30·1920=576; cy = 220+320 = 540 = H/2;
    //        hero centroid x=1440 (right half) vs copy centroid x=480 (left).
    //   9:16 hero w=450 ≥ 0.30·1080=324; cy = 610+350 = 960 = H/2;
    //        centroids 795 vs 285 — opposite halves of 540.
    //   1:1  hero w=440 ≥ 324; cy = 260+280 = 540 = H/2; centroids 780 vs 290.
    "16:9": { copy: { x: 120, y: 240, w: 720, h: 600 }, hero: { x: 1056, y: 220, w: 768, h: 640 } },
    "9:16": { copy: { x: 60, y: 460, w: 450, h: 1000 }, hero: { x: 570, y: 610, w: 450, h: 700 } },
    "1:1": { copy: { x: 80, y: 260, w: 420, h: 560 }, hero: { x: 560, y: 260, w: 440, h: 560 } },
  },
  list: {
    "16:9": { copy: { x: 120, y: 140, w: 780, h: 800 }, hero: { x: 1020, y: 270, w: 780, h: 540 } },
    "9:16": { copy: { x: 90, y: 200, w: 900, h: 920 }, hero: { x: 240, y: 1180, w: 600, h: 600 } },
    "1:1": { copy: { x: 80, y: 140, w: 480, h: 800 }, hero: { x: 620, y: 300, w: 380, h: 480 } },
  },
};

/** Bottom chrome bar (BrandChrome: logo + pagination). Full-width, z3. */
const chromeRect = (aspect: Aspect): Rect => {
  const { w, h } = CANVAS[aspect];
  const barH = aspect === "9:16" ? 80 : 72;
  return { x: 0, y: h - barH, w, h: barH };
};

// ─── Invariant enforcement ──────────────────────────────────────────────────

const rectsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Throws if the plan violates any hard invariant. Called on EVERY compose —
 * the geometry tables are hand-checked, but a table edit that reintroduces a
 * collision must fail loudly at compose time, not paint time.
 */
const assertPlanInvariants = (plan: ScenePlan, aspect: Aspect, content: Record<string, unknown> | undefined): void => {
  const { w: W, h: H } = CANVAS[aspect];
  const els = plan.elements;

  // (b) All bounds inside the canvas, with positive extent.
  for (const el of els) {
    const { x, y, w, h } = el.bounds;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > W || y + h > H) {
      throw new Error(`layout-composer: "${el.id}" bounds ${JSON.stringify(el.bounds)} escape the ${W}×${H} canvas`);
    }
  }

  // (a) Pairwise disjoint unless the overlap is declared (symmetric).
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i];
      const b = els[j];
      if (!rectsOverlap(a.bounds, b.bounds)) continue;
      const declared = a.allowedOverlaps.includes(b.id) || b.allowedOverlaps.includes(a.id);
      if (!declared) {
        throw new Error(`layout-composer: UNDECLARED overlap between "${a.id}" and "${b.id}" (${plan.register}@${aspect})`);
      }
    }
  }

  // (c) Split register: the stranded-hero numeric contract, by construction.
  if (plan.register === "split") {
    const hero = els.find((e) => e.id === "hero");
    const copy = els.find((e) => e.id === "copy");
    if (!hero || !copy) throw new Error("layout-composer: split plan must carry hero + copy");
    if (hero.bounds.w < SPLIT_HERO_MIN_W_FRAC * W) {
      throw new Error(`layout-composer: split hero w=${hero.bounds.w} < ${SPLIT_HERO_MIN_W_FRAC * W}`);
    }
    const heroCy = hero.bounds.y + hero.bounds.h / 2;
    if (Math.abs(heroCy - H / 2) > SPLIT_HERO_VCENTER_FRAC * H) {
      throw new Error(`layout-composer: split hero cy=${heroCy} outside the ±${SPLIT_HERO_VCENTER_FRAC * H}px band`);
    }
    const heroOff = hero.bounds.x + hero.bounds.w / 2 - W / 2;
    const copyOff = copy.bounds.x + copy.bounds.w / 2 - W / 2;
    // Stronger than the gate (which tolerates near-center): strictly opposite.
    if (heroOff * copyOff >= 0) {
      throw new Error("layout-composer: split hero and copy centroids must sit on OPPOSITE horizontal halves");
    }
  }

  // (d) Every present content field owned by exactly ONE element.
  const present = presentOf(content, [...COPY_FIELDS, ...VISUAL_FIELDS]);
  const owners = new Map<string, string[]>();
  for (const el of els) {
    for (const f of el.contentFields) owners.set(f, [...(owners.get(f) ?? []), el.id]);
  }
  for (const f of present) {
    const who = owners.get(f) ?? [];
    if (who.length !== 1) {
      throw new Error(`layout-composer: content field "${f}" owned by [${who.join(", ")}] — must be exactly one element`);
    }
  }
};

// ─── The composer ───────────────────────────────────────────────────────────

/**
 * Compose the deterministic element-slot plan for one scene. Pure: identical
 * inputs yield a byte-identical ScenePlan (fixed tables, fixed emit order —
 * atmosphere, hero, copy, throughline, chrome — no randomness, no clock).
 *
 * @param scene  register + content (only field PRESENCE is read, never text).
 * @param aspect target canvas.
 * @param opts.hasThroughline add the cross-scene motif slot, pinned to
 *        throughlineAnchorFor(aspect) (lib/agents/choreograph.ts) so the
 *        cross-scene drift gate passes and the film wrapper's match-cut camera
 *        push has its target.
 */
export const composeSceneLayout = (
  scene: { register?: string; content?: Record<string, unknown> },
  aspect: Aspect,
  opts?: { hasThroughline?: boolean },
): ScenePlan => {
  const register = normalizeRegister(scene.register);
  const { w: W, h: H } = CANVAS[aspect];
  const geo = GEOMETRY[register][aspect];

  const copyFields = presentOf(scene.content, COPY_FIELDS);
  const visualFields = presentOf(scene.content, VISUAL_FIELDS);

  // quote is text-first: it earns a hero slot only when the scene actually
  // brings visual intent (illustration / asset_ids) — otherwise the pull-quote
  // stands alone. Every other register keeps its hero unconditionally (the
  // element generator invents the diegetic visual from visual_concept).
  const wantsHero = register === "quote" ? visualFields.length > 0 : geo.hero !== null;

  // full-bleed's hero is a canvas TREATMENT: it declares that copy, chrome and
  // the throughline may all sit on top of it (z decides paint order). This is
  // the doctrine's "declared overlap" — the one register where text-on-visual
  // is the composition, not an accident.
  const isCanvasTreatment = register === "full-bleed";

  const elements: ElementSlot[] = [];

  elements.push({
    id: "atmosphere",
    kind: "atmosphere",
    bounds: { x: 0, y: 0, w: W, h: H, z: 0 },
    contentFields: [],
    // Glow/grain may carry accent at low alpha — the declared accent surface.
    paletteRoles: ["canvas", "accent"],
    // The base layer declares nothing; every other slot declares IT (symmetric).
    allowedOverlaps: [],
  });

  if (wantsHero && geo.hero) {
    elements.push({
      id: "hero",
      kind: "diegetic",
      bounds: { ...geo.hero, z: 1 },
      contentFields: visualFields,
      // Diegetic UI: surfaces + hairlines + ink, accent for the data moments.
      paletteRoles: ["panelBg", "hairline", "ink", "accent"],
      allowedOverlaps: isCanvasTreatment
        ? ["atmosphere", "copy", "chrome", "throughline"]
        : ["atmosphere"],
    });
  }

  elements.push({
    id: "copy",
    kind: "text",
    // z2 keeps overlaid copy above a full-bleed hero; harmless elsewhere
    // (copy is disjoint from everything else by table construction).
    bounds: { ...geo.copy, z: 2 },
    contentFields: copyFields,
    // Accent only where the register declares emphasis: the stat metric and
    // the quote's highlighted line. Everything else sets copy in pure ink.
    paletteRoles: register === "stat" || register === "quote" ? ["ink", "accent"] : ["ink"],
    allowedOverlaps: ["atmosphere"],
  });

  if (opts?.hasThroughline) {
    const anchor = throughlineAnchorFor(aspect);
    elements.push({
      id: "throughline",
      kind: "diegetic",
      // Pinned EXACTLY to the choreographer's anchor (16:9 → 1360,540) so the
      // cross-scene drift gate (SEVERE_DRIFT_PX) passes by construction.
      bounds: { x: anchor.left, y: anchor.top, w: THROUGHLINE_SIZE, h: THROUGHLINE_SIZE, z: 2 },
      contentFields: [],
      // The motif IS the accent thread — its one palette role.
      paletteRoles: ["accent"],
      // May sit over the hero (visual-on-visual, declared) — never over copy
      // or chrome; the geometry tables keep those rects clear of the anchor box.
      allowedOverlaps: ["atmosphere", "hero"],
    });
  }

  elements.push({
    id: "chrome",
    kind: "chrome",
    bounds: { ...chromeRect(aspect), z: 3 },
    contentFields: [],
    paletteRoles: ["ink"],
    allowedOverlaps: ["atmosphere"],
  });

  const plan: ScenePlan = { register, elements };
  assertPlanInvariants(plan, aspect, scene.content);
  return plan;
};
