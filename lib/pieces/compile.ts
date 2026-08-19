/**
 * Deterministic compiler for PieceSpec → TSX fragment (see spec.ts for the
 * variety doctrine). Two hard rules:
 *
 * - LAYOUT STAYS WITH THE MODEL. Compiled output is an UNPOSITIONED content
 *   block; the fill agent authors the absolutely-positioned wrapper around
 *   the marker, exactly as it does for freeform pieces. The spec only
 *   standardizes the part that was error-prone (internal typography/box
 *   anatomy), never the composition.
 * - TOKENS ARE RESOLVED, NEVER ASSUMED. Corpus tally (2026-08-20): PALETTE
 *   key names vary deck to deck (accent 101/148, ink 91, canvas 62, bg 21…).
 *   resolveDeckTokens() reads the actual scaffold and returns expression
 *   strings that verifiably exist in scope, falling back to translucent
 *   neutrals that render on any background. A compiled piece must never
 *   reference an identifier the deck doesn't declare.
 */
import type { PieceSpec, StatTileSpec, BulletStackSpec } from "./spec";

export interface DeckTokens {
  /** Each value is a TSX EXPRESSION string spliced into the output. */
  fontDisplay: string;
  fontBody: string;
  fontMono: string;
  accent: string;
  ink: string;
  /** Soft panel fill — translucent so it reads on any background. */
  surface: string;
  /** Hairline color for rules/borders. */
  line: string;
}

const NEUTRAL: DeckTokens = {
  fontDisplay: `"inherit"`,
  fontBody: `"inherit"`,
  fontMono: `'"SF Mono", Menlo, Consolas, monospace'`,
  accent: `"currentColor"`,
  ink: `"currentColor"`,
  surface: `"rgba(127,127,127,0.12)"`,
  line: `"rgba(127,127,127,0.28)"`,
};

const declares = (code: string, ident: string): boolean =>
  new RegExp(`\\bconst\\s+${ident}\\s*=`).test(code);

const paletteKey = (code: string, key: string): boolean => {
  const m = code.match(/const PALETTE\s*=\s*\{([\s\S]*?)\}/);
  // Keys appear after "{" or "," — corpus PALETTEs are written both
  // multi-line and single-line, so never anchor on line starts.
  return !!m && new RegExp(`[{,\\s]${key}\\s*:`).test(`{${m[1]}`);
};

/** Derive splice-safe token expressions from a deck's composition source. */
export const resolveDeckTokens = (code: string): DeckTokens => {
  const font = (name: string, fallback: string): string =>
    declares(code, name) ? name : fallback;
  const color = (key: string, alias: string, fallback: string): string =>
    paletteKey(code, key) ? `PALETTE.${key}` : declares(code, alias) ? alias : fallback;
  const fontBody = font("FONT_BODY", NEUTRAL.fontBody);
  return {
    fontDisplay: font("FONT_DISPLAY", fontBody),
    fontBody,
    fontMono: font("FONT_MONO", NEUTRAL.fontMono),
    accent: color("accent", "BRAND_ACCENT", NEUTRAL.accent),
    ink: color("ink", "BRAND_INK", NEUTRAL.ink),
    surface: paletteKey(code, "surface") ? "PALETTE.surface" : NEUTRAL.surface,
    line: paletteKey(code, "line")
      ? "PALETTE.line"
      : paletteKey(code, "hairline")
        ? "PALETTE.hairline"
        : NEUTRAL.line,
  };
};

const jsStr = (s: string): string => JSON.stringify(s);

