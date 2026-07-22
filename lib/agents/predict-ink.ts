/**
 * PREDICTED TEXT INK (ink re-score, 2026-07-22) — given a text element's box
 * and the ACTUAL copy strings it owns, predict the rectangle its ink will
 * paint. Pure, deterministic, no I/O.
 *
 * WHY THIS EXISTS. The persisted `rects-scene-N.json` measurements split the
 * corpus cleanly in two:
 *   - DIEGETIC pieces: declared box = painted ink, pixel-exact, 21/21. A mock
 *     fills its container; the declared box IS the ink.
 *   - TEXT pieces: 0/10 match — painted ink is ALWAYS smaller than the
 *     declared box (800×666 declared → 800×466 painted; the declared box runs
 *     1.04–2.09× its own ink, mean ≈1.5×). A declared text box is a CEILING,
 *     not a fill.
 * Every box-space metric therefore overstates how full a frame is, and every
 * text-sizing decision made in box space reserves air the frame never gets.
 * This module makes ink computable at plan time so scoring and sizing can be
 * done on what will actually paint.
 *
 * THE MODEL, and where each constant comes from (all calibrated once against
 * the 10 measured scenes, then FROZEN — see predict-ink.test.ts, which pins
 * the golden error):
 *   - width: ink w = box w. Text is block flow; the piece paints its measure.
 *     8/10 measured text pieces paint exactly their declared width; the two
 *     exceptions are extra-wide strips with centred single lines. Deliberately
 *     conservative in the SAFE direction for scoring: over-stating ink
 *     under-states voids for BOTH sides of any comparison symmetrically.
 *   - height: per owned field, wrap the REAL string through the calibrated
 *     UAX#14 engine (`linesNeededPx`) at the type scale `deriveTypeScale`
 *     picks for the box — the same scale the pipeline DECLARES to the emitter
 *     (P4b), which is why rendered sizes track it (verified: 8/10 scenes
 *     rendered headline px equal to the derived step).
 *   - structure: `meta` renders as one row per entry; `bullets` as stacked
 *     rows — EXCEPT in a wide strip with short items, where emitters render a
 *     chip row (flags-notion s3); `cta` renders as button chrome around each
 *     value, not bare text (flags-on-rappi s4); blocks carry vertical rhythm.
 *
 * MEASURED ACCURACY (the honest number, from the golden test): mean |height
 * error| ≈ 10% over the 8 scenes whose emission honoured the ownership
 * contract, worst ≈ 19%. Two of the ten measured scenes BROKE the contract at
 * emission time (one dropped an owned headline, one duplicated another
 * element's stat into the copy piece) and error 30–70% — a plan-time
 * predictor cannot see an emitter's disobedience, so those two are reported,
 * not hidden, and the golden test carries them under their own label. Note
 * the asymmetry with the pipeline use: when the box is SIZED from this
 * prediction, the capacity budget derived from that same box becomes the
 * emitter's contract, so the prediction is partly self-fulfilling in a way a
 * replay against historical free-form renders cannot be.
 *
 * Metrics are a required input: the pipeline passes the per-build calibrated
 * brand face (the same table the capacity budget uses); offline replays pass
 * whatever calibrated table is on disk or `typicalSansMetrics()`.
 */
import { fallbackMetrics, textWidth, type FontMetrics } from "../render/font-metrics";
import { linesNeededPx } from "../render/capacity";
import {
  deriveTypeScale,
  HEADLINE_LINE_HEIGHT,
  BODY_LINE_HEIGHT,
  type ResolvedTypeScale,
} from "../render/type-scale";

export interface Box {
  w: number;
  h: number;
}

export interface Rect extends Box {
  x: number;
  y: number;
}

/** The copy fields a text element can own (mirrors layout-composer.COPY_FIELDS). */
export const INK_COPY_FIELDS = [
  "eyebrow",
  "headline",
  "lede",
  "bullets",
  "caption",
  "meta",
  "cta",
  "texts",
] as const;

