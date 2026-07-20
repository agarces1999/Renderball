/**
 * CONTENT EXTENT (allocator dry-run round 2, 2026-07-19) — how much room an
 * element's content ACTUALLY needs, derived from the real copy strings rather
 * than guessed from a role name.
 *
 * WHY THIS EXISTS. Round 1 of the allocator dry-run gave every element a size
 * from a role prior ("copy is 0.62 mass"), and the two damage mechanisms it
 * produced on the controls were both size errors: a 320×200 copy corner became
 * a 795×648 panel (8×), and a 720×180 caption became 795×648 (3.2×). A box
 * enlarged without a matching capacity budget is the hollow-hero defect. The
 * fix is not a better prior — it is the actual content.
 *
 * WHAT IS AND IS NOT DERIVABLE, measured against the 10 scenes that carry real
 * `rects-scene-N.json` (flags-notion, flags-on-rappi):
 *
 *   - TEXT: derivable, and the head systematically OVER-SIZES it. Painted copy
 *     area vs authored copy area across those 10 scenes runs 0.54–0.90 (notion
 *     s2 0.180 vs 0.257; s4 0.113 vs 0.189; rappi s1 0.096 vs 0.179). The ink
 *     is reliably 10–46% smaller than the declared box. So a text box's real
 *     need is computable, and it is smaller than what the head declares.
 *
 *   - HERO: NOT derivable, and this contradicts the expectation that persisting
 *     measured rects closes the gap. In all 10 measured scenes the hero's
 *     PAINTED area equals its AUTHORED area to the pixel — a diegetic element
 *     is mounted into its declared box and fills it, so the measurement returns
 *     the box, never the content's need. Interior-item count does not stand in
 *     for it either: 8 interior items appears at 0.093 of canvas AND at 0.408.
 *     There is therefore no content-derived hero size available from anything
 *     on disk, and none will become available from more measuring. The only
 *     honest hero-scale signal is the head's own authored area — which is why
 *     the allocator consumes it as an anchor rather than inventing one.
 *
 * Deterministic: uses `fallbackMetrics` (no calibrated brand font is on disk in
 * a replay, and the 10% uncalibrated safety margin is the correct posture), so
 * the same strings always yield the same extent.
 */
import { fallbackMetrics, textWidth, type FontMetrics } from "../render/font-metrics";
import { linesNeededPx } from "../render/capacity";
import { HEADLINE_RAMP, BODY_RAMP, HEADLINE_LINE_HEIGHT, BODY_LINE_HEIGHT } from "../render/type-scale";

export interface ContentExtent {
  /** Area in px² the content genuinely needs, at its most efficient measure. */
  neededArea: number;
  /** The box that achieves it — the "natural" size for this content. */
  naturalW: number;
  naturalH: number;
  /** Narrowest measure that does not fracture the longest unbreakable word. */
  minW: number;
  /** Where the number came from, for honest reporting. */
  source: "measured" | "derived" | "authored" | "prior";
}

/**
 * Per-field type role. The actual px comes from the RESOLVED scale, not a fixed
 * ramp index — see `copyExtent`'s `scale` argument.
 *
 * WHY THE SCALE HAS TO BE AN INPUT. A content extent is scale-dependent, and
 * the scale is itself box-dependent: `deriveTypeScale` starts at the role's
 * nominal step and walks DOWN until the box can carry it. Computing an extent
 * at a fixed 68px headline therefore over-estimates badly for a small box —
 * measured on `p3-cycle8-razorpay s2`, a fixed-scale extent claimed the 320×200
 * corner of copy needed 4.83× its authored area, which would have licensed
 * exactly the inflation the ceiling exists to prevent. Passing the scale the
 * emitter will really use grounds the derivation in the same number.
 */
const FIELD_ROLE: Record<string, { kind: "headline" | "body"; rel: number; lh: number; caps?: boolean }> = {
  eyebrow: { kind: "body", rel: 0.72, lh: BODY_LINE_HEIGHT, caps: true },
  headline: { kind: "headline", rel: 1, lh: HEADLINE_LINE_HEIGHT },
  lede: { kind: "body", rel: 1.1, lh: BODY_LINE_HEIGHT },
  bullets: { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT },
  caption: { kind: "body", rel: 0.85, lh: BODY_LINE_HEIGHT },
  meta: { kind: "body", rel: 0.85, lh: BODY_LINE_HEIGHT },
  cta: { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT },
  texts: { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT },
};

const DEFAULT_FIELD = { kind: "body" as const, rel: 1, lh: BODY_LINE_HEIGHT };

/** The type scale an extent is computed at. Defaults to the nominal copy step
 *  (`HEADLINE_RAMP[2]` / `BODY_RAMP[2]`) when the caller has no box to derive
 *  one from. */
export interface ExtentScale {
  headlinePx: number;
  bodyPx: number;
}

