/**
 * resolveBrandIdentity — turn a raw BrandExtract into a LOCKED brand
 * identity the design agent must use verbatim, instead of letting the
 * agent improvise from a raw asset dump.
 *
 * Why this exists (from the non-tech pilot):
 *  - Falabella: the agent grabbed the site's SEARCH-ICON svg as the "logo"
 *    and invented `LOGO_URL = "https://falabella.com"` (an HTML page used as
 *    an <img src> → broken). The crawl's logo_hd was actually the OG share
 *    image, not a logo.
 *  - Falabella display font fell back to Georgia because the "font" the
 *    crawl surfaced was `swiper-icons` (an icon font). [The icon-font regex
 *    fix in extract-brand.ts handles that; here we handle the *no usable
 *    src* case — Patagonia's "Avenir Next" had a family name but no web
 *    src, so it rendered as a system serif.]
 *
 * The logo and font bugs are the SAME bug: the agent guessing. This module
 * decides — deterministically, testably — exactly one logo (or "no logo,
 * use the wordmark") and a loadable font per role, then the agent executes.
 *
 * Pure + synchronous: no network. Logo light/dark is inferred from URL
 * filename hints (light/white/dark/black) rather than fetching + decoding
 * the image — good enough to let the design prompt place the logo on a
 * contrasting surface; a real luminance probe is deferred (see plan).
 */

import type { BrandExtract, BrandFont } from "../../app/new/schema";
import { classifyFontRoles } from "./extract-brand";

// Curated, Google-Fonts-loadable fallbacks by style class. Used ONLY when a
// crawled family has no usable web src (so it would otherwise render as a
// system fallback — the "Georgia" bug). Style-matched so a serif brand stays
// serif. The design agent loads these from Google Fonts when `fallback` is set.
const FALLBACK_DISPLAY_SANS = "Inter";
const FALLBACK_DISPLAY_SERIF = "Fraunces";
const FALLBACK_BODY = "Inter";
const FALLBACK_MONO = "JetBrains Mono";

const SERIF_RX =
  /\b(serif|tiempos|merriweather|playfair|lora|freight|garamond|caslon|bodoni|didot|minion|miller|noe|times|georgia|cambria|baskerville|crimson|cormorant|source[\s-]*serif|noto[\s-]*serif|pt[\s-]*serif|sentinel|chronicle|gt[\s-]*super|fraunces|signifier|literata|recoleta|reckless|domaine|saol)\b/i;
const MONO_RX =
  /\b(mono|code|courier|consol|menlo|jetbrains|plex[\s-]*mono|fira[\s-]*code|space[\s-]*mono)\b/i;

// URL substrings that mean "this is a UI glyph, not the brand logo".
const UI_GLYPH_RX =
  /\b(search|magnif|menu|hamburger|burger|cart|bag|close|times|arrow|chevron|caret|nav|spinner|loader|play|pause|share|heart|star|plus|minus|check|x-?icon)\b/i;
// URL substrings that mean "this is a social/share card, not a logo".
const SHARE_IMG_RX = /\b(og[-_]?image|og[-_]?fcom|social|share|twitter|opengraph|card)\b/i;
// Junk a brand sometimes wires into its logo/og/icon meta on a site builder —
// a screenshot or placeholder, not a real mark (Fuse's Webflow site set its
// logo_hd / apple-touch / favicon all to a "Screenshot ….png"). Reject → wordmark.
// No \b: filenames embed these after underscores ("…_Screenshot 2026….png"),
// where \b fails because "_" is a word char. Substring match — these words
// don't appear in real logo filenames.
const JUNK_IMG_RX = /(screenshot|screen-?shot|untitled|placeholder)/i;

export interface ResolvedFont {
  family: string;
  /** Web font src to @font-face, if the brand provides a loadable one. */
  src?: string;
  /** True when `family` is a curated Google-Fonts fallback (agent must load it). */
  fallback: boolean;
  /** CSS generic fallback so the agent's font stack degrades on-style. */
  generic: "serif" | "sans-serif" | "monospace";
}

