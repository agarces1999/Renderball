/**
 * Capacity budgets — turn a pixel box into an instruction an emitter can obey.
 *
 * The frame-authoring head hands each element PIXEL BOUNDS. Today the element
 * emitter writes copy blind and a gate discovers the overflow afterwards. This
 * module closes that loop from the other side: given a box and a type scale, it
 * answers "this box holds ≤N headline characters, ≤R rows, ≤C chips, ≤D nesting
 * levels" — a budget the emitter can be told BEFORE it writes a word.
 *
 * It is built on Chromium-measured glyph advances (./font-metrics.ts), so the
 * arithmetic agrees with the engine that renders the MP4, and on `linebreak`
 * (MIT, UAX#14 — Satori's own break-opportunity dependency) for where lines may
 * actually break.
 *
 * WHY NOT SPLIT ON SPACES
 *   Naive whitespace splitting silently miscounts every string containing a
 *   hyphen, slash, em-dash, or CJK — "compra-ahora", "24/7", "más rápido — sin
 *   fricción" all wrap at points a space-splitter cannot see. A budget handed to
 *   a BLIND emitter must not lie, so break opportunities come from the real
 *   UAX#14 algorithm, not a regex.
 */
import LineBreaker from "linebreak";
import {
  type FontMetrics,
  measureText,
  textWidth,
  DEFAULT_NORMAL_LINE_HEIGHT,
  isCalibrated,
} from "./font-metrics";

/**
 * MANDATORY CONSERVATIVE MARGIN — 4%.
 *
 * A per-glyph advance SUM provably drifts from whole-string measurement. The
 * drift is real, engine-level, and documented:
 *   - Mozilla bug 563758 — summing per-character advances does not equal the
 *     measured width of the whole string (shaping, kerning, hinting, and
 *     sub-pixel accumulation all apply to the RUN, not the glyph).
 *   - Mozilla bug 1126391 — canvas measureText and DOM layout measure
 *     differently for the same font and string.
 *   - Satori issue #393 — exactly this bug class, shipping in production:
 *     predicted text fit disagreeing with rendered text fit.
 *
 * We cannot make the drift zero, so we make it HARMLESS by spending it in one
 * direction. Every budget shrinks the usable box by this margin, so the engine
 * errs toward UNDER-filling. An under-filled box is a design nit; an overflowed
 * box is a shipped defect.
 *
 * 4% is not a guess. capacity.test.ts calibrates real fonts in real headless
 * Chromium and compares this module's browser-free prediction against measured
 * widths across 144 string×size×face combinations: max |drift| 1.99%, and the
 * worst case in the DANGEROUS direction (predicting narrower than reality) is
 * 0.004% — effectively zero, because per-glyph sums ignore the negative kerning
 * and ligature substitution that only ever make real text narrower. The 1.99%
 * outlier is a serif face substituting fi/ffl ligatures we deliberately measure
 * without. So 4% buys ~2× headroom over the observed worst case while staying
 * inside the mandated 3–5% band. Re-run that test before changing this number.
 */
export const CAPACITY_SAFETY_MARGIN = 0.04;

/**
 * Wider margin for UNCALIBRATED fonts. When advances are synthesized rather
 * than measured, the per-glyph error is an order of magnitude larger than the
 * shaping drift the 4% covers, so an uncalibrated budget buys more headroom.
 */
export const UNCALIBRATED_SAFETY_MARGIN = 0.1;

export interface Box {
  w: number;
  h: number;
}

export interface TypeScale {
  /** Headline font size in px. */
  headlinePx: number;
  /** Body / row copy font size in px. */
  bodyPx: number;
  /** Headline line-height MULTIPLIER (not px). Display type sets tight. */
  headlineLineHeight?: number;
  /** Body line-height multiplier. */
  bodyLineHeight?: number;
}

