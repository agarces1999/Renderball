//
// Arrow-key nudging.
//
// The editor had no keyboard movement at all, which makes precise placement impossible:
// a mouse cannot reliably move something by one pixel, and without snapping (added
// alongside this) it could not reliably move it by exactly the right amount either.
// Every design tool has had this since the 1980s and users reach for it without
// thinking.
//
// Two step sizes, the convention everywhere: a bare arrow moves by one canvas pixel for
// finishing, Shift moves by ten for getting there. Deliberately NOT tied to the zoom —
// a nudge is an edit to the document, and "one pixel" has to mean one document pixel
// however far in the user happens to be, or the same keystroke would produce different
// results on different screens.
//
export interface Nudge {
  dx: number;
  dy: number;
}

export const NUDGE_STEP = 1;
export const NUDGE_STEP_SHIFT = 10;

/**
 * Map a key event to a document offset, or null when the key is not a nudge.
 *
 * Takes the pieces rather than the event so it can be tested without a DOM, and so the
 * caller keeps ownership of the guards that matter (is anything selected, is a text
 * session open, is focus in an input) — those are not this function's business and
 * getting them wrong is how a Backspace deletes an element while someone is typing.
 */
export const nudgeFor = (key: string, shift: boolean): Nudge | null => {
  const step = shift ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  switch (key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 };
    case "ArrowRight":
      return { dx: step, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -step };
    case "ArrowDown":
      return { dx: 0, dy: step };
    default:
      return null;
  }
};

/**
 * Constrain a free drag to whichever axis it has travelled furthest along.
 *
 * Shift-drag, the other half of the convention. Ties go to horizontal only because a
 * tie means the user has moved diagonally by exactly the same amount on both axes,
 * which is vanishingly rare and needs *some* answer.
 */
export const constrainToAxis = (dx: number, dy: number): Nudge =>
  Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
