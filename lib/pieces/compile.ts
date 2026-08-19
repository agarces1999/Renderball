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
 *
 * v2: 22 variants per class (founder: "at least 20 per type"), every one
 * anchored to a mined corpus feature (carriage counts in spec.ts). Recipes
 * compose from shared parts — panel styles, leads, value treatments — so
 * each variant stays a distinct, reviewable visual and the pairwise-
 * distinct test keeps them honest.
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

/** Escape literal copy for a JSX text position. */
const esc = (s: string): string => s.replace(/[{}<>&]/g, (c) => `{${jsStr(c)}}`);

/**
 * Deterministic mini-series for spark-adjacent — derived from the value's
 * char codes so the same spec always draws the same line (no Math.random,
 * which the pipeline environment forbids anyway).
 */
const sparkPoints = (seed: string): string => {
  const xs: string[] = [];
  let acc = 7;
  for (let i = 0; i < 8; i++) {
    acc = (acc * 31 + (seed.charCodeAt(i % seed.length) || 13)) % 97;
    xs.push(`${i * 8},${22 - Math.round((acc / 97) * 18)}`);
  }
  return xs.join(" ");
};

// ─── statTile ────────────────────────────────────────────────────────────

const statTile = (s: StatTileSpec, t: DeckTokens): string => {
  const k = s.knobs ?? {};
  const v = s.variant;
  const align = k.align ?? "start";
  const mono = k.mono || v === "boxed-mono";
  const valueFont = mono ? t.fontMono : t.fontDisplay;
  const big = v === "big-number";

  // Panel treatment per variant (the box family).
  const panel =
    v === "boxed" || v === "boxed-mono"
      ? `background: ${t.surface}, borderRadius: 14, padding: "20px 24px", `
      : v === "bordered-boxed"
        ? `background: ${t.surface}, borderRadius: 14, padding: "20px 24px", border: \`1px solid \${${t.line}}\`, `
        : v === "shadow-card"
          ? `background: ${t.surface}, borderRadius: 16, padding: "22px 26px", boxShadow: "0 12px 32px rgba(0,0,0,0.14)", `
          : v === "inverse-panel"
            ? `background: ${t.ink}, borderRadius: 14, padding: "20px 24px", `
            : v === "dashed-frame"
              ? `border: \`1.5px dashed \${${t.line}}\`, borderRadius: 12, padding: "20px 24px", `
              : v === "framed-hairline"
                ? `border: \`1px solid \${${t.line}}\`, borderRadius: 12, padding: "20px 24px", `
                : v === "gradient-panel"
                  ? `background: \`linear-gradient(135deg, \${${t.surface}}, transparent)\`, borderRadius: 16, padding: "22px 26px", `
                  : v === "ruled-top"
                    ? `borderTop: \`3px solid \${${t.accent}}\`, paddingTop: 16, `
                    : "";
  const inverse = v === "inverse-panel";
  const textColor = inverse ? `"rgba(255,255,255,0.94)"` : t.ink;
  const softColor = inverse ? `"rgba(255,255,255,0.66)"` : t.ink;

  // Lead elements above the value.
  const lead =
    v === "iconled"
      ? `<span style={{ display: "inline-flex", width: 34, height: 34, borderRadius: 10, background: ${t.surface}, color: ${t.accent}, alignItems: "center", justifyContent: "center", marginBottom: 12 }}><TrendingUp size={18} /></span>\n      `
      : v === "eyebrow"
        ? `<div style={{ fontFamily: ${t.fontMono}, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: ${t.accent}, marginBottom: 10 }}>${esc(s.label)}</div>\n      `
        : v === "index-chip"
          ? `<span style={{ fontFamily: ${t.fontMono}, fontSize: 12, color: ${t.accent}, border: \`1px solid \${${t.line}}\`, borderRadius: 6, padding: "2px 7px", marginBottom: 12, display: "inline-block" }}>01</span>\n      `
          : v === "ghost-number"
            ? `<div aria-hidden style={{ position: "absolute", top: -18, right: 0, fontFamily: ${t.fontDisplay}, fontWeight: 800, fontSize: 130, lineHeight: 1, opacity: 0.07, color: ${textColor}, pointerEvents: "none" }}>${esc(s.value)}</div>\n      `
            : "";

  // Value row treatments.
  const valueCore =
    v === "split-tone"
      ? `<span style={{ color: ${t.accent} }}>${esc(s.value.slice(0, Math.ceil(s.value.length / 2)))}</span><span>${esc(s.value.slice(Math.ceil(s.value.length / 2)))}</span>`
      : esc(s.value);
  const valueSide =
    v === "delta-up"
      ? `\n        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: ${t.fontMono}, fontSize: 15, color: ${t.accent}, background: ${t.surface}, borderRadius: 999, padding: "4px 10px" }}><TrendingUp size={14} />{${jsStr(k.delta ?? "+12%")}}</span>`
      : v === "spark-adjacent"
        ? `\n        <svg width="58" height="24" viewBox="0 0 58 24" aria-hidden style={{ overflow: "visible" }}><polyline points="${sparkPoints(s.value)}" fill="none" stroke={${t.accent}} strokeWidth="2" strokeLinecap="round" /></svg>`
        : v === "arrow-cta"
          ? `\n        <span style={{ color: ${t.accent}, marginLeft: "auto" }}><ArrowUpRight size={22} /></span>`
          : "";
  const valueRow = `<div style={{ display: "flex", alignItems: "baseline", gap: 12${v === "arrow-cta" ? `, width: "100%"` : ""} }}>
        <div style={{ fontFamily: ${valueFont}, fontWeight: ${big ? 800 : 700}, fontSize: ${big ? 96 : 56}, lineHeight: 1, letterSpacing: "-0.02em", color: ${textColor}, fontVariantNumeric: "tabular-nums" }}>${valueCore}</div>${valueSide}
      </div>`;

  // Label + caption below (eyebrow variant already used the label above).
  const labelEl =
    v === "eyebrow"
      ? ""
      : v === "pill-label"
        ? `\n      <div style={{ fontFamily: ${t.fontBody}, fontSize: 13, fontWeight: 600, color: ${t.accent}, background: ${t.surface}, borderRadius: 999, padding: "4px 12px", marginTop: 12, display: "inline-block" }}>${esc(s.label)}</div>`
        : `\n      <div style={{ fontFamily: ${t.fontBody}, fontSize: 17, fontWeight: 500, opacity: 0.82, marginTop: 10, color: ${softColor} }}>${esc(s.label)}</div>`;
  const captionEl =
    s.caption && (v === "captioned" || v !== "eyebrow")
      ? `\n      <div style={{ fontFamily: ${v === "captioned" ? t.fontMono : t.fontBody}, fontSize: ${v === "captioned" ? 13 : 14}, opacity: 0.55, marginTop: 6, color: ${softColor} }}>${esc(s.caption)}</div>`
      : "";
  const underlineEl =
    k.underline || v === "underline"
      ? `\n      <div style={{ width: 44, height: 3, background: ${t.accent}, borderRadius: 2, margin: ${align === "center" ? `"10px auto 0"` : `"10px 0 0"`} }} />`
      : "";

  return `<div style={{ display: "flex", flexDirection: "column", alignItems: "${align === "center" ? "center" : "flex-start"}", textAlign: "${align}", position: "relative", ${panel}minWidth: 0 }}>
      ${lead}${valueRow}${labelEl}${captionEl}${underlineEl}
    </div>`;
};

