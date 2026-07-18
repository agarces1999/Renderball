/**
 * OPTICAL REFINEMENT POST-PASS (spatial P5a, 2026-07-18).
 *
 * A deterministic, zero-LLM pass over ALREADY-RESOLVED element rects — the ones
 * `composeSceneLayout` produced and P1's repair ladder may have adjusted. Its
 * only job is the last few pixels: the difference between a frame that was
 * SOLVED and a frame that was DESIGNED.
 *
 * Three things a solver cannot know, and this pass corrects:
 *
 *   1. A TEXT BOX IS NOT ITS INK. Half-leading sits above and below the line
 *      box, the ascender band above cap height is blank for almost every Latin
 *      string, and each glyph carries a side bearing. So a headline whose CSS
 *      box shares an edge with the panel beside it PAINTS several pixels inside
 *      that edge and reads as misaligned. We OUTSET the layout box by the ink
 *      inset, so the ink lands where the composer meant the edge to be.
 *
 *   2. GEOMETRIC CENTER READS LOW. The eye places the optical center above the
 *      mathematical one; the typographic convention is to lift a centered focal
 *      element by ~2–3% of the container height. Applied ONLY to a focal element
 *      genuinely floating centered in a large field — a bottom-anchored band or
 *      a column pinned to the top edge is not "centered", and lifting it would
 *      be vandalism, not polish.
 *
 *   3. A HERO PENNED INTO ITS GUTTER DOES NOT READ AS DOMINANT. Where the region
 *      adjacent to the rank-1 focal element is measurably empty, we let it bleed
 *      a bounded amount into that emptiness.
 *
 * ── WHAT THIS PASS IS NOT ALLOWED TO DO ─────────────────────────────────────
 * This is POLISH, not correctness. The ordering is absolute: every guarantee P1
 * bought outranks every pixel this pass wants.
 *
 *   - NEVER introduces a violation. The refined plan is re-run through
 *     `validateScenePlan`; any violation not already present in the INPUT plan
 *     causes the implicated element's adjustment to be REVERTED, one element at
 *     a time, until the refined violation set is a subset of the baseline's.
 *     A frame we cannot polish safely ships exactly as it arrived.
 *   - NEVER pushes an element outside SMPTE title-safe. The clamp is
 *     "no-worse-than-input": an element inside title-safe stays inside; an
 *     element the head already parked outside it never gets pushed FURTHER out
 *     (silently pulling it in would be an un-asked-for layout change, and would
 *     fight P1's ladder over the same box).
 *   - NEVER grows unbounded. Every growth is capped three times — as a fraction
 *     of the element's own box, as a fraction of the canvas, and by the measured
 *     room to the nearest neighbour.
 *   - OFF BY DEFAULT, behind `RB_OPTICAL_REFINE=on`. It must be revertible with
 *     an env var, not a deploy.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * `refine(refine(p))` deep-equals `refine(p)`. An adjusted element carries its
 * pre-refinement rect in `opticalBase`; a second pass recomputes from
 * `opticalBase`, not from the already-outset `bounds`, so the outsets cannot
 * compound. An element the pass declines to touch gets no `opticalBase` at all,
 * which is what makes the NO-OP case return the input plan BY REFERENCE —
 * byte-identical, not merely equal.
 *
 * Pure: no I/O, no mutation of the input plan, no clock, no randomness.
 */
import {
  BOTTOM_SAFE_FRAC,
  CANVAS,
  validateScenePlan,
  type Aspect,
  type ElementSlot,
  type PlanViolation,
  type ScenePlan,
} from "../agents/layout-composer";
import type { SceneComposition } from "../../src/schema";
import { DEFAULT_NORMAL_LINE_HEIGHT, type FontMetrics } from "./font-metrics";
import type { ResolvedTypeScale } from "./type-scale";

// ─── Calibration ────────────────────────────────────────────────────────────