export interface BrandIdentity {
  /** The one logo to render, or null → render the wordmark instead. */
  logo:
    | {
        url: string;
        /** Safe to place on a LIGHT background (logo is dark/colored). */
        onLight: boolean;
        /** Safe to place on a DARK background (logo is light/white). */
        onDark: boolean;
      }
    | null;
  /** Always present: brand name + display font, the fallback when logo is null. */
  wordmark: { text: string; font: string };
  fonts: { display: ResolvedFont; body: ResolvedFont; mono?: ResolvedFont };
  palette: string[];
  /**
   * The brand's SIGNATURE color — the vivid, chromatic hue a viewer associates
   * with the brand (Fuse blue, Tony's red), as opposed to the dark/neutral that
   * merely covers the most pixels (Fuse maroon, Tony's brown). null for
   * genuinely monochrome brands (Liquid Death). The design agent leads with
   * this so the brand color is prominent instead of buried under a neutral.
   */
  signature: string | null;
}

const isLoadableUrl = (u: string): boolean =>
  /^https?:\/\//i.test(u) || u.startsWith("data:");

const hasUsableSrc = (src?: string): boolean =>
  typeof src === "string" && isLoadableUrl(src);

/**
 * Derive a clean brand name from the page title + hostname.
 * The brand can be EITHER side of the title separator ("Brand | Tagline" OR
 * "Tagline | Brand" — Fuse's title is "AI-Powered Loan Origination Software |
 * Fuse"), so we pick the title segment that matches the hostname rather than
 * blindly taking the first. Splits on title separators only — NOT hyphen, so
 * "AI-Powered" stays one word.
 */
export const deriveBrandName = (extract: Partial<BrandExtract>): string => {
  const host = (extract.url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0];
  const hostLabel = host.split(".")[0] || ""; // "fusefinance"
  const title = extract.title?.trim();
  if (title) {
    const segs = title
      .split(/\s*[|–—:·•]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segs.length > 0) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      // Prefer the segment that matches the hostname (the brand usually does).
      const byHost = segs.find((s) => {
        const n = norm(s);
        return n && hostLabel && (hostLabel.includes(n) || n.includes(hostLabel));
      });
      // Else the shortest segment — taglines are long, brand names are short.
      const chosen = byHost || [...segs].sort((a, b) => a.length - b.length)[0];
      const clean = chosen.replace(/\.(com|io|co|app|ai|net|org)$/i, "").trim();
      if (clean) return clean;
    }
  }
  if (hostLabel) return hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1);
  return "Brand";
};

/** Light/dark placement hints from the logo URL filename. */
const luminanceFromUrl = (url: string): { onLight: boolean; onDark: boolean } => {
  // Normalize separators AND digits to spaces so word boundaries are reliable:
  // "favicon-light_180x180.webp" → "favicon light x webp" ('_' is a \w char, so
  // \blight\b would otherwise fail before it). Precise: won't match "delight".
  const u = url.toLowerCase().replace(/[^a-z]+/g, " ");
  if (/\b(light|white|inverse|inverted|reverse|knockout)\b/.test(u)) {
    // A light/white logo: shows on dark, disappears on light.
    return { onLight: false, onDark: true };
  }
  if (/\b(dark|black|mono-?dark)\b/.test(u)) {
    return { onLight: true, onDark: false };
  }
  // Unknown: assume it works on light (most logos are dark/colored); the
  // design prompt is told to place an unknown logo on a contrasting chip.
  return { onLight: true, onDark: true };
};

/**
 * Pick the single logo to use. Priority: a real logo_hd that isn't a UI
 * glyph or a share image, then the apple-touch-icon, then the favicon.
 * Returns null when nothing brand-correct is available (→ wordmark).
 */
// Trust a logo the agentic finder picked at or above this confidence. Below it
// (or with no confidence at all — a legacy/stale cached brief) we re-apply the
// regex reject filters as a safety net.
const LOGO_TRUST_THRESHOLD = 0.6;

