/**
 * COPY OVERFLOW REJECTION — catch text that does not fit BEFORE a render pass.
 *
 * The capacity budget (./capacity.ts) tells a blind emitter how much copy its
 * box holds. This module is the other half: it checks what the emitter actually
 * wrote, in the element's own emission round, so an overflowing element is
 * repaired for the price of one ~10s re-emission instead of a full
 * Chromium render + vision gate round (44–100s) — or worse, shipping.
 *
 * WHY THIS IS MEASURABLE AT ALL (and why it is scoped to OWNED SCENE COPY)
 * ----------------------------------------------------------------------
 * A general "does this JSX overflow?" question needs a layout engine. But the
 * one text class that actually overflows in practice is EDITORIAL COPY — the
 * headline / eyebrow / lede / bullets an element owns — and that text is known
 * VERBATIM before the element is even generated: it comes from the script, not
 * the model. So for exactly that class we know the string, the box, and (below)
 * the size it renders at, which is enough for capacity.ts's exact `linesNeeded`
 * arithmetic. Diegetic interior text a model invents inside a hero mock is NOT
 * checked here: we would have to guess both the string's container and its size,
 * and a guessed rejection costs a real re-emission. Budgets still constrain that
 * text via the prompt; only the exact-measurable class can REJECT.
 *
 * HOW THE SIZE IS ATTRIBUTED
 * --------------------------
 * The cast contract already requires every copy node to carry
 * `data-content-path="<field>"` (choreograph.ts targets those selectors). That
 * tag is the attribution hook: we find the tag bearing it and read `fontSize` /
 * `textTransform` / `lineHeight` off THAT element's own style object. No
 * proximity heuristics, no guessing which style belongs to which text.
 *
 * UPPERCASE IS READ, NOT ASSUMED
 * ------------------------------
 * P4a measured the defect this exists for: 108 characters of ALL CAPS wrapped to
 * SEVEN lines in a box budgeted for five, because capitals run ~35–40% wider.
 * Our eyebrow/kicker copy is routinely `text-transform: uppercase`, so a check
 * that measured the mixed-case string would systematically miss the single most
 * likely overflow on the frame. When the tagged node declares uppercase, the
 * string is measured UPPERCASED.
 */
import {
  type FontMetrics,
  DEFAULT_NORMAL_LINE_HEIGHT,
  isCalibrated,
} from "./font-metrics";
import { type Box, linesNeeded, usableBox } from "./capacity";
import type { ResolvedTypeScale } from "./type-scale";

/** One copy field an element owns, with the verbatim value it must render. */
export interface CopyEntry {
  /** The data-content-path, e.g. "headline", "bullets.0", "meta.1.value". */
  path: string;
  /** The verbatim string from the script. */
  text: string;
}

/** What a tagged node's own style declares about how its text renders. */
export interface TaggedStyle {
  /** Explicit numeric fontSize in px, when the node declares one. */
  fontSizePx?: number;
  /** True when the node declares `text-transform: uppercase`. */
  uppercase: boolean;
  /** Line-height MULTIPLIER (a px value is converted when a size is known). */
  lineHeight?: number;
}

/**
 * Fields that carry DISPLAY type. Everything else is measured at the body size.
 * `headline` is the only true display field in the cast contract; an eyebrow is
 * a small label that happens to sit above it (and is the field most often set in
 * caps — see the module note).
 */
const DISPLAY_FIELDS: ReadonlySet<string> = new Set(["headline"]);

/**
 * Vertical rhythm between stacked copy fields, as a multiple of body size. A
 * copy column is a flow stack, not a set of absolutely-placed boxes, so the gaps
 * are real height the fields must share. Conservative (small): over-charging the
 * gap would manufacture overflow rejections out of well-fitting copy.
 */
const STACK_GAP_EM = 0.5;

// ── tag scanning ────────────────────────────────────────────────────────────

/**
 * Walk every JSX opening tag in `body` and return its source span. Quote- and
 * brace-aware (a `>` inside `style={{ … }}` or inside a string is not the end of
 * the tag), mirroring the scanners cast-build.ts already uses for its
 * deterministic post-passes.
 */
const tagSpans = (body: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "<") continue;
    // Skip closing tags and comments — neither carries attributes.
    if (body[i + 1] === "/" || body[i + 1] === "!") continue;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let j = i + 1; j < body.length; j++) {
      const ch = body[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "<" && depth === 0) break; // unterminated tag — bail
      else if (ch === ">" && depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) continue;
    out.push(body.slice(i, end + 1));
    i = end;
  }
  return out;
};

