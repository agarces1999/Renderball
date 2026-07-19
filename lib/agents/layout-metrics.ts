/**
 * LAYOUT METRICS (allocator dry-run, 2026-07-19) — the four numbers the
 * head-vs-allocator comparison is scored on. Pure, no I/O, canvas-agnostic.
 *
 * Deliberately a SEPARATE leaf from `allocate-layout.ts`: the allocator must not
 * be able to optimise against its own scorer by sharing state with it, and the
 * head's stored bounds must be scored by exactly the same code path as the
 * allocator's. Both sides go through `scoreLayout` and nothing else.
 *
 * On the void metric specifically — coverage is the WRONG instrument and was
 * tried and reverted (it mandates over-fill and shipped white debug boxes onto
 * healthy negative space). Unclaimed area defaults to intentional negative
 * space here; the metric asks only whether the emptiness is CONCENTRATED into
 * one abandoned block. A frame that is 60% air spread as margins scores LOW; a
 * frame that is 35% air pooled in one half scores HIGH.
 */

export type Aspect = "16:9" | "9:16" | "1:1";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CANVAS: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/** SMPTE title-safe — the frame the metrics are computed over. */
export const SAFE: Record<Aspect, Rect> = {
  "16:9": { x: 96, y: 54, w: 1728, h: 972 },
  "9:16": { x: 54, y: 96, w: 972, h: 1728 },
  "1:1": { x: 54, y: 54, w: 972, h: 972 },
};

/** 54px square lattice: 1728/32 = 972/18 = 54, so a void's cell extent reads as
 *  a literal aspect ratio, and the numbers stay directly comparable to the P2
 *  bake-off's published void column (arm A 16.8% / B 22.1% / C 17.5%), which was
 *  measured on this exact lattice. */
export const CELL = 54;

export interface ScoredElement {
  id: string;
  role: string;
  focalRank?: number | null;
  bounds: Rect;
  /** Ids this element may intentionally overlap. */
  allowedOverlaps?: string[];
  /** Excluded from every metric: the full-bleed base layer and the chrome bar
   *  are not compositional mass. */
  excluded?: boolean;
}

export interface LayoutScore {
  /** Largest maximal contiguous unclaimed rectangle ÷ title-safe area (0..1). */
  largestVoid: number;
  /** That rectangle, in canvas px — drawn on the dry-run panels. */
  voidRect: Rect | null;
  /** True when the focalRank-1 element holds the largest area. Null when the
   *  layout declares no rank-1 element at all (which is itself a finding). */
  focalIsLargest: boolean | null;
  /** area(rank1) ÷ area(next largest). >1 means the focal genuinely dominates.
   *  Null when there is no rank-1 element or no competitor. */
  focalMargin: number | null;
  /** Area-weighted ink centroid's distance from the frame centre, as a fraction
   *  of the frame's half-diagonal. The "everything is clustered in one band"
   *  signal — 0 is perfectly balanced. */
  centroidOffset: number;
  /** Signed components (fraction of half-width / half-height), so the direction
   *  of the imbalance is legible, not just its size. */
  centroidDx: number;
  centroidDy: number;
  /** Pairs that overlap with no declared allowance. */
  overlaps: number;
  /**
   * The same count, minus the ONE class the 2026-07-18 throughline work proved
   * is usually DELIBERATE: a throughline motif fully CONTAINED in another
   * element ("the spinning Pending status ring embedded in the card
   * mid-section"). The schema has no way for the head to declare that, so
   * scoring it as a defect makes the head look broken for composing well. 71 of
   * the 95 stored hero+motif scenes are this shape. Report both numbers.
   */
  overlapsExEmbedded: number;
  /**
   * How many elements were dropped from scoring for being canvas treatments
   * (≥85% of the frame). NON-ZERO MEANS THE VOID AND CENTROID NUMBERS FOR THIS
   * SCENE ARE ARTEFACTS: with the treatment excluded, only the small overlaid
   * insets remain, so a perfectly composed full-bleed frame reports a huge void.
   * Aggregate over these scenes separately or not at all.
   */
  canvasTreatments: number;
  /** Sum of element areas ÷ safe area. Reported for context ONLY — it is
   *  explicitly NOT a target (see the module note on coverage). */
  coverage: number;
  /** How many elements were actually scored. */
  counted: number;
}

const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

/** A near-full-canvas rect is a canvas TREATMENT, not placeable mass: counting
 *  it would drive every void to zero and every centroid to centre, measuring
 *  nothing. Same 85% threshold layout-composer uses for `isFullBleedRect`. */
export const isCanvasTreatment = (r: Rect, aspect: Aspect): boolean => {
  const { w: W, h: H } = CANVAS[aspect];
  return area(r) >= 0.85 * W * H;
};

/**
 * Largest all-free axis-aligned rectangle in a binary occupancy matrix, in
 * cells. Standard maximal-rectangle sweep: per-row histogram of consecutive
 * free cells + a monotonic stack solving largest-rectangle-in-histogram.
 * O(cols·rows).
 */