export interface Capacity {
  /**
   * Max headline characters, assuming SENTENCE/TITLE CASE copy, that wrap
   * inside the box within `maxHeadlineRows`.
   */
  headlineChars: number;
  /**
   * Max headline characters when the copy is set in ALL CAPS — an eyebrow, a
   * kicker, a `text-transform: uppercase` label.
   *
   * This is a SEPARATE number because capitals run ~35–40% wider than
   * lowercase, so a mixed-case character budget is not merely imprecise for
   * caps copy, it is wrong by lines: measured in Chromium, 108 characters of
   * caps wrapped to 7 lines in a box budgeted for 5. Hand the emitter whichever
   * number matches the case it is about to write.
   */
  headlineCharsUppercase: number;
  /** Max body rows (list items / stat lines) that fit vertically. */
  maxRows: number;
  /** Max headline lines the box's height allows. */
  maxHeadlineRows: number;
  /** Max nominal chips/pills that fit (grid of `chipsPerRow` × chip rows). */
  maxChips: number;
  chipsPerRow: number;
  /** Max nested container depth before the innermost box can't hold a row. */
  maxDepth: number;
  /** The margin actually applied (wider when the font was uncalibrated). */
  marginApplied: number;
  /**
   * True when any part of this budget rests on a conservative fallback rather
   * than a Chromium measurement. Propagate it — a flagged budget is an
   * estimate.
   */
  estimated: boolean;
}

// ── tunables (named, not magic) ─────────────────────────────────────────────

const DEFAULT_HEADLINE_LINE_HEIGHT = 1.1;
const DEFAULT_BODY_LINE_HEIGHT = 1.5;

/** Nominal chip label used to size a chip. ~10 chars is our observed median. */
export const CHIP_NOMINAL_LABEL = "Automático";
/** Chip horizontal padding, as a multiple of body font-size (both sides sum). */
const CHIP_PAD_X_EM = 1.4;
/** Chip box height, as a multiple of body font-size. */
const CHIP_HEIGHT_EM = 2.2;
/** Gap between chips, as a multiple of body font-size. */
const CHIP_GAP_EM = 0.6;

/** Container padding per nesting level, as a multiple of body font-size. */
const NEST_PAD_EM = 0.9;
/** Narrowest readable inner column, in body characters. */
const NEST_MIN_CHARS = 10;
/** Hard cap — deeper than this reads as fussy regardless of geometry. */
export const MAX_NEST_DEPTH = 4;

/**
 * A character budget cannot be exact, and pretending otherwise is how these
 * systems lie. Greedy wrapping waste is SEQUENCE-dependent: 147 characters of
 * one word sequence wraps to 5 lines while 147 of another wraps to 6, at
 * identical widths. So `headlineChars` is sized against SEVERAL filler
 * sequences and takes the WORST, then charges an explicit per-break allowance.
 *
 * Short words waste little; long words waste up to (wordLength − 1) characters
 * at every line break. Spanish headline copy skews long ("crecimiento",
 * "experiencia", "inmediato"), so the long-word sequence is the binding one and
 * it is deliberately included.
 *
 * `fits()` / `linesNeeded()` remain the EXACT check for text that already
 * exists. `headlineChars` is the instruction for text that does not yet.
 */
const FILLER_SEQUENCES: string[][] = [
  // short — mean ~4.5
  ["Cada", "marca", "hoy", "más", "señal", "clara", "para", "ti", "ya", "vive"],
  // medium — mean ~6
  ["propio", "video", "hecho", "crecer", "rápido", "diseño", "fuerte", "minutos"],
  // long — mean ~10, the waste driver
  ["crecimiento", "experiencia", "inmediato", "automático", "resultados", "convierte", "plataforma"],
];

/**
 * Extra characters surrendered per line BREAK, on top of the worst measured
 * filler. Covers sequences unlike any of the three (an unusually long proper
 * noun, a run of caps) without collapsing the budget to uselessness. Named and
 * small on purpose: the fillers do the real work, this is the residual.
 */
const WRAP_WASTE_CHARS_PER_BREAK = 2;

/** ALL-CAPS variants of the same sequences — capitals are far wider. */
const FILLER_SEQUENCES_UPPER: string[][] = FILLER_SEQUENCES.map((ws) =>
  ws.map((w) => w.toUpperCase()),
);

const fillerOfLength = (words: string[], n: number): string => {
  let s = "";
  let i = 0;
  while (s.length < n) {
    s += (s ? " " : "") + words[i % words.length];
    i++;
  }
  return s.slice(0, n).replace(/[ \t]+$/, "");
};

// ── UAX#14 line fitting ─────────────────────────────────────────────────────

/**
 * Trailing COLLAPSIBLE whitespace does not contribute to a rendered line's
 * width. Deliberately NOT the `\s` class — JS's `\s` includes U+00A0, and CSS
 * does not collapse a non-breaking space, so trimming it would UNDER-estimate
 * width, which is the one direction this engine must never err in.
 */