/** One owned copy field, with the RAW content value (string | array | object)
 *  exactly as it appears in scene.content — flattening is this module's job so
 *  every caller agrees on the structure model. */
export interface OwnedField {
  name: string;
  value: unknown;
}

interface FieldRole {
  kind: "headline" | "body";
  /** Size relative to the scale's headline/body px. */
  rel: number;
  lh: number;
  caps?: boolean;
  /** Arrays/objects render one visual row per entry (meta rows, bullets). */
  perItem?: boolean;
  /** Renders as button chrome around the text (cta). */
  chrome?: boolean;
}

/** Per-field render idiom. `rel` values mirror content-extent.ts so the two
 *  derivations can never disagree about what an eyebrow is. */
const FIELD_ROLE: Record<string, FieldRole> = {
  eyebrow: { kind: "body", rel: 0.72, lh: BODY_LINE_HEIGHT, caps: true },
  headline: { kind: "headline", rel: 1, lh: HEADLINE_LINE_HEIGHT },
  lede: { kind: "body", rel: 1.1, lh: BODY_LINE_HEIGHT },
  bullets: { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT, perItem: true },
  caption: { kind: "body", rel: 0.85, lh: BODY_LINE_HEIGHT },
  meta: { kind: "body", rel: 0.85, lh: BODY_LINE_HEIGHT, perItem: true },
  cta: { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT, perItem: true, chrome: true },
  texts: { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT },
};
const DEFAULT_FIELD: FieldRole = { kind: "body", rel: 1, lh: BODY_LINE_HEIGHT };

/**
 * The frozen structural constants, in ems of the scale's body px (except the
 * two idiom thresholds). Calibrated ONCE against the 10 measured scenes and
 * pinned by the golden test — tune them only against new measured rects.
 */
export const INK_MODEL = {
  /** Vertical rhythm between two copy blocks (eyebrow→headline→lede…). */
  BLOCK_GAP_EM: 1.3,
  /** Container top+bottom padding emitters put around the stack. */
  CONTAINER_PAD_EM: 0.9,
  /** Extra height of a CTA's button chrome beyond its label line. */
  CTA_CHROME_EM: 1.7,
  /** Rhythm between per-item rows inside one field (meta rows, bullet rows). */
  ITEM_GAP_EM: 0.45,
  /** Height of one chip/pill row, in ems of the FIELD's px. */
  CHIP_H_EM: 1.55,
  /** Horizontal padding a chip adds around its label, ems of the field's px. */
  CHIP_PAD_EM: 1.6,
  CHIP_GAP_EM: 0.5,
  /** Items at or under this length count as chip-able labels. */
  CHIP_MAX_CHARS: 40,
  /** A box at least this wide-per-tall is a STRIP: short multi-items render
   *  as a horizontal chip row there, not stacked lines (flags-notion s3). */
  STRIP_ASPECT: 4,
} as const;

/**
 * Deterministic stand-in metrics for offline replays with no calibrated table
 * on disk. 0.52em/char is the mixed-case mean of the UI sans faces we have
 * measured (Inter ≈ 0.52, Helvetica ≈ 0.53, Geist ≈ 0.51 — font-metrics.ts's
 * own numbers), i.e. a PREDICTION posture, unlike `fallbackMetrics`' 0.62em
 * which is a deliberately-wide BUDGET posture. Never use this for capacity
 * budgets; never use fallbackMetrics for ink prediction.
 */
export const TYPICAL_SANS_ADVANCE_100 = 52;
export const typicalSansMetrics = (): FontMetrics => ({
  ...fallbackMetrics("sans-serif", 400),
  meanAdv: TYPICAL_SANS_ADVANCE_100,
  fallbackAdv: TYPICAL_SANS_ADVANCE_100,
});

/** Flatten one content value into visual rows. `perValue` splits an object
 *  into one row per value (a cta's primary/secondary buttons); the default
 *  joins an object's values into one row (a meta entry's label+value pair). */
