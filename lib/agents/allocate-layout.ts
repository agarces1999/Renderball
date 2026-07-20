/**
 * THE DETERMINISTIC LAYOUT ALLOCATOR (dry-run, 2026-07-19).
 *
 * A generalization of `layout-composer.composeSceneLayout`'s per-register
 * literal geometry tables. Same posture — pure, zero LLM, zero I/O — but where
 * the composer holds ONE fixed rectangle pair per (register × aspect), this
 * module holds a REPERTOIRE of distributions and chooses among them from the
 * scene's element count, roles, focal ranks and content size.
 *
 * WHAT QUESTION THIS EXISTS TO ANSWER. Today the composition HEAD invents pixel
 * bounds for every element, and its characteristic failure is a VOID — a huge
 * abandoned contiguous region with no focal anchor. The founder's hypothesis is
 * that coordinate authorship should be REMOVED from the model entirely: give a
 * solver the frame and the pieces, let it compute placement. This module is that
 * solver, built to be dry-run against the head's stored output so the question
 * can be answered offline for $0. It is NOT wired into the pipeline.
 *
 * DESIGN REQUIREMENTS, in the founder's priority order:
 *   1. DISJOINT BY CONSTRUCTION. Every shape tiles its container by band
 *      splitting, so two content boxes can only overlap if the shape explicitly
 *      declares a layer (the full-bleed treatments). `assertAllocation` proves
 *      it on every call.
 *   2. NO LARGE DEAD REGION. Shapes leave air as MARGINS AND GUTTERS rather than
 *      one pooled block, and a bounded absorption pass grows the neighbour that
 *      shares the longest edge with the largest residual void.
 *   3. A FOCAL ANCHOR. Each shape declares its slots in PROMINENCE order and the
 *      elements are mapped onto them in focal order, so the rank-1 element holds
 *      the shape's largest slot BY CONSTRUCTION — never by a post-hoc fixup.
 *   4. TITLE-SAFE CONTAINMENT. Every non-bleed slot lives inside the SMPTE
 *      title-safe rect, further clipped above the chrome bar.
 *   5. VARIETY IS A HARD REQUIREMENT. "Not every scene should look like s2."
 *      One balanced grid for everything is a FAILURE even if the metrics
 *      improve. Hence a repertoire, and `SHAPES` is deliberately wide.
 *   6. SPARSE REMAINS LEGAL. A single big focal object with symmetric air is
 *      GOOD composition. Nothing here raises a coverage floor — the defect is an
 *      abandoned CONTIGUOUS region, not low coverage. `poster-center` exists
 *      precisely so the allocator can choose emptiness on purpose.
 *
 * Determinism: no Math.random, no Date, no iteration over unordered maps. The
 * same input yields a byte-identical Allocation.
 */

// ─── Canvas geometry ────────────────────────────────────────────────────────

export type Aspect = "16:9" | "9:16" | "1:1";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mirrors layout-composer.CANVAS / measure-scene.CANVAS_DIMS. Mirrored rather
 *  than imported to keep this a dependency-free leaf (the composer pulls the
 *  schema + choreograph). The values are fixed product canvases. */
export const CANVAS: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/** SMPTE title-safe (5% inset per side) — the containment contract for text,
 *  identical to the rect void-metric/plan-validate reason about. */
export const SAFE: Record<Aspect, Rect> = {
  "16:9": { x: 96, y: 54, w: 1728, h: 972 },
  "9:16": { x: 54, y: 96, w: 972, h: 1728 },
  "1:1": { x: 54, y: 54, w: 972, h: 972 },
};

/** Bottom chrome bar height (BrandChrome), verbatim from layout-composer. */
const chromeH = (aspect: Aspect): number => (aspect === "9:16" ? 80 : 72);

/** Breathing room between the lowest content edge and the chrome bar. */
const CHROME_GAP = 16;

/**
 * The CONTENT rect: title-safe, further clipped so nothing parks against the
 * chrome bar. Every shape lays out inside this and nothing else, which is what
 * makes containment (requirement 4) structural rather than checked.
 */
export const contentRect = (aspect: Aspect): Rect => {
  const safe = SAFE[aspect];
  const { h: H } = CANVAS[aspect];
  const bottom = Math.min(safe.y + safe.h, H - chromeH(aspect) - CHROME_GAP);
  return { x: safe.x, y: safe.y, w: safe.w, h: bottom - safe.y };
};

/** Gutter between adjacent slots, ~2.2% of the canvas short side (24px @1080).
 *  Big enough to read as deliberate separation, small enough that the air it
 *  creates never pools into a measurable void. */
const gutterFor = (aspect: Aspect): number => {
  const { w, h } = CANVAS[aspect];
  return Math.round(0.022 * Math.min(w, h));
};

/** Side of the throughline motif box — the same 200px square the composer pins
 *  (layout-composer.THROUGHLINE_SIZE), scaled off the canvas short side so the
 *  portrait/square canvases get a proportionate mark. */
const throughlineSize = (aspect: Aspect): number => Math.round(0.185 * Math.min(CANVAS[aspect].w, CANVAS[aspect].h));

// ─── Public contract ────────────────────────────────────────────────────────

export interface AllocElementInput {
  /** Stable id. Callers with duplicate roles must disambiguate (e.g. "copy#2"). */
  id: string;
  /** hero | copy | atmosphere | throughline | connector | chrome (others → body). */
  role: string;
  /** 1 = dominant focal object. Null/absent = unranked (sorts last). */
  focalRank?: number | null;
  /** Content size signals. All optional — absent falls back to a role prior. */
  textChars?: number;
  /** Rows/bullets/meta cells the element must carry. */
  itemCount?: number;
  /** Interior-inventory length (the head's own density signal for a hero). */
  interiorCount?: number;
  /**
   * REAL painted size, when a measured `rects-scene-N.json` exists for this
   * scene. Used as a lower bound on the allocated box (an element must never be
   * given less room than it is known to paint) and as a weight signal. Null when
   * the scene predates measurement — then a role-based prior is used, and the
   * dry-run reports which scenes had which.
   */
  measured?: { w: number; h: number } | null;
  /**
   * The size the composition head authored for this element, when replaying
   * against a stored plan. REQUIRED for `mode: "reposition"`, which keeps this
   * size verbatim and changes only where the box sits — the arm that isolates
   * "the head's placement is wrong" from "the head's SIZING is wrong".
   */
  authoredSize?: { w: number; h: number } | null;
  /**
   * How much room this element's content ACTUALLY needs (lib/agents/
   * content-extent.ts): a measured painted rect where one exists, otherwise a
   * capacity-derived extent from the real copy strings, otherwise the head's
   * authored box as a scale anchor. Round 1 had none of this and sized from a
   * role name; both control regressions it produced were size errors.
   */
  contentExtent?: { neededArea: number; naturalW: number; naturalH: number; minW: number; source: string } | null;
  /**
   * THE EMBEDDED-MOTIF RELATION. When the head placed this element fully INSIDE
   * another (71 of 95 stored hero+motif scenes do exactly this — a status chip
   * in a card header, a payment button inside a checkout modal), it is a CHILD,
   * not a peer to be re-placed. The allocator keeps it inside its parent at the
   * same relative rect. Round 1 turned every one of these into a floating
   * badge, which is what wrecked all three controls.
   */
  embeddedIn?: string | null;
  /** The child's rect as fractions of the parent's box: preserved verbatim. */
  embeddedRect?: { fx: number; fy: number; fw: number; fh: number } | null;
}

/**
 * Whether the scene's dominant visual is a CANVAS TREATMENT or a PLACED object.
 * Round 1 called this underivable from structure and it is — from *structure*.
 * It is not underivable from the plan: the head's own authored hero area says
 * so exactly (≥85% of the frame is the same threshold every other module uses
 * for a canvas treatment). Passed in explicitly rather than guessed, because
 * guessing it from the register alone is what converted a centred checkout
 * modal into a full-bleed wash. `null` = unknown → treat as PLACED and preserve
 * the head's hero scale; never inflate on an absent signal.
 */
export type HeroTreatment = "bleed" | "placed" | null;

/**
 * Which authority the allocator takes from the model.
 *   - `"resize"`   — full authorship: the allocator chooses position AND size
 *                    from role, focal rank and content (the default).
 *   - `"reposition"` — the head keeps its authored SIZE; the allocator moves
 *                    the boxes only. Running both arms is the whole point: if
 *                    reposition-only captures most of the gain, the head's
 *                    placement is broadly fine and the fix is small; if it
 *                    captures little, the sizing is what is wrong.
 */