const trimEnd = (s: string): string => s.replace(/[ \t\n\r\f\v]+$/, "");

/**
 * How many lines `text` occupies when wrapped to `maxWidthPx`.
 *
 * Greedy first-fit over UAX#14 break opportunities — the same strategy every
 * browser uses for `overflow-wrap: normal`. A single unbreakable segment wider
 * than the box is charged `ceil(w / maxWidth)` lines (what `overflow-wrap:
 * anywhere` would do) rather than 1, so an unbreakable URL or compound word can
 * never make a budget look roomier than it is.
 */
export const linesNeededPx = (
  m: FontMetrics,
  text: string,
  maxWidthPx: number,
  sizePx: number,
): number => {
  if (!text.trim()) return 0;
  if (!(maxWidthPx > 0) || !(sizePx > 0)) return Infinity;

  const breaker = new LineBreaker(text);
  let lines = 1;
  let lineStart = 0;
  let lastFit = -1; // last break position known to fit on the current line
  let bk = breaker.nextBreak();

  const widthOf = (from: number, to: number): number =>
    textWidth(m, trimEnd(text.slice(from, to)), sizePx);

  while (bk) {
    const pos = bk.position;
    if (bk.required && pos < text.length) {
      lines++;
      lineStart = pos;
      lastFit = -1;
      bk = breaker.nextBreak();
      continue;
    }
    const w = widthOf(lineStart, pos);
    if (w <= maxWidthPx) {
      lastFit = pos;
      bk = breaker.nextBreak();
      continue;
    }
    // Overflows. Break at the last opportunity that fit, if there was one.
    if (lastFit > lineStart) {
      lines++;
      lineStart = lastFit;
      lastFit = -1;
      continue; // re-test THIS break against the new line start
    }
    // No break opportunity fit: the segment itself is unbreakable and too wide.
    const segW = widthOf(lineStart, pos);
    lines += Math.max(1, Math.ceil(segW / maxWidthPx)) - 1;
    lineStart = pos;
    lastFit = -1;
    bk = breaker.nextBreak();
  }
  return lines;
};

// ── margin plumbing ─────────────────────────────────────────────────────────

const marginFor = (m: FontMetrics): number =>
  isCalibrated(m) ? CAPACITY_SAFETY_MARGIN : UNCALIBRATED_SAFETY_MARGIN;

/** The box an emitter may actually plan against: shrunk by the safety margin. */
export const usableBox = (box: Box, m: FontMetrics): Box => {
  const margin = marginFor(m);
  return { w: Math.max(0, box.w * (1 - margin)), h: Math.max(0, box.h * (1 - margin)) };
};

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Lines `text` needs inside `box` at `sizePx`, with the safety margin applied.
 * Conservative by construction: the margin narrows the box, which can only
 * INCREASE the count.
 */
export const linesNeeded = (
  text: string,
  box: Box,
  sizePx: number,
  m: FontMetrics,
): number => linesNeededPx(m, text, usableBox(box, m).w, sizePx);

/**
 * Does `text` fit inside `box` at `sizePx`? The inverse of the budget — for
 * validating what an emitter actually wrote.
 *
 * `lineHeight` is a MULTIPLIER; omitted, it uses the font's measured
 * line-height:normal ratio.
 */
export const fits = (
  text: string,
  box: Box,
  sizePx: number,
  m: FontMetrics,
  lineHeight?: number,
): boolean => {
  const usable = usableBox(box, m);
  const lh = (lineHeight ?? m.normalLineHeight ?? DEFAULT_NORMAL_LINE_HEIGHT) * sizePx;
  if (!(usable.w > 0) || !(usable.h > 0) || !(lh > 0)) return false;
  const rows = linesNeededPx(m, text, usable.w, sizePx);
  if (!Number.isFinite(rows)) return false;
  return rows * lh <= usable.h;
};

/**
 * The budget. Everything an emitter needs to write TO FIT, given a box and the
 * type scale it will render at.
 */
