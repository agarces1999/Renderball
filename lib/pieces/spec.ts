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

/**
 * Observed statTile morphologies. v2 menu (founder: "at least 20 per
 * type") — every variant anchors to a feature the miner counted on real
 * corpus pieces (carriage n in comments; miner v2, 355 classified pieces).
 */
export const STAT_TILE_VARIANTS = [
  "plain", // bare value + label
  "eyebrow", // letterSpaced uppercase label above the value (n=26)
  "captioned", // value + label + secondary caption line (n=22)
  "big-number", // display-scale numeral dominates (n=21)
  "boxed", // soft panel behind (n=20)
  "boxed-mono", // panel + mono numerals (n=17)
  "shadow-card", // lifted card with shadow (n=10)
  "delta-up", // trend arrow + delta chip beside the value (n=8)
  "bordered-boxed", // hairline panel (n=7)
  "pill-label", // label set in a pill badge (n=6)
  "iconled", // small icon chip leads (n=4)
  "split-tone", // value split across two tones (n=3)
  "ruled-top", // accent rule above (n=3)
  "underline", // accent underline beneath the value (n=2)
  "inverse-panel", // ink-dark panel, light text (n=1)
  "dashed-frame", // dashed hairline frame (n=1)
  "ghost-number", // huge low-opacity numeral behind the label (n=1)
  "spark-adjacent", // mini sparkline beside the value (sparkline n=15)
  "gradient-panel", // soft gradient panel (gradientPanel n=80 corpus-wide)
  "framed-hairline", // 1px frame, no fill (framedHairline class)
  "index-chip", // small mono 01-index chip (indexNumbered n=4)
  "arrow-cta", // ArrowUpRight corner affordance (arrowLed n=8)
] as const;
export type StatTileVariant = (typeof STAT_TILE_VARIANTS)[number];

/** Observed bulletStack morphologies (miner v2 carriage n in comments). */
export const BULLET_STACK_VARIANTS = [
  "plain", // bare stack
  "dot", // dot markers (n=4)
  "dash", // dash markers (n=1)
  "mono", // mono labels, index-led technical register (mono n=169)
  "check", // check glyphs lead (checkLed n=27)
  "arrow", // arrow glyphs lead (arrowLed n=14)
  "iconled", // icon chips lead (iconled n=30)
  "boxed", // items in soft panels (boxed n=270)
  "boxed-ruled", // panels with an accent top rule (ruledTop n=82)
  "bordered", // hairline panels (borderedBox n=155)
  "shadow-cards", // lifted cards (shadowCard n=163)
  "inverse-panels", // ink-dark item panels (inversePanel n=34)
  "gradient-panel", // one gradient panel wraps the stack (n=80)
  "dashed-frame", // dashed hairline item frames (dashed n=10)
  "pill-lead", // pill badge leads each item (pillBadge n=38)
  "eyebrow-items", // letterSpaced uppercase item leads (letterSpaced n=207)
  "ruled-rows", // hairline rules BETWEEN rows
  "horizontal", // items in a row (n=7)
  "grid", // two-column grid (grid n=37)
  "timeline", // vertical connector + nodes (timeline class)
  "steps", // numbered circles with connector (indexNumbered + timeline)
  "split-lead", // first word of each item in accent tone (splitTone n=57)
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
    /** Delta chip copy for delta-up (must come from the script's numbers). */
    delta?: string;
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
    // Witness build 2 (2026-08-20): the model emitted value:"PLACEHOLDER"
    // for a scene whose headline held the real number ("12"). A filler
    // value must never compile — rejecting here leaves the marker as an
    // invisible comment, so the density/bind gates see the missing mount
    // and route a freeform repair instead of shipping a fabricated stat.
    if (/^(placeholder|tbd|todo|n\/?a|xx+|lorem.*|value|number|123)$/i.test(o.value.trim())) return null;
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
