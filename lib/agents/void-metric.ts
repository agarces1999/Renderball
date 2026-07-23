/**
 * THE VOID-SIZE METRIC (spatial P3-residual, 2026-07-18) — the largest maximal
 * contiguous UNCLAIMED rectangle inside the title-safe area, as a fraction of
 * that area.
 *
 * WHY THIS AND NOT COVERAGE. "Every region must be claimed" mandates over-fill
 * and is exactly the regression that shipped stark-white debug boxes onto
 * healthy negative space (audit 2). Unclaimed area DEFAULTS to intentional
 * negative space here — the metric says nothing about how much of the frame is
 * empty. It measures only whether the emptiness is CONCENTRATED into one
 * enormous dead hole, which is the "abandoned half" defect. A frame that is 60%
 * air distributed as margins and gutters scores LOW; a frame that is 35% air all
 * pooled in the right half scores HIGH. Coverage cannot tell those apart, which
 * is why coverage was the wrong instrument.
 *
 * WHY IT IS NOT THE REVERTED FILL-FLOOR. The author-time rect-union fill-floor
 * was anti-monotone with pixel truth: a rect's AREA is not the area it paints,
 * so summing authored areas could rise while painted ink fell. This metric has
 * the opposite failure direction, and structurally so. Elements are mounted into
 * their authored rect, so
 *
 *     painted pixels ⊆ authored rect
 *
 * for every element. Therefore the unclaimed region computed from authored rects
 * is a SUBSET of the genuinely unpainted region, and
 *
 *     largestVoid(authored) ≤ largestVoid(painted).
 *
 * The metric can only ever UNDER-report a void. It cannot manufacture one. A
 * fired gate is therefore always a real hole (a true positive by construction);
 * what it can do is miss a hole hidden inside a mostly-empty authored rect. That
 * one-sidedness is what makes it safe to run at author time, and it is the exact
 * property the fill-floor lacked.
 *
 * Pure. No I/O, no env, no SDK — the same leaf posture as layout-composer.
 */

export type Aspect = "16:9" | "9:16" | "1:1";

export interface VoidRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * SMPTE title-safe: a 5% inset per side, the same rects the containment contract
 * uses for text. Mirrored (not imported) to keep this a dependency-free leaf.
 */
export const SAFE: Record<Aspect, VoidRect> = {
  "16:9": { x: 96, y: 54, w: 1728, h: 972 },
  "9:16": { x: 54, y: 96, w: 972, h: 1728 },
  "1:1": { x: 54, y: 54, w: 972, h: 972 },
};

/**
 * Square lattice cell, px. 1728/32 = 972/18 = 54 — cells are SQUARE on every
 * aspect, so a void's cell extent reads as a literal aspect ratio.
 *
 * 54 specifically (rather than something finer) so this metric's numbers are
 * DIRECTLY COMPARABLE to the P2 bake-off's published void column (arm A 16.8% /
 * B 22.1% / C 17.5%), which was measured on this exact lattice. A calibrated
 * threshold is only useful next to the distribution it was calibrated against.
 */
export const CELL = 54;

export const GRID: Record<Aspect, { cols: number; rows: number }> = {
  "16:9": { cols: 32, rows: 18 },
  "9:16": { cols: 18, rows: 32 },
  "1:1": { cols: 18, rows: 18 },
};

/**
 * The largest all-free axis-aligned rectangle in a binary occupancy matrix, in
 * CELLS. Lifted verbatim from the P2 bake-off's `largestVoidCells`
 * (lib/agents/grid-intent.ts) — the algorithm was written and exercised there
 * and there is no reason to re-derive it.
 *
 * Standard maximal-rectangle-in-a-binary-matrix: walk rows keeping a histogram
 * of consecutive free cells per column, and for each row solve
 * largest-rectangle-in-histogram with a monotonic stack. O(cols·rows).
 *
 * `outRect`, when supplied, receives the winning rectangle in CELL coordinates —
 * the gate quotes it to the head, and "there is a dead 14×11 block at column 18"
 * is a far more actionable repair instruction than a bare percentage.
 */
export const largestVoidCells = (
  occupied: boolean[][],
  cols: number,
  rows: number,
  outRect?: { c0: number; r0: number; c1: number; r1: number },
): number => {
  const heights = new Array<number>(cols).fill(0);
  let best = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[c] = occupied[r][c] ? 0 : heights[c] + 1;
    }
    // Largest rectangle in this row's histogram, monotonic-stack sweep. The
    // sentinel pass (i === cols) drains whatever is left on the stack.
    const stack: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const h = i === cols ? 0 : heights[i];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const left = stack.length === 0 ? -1 : stack[stack.length - 1];
        const height = heights[top];
        const width = i - left - 1;
        const areaCells = height * width;
        if (areaCells > best) {
          best = areaCells;
          if (outRect) {
            outRect.c0 = left + 1;
            outRect.c1 = i - 1;
            outRect.r0 = r - height + 1;
            outRect.r1 = r;
          }
        }
      }
      stack.push(i);
    }
  }
  return best;
};

export interface VoidMeasurement {
  /** Largest maximal contiguous unclaimed rectangle ÷ title-safe area. */
  fraction: number;
  /** That rectangle in canvas pixels — what the repair instruction quotes. */
  rect: VoidRect;
  /** Its extent in lattice cells, for the human-readable message. */
  cells: { cols: number; rows: number };
}

/**
 * Rasterize a set of CLAIMED rectangles onto the title-safe lattice and measure
 * the largest void.
 *
 * A cell counts as CLAIMED when its CENTRE falls inside any claimed rect —
 * deterministic and cheap. Callers pass the plan's content slots and EXCLUDE
 * atmosphere: the full-bleed base layer covers every cell and would drive every
 * void to zero, measuring nothing. The chrome bar IS included — it is real
 * painted mass, and the strip it occupies is genuinely not abandoned.
 */
export const measureVoid = (rects: VoidRect[], aspect: Aspect): VoidMeasurement => {
  const { cols, rows } = GRID[aspect];
  const safe = SAFE[aspect];
  const occupied: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));

  for (let r = 0; r < rows; r++) {
    const cy = safe.y + r * CELL + CELL / 2;
    for (let c = 0; c < cols; c++) {
      const cx = safe.x + c * CELL + CELL / 2;
      for (const rect of rects) {
        if (cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h) {
          occupied[r][c] = true;
          break;
        }
      }
    }
  }

  const box = { c0: 0, r0: 0, c1: -1, r1: -1 };
  const cells = largestVoidCells(occupied, cols, rows, box);
  const cw = box.c1 - box.c0 + 1;
  const ch = box.r1 - box.r0 + 1;
  return {
    fraction: cells / (cols * rows),
    rect:
      cells > 0
        ? { x: safe.x + box.c0 * CELL, y: safe.y + box.r0 * CELL, w: cw * CELL, h: ch * CELL }
        : { x: 0, y: 0, w: 0, h: 0 },
    cells: cells > 0 ? { cols: cw, rows: ch } : { cols: 0, rows: 0 },
  };
};