export const capacityFor = (box: Box, scale: TypeScale, m: FontMetrics): Capacity => {
  const margin = marginFor(m);
  const usable = usableBox(box, m);
  const headlineLh = (scale.headlineLineHeight ?? DEFAULT_HEADLINE_LINE_HEIGHT) * scale.headlinePx;
  const bodyLh = (scale.bodyLineHeight ?? DEFAULT_BODY_LINE_HEIGHT) * scale.bodyPx;

  const empty: Capacity = {
    headlineChars: 0, headlineCharsUppercase: 0, maxRows: 0, maxHeadlineRows: 0, maxChips: 0,
    chipsPerRow: 0, maxDepth: 0, marginApplied: margin,
    estimated: !isCalibrated(m),
  };
  if (!(usable.w > 0) || !(usable.h > 0) || !(scale.headlinePx > 0) || !(scale.bodyPx > 0)) {
    return empty;
  }

  const maxHeadlineRows = Math.floor(usable.h / headlineLh);
  const maxRows = Math.floor(usable.h / bodyLh);

  // headlineChars: the largest filler length that still wraps within
  // maxHeadlineRows. Binary-searched through the REAL wrap engine, so the
  // answer already pays the ragged-right waste a closed-form estimate misses.
  // headline budgets: the largest length that still wraps within
  // maxHeadlineRows for the WORST of several filler sequences, less an explicit
  // per-break allowance. Searched through the REAL wrap engine, so the answer
  // already pays the ragged-right waste a closed-form estimate misses.
  const narrowest = Math.max(1, textWidth(m, "i", scale.headlinePx));
  const ceiling = Math.ceil((usable.w * Math.max(1, maxHeadlineRows)) / narrowest) + 8;
  const budgetFor = (sequences: string[][]): number => {
    if (maxHeadlineRows < 1) return 0;
    let worst = Infinity;
    for (const words of sequences) {
      let lo = 0;
      let hi = ceiling;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const rows = linesNeededPx(m, fillerOfLength(words, mid), usable.w, scale.headlinePx);
        if (rows <= maxHeadlineRows) lo = mid;
        else hi = mid - 1;
      }
      if (lo < worst) worst = lo;
    }
    return Math.max(0, worst - WRAP_WASTE_CHARS_PER_BREAK * Math.max(0, maxHeadlineRows - 1));
  };
  const headlineChars = budgetFor(FILLER_SEQUENCES);
  const headlineCharsUppercase = budgetFor(FILLER_SEQUENCES_UPPER);

  // Chips: a grid of nominal pills.
  const chipLabelW = measureText(m, CHIP_NOMINAL_LABEL, scale.bodyPx).width;
  const chipW = chipLabelW + CHIP_PAD_X_EM * scale.bodyPx;
  const chipH = CHIP_HEIGHT_EM * scale.bodyPx;
  const gap = CHIP_GAP_EM * scale.bodyPx;
  const chipsPerRow = Math.max(0, Math.floor((usable.w + gap) / (chipW + gap)));
  const chipRows = Math.max(0, Math.floor((usable.h + gap) / (chipH + gap)));
  const maxChips = chipsPerRow * chipRows;

  // Nesting depth: each level insets by NEST_PAD_EM on all four sides. Depth is
  // the last level whose interior still holds one body row of readable width.
  const pad = NEST_PAD_EM * scale.bodyPx;
  const minW = textWidth(m, "n".repeat(NEST_MIN_CHARS), scale.bodyPx);
  let maxDepth = 0;
  for (let d = 1; d <= MAX_NEST_DEPTH; d++) {
    const iw = usable.w - 2 * d * pad;
    const ih = usable.h - 2 * d * pad;
    if (iw >= minW && ih >= bodyLh) maxDepth = d;
    else break;
  }

  return {
    headlineChars,
    headlineCharsUppercase,
    maxRows,
    maxHeadlineRows,
    maxChips,
    chipsPerRow,
    maxDepth,
    marginApplied: margin,
    estimated: !isCalibrated(m),
  };
};

/**
 * Render a budget as the one-line instruction an emitter is given. Kept here so
 * the wording lives next to the numbers it describes (P4b wires this into the
 * element prompt).
 */
export const describeCapacity = (c: Capacity): string =>
  `This box holds at most ${c.headlineChars} headline characters ` +
  `(${c.headlineCharsUppercase} if set in ALL CAPS; ≤${c.maxHeadlineRows} line${c.maxHeadlineRows === 1 ? "" : "s"}), ` +
  `${c.maxRows} body row${c.maxRows === 1 ? "" : "s"}, ` +
  `${c.maxChips} chip${c.maxChips === 1 ? "" : "s"}, ` +
  `and ${c.maxDepth} level${c.maxDepth === 1 ? "" : "s"} of nesting. Write to fit.` +
  (c.estimated ? " (ESTIMATE — font not calibrated; stay well under.)" : "");