const pickLogo = (extract: Partial<BrandExtract>): BrandIdentity["logo"] => {
  const ogImage = extract.og_image;

  // The agentic logo finder already vetted candidates with vision + decoded
  // dimensions and rejected screenshots / customer logos. When it returns a
  // confident pick, TRUST it — re-applying the regex here is exactly what nulled
  // a *correct* pick before (Fuse: agent would pick the real mark, regex would
  // not, but the screenshot path also failed). Only re-litigate logo_hd when it
  // carries no confidence (a brief crawled before this finder existed).
  const conf = typeof extract.logo_confidence === "number" ? extract.logo_confidence : undefined;
  if (
    typeof extract.logo_hd === "string" &&
    isLoadableUrl(extract.logo_hd) &&
    conf !== undefined &&
    conf >= LOGO_TRUST_THRESHOLD
  ) {
    return { url: extract.logo_hd, ...luminanceFromUrl(extract.logo_hd) };
  }

  const candidates: Array<string | undefined> = [
    extract.logo_hd,
    extract.apple_touch_icon,
    extract.favicon,
  ];
  for (const url of candidates) {
    if (typeof url !== "string" || !isLoadableUrl(url)) continue;
    if (UI_GLYPH_RX.test(url)) continue; // search/menu/cart icon, not a logo
    if (SHARE_IMG_RX.test(url)) continue; // OG/social card, not a logo
    if (JUNK_IMG_RX.test(url)) continue; // screenshot/placeholder, not a logo
    if (ogImage && url === ogImage) continue; // share image masquerading as logo
    return { url, ...luminanceFromUrl(url) };
  }
  return null;
};

const styleClass = (family: string): "serif" | "mono" | "sans" => {
  if (MONO_RX.test(family)) return "mono";
  if (SERIF_RX.test(family)) return "serif";
  return "sans";
};

const genericFor = (family: string): ResolvedFont["generic"] => {
  const c = styleClass(family);
  return c === "serif" ? "serif" : c === "mono" ? "monospace" : "sans-serif";
};

/**
 * Resolve one role's font: keep the brand family if it ships a loadable web
 * src; otherwise return a style-matched curated fallback (NOT a system serif).
 */
const resolveFont = (
  family: string | undefined,
  role: "display" | "body" | "mono",
  fonts: BrandFont[],
): ResolvedFont | undefined => {
  if (!family) return undefined;
  const decl = fonts.find((f) => f.family === family && hasUsableSrc(f.src));
  if (decl) return { family, src: decl.src, fallback: false, generic: genericFor(family) };
  // No loadable src → curated fallback by style, so we never silently render
  // a system serif (the Georgia bug).
  const cls = styleClass(family);
  if (role === "mono" || cls === "mono")
    return { family: FALLBACK_MONO, fallback: true, generic: "monospace" };
  if (role === "body") return { family: FALLBACK_BODY, fallback: true, generic: "sans-serif" };
  return cls === "serif"
    ? { family: FALLBACK_DISPLAY_SERIF, fallback: true, generic: "serif" }
    : { family: FALLBACK_DISPLAY_SANS, fallback: true, generic: "sans-serif" };
};

// Relative luminance (0=black, 1=white) of a #rrggbb color.
const luminanceOf = (hex: string): number | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

// HSV-style saturation (0–1) from a hex string. 0 = grey, 1 = fully chromatic.
const saturationOf = (hex: string): number | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

const isHex6 = (h: unknown): h is string =>
  typeof h === "string" && /^#?[0-9a-fA-F]{6}$/.test(h.trim());

const normHex = (h: string): string => {
  const t = h.trim();
  return t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
};

// A color is a usable SIGNATURE candidate when it's chromatic enough to read as
// "a color" and neither near-black nor near-white (those are structure, not the
// brand hue). Tuned to reject Fuse maroon (#440b12, too dark) and near-whites.
const isSignatureCandidate = (hex: string): boolean => {
  const sat = saturationOf(hex),
    lum = luminanceOf(hex);
  return sat !== null && lum !== null && sat >= 0.3 && lum >= 0.15 && lum <= 0.85;
};

/**
 * Pick the brand's SIGNATURE color from its palette.
 *
 * Problem this solves: the palette is a flat list, so the design agent led with
 * whatever color covered the most pixels — usually a dark neutral (Fuse maroon,
 * Tony's brown) — leaving the actual brand hue (Fuse blue, Tony's red) buried.
 *
 * Strategy, most-authoritative first:
 *   1. theme_color (<meta name="theme-color">) when it's a real chromatic color
 *      — brands set this to their primary far more often than not.
 *   2. else the most "vivid" palette member: saturation, biased toward
 *      mid-luminance so a deep shade doesn't beat a clean brand hue. Still
 *      strictly better than leading with a near-black neutral.
 *   3. null when nothing qualifies — a genuinely monochrome brand (Liquid
 *      Death). We never invent a color for a brand that doesn't have one.
 */
