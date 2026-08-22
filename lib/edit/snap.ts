//
// Snapping, and the guides that explain it.
//
// The editor had none. Measured 2026-08-22: one stray `snapped` identifier in
// ElementEditor and nothing behind it — every drag landed wherever the pointer stopped,
// so alignment was down to eyesight and 1px nudges nobody had either. It is the single
// largest gap between this editor and one that feels professional, and it is the
// cheapest to close, because snapping is arithmetic.
//
// WHAT IT SNAPS TO, in the order a designer expects:
//   * a sibling's edges and centre — aligning to your own content matters most;
//   * the canvas edges, centre, and thirds — the page's own structure;
// with sibling targets preferred when both are in range, because "line this up with
// that" is the intent nine times in ten.
//
// WHAT MAKES IT TOLERABLE RATHER THAN INFURIATING (Canva's lesson, from the research):
// a modifier that turns it off. Snapping you cannot escape is worse than none — the
// one position you want is always the one it refuses to give you. The caller passes
// `bypass` (Cmd/Ctrl held) and gets the raw position back, guides and all suppressed.
//
// THRESHOLD IS IN SCREEN PIXELS, converted by the caller. A fixed canvas-pixel
// threshold would feel sticky when zoomed out and useless when zoomed in; the pull
// should feel the same under the hand at any zoom.
//
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line to draw while a snap is active. Canvas coordinates. */
export interface Guide {
  /** "x" is a VERTICAL line at this x; "y" is a HORIZONTAL line at this y. */
  axis: "x" | "y";
  at: number;
  /** Extent of the line along the other axis, so it spans only what it relates. */
  from: number;
  to: number;
  /** What produced it — for styling (a sibling guide reads differently to a page one). */
  source: "sibling" | "canvas";
}

export interface SnapResult {
  x: number;
  y: number;
  guides: Guide[];
  /** True when either axis moved. Callers use it to avoid redundant work. */
  snapped: boolean;
}

export interface SnapOptions {
  /** Pull distance in CANVAS px — the caller divides its screen threshold by the zoom. */
  threshold?: number;
  /** Cmd/Ctrl held: return the raw position and no guides. */
  bypass?: boolean;
}

export const DEFAULT_SNAP_THRESHOLD = 8;

interface Candidate {
  /** Where the moving box's ORIGIN would land if this candidate wins. */
  origin: number;
  /** The coordinate the guide is drawn at. */
  at: number;
  distance: number;
  source: "sibling" | "canvas";
  /** Extent of the guide along the perpendicular axis. */
  from: number;
  to: number;
}

const best = (cands: Candidate[], threshold: number): Candidate | null => {
  let winner: Candidate | null = null;
  for (const c of cands) {
    if (c.distance > threshold) continue;
    // Ties go to a sibling: aligning to your own content beats aligning to the page.
    if (
      !winner ||
      c.distance < winner.distance - 1e-9 ||
      (Math.abs(c.distance - winner.distance) <= 1e-9 && c.source === "sibling" && winner.source === "canvas")
    ) {
      winner = c;
    }
  }
  return winner;
};

/**
 * Snap `moving` against `others` and the canvas.
 *
 * Each axis is decided independently — a box can align its left edge to a sibling
 * while its vertical centre meets the page's, and both guides show. Returns the
 * position to use and the guides to draw.
 */
export const snapBox = (
  moving: Box,
  others: readonly Box[],
  canvas: { w: number; h: number },
  opts: SnapOptions = {},
): SnapResult => {
  const threshold = opts.threshold ?? DEFAULT_SNAP_THRESHOLD;
  if (opts.bypass || threshold <= 0) {
    return { x: moving.x, y: moving.y, guides: [], snapped: false };
  }

  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w]; // left, centre, right
  const my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h]; // top, middle, bottom

  const xc: Candidate[] = [];
  const yc: Candidate[] = [];

  const pushX = (target: number, source: "sibling" | "canvas", from: number, to: number) => {
    mx.forEach((edge, i) => {
      // origin = where moving.x ends up so that THIS edge sits on the target
      const origin = target - (i === 0 ? 0 : i === 1 ? moving.w / 2 : moving.w);
      xc.push({ origin, at: target, distance: Math.abs(edge - target), source, from, to });
    });
  };
  const pushY = (target: number, source: "sibling" | "canvas", from: number, to: number) => {
    my.forEach((edge, i) => {
      const origin = target - (i === 0 ? 0 : i === 1 ? moving.h / 2 : moving.h);
      yc.push({ origin, at: target, distance: Math.abs(edge - target), source, from, to });
    });
  };

  for (const o of others) {
    // A guide between two boxes spans both, so it visibly connects them.
    const spanY = { from: Math.min(moving.y, o.y), to: Math.max(moving.y + moving.h, o.y + o.h) };
    const spanX = { from: Math.min(moving.x, o.x), to: Math.max(moving.x + moving.w, o.x + o.w) };
    for (const t of [o.x, o.x + o.w / 2, o.x + o.w]) pushX(t, "sibling", spanY.from, spanY.to);
    for (const t of [o.y, o.y + o.h / 2, o.y + o.h]) pushY(t, "sibling", spanX.from, spanX.to);
  }

  // The page's own structure. Thirds are included because decks are built on them and
  // a box that lands on one reads as deliberate.
  for (const t of [0, canvas.w / 3, canvas.w / 2, (canvas.w * 2) / 3, canvas.w]) {
    pushX(t, "canvas", 0, canvas.h);
  }
  for (const t of [0, canvas.h / 3, canvas.h / 2, (canvas.h * 2) / 3, canvas.h]) {
    pushY(t, "canvas", 0, canvas.w);
  }

  const wx = best(xc, threshold);
  const wy = best(yc, threshold);
  const guides: Guide[] = [];
  if (wx) guides.push({ axis: "x", at: wx.at, from: wx.from, to: wx.to, source: wx.source });
  if (wy) guides.push({ axis: "y", at: wy.at, from: wy.from, to: wy.to, source: wy.source });

  return {
    x: wx ? wx.origin : moving.x,
    y: wy ? wy.origin : moving.y,
    guides,
    snapped: !!(wx || wy),
  };
};
