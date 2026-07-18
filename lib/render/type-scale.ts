/**
 * DETERMINISTIC TYPE SCALE — the missing input the capacity engine needs.
 *
 * `capacityFor()` (./capacity.ts) answers "how much copy fits in this box?" only
 * once it knows the PX SIZES the element will render at. Today nothing declares
 * them: the composition head authors bounds, and the leaf emitter picks font
 * sizes free-hand, inline, blind. So a budget computed against an assumed scale
 * would be a budget the emitter never agreed to.
 *
 * This module closes that gap WITHOUT an LLM call. It maps
 * `(role, box, canvas)` → `{ headlinePx, bodyPx, lineHeights }` off a fixed
 * modular ramp, downshifting when the authored box is too small to carry the
 * role's nominal step. The result is then DECLARED to the emitter in its brief
 * alongside the budget, which makes the two self-consistent: the emitter is told
 * the size it must set AND the character count that size affords. A budget the
 * emitter can honor is worth more than a more "accurate" one it never sees.
 *
 * WHY DETERMINISTIC RATHER THAN HEAD-AUTHORED
 *   - zero tokens, zero latency, zero model variance on a purely mechanical
 *     decision (a ramp step is arithmetic, not taste);
 *   - it needs no change to the composition head's contract;
 *   - the same input always yields the same scale, so a re-emission of one
 *     element is measured against exactly the budget it was given.
 *
 * A later phase may want the head to override a step on a specific element
 * ("this stat is the whole frame — set it huge"). That slots in additively via
 * `override` — no caller has to supply one today, and none does.
 *
 * NOT metrics-aware ON PURPOSE. The ramp must be stable across brands and must
 * not shift when a font fails to calibrate; the FONT-dependent arithmetic all
 * lives downstream in capacity.ts, which applies its own (wider) margin for an
 * uncalibrated face. Mixing the two would let a calibration failure silently
 * change the declared design.
 */
import type { TypeScale } from "./capacity";

/**
 * The headline/display ramp, in px on a 1080-short-side canvas, largest first.
 * Ratio ≈ 1.24 between adjacent steps — a conventional modular scale, wide
 * enough that a single downshift is a visible, deliberate change rather than a
 * rounding artifact.
 */
export const HEADLINE_RAMP: readonly number[] = [104, 84, 68, 54, 44, 35, 28, 22];

/**
 * The body/label ramp, index-aligned with HEADLINE_RAMP. Compressed relative to
 * the headline ramp on purpose: body copy has a hard legibility floor (video is
 * watched at a distance, and sub-14px text is unreadable at 1080p delivery),
 * so it must not scale linearly with display type.
 */
export const BODY_RAMP: readonly number[] = [30, 27, 24, 22, 20, 18, 16, 14];

/** Display type sets TIGHT — matches capacity.ts's own headline default. */
export const HEADLINE_LINE_HEIGHT = 1.1;
/** Body copy sets loose enough to read — matches capacity.ts's body default. */
export const BODY_LINE_HEIGHT = 1.5;

/**
 * The nominal ramp step per cast role, before any box-driven downshift.
 *   copy        — the editorial headline stack, the frame's largest type.
 *   hero        — a product artifact: a panel title plus many small rows, so it
 *                 starts well down the ramp even in a big box.
 *   throughline — a recurring motif with at most a label.
 *   connector   — SVG connective tissue; any text is annotation-sized.
 *   atmosphere  — carries no text at all; a step exists only so the budget
 *                 shape is uniform.
 */
export const ROLE_START_STEP: Record<string, number> = {
  copy: 2,
  hero: 4,
  throughline: 5,
  connector: 6,
  atmosphere: 6,
};

/** Roles with no declared step land mid-ramp rather than at an extreme. */
export const DEFAULT_START_STEP = 4;

/**
 * Minimum headline LINES a box must afford at a step for that step to be
 * usable. Copy demands two: a one-line-only headline box means the very next
 * word of a slightly longer headline clips, and headline lengths are authored
 * upstream by a different agent. Other roles need only their one title line.
 */
const MIN_HEADLINE_LINES: Record<string, number> = { copy: 2 };
const DEFAULT_MIN_HEADLINE_LINES = 1;

/**
 * Minimum BODY lines a copy box must afford on top of its headline — a copy
 * column that fits a headline and nothing else cannot render its own lede.
 */
const MIN_BODY_LINES: Record<string, number> = { copy: 2 };
const DEFAULT_MIN_BODY_LINES = 0;

/**
 * A headline must have room for at least this many EMs of text on one line.
 * Below roughly 6em a proportional face fits ~10–12 characters per line, which
 * is where wrapping stops being layout and starts being a column of fragments.
 * Deliberately em-based (font-size relative) so it holds at every ramp step,
 * and deliberately not metrics-based (see the module note).
 */
export const MIN_HEADLINE_EM_PER_LINE = 6;

/** Hard floor. Below this, text is unreadable at 1080p delivery regardless of
 *  what the geometry would technically permit. */
export const MIN_HEADLINE_PX = 20;
export const MIN_BODY_PX = 14;

export interface Box {
  w: number;
  h: number;
}