const itemsOf = (v: unknown, perValue = false): string[] => {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.map((x) => itemsOf(x).join(" ")).filter((s) => s.trim());
  if (typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>)
      .map((x) => (x === null || x === undefined ? "" : typeof x === "string" ? x : String(x)))
      .filter((s) => s.trim());
    return perValue ? vals : vals.length > 0 ? [vals.join(" ")] : [];
  }
  return [String(v)];
};

export interface InkPrediction {
  /** Predicted painted ink size. w = box w (see module note). */
  w: number;
  h: number;
  /** Copy blocks that actually carried text. 0 ⇒ nothing would paint. */
  blocks: number;
  /** The type scale the prediction was computed at — the same scale the
   *  pipeline declares to the emitter for this box. */
  scale: ResolvedTypeScale;
  /** True when any wrapped segment came back non-finite (defensive; the wrap
   *  engine only does that on degenerate input). */
  degraded: boolean;
}

/**
 * Predict the ink a copy element paints inside `box` given the verbatim
 * strings it owns. Pure: identical inputs yield an identical prediction.
 */
export const predictCopyInk = (
  fields: OwnedField[],
  box: Box,
  canvas: Box,
  metrics: FontMetrics,
): InkPrediction => {
  const scale = deriveTypeScale({ role: "copy", box: { w: box.w, h: box.h }, canvas });
  const M = INK_MODEL;
  const wrapW = Math.max(1, box.w);
  let h = 0;
  let blocks = 0;
  let degraded = false;

  for (const f of fields) {
    const fr = FIELD_ROLE[f.name] ?? DEFAULT_FIELD;
    const px = Math.max(12, Math.round((fr.kind === "headline" ? scale.headlinePx : scale.bodyPx) * fr.rel));
    const parts = fr.perItem ? itemsOf(f.value, f.name === "cta") : [itemsOf(f.value).join(" ")].filter((t) => t.trim());
    if (parts.length === 0) continue;

    let bh = 0;
    const isStrip = box.w / Math.max(1, box.h) >= M.STRIP_ASPECT;
    const chipRow = fr.perItem && !fr.chrome && isStrip && parts.length > 1 && parts.every((p) => p.length <= M.CHIP_MAX_CHARS);
    if (chipRow) {
      // Chip-row idiom: short labels in a wide strip render as pills packed
      // into rows, not stacked lines.
      let rowW = 0;
      let rows = 1;
      for (const p of parts) {
        const w = textWidth(metrics, p, px) + M.CHIP_PAD_EM * px;
        if (rowW > 0 && rowW + w > wrapW) {
          rows++;
          rowW = w;
        } else {
          rowW += w + M.CHIP_GAP_EM * px;
        }
      }
      bh = rows * M.CHIP_H_EM * px + (rows - 1) * M.ITEM_GAP_EM * scale.bodyPx;
    } else {
      for (const p of parts) {
        const t = fr.caps ? p.toUpperCase() : p;
        const lines = linesNeededPx(metrics, t, wrapW, px);
        if (!Number.isFinite(lines)) {
          degraded = true;
          continue;
        }
        bh += lines * fr.lh * px;
        if (fr.chrome) bh += M.CTA_CHROME_EM * px;
      }
      bh += (parts.length - 1) * M.ITEM_GAP_EM * scale.bodyPx;
    }
    h += bh;
    blocks++;
  }

  if (blocks === 0) return { w: 0, h: 0, blocks: 0, scale, degraded };
  h += (blocks - 1) * M.BLOCK_GAP_EM * scale.bodyPx + M.CONTAINER_PAD_EM * scale.bodyPx;
  return { w: Math.round(box.w), h: Math.round(h), blocks, scale, degraded };
};

