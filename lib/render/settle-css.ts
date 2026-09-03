/**
 * Settle mode — one definition, shared by the server render (scene-iframe)
 * and the editor (ElementEditor), which toggles it inside the LIVE document.
 *
 * Motion doctrine (founder, 2026-09-03: "for launch let's allow motion"):
 * decks move — every page opens with an entrance choreography and a graphic
 * device may carry an ambient loop. Everything that MEASURES a page (layout
 * gates, export, thumbnails, the critic's screenshots) reads its settled end
 * state, which the author contract guarantees equals the designed layout.
 *
 * The !important longhand beats inline shorthand delays: every finite
 * animation jumps to its final frame; infinite loops merely phase-shift and
 * keep looping. Client-safe on purpose — no server imports here.
 */
export const SETTLE_STYLE_ID = "rb-settle";

export const SETTLE_CSS = "*, *::before, *::after { animation-delay: -100000s !important; }";

/**
 * Viewers who asked their OS for less motion get the page at rest: the same
 * jump-to-end as settle mode, plus a single iteration so ambient loops come
 * to rest on their base styles. Injected into every scene document.
 */
export const REDUCED_MOTION_CSS =
  "@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-delay: -100000s !important; animation-iteration-count: 1 !important; transition: none !important; } }";

/** Upper bound on how long the editor waits for a page's entrance before it
 *  settles the live document. The editor awaits only FINITE animations (an
 *  ambient loop never finishes); the cap guards a choreography that runs far
 *  past the contract's 1.5s. */
export const MOTION_SETTLE_CAP_MS = 6000;
