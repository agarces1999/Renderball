/**
 * The founder's rubric (RB_CRITIC_RUBRIC=founder; 10x program 2026-09-04;
 * default OFF = today's generic "judge against intent for an executive
 * audience").
 *
 * Written from his recorded blind verdicts, in his order of weight:
 *   - "version A is better, it uses space better. version B shows a bunch
 *     of blank spaces" (ab6) — occupancy is a first-class criterion.
 *   - "A more ambitious but B made less mistakes" (ab5, no winner) — a
 *     mistake cancels ambition; ambition alone does not win.
 *   - "really a lot better" (ab7 B) — the device and composition, not polish.
 *   - the locked accent must lead; real fonts; the real logo (Fuse, Zoom,
 *     Deel incidents).
 * Measured before wiring: on 7 pairs he graded, the generic prompt agreed
 * 3/5 (Kimi) and 4/5 (Qwen). This rubric is re-measured on the same pairs.
 */
export const founderRubricEnabled = (): boolean => (process.env.RB_CRITIC_RUBRIC ?? "off") === "founder";

export const FOUNDER_RUBRIC = `Grade the way this studio's founder grades, in this order of weight:
1. MISTAKES first — any collision or overlap of elements, clipped or cut-off text, text over a busy background, an element hanging off the canvas, a large empty region (a blank half or quarter of the canvas), misaligned or missing chrome, an off-brand color. One clear mistake outweighs any amount of ambition.
2. OCCUPANCY — the composition uses the whole 1920x1080 canvas with intent: full-bleed, deliberate asymmetry, generous but purposeful space. "A bunch of blank space" loses.
3. AMBITION OF THE DEVICE — one purposeful graphic device that expresses THIS page's idea (a diagram born from the meaning), not generic decoration and not a bullet wall. Bolder wins when it is clean.
4. BRAND FIDELITY — the brand's accent leads, its real type and logo are used, the page looks like the brand's own material rather than a template.
5. HIERARCHY — one strong headline, controlled secondary text, monospace kickers/labels, legible at presentation distance.
Motion is judged only by its settled end state (the frame you see).`;

/** Per-page critic prompt (ship / weakness JSON), rubric-led. */
export const founderCriticPrompt = (intent: string): string =>
  `${FOUNDER_RUBRIC}\n\nThis slide was authored for the intent: "${intent}". Apply the rubric. If it has a clear mistake (rule 1) or a large empty region (rule 2) it does not ship. Reply ONLY JSON: {"ship": true|false, "weakness": "<the single most important thing to fix, in one specific sentence naming the element — or null>"}`;

/** Pairwise judge prompt (FIRST vs SECOND), rubric-led. */
export const founderPairwisePrompt = (intent: string): string =>
  `${FOUNDER_RUBRIC}\n\nTwo versions of one slide (FIRST then SECOND), intent: "${intent}". Apply the rubric in order: the version with a clear mistake loses; then the version that uses the canvas better wins; then the bolder, cleaner device; then brand fidelity. Reply ONLY JSON: {"winner":"FIRST"|"SECOND"}`;
