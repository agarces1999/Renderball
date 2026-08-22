//
// Where a toolbar insert lands when the user did not draw a box.
//
// The centred default was returned verbatim, so every insert landed on the same pixel.
// The founder's deck (2026-08-22) holds four of them — s0.add2 through s0.add5, all at
// `left: 576, top: 454, width: 768` exactly — stacked so precisely that only the last
// was visible or selectable. Adding a second text box looked like adding nothing at
// all, and the four boxes underneath were unreachable without deleting the top one.
//
// Every design tool solves this the same way and users already expect it: offset each
// new item down-right from whatever is already there.
//
// The occupancy list comes from the LIVE document, not a client-side counter. A
// counter resets on reload and starts stacking again from zero; measured rectangles
// pick up wherever the page actually is.
//
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas px between successive inserts: clearly separate, still obviously related. */
export const CASCADE_STEP = 40;
/** Two boxes are "the same place" within this many px on BOTH axes. */
export const CASCADE_SAME_PX = 12;
/** Give up cascading after this many tries and reuse the base. */
export const CASCADE_MAX_TRIES = 10;

/**
 * First free offset of `base`, stepping down-right past anything already occupying
 * that spot.
 *
 * Returns `base` unchanged when nothing is in the way, when every candidate is taken,
 * or when the next step would push the box past the canvas edge — a partly off-slide
 * insert is a worse outcome than a stacked one, so the cascade stops at the boundary
 * rather than walking off it.
 */
export const cascadeBox = (
  base: Box,
  taken: readonly Box[],
  canvas: { w: number; h: number },
  opts: { step?: number; samePx?: number; maxTries?: number } = {},
): Box => {
  const step = opts.step ?? CASCADE_STEP;
  const samePx = opts.samePx ?? CASCADE_SAME_PX;
  const tries = opts.maxTries ?? CASCADE_MAX_TRIES;
  for (let i = 0; i < tries; i++) {
    const cand: Box = { ...base, x: base.x + i * step, y: base.y + i * step };
    if (cand.x + base.w > canvas.w || cand.y + base.h > canvas.h) break;
    const collides = taken.some(
      (t) => Math.abs(t.x - cand.x) < samePx && Math.abs(t.y - cand.y) < samePx,
    );
    if (!collides) return cand;
  }
  return base;
};