export const pickSignatureColor = (
  palette: string[],
  themeColor?: string,
): string | null => {
  if (isHex6(themeColor) && isSignatureCandidate(themeColor)) {
    return normHex(themeColor);
  }
  const scored = (palette ?? [])
    .filter((h) => isHex6(h) && isSignatureCandidate(h))
    .map((h) => {
      const sat = saturationOf(h) as number;
      const lum = luminanceOf(h) as number;
      // Vividness: saturation, gently penalized away from mid-luminance so a
      // very dark or very pale-but-saturated color loses to a clean brand hue.
      return { h: normHex(h), score: sat * (1 - Math.abs(lum - 0.5) * 0.6) };
    })
    .sort((a, b) => b.score - a.score);
  return scored.length > 0 ? scored[0].h : null;
};

// Pick an "ink" color for a monochrome logo: the palette's darkest non-trivial
// color (so the mark reads as a real brand color — e.g. Fuse maroon — not
// generic black), falling back to near-black.
const pickInk = (palette: string[]): string => {
  const dark = palette
    .map((h) => ({ h, l: luminanceOf(h) }))
    .filter((x): x is { h: string; l: number } => x.l !== null && x.l < 0.55)
    .sort((a, b) => a.l - b.l)[0];
  return dark ? dark.h : "#111111";
};

/**
 * Bake an explicit ink color into a monochrome inline-svg logo.
 *
 * `<Img src="data:image/svg+xml,...">` is color-ISOLATED: a `fill="currentColor"`
 * mark resolves currentColor to its default (black) regardless of the
 * surrounding CSS, so a wordmark renders BLACK and can vanish on a colored scene
 * (Fuse's wordmark is currentColor → black-on-maroon). Replace currentColor with
 * a real palette ink and flag it as a dark/colored mark so the design agent
 * places it on a LIGHT surface. Only touches inline-svg logos that actually use
 * currentColor; colored logos pass through untouched.
 */
const recolorMonochromeLogo = (
  logo: BrandIdentity["logo"],
  palette: string[],
): BrandIdentity["logo"] => {
  if (!logo || !/^data:image\/svg\+xml/i.test(logo.url)) return logo;
  let svg: string;
  try {
    const b64 = logo.url.split(",")[1] ?? "";
    svg = Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return logo;
  }
  if (!/currentColor/i.test(svg)) return logo; // already explicitly colored
  const ink = pickInk(palette);
  const recolored = svg.replace(/currentColor/gi, ink);
  const url =
    "data:image/svg+xml;base64," + Buffer.from(recolored).toString("base64");
  // Dark/colored ink → safe on a light surface, not a dark one.
  return { url, onLight: true, onDark: false };
};

export const resolveBrandIdentity = (
  extract: Partial<BrandExtract> | undefined,
  opts?: { brandName?: string },
): BrandIdentity => {
  const e = extract ?? {};
  const fonts = e.fonts ?? [];
  // Re-classify the raw font list with the CURRENT classifier rather than
  // trusting the stored font_roles — cached briefs may carry stale roles from
  // before the icon-font filter was fixed (Falabella's stored role was the
  // icon font `swiper-icons`). Re-classifying is the single source of truth.
  const roles = fonts.length > 0 ? classifyFontRoles(fonts) : e.font_roles ?? {};

  const display =
    resolveFont(roles.display, "display", fonts) ??
    ({ family: FALLBACK_DISPLAY_SANS, fallback: true } as ResolvedFont);
  const body =
    resolveFont(roles.body, "body", fonts) ??
    ({ family: FALLBACK_BODY, fallback: true } as ResolvedFont);
  const mono = resolveFont(roles.mono, "mono", fonts);

  const brandName = opts?.brandName?.trim() || deriveBrandName(e);

  return {
    logo: recolorMonochromeLogo(pickLogo(e), e.palette ?? []),
    wordmark: { text: brandName, font: display.family },
    fonts: { display, body, ...(mono ? { mono } : {}) },
    palette: e.palette ?? [],
    signature: pickSignatureColor(e.palette ?? [], e.theme_color),
  };
};