export const NOMINAL_SCALE: ExtentScale = { headlinePx: HEADLINE_RAMP[2], bodyPx: BODY_RAMP[2] };

const sizeOfField = (name: string, scale: ExtentScale): { px: number; lh: number; caps: boolean } => {
  const f = FIELD_ROLE[name] ?? DEFAULT_FIELD;
  const base = f.kind === "headline" ? scale.headlinePx : scale.bodyPx;
  return { px: Math.max(12, Math.round(base * f.rel)), lh: f.lh, caps: !!(f as { caps?: boolean }).caps };
};

/** Vertical rhythm between two stacked copy fields. */
const FIELD_GAP_EM = 0.7;

/** Candidate measures, as fractions of the canvas width. The natural box is the
 *  one minimising AREA — wide-and-short and narrow-and-tall both waste space,
 *  and the minimum sits between them. */
const MEASURE_FRACTIONS = [0.18, 0.24, 0.3, 0.36, 0.44, 0.52, 0.62, 0.74];

export interface CopyField {
  /** Field name (eyebrow / headline / lede / bullets / …). */
  name: string;
  /** The rendered string. Arrays and objects are flattened by the caller. */
  text: string;
}

/** The widest single unbreakable run, so a measure never fractures a word. */
const widestWord = (m: FontMetrics, text: string, sizePx: number): number => {
  let widest = 0;
  for (const w of text.split(/\s+/)) {
    if (!w) continue;
    const px = textWidth(m, w, sizePx);
    if (px > widest) widest = px;
  }
  return widest;
};

/**
 * The area a copy element's real strings need, and the box that achieves it.
 * Pure given the strings — the metrics are the deterministic fallback table.
 */
export const copyExtent = (
  fields: CopyField[],
  canvas: { w: number; h: number },
  scale: ExtentScale = NOMINAL_SCALE,
  metrics: FontMetrics = fallbackMetrics("sans-serif", 400),
): ContentExtent => {
  const present = fields.filter((f) => f.text && f.text.trim().length > 0);
  if (present.length === 0) {
    return { neededArea: 0, naturalW: 0, naturalH: 0, minW: 0, source: "derived" };
  }

  let minW = 0;
  for (const f of present) {
    const sc = sizeOfField(f.name, scale);
    const t = sc.caps ? f.text.toUpperCase() : f.text;
    minW = Math.max(minW, widestWord(metrics, t, sc.px) * 1.15);
  }

  let best: { area: number; w: number; h: number } | null = null;
  for (const frac of MEASURE_FRACTIONS) {
    const w = Math.round(frac * canvas.w);
    if (w < minW) continue;
    let h = 0;
    for (const f of present) {
      const sc = sizeOfField(f.name, scale);
      const t = sc.caps ? f.text.toUpperCase() : f.text;
      const lines = linesNeededPx(metrics, t, w, sc.px);
      if (!Number.isFinite(lines)) continue;
      h += lines * sc.lh * sc.px;
    }
    h += (present.length - 1) * FIELD_GAP_EM * scale.bodyPx;
    const area = w * h;
    if (!best || area < best.area) best = { area, w, h: Math.round(h) };
  }
  // Every candidate measure was narrower than the longest word: fall back to
  // the word's own width, which is the narrowest legal box.
  if (!best) {
    const w = Math.ceil(minW);
    let h = 0;
    for (const f of present) {
      const sc = sizeOfField(f.name, scale);
      const t = sc.caps ? f.text.toUpperCase() : f.text;
      const lines = linesNeededPx(metrics, t, w, sc.px);
      if (Number.isFinite(lines)) h += lines * sc.lh * sc.px;
    }
    best = { area: w * h, w, h: Math.round(h) };
  }

  return {
    neededArea: Math.round(best.area),
    naturalW: best.w,
    naturalH: best.h,
    minW: Math.ceil(minW),
    source: "derived",
  };
};

/**
 * Wrap a MEASURED painted rect as an extent. This is ground truth for text —
 * the ink that actually appeared — and outranks any derivation.
 */
export const measuredExtent = (painted: { w: number; h: number }): ContentExtent => ({
  neededArea: Math.round(painted.w * painted.h),
  naturalW: Math.round(painted.w),
  naturalH: Math.round(painted.h),
  minW: Math.round(painted.w * 0.6),
  source: "measured",
});

/**
 * A hero's scale anchor: the head's own authored box. NOT a content
 * derivation — see the module note. Recorded as `source: "authored"` precisely
 * so the report never claims more than it has.
 */
export const authoredExtent = (box: { w: number; h: number }): ContentExtent => ({
  neededArea: Math.round(box.w * box.h),
  naturalW: Math.round(box.w),
  naturalH: Math.round(box.h),
  minW: Math.round(box.w * 0.5),
  source: "authored",
});