export type AllocMode = "resize" | "reposition";

export interface AllocInput {
  aspect: Aspect;
  /** stat | quote | full-bleed | split | list | centered (unknown → centered). */
  register?: string;
  elements: AllocElementInput[];
  mode?: AllocMode;
  /** See HeroTreatment. Absent → "placed" (never inflate on an absent signal). */
  heroTreatment?: HeroTreatment;
}

export type SlotLayer = "base" | "content" | "overlay" | "chrome";

export interface AllocSlot {
  id: string;
  role: string;
  bounds: Rect;
  layer: SlotLayer;
  /** Ids this slot may INTENTIONALLY overlap (declared layering). Symmetric:
   *  an overlap is legal iff either side declares the other. */
  allowedOverlaps: string[];
  /** The shape's slot name this element landed in ("focal", "band-top", …). */
  slot: string;
}

export interface Allocation {
  /** The chosen distribution's id — the diversity number counts these. */
  shape: string;
  register: string;
  aspect: Aspect;
  slots: AllocSlot[];
  /** Which authority the allocator took (see AllocMode). */
  mode: AllocMode;
  /** True when the shape was RE-PICKED because the first choice left structural
   *  dead space remote from every element. */
  repicked: boolean;
  /** True when at least one element carried a real measured size. */
  usedMeasured: boolean;
}

// ─── Registers ──────────────────────────────────────────────────────────────

const REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered"] as const;
type Register = (typeof REGISTERS)[number];

const normalizeRegister = (r: string | undefined): Register =>
  (REGISTERS as readonly string[]).includes(r ?? "") ? (r as Register) : "centered";

// ─── Content weight ─────────────────────────────────────────────────────────

/** Role priors for relative visual mass, used only when a shape has to choose
 *  BETWEEN peers of equal prominence. Focal order (requirement 3) always wins
 *  over weight — weight breaks ties among the subordinates. */
const ROLE_MASS: Record<string, number> = {
  hero: 1.0,
  copy: 0.62,
  connector: 0.34,
  throughline: 0.2,
};

/**
 * A single scalar for "how much room does this element's CONTENT want".
 * Measured area dominates when known; otherwise the role prior is modulated by
 * text length / item count / interior density. Bounded to [0.25, 2.0] so one
 * enormous signal can never starve a peer.
 */