/**
 * SMPTE title-safe: the centered 90% of the frame. 1920×1080 → 1728×972 at
 * (96,54), the numbers the spatial plan fixed as the containment target for
 * TEXT. Non-text elements get the frame instead (clipped to the bottom reserve
 * `validateScenePlan` enforces) — a visual treatment may reach the side edges,
 * which is what bleed means.
 */
export const TITLE_SAFE_FRAC = 0.9;

/**
 * Share of the CSS content box (normalLineHeight × font-size) that sits ABOVE
 * the baseline. Across the UI sans faces we actually ship this clusters tightly
 * at 0.80 (Inter hhea 0.969 asc / 0.241 desc → 0.80; Helvetica and Geist land
 * within a point of it). Deliberately a constant and not a measured field:
 * `FontMetrics` persists advance widths and `normalLineHeight`, not vertical
 * metrics, and standing up a calibration pass for two numbers that vary ~1%
 * across our whole type stack would be cost without accuracy.
 */
export const ASCENT_SHARE = 0.8;

/**
 * Cap height as a fraction of the em. 0.70–0.73 across the same faces; the low
 * end is the conservative choice here, because a SMALLER cap height implies a
 * SMALLER blank band, i.e. a smaller correction.
 */
export const CAP_HEIGHT_EM = 0.71;

/**
 * Share of the DESCENDER band a typical mixed-case last line actually paints
 * into. Latin descenders (g j p q y) are common enough that the bottom band is
 * usually occupied; only the remainder is genuine optical slack. This is why
 * the correction is ASYMMETRIC — a text box's ink hangs low in its box, so the
 * top outset is several times the bottom one and the net effect is a lift.
 */
export const DESCENDER_PAINT_SHARE = 0.75;

/**
 * We apply only this share of the geometrically-derived blank band. Accented
 * capitals (Á, Ñ, Ü — routine in the es-CO and pt-BR copy we ship) and tall
 * lowercase ascenders reach above cap height, so the full correction would
 * over-shoot on a real string. An under-correction is invisible; an
 * over-correction misaligns in the other direction, which is worse than the
 * defect it set out to fix.
 */
export const INK_INSET_CONFIDENCE = 0.6;

/** Horizontal side bearing per edge, in em. Small, real, and the reason a
 *  left-aligned headline never quite touches the column rule beside it. */
export const SIDE_BEARING_EM = 0.04;

/** Hard cap on any single ink outset, as a fraction of the box's own extent on
 *  that axis. At 8%, a 480px-tall copy column can gain at most 38px — a
 *  correction, never a re-layout. */
export const MAX_INSET_FRAC = 0.08;

/**
 * The optical-center lift, as a fraction of the CONTAINER height. The
 * convention is 2–3%; we take the conservative end because on a text element it
 * compounds with the ink outset's own upward bias.
 */
export const OPTICAL_CENTER_RISE_FRAC = 0.02;

/** How near the geometric center an element must already sit for the lift to
 *  mean anything. Beyond this the element is anchored, not centered. */
export const OPTICAL_CENTER_TOLERANCE_FRAC = 0.05;

/**
 * The lift only reads on an element floating in a LARGE field. Below this much
 * slack above AND below, the element effectively spans the frame and its
 * "centering" is incidental — lifting it just breaks a margin.
 */
export const OPTICAL_CENTER_MIN_MARGIN_FRAC = 0.08;

/**
 * Max focal-bleed expansion per edge, as a fraction of the canvas SHORT side.
 * 2.5% of 1080 = 27px: enough for a hero to break its gutter and stop reading
 * as boxed, far too little to restructure a frame.
 */
export const FOCAL_BLEED_FRAC = 0.025;

/** Second, independent cap on bleed: a fraction of the element's OWN smaller
 *  extent, so a small focal element cannot be inflated out of proportion. */
export const MAX_BLEED_BOX_FRAC = 0.06;