const FONT_SIZE_RX = /\bfontSize\s*:\s*["'`]?(\d+(?:\.\d+)?)\s*(?:px)?["'`]?/;
const CSS_FONT_SIZE_RX = /\bfont-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i;
const UPPERCASE_RX = /\btextTransform\s*:\s*["'`]uppercase["'`]|\btext-transform\s*:\s*uppercase/i;
const LINE_HEIGHT_RX = /\blineHeight\s*:\s*["'`]?(\d+(?:\.\d+)?)\s*(?:px)?["'`]?/;

/** A lineHeight literal above this reads as PX, not a multiplier (CSS's own
 *  convention — no one sets `line-height: 8`). */
const LINE_HEIGHT_PX_THRESHOLD = 4;

const parseStyle = (tag: string): TaggedStyle => {
  const sizeM = FONT_SIZE_RX.exec(tag) ?? CSS_FONT_SIZE_RX.exec(tag);
  const fontSizePx = sizeM ? Number(sizeM[1]) : undefined;
  const lhM = LINE_HEIGHT_RX.exec(tag);
  let lineHeight: number | undefined;
  if (lhM) {
    const v = Number(lhM[1]);
    lineHeight =
      v > LINE_HEIGHT_PX_THRESHOLD ? (fontSizePx && fontSizePx > 0 ? v / fontSizePx : undefined) : v;
  }
  return {
    fontSizePx: fontSizePx && fontSizePx > 0 ? fontSizePx : undefined,
    uppercase: UPPERCASE_RX.test(tag),
    lineHeight: lineHeight && lineHeight > 0 ? lineHeight : undefined,
  };
};

/**
 * Map each `data-content-path` present in `body` to what its own tag declares.
 * A path tagged more than once (the emitter split a field across nodes) keeps
 * the LARGEST declared size — the widest reading is the conservative one.
 */
export const parseTaggedCopyStyles = (body: string): Map<string, TaggedStyle> => {
  const out = new Map<string, TaggedStyle>();
  for (const tag of tagSpans(body)) {
    const m = /data-content-path\s*=\s*["'{]?["'`]?([A-Za-z0-9_.\[\]]+)["'`]?["'}]?/.exec(tag);
    if (!m) continue;
    const path = m[1];
    const style = parseStyle(tag);
    const prev = out.get(path);
    if (!prev) {
      out.set(path, style);
      continue;
    }
    out.set(path, {
      fontSizePx: Math.max(prev.fontSizePx ?? 0, style.fontSizePx ?? 0) || undefined,
      uppercase: prev.uppercase || style.uppercase,
      lineHeight: Math.max(prev.lineHeight ?? 0, style.lineHeight ?? 0) || undefined,
    });
  }
  return out;
};

/** The largest explicit fontSize anywhere in the body. Used only as the
 *  INHERITED size for a display field whose own node declares none (a copy
 *  column's largest type is its headline by construction). */
export const maxDeclaredFontSize = (body: string): number => {
  let max = 0;
  for (const tag of tagSpans(body)) {
    const s = parseStyle(tag).fontSizePx;
    if (s && s > max) max = s;
  }
  return max;
};

// ── the check ───────────────────────────────────────────────────────────────

export interface CopyFitEntry {
  path: string;
  /** The string as it RENDERS (uppercased when the node transforms it). */
  rendered: string;
  sizePx: number;
  uppercase: boolean;
  lines: number;
  /** Height this field occupies, in px. */
  heightPx: number;
}

export interface CopyFitReport {
  overflows: boolean;
  /** Stacked height of every owned field, including inter-field gaps. */
  totalPx: number;
  /** The box height actually available (safety margin already applied). */
  availablePx: number;
  entries: CopyFitEntry[];
  /** The single worst offender (most lines beyond its share). Absent when the
   *  stack fits. */
  worst?: CopyFitEntry;
  /** True when the budget rests on uncalibrated metrics — propagated so a
   *  caller can weigh a rejection differently. */
  estimated: boolean;
}

export interface CheckCopyOverflowArgs {
  /** The emitted JSX fragment. */
  body: string;
  /** The copy fields this element owns, verbatim. */
  entries: CopyEntry[];
  /** The element's authored bounds. */
  box: Box;
  /** The scale the element was TOLD to render at (the budget's basis). */
  scale: ResolvedTypeScale;
  metrics: FontMetrics;
  /**
   * When true, a DISPLAY field whose own node declares no fontSize inherits the
   * largest size declared anywhere in the body. Correct for a copy column (its
   * largest type IS the headline); wrong for a hero, whose largest type may be a
   * stat unrelated to the copy — so callers set this only for text elements.
   */
  inheritLargestForDisplay?: boolean;
}

/**
 * Measure the element's owned copy against its box.
 *
 * Every arithmetic choice errs toward NOT rejecting: the safety margin comes
 * from capacity.ts (which already shrinks the box), gaps are charged small, and
 * a field with no attributable size falls back to the DECLARED scale rather than
 * to a worst case. A false rejection costs a real re-emission; a missed overflow
 * costs only what the render-side gates already catch today.
 */
export const checkCopyOverflow = (args: CheckCopyOverflowArgs): CopyFitReport => {
  const { body, entries, box, scale, metrics, inheritLargestForDisplay } = args;
  const usable = usableBox(box, metrics);
  const styles = parseTaggedCopyStyles(body);
  const largest = inheritLargestForDisplay ? maxDeclaredFontSize(body) : 0;

  const out: CopyFitEntry[] = [];
  let total = 0;
  for (const e of entries) {
    const text = (e.text ?? "").trim();
    if (!text) continue;
    const style = styles.get(e.path);
    const isDisplay = DISPLAY_FIELDS.has(e.path);
    const declared = isDisplay ? scale.headlinePx : scale.bodyPx;
    const sizePx =
      style?.fontSizePx ??
      (isDisplay ? Math.max(declared, largest) : declared);
    const uppercase = style?.uppercase ?? false;
    const rendered = uppercase ? text.toUpperCase() : text;
    const lh =
      style?.lineHeight ??
      (isDisplay ? scale.headlineLineHeight : scale.bodyLineHeight) ??
      metrics.normalLineHeight ??
      DEFAULT_NORMAL_LINE_HEIGHT;
    const lines = linesNeeded(rendered, box, sizePx, metrics);
    if (!Number.isFinite(lines)) {
      // A zero-width box (or a zero size) — capacity.ts's own signal that this
      // geometry holds nothing. Not an emission defect; do not reject on it.
      continue;
    }
    const heightPx = lines * sizePx * lh;
    out.push({ path: e.path, rendered, sizePx, uppercase, lines, heightPx });
    total += heightPx;
  }
  if (out.length > 1) total += (out.length - 1) * STACK_GAP_EM * scale.bodyPx;

  const overflows = out.length > 0 && total > usable.h;
  const worst = overflows
    ? out.reduce((a, b) => (b.heightPx > a.heightPx ? b : a))
    : undefined;

  return {
    overflows,
    totalPx: Math.round(total),
    availablePx: Math.round(usable.h),
    entries: out,
    worst,
    estimated: !isCalibrated(metrics),
  };
};

/**
 * The repair instruction for an overflowing element.
 *
 * The copy VALUES are fixed (they come from the script and the element renders
 * them verbatim), so the only lever the emitter has is TYPE — smaller sizes,
 * tighter leading, and dropping any transform that widens the string. The
 * message says so explicitly, otherwise the model's instinct is to rewrite the
 * copy it is contractually forbidden to rewrite.
 */
export const overflowRepairMessage = (
  report: CopyFitReport,
  scale: ResolvedTypeScale,
): string => {
  const w = report.worst;
  const over = report.totalPx - report.availablePx;
  const tighter = Math.max(1, Math.floor(scale.headlinePx * 0.75));
  const tighterBody = Math.max(1, Math.floor(scale.bodyPx * 0.85));
  return [
    `copy OVERFLOWS its wrapper: the owned fields stack to ~${report.totalPx}px inside a ${report.availablePx}px-tall box (${over}px over).`,
    w
      ? `Worst field is data-content-path="${w.path}" — ${w.rendered.length} characters${w.uppercase ? " set in ALL CAPS (capitals run ~35-40% wider than mixed case)" : ""} at ${w.sizePx}px wrap to ${w.lines} lines.`
      : "",
    `The copy TEXT is fixed — it renders verbatim from the \`c\` binding and must NOT be shortened, reworded, or dropped.`,
    `Fix it with TYPE instead: set the headline at ${tighter}px or less and body/label text at ${tighterBody}px or less, tighten leading toward ${scale.headlineLineHeight}, and remove any \`textTransform: "uppercase"\` on a long field (uppercase alone can cost two extra lines).`,
  ]
    .filter(Boolean)
    .join(" ");
};

// ─── Shrink-to-fit (Bug 2, the TEXT arm) ────────────────────────────────────
//
// A text piece is emitted with `maxWidth` and NO height, so a headline that
// wraps to more lines than its box planned simply grows downward into whatever
// sits beneath it. Clipping is not the answer — cutting words in half is worse
// than the defect. Scaling is: the copy gets SMALLER and stays whole.
//
// WHY THIS IS PRECOMPUTED AND NOT `fitText`.
// `@remotion/layout-utils`' `fitText` was the recommended tool and does not fit
// this path, for three independent reasons:
//   1. It is not a dependency of this project, and adding one is not the
//      cheapest correct move when the measurement engine is already here.
//   2. It measures in a browser (DOM/canvas). This composition is rendered with
//      `renderToStaticMarkup` in two load-bearing places — the SSR gate and
//      measure-scene — where there is no DOM. A runtime fit would silently
//      no-op there, so the MEASURED frame would disagree with the MP4. Since
//      measure-scene IS the render-truth gate, that disagreement is not a
//      cosmetic risk, it is the gate going blind.
//   3. It solves single-line-text-to-WIDTH. The defect here is a wrapped block
//      growing in HEIGHT, which is a different question.
// P4a/P4b already predict wrapped line counts exactly, in pure Node, from
// Chromium-calibrated metrics (max drift in the dangerous direction: 0.004%).
// So the factor is derived here and baked into the emitted CSS — deterministic,
// zero runtime cost, and identical in SSR, preview and render.

/** Descending ladder of scale factors. Coarse on purpose: a 5% step is below
 *  the threshold of noticing, and a finer search buys precision nobody sees. */
const FIT_LADDER = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7] as const;

/**
 * The smallest downscale is the best one, so the ladder is walked from 1.0 down
 * and the FIRST factor that fits wins. `FIT_SCALE_FLOOR` is where scaling stops
 * being a fix: below it the copy is small enough to read as a mistake, and the
 * right response is P4b's overflow rejection (re-emit with tighter type), not a
 * smaller render. A block that does not fit even at the floor returns the floor
 * — the assembler still emits `maxHeight`, and the residue is the repair
 * ladder's problem, not something to hide by shrinking to nothing.
 */
export const FIT_SCALE_FLOOR = 0.7;

/** Which of the two type sizes a field renders at. Mirrors the emitter's own
 *  convention: the headline is display type, everything else is body/label. */
const sizeForPath = (path: string, scale: ResolvedTypeScale): { px: number; lh: number } =>
  path === "headline"
    ? { px: scale.headlinePx, lh: scale.headlineLineHeight }
    : { px: scale.bodyPx, lh: scale.bodyLineHeight };

export interface FitScaleArgs {
  /** The copy this piece owns, verbatim (see cast-build's ownedCopyEntries). */
  entries: CopyEntry[];
  /** The piece's declared box in canvas px. */
  box: Box;
  scale: ResolvedTypeScale;
  metrics: FontMetrics;
  /** Fields the emitter sets in caps — measured uppercased (P4a finding #2). */
  uppercasePaths?: Set<string>;
}

/**
 * Predicted STACKED height (px) of the owned copy at a given scale factor.
 *
 * The assembler emits `width: box.w / s` with `transform: scale(s)`, which lays
 * the text out at width `box.w / s` at unscaled sizes and then scales the whole
 * box by `s`. That is arithmetically identical to laying out at width `box.w`
 * with every size multiplied by `s` — which is what this measures, because
 * `linesNeeded` already applies the capacity safety margin to the width it is
 * handed and we want that margin applied to the REAL box.
 */
export const predictedCopyHeight = (args: FitScaleArgs, s: number): number => {
  const { entries, box, scale, metrics, uppercasePaths } = args;
  let total = 0;
  for (const e of entries) {
    const { px, lh } = sizeForPath(e.path, scale);
    const sized = px * s;
    if (!(sized > 0)) continue;
    const text = uppercasePaths?.has(e.path) ? e.text.toUpperCase() : e.text;
    const rows = linesNeeded(text, { w: box.w, h: box.h }, sized, metrics);
    if (!Number.isFinite(rows)) continue;
    total += rows * (lh || DEFAULT_NORMAL_LINE_HEIGHT) * sized;
  }
  return total;
};

/**
 * The shrink-to-fit factor for one text piece: 1 when the copy already fits,
 * otherwise the largest ladder step whose predicted stacked height clears the
 * box's usable height, floored at `FIT_SCALE_FLOOR`.
 */
export const deriveFitScale = (args: FitScaleArgs): number => {
  if (args.entries.length === 0) return 1;
  const usable = usableBox(args.box, args.metrics);
  if (!(usable.h > 0)) return 1;
  for (const s of FIT_LADDER) {
    if (predictedCopyHeight(args, s) <= usable.h) return s;
  }
  return FIT_SCALE_FLOOR;
};