/**
 * The ink RECT a text element paints, placed inside its declared bounds by the
 * natural alignment: TOP-LEFT flow (block layout starts at the container's
 * top; the measure spans its width). This is the stated assumption of every
 * ink-space score — all 10 measured text pieces paint from their box's top
 * edge (top offsets 2–48px), so top-anchoring tracks reality far better than
 * centring would.
 *
 * The height is NOT clipped to the declared bounds: with box enforcement off,
 * overflowing ink genuinely paints past the box, and clipping the prediction
 * would hide exactly the defect the measurement exists to reveal.
 */
export const predictInkRect = (
  bounds: Rect,
  fields: OwnedField[],
  canvas: Box,
  metrics: FontMetrics,
): { rect: Rect; prediction: InkPrediction } => {
  const prediction = predictCopyInk(fields, { w: bounds.w, h: bounds.h }, canvas, metrics);
  const rect: Rect =
    prediction.blocks === 0
      ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
      : { x: bounds.x, y: bounds.y, w: bounds.w, h: prediction.h };
  return { rect, prediction };
};

// ─── Ink-sized box (the pipeline's sizing primitive, RB_ALLOCATE) ───────────

/** Padding the ink-sized box adds around the predicted ink, in ems of the
 *  scale's body px per side. Derived from the same measurements as the model:
 *  painted piece rects exceed their text union by ~0.3–1em of body per edge. */
export const INK_BOX_PAD_EM = 0.6;

export interface InkSizedBox {
  /** The box: predicted ink + type-scale padding, never larger than the input. */
  box: Box;
  prediction: InkPrediction;
  /** Pixels of area released by the shrink (0 when the box was kept). */
  freedPx: number;
  /** True when the prediction exceeded the input box and the input was KEPT
   *  (sizing-to-ink only ever shrinks; growth without redistribution is the
   *  hollow-panel defect this whole pass exists to avoid). */
  kept: boolean;
}

/**
 * Size a text box to its own ink: `box = predicted ink + type-scale padding`,
 * bounded so the TYPE SCALE THE PREDICTION USED STILL DERIVES from the result
 * (deriveTypeScale walks the ramp by box size, so an unguarded shrink could
 * downshift the scale below the one the ink was predicted at — the box and
 * its capacity budget would then quietly disagree). The floors below make
 * `deriveTypeScale(result).step === prediction.scale.step` hold by
 * construction, and the golden test asserts it.
 */
export const inkSizedBox = (
  bounds: Box,
  fields: OwnedField[],
  canvas: Box,
  metrics: FontMetrics,
): InkSizedBox => {
  const prediction = predictCopyInk(fields, bounds, canvas, metrics);
  if (prediction.blocks === 0 || prediction.h <= 0) {
    return { box: { w: bounds.w, h: bounds.h }, prediction, freedPx: 0, kept: true };
  }
  const s = prediction.scale;
  const pad = INK_BOX_PAD_EM * s.bodyPx;
  // The scale-stability floors: the minimum box deriveTypeScale needs to pick
  // the SAME step it picked for the input box (copy demands 2 headline lines +
  // 2 body lines of height and 6em of headline width — type-scale.ts).
  const minScaleH = 2 * s.headlinePx * (s.headlineLineHeight ?? HEADLINE_LINE_HEIGHT) + 2 * s.bodyPx * (s.bodyLineHeight ?? BODY_LINE_HEIGHT);
  // The MEASURE is preserved verbatim: the ink was wrapped at this width, so
  // narrowing it would invalidate the very prediction the box is sized from
  // (and the width already satisfies the step's 6-em rule, or the derivation
  // would have downshifted). Only height shrinks to ink.
  const w = Math.round(bounds.w);
  const h = Math.round(Math.max(minScaleH, prediction.h + 2 * pad));
  if (h >= bounds.h) {
    // Ink (plus padding) already fills or exceeds the declared box — keep it.
    return { box: { w: bounds.w, h: bounds.h }, prediction, freedPx: 0, kept: true };
  }
  const box = { w, h };
  return { box, prediction, freedPx: Math.max(0, bounds.w * bounds.h - box.w * box.h), kept: false };
};