/** Clearance every growth leaves to the nearest neighbour, as a fraction of the
 *  canvas short side. Expanding to KISS a neighbour is not polish. */
export const CLEARANCE_FRAC = 0.01;

/** The env flag values that turn the pass ON. Anything else leaves it off. */
const ENABLED_VALUES = new Set(["on", "1", "true", "yes"]);

/** Kinds whose painted content is TEXT, and whose layout box is therefore not
 *  its ink. `hero` is a rendered artifact with its own interior padding — its
 *  box edge IS its visual edge, so it gets no ink inset. */
const TEXT_KINDS = new Set(["text"]);

/** Exempt from refinement entirely: the base layer and the chrome bar own the
 *  frame edge by design, and nudging either is a regression by definition. */
const EXEMPT_KINDS = new Set(["atmosphere", "chrome"]);

/**
 * Exempt by ID, regardless of kind. The throughline motif is pinned EXACTLY to
 * `throughlineAnchorFor(aspect)` so the cross-scene DRIFT gate passes by
 * construction — it is the one box in the plan whose position is a cross-scene
 * contract, not a per-frame composition choice. A bleed here would still be well
 * inside SEVERE_DRIFT_PX, but "still inside the tolerance" is a worse guarantee
 * than "identical in every scene", and the motif gains nothing from polish.
 */
const EXEMPT_IDS = new Set(["throughline"]);

// ─── Public shapes ──────────────────────────────────────────────────────────

export type OpticalAdjustment = "ink-inset" | "optical-center" | "focal-bleed";

export interface RefinedElementSlot extends ElementSlot {
  /**
   * The rect this element carried BEFORE refinement. Present iff the pass
   * actually moved it — both the audit trail and the idempotency key (a second
   * pass recomputes from here, never from the already-outset `bounds`).
   */
  opticalBase?: ElementSlot["bounds"];
  /** Which adjustments contributed, in application order. Audit only. */
  opticalAdjustments?: OpticalAdjustment[];
}

export interface RefinedScenePlan extends ScenePlan {
  elements: RefinedElementSlot[];
}

export interface RefineOpts {
  aspect: Aspect;
  /**
   * The head composition, read ONLY for `focalRank` (which `ScenePlan` does not
   * carry). Absent ⇒ the focal element is inferred: "hero" when present,
   * otherwise the largest non-exempt slot.
   */
  composition?: SceneComposition;
  /** Passed straight through to `validateScenePlan`, so the re-validation
   *  judges by exactly the contract the input plan was judged by. */
  content?: Record<string, unknown>;
  /** Real font metrics for a slot. Omitted ⇒ conservative defaults; the ink
   *  inset degrades in accuracy, never in safety. */
  metricsFor?: (slot: ElementSlot) => FontMetrics | undefined;
  /** The type scale the slot will actually render at (P4b derives this
   *  deterministically). Omitted ⇒ NO ink inset for that slot: guessing a font
   *  size yields a correction with no relationship to the painted frame. */
  typeScaleFor?: (slot: ElementSlot) => ResolvedTypeScale | undefined;
}

export interface RefineReport {
  plan: RefinedScenePlan;
  /** Slots adjusted, with the adjustments that stuck. */
  adjusted: { id: string; adjustments: OpticalAdjustment[] }[];
  /** Slots whose adjustment was reverted because it would have introduced a
   *  violation. A non-empty list is the guardrail working, not a bug. */
  reverted: string[];
  /** One-line telemetry, greppable in a build log. */
  summary: string;
}

// ─── Geometry ───────────────────────────────────────────────────────────────

type Rect = { x: number; y: number; w: number; h: number };

const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const asRect = (b: ElementSlot["bounds"]): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });

/** SMPTE title-safe for an aspect: the centered `TITLE_SAFE_FRAC` of the frame.
 *  16:9 → {96,54,1728,972} — the numbers the spatial plan fixed. */