export const largestVoidCells = (
  occupied: boolean[][],
  cols: number,
  rows: number,
  out?: { c0: number; r0: number; c1: number; r1: number },
): number => {
  const heights = new Array<number>(cols).fill(0);
  let best = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = occupied[r][c] ? 0 : heights[c] + 1;
    const stack: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const h = i === cols ? 0 : heights[i];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const left = stack.length === 0 ? -1 : stack[stack.length - 1];
        const a = heights[top] * (i - left - 1);
        if (a > best) {
          best = a;
          if (out) {
            out.c0 = left + 1;
            out.c1 = i - 1;
            out.r0 = r - heights[top] + 1;
            out.r1 = r;
          }
        }
      }
      stack.push(i);
    }
  }
  return best;
};

/**
 * Score one layout. `elements` may come from the head's stored composition or
 * from the allocator — the caller normalises both into ScoredElement, and this
 * function is the ONLY scorer, so the two sides can never be measured
 * differently.
 */
export const scoreLayout = (elements: ScoredElement[], aspect: Aspect): LayoutScore => {
  const safe = SAFE[aspect];
  const cols = Math.round(safe.w / CELL);
  const rows = Math.round(safe.h / CELL);

  const scored = elements.filter(
    (e) => !e.excluded && e.bounds && e.bounds.w > 0 && e.bounds.h > 0 && !isCanvasTreatment(e.bounds, aspect),
  );

  // ── Void ────────────────────────────────────────────────────────────────
  const occupied: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array<boolean>(cols).fill(false);
    const cy = safe.y + r * CELL + CELL / 2;
    for (let c = 0; c < cols; c++) {
      const cx = safe.x + c * CELL + CELL / 2;
      for (const e of scored) {
        const b = e.bounds;
        if (cx >= b.x && cx < b.x + b.w && cy >= b.y && cy < b.y + b.h) {
          row[c] = true;
          break;
        }
      }
    }
    occupied.push(row);
  }
  const box = { c0: 0, r0: 0, c1: -1, r1: -1 };
  const voidCells = largestVoidCells(occupied, cols, rows, box);
  const voidRect =
    voidCells > 0
      ? {
          x: safe.x + box.c0 * CELL,
          y: safe.y + box.r0 * CELL,
          w: (box.c1 - box.c0 + 1) * CELL,
          h: (box.r1 - box.r0 + 1) * CELL,
        }
      : null;

  // ── Focal dominance ─────────────────────────────────────────────────────
  const rank1 = scored.find((e) => e.focalRank === 1) ?? null;
  let focalIsLargest: boolean | null = null;
  let focalMargin: number | null = null;
  if (rank1) {
    const others = scored.filter((e) => e !== rank1);
    const maxOther = others.reduce((m, e) => Math.max(m, area(e.bounds)), 0);
    focalIsLargest = others.length === 0 ? true : area(rank1.bounds) >= maxOther;
    focalMargin = maxOther > 0 ? area(rank1.bounds) / maxOther : null;
  }

  // ── Ink centroid ────────────────────────────────────────────────────────
  const totalArea = scored.reduce((s, e) => s + area(e.bounds), 0);
  const cxFrame = safe.x + safe.w / 2;
  const cyFrame = safe.y + safe.h / 2;
  let cx = cxFrame;
  let cy = cyFrame;
  if (totalArea > 0) {
    cx = scored.reduce((s, e) => s + (e.bounds.x + e.bounds.w / 2) * area(e.bounds), 0) / totalArea;
    cy = scored.reduce((s, e) => s + (e.bounds.y + e.bounds.h / 2) * area(e.bounds), 0) / totalArea;
  }
  const dx = (cx - cxFrame) / (safe.w / 2);
  const dy = (cy - cyFrame) / (safe.h / 2);
  const centroidOffset = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;

  // ── Undeclared overlaps ─────────────────────────────────────────────────
  const contains = (outer: Rect, inner: Rect): boolean =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  let overlaps = 0;
  let overlapsExEmbedded = 0;
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const a = scored[i];
      const b = scored[j];
      if (!rectsOverlap(a.bounds, b.bounds)) continue;
      if ((a.allowedOverlaps ?? []).includes(b.id) || (b.allowedOverlaps ?? []).includes(a.id)) continue;
      overlaps++;
      const embedded =
        (a.role === "throughline" && contains(b.bounds, a.bounds)) ||
        (b.role === "throughline" && contains(a.bounds, b.bounds));
      if (!embedded) overlapsExEmbedded++;
    }
  }

  return {
    largestVoid: voidCells / (cols * rows),
    voidRect,
    focalIsLargest,
    focalMargin,
    centroidOffset,
    centroidDx: dx,
    centroidDy: dy,
    overlaps,
    overlapsExEmbedded,
    canvasTreatments: elements.filter((e) => !e.excluded && e.bounds && isCanvasTreatment(e.bounds, aspect)).length,
    coverage: Math.min(1, totalArea / (safe.w * safe.h)),
    counted: scored.length,
  };
};