export interface ResolvedTypeScale extends TypeScale {
  headlinePx: number;
  bodyPx: number;
  /** Always populated (capacity.ts treats them as optional; we do not). */
  headlineLineHeight: number;
  bodyLineHeight: number;
  /** The ramp index actually chosen. */
  step: number;
  /** True when the box forced a step below the role's nominal start. */
  downshifted: boolean;
}

export interface DeriveTypeScaleArgs {
  /** Cast slot id: copy | hero | atmosphere | connector | throughline. */
  role: string;
  /** The element's authored pixel bounds. */
  box: Box;
  /** The scene canvas, e.g. {w:1920,h:1080}. Used only for the ramp's scale
   *  factor; omitted ⇒ the reference canvas (factor 1). */
  canvas?: Box;
  /**
   * ADDITIVE override hook (see module note). Any field present here wins over
   * the derived value. No production caller supplies one today; the parameter
   * exists so a head-authored scale can be threaded through later without
   * changing a single call site's shape.
   */
  override?: Partial<TypeScale>;
}

/**
 * The ramp is authored against a 1080px SHORT side (1920×1080, 1080×1920 and
 * 1080×1080 all share it). Keying off the short side rather than the height is
 * what keeps a portrait canvas from inheriting a 1.8× headline: type size
 * tracks the narrow axis a line has to fit inside, not the scroll axis.
 */
const REFERENCE_SHORT_SIDE = 1080;

const scaleFactor = (canvas?: Box): number => {
  if (!canvas || !(canvas.w > 0) || !(canvas.h > 0)) return 1;
  return Math.min(canvas.w, canvas.h) / REFERENCE_SHORT_SIDE;
};

/** Round to the nearest px — emitters write integer font sizes, and a budget
 *  computed at 53.7px against copy set at 54px is a budget that lies slightly
 *  in the WRONG direction. */
const px = (n: number, floor: number): number => Math.max(floor, Math.round(n));

/**
 * Derive the type scale an element will render at.
 *
 * The step search starts at the role's nominal step and walks DOWN the ramp
 * until the box can carry it (never up — a generous box does not earn bigger
 * type than the role's design intent, and upshifting would let one oversized
 * hero panel set 104px interior labels).
 *
 * A box that cannot carry even the smallest step still returns the smallest
 * step rather than zero: the emitter needs a number, and capacity.ts will
 * independently report a budget of ~0 for a box that genuinely holds nothing,
 * which is the honest signal.
 */
export const deriveTypeScale = (args: DeriveTypeScaleArgs): ResolvedTypeScale => {
  const { role, box, canvas, override } = args;
  const f = scaleFactor(canvas);
  const start = Math.min(
    HEADLINE_RAMP.length - 1,
    Math.max(0, ROLE_START_STEP[role] ?? DEFAULT_START_STEP),
  );
  const minHeadlineLines = MIN_HEADLINE_LINES[role] ?? DEFAULT_MIN_HEADLINE_LINES;
  const minBodyLines = MIN_BODY_LINES[role] ?? DEFAULT_MIN_BODY_LINES;

  const w = Math.max(0, box?.w ?? 0);
  const h = Math.max(0, box?.h ?? 0);

  let step = HEADLINE_RAMP.length - 1;
  for (let i = start; i < HEADLINE_RAMP.length; i++) {
    const hp = px(HEADLINE_RAMP[i] * f, MIN_HEADLINE_PX);
    const bp = px(BODY_RAMP[i] * f, MIN_BODY_PX);
    const needH =
      minHeadlineLines * hp * HEADLINE_LINE_HEIGHT + minBodyLines * bp * BODY_LINE_HEIGHT;
    const needW = hp * MIN_HEADLINE_EM_PER_LINE;
    if (h >= needH && w >= needW) {
      step = i;
      break;
    }
  }

  const headlinePx = px(HEADLINE_RAMP[step] * f, MIN_HEADLINE_PX);
  const bodyPx = px(BODY_RAMP[step] * f, MIN_BODY_PX);

  return {
    headlinePx: override?.headlinePx ?? headlinePx,
    bodyPx: override?.bodyPx ?? bodyPx,
    headlineLineHeight: override?.headlineLineHeight ?? HEADLINE_LINE_HEIGHT,
    bodyLineHeight: override?.bodyLineHeight ?? BODY_LINE_HEIGHT,
    step,
    downshifted: step > start,
  };
};

/**
 * The scale as the one-line instruction an emitter is given, immediately above
 * its capacity budget. Stated as a TARGET with an explicit ceiling because the
 * budget below it is only true at this size — an emitter that silently doubles
 * the headline has invalidated the number it was just handed.
 */
export const describeTypeScale = (s: ResolvedTypeScale): string =>
  `TYPE SCALE (the capacity budget below is computed at THIS size — set your type to it): ` +
  `headline/display text ${s.headlinePx}px (line-height ${s.headlineLineHeight}), ` +
  `body/label/row text ${s.bodyPx}px (line-height ${s.bodyLineHeight}). ` +
  `${s.headlinePx}px is a CEILING for the largest text in this element — larger type overflows the box.`;