export const titleSafeRect = (aspect: Aspect): Rect => {
  const { w: W, h: H } = CANVAS[aspect];
  const w = Math.round(TITLE_SAFE_FRAC * W);
  const h = Math.round(TITLE_SAFE_FRAC * H);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
};

/**
 * The region an element may occupy after refinement. Text gets title-safe.
 * Everything else gets the frame clipped to the BOTTOM RESERVE — bleeding a
 * hero past `BOTTOM_SAFE_FRAC` would manufacture exactly the containment
 * violation `validateScenePlan` blocks on, so we never propose it.
 */
export const refineRegionFor = (kind: string, aspect: Aspect): Rect => {
  if (TEXT_KINDS.has(kind)) return titleSafeRect(aspect);
  const { w: W, h: H } = CANVAS[aspect];
  return { x: 0, y: 0, w: W, h: Math.floor(BOTTOM_SAFE_FRAC * H) };
};

/**
 * Clamp `next` so refinement can only ever IMPROVE an element's relationship to
 * the safe region. The limit on each edge is the more generous of the region and
 * where the element ALREADY was: an element inside title-safe is pinned inside
 * it, and an element the head parked outside is never pushed further out — but
 * it is not silently dragged in either. Dragging it in would be an un-asked-for
 * layout change, and would fight P1's ladder over the same box.
 */
