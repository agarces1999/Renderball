/**
 * deriveCrawlTheme — a DETERMINISTIC Theme built straight from the brand crawl
 * (canvas plan + signature + fonts + palette), with NO LLM design-system call.
 *
 * The dogfood spike derives its theme from an LLM design-system emission and
 * falls back to this deterministic path only when the DS emission is invalid.
 * The production cast path (run-preview-build under RB_BUILD_MODE=cast) uses
 * THIS deterministic derivation directly — it needs a valid Theme for castBuild
 * without spending a head call on a bespoke palette. Ported verbatim from the
 * spike's fallbackThemeFromCrawl + fontsFromCrawl + grammarDefaults so the two
 * paths cannot drift on the fallback shape.
 */
import type { Theme } from "../edit/piece-model";
import type { AgentBrandExtract } from "../agents/script-generator";

const FALLBACK_KEYFRAMES = `
@keyframes fadeRise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
@keyframes drawWidth { from { width: 0; } }
@keyframes glowBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes drift1 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(14px, -10px); } }
@keyframes drift2 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-12px, 8px); } }
@keyframes drift3 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(8px, 12px); } }
`;

const grammarDefaults = (): Theme["grammar"] => ({
  radiusScale: [6, 12, 20],
  strokeWeight: 1,
  hairline: "SOFT_NEUTRAL",
  panelBg: "CARD_FILL",
  shadowRecipe: "0 24px 60px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06)",
  dataFont: "mono",
});

const CSS_FONT_FORMAT: Record<string, string> = {
  woff2: "woff2", woff: "woff", otf: "opentype", ttf: "truetype",
  eot: "embedded-opentype", svg: "svg", opentype: "opentype", truetype: "truetype",
};
const quoteFamily = (f: string): string => (/[^a-zA-Z0-9-]/.test(f) ? JSON.stringify(f) : f);

/** Theme fonts from the brand crawl: role-classified families lead their
 *  stacks; @font-face CSS is built from the crawled srcs (data:-inlined later
 *  at finalize so the measure/vision path loads them CORS-free). */
export const fontsFromCrawl = (be: AgentBrandExtract | undefined): Theme["fonts"] => {
  const fam = be?.fonts ?? [];
  const roles = be?.font_roles ?? {};
  const display = roles.display ?? fam[0]?.family;
  const body = roles.body ?? roles.display ?? fam[1]?.family ?? fam[0]?.family;
  const mono = roles.mono;
  const stack = (primary: string | undefined, fallback: string): string =>
    primary ? `${quoteFamily(primary)}, ${fallback}` : fallback;
  const faces = fam
    .filter((f) => f.family && f.src)
    .map((f) => {
      const fmt = f.format ? CSS_FONT_FORMAT[f.format.toLowerCase()] ?? f.format : undefined;
      return `@font-face { font-family: ${JSON.stringify(f.family)}; src: url("${f.src}")${fmt ? ` format("${fmt}")` : ""};${f.weight ? ` font-weight: ${f.weight};` : ""}${f.style ? ` font-style: ${f.style};` : ""} font-display: swap; }`;
    });
  return {
    display: stack(display, "Inter, system-ui, sans-serif"),
    body: stack(body, "Inter, system-ui, sans-serif"),
    mono: stack(mono, 'ui-monospace, "SF Mono", Menlo, monospace'),
    fontFaceCss: faces.join("\n"),
  };
};

export interface DerivedCrawlTheme {
  theme: Theme;
  paletteHexes: string[];
  signatureAccent: string;
}

/** Contract consts synthesized from the canvas plan + signature (no reference
 *  PALETTE to borrow on a fresh brand); neutral deterministic keyframes. */
export const deriveCrawlTheme = (
  be: AgentBrandExtract | undefined,
  canvasBg: string,
  canvasMode: "light" | "dark",
  signature: string,
  brandPalette: string[],
): DerivedCrawlTheme => {
  const dark = canvasMode === "dark";
  const palette: Record<string, string> = {
    CANVAS: canvasBg,
    INK: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.88)",
    ACCENT: signature,
    MUTED: dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)",
    SOFT_NEUTRAL: dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.1)",
    CARD_FILL: dark ? "#1a1a1e" : "#f7f8fa",
    WHITE: "#ffffff",
  };
  return {
    theme: { palette, fonts: fontsFromCrawl(be), keyframes: FALLBACK_KEYFRAMES, grammar: grammarDefaults() },
    paletteHexes: [...new Set([...Object.values(palette).filter((v) => /^#/.test(v)), ...brandPalette])],
    signatureAccent: signature,
  };
};
