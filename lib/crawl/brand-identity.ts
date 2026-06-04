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
}

const isLoadableUrl = (u: string): boolean =>
  /^https?:\/\//i.test(u) || u.startsWith("data:");

const hasUsableSrc = (src?: string): boolean =>
  typeof src === "string" && isLoadableUrl(src);

/** Derive a human brand name from the page title or the hostname. */
export const deriveBrandName = (extract: Partial<BrandExtract>): string => {
  const title = extract.title?.trim();
  if (title) {
    // Take the segment before the first separator: "Falabella.com | ..." → "Falabella.com"
    const seg = title.split(/[|–—\-:·•]/)[0].trim();
    if (seg) return seg.replace(/\.com$|\.[a-z]{2,}$/i, "").trim() || seg;
  }
  const url = extract.url || "";
  const host = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0];
  const label = host.split(".")[0] || "Brand";
  return label.charAt(0).toUpperCase() + label.slice(1);
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
const pickLogo = (extract: Partial<BrandExtract>): BrandIdentity["logo"] => {
  const ogImage = extract.og_image;
  const candidates: Array<string | undefined> = [
    extract.logo_hd,
    extract.apple_touch_icon,
    extract.favicon,
  ];
  for (const url of candidates) {
    if (typeof url !== "string" || !isLoadableUrl(url)) continue;
    if (UI_GLYPH_RX.test(url)) continue; // search/menu/cart icon, not a logo
    if (SHARE_IMG_RX.test(url)) continue; // OG/social card, not a logo
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
    logo: pickLogo(e),
    wordmark: { text: brandName, font: display.family },
    fonts: { display, body, ...(mono ? { mono } : {}) },
    palette: e.palette ?? [],
  };
};