export const contentWeight = (el: AllocElementInput, aspect: Aspect): number => {
  const base = ROLE_MASS[el.role] ?? 0.5;
  if (el.measured && el.measured.w > 0 && el.measured.h > 0) {
    const { w: W, h: H } = CANVAS[aspect];
    // sqrt so a 4× area difference reads as 2× mass, not 4× — a measured hero
    // must not flatten the copy column to a sliver.
    const frac = Math.sqrt((el.measured.w * el.measured.h) / (W * H));
    return clamp(frac * 2.2, 0.25, 2.0);
  }
  let w = base;
  if (typeof el.textChars === "number" && el.textChars > 0) {
    // 160 chars ≈ the neutral point; log so a 10× longer string is ~2× the mass.
    w *= clamp(1 + Math.log2(Math.max(el.textChars, 20) / 160) * 0.28, 0.6, 1.7);
  }
  if (typeof el.itemCount === "number" && el.itemCount > 0) w *= clamp(1 + (el.itemCount - 3) * 0.07, 0.7, 1.5);
  if (typeof el.interiorCount === "number" && el.interiorCount > 0) {
    w *= clamp(1 + (el.interiorCount - 6) * 0.05, 0.75, 1.45);
  }
  return clamp(w, 0.25, 2.0);
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ─── Size bounds (resizing is a first-class lever) ──────────────────────────
//
// RESIZING IS NOT A SIDE EFFECT OF PLACEMENT — it is half the hypothesis. Every
// reference-grade frame we have carries a LARGE dominant element (the Razorpay
// checkout modal, the Notion workspace panel, the Checkr dashboard); every void
// failure carries a SMALL element adrift (Notion s0's ticket card, s4's floating
// CTA pill). So the allocator may grow the focal object to absorb dead space and
// shrink a subordinate that crowds it.
//
// TWO CONSTRAINTS MAKE THAT SAFE, and both are load-bearing:
//
//   (1) A BIGGER BOX MUST CARRY A BIGGER CONTENT BUDGET. The leaf writes content
//       for the box it is told about (`capacity.ts` / `describeCapacity`, P4b).
//       Enlarging a box WITHOUT enlarging its capacity budget produces a large
//       box with sparse content — the hollow-hero defect, strictly worse than
//       the small-but-full box you started from. Any allocator that ships must
//       emit a NEW capacity budget alongside every resize. This dry run does not
//       emit content, so it cannot demonstrate that half; the report says so.
//
//   (2) BOUNDS ARE PER ROLE AND PER KIND. A chip is legitimately small; a rank-1
//       hero is not. TEXT is bounded in BOTH directions — below a floor it is
//       illegible (copy-fit.ts already refuses to shrink past 0.7×), above a
//       ceiling the measure gets unreadably long. A diegetic mock scales far
//       more freely.

export interface SizeBound {
  /** Minimum legible extent, px on the canvas short side's scale. */
  minW: number;
  minH: number;
  /** Maximum share of the CONTENT rect's area this role may claim. */
  maxAreaFrac: number;
  /** Minimum share, applied only to the rank-1 focal element (see below). */
  minFocalAreaFrac: number;
}

/** Bounds by role. Text roles ("copy") are tighter at BOTH ends than diegetic
 *  ones — an over-wide measure is as much a defect as an illegible one. */
export const SIZE_BOUNDS: Record<string, SizeBound> = {
  hero: { minW: 260, minH: 180, maxAreaFrac: 0.92, minFocalAreaFrac: 0.2 },
  copy: { minW: 300, minH: 90, maxAreaFrac: 0.55, minFocalAreaFrac: 0.16 },
  throughline: { minW: 64, minH: 64, maxAreaFrac: 0.16, minFocalAreaFrac: 0.02 },
  connector: { minW: 90, minH: 60, maxAreaFrac: 0.3, minFocalAreaFrac: 0.05 },
};
const DEFAULT_BOUND: SizeBound = { minW: 120, minH: 80, maxAreaFrac: 0.6, minFocalAreaFrac: 0.1 };

export const boundsFor = (role: string): SizeBound => SIZE_BOUNDS[role] ?? DEFAULT_BOUND;

/**
 * A TEXT BOX MAY NOT EXCEED WHAT ITS CONTENT NEEDS BY MORE THAN THIS FACTOR.
 * Round 1 blew a 320×200 corner of copy up to 795×648 — 8× — purely from a role
 * prior. A box enlarged past its content without a matching capacity budget
 * paints a large sparse panel, which is strictly worse than the small full one
 * it replaced. 2.0 leaves genuine breathing room (the head's own authored boxes
 * measure 1.1–1.9× their painted ink across the 10 measured scenes) while
 * making an 8× inflation impossible.
 */
export const COPY_AREA_CEILING = 2.0;

/**
 * How far a hero may depart from the head's authored SCALE. There is no
 * content-derived hero size available from anything on disk — painted area
 * equals authored area in all 10 measured scenes, and interior-item count does
 * not correlate with it — so the head's own area is the only honest anchor.
 * Growth is still allowed up to the focal floor, which is what rescues a
 * genuinely adrift focal object (flags-notion s0's hero is 9.3% of frame).
 */
export const HERO_GROWTH_CAP = 1.6;
export const HERO_SHRINK_CAP = 1.35;

/**
 * Clamp a box's SIZE into its legal band, scaled about the box's own centre so
 * the composition's balance is preserved while the size changes. Three bands
 * apply, tightest wins:
 *   - the role band (legibility floor, area ceiling);
 *   - the CONTENT band, when a measured/derived extent is known: at least what
 *     the content needs, at most COPY_AREA_CEILING × that, for text;
 *   - the AUTHORED SCALE band for a hero (see HERO_GROWTH_CAP).
 * `isFocal` engages the minimum-area floor — the "small element adrift" fix.
 */
const clampSize = (
  b: Rect,
  role: string,
  C: Rect,
  isFocal: boolean,
  el?: AllocElementInput,
): Rect => {
  const bound = boundsFor(role);
  const cA = area(C);
  let { w, h } = b;
  const extent = el?.contentExtent ?? null;
  const isText = role === "copy";
  // Floors first (a rank-1 element must command real area), ceilings second, so
  // a role whose floor and ceiling conflict resolves in favour of the ceiling.
  const scaleTo = (target: number) => {
    const k = Math.sqrt(target / Math.max(1, w * h));
    w *= k;
    h *= k;
  };
  if (isFocal && w * h < bound.minFocalAreaFrac * cA) scaleTo(bound.minFocalAreaFrac * cA);
  if (w * h > bound.maxAreaFrac * cA) scaleTo(bound.maxAreaFrac * cA);

  // CONTENT BAND — text only. A text box must hold its content, and must not
  // exceed it by more than the ceiling. Applied AFTER the role band so a
  // content-driven bound always wins over a role prior.
  if (isText && extent && extent.neededArea > 0) {
    if (w * h < extent.neededArea) scaleTo(extent.neededArea);
    if (w * h > COPY_AREA_CEILING * extent.neededArea) scaleTo(COPY_AREA_CEILING * extent.neededArea);
    // Never narrower than the longest unbreakable word.
    if (w < extent.minW) w = extent.minW;
  }

  // AUTHORED-SCALE BAND — non-text (heroes). Growth is bounded, but never below
  // the focal floor: a genuinely adrift focal object is still rescued.
  if (!isText && el?.authoredSize && el.authoredSize.w > 0 && el.authoredSize.h > 0) {
    const authored = el.authoredSize.w * el.authoredSize.h;
    const ceiling = Math.max(HERO_GROWTH_CAP * authored, isFocal ? bound.minFocalAreaFrac * cA : 0);
    const floorA = authored / HERO_SHRINK_CAP;
    if (w * h > ceiling) scaleTo(ceiling);
    if (w * h < floorA) scaleTo(floorA);
  }

  w = Math.max(w, bound.minW);
  h = Math.max(h, bound.minH);
  w = Math.min(w, C.w);
  h = Math.min(h, C.h);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
};

// ─── Shape repertoire ───────────────────────────────────────────────────────
//
// A shape is a pure function from the content rect + a gutter to an ORDERED
// list of named slots, MOST PROMINENT FIRST. Elements are mapped onto slots in
// focal order, so slot[0] always holds focalRank 1. Fractions (not literals) so
// one table serves all three canvases.
//
// Every shape's fractions are checked by `assertAllocation` on every call —
// a shape whose slots overlap or escape the content rect throws at allocate
// time, exactly like the composer's `assertPlanInvariants`.

interface ShapeSlot {
  name: string;
  /** Fractional rect within the content box: 0..1 on each axis. */
  f: { x: number; y: number; w: number; h: number };
  /** Full-canvas treatment: ignores the content rect, becomes the whole frame,
   *  and declares an overlap with everything (the copy-over-canvas case). */
  bleed?: boolean;
}

type Shape = { id: string; slots: ShapeSlot[] };

/** Fractions are laid out so that x+w ≤ 1 and y+h ≤ 1 with visible margins;
 *  the gutter is baked into the numbers rather than subtracted afterwards,
 *  which keeps each shape auditable at a glance (the composer's own rationale
 *  for literal tables over formulas). */
const SHAPES: Record<string, Shape> = {
  // ── ONE body: deliberate emptiness. Requirement 6 made concrete. ──────────
  "poster-center": {
    id: "poster-center",
    slots: [{ name: "focal", f: { x: 0.17, y: 0.16, w: 0.66, h: 0.62 } }],
  },

  // ── TWO bodies ───────────────────────────────────────────────────────────
  /** Copy band riding above a wide centered focal object. The default. */
  "centered-focal": {
    id: "centered-focal",
    slots: [
      { name: "focal", f: { x: 0.2, y: 0.36, w: 0.6, h: 0.6 } },
      { name: "band-top", f: { x: 0.17, y: 0.0, w: 0.66, h: 0.3 } },
    ],
  },
  /** The focal object owns almost the full width; copy is a narrow base strip.
   *  Chosen for interior-dense heroes with short copy — the "product shot"
   *  composition, and the lowest-void shape in the repertoire. */
  "hero-dominant-strip": {
    id: "hero-dominant-strip",
    slots: [
      { name: "focal", f: { x: 0.02, y: 0.0, w: 0.96, h: 0.66 } },
      { name: "strip-base", f: { x: 0.13, y: 0.72, w: 0.74, h: 0.26 } },
    ],
  },
  /** Focal mock right, copy column left. */
  "split-mock-right": {
    id: "split-mock-right",
    slots: [
      { name: "focal", f: { x: 0.45, y: 0.06, w: 0.55, h: 0.86 } },
      { name: "column-left", f: { x: 0.0, y: 0.17, w: 0.41, h: 0.62 } },
    ],
  },
  /** Mirror. Chosen when the hero is authored BEFORE the copy — a real input
   *  signal (reading order), not a coin flip, so the choice stays deterministic
   *  while still producing left/right variety across the corpus. */
  "split-mock-left": {
    id: "split-mock-left",
    slots: [
      { name: "focal", f: { x: 0.0, y: 0.06, w: 0.55, h: 0.86 } },
      { name: "column-right", f: { x: 0.59, y: 0.17, w: 0.41, h: 0.62 } },
    ],
  },
  /**
   * The stat register: a wide metric band high in frame with its support
   * beneath. This was FIRST authored as a left/right split, and the corpus
   * refuted it — a dominant column pinned to the left edge produced the worst
   * ink centroids in the whole run (p5a-off s3 head 0.060 → allocator 0.332),
   * while the head puts a stat counter across the middle of the frame
   * (flags-notion s3 hero at x 460..1460 on a 1920 canvas). A stat is read, not
   * compared side-by-side.
   */
  "stat-band": {
    id: "stat-band",
    slots: [
      { name: "focal", f: { x: 0.06, y: 0.06, w: 0.88, h: 0.5 } },
      { name: "support", f: { x: 0.19, y: 0.62, w: 0.62, h: 0.36 } },
    ],
  },
  /** Tall list column beside a squarer supporting panel. */
  "list-grid": {
    id: "list-grid",
    slots: [
      { name: "focal", f: { x: 0.42, y: 0.1, w: 0.58, h: 0.78 } },
      { name: "column-list", f: { x: 0.0, y: 0.0, w: 0.38, h: 0.98 } },
    ],
  },
  /** Wide pull-quote high in frame, supporting band beneath. */
  "quote-stack": {
    id: "quote-stack",
    slots: [
      { name: "focal", f: { x: 0.07, y: 0.0, w: 0.86, h: 0.44 } },
      { name: "band-under", f: { x: 0.19, y: 0.52, w: 0.62, h: 0.46 } },
    ],
  },

  // ── THREE bodies ─────────────────────────────────────────────────────────
  /** Copy above, focal centre, meta strip below — the classic editorial stack. */
  "centered-focal-base": {
    id: "centered-focal-base",
    slots: [
      { name: "focal", f: { x: 0.19, y: 0.29, w: 0.62, h: 0.46 } },
      { name: "band-top", f: { x: 0.17, y: 0.0, w: 0.66, h: 0.24 } },
      { name: "strip-base", f: { x: 0.14, y: 0.81, w: 0.72, h: 0.19 } },
    ],
  },
  /** Three centred bands: the metric, its caption row, then a footing strip.
   *  Same correction as `stat-band` — the left/right original centroid-failed. */
  "stat-band-strip": {
    id: "stat-band-strip",
    slots: [
      { name: "focal", f: { x: 0.1, y: 0.0, w: 0.8, h: 0.42 } },
      { name: "support", f: { x: 0.1, y: 0.48, w: 0.8, h: 0.28 } },
      { name: "strip-base", f: { x: 0.06, y: 0.8, w: 0.88, h: 0.2 } },
    ],
  },
  /** List column left; the right side stacks focal over a secondary panel. */
  "list-grid-stack": {
    id: "list-grid-stack",
    slots: [
      // The focal MUST out-area the tall list column (0.36×0.98 = 0.353) —
      // 0.60×0.66 = 0.396 does; the first draft's 0.58×0.58 did not, and the
      // focal-dominance test caught it.
      { name: "focal", f: { x: 0.4, y: 0.0, w: 0.6, h: 0.66 } },
      { name: "column-list", f: { x: 0.0, y: 0.0, w: 0.36, h: 0.98 } },
      { name: "panel-under", f: { x: 0.4, y: 0.72, w: 0.6, h: 0.26 } },
    ],
  },
  /** A wide focal band over a row of two peers — used when the two
   *  subordinates carry comparable mass and would look wrong stacked. */
  "band-over-pair": {
    id: "band-over-pair",
    slots: [
      { name: "focal", f: { x: 0.03, y: 0.0, w: 0.94, h: 0.56 } },
      { name: "pair-left", f: { x: 0.03, y: 0.62, w: 0.46, h: 0.38 } },
      { name: "pair-right", f: { x: 0.51, y: 0.62, w: 0.46, h: 0.38 } },
    ],
  },

  // ── FOUR+ bodies ─────────────────────────────────────────────────────────
  /** Asymmetric quad: a dominant focal quadrant with three subordinates. */
  "editorial-quad": {
    id: "editorial-quad",
    slots: [
      { name: "focal", f: { x: 0.0, y: 0.0, w: 0.6, h: 0.58 } },
      { name: "quad-tr", f: { x: 0.64, y: 0.0, w: 0.36, h: 0.58 } },
      { name: "quad-bl", f: { x: 0.0, y: 0.64, w: 0.6, h: 0.36 } },
      { name: "quad-br", f: { x: 0.64, y: 0.64, w: 0.36, h: 0.36 } },
    ],
  },
  /** Focal column left, three stacked cards right. */
  "column-plus-stack": {
    id: "column-plus-stack",
    slots: [
      { name: "focal", f: { x: 0.0, y: 0.0, w: 0.56, h: 0.98 } },
      { name: "card-1", f: { x: 0.6, y: 0.0, w: 0.4, h: 0.3 } },
      { name: "card-2", f: { x: 0.6, y: 0.34, w: 0.4, h: 0.3 } },
      { name: "card-3", f: { x: 0.6, y: 0.68, w: 0.4, h: 0.3 } },
    ],
  },

  /**
   * ONE DOMINANT PLACED OBJECT with a whisper of copy in a corner — the
   * composition `p3-cycle8-razorpay s2` actually has (a 1080×920 checkout modal
   * floating dead-centre, 320×200 of copy in the lower-left). Round 1 had no
   * shape for this and sent every full-bleed REGISTER to a canvas bleed, which
   * is what destroyed that control. It is chosen when the register says
   * full-bleed but the hero treatment says PLACED.
   */
  "dominant-center-corner-copy": {
    id: "dominant-center-corner-copy",
    slots: [
      // The focal object is centred on the FRAME's axis (x 0.17 + w 0.66 → a
      // centre of exactly 0.5), because that centring is the composition: the
      // head put razorpay's modal at x 420..1500 on a 1920 frame, dead centre.
      // An off-axis focal here measured a 2.4× worse ink centroid.
      { name: "focal", f: { x: 0.17, y: 0.0, w: 0.66, h: 0.78 } },
      { name: "corner-copy", f: { x: 0.0, y: 0.82, w: 0.42, h: 0.18 } },
      { name: "corner-second", f: { x: 0.5, y: 0.82, w: 0.5, h: 0.18 } },
    ],
  },

  // ── Full-bleed treatments (declared layering) ─────────────────────────────
  /** The canvas IS the focal object; copy sits in a lower-left inset. */
  "full-bleed-corner-copy": {
    id: "full-bleed-corner-copy",
    slots: [
      { name: "focal", f: { x: 0, y: 0, w: 1, h: 1 }, bleed: true },
      { name: "inset-lower-left", f: { x: 0.0, y: 0.58, w: 0.46, h: 0.4 } },
      { name: "inset-upper-right", f: { x: 0.6, y: 0.0, w: 0.4, h: 0.26 } },
    ],
  },
  /** Full-bleed treatment with the copy centred over it — used when the COPY
   *  is the rank-1 element and the visual is genuinely a backdrop. */
  "full-bleed-center-copy": {
    id: "full-bleed-center-copy",
    slots: [
      { name: "focal", f: { x: 0.16, y: 0.28, w: 0.68, h: 0.42 } },
      { name: "canvas", f: { x: 0, y: 0, w: 1, h: 1 }, bleed: true },
      { name: "inset-base", f: { x: 0.22, y: 0.78, w: 0.56, h: 0.2 } },
    ],
  },
};

/**
 * Portrait (9:16) re-maps the side-by-side shapes onto stacked equivalents:
 * a 41%-wide copy column is unreadable at 1080px wide. Square keeps the
 * landscape shapes (972px columns are fine). Applied AFTER the chooser so the
 * chooser stays about content, not canvas.
 */
const PORTRAIT_SUBSTITUTE: Record<string, string> = {
  "split-mock-right": "centered-focal",
  "split-mock-left": "hero-dominant-strip",
  "stat-band": "centered-focal",
  "list-grid": "centered-focal",
  "stat-band-strip": "centered-focal-base",
  "list-grid-stack": "centered-focal-base",
  "editorial-quad": "column-plus-stack",
  // An 18%-wide corner of copy is 175px at 1080 — below the legibility floor.
  "dominant-center-corner-copy": "centered-focal-base",
};

// ─── The chooser ────────────────────────────────────────────────────────────

/**
 * Pick a distribution. Register sets the family; element count, roles and
 * content size pick WITHIN it. This function is the whole answer to requirement
 * 5 — if it collapses to one shape across the corpus, the allocator has failed
 * regardless of what the void numbers say.
 *
 * Exported so the dry-run and the tests can interrogate the choice directly.
 */
export const chooseShape = (
  register: Register,
  /** Bodies in AUTHOR order (as the scene declares them) — reading order is one
   *  of the chooser's signals, so this must not be pre-sorted by focal rank. */
  bodies: AllocElementInput[],
  aspect: Aspect,
  /** See HeroTreatment. Absent → PLACED: never assume a canvas bleed. */
  heroTreatment: HeroTreatment = null,
): string => {
  const n = bodies.length;
  const focal = bodies
    .map((e, i) => ({ e, i }))
    .sort((a, b) => focalKey(a.e) - focalKey(b.e) || a.i - b.i)
    .map((p) => p.e)[0];
  const heroFirst = bodies.findIndex((b) => b.role === "hero");
  const copyFirst = bodies.findIndex((b) => b.role === "copy");
  const heroBeforeCopy = heroFirst >= 0 && (copyFirst < 0 || heroFirst < copyFirst);
  const focalIsCopy = focal?.role === "copy";
  const totalChars = bodies.reduce((s, b) => s + (b.textChars ?? 0), 0);
  const denseHero = bodies.some((b) => b.role === "hero" && (b.interiorCount ?? 0) >= 8);

  let id: string;

  if (n <= 1) {
    id = register === "full-bleed" ? "full-bleed-center-copy" : "poster-center";
  } else if (register === "full-bleed" && n <= 3) {
    // THE ROUND-1 BUG, FIXED. The register alone does NOT mean the visual is a
    // canvas treatment — 7 of the 18 stored full-bleed scenes place a bounded
    // hero (razorpay s2 at 48% of frame, rappi s2 at 22%). Sending those to a
    // canvas bleed is what destroyed the razorpay control. The treatment is now
    // an explicit input, and an ABSENT signal resolves to PLACED.
    if (heroTreatment === "bleed") id = focalIsCopy ? "full-bleed-center-copy" : "full-bleed-corner-copy";
    else id = n <= 1 ? "poster-center" : "dominant-center-corner-copy";
    // A canvas treatment PLUS four more placed elements is not a full-bleed
    // composition — it is a dashboard. Over 3 bodies, fall through to the
    // placed families below, which have enough slots to keep every box legible.
  } else if (n === 2) {
    if (register === "split") id = heroBeforeCopy ? "split-mock-left" : "split-mock-right";
    else if (register === "stat") id = "stat-band";
    else if (register === "list") id = "list-grid";
    else if (register === "quote") id = "quote-stack";
    else if (denseHero && totalChars < 220) id = "hero-dominant-strip";
    else id = "centered-focal";
  } else if (n === 3) {
    if (register === "stat") id = "stat-band-strip";
    else if (register === "list") id = "list-grid-stack";
    else if (register === "split") id = "band-over-pair";
    else if (register === "quote") id = "band-over-pair";
    else if (denseHero && totalChars < 260) id = "band-over-pair";
    else id = "centered-focal-base";
  } else {
    // 4+ bodies: a quad reads as composed; a column+stack reads as a dashboard.
    id = register === "list" || register === "stat" ? "column-plus-stack" : "editorial-quad";
  }

  if (aspect === "9:16" && PORTRAIT_SUBSTITUTE[id]) id = PORTRAIT_SUBSTITUTE[id];
  // The narrow-corner shape needs the landscape's width for its 18% copy
  // column; on BOTH square and portrait canvases that column is ~175px, under
  // the copy legibility floor. Substituted at any non-landscape aspect.
  // Count-aware: substituting a 3-slot shape for a 2-body scene leaves an
  // unused slot, and an unused slot IS a dead region (27.8% at 1:1).
  if (aspect !== "16:9" && id === "dominant-center-corner-copy") {
    id = n <= 2 ? "centered-focal" : "centered-focal-base";
  }
  return id;
};

// ─── Allocation ─────────────────────────────────────────────────────────────

const focalKey = (el: AllocElementInput): number =>
  typeof el.focalRank === "number" && Number.isFinite(el.focalRank) ? el.focalRank : Number.MAX_SAFE_INTEGER;

const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

/**
 * Split `rect` into `weights.length` disjoint bands along one axis, separated
 * by `gutter`. Proportional to weight, with a floor so no band collapses.
 * Integer-rounded by accumulating EXACT offsets and rounding at the edges, so
 * the bands tile the parent without a 1px seam or a 1px overlap.
 */
export const splitBand = (rect: Rect, weights: number[], dir: "row" | "col", gutter: number): Rect[] => {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [{ ...rect }];
  const extent = (dir === "col" ? rect.w : rect.h) - gutter * (n - 1);
  const floor = Math.max(24, Math.floor(extent * 0.12));
  const total = weights.reduce((s, w) => s + Math.max(w, 0.01), 0);
  let sizes = weights.map((w) => (Math.max(w, 0.01) / total) * extent);
  // Lift anything under the floor, then re-proportion the surplus among the
  // bands that are still above it (two passes converge for our band counts).
  for (let pass = 0; pass < 2; pass++) {
    const under = sizes.map((s) => s < floor);
    const deficit = sizes.reduce((d, s) => d + (s < floor ? floor - s : 0), 0);
    if (deficit <= 0) break;
    const pool = sizes.reduce((p, s, i) => p + (under[i] ? 0 : s), 0);
    if (pool <= deficit) break;
    sizes = sizes.map((s, i) => (under[i] ? floor : s - (s / pool) * deficit));
  }
  const out: Rect[] = [];
  let cursor = dir === "col" ? rect.x : rect.y;
  for (let i = 0; i < n; i++) {
    const start = Math.round(cursor);
    const end = Math.round(cursor + sizes[i]);
    out.push(
      dir === "col"
        ? { x: start, y: rect.y, w: Math.max(1, end - start), h: rect.h }
        : { x: rect.x, y: start, w: rect.w, h: Math.max(1, end - start) },
    );
    cursor += sizes[i] + gutter;
  }
  return out;
};

const place = (C: Rect, f: ShapeSlot["f"]): Rect => ({
  x: Math.round(C.x + f.x * C.w),
  y: Math.round(C.y + f.y * C.h),
  w: Math.round(f.w * C.w),
  h: Math.round(f.h * C.h),
});

/**
 * Absorb the largest residual void (requirement 2) by growing the ONE slot that
 * shares the longest edge with it, by at most `MAX_ABSORB` of the void's extent
 * on that axis. Bounded three ways: capped growth, reverted on any new overlap,
 * and never applied to a bleed slot. This is the only step that is not pure
 * table geometry, and it is deliberately timid — the failure mode we are
 * avoiding is an over-fill regression, not a slightly airy frame.
 */
const MAX_ABSORB = 0.55;

/**
 * Is this void ADJACENT to some element (shares an edge within a gutter), or is
 * it remote from everything? The distinction drives the repair rule:
 *   adjacent → GROW the neighbour into it (local dead space);
 *   remote   → the DISTRIBUTION is wrong; re-pick the shape (structural dead
 *              space). Never teleport an element across the frame to plug it.
 */
const voidIsAdjacent = (v: Rect, claimed: Rect[], gutter: number): boolean => {
  const near = (a: number, b: number) => Math.abs(a - b) <= gutter + 2;
  for (const b of claimed) {
    const overlapX = Math.min(b.x + b.w, v.x + v.w) - Math.max(b.x, v.x);
    const overlapY = Math.min(b.y + b.h, v.y + v.h) - Math.max(b.y, v.y);
    if (overlapX > 0 && (near(b.y + b.h, v.y) || near(v.y + v.h, b.y))) return true;
    if (overlapY > 0 && (near(b.x + b.w, v.x) || near(v.x + v.w, b.x))) return true;
  }
  return false;
};

/** A void bigger than this share of the content rect, and REMOTE from every
 *  element, means the distribution itself is wrong. Calibrated against the
 *  corpus: the head's median largest void is ~14%, its 84th percentile ~25%. */
const VOID_REPICK_FRAC = 0.22;

/**
 * The re-pick ladder: when a shape leaves structural dead space, fall to a
 * DENSER distribution carrying the same body count. Each entry is a genuine
 * alternative composition, not a generic grid — variety survives the repair.
 */
const REPICK: Record<string, string> = {
  "poster-center": "centered-focal",
  "centered-focal": "hero-dominant-strip",
  "hero-dominant-strip": "centered-focal",
  "split-mock-right": "hero-dominant-strip",
  "split-mock-left": "hero-dominant-strip",
  "stat-band": "centered-focal",
  "list-grid": "hero-dominant-strip",
  "quote-stack": "centered-focal",
  "centered-focal-base": "band-over-pair",
  "stat-band-strip": "band-over-pair",
  "list-grid-stack": "band-over-pair",
  "band-over-pair": "centered-focal-base",
  "editorial-quad": "column-plus-stack",
  "column-plus-stack": "editorial-quad",
};

/**
 * CROWDING repair: a subordinate sitting closer than a gutter to the focal
 * object is SHRUNK away from it, never moved. Moving it would open a new gap
 * somewhere else — that is the "never teleport" rule applied at short range.
 */
const relieveCrowding = (slots: AllocSlot[], gutter: number): void => {
  const content = slots.filter((s) => s.layer === "content");
  const focal = content.find((s) => s.slot === "focal" || s.slot.startsWith("focal/"));
  if (!focal) return;
  for (const s of content) {
    if (s === focal) continue;
    const b = s.bounds;
    const f = focal.bounds;
    const overlapX = Math.min(b.x + b.w, f.x + f.w) - Math.max(b.x, f.x);
    const overlapY = Math.min(b.y + b.h, f.y + f.h) - Math.max(b.y, f.y);
    const bound = boundsFor(s.role);
    if (overlapX > 0) {
      const gapBelow = b.y - (f.y + f.h);
      const gapAbove = f.y - (b.y + b.h);
      if (gapBelow >= 0 && gapBelow < gutter) {
        const cut = gutter - gapBelow;
        if (b.h - cut >= bound.minH) {
          b.y += cut;
          b.h -= cut;
        }
      } else if (gapAbove >= 0 && gapAbove < gutter) {
        const cut = gutter - gapAbove;
        if (b.h - cut >= bound.minH) b.h -= cut;
      }
    }
    if (overlapY > 0) {
      const gapRight = b.x - (f.x + f.w);
      const gapLeft = f.x - (b.x + b.w);
      if (gapRight >= 0 && gapRight < gutter) {
        const cut = gutter - gapRight;
        if (b.w - cut >= bound.minW) {
          b.x += cut;
          b.w -= cut;
        }
      } else if (gapLeft >= 0 && gapLeft < gutter) {
        const cut = gutter - gapLeft;
        if (b.w - cut >= bound.minW) b.w -= cut;
      }
    }
  }
};

const absorbVoid = (slots: AllocSlot[], C: Rect, gutter: number, canGrow?: (s: AllocSlot) => boolean): void => {
  const content = slots.filter((s) => s.layer === "content");
  if (content.length === 0) return;
  // Requirement 3 outranks requirement 2: absorbing a void must never let a
  // subordinate out-area the focal object.
  const focalSlot = content.find((s) => s.slot === "focal" || s.slot.startsWith("focal/"));
  const focalArea = focalSlot ? area(focalSlot.bounds) : Infinity;
  const v = largestFreeRect(content.map((s) => s.bounds), C);
  if (!v || area(v) < 0.06 * area(C)) return;

  // Which slot shares the longest edge with the void, and on which side?
  let best: { s: AllocSlot; axis: "x" | "y"; dir: 1 | -1; shared: number } | null = null;
  for (const s of content) {
    if (canGrow && !canGrow(s)) continue;
    const b = s.bounds;
    const overlapX = Math.min(b.x + b.w, v.x + v.w) - Math.max(b.x, v.x);
    const overlapY = Math.min(b.y + b.h, v.y + v.h) - Math.max(b.y, v.y);
    const near = (a: number, bb: number) => Math.abs(a - bb) <= gutter + 2;
    const cands: { axis: "x" | "y"; dir: 1 | -1; shared: number }[] = [];
    if (overlapX > 0) {
      if (near(b.y + b.h, v.y)) cands.push({ axis: "y", dir: 1, shared: overlapX });
      if (near(v.y + v.h, b.y)) cands.push({ axis: "y", dir: -1, shared: overlapX });
    }
    if (overlapY > 0) {
      if (near(b.x + b.w, v.x)) cands.push({ axis: "x", dir: 1, shared: overlapY });
      if (near(v.x + v.w, b.x)) cands.push({ axis: "x", dir: -1, shared: overlapY });
    }
    for (const c of cands) if (!best || c.shared > best.shared) best = { s, ...c };
  }
  if (!best) return;

  const b = best.s.bounds;
  const before = { ...b };
  const grow = Math.floor(MAX_ABSORB * (best.axis === "x" ? v.w : v.h)) - gutter;
  if (grow <= 8) return;
  if (best.axis === "x") {
    if (best.dir === 1) b.w += grow;
    else {
      b.x -= grow;
      b.w += grow;
    }
  } else if (best.dir === 1) b.h += grow;
  else {
    b.y -= grow;
    b.h += grow;
  }
  // Revert on ANY new collision, on escaping the content rect, or on stealing
  // the focal anchor.
  const escaped = b.x < C.x || b.y < C.y || b.x + b.w > C.x + C.w || b.y + b.h > C.y + C.h;
  const collided = content.some((o) => o !== best!.s && rectsOverlap(o.bounds, b));
  const stoleFocal = best.s !== focalSlot && area(b) > focalArea;
  // Absorption must respect the size bands too — growing the focal object past
  // a text role's ceiling reintroduces exactly the inflated-copy-panel defect
  // the ceiling exists to prevent.
  const bound = boundsFor(best.s.role);
  const overRole = area(b) > bound.maxAreaFrac * area(C);
  if (escaped || collided || stoleFocal || overRole) Object.assign(b, before);
};

/**
 * The largest all-free axis-aligned rectangle among `claimed` inside `frame`,
 * on a 54px lattice — the same instrument (and the same lattice) the void
 * metric uses, so the absorption pass and the scoring agree about what a void
 * is.
 *
 * CONSERVATIVE BY DESIGN: a cell is occupied when it INTERSECTS a claimed rect,
 * not merely when its centre falls inside one. The scorer samples centres
 * (that is the published lattice semantics the P2 void column was measured on),
 * but a PLACEMENT primitive that samples centres can return a rect which
 * partially overlaps a neighbour — and it did, producing an undeclared overlap
 * for the residual/motif slots. Here the returned rect is guaranteed free.
 */
const LATTICE = 54;

export const largestFreeRect = (claimed: Rect[], frame: Rect): Rect | null => {
  const cols = Math.max(1, Math.floor(frame.w / LATTICE));
  const rows = Math.max(1, Math.floor(frame.h / LATTICE));
  const occ: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array<boolean>(cols).fill(false);
    const cy = frame.y + r * LATTICE;
    for (let c = 0; c < cols; c++) {
      const cx = frame.x + c * LATTICE;
      const cell = { x: cx, y: cy, w: LATTICE, h: LATTICE };
      for (const q of claimed) {
        if (rectsOverlap(cell, q)) {
          row[c] = true;
          break;
        }
      }
    }
    occ.push(row);
  }
  // Maximal rectangle in a binary matrix: per-row histogram + monotonic stack.
  const heights = new Array<number>(cols).fill(0);
  let best = 0;
  let box: { c0: number; r0: number; c1: number; r1: number } | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = occ[r][c] ? 0 : heights[c] + 1;
    const stack: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const h = i === cols ? 0 : heights[i];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const left = stack.length === 0 ? -1 : stack[stack.length - 1];
        const a = heights[top] * (i - left - 1);
        if (a > best) {
          best = a;
          box = { c0: left + 1, c1: i - 1, r0: r - heights[top] + 1, r1: r };
        }
      }
      stack.push(i);
    }
  }
  if (!box || best === 0) return null;
  return {
    x: frame.x + box.c0 * LATTICE,
    y: frame.y + box.r0 * LATTICE,
    w: (box.c1 - box.c0 + 1) * LATTICE,
    h: (box.r1 - box.r0 + 1) * LATTICE,
  };
};