const clampNoWorse = (next: Rect, original: Rect, region: Rect, canvas: Rect): Rect => {
  const left = Math.max(canvas.x, Math.min(region.x, original.x));
  const top = Math.max(canvas.y, Math.min(region.y, original.y));
  const right = Math.min(canvas.x + canvas.w, Math.max(region.x + region.w, original.x + original.w));
  const bottom = Math.min(canvas.y + canvas.h, Math.max(region.y + region.h, original.y + original.h));

  let { x, y, w, h } = next;
  w = Math.max(1, Math.min(w, right - left));
  h = Math.max(1, Math.min(h, bottom - top));
  x = Math.max(left, Math.min(x, right - w));
  y = Math.max(top, Math.min(y, bottom - h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
};

export interface EdgeRoom {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far each edge of `r` may travel outward before it reaches the region
 * boundary or comes within `clearance` of a neighbour. This is the MEASURED
 * emptiness the focal bleed requires and the ceiling the ink outset respects —
 * growing into a neighbour would only be reverted a moment later by the
 * validator, and a reverted adjustment loses the polish for the whole element.
 *
 * Measured per edge against the FULL perpendicular extent of `r`, so a
 * neighbour that clips only a corner still blocks the edge. Conservative on
 * purpose: this is a claim about emptiness, and a wrong one costs a collision.
 */
export const edgeRoom = (r: Rect, neighbours: Rect[], region: Rect, clearance: number): EdgeRoom => {
  const room: EdgeRoom = {
    top: Math.max(0, r.y - region.y),
    bottom: Math.max(0, region.y + region.h - (r.y + r.h)),
    left: Math.max(0, r.x - region.x),
    right: Math.max(0, region.x + region.w - (r.x + r.w)),
  };
  for (const n of neighbours) {
    const overlapsX = n.x < r.x + r.w && r.x < n.x + n.w;
    const overlapsY = n.y < r.y + r.h && r.y < n.y + n.h;
    if (overlapsX) {
      if (n.y + n.h <= r.y) room.top = Math.min(room.top, Math.max(0, r.y - (n.y + n.h) - clearance));
      if (n.y >= r.y + r.h) room.bottom = Math.min(room.bottom, Math.max(0, n.y - (r.y + r.h) - clearance));
    }
    if (overlapsY) {
      if (n.x + n.w <= r.x) room.left = Math.min(room.left, Math.max(0, r.x - (n.x + n.w) - clearance));
      if (n.x >= r.x + r.w) room.right = Math.min(room.right, Math.max(0, n.x - (r.x + r.w) - clearance));
    }
    // A neighbour that ALREADY overlaps `r` (a declared overlap, e.g. copy over
    // a full-bleed hero) blocks nothing: the relationship is intentional and
    // growing does not change whether they intersect.
  }
  return room;
};

// ─── Adjustment 1: per-type ink insets ──────────────────────────────────────

export interface InkInset {
  top: number;
  bottom: number;
  side: number;
}

/**
 * The blank band between a text element's LAYOUT box and its painted INK, per
 * edge, in px — derived from real font metrics and the declared type scale
 * rather than guessed.
 *
 *   contentH    = normalLineHeight · size     (the CSS content area of a line)
 *   halfLead    = max(0, (lineHeight − normalLineHeight)/2 · size)
 *   topBlank    = halfLead + (ASCENT_SHARE · contentH − CAP_HEIGHT_EM · size)
 *   bottomBlank = halfLead + (1 − DESCENDER_PAINT_SHARE) · descender band
 *   side        = SIDE_BEARING_EM · size
 *
 * all scaled by `INK_INSET_CONFIDENCE`. Sized against the element's LARGEST
 * text (the headline step): that is the first line of the box and the string a
 * viewer actually aligns against.
 */
export const inkInsetFor = (scale: ResolvedTypeScale, metrics?: FontMetrics): InkInset => {
  const size = Math.max(0, scale.headlinePx);
  if (!(size > 0)) return { top: 0, bottom: 0, side: 0 };
  const normalLh =
    metrics && metrics.normalLineHeight > 0 ? metrics.normalLineHeight : DEFAULT_NORMAL_LINE_HEIGHT;
  const contentH = normalLh * size;
  const halfLead = Math.max(0, ((scale.headlineLineHeight ?? normalLh) - normalLh) / 2) * size;

  const aboveBaseline = ASCENT_SHARE * contentH;
  const topBlank = halfLead + Math.max(0, aboveBaseline - CAP_HEIGHT_EM * size);
  const descenderBand = Math.max(0, contentH - aboveBaseline);
  const bottomBlank = halfLead + (1 - DESCENDER_PAINT_SHARE) * descenderBand;

  return {
    top: INK_INSET_CONFIDENCE * topBlank,
    bottom: INK_INSET_CONFIDENCE * bottomBlank,
    side: INK_INSET_CONFIDENCE * SIDE_BEARING_EM * size,
  };
};

/**
 * Outset a text box by its ink inset so the INK lands on the composer's edge.
 * Each delta is capped twice: at `MAX_INSET_FRAC` of that axis, and at the
 * measured room on that edge.
 */
const applyInkInset = (r: Rect, inset: InkInset, room: EdgeRoom): Rect => {
  const capY = MAX_INSET_FRAC * r.h;
  const capX = MAX_INSET_FRAC * r.w;
  const top = Math.floor(Math.min(inset.top, capY, room.top));
  const bottom = Math.floor(Math.min(inset.bottom, capY, room.bottom));
  const left = Math.floor(Math.min(inset.side, capX, room.left));
  const right = Math.floor(Math.min(inset.side, capX, room.right));
  return { x: r.x - left, y: r.y - top, w: r.w + left + right, h: r.h + top + bottom };
};

// ─── Adjustment 2: optical centering ────────────────────────────────────────

/**
 * Is this element actually a CENTERED focal element in a LARGE field — the only
 * place the optical-center convention applies? Three conditions, all necessary:
 * its center already sits within tolerance of the frame's, and it leaves real
 * slack above AND below. A hero band pinned to the bottom third fails the first;
 * a near-full-height column fails the second.
 */
export const isCenteredFocal = (r: Rect, canvas: Rect): boolean => {
  const cy = r.y + r.h / 2;
  const frameCy = canvas.y + canvas.h / 2;
  if (Math.abs(cy - frameCy) > OPTICAL_CENTER_TOLERANCE_FRAC * canvas.h) return false;
  const need = OPTICAL_CENTER_MIN_MARGIN_FRAC * canvas.h;
  return r.y - canvas.y >= need && canvas.y + canvas.h - (r.y + r.h) >= need;
};

/** Lift, never grow: the rise MOVES the box, it does not resize it. Capped by
 *  the room actually available above. */
const applyOpticalCenter = (r: Rect, canvas: Rect, room: EdgeRoom): Rect => {
  const rise = Math.min(Math.round(OPTICAL_CENTER_RISE_FRAC * canvas.h), Math.floor(room.top));
  return rise > 0 ? { ...r, y: r.y - rise } : r;
};

// ─── Adjustment 3: focal bleed ──────────────────────────────────────────────

/**
 * Expand a rank-1 focal element into MEASURABLY EMPTY adjacent territory. Each
 * edge grows by the smallest of three bounds: the canvas-relative cap, the
 * box-relative cap, and the measured room to the nearest neighbour. The two caps
 * bound each other, so neither a huge canvas nor a huge box can run away.
 *
 * Text elements are deliberately EXCLUDED by the caller: widening a text box
 * changes its measure, and P4b hands the emitter a capacity budget computed from
 * exactly these bounds. Bleeding a copy column would hand it a budget for a box
 * it was never shown.
 */
const applyFocalBleed = (r: Rect, room: EdgeRoom, canvas: Rect): Rect => {
  const limit = Math.min(
    Math.round(FOCAL_BLEED_FRAC * Math.min(canvas.w, canvas.h)),
    Math.round(MAX_BLEED_BOX_FRAC * Math.min(r.w, r.h)),
  );
  if (limit <= 0) return r;
  const grow = (avail: number): number => Math.max(0, Math.min(limit, Math.floor(avail)));
  const top = grow(room.top);
  const bottom = grow(room.bottom);
  const left = grow(room.left);
  const right = grow(room.right);
  return { x: r.x - left, y: r.y - top, w: r.w + left + right, h: r.h + top + bottom };
};

// ─── Focal identification ───────────────────────────────────────────────────

/**
 * The rank-1 focal slot id. The head's `focalRank` is authoritative when it
 * supplied one; otherwise "hero" is the focal by convention, and failing that
 * the largest non-exempt slot. Returns null when nothing qualifies — a frame
 * with no focal element gets no focal polish, which is correct.
 */
export const focalSlotId = (plan: ScenePlan, composition?: SceneComposition): string | null => {
  const eligible = plan.elements.filter((e) => !EXEMPT_KINDS.has(e.kind) && !EXEMPT_IDS.has(e.id));
  if (eligible.length === 0) return null;

  const ranked = (composition?.elements ?? [])
    .filter((e) => Number(e?.focalRank) === 1 && typeof e?.role === "string")
    .map((e) => String(e.role));
  const declared = eligible.find((e) => ranked.includes(e.id));
  if (declared) return declared.id;

  const hero = eligible.find((e) => e.id === "hero");
  if (hero) return hero.id;

  return eligible.reduce((best, e) => (e.bounds.w * e.bounds.h > best.bounds.w * best.bounds.h ? e : best)).id;
};

// ─── Validation + revert ────────────────────────────────────────────────────

const violationKey = (v: PlanViolation): string => `${v.kind}|${v.pieceId}|${v.message}`;

const violationsOf = (plan: ScenePlan, opts: RefineOpts): Set<string> =>
  new Set(
    validateScenePlan(plan, opts.aspect, { composition: opts.composition, content: opts.content }).map(
      violationKey,
    ),
  );

// ─── The pass ───────────────────────────────────────────────────────────────

const withBounds = (slot: RefinedElementSlot, rect: Rect): RefinedElementSlot => ({
  ...slot,
  bounds: { ...slot.bounds, ...rect },
});

/** Strip the audit fields — a reverted element must be indistinguishable from
 *  one the pass never touched, or a later pass would refine from a stale base. */
const stripAudit = (slot: RefinedElementSlot): RefinedElementSlot => {
  const { opticalBase: _b, opticalAdjustments: _a, ...rest } = slot;
  return rest;
};

const refineOne = (
  slot: RefinedElementSlot,
  base: Rect,
  isFocal: boolean,
  neighbours: Rect[],
  opts: RefineOpts,
  canvas: Rect,
): { rect: Rect; adjustments: OpticalAdjustment[] } => {
  const adjustments: OpticalAdjustment[] = [];
  const region = refineRegionFor(slot.kind, opts.aspect);
  const clearance = Math.round(CLEARANCE_FRAC * Math.min(canvas.w, canvas.h));
  let rect = base;

  // 1. Ink inset — text only, and only when the type scale is actually known.
  if (TEXT_KINDS.has(slot.kind)) {
    const scale = opts.typeScaleFor?.(slot);
    if (scale) {
      const next = applyInkInset(rect, inkInsetFor(scale, opts.metricsFor?.(slot)), edgeRoom(rect, neighbours, region, clearance));
      if (!sameRect(next, rect)) {
        rect = next;
        adjustments.push("ink-inset");
      }
    }
  }

  // 2. Optical centering — focal, genuinely centered, genuinely floating.
  //    Judged against the ORIGINAL rect: the ink outset must not be what makes
  //    an element look centered enough to earn a lift.
  if (isFocal && isCenteredFocal(base, canvas)) {
    const next = applyOpticalCenter(rect, canvas, edgeRoom(rect, neighbours, region, clearance));
    if (!sameRect(next, rect)) {
      rect = next;
      adjustments.push("optical-center");
    }
  }

  // 3. Focal bleed — rank-1, non-text (see applyFocalBleed's note).
  if (isFocal && !TEXT_KINDS.has(slot.kind)) {
    const next = applyFocalBleed(rect, edgeRoom(rect, neighbours, region, clearance), canvas);
    if (!sameRect(next, rect)) {
      rect = next;
      adjustments.push("focal-bleed");
    }
  }

  if (adjustments.length === 0) return { rect: base, adjustments };

  // 4. Clamp LAST, so an over-reach is absorbed once, visibly, at the boundary.
  const clamped = clampNoWorse(rect, base, region, canvas);
  return sameRect(clamped, base) ? { rect: base, adjustments: [] } : { rect: clamped, adjustments };
};

/**
 * Run the optical refinement post-pass. Pure; returns the input plan BY
 * REFERENCE when nothing was adjusted (the byte-identical no-op).
 */
export const refineScenePlan = (plan: ScenePlan, opts: RefineOpts): RefineReport => {
  const { w: W, h: H } = CANVAS[opts.aspect];
  const canvas: Rect = { x: 0, y: 0, w: W, h: H };
  const focalId = focalSlotId(plan, opts.composition);

  const source = plan.elements as RefinedElementSlot[];
  // IDEMPOTENCY: refine from `opticalBase` when a previous pass left one, so a
  // second run recomputes the same answer instead of compounding the outsets.
  const bases = source.map((e) => asRect(e.opticalBase ?? e.bounds));
  /** The plan as it stood BEFORE any refinement — the baseline the guardrail
   *  compares against, and what a full revert returns to. */
  const rebased: RefinedElementSlot[] = source.map((slot, i) => stripAudit(withBounds(slot, bases[i])));

  const working = [...rebased];
  const touched = new Set<number>();

  source.forEach((slot, i) => {
    if (EXEMPT_KINDS.has(slot.kind) || EXEMPT_IDS.has(slot.id)) return;
    const neighbours = bases.filter((_, j) => j !== i && source[j].kind !== "atmosphere");
    const { rect, adjustments } = refineOne(rebased[i], bases[i], slot.id === focalId, neighbours, opts, canvas);
    if (adjustments.length === 0) return;
    working[i] = { ...withBounds(rebased[i], rect), opticalBase: { ...rebased[i].bounds }, opticalAdjustments: adjustments };
    touched.add(i);
  });

  // ── GUARANTEE > POLISH: revert any adjustment that introduced a violation ──
  const baseline = violationsOf({ ...plan, elements: rebased }, opts);
  const reverted: string[] = [];
  // Terminates: every iteration removes exactly one element from `touched`.
  while (touched.size > 0) {
    const after = violationsOf({ ...plan, elements: working }, opts);
    const extra = [...after].filter((k) => !baseline.has(k));
    if (extra.length === 0) break;
    // Revert the implicated element when a new violation names one we touched;
    // otherwise the largest adjustment, as the most likely culprit.
    const named = [...touched].find((i) => extra.some((k) => k.includes(`|${working[i].id}|`)));
    const victim =
      named ?? [...touched].reduce((best, i) => (areaDelta(working[i]) > areaDelta(working[best]) ? i : best));
    reverted.push(working[victim].id);
    working[victim] = rebased[victim];
    touched.delete(victim);
  }

  const adjusted = [...touched]
    .sort((a, b) => a - b)
    .map((i) => ({ id: working[i].id, adjustments: working[i].opticalAdjustments ?? [] }));
  const summary = summarize(adjusted, reverted);

  // NO-OP: nothing stuck ⇒ hand back the INPUT plan, by reference. (A pass that
  // only reverted also lands here — a reverted element is byte-identical to its
  // input only when the input carried no stale audit fields, which is exactly
  // the contract `stripAudit` maintains.)
  if (touched.size === 0) {
    const untouchedInput = source.every((s) => !s.opticalBase);
    return { plan: untouchedInput ? (plan as RefinedScenePlan) : { ...plan, elements: rebased }, adjusted, reverted, summary };
  }
  return { plan: { ...plan, elements: working }, adjusted, reverted, summary };
};

const areaDelta = (slot: RefinedElementSlot): number =>
  slot.opticalBase ? Math.abs(slot.bounds.w * slot.bounds.h - slot.opticalBase.w * slot.opticalBase.h) : 0;

const summarize = (
  adjusted: { id: string; adjustments: OpticalAdjustment[] }[],
  reverted: string[],
): string => {
  if (adjusted.length === 0 && reverted.length === 0) return "optical-refine: no-op";
  const list = adjusted.map((a) => `${a.id}(${a.adjustments.join("+")})`).join(", ");
  return [
    `optical-refine: ${adjusted.length} adjusted${list ? ` [${list}]` : ""}`,
    ...(reverted.length > 0
      ? [`${reverted.length} REVERTED [${reverted.join(", ")}] — would have violated the plan`]
      : []),
  ].join(" · ");
};

// ─── The flag ───────────────────────────────────────────────────────────────

/** `RB_OPTICAL_REFINE=on|1|true|yes`. Off by default, everywhere. */
export const opticalRefineEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  ENABLED_VALUES.has(String(env.RB_OPTICAL_REFINE ?? "").trim().toLowerCase());

/**
 * The production entry point: refines when the flag is on, otherwise returns the
 * plan untouched BY REFERENCE. The flag check lives here and not inside
 * `refineScenePlan` so the pass itself stays purely testable.
 */
export const maybeRefineScenePlan = (
  plan: ScenePlan,
  opts: RefineOpts,
  env: Record<string, string | undefined> = process.env,
): ScenePlan => {
  if (!opticalRefineEnabled(env)) return plan;
  try {
    const report = refineScenePlan(plan, opts);
    if (report.adjusted.length > 0 || report.reverted.length > 0) console.log(`[optical-refine] ${report.summary}`);
    return report.plan;
  } catch (e) {
    // POLISH MUST NEVER BREAK A BUILD. Any unexpected throw ships the input plan.
    console.warn(`[optical-refine] skipped — ${e instanceof Error ? e.message : e}`);
    return plan;
  }
};
