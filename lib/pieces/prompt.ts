/**
 * Fill-prompt addendum for RB_PIECE_SPEC. Generated from the variant enums
 * so prompt and compiler can never disagree on the vocabulary (the
 * unbound_copy lesson: when the prompt, detector, and repair hold different
 * definitions, the difference ships flagged forever).
 */
import { STAT_TILE_VARIANTS, BULLET_STACK_VARIANTS } from "./spec";

export const pieceSpecEnabled = (): boolean =>
  process.env.RB_PIECE_SPEC === "on";

export const PIECE_SPEC_PROMPT = [
  `## Spec pieces (optional shorthand for two common shapes)`,
  `For a PLAIN stat tile or bullet stack — and ONLY those — you may emit a spec marker instead of hand-writing the internals. Inside your own positioned wrapper (you still author position/size/layout), place:`,
  `\`{/* @rb-spec {"piece":"statTile","variant":"iconled","value":"97%","label":"retention"} */}\``,
  `- statTile: { piece:"statTile", variant: ${STAT_TILE_VARIANTS.map((v) => `"${v}"`).join("|")}, value, label, caption?, knobs?: { underline?, mono?, align?: "start"|"center" } }`,
  `- bulletStack: { piece:"bulletStack", variant: ${BULLET_STACK_VARIANTS.map((v) => `"${v}"`).join("|")}, items: [{ text, detail? }] (max 6), knobs?: { bordered?, marker?: "dot"|"dash"|"index" } }`,
  `It compiles to brand-tokened markup at build time. Pick the variant that fits THIS scene's register — do not default to the same variant every time. Values/labels must come verbatim from the copy slots. Everything richer — charts, diagrams, UI mocks, timelines, any composition with a point of view — you hand-write as always; the marker is never a substitute for design.`,
].join("\n");