// ─── bulletStack ─────────────────────────────────────────────────────────

const stackLead = (
  v: BulletStackSpec["variant"],
  marker: "dot" | "dash" | "index",
  i: number,
  t: DeckTokens,
): string => {
  if (v === "check")
    return `<span style={{ color: ${t.accent}, marginTop: 2, flexShrink: 0 }}><Check size={16} /></span>`;
  if (v === "arrow")
    return `<span style={{ color: ${t.accent}, marginTop: 2, flexShrink: 0 }}><ArrowRight size={15} /></span>`;
  if (v === "iconled")
    return `<span style={{ display: "inline-flex", width: 26, height: 26, borderRadius: 8, background: ${t.surface}, color: ${t.accent}, alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Check size={14} /></span>`;
  if (v === "pill-lead")
    return `<span style={{ fontFamily: ${t.fontMono}, fontSize: 11, color: ${t.accent}, background: ${t.surface}, borderRadius: 999, padding: "3px 9px", flexShrink: 0, marginTop: 2 }}>0${i + 1}</span>`;
  if (v === "steps")
    return `<span style={{ display: "inline-flex", width: 26, height: 26, borderRadius: 999, border: \`1.5px solid \${${t.accent}}\`, color: ${t.accent}, alignItems: "center", justifyContent: "center", fontFamily: ${t.fontMono}, fontSize: 12, flexShrink: 0 }}>${i + 1}</span>`;
  if (v === "timeline")
    return `<span style={{ width: 9, height: 9, borderRadius: 999, background: ${t.accent}, marginTop: 7, flexShrink: 0, zIndex: 1 }} />`;
  if (v === "mono" || marker === "index")
    return `<span style={{ fontFamily: ${t.fontMono}, fontSize: 13, color: ${t.accent}, minWidth: 26 }}>0${i + 1}</span>`;
  if (v === "dash" || marker === "dash")
    return `<span style={{ width: 14, height: 2, background: ${t.accent}, marginTop: 11, flexShrink: 0 }} />`;
  return `<span style={{ width: 7, height: 7, borderRadius: 999, background: ${t.accent}, marginTop: 8, flexShrink: 0 }} />`;
};