/**
 * REPOSITION-ONLY arm. Each element keeps the size the head authored; only its
 * position changes. The element is centred on the slot the shape assigned it,
 * then a deterministic separation pass pushes overlapping pairs apart along
 * their axis of minimum overlap, lowest-priority element first (higher
 * focalRank moves; the focal object holds its ground).
 *
 * This can FAIL to converge — authored sizes are not guaranteed to be packable
 * into one frame, which is itself a finding: it means the head's sizes are the
 * problem, not its coordinates. Unresolved overlaps are left in place and
 * counted honestly by the scorer rather than papered over.
 */
const SEPARATION_ITERATIONS = 60;

const repositionOnly = (
  slots: AllocSlot[],
  sizeOf: Map<string, { w: number; h: number }>,
  rankOf: Map<string, number>,
  C: Rect,
  W: number,
  H: number,
): void => {
  const content = slots.filter((s) => s.layer === "content");
  for (const s of content) {
    const size = sizeOf.get(s.id);
    if (!size) continue;
    const cx = s.bounds.x + s.bounds.w / 2;
    const cy = s.bounds.y + s.bounds.h / 2;
    const w = Math.min(Math.max(1, Math.round(size.w)), W);
    const h = Math.min(Math.max(1, Math.round(size.h)), H);
    s.bounds = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
  }
  // An authored box too large to place inside the safe frame is a canvas
  // treatment; it becomes the base layer and declares its overlaps, exactly as
  // a shape-authored bleed does.
  for (const s of content) {
    if (s.bounds.w >= C.w && s.bounds.h >= C.h) {
      s.layer = "base";
      s.bounds = { x: Math.max(0, Math.round((W - s.bounds.w) / 2)), y: Math.max(0, Math.round((H - s.bounds.h) / 2)), w: Math.min(s.bounds.w, W), h: Math.min(s.bounds.h, H) };
      s.allowedOverlaps = slots.filter((o) => o.id !== s.id).map((o) => o.id);
    }
  }
  const movable = slots.filter((s) => s.layer === "content");
  const clampIn = (b: Rect) => {
    b.x = Math.round(clamp(b.x, C.x, Math.max(C.x, C.x + C.w - b.w)));
    b.y = Math.round(clamp(b.y, C.y, Math.max(C.y, C.y + C.h - b.h)));
  };
  for (const s of movable) clampIn(s.bounds);

  for (let iter = 0; iter < SEPARATION_ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < movable.length && !moved; i++) {
      for (let j = i + 1; j < movable.length && !moved; j++) {
        const a = movable[i];
        const b = movable[j];
        if (!rectsOverlap(a.bounds, b.bounds)) continue;
        if (a.allowedOverlaps.includes(b.id) || b.allowedOverlaps.includes(a.id)) continue;
        // The lower-priority element yields (higher focalRank = subordinate).
        const ra = rankOf.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rankOf.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        const mover = rb >= ra ? b : a;
        const anchor = mover === b ? a : b;
        const ox = Math.min(mover.bounds.x + mover.bounds.w, anchor.bounds.x + anchor.bounds.w) - Math.max(mover.bounds.x, anchor.bounds.x);
        const oy = Math.min(mover.bounds.y + mover.bounds.h, anchor.bounds.y + anchor.bounds.h) - Math.max(mover.bounds.y, anchor.bounds.y);
        const before = { ...mover.bounds };
        if (ox <= oy) {
          const dir = mover.bounds.x + mover.bounds.w / 2 >= anchor.bounds.x + anchor.bounds.w / 2 ? 1 : -1;
          mover.bounds.x += dir * (ox + 2);
        } else {
          const dir = mover.bounds.y + mover.bounds.h / 2 >= anchor.bounds.y + anchor.bounds.h / 2 ? 1 : -1;
          mover.bounds.y += dir * (oy + 2);
        }
        clampIn(mover.bounds);
        // The clamp can undo the push entirely (the mover is pinned against the
        // frame edge). Try the other axis once before giving up on this pair.
        if (rectsOverlap(mover.bounds, anchor.bounds)) {
          Object.assign(mover.bounds, before);
          if (ox <= oy) {
            const dir = mover.bounds.y + mover.bounds.h / 2 >= anchor.bounds.y + anchor.bounds.h / 2 ? 1 : -1;
            mover.bounds.y += dir * (oy + 2);
          } else {
            const dir = mover.bounds.x + mover.bounds.w / 2 >= anchor.bounds.x + anchor.bounds.w / 2 ? 1 : -1;
            mover.bounds.x += dir * (ox + 2);
          }
          clampIn(mover.bounds);
          if (rectsOverlap(mover.bounds, anchor.bounds)) {
            // Genuinely unpackable at these sizes — leave it and let the scorer
            // report the overlap. Declaring it away would hide the finding.
            Object.assign(mover.bounds, before);
            continue;
          }
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
};

/** Throws when the allocation violates a hard invariant. Called on EVERY
 *  allocate — a violation is an allocator bug (a bad shape table), never a
 *  runtime condition. Mirrors layout-composer.assertPlanInvariants. */
export const assertAllocation = (alloc: Allocation, opts?: { allowResidualOverlap?: boolean }): void => {
  // `allowResidualOverlap` = the REPOSITION arm, where disjointness and
  // title-safe containment are best-effort OUTCOMES rather than construction
  // invariants: the head's authored size is kept verbatim, and an authored box
  // wider than the safe frame cannot be contained without resizing it — which
  // is precisely the authority this arm withholds. Violations survive into the
  // score instead of being repaired away, because they ARE the finding.
  const { w: W, h: H } = CANVAS[alloc.aspect];
  const C = contentRect(alloc.aspect);
  for (const s of alloc.slots) {
    const { x, y, w, h } = s.bounds;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > W || y + h > H) {
      throw new Error(`allocate-layout: "${s.id}" bounds ${JSON.stringify(s.bounds)} escape the ${W}×${H} canvas (${alloc.shape})`);
    }
    if (s.layer === "content" && !opts?.allowResidualOverlap) {
      const inside = x >= C.x - 1 && y >= C.y - 1 && x + w <= C.x + C.w + 1 && y + h <= C.y + C.h + 1;
      if (!inside) throw new Error(`allocate-layout: "${s.id}" escapes the title-safe content rect (${alloc.shape})`);
    }
  }
  for (let i = 0; i < alloc.slots.length; i++) {
    for (let j = i + 1; j < alloc.slots.length; j++) {
      const a = alloc.slots[i];
      const b = alloc.slots[j];
      if (a.layer === "base" || b.layer === "base" || a.layer === "chrome" || b.layer === "chrome") continue;
      if (!rectsOverlap(a.bounds, b.bounds)) continue;
      if (a.allowedOverlaps.includes(b.id) || b.allowedOverlaps.includes(a.id)) continue;
      if (opts?.allowResidualOverlap) continue;
      throw new Error(`allocate-layout: UNDECLARED overlap "${a.id}"×"${b.id}" (${alloc.shape})`);
    }
  }
};

/**
 * Allocate bounds for every element of one scene. Pure and deterministic.
 *
 * Element handling by role:
 *   - `atmosphere` → the full canvas, layer "base", excluded from every metric.
 *   - `chrome`     → the bottom bar, layer "chrome".
 *   - `throughline`→ a fixed square, centred in the largest residual void so the
 *                    motif absorbs air instead of adding to it. Falls back to
 *                    the top-right safe corner (declaring an overlap with the
 *                    focal object, as the composer does) when nothing fits.
 *   - everything else = a BODY, mapped onto the chosen shape's slots in focal
 *                    order. Bodies beyond the shape's slot count are stacked
 *                    into the least-occupied residual void rather than dropped.
 */
export const allocateLayout = (input: AllocInput, opts?: { forceShape?: string; depth?: number }): Allocation => {
  const aspect = input.aspect;
  const mode: AllocMode = input.mode ?? "resize";
  const register = normalizeRegister(input.register);
  const { w: W, h: H } = CANVAS[aspect];
  const C = contentRect(aspect);
  const gutter = gutterFor(aspect);

  const atmos = input.elements.filter((e) => e.role === "atmosphere");
  const chrome = input.elements.filter((e) => e.role === "chrome");
  // EMBEDDED CHILDREN are not bodies. The head placed them inside another
  // element on purpose (71 of 95 stored hero+motif scenes); they are positioned
  // relative to their parent's final box, after the parent is placed.
  const isEmbedded = (e: AllocElementInput): boolean =>
    !!e.embeddedIn && !!e.embeddedRect && e.embeddedIn !== e.id;
  const embedded = input.elements.filter(isEmbedded);
  const motifs = input.elements.filter((e) => e.role === "throughline" && !isEmbedded(e));
  const bodiesRaw = input.elements.filter(
    (e) => e.role !== "atmosphere" && e.role !== "chrome" && e.role !== "throughline" && !isEmbedded(e),
  );

  // Focal order: rank 1 first, unranked last, input order as the stable
  // tie-break (never a weight comparison — requirement 3 outranks mass).
  const bodies = bodiesRaw
    .map((e, i) => ({ e, i }))
    .sort((a, b) => focalKey(a.e) - focalKey(b.e) || a.i - b.i)
    .map((p) => p.e);

  // STAGE 1 — CHOOSE A DISTRIBUTION. This decides POSITION, from register +
  // element count + roles. The chooser reads AUTHOR order (reading order is a
  // signal); the SLOT mapping below reads focal order. Two different orderings,
  // deliberately.
  const shapeId = opts?.forceShape ?? chooseShape(register, bodiesRaw, aspect, input.heroTreatment ?? null);
  const shape = SHAPES[shapeId];
  if (!shape) throw new Error(`allocate-layout: unknown shape "${shapeId}"`);

  const slots: AllocSlot[] = [];

  for (const a of atmos) {
    slots.push({
      id: a.id,
      role: a.role,
      bounds: { x: 0, y: 0, w: W, h: H },
      layer: "base",
      allowedOverlaps: [],
      slot: "canvas",
    });
  }

  // Map bodies onto shape slots in prominence order. When the shape has a
  // `bleed` slot that is NOT slot[0] (full-bleed-center-copy), the bleed slot
  // belongs to the visual, so it is filled by the first non-focal body.
  const bleedIx = shape.slots.findIndex((s) => s.bleed);
  const order: number[] = [];
  if (bleedIx > 0) {
    // focal first, then the bleed (the backdrop visual), then the rest in order.
    order.push(0, bleedIx);
    for (let i = 1; i < shape.slots.length; i++) if (i !== bleedIx) order.push(i);
  } else {
    for (let i = 0; i < shape.slots.length; i++) order.push(i);
  }

  const bleedIds: string[] = [];
  const placed: AllocSlot[] = [];
  const nSlots = order.length;
  for (let k = 0; k < bodies.length && k < nSlots; k++) {
    const el = bodies[k];
    const sSpec = shape.slots[order[k]];
    // OVER-SUBSCRIBED SHAPE: bodies beyond the repertoire's slot count are not
    // dropped (the composer silently drops duplicate roles — the orphaned-copy
    // defect fixed 2026-07-18; an allocator must not repeat it) and are not
    // parked in a residual void (a lattice-quantised void is not guaranteed to
    // fit them). The LAST slot is SUBDIVIDED among itself and the leftovers,
    // band-split along its longer axis, weighted by content — disjoint by
    // construction, which is requirement 1.
    //
    // KNOWN LIMIT, deliberately not hidden: a slot subdivided three ways can
    // fall below a role's legibility floor (a 691x244 inset split three ways
    // gives 214px-wide copy against a 300px floor). At that point the scene is
    // genuinely over-subscribed and no placement saves it — the honest signal
    // is a too-small box, not a silently dropped element. Subdivided slots are
    // named "<slot>/<n>" so the floor check can identify and report them.
    const isLast = k === nSlots - 1;
    const share = isLast ? bodies.slice(k) : [el];
    if (isLast && share.length > 1 && !sSpec.bleed) {
      const parent = place(C, sSpec.f);
      const weights = share.map((b) => contentWeight(b, aspect));
      const bands = splitBand(parent, weights, parent.w >= parent.h ? "col" : "row", gutter);
      for (let m = 0; m < share.length; m++) {
        const s: AllocSlot = {
          id: share[m].id,
          role: share[m].role,
          bounds: bands[m],
          layer: "content",
          allowedOverlaps: [],
          slot: `${sSpec.name}/${m + 1}`,
        };
        placed.push(s);
        slots.push(s);
      }
      break;
    }
    // A BLEED SLOT KEEPS THE HEAD'S AUTHORED SCALE when one exists. Forcing
    // (0,0,W,H) discarded final-checkr s2's deliberate 40px inset — the
    // dashboard is a single app shell sitting IN the frame, not running off it.
    const bleedBox = (): Rect => {
      const a = el.authoredSize;
      if (a && a.w > 0 && a.h > 0 && (a.w < W || a.h < H)) {
        const w = Math.min(a.w, W);
        const h = Math.min(a.h, H);
        return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
      }
      return { x: 0, y: 0, w: W, h: H };
    };
    const bounds = sSpec.bleed ? bleedBox() : place(C, sSpec.f);
    const s: AllocSlot = {
      id: el.id,
      role: el.role,
      bounds,
      layer: sSpec.bleed ? "base" : "content",
      allowedOverlaps: [],
      slot: sSpec.name,
    };
    if (sSpec.bleed) bleedIds.push(el.id);
    placed.push(s);
    slots.push(s);
  }

  // A bleed treatment declares that everything may sit on top of it.
  for (const id of bleedIds) {
    const bleedSlot = slots.find((s) => s.id === id)!;
    bleedSlot.allowedOverlaps = slots.filter((s) => s.id !== id).map((s) => s.id);
  }

  // STAGE 2 — ALLOCATE AREA WITHIN THE DISTRIBUTION. This decides SIZE: the
  // shape's fractions give the focal object the dominant share, and the role
  // bounds keep every box legible and stop any one element crowding the frame.
  const applySizeBands = (): void => {
    for (const s of placed) {
      if (s.layer !== "content") continue;
      const isFocal = s.slot === "focal" || s.slot.startsWith("focal/");
      const sized = clampSize(s.bounds, s.role, C, isFocal, input.elements.find((e) => e.id === s.id));
      // A size clamp must never manufacture a collision or leave the frame.
      const trial = {
        x: clamp(sized.x, C.x, C.x + C.w - sized.w),
        y: clamp(sized.y, C.y, C.y + C.h - sized.h),
        w: sized.w,
        h: sized.h,
      };
      const collides = placed.some((o) => o !== s && o.layer === "content" && rectsOverlap(o.bounds, trial));
      if (!collides && trial.w > 0 && trial.h > 0) s.bounds = trial;
    }
  };
  if (mode === "resize") applySizeBands();

  if (mode === "reposition") {
    const sizeOf = new Map<string, { w: number; h: number }>();
    const rankOf = new Map<string, number>();
    for (const e of input.elements) {
      if (e.authoredSize && e.authoredSize.w > 0 && e.authoredSize.h > 0) sizeOf.set(e.id, e.authoredSize);
      rankOf.set(e.id, focalKey(e));
    }
    repositionOnly(slots, sizeOf, rankOf, C, W, H);
  } else {
    // REPAIR RULE — local dead space is absorbed by the NEIGHBOUR that touches
    // it; a subordinate crowding the focal object is SHRUNK, not moved.
    // A TEXT BOX WHOSE CONTENT NEED IS KNOWN IS NOT AN ABSORBER. Dead space is
    // absorbed by the visual next to it, never by inflating a copy panel past
    // what its strings need — growing it and then re-clamping to the ceiling
    // also DRIFTS it off its slot anchor (final-checkr s2's copy walked from
    // the dashboard's quiet lower-left margin up to mid-left).
    absorbVoid(slots, C, gutter, (s) => {
      if (s.role !== "copy") return true;
      const el = input.elements.find((e) => e.id === s.id);
      return !(el?.contentExtent && el.contentExtent.neededArea > 0);
    });
    relieveCrowding(slots, gutter);
    // RE-APPLY THE SIZE BANDS. `absorbVoid` grows a box into adjacent dead
    // space, and its own guards only knew about the ROLE ceiling — it grew
    // final-checkr s2's copy from the shape's 795×375 to 795×648, blowing
    // through the CONTENT ceiling and reproducing the exact inflated-panel
    // defect this round exists to fix. A second banding pass catches it; a
    // shrink can never introduce a collision.
    applySizeBands();

    // REPAIR RULE — STRUCTURAL dead space (a large void REMOTE from every
    // element) means the distribution is wrong. Re-pick the shape and re-run
    // rather than teleporting an element across the frame to plug the hole.
    // One re-pick only: a ladder that keeps falling is a shape table bug, and
    // an unbounded recursion would be worse than a residual void.
    if ((opts?.depth ?? 0) === 0 && !opts?.forceShape) {
      const claimed = slots.filter((s) => s.layer === "content").map((s) => s.bounds);
      const v = claimed.length > 0 ? largestFreeRect(claimed, C) : null;
      const alt = REPICK[shapeId];
      if (v && area(v) > VOID_REPICK_FRAC * area(C) && !voidIsAdjacent(v, claimed, gutter) && alt && alt !== shapeId) {
        return allocateLayout(input, { forceShape: alt, depth: 1 });
      }
    }
  }

  // Throughline motif: centred in the largest residual void.
  for (const m of motifs) {
    const size = throughlineSize(aspect);
    const claimed = slots.filter((s) => s.layer === "content").map((s) => s.bounds);
    const v = largestFreeRect(claimed, C);
    let bounds: Rect;
    let overlaps: string[] = [];
    if (v && v.w >= size + gutter && v.h >= size + gutter) {
      bounds = {
        x: Math.round(v.x + (v.w - size) / 2),
        y: Math.round(v.y + (v.h - size) / 2),
        w: size,
        h: size,
      };
    } else {
      // Nothing fits: pin to the top-right of the content rect and DECLARE the
      // overlap with the focal object, exactly as the composer's motif does.
      bounds = { x: C.x + C.w - size, y: C.y, w: size, h: size };
      overlaps = placed.filter((s) => rectsOverlap(s.bounds, bounds)).map((s) => s.id);
    }
    const s: AllocSlot = { id: m.id, role: m.role, bounds, layer: "content", allowedOverlaps: overlaps, slot: "motif" };
    placed.push(s);
    slots.push(s);
  }

  // EMBEDDED CHILDREN — placed inside the parent's FINAL box at the relative
  // rect the head authored, so a status chip in a card header stays a status
  // chip in a card header. The overlap with the parent is DECLARED (it is the
  // whole point), and the child inherits the parent's layer for stacking.
  for (const child of embedded) {
    const parent = slots.find((p) => p.id === child.embeddedIn);
    const r = child.embeddedRect!;
    const box: Rect = parent
      ? {
          x: Math.round(parent.bounds.x + r.fx * parent.bounds.w),
          y: Math.round(parent.bounds.y + r.fy * parent.bounds.h),
          w: Math.max(8, Math.round(r.fw * parent.bounds.w)),
          h: Math.max(8, Math.round(r.fh * parent.bounds.h)),
        }
      : { x: C.x, y: C.y, w: throughlineSize(aspect), h: throughlineSize(aspect) };
    // A child of a BLEED parent inherits the parent's overlap declarations. A
    // mark painted inside the canvas treatment IS part of the canvas treatment,
    // and everything that may sit over the canvas may sit over the mark — which
    // is exactly what the head authored (fullpipe-fuse s0 puts a 300×44 motif
    // at y=940 under a copy block that overlays the same full-bleed hero).
    // Without this the child collides with a re-placed sibling and throws.
    const inheritsBleed = parent?.layer === "base";
    const s: AllocSlot = {
      id: child.id,
      role: child.role,
      bounds: box,
      layer: "content",
      allowedOverlaps: parent
        ? inheritsBleed
          ? [parent.id, ...slots.filter((o) => o.id !== child.id && o.id !== parent.id).map((o) => o.id)]
          : [parent.id]
        : [],
      slot: parent ? `embedded:${parent.id}` : "motif",
    };
    if (parent) parent.allowedOverlaps = [...parent.allowedOverlaps, child.id];
    placed.push(s);
    slots.push(s);
  }

  for (const c of chrome) {
    slots.push({
      id: c.id,
      role: c.role,
      bounds: { x: 0, y: H - chromeH(aspect), w: W, h: chromeH(aspect) },
      layer: "chrome",
      allowedOverlaps: [],
      slot: "chrome-bar",
    });
  }

  const alloc: Allocation = {
    shape: shapeId,
    register,
    aspect,
    slots,
    mode,
    repicked: !!opts?.forceShape,
    usedMeasured: input.elements.some((e) => !!e.measured),
  };
  // Disjointness is an INVARIANT in resize mode (the shapes tile by
  // construction) but only a best-effort OUTCOME in reposition mode — authored
  // sizes are not guaranteed to be packable, and pretending otherwise would
  // hide the finding.
  assertAllocation(alloc, { allowResidualOverlap: mode === "reposition" });
  return alloc;
};

/** Every shape id in the repertoire — the denominator for the diversity number. */
export const shapeIds = (): string[] => Object.keys(SHAPES).slice().sort();
