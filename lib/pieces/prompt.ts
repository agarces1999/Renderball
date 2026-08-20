/**
 * Fill-prompt addendum for RB_PIECE_SPEC. Generated from the variant enums
 * so prompt and compiler can never disagree on the vocabulary (the
 * unbound_copy lesson: when the prompt, detector, and repair hold different
 * definitions, the difference ships flagged forever).
 */
import { STAT_TILE_VARIANTS, BULLET_STACK_VARIANTS } from "./spec";

/**
 * ON BY DEFAULT since the founder's specimen approval (2026-08-20, 88-card
 * gallery verdict: "good to go"). RB_PIECE_SPEC=off is the kill switch.
 */
export const pieceSpecEnabled = (): boolean =>
  process.env.RB_PIECE_SPEC !== "off";

export const PIECE_SPEC_PROMPT = [
  `## Spec pieces (REQUIRED for two shapes)`,
  // Witness build 2026-08-20: as an optional shorthand ("you may"), adoption
  // was ZERO across a whole deck — the surrounding prompt demands hand-
  // crafted richness everywhere, and an optional escape loses to that. For
  // the two shapes the spec covers, the marker is now the stated default;
  // freeform remains for anything richer.
  `Whenever this scene needs a stat tile (a number/metric + label) or a simple bullet/point stack, EMIT A SPEC MARKER for it — do not hand-write those two shapes unless they need something no variant+knobs can express (then hand-write and keep it rich). Inside your own positioned wrapper (you still author position/size/layout), place:`,
  `\`{/* @rb-spec {"piece":"statTile","variant":"iconled","value":"97%","label":"retention"} */}\``,
  `- statTile: { piece:"statTile", variant: ${STAT_TILE_VARIANTS.map((v) => `"${v}"`).join("|")}, value, label, caption?, knobs?: { underline?, mono?, align?: "start"|"center" } }`,
  `- bulletStack: { piece:"bulletStack", variant: ${BULLET_STACK_VARIANTS.map((v) => `"${v}"`).join("|")}, items: [{ text, detail? }] (max 6), knobs?: { bordered?, marker?: "dot"|"dash"|"index" } }`,
  `It compiles to brand-tokened markup at build time. Pick the variant that fits THIS scene's register — do not default to the same variant every time; vary variants across the deck's scenes. The value MUST be copied verbatim from this scene's copy slots (headline, meta values, bullets — e.g. if the headline is the number, value = that exact string); never write a filler like PLACEHOLDER — if no real number exists in the slots, do not emit a statTile at all. Everything richer — charts, diagrams, UI mocks, timelines, any composition with a point of view — you hand-write as always.`,
].join("\n");