const bulletStack = (s: BulletStackSpec, t: DeckTokens): string => {
  const k = s.knobs ?? {};
  const v = s.variant;
  const marker = k.marker ?? "dot";
  const horizontal = v === "horizontal";
  const grid = v === "grid";
  const inverse = v === "inverse-panels";

  const itemPanel =
    v === "boxed"
      ? `background: ${t.surface}, borderRadius: 12, padding: "16px 18px", `
      : v === "boxed-ruled"
        ? `background: ${t.surface}, borderRadius: 12, padding: "16px 18px", borderTop: \`2px solid \${${t.accent}}\`, `
        : v === "bordered"
          ? `background: ${t.surface}, borderRadius: 12, padding: "16px 18px", border: \`1px solid \${${t.line}}\`, `
          : v === "shadow-cards"
            ? `background: ${t.surface}, borderRadius: 14, padding: "18px 20px", boxShadow: "0 10px 26px rgba(0,0,0,0.12)", `
            : v === "inverse-panels"
              ? `background: ${t.ink}, borderRadius: 12, padding: "16px 18px", `
              : v === "dashed-frame"
                ? `border: \`1.5px dashed \${${t.line}}\`, borderRadius: 12, padding: "14px 16px", `
                : v === "ruled-rows"
                  ? `borderBottom: \`1px solid \${${t.line}}\`, paddingBottom: 14, `
                  : "";
  const textColor = inverse ? `"rgba(255,255,255,0.94)"` : t.ink;
  const softColor = inverse ? `"rgba(255,255,255,0.62)"` : t.ink;
  const boxedFamily = itemPanel !== "" && v !== "ruled-rows";

  const rows = s.items
    .map((it, i) => {
      const textCore =
        v === "split-lead"
          ? (() => {
              const sp = it.text.indexOf(" ");
              const head = sp > 0 ? it.text.slice(0, sp) : it.text;
              const rest = sp > 0 ? it.text.slice(sp) : "";
              return `<span style={{ color: ${t.accent} }}>${esc(head)}</span>${esc(rest)}`;
            })()
          : esc(it.text);
      const eyebrowLead =
        v === "eyebrow-items"
          ? `<div style={{ fontFamily: ${t.fontMono}, fontSize: 11, letterSpacing: "0.13em", textTransform: "uppercase", color: ${t.accent}, marginBottom: 4 }}>0${i + 1}</div>\n          `
          : "";
      const lead =
        v === "plain" || v === "eyebrow-items" || v === "gradient-panel"
          ? ""
          : `${stackLead(v, v === "dash" ? "dash" : v === "mono" ? "index" : marker, i, t)}\n        `;
      return `<div style={{ display: "flex", gap: 12, alignItems: "flex-start", position: "relative", ${itemPanel}${horizontal || grid ? "flex: 1, minWidth: 0, " : ""}}}>
        ${lead}<div style={{ minWidth: 0 }}>
          ${eyebrowLead}<div style={{ fontFamily: ${v === "mono" ? t.fontMono : t.fontBody}, fontSize: ${v === "mono" ? 15 : 18}, fontWeight: 600, lineHeight: 1.35, color: ${textColor} }}>${textCore}</div>${
            it.detail
              ? `\n          <div style={{ fontFamily: ${t.fontBody}, fontSize: 14, opacity: 0.6, marginTop: 4, lineHeight: 1.4, color: ${softColor} }}>${esc(it.detail)}</div>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("\n      ");

  const layout = grid
    ? `display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14`
    : `display: "flex", flexDirection: ${horizontal ? `"row"` : `"column"`}, gap: ${boxedFamily ? 14 : horizontal ? 20 : v === "ruled-rows" ? 14 : 16}`;
  const wrapPanel =
    v === "gradient-panel"
      ? `background: \`linear-gradient(135deg, \${${t.surface}}, transparent)\`, borderRadius: 16, padding: "22px 24px", `
      : "";
  const rail =
    v === "timeline" || v === "steps"
      ? `\n      <div aria-hidden style={{ position: "absolute", left: ${v === "steps" ? 12 : 3.5}, top: 10, bottom: 10, width: 1.5, background: ${t.line} }} />`
      : "";

  return `<div style={{ ${layout}, position: "relative", ${wrapPanel}minWidth: 0 }}>${rail}
      ${rows}
    </div>`;
};

export const compilePieceSpec = (spec: PieceSpec, tokens: DeckTokens): string =>
  spec.piece === "statTile" ? statTile(spec, tokens) : bulletStack(spec, tokens);

/**
 * Lucide icons the compiled recipes may reference, and which variants need
 * them. The expander guarantees the deck's lucide import carries these
 * before splicing an icon-bearing piece.
 */
export const SPEC_ICON_DEPS = ["TrendingUp", "Check", "ArrowRight", "ArrowUpRight"] as const;
export const ICON_VARIANTS = new Set<string>([
  "iconled",
  "delta-up",
  "arrow-cta",
  "check",
  "arrow",
]);
