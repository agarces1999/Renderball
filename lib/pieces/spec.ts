/**
 * PIECE-SPEC v1 (founder: "I like the idea — but how do you avoid all our
 * graphs looking the same? think first"). The variety answer, in four
 * layers, all enforced here:
 *
 * 1. VARIANTS ARE MINED, NOT INVENTED — the enums below are the
 *    morphologies freeform generation actually produced across the stored
 *    corpus (scripts/mine-piece-variants.mjs, 2026-08-20: statTile = 13
 *    distinct shapes over 29 pieces, bulletStack = 14 over 20). The spec
 *    space IS the observed diversity.
 * 2. THE MODEL STILL DESIGNS — a spec is variant + knobs, chosen per
 *    context by the fill agent; the compiler only executes the choice.
 * 3. DECK-TOKEN THEMING — compiled TSX references the scaffold's own
 *    identifiers (FONT_DISPLAY / FONT_BODY / FONT_MONO / PALETTE.*), so
 *    the same variant renders as a different company on a different deck.
 * 4. FREEFORM ESCAPE HATCH — anything outside these classes stays
 *    hand-written TSX; the ceiling never drops.
 *
 * Anti-sameness telemetry lives in compile.ts: variant usage is counted
 * per class, and a >40% dominant share logs a distribution warning (the
 * killed-by-data doctrine: measure sameness, don't assume either way).
 */

/** Observed statTile morphologies (corpus shares in comments). */
export const STAT_TILE_VARIANTS = [
  "plain", // 38% — number + label, no box
  "iconled", // 14% — small icon leads the label
  "boxed", // 7% — soft panel behind
  "boxed-mono", // 7% — panel + mono numerals
  "bordered-boxed", // 7% — hairline panel
  "big-number", // 3%+ — display-scale numeral dominates
] as const;
export type StatTileVariant = (typeof STAT_TILE_VARIANTS)[number];

/** Observed bulletStack morphologies. */
export const BULLET_STACK_VARIANTS = [
  "boxed", // 15% — items in soft panels
  "boxed-ruled", // 10% — panels with a top rule
  "horizontal", // 10% — items in a row
  "mono", // 10% — mono labels, technical register
  "plain", // 5% — bare stack
  "iconled", // 5% — leading glyph per item
] as const;
export type BulletStackVariant = (typeof BULLET_STACK_VARIANTS)[number];

export interface StatTileSpec {
  piece: "statTile";
  variant: StatTileVariant;
  value: string;
  label: string;
  /** Optional secondary line under the label. */
  caption?: string;
  knobs?: {
    /** Accent underline beneath the value (observed knob). */
    underline?: boolean;
    /** Mono numerals regardless of variant. */
    mono?: boolean;
    align?: "start" | "center";
  };
}

export interface BulletStackSpec {
  piece: "bulletStack";
  variant: BulletStackVariant;
  items: { text: string; detail?: string }[];
  knobs?: {
    bordered?: boolean;
    /** Accent marker style before each item. */
    marker?: "dot" | "dash" | "index";
  };
}

export type PieceSpec = StatTileSpec | BulletStackSpec;

export const parsePieceSpec = (raw: unknown): PieceSpec | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.piece === "statTile") {
    if (typeof o.value !== "string" || typeof o.label !== "string") return null;
    const variant = STAT_TILE_VARIANTS.includes(o.variant as StatTileVariant)
      ? (o.variant as StatTileVariant)
      : "plain";
    return { piece: "statTile", variant, value: o.value, label: o.label, caption: typeof o.caption === "string" ? o.caption : undefined, knobs: (o.knobs as StatTileSpec["knobs"]) ?? {} };
  }
  if (o.piece === "bulletStack") {
    if (!Array.isArray(o.items) || o.items.length === 0) return null;
    const items = o.items
      .filter((it): it is { text: string; detail?: string } => !!it && typeof (it as { text?: unknown }).text === "string")
      .slice(0, 6);
    if (items.length === 0) return null;
    const variant = BULLET_STACK_VARIANTS.includes(o.variant as BulletStackVariant)
      ? (o.variant as BulletStackVariant)
      : "plain";
    return { piece: "bulletStack", variant, items, knobs: (o.knobs as BulletStackSpec["knobs"]) ?? {} };
  }
  return null;
};