const statTile = (s: StatTileSpec, t: DeckTokens): string => {
  const k = s.knobs ?? {};
  const boxed = s.variant === "boxed" || s.variant === "boxed-mono" || s.variant === "bordered-boxed";
  const mono = k.mono || s.variant === "boxed-mono";
  const big = s.variant === "big-number";
  const align = k.align ?? "start";
  const valueFont = mono ? t.fontMono : t.fontDisplay;
  const box = boxed
    ? `background: ${t.surface}, borderRadius: 14, padding: "20px 24px", ${
        s.variant === "bordered-boxed" ? `border: \`1px solid \${${t.line}}\`, ` : ""
      }`
    : "";
  const icon =
    s.variant === "iconled"
      ? `<span style={{ display: "inline-flex", width: 34, height: 34, borderRadius: 10, background: ${t.surface}, color: ${t.accent}, alignItems: "center", justifyContent: "center", marginBottom: 12 }}><TrendingUp size={18} /></span>\n      `
      : "";
  const underline = k.underline
    ? `\n      <div style={{ width: 44, height: 3, background: ${t.accent}, borderRadius: 2, margin: ${align === "center" ? `"10px auto 0"` : `"10px 0 0"`} }} />`
    : "";
  return `<div style={{ display: "flex", flexDirection: "column", alignItems: "${align === "center" ? "center" : "flex-start"}", textAlign: "${align}", ${box}minWidth: 0 }}>
      ${icon}<div style={{ fontFamily: ${valueFont}, fontWeight: ${big ? 800 : 700}, fontSize: ${big ? 96 : 56}, lineHeight: 1, letterSpacing: "-0.02em", color: ${t.ink}, fontVariantNumeric: "tabular-nums" }}>${esc(s.value)}</div>
      <div style={{ fontFamily: ${t.fontBody}, fontSize: 17, fontWeight: 500, opacity: 0.82, marginTop: 10, color: ${t.ink} }}>${esc(s.label)}</div>${
        s.caption
          ? `\n      <div style={{ fontFamily: ${t.fontBody}, fontSize: 14, opacity: 0.55, marginTop: 6, color: ${t.ink} }}>${esc(s.caption)}</div>`
          : ""
      }${underline}
    </div>`;
};

const markerFor = (
  marker: "dot" | "dash" | "index",
  i: number,
  t: DeckTokens,
): string =>
  marker === "index"
    ? `<span style={{ fontFamily: ${t.fontMono}, fontSize: 13, color: ${t.accent}, minWidth: 26 }}>0${i + 1}</span>`
    : marker === "dash"
      ? `<span style={{ width: 14, height: 2, background: ${t.accent}, marginTop: 11, flexShrink: 0 }} />`
      : `<span style={{ width: 7, height: 7, borderRadius: 999, background: ${t.accent}, marginTop: 8, flexShrink: 0 }} />`;

const bulletStack = (s: BulletStackSpec, t: DeckTokens): string => {
  const k = s.knobs ?? {};
  const horizontal = s.variant === "horizontal";
  const boxedItem = s.variant === "boxed" || s.variant === "boxed-ruled";
  const mono = s.variant === "mono";
  const marker = k.marker ?? (mono ? "index" : "dot");
  const itemBox = boxedItem
    ? `background: ${t.surface}, borderRadius: 12, padding: "16px 18px", ${
        k.bordered ? `border: \`1px solid \${${t.line}}\`, ` : ""
      }${s.variant === "boxed-ruled" ? `borderTop: \`2px solid \${${t.accent}}\`, ` : ""}`
    : "";
  const rows = s.items
    .map((it, i) => {
      const lead =
        s.variant === "iconled"
          ? `<span style={{ display: "inline-flex", width: 26, height: 26, borderRadius: 8, background: ${t.surface}, color: ${t.accent}, alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Check size={14} /></span>`
          : markerFor(marker, i, t);
      return `<div style={{ display: "flex", gap: 12, alignItems: "flex-start", ${itemBox}${horizontal ? "flex: 1, minWidth: 0, " : ""}}}>
        ${lead}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: ${mono ? t.fontMono : t.fontBody}, fontSize: ${mono ? 15 : 18}, fontWeight: 600, lineHeight: 1.35, color: ${t.ink} }}>${esc(it.text)}</div>${
            it.detail
              ? `\n          <div style={{ fontFamily: ${t.fontBody}, fontSize: 14, opacity: 0.6, marginTop: 4, lineHeight: 1.4, color: ${t.ink} }}>${esc(it.detail)}</div>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("\n      ");
  return `<div style={{ display: "flex", flexDirection: ${horizontal ? `"row"` : `"column"`}, gap: ${boxedItem ? 14 : horizontal ? 20 : 16}, minWidth: 0 }}>
      ${rows}
    </div>`;
};

/** Escape literal copy for a JSX text position. */
const esc = (s: string): string =>
  s.replace(/[{}<>&]/g, (c) => `{${jsStr(c)}}`);

export const compilePieceSpec = (spec: PieceSpec, tokens: DeckTokens): string =>
  spec.piece === "statTile" ? statTile(spec, tokens) : bulletStack(spec, tokens);

/**
 * Lucide icons the compiled recipes may reference. The expander guarantees
 * these exist in the deck's lucide import before splicing an icon-led piece.
 */
export const SPEC_ICON_DEPS = ["TrendingUp", "Check"] as const;
