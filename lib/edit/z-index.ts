//
// ONE definition of "the highest z-index in this scene's sources".
//
// There were two, and they disagreed. `edit-layout` (bring-to-front / send-to-
// back) matched `zIndex:`, `z-index:`, `zIndex={7}`, quoted values and negative
// numbers; `insert-element` matched only `zIndex:` followed by a bare positive
// integer. So a scene whose card writes `zIndex={7}` — perfectly ordinary JSX —
// was invisible to the insert path, which then placed a newly generated element
// at a z BELOW content already on screen: you drew a box over a panel, asked for
// something in it, and the result landed behind the panel.
//
// Read from the SOURCE because this runs server-side during an edit and there is
// no browser, which makes it incomplete by nature: the QA flow found a scene
// whose scan said 5 while the browser computed 20, from a stylesheet rule no
// regex can see. That is why `edit-layout` only ever uses this to RAISE its
// front band rather than to set a layer outright, and why matching a number
// inside a comment or a string is harmless here — the only claim being made is
// "at least this high".
//
/** Every shape generated code writes a stacking value in. */
export const Z_INDEX_IN_BODY = /(?:zIndex|z-index)\s*[:=]\s*["'{\s]*(-?\d+)/g;

/** The highest z-index visible in these piece bodies; 0 when none is found. */
export const highestZIndex = (bodies: string[]): number => {
  let max = 0;
  for (const body of bodies) {
    for (const m of body.matchAll(Z_INDEX_IN_BODY)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
};
