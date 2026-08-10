import type { BrandExtract } from "../../app/new/schema";
import type { Usage } from "../usage";
import {
  extractBrandColorRoles,
  extractPaletteFromPixels,
  refinePaletteWithPixels,
  snapHexToPixels,
} from "./vision-brand";
import {
  GENERIC_FAMILIES,
  annotateFontUsage,
  classifyFontRoles,
  type CrawledFont,
} from "./font-roles";
import { readLogoCache, writeLogoCache } from "./logo-cache";
import { dominantSvgColor, signatureWithLogoFallback } from "./brand-identity";
import { extractDesignLanguage } from "./design-language";
import { safeFetch } from "./ssrf-guard";
import {
  assessBrandTruth,
  dominantColorFromImageBytes,
  isNeutralAccentHex,
  verifyLogoChain,
  verifyPageImages,
  type BrandTruthReport,
  type LogoChainResult,
  type PageImageVerification,
} from "./brand-truth";

/**
 * Receives the model + token usage of every Anthropic call the crawl makes —
 * palette vision + design language (Haiku) and the logo agent (Sonnet,
 * including its retry/web-search rounds) — so the caller can aggregate
 * per-model totals and persist them. A logo-cache hit skips the agent
 * entirely, so cached crawls correctly report zero usage.
 */
export type CrawlUsageCollector = (model: string, usage: Usage) => void;

/**
 * Website crawl + brand extract — V0.3.
 *
 * Goals:
 *   - Server-side fetch (no CORS, no client exposure)
 *   - Cheap: regex-based HTML/CSS parsing, no cheerio dep
 *   - Bounded: 10s HTML timeout, 5s per stylesheet, max 5 stylesheets
 *   - Forgiving: malformed pages still return *something*, never throw
 *   - Honest: bad/unreachable URLs return ok=false with a reason
 *
 * What we extract:
 *   FROM HTML <head>:
 *     - <title>, meta description, og:image, theme-color, favicon, apple-touch-icon
 *   FROM HTML <body>:
 *     - First 3 H1/H2 headlines (tagline candidates)
 *   FROM linked CSS + inline <style>:
 *     - @font-face declarations → { family, src, weight, style }
 *     - Color palette (hex + rgb), top by frequency, filtered for grays
 *     - Motion signal: keyframe + animation/transition counts
 */

const HTML_TIMEOUT_MS = 10_000;
const CSS_TIMEOUT_MS = 5_000;
// 10 because modern sites stack 6-8 stylesheets (framework + global + page +
// fonts CDN + UI lib) and the Google Fonts link is often last in the head.
const MAX_STYLESHEETS = 10;
// Stylesheets pulled via `@import` inside the site CSS (one level deep). Font
// services — Adobe Fonts/Typekit especially — are often loaded this way rather
// than via a <link rel=stylesheet>, so a plain link scan misses their fonts.
const MAX_IMPORTED_SHEETS = 5;
const MAX_CSS_BYTES = 500_000; // per stylesheet
const USER_AGENT =
  "Mozilla/5.0 (compatible; RenderballBrandExtract/0.3; +https://renderball.com/bot)";

export const extractBrand = async (
  rawUrl: string,
  opts: { onUsage?: CrawlUsageCollector } = {},
): Promise<BrandExtract> => {
  // Guard the caller's collector once so a throwing collector can never turn a
  // good crawl into a failed one (every model pass below is best-effort).
  const onUsage: CrawlUsageCollector | undefined = opts.onUsage
    ? (model, usage) => {
        try {
          opts.onUsage!(model, usage);
        } catch {
          /* usage accounting must never break the crawl */
        }
      }
    : undefined;
  const fetched_at = new Date().toISOString();
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      url: rawUrl,
      fetched_at,
      ok: false,
      error: "Not a valid URL.",
    };
  }

  let html: string;
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        url,
        fetched_at,
        ok: false,
        error: `HTTP ${res.status} from ${url}`,
      };
    }
    // A 200 is not a page. ramp.com answers this User-Agent with
    // `content-type: text/markdown; charset=utf-8` (verified 2026-08-09): the
    // HTML regexes below then matched nothing, and the crawl still returned
    // ok:true with an empty palette and no fonts — a silent failure the caller
    // could not distinguish from a real extract. A missing content-type is
    // tolerated (some origins omit it); a content-type that positively says
    // "not HTML" is a failed crawl and must say so.
    const contentType = res.headers.get("content-type") ?? "";
    if (!isHtmlContentType(contentType)) {
      return {
        url,
        fetched_at,
        ok: false,
        error: `Not an HTML page: ${url} served ${contentType.split(";")[0].trim()}`,
      };
    }
    html = await res.text();
  } catch (err) {
    return {
      url,
      fetched_at,
      ok: false,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // https-near-universal upgrade for image meta URLs. Vision + pixel palette and
  // SVG-logo rasterization are https-only, so an http:// og:image (liquiddeath.com)
  // silently disables them and the palette degrades to the CSS-frequency fallback.
  const upgradeToHttps = (u: string | undefined): string | undefined =>
    u && /^http:\/\//i.test(u) ? u.replace(/^http:\/\//i, "https://") : u;

  // Pull HTML signals.
  const headSlice =
    html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 50_000);
  // Body content for headline / excerpt / image extraction. Strip <script>/
  // <style>/<noscript> FIRST, then slice — heavy SPAs (Shopify Hydrogen, Next)
  // embed hundreds of KB of JSON in <script>, which otherwise eats the slice cap
  // before any real <h1>/<p> (liquiddeath.com: 66 headlines, all past the old
  // 80KB raw cap → 0 extracted).
  const bodyHtml = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
  const bodySlice = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .slice(0, 200_000);

  const title = decode(extractTitle(headSlice));
  const description = decode(extractMetaName(headSlice, "description"));
  const og_image = upgradeToHttps(
    resolveMaybe(extractMetaProperty(headSlice, "og:image"), url),
  );
  const theme_color = extractMetaName(headSlice, "theme-color");
  const favicon = upgradeToHttps(
    resolveMaybe(
      extractLinkRel(headSlice, /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/i),
      url,
    ),
  );
  const apple_touch_icon = upgradeToHttps(
    resolveMaybe(
      extractLinkRel(headSlice, /(?:^|\s)apple-touch-icon(?:\s|$)/i),
      url,
    ),
  );
  const headlines = extractHeadlines(bodySlice);
  const body_excerpts = extractBodyExcerpts(bodySlice);
  // R4b (audit-3): the on-page copy language, bound to the FULL html (the <html
  // lang> tag sits outside headSlice) with a dominant-language fallback over the
  // crawled copy. Reinforces the script's copy-language directive so a Spanish
  // brand ships Spanish mocks, not English headlines.
  const site_lang = detectSiteLang(html, [...headlines, ...body_excerpts]);
  // Strip logo-grid containers from the body BEFORE extracting page_images
  // and discovering the brand logo. Marketing sites (Webflow especially)
  // pack customer/partner logos into "Trusted by" carousels — we don't
  // want any of those reaching the agents as either "the brand's logo"
  // or "real product imagery."
  const bodyWithoutLogoGrids = stripLogoGridContainers(bodySlice);
  const page_images = extractPageImages(bodyWithoutLogoGrids, url);

  // Kick off the independent network/vision stages NOW so they overlap with logo
  // discovery + CSS fetching below. extractDesignLanguage (screenshot + vision)
  // and the og:image palette pair depend on neither the logo nor the CSS, so
  // running them concurrently collapses crawl wall-clock from ~sum-of-stages to
  // ~slowest-stage. Each is already internally best-effort (safe defaults / {} on
  // any failure); awaited at their consumption points below.
  const designP = extractDesignLanguage(url, og_image, { onUsage });
  const paletteVisionP = Promise.all([
    extractBrandColorRoles(og_image, { onUsage }),
    extractPaletteFromPixels(og_image, { maxColors: 8 }),
  ]).catch(() => null);
  // The site's OWN icons, mined for colour (palette tier 3). Two small images,
  // started here so they overlap the logo + CSS work like the vision pair above.
  const iconColorsP = iconAccentColors([favicon, apple_touch_icon]);

  const logoResult = await discoverLogoHd(
    bodyWithoutLogoGrids,
    url,
    og_image,
    apple_touch_icon,
    favicon,
    title,
    onUsage,
  );
  // QA G1: the signature/lead color the agents reach for when the palette is
  // achromatic. Pulled from the logo SVG (the one place a greyscale site still
  // hides its real color). undefined for raster logos or monochrome marks.
  const logo_color = await logoColorFromUrl(logoResult?.url);

  // Gather all CSS: inline <style> blocks + linked stylesheets.
  const inlineCss = extractInlineStyles(html);
  const cssLinks = extractStylesheetLinks(html, url).slice(0, MAX_STYLESHEETS);
  const fetchedCss = await Promise.all(
    cssLinks.map((href) => fetchCss(href).catch(() => "")),
  );
  const baseCss = [inlineCss, ...fetchedCss].join("\n");

  // Follow `@import`'d stylesheets one level deep. Font services (Adobe
  // Fonts/Typekit, Fontshare, …) are frequently pulled via
  // `@import url("https://use.typekit.net/xxx.css")` inside the site CSS rather
  // than a <link rel=stylesheet>, so the link scan above never sees them and
  // their @font-face declarations are lost. Bounded + best-effort; font-service
  // imports are fetched first so the cap favors brand fonts over UI imports.
  const importHrefs = extractCssImports(baseCss, url)
    .filter((href) => !cssLinks.includes(href))
    .slice(0, MAX_IMPORTED_SHEETS);
  const importedCss = importHrefs.length
    ? await Promise.all(importHrefs.map((href) => fetchCss(href).catch(() => "")))
    : [];
  const allCss = [baseCss, ...importedCss].join("\n");

  // Two complementary font discovery paths:
  //   1. @font-face blocks in inline + linked CSS (the existing path)
  //   2. Google Fonts URLs in <link rel="stylesheet"> tags — parsed
  //      directly without fetching, so we still get families even when
  //      Google's CSS response is rate-limited / blocked
  //   3. DOM inline style="font-family:..." declarations and <style>
  //      block font-family rules — catches sites using JS-loaded fonts
  //      or system-font-only stacks
  // Results merge with dedupe-by-family-name. Path #1 wins for any
  // family it found (it has src URL + weight); path #2 fills in
  // family names path #1 missed.
  // Resolve each stylesheet's font url()s against THAT sheet's own URL — NOT the
  // page URL. A CSS `url()` is relative to the stylesheet (browser behavior): a
  // linked sheet at /_next/static/css/x.css with `url(../media/f.otf)` resolves
  // to /_next/static/media/f.otf. Resolving against the page root instead drops
  // the /_next/static segment, so the font 404s and never loads (the corgi
  // f37Bolton bug — the file is fine, the crawl just recorded the wrong path).
  // (allCss keeps the page base for palette/motion — those need no url resolution.)
  const fontsFromCss = [
    ...extractFonts(inlineCss, url), // inline <style>: relative to the page
    ...fetchedCss.flatMap((css, i) => extractFonts(css, cssLinks[i])),
    ...importedCss.flatMap((css, i) => extractFonts(css, importHrefs[i])),
  ];
  const fontsFromGoogle = extractGoogleFontsFromLinks(html);
  const fontsFromInline = extractInlineFontFamilies(html);
  // Staple on what the site's own CSS says it PUTS each family on, before the
  // roles are decided — a family that is merely @font-face'd is not the display
  // face (vercel.com declares five GeistPixel* novelty cuts and was crowned by
  // declaration order). The counts ride along in `fonts` so resolveBrandIdentity
  // can re-classify later without the CSS. See ./font-roles.
  const fonts = annotateFontUsage(
    mergeFonts(fontsFromCss, fontsFromGoogle, fontsFromInline),
    allCss,
  );
  const font_roles = classifyFontRoles(fonts);
  // Palette tiers 1 + 2 — see mergePaletteByProvenance for the ordering and why
  // it exists. theme_color is NOT passed to extractPalette any more: it used to
  // be unshifted to the FRONT of the palette, and it is the weakest source we
  // have (3% of hosts declare one). It re-enters as the last tier in the merge.
  const namedBrandColors = extractNamedBrandColors(allCss);
  const cssPalette = extractPalette(allCss);
  // The page CANVAS color (Fuse burgundy #440b12) — the background the scenes
  // sit ON. SEPARATE from the signature accent (Fuse orange, the CTA hue). Read
  // by role from the share image so the Design Agent gets it as a hard
  // constraint instead of inferring the canvas and defaulting to near-black.
  let background_color: string | undefined;
  const motion_signal = classifyMotion(allCss);

  // CSS-frequency palette picks up site-builder DEFAULTS — Webflow's link-blue
  // out-counts the brand's real colors (fusefinance.com returned Webflow blue
  // #3898ec when the brand is deep maroon + orange). When a hero/share image is
  // available, read the TRUE palette off what actually renders. Two readers,
  // each strong where the other is weak:
  //   • vision (Haiku) — SELECTS the brand colors semantically (it knows Fuse's
  //     orange is an accent even though it's a tiny share-image area) but only
  //     ESTIMATES the hex by eye (#3d1625 for a true ~#440c12).
  //   • pixel clustering (sharp) — EXACT hex of whatever's prominent, but blind
  //     to small accents (misses that orange entirely).
  // So: vision selects, pixels correct. Snap each vision color to the nearest
  // precise pixel cluster when close; keep vision's value for accents pixels
  // didn't capture. Degrades cleanly: vision-only, then pixel-only, then CSS.
  // All best-effort (no key, no sharp binary, timeout → keep what we have).
  // ONE vision call (extractBrandColorRoles) feeds BOTH the flat palette and the
  // discrete background-color role — the role carries the canvas semantic the
  // flat palette loses.
  //
  // What CHANGED 2026-08-09: this block used to ASSIGN `palette` directly, so
  // whichever arm ran last won and the image beat the site's own stylesheet
  // every time (see mergePaletteByProvenance). It now produces a candidate list
  // that the merge admits only as corroboration. The background ROLE is
  // untouched — the canvas colour is genuinely a thing only the rendered page
  // knows, and no CSS-frequency ranking carries that semantic.
  let imagePalette: string[] = [];
  try {
    const pv = await paletteVisionP; // hoisted above — overlaps logo + CSS work
    if (!pv) throw new Error("palette vision unavailable");
    const [roles, pixelPalette] = pv;
    const visionPalette = [
      roles.background,
      roles.accent,
      roles.text,
      ...roles.supporting,
    ].filter((h): h is string => !!h);
    if (visionPalette.length >= 3 && pixelPalette.length >= 2) {
      imagePalette = refinePaletteWithPixels(visionPalette, pixelPalette);
    } else if (visionPalette.length >= 3) {
      imagePalette = visionPalette;
    } else if (pixelPalette.length >= 3) {
      imagePalette = pixelPalette.slice(0, 5); // pixel-only: trim noisy tail clusters
    }
    // Pixel-snap the background role to its exact homepage value when a cluster
    // is close (vision estimates the hex by eye); keep the vision value when the
    // canvas color isn't a prominent cluster pixels captured.
    if (roles.background) {
      background_color =
        pixelPalette.length > 0
          ? snapHexToPixels(roles.background, pixelPalette)
          : roles.background;
    }
  } catch {
    /* keep the CSS palette; the deterministic CSS canvas reader below fills bg */
  }
  // R1 (audit-2): with vision off (no z.ai) the try above never runs, so
  // background_color stayed undefined and resolveCanvasPlan fell to a dark-biased
  // palette path (Faire/Mailchimp shipped dark). Read the canvas deterministically
  // from the stylesheet whenever vision didn't supply one — light brands recover.
  if (!background_color) {
    background_color = extractCssCanvasBackground(allCss);
  }
  const palette = mergePaletteByProvenance({
    named: namedBrandColors,
    css: cssPalette,
    icon: await iconColorsP,
    image: imagePalette,
    themeColor: theme_color,
  });

  // Design-language analysis (best-effort): screenshot the LIVE homepage and read
  // its compositional design language — the qualitative layer that palette/fonts/
  // motion don't capture (type treatment, layout patterns, shape, imagery, mood).
  // Falls back to the og:image; any failure leaves both fields undefined and the
  // crawl proceeds unchanged.
  const { site_screenshot, design_language } = await designP; // hoisted above

  // ── v14 brand-truth verification (the Patagonia-failover class, at source) ──
  // 1. LOGO DECODE: fetch+decode the chosen mark AND the fallback icons. A dead
  //    candidate is blanked so pickLogo can't resurrect it at design time (the
  //    naturalWidth=0 class caught here, not at render).
  // 2. PHOTO VERIFICATION: page_images fetched+decoded in parallel (time-boxed
  //    ~5s); dead entries dropped before they can reach preallocated assets.
  // 3. ACCENT SANITY: when the resolved signature is neutral/missing, pull the
  //    logo's dominant chromatic color from the bytes we just fetched.
  // 4. Attach the structured BrandTruthReport. All best-effort — a probe
  //    failure must never turn a good crawl into a failed one.
  let logo_hd_final = logoResult?.url;
  let logo_confidence_final = logoResult?.confidence;
  let logo_source_final = logoResult?.source;
  let favicon_final = favicon;
  let apple_touch_final = apple_touch_icon;
  let page_images_final = page_images;
  let logo_color_final = logo_color;
  let brand_truth: BrandTruthReport | undefined;
  try {
    const [logoChain, photoCheck]: [LogoChainResult, PageImageVerification] =
      await Promise.all([
        verifyLogoChain([logoResult?.url, apple_touch_icon, favicon]),
        verifyPageImages(page_images, { budgetMs: 5_000 }),
      ]);
    // Blank every dead candidate — reject undecodable → next candidate → null.
    const dead = new Set(logoChain.deadUrls);
    if (logo_hd_final && dead.has(logo_hd_final)) {
      logo_hd_final = undefined;
      logo_confidence_final = undefined;
      logo_source_final = undefined;
    }
    if (apple_touch_final && dead.has(apple_touch_final)) apple_touch_final = undefined;
    if (favicon_final && dead.has(favicon_final)) favicon_final = undefined;
    page_images_final = photoCheck.kept;
    // Accent sanity: neutral/missing signature → logo dominant color fallback.
    const sigNow = signatureWithLogoFallback(palette, theme_color, logo_color_final, namedBrandColors);
    if ((sigNow === null || isNeutralAccentHex(sigNow)) && logoChain.effectiveBytes) {
      const fromLogo = await dominantColorFromImageBytes(logoChain.effectiveBytes);
      if (fromLogo && !isNeutralAccentHex(fromLogo)) logo_color_final = fromLogo;
    }
    brand_truth = assessBrandTruth(
      {
        url,
        title,
        description,
        og_image,
        theme_color,
        favicon: favicon_final,
        apple_touch_icon: apple_touch_final,
        logo_hd: logo_hd_final,
        logo_color: logo_color_final,
        headlines,
        body_excerpts,
        page_images: page_images_final,
        palette,
        background_color,
      },
      { logo: logoChain, photos: photoCheck },
    );
  } catch {
    // Verification is best-effort; fall back to the pure assessment.
    try {
      brand_truth = assessBrandTruth({
        url, title, description, og_image, theme_color,
        favicon: favicon_final, apple_touch_icon: apple_touch_final,
        logo_hd: logo_hd_final, logo_color: logo_color_final,
        headlines, body_excerpts, page_images: page_images_final,
        palette, background_color,
      });
    } catch { /* the report is advisory — never fail the crawl over it */ }
  }

  return {
    url,
    title,
    description,
    og_image,
    theme_color,
    favicon: favicon_final,
    apple_touch_icon: apple_touch_final,
    headlines,
    body_excerpts,
    site_lang,
    page_images: page_images_final,
    logo_hd: logo_hd_final,
    logo_confidence: logo_confidence_final,
    logo_source: logo_source_final,
    logo_color: logo_color_final,
    fonts,
    font_roles,
    palette,
    background_color,
    motion_signal,
    site_screenshot,
    design_language,
    brand_truth,
    fetched_at,
    ok: true,
  };
};

/**
 * Is this response body a page we can parse? An empty/absent content-type is
 * accepted (origins do omit it, and the parsers are all forgiving); a
 * content-type that positively names a non-HTML format is not.
 */
export const isHtmlContentType = (contentType: string | null): boolean => {
  const ct = (contentType ?? "").trim();
  if (!ct) return true;
  return /text\/html|application\/xhtml\+xml/i.test(ct);
};

// HONEST YIELD lives in lib/crawl/brand-identity.ts as `brandExtractYield`
// (another agent's file, landed in this same session). One predicate only: the
// UI banner and the BrandKit persistence gate must not be able to disagree about
// whether a brand was loaded, which is the bug that let "brand loaded from
// {url}" print over `palette: []`. What this file contributes to it is upstream
// and structural — a font role that holds `squarespace-ui-font` and a palette
// carrying a share-card hue both LOOK like yield to any predicate.

/**
 * R4b (audit-3): detect the brand's on-page copy LANGUAGE deterministically.
 *
 * PRIMARY — the `<html lang>` attribute off the FULL html string (NOT headSlice,
 * which begins at `<head>` and excludes the `<html>` tag). Captures a 2-letter
 * primary subtag with an optional region ("es", "pt-BR", "en-US"); a longer tag
 * like "es-419" degrades to its "es" primary subtag, which is what we want.
 *
 * FALLBACK — the dominant language of the crawled headlines/body-excerpts by
 * stopword + diacritic scoring, used only when the tag is absent. Returns a
 * non-English code ONLY when it clearly wins; English or an ambiguous/empty
 * signal returns undefined (→ the script defaults to English, which is correct).
 * This never mislabels an English site as Spanish and never overrides the tag.
 */
const LANG_STOPWORDS: Record<string, readonly string[]> = {
  es: ["el", "la", "los", "las", "de", "del", "que", "con", "para", "por", "una", "tus", "sus", "más", "envío", "pedir", "ahora", "gratis", "todo", "hasta", "compra", "tu", "en"],
  pt: ["de", "que", "com", "para", "você", "não", "uma", "seu", "mais", "grátis", "pedido", "agora", "tudo", "até", "fazer", "voce", "os", "as"],
  fr: ["le", "la", "les", "des", "une", "pour", "avec", "vous", "votre", "plus", "tout", "sur", "nous", "est", "vos"],
  de: ["der", "die", "das", "und", "für", "mit", "sie", "ihre", "auf", "ist", "ein", "eine", "nicht", "alle", "wir"],
  it: ["il", "la", "le", "dei", "una", "per", "con", "tuo", "più", "tutto", "non", "gli", "che", "sul"],
  en: ["the", "and", "for", "with", "your", "you", "our", "get", "all", "more", "free", "now", "of", "is", "to", "we"],
};
const DIACRITIC_LANGS: Array<[string, RegExp]> = [
  ["es", /[ñ¿¡áéíóúü]/i],
  ["pt", /[ãõçáâêó]/i],
  ["fr", /[çàèùâêîôûëï]/i],
  ["de", /[äöüß]/i],
  ["it", /[àèìòù]/i],
];
export const detectSiteLang = (html: string, copy: string[]): string | undefined => {
  const tag = /<html[^>]*\blang=["']([a-z]{2}(?:-[A-Z]{2})?)/i.exec(html)?.[1];
  if (tag) return tag;
  const text = copy.join(" ").toLowerCase();
  if (text.trim().length < 12) return undefined; // empty SPA → English default
  const words = text.split(/[^\p{L}]+/u).filter((w) => w.length > 1);
  if (words.length < 6) return undefined;
  const wordSet = words; // multiset — count repeats
  const scores: Record<string, number> = {};
  for (const [lang, stop] of Object.entries(LANG_STOPWORDS)) {
    const set = new Set(stop);
    scores[lang] = wordSet.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  }
  for (const [lang, rx] of DIACRITIC_LANGS) if (rx.test(text)) scores[lang] += 4;
  let best = "en";
  for (const lang of Object.keys(scores)) if (scores[lang] > scores[best]) best = lang;
  // Only override the English default when a non-English language clearly wins:
  // a real signal (≥3) AND a margin over English (guards Spanglish marketing copy).
  if (best === "en" || scores[best] < 3 || scores[best] - scores.en < 2) return undefined;
  return best;
};

// ─── HTML parsing ─────────────────────────────────────────────────────

const extractTitle = (html: string): string | undefined => {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1]?.trim();
};

const extractMetaName = (
  html: string,
  name: string,
): string | undefined => {
  const re1 = new RegExp(
    `<meta[^>]+name=["']${escapeRegex(name)}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegex(name)}["']`,
    "i",
  );
  return html.match(re1)?.[1]?.trim() ?? html.match(re2)?.[1]?.trim();
};

const extractMetaProperty = (
  html: string,
  property: string,
): string | undefined => {
  const re1 = new RegExp(
    `<meta[^>]+property=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegex(property)}["']`,
    "i",
  );
  return html.match(re1)?.[1]?.trim() ?? html.match(re2)?.[1]?.trim();
};

const extractLinkRel = (
  html: string,
  relPattern: RegExp,
): string | undefined => {
  const linkTags = html.match(/<link\s[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] ?? "";
    if (!relPattern.test(rel)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) return href.trim();
  }
  return undefined;
};

const extractHeadlines = (html: string): string[] => {
  // Match h1/h2/h3 with dedup. Brand sites often repeat the hero headline
  // in a visually-hidden a11y wrapper, so deduplication is required.
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < 8) {
    const inner = match[1] ?? "";
    const txt = (decode(stripTags(inner)) ?? "").trim();
    if (txt.length < 2 || txt.length > 200) continue;
    const norm = txt.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(txt);
  }
  return out;
};

/**
 * Pull body-copy excerpts so Agent 1 can stick to the brand's actual claims.
 *
 * Extracts:
 *   - <p> tags with substantive content (20-400 chars)
 *   - <li> tags with text (10-200 chars)
 *   - Aria-labelled elements with role attributes
 *
 * Deduplicates by normalized text. Caps at 12 excerpts to bound token cost
 * downstream.
 */
const extractBodyExcerpts = (html: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) && out.length < 12) {
      const inner = match[1] ?? "";
      const txt = (decode(stripTags(inner)) ?? "").trim();
      if (txt.length < 20 || txt.length > 400) continue;
      // Skip boilerplate
      if (/cookie|privacy policy|terms of (use|service)|all rights reserved/i.test(txt)) continue;
      const norm = txt.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(txt);
    }
  }
  return out;
};

/**
 * Pull <img> URLs from the body so we can surface real product imagery to
 * the agents instead of just the favicon/og-image.
 *
 * Filters:
 *   - format must be png/jpg/jpeg/webp/svg/gif (no data-URIs unless SVG > 500 bytes)
 *   - skips known tracking pixels (1x1, common analytics paths)
 *   - dedup by URL
 *   - cap 8 images (token cost + relevance fall-off)
 */
/**
 * Strip out "logo grid" / "trusted by" / "customer marquee" containers
 * from the HTML before image extraction. On marketing sites these
 * containers are usually 5-20 customer logos packed as <img> tags,
 * and they're the #1 reason the agents end up mounting a customer
 * logo as if it were the brand's own mark.
 *
 * The filter matches the OPENING tag's class/id/data-* attribute
 * for any of: trusted, customer, partner, client, logos-grid/-cloud
 * /-marquee/-strip/-list/-wall/-bar, brands-grid/-cloud/-marquee,
 * featured-in, as-seen-in, press, case-stud, integration, social-proof.
 * Then removes everything until the matching closing tag.
 *
 * Operates on common containers: section, div, ul, aside.
 */
const LOGO_GRID_CLASS_RX =
  /(?:^|\s|[-_])(trusted|customer|client|partner|press|featured[-_]?in|as[-_]?seen[-_]?in|case[-_]?stud|integration|social[-_]?proof|logos?[-_]?(?:grid|cloud|marquee|strip|list|wall|bar|row|carousel)|brands?[-_]?(?:grid|cloud|marquee|strip|list|wall|bar|row|carousel))(?:[-_\s]|$)/i;

const stripLogoGridContainers = (html: string): string => {
  let out = html;
  // Match opening container tag with attributes; check if any
  // class/id/data-attr matches the logo-grid pattern; if so, find the
  // matching close and excise the whole range.
  // We loop because nested containers may match too — repeated passes
  // until no more matches.
  const tags = ["section", "div", "ul", "aside"];
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const tag of tags) {
      const openRx = new RegExp(
        `<${tag}\\b([^>]*)>`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = openRx.exec(out))) {
        const attrs = match[1];
        if (!LOGO_GRID_CLASS_RX.test(attrs)) continue;
        // Find the matching close tag, handling nested same-tag pairs.
        const openTag = `<${tag}`;
        const closeTag = `</${tag}>`;
        const closeRx = new RegExp(
          `${openTag}\\b|${closeTag}`,
          "gi",
        );
        closeRx.lastIndex = match.index + match[0].length;
        let depth = 1;
        let endIdx = -1;
        let m2: RegExpExecArray | null;
        while ((m2 = closeRx.exec(out))) {
          if (m2[0].toLowerCase().startsWith(closeTag.toLowerCase())) {
            depth -= 1;
            if (depth === 0) {
              endIdx = m2.index + m2[0].length;
              break;
            }
          } else {
            depth += 1;
          }
        }
        if (endIdx < 0) break;
        // Excise the entire range.
        out = out.slice(0, match.index) + out.slice(endIdx);
        changed = true;
        openRx.lastIndex = 0; // restart for this tag
      }
    }
    if (!changed) break;
  }
  return out;
};

const extractPageImages = (
  html: string,
  baseUrl: string,
): { src: string; alt?: string }[] => {
  const out: { src: string; alt?: string }[] = [];
  const seen = new Set<string>();
  // Same "looks like a customer/partner-logo grid" filter as discoverLogoHd.
  // Without this, the page_images list on a Webflow site ends up as 8
  // customer logos with no Fuse/brand product imagery anywhere.
  const customerLogoCtxRx =
    /\b(customer|client|partner|trusted[-_]?by|press|featured[-_]?in|as[-_]?seen[-_]?in|logo[-_]?grid|logo[-_]?cloud|logos[-_]?grid|case[-_]?stud|testimonial|integration)/i;
  const re = /<img\s[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < 8) {
    const tag = match[0];
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const rawSrc = srcMatch[1].trim();
    const haystack = tag.toLowerCase();

    // Skip data-URIs except substantial SVGs
    if (rawSrc.startsWith("data:")) {
      if (!rawSrc.startsWith("data:image/svg+xml") || rawSrc.length < 500) continue;
    }
    // Skip 1x1 tracking pixels (common patterns)
    if (/[\?&](pixel|tracking|t=|p=)/i.test(rawSrc)) continue;
    if (/\b(1x1|spacer|blank|pixel)\.(gif|png)/i.test(rawSrc)) continue;
    // Format check (skip URLs without an obvious image extension AND without query)
    if (!/\.(png|jpe?g|webp|svg|gif|avif)(\?|$)/i.test(rawSrc) && !rawSrc.startsWith("data:")) {
      continue;
    }
    // Skip customer-logo / partner-grid imagery — these aren't the brand's
    // own product imagery and lead the agent to mount someone else's logo.
    if (customerLogoCtxRx.test(haystack)) continue;
    const filename = rawSrc.split("/").pop() ?? "";
    if (/^[A-Z]{2,6}[._-]/.test(filename)) continue;
    if (/_[A-Z]{2,6}\.(png|svg|webp|jpg|jpeg)(\?|$)/.test(filename)) continue;
    const resolved = resolveMaybe(rawSrc, baseUrl);
    if (!resolved) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    out.push({ src: resolved, alt: altMatch?.[1]?.trim() || undefined });
  }
  return out;
};

/**
 * Discover the brand's high-resolution logo (NOT the favicon).
 *
 * Try in order:
 *   1. <img> tags whose src/alt/class contains "logo" (excluding favicon paths)
 *   2. Common static paths: /logo.svg, /static/logo.svg, /img/logo.png, /assets/logo.png
 *   3. Clearbit Logo API fallback: https://logo.clearbit.com/{domain}?size=512
 *
 * Returns undefined if nothing usable is found.
 */
/**
 * Discover the brand's high-resolution logo via a vision-evaluated
 * agent (lib/crawl/find-logo-agent.ts).
 *
 * Old approach: priority-chain that returned the FIRST plausible
 * candidate (Clearbit → og:image → static paths → header <img>). Failed
 * for brands like Fuse whose og:image is a share-card screenshot, not
 * a logo. Agent now evaluates ALL candidates with vision and picks
 * the actual brand mark — OR returns nothing, in which case the
 * wizard prompts the user to upload.
 */
const discoverLogoHd = async (
  html: string,
  baseUrl: string,
  ogImage: string | undefined,
  appleTouchIcon: string | undefined,
  faviconUrl: string | undefined,
  brandTitle: string | undefined,
  onUsage?: CrawlUsageCollector,
): Promise<{ url: string; confidence: number; source: string } | undefined> => {
  let baseHostname: string;
  try {
    baseHostname = new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }

  // Cache hit → skip the candidate sweep + vision agent. Repeat crawls of the
  // same domain are instant + deterministic (and can't regress a good result to
  // a flaky one).
  const cached = await readLogoCache(baseHostname);
  if (cached) return cached;

  const candidates = await collectLogoCandidates(
    html,
    baseUrl,
    baseHostname,
    ogImage,
    appleTouchIcon,
    faviconUrl,
  );
  if (candidates.length === 0) return undefined;

  // Lazy-import the agent so the crawl module stays standalone when
  // ANTHROPIC_API_KEY isn't configured (e.g. CLI tests).
  const { findBrandLogo } = await import("./find-logo-agent");
  const result = await findBrandLogo(baseHostname, brandTitle, candidates, {
    onUsage,
  });
  if (result.ok) {
    const out = {
      url: result.url,
      confidence: result.confidence,
      source: result.source,
    };
    await writeLogoCache(baseHostname, out); // only successes are cached
    return out;
  }
  // Agent rejected all candidates → return undefined so the wizard
  // prompts the user to upload a logo PNG/SVG.
  return undefined;
};

/**
 * Extract the logo's dominant chromatic color (QA G1). When the crawled palette
 * is achromatic — greyscale marketing boilerplate, common on Webflow sites — the
 * brand's real color often survives only inside the logo mark. Decode the
 * discovered logo when it's an SVG (data: URI or `.svg` URL) and pull the most
 * vivid color out via dominantSvgColor. Raster logos (PNG/JPG) return undefined:
 * pulling a color from those needs pixel clustering, which is out of scope here.
 * Best-effort — any fetch/parse failure yields undefined and the signature
 * simply falls back to null (monochrome treatment).
 */
const logoColorFromUrl = async (
  url: string | undefined,
): Promise<string | undefined> => {
  if (!url) return undefined;
  let svg: string | null = null;
  try {
    if (url.startsWith("data:")) {
      if (!/^data:image\/svg/i.test(url)) return undefined;
      const comma = url.indexOf(",");
      if (comma === -1) return undefined;
      const header = url.slice(0, comma);
      const payload = url.slice(comma + 1);
      svg = /;base64/i.test(header)
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
    } else if (/\.svg(\?|#|$)/i.test(url)) {
      const r = await safeFetch(url, {
        signal: AbortSignal.timeout(4_000),
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      if (!r.ok) return undefined;
      const ct = r.headers.get("content-type") ?? "";
      // Tolerate a missing/incorrect content-type but reject obvious non-SVG.
      if (ct && !/svg|xml/i.test(ct)) return undefined;
      svg = await r.text();
    } else {
      return undefined; // raster — no SVG color extraction
    }
  } catch {
    return undefined;
  }
  if (!svg) return undefined;
  return dominantSvgColor(svg) ?? undefined;
};

/**
 * Build the candidate list passed to the logo agent. Each candidate
 * is a real, fetched URL — we HEAD-probe Clearbit + static paths so
 * the agent doesn't waste vision tokens on dead links. Returns up to
 * ~10 candidates; the agent picks one (or NONE).
 */
const collectLogoCandidates = async (
  html: string,
  baseUrl: string,
  baseHostname: string,
  ogImage: string | undefined,
  appleTouchIcon: string | undefined,
  faviconUrl: string | undefined,
): Promise<import("./find-logo-agent").LogoCandidate[]> => {
  const out: import("./find-logo-agent").LogoCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    url: string | undefined,
    source: import("./find-logo-agent").LogoCandidate["source"],
    hint?: string,
  ) => {
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, source, hint });
  };

  // 1. Clearbit Logo API (HEAD-probe; only include if 200).
  try {
    const clearbit = `https://logo.clearbit.com/${baseHostname}?size=512`;
    const res = await safeFetch(clearbit, {
      method: "HEAD",
      signal: AbortSignal.timeout(3_000),
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (res.ok) add(clearbit, "clearbit", "Clearbit returns the brand's mark by domain");
  } catch {
    // skip
  }

  // 2. Common same-origin static paths (probe in parallel).
  const staticPaths = [
    "/logo.svg",
    "/static/logo.svg",
    "/assets/logo.svg",
    "/images/logo.svg",
    "/img/logo.svg",
    "/logo.png",
    "/assets/logo.png",
    "/images/logo.png",
  ];
  const staticProbes = await Promise.all(
    staticPaths.map(async (path) => {
      try {
        const candidate = new URL(path, baseUrl).toString();
        const res = await safeFetch(candidate, {
          method: "HEAD",
          signal: AbortSignal.timeout(2_000),
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
        });
        if (res.ok && res.headers.get("content-type")?.startsWith("image/")) {
          return candidate;
        }
      } catch {
        // skip
      }
      return null;
    }),
  );
  for (const url of staticProbes) {
    if (url) add(url, "static-path", "Same-origin /logo.* path — brand likely placed this deliberately");
  }

  // 3. Header/nav <img> tags (same-origin OR brand-name in filename).
  const headerImgs = collectHeaderImgs(html, baseUrl, baseHostname);
  for (const url of headerImgs) {
    add(url, "header-img", "Image found inside <header>/<nav>");
  }

  // 3b. Inline <svg> + CSS background-image marks in <header>/<nav>. The brand's
  //     real logo is often NOT an <img> (inline SVG on Webflow/React, or a CSS
  //     background div) — this is the Fuse miss. Highest-prior on-page source.
  const vectors = collectHeaderVectorsAndBg(html, baseUrl, baseHostname);
  for (const url of vectors.svgDataUrls) {
    add(url, "inline-svg", "Inline <svg> in the site's header/nav — usually the brand's own mark");
  }
  for (const url of vectors.bgUrls) {
    add(url, "css-bg", "CSS background-image in header/nav — sometimes the brand logo");
  }

  // 4. simple-icons brand match. Heuristic: hostname's first label
  //    (e.g. "stripe" from stripe.com) checked against the package's
  //    slug map. We import lazily to keep cold-start fast.
  try {
    const slug = baseHostname.split(".")[0].toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const si = await import("simple-icons");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icon = (si as any)[`si${slug.charAt(0).toUpperCase()}${slug.slice(1)}`];
    if (icon?.svg) {
      // simple-icons exports inline SVG strings; agent can't fetch a string.
      // Encode as a data: URL so the vision block can render it.
      const dataUrl =
        "data:image/svg+xml;base64," +
        Buffer.from(icon.svg).toString("base64");
      add(dataUrl, "simple-icons", `simple-icons brand match: ${icon.title}`);
    }
  } catch {
    // simple-icons not available or no match — skip
  }

  // 5. Apple touch icon (180x180, always brand-correct but low-res).
  add(appleTouchIcon, "apple-touch", "180x180 — low-res but always the brand");

  // 6. og:image (could be share-card hero, NOT logo — agent decides).
  add(ogImage, "og-image", "OG share image — sometimes a logo, often a hero screenshot");

  // 7. Favicon (last resort).
  add(faviconUrl, "favicon", "Favicon — tiny but always the brand");

  return out;
};

/**
 * Inline-vector + CSS-background logo candidates from <header>/<nav>.
 *
 * The brand's real mark is frequently an inline <svg> (Webflow / React inline
 * their nav logo) or a <div> with a CSS background-image — NEITHER is an <img>,
 * so collectHeaderImgs misses both. This was the Fuse failure: the actual logo
 * was an inline nav <svg>, never a candidate, so the agent fell back to the
 * screenshot apple-touch-icon.
 *
 * Inline SVGs are scored (logo-marked / first-in-header / wide-aspect = keep;
 * tiny-square / menu-search-cart context = drop) and returned as data: URLs so
 * the logo agent can rasterize + SEE them. Anthropic vision rejects raw SVG, so
 * the agent rasterizes these to PNG before the vision pass.
 */
const LOGO_CTX_RX = /\b(logo|brand|wordmark|site-?title|navbar-?brand)\b/i;
const ICON_CTX_RX =
  /\b(menu|hamburger|search|cart|basket|close|toggle|chevron|arrow|caret|social|hamburger|burger)\b/i;

/**
 * Header/nav regions to scan for the brand mark. Beyond semantic <header>/<nav>,
 * grab a window around the first brand-link (w-nav-brand / *logo-link / navbar
 * brand) — Webflow/React render the navbar as a <div class="navbar... w-nav">,
 * NOT a <nav> tag, so the logo lives OUTSIDE <header>/<nav>. That was the Fuse
 * miss: its inline-svg wordmark sat in a Webflow navbar div and was never
 * scanned. Shared by collectHeaderImgs + collectHeaderVectorsAndBg.
 */
const getHeaderRegions = (html: string): string[] => {
  const regions: string[] = [];
  const h = html.match(/<header\b[\s\S]*?<\/header>/gi);
  const n = html.match(/<nav\b[\s\S]*?<\/nav>/gi);
  if (h) regions.push(...h);
  if (n) regions.push(...n);
  const brandIdx = html.search(
    /\bw-nav-brand\b|class=["'][^"']*(?:nav-?brand|logo-?link|logo-?block|logo-?wrap|site-?logo|header-?logo|navbar[^"']*logo|brand[^"']*logo)[^"']*["']/i,
  );
  if (brandIdx >= 0) {
    const aStart = html.lastIndexOf("<a", brandIdx);
    const start = Math.max(0, (aStart >= 0 ? aStart : brandIdx) - 40);
    // 4000 chars: a wordmark <svg> with one path per letter runs ~2KB+ (Fuse's
    // is 2170) — too small a window truncates it before </svg> and the match fails.
    regions.push(html.slice(start, brandIdx + 4000)); // brand link + its logo
  }
  if (regions.length === 0) regions.push(html.slice(0, 8_000));
  return regions;
};

const collectHeaderVectorsAndBg = (
  html: string,
  baseUrl: string,
  baseHostname: string,
): { svgDataUrls: string[]; bgUrls: string[] } => {
  const region = getHeaderRegions(html).join("\n");

  // ── inline <svg> marks ──────────────────────────────────────────
  const svgDataUrls: string[] = [];
  const scored: { svg: string; score: number }[] = [];
  const svgRe = /<svg\b[\s\S]*?<\/svg>/gi;
  let sm: RegExpExecArray | null;
  let i = 0;
  // Scan generously — navbars stack many UI-glyph SVGs (menu, social, arrows)
  // and the brand mark can sit after them. Scoring filters the glyphs out.
  while ((sm = svgRe.exec(region)) !== null && i < 30) {
    const svg = sm[0];
    const before = region.slice(Math.max(0, sm.index - 160), sm.index);
    const attrs = svg.match(/<svg\b([^>]*)>/i)?.[1] ?? "";
    let score = 0;
    if (LOGO_CTX_RX.test(attrs) || LOGO_CTX_RX.test(before)) score += 3;
    if (i === 0) score += 2; // first svg in a header is usually the brand mark
    const vb = svg.match(/viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
    const w = vb ? parseFloat(vb[1]) : parseFloat(svg.match(/\bwidth=["']?([\d.]+)/i)?.[1] ?? "0");
    const h = vb ? parseFloat(vb[2]) : parseFloat(svg.match(/\bheight=["']?([\d.]+)/i)?.[1] ?? "0");
    if (w && h) {
      const aspect = w / h;
      if (aspect >= 1.6) score += 1; // wide → wordmark
      if (Math.max(w, h) < 32 && aspect > 0.7 && aspect < 1.4) score -= 3; // tiny square icon
    }
    if (ICON_CTX_RX.test(attrs) || ICON_CTX_RX.test(before)) score -= 2;
    scored.push({ svg, score });
    i++;
  }
  scored
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .forEach(({ svg }) => {
      const withNs = /xmlns=/.test(svg)
        ? svg
        : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      svgDataUrls.push(
        "data:image/svg+xml;base64," + Buffer.from(withNs).toString("base64"),
      );
    });

  // ── CSS background-image marks ──────────────────────────────────
  const bgUrls: string[] = [];
  const seenBg = new Set<string>();
  const bgRe = /background(?:-image)?\s*:\s*[^;"']*url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = bgRe.exec(region)) !== null && bgUrls.length < 3) {
    const raw = bm[1];
    if (!/\.(png|jpe?g|webp|svg)(\?|#|$)/i.test(raw)) continue;
    if (/favicon|sprite|icon-\d/i.test(raw)) continue;
    const resolved = resolveMaybe(raw, baseUrl);
    if (!resolved || seenBg.has(resolved)) continue;
    seenBg.add(resolved);
    try {
      const host = new URL(resolved).hostname.replace(/^www\./, "");
      const brandLabel = baseHostname.split(".")[0].toLowerCase();
      const fn = (resolved.split("/").pop() ?? "").toLowerCase();
      if (
        host === baseHostname ||
        (brandLabel.length >= 4 && fn.includes(brandLabel)) ||
        /logo|brand|wordmark/.test(fn)
      ) {
        bgUrls.push(resolved);
      }
    } catch {
      // skip malformed
    }
  }

  return { svgDataUrls, bgUrls };
};

const collectHeaderImgs = (
  html: string,
  baseUrl: string,
  baseHostname: string,
): string[] => {
  const out: string[] = [];
  const regions = getHeaderRegions(html);

  const customerLogoCtxRx =
    /\b(customer|client|partner|trusted[-_]?by|press|featured[-_]?in|as[-_]?seen[-_]?in|logo[-_]?grid|logo[-_]?cloud|logos?[-_]?grid|case[-_]?stud|testimonial|integration)/i;
  const seen = new Set<string>();

  for (const region of regions) {
    const imgRe = /<img\s[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = imgRe.exec(region))) {
      const tag = match[0];
      // Logos are often lazy-loaded (data-src) or only in srcset — fall back to
      // both so a deferred nav logo still becomes a candidate.
      const srcMatch =
        tag.match(/\bsrc=["']([^"']+)["']/i) ||
        tag.match(/\bdata-src=["']([^"']+)["']/i) ||
        tag.match(/\bsrcset=["']([^"',\s]+)/i);
      if (!srcMatch) continue;
      const src = srcMatch[1];
      const haystack = tag.toLowerCase();
      if (/favicon|icon-\d+x|x32\.png|x16\.png/i.test(src)) continue;
      if (!/\.(png|jpe?g|webp|svg)(\?|$)/i.test(src)) continue;
      if (customerLogoCtxRx.test(haystack)) continue;
      const filename = src.split("/").pop() ?? "";
      if (/^[A-Z]{2,6}[._-]/.test(filename)) continue;
      if (/_[A-Z]{2,6}\.(png|svg|webp|jpg|jpeg)(\?|$)/.test(filename)) continue;
      const resolved = resolveMaybe(src, baseUrl);
      if (!resolved || seen.has(resolved)) continue;
      try {
        const imgHost = new URL(resolved).hostname.replace(/^www\./, "");
        const brandLabel = baseHostname.split(".")[0].toLowerCase();
        const matchesBrand =
          brandLabel.length >= 4 && filename.toLowerCase().includes(brandLabel);
        if (imgHost === baseHostname || matchesBrand) {
          seen.add(resolved);
          out.push(resolved);
          if (out.length >= 4) return out;
        }
      } catch {
        // skip malformed
      }
    }
  }
  return out;
};

const extractInlineStyles = (html: string): string => {
  const matches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  return matches
    .map((m) => m.replace(/<style[^>]*>/i, "").replace(/<\/style>/i, ""))
    .join("\n");
};

const extractStylesheetLinks = (html: string, baseUrl: string): string[] => {
  const linkTags = html.match(/<link\s[^>]*>/gi) ?? [];
  const hrefs: string[] = [];
  for (const tag of linkTags) {
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] ?? "";
    if (!/(?:^|\s)stylesheet(?:\s|$)/i.test(rel)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const resolved = resolveMaybe(href, baseUrl);
    if (resolved) hrefs.push(resolved);
  }
  return Array.from(new Set(hrefs));
};

// Font-service hosts whose @import'd CSS most likely carries brand fonts.
// Followed first so MAX_IMPORTED_SHEETS favors fonts over generic UI imports.
const FONT_IMPORT_HINT_RX =
  /typekit|adobe|fonts\.googleapis|fonts\.bunny|fontshare|cloud\.typography|fonts\.net|fast\.fonts|fontawesome/i;

// Parse `@import url("…")` / `@import "…"` targets out of CSS. Resolves to
// absolute http(s) URLs (font-service imports are always absolute) and orders
// known font-service hosts first.
const extractCssImports = (css: string, baseUrl: string): string[] => {
  // Two forms: `@import url(<target>)` (target may be quoted; capture to the
  // closing paren so embedded `;` like Google's `wght@400;700` survives) and
  // `@import "<target>"` (capture to the closing quote). Bare unquoted targets
  // ending at `;`/whitespace are the legacy fallback.
  const rx =
    /@import\s+(?:url\(\s*["']?([^)"']+)["']?\s*\)|["']([^"']+)["']|([^\s;"']+))/gi;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(css)) !== null) {
    const target = m[1] || m[2] || m[3];
    if (!target) continue;
    const resolved = resolveMaybe(target, baseUrl);
    if (resolved && /^https?:\/\//i.test(resolved)) urls.push(resolved);
  }
  const ordered = [
    ...urls.filter((u) => FONT_IMPORT_HINT_RX.test(u)),
    ...urls.filter((u) => !FONT_IMPORT_HINT_RX.test(u)),
  ];
  return Array.from(new Set(ordered));
};

const fetchCss = async (href: string): Promise<string> => {
  try {
    const res = await safeFetch(href, {
      signal: AbortSignal.timeout(CSS_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/css,*/*;q=0.1",
      },
      redirect: "follow",
    });
    if (!res.ok) return "";
    const text = await res.text();
    return text.slice(0, MAX_CSS_BYTES);
  } catch {
    return "";
  }
};

// ─── CSS parsing ──────────────────────────────────────────────────────

export const extractFonts = (
  css: string,
  baseUrl: string,
): CrawledFont[] => {
  const fonts: CrawledFont[] = [];
  const seenSrc = new Set<string>();
  const blocks = css.match(/@font-face\s*\{[^}]*\}/gi) ?? [];

  for (const block of blocks) {
    const family = block
      .match(/font-family\s*:\s*["']?([^;"',)]+)["']?/i)?.[1]
      ?.trim();
    if (!family) continue;

    // src can have many url() entries; pick the first woff2 if available,
    // else first url. Format hint follows the url in CSS.
    const urlMatches = Array.from(
      block.matchAll(
        /url\(\s*["']?([^)"']+)["']?\s*\)\s*(?:format\(\s*["']?([^)"']+)["']?\s*\))?/gi,
      ),
    );
    const preferred =
      urlMatches.find(
        (m) => /woff2/i.test(m[2] ?? "") || /\.woff2(\?|$)/i.test(m[1]),
      ) ?? urlMatches[0];
    if (!preferred) continue;
    const src = resolveMaybe(preferred[1], baseUrl);
    if (!src || seenSrc.has(src)) continue;
    seenSrc.add(src);

    const weight = block
      .match(/font-weight\s*:\s*([^;]+);/i)?.[1]
      ?.trim();
    const style = block.match(/font-style\s*:\s*([^;]+);/i)?.[1]?.trim();
    const format =
      preferred[2]?.trim().replace(/['"]/g, "").split(/[\s-]/)[0] ??
      inferFormatFromUrl(src);

    fonts.push({
      family,
      src,
      weight,
      style,
      format,
    });
    if (fonts.length >= 12) break;
  }

  return fonts;
};

const inferFormatFromUrl = (url: string): string | undefined => {
  const m = url.match(/\.(woff2|woff|ttf|otf|eot)(\?|$)/i);
  return m?.[1]?.toLowerCase();
};

/**
 * Parse Google Fonts <link> tags directly out of the HTML head. The
 * URL itself carries family names — we don't need to fetch the CSS.
 * Supports both the modern css2 API and the legacy css API:
 *   - css2?family=Inter:wght@400;700&family=Lora:ital@1
 *   - css?family=Roboto:400,700|Open+Sans:400|Playfair+Display
 *
 * Returns a CrawledFont per family with src pointing at the Google
 * Fonts CSS URL (for transparency; the agent doesn't fetch it).
 *
 * This path catches the common modern setup where the entire font
 * stack lives in a single fonts.googleapis.com link and there are
 * NO @font-face declarations anywhere else on the page.
 */
const extractGoogleFontsFromLinks = (html: string): CrawledFont[] => {
  const out: CrawledFont[] = [];
  const linkTags = html.match(/<link\s[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (!/fonts\.googleapis\.com\/css/i.test(href)) continue;

    // Decode HTML entities so &amp;family=... resolves.
    const decoded = href.replace(/&amp;/g, "&");

    // css2 API: ?family=Foo:wght@400;700&family=Bar:ital@1
    const css2Re = /family=([^&]+)/g;
    let m: RegExpExecArray | null;
    while ((m = css2Re.exec(decoded)) !== null) {
      const familyExpr = decodeURIComponent(m[1]);
      // Strip the spec after the colon (weight/ital/style) — only the
      // bit before is the family name. + signs decode to spaces.
      const family = familyExpr.split(":")[0].replace(/\+/g, " ").trim();
      if (!family) continue;
      // Pull weights from the spec if present (wght@400;700;900 → 400 700 900)
      const weightMatch = familyExpr.match(/wght@([\d;,\s]+)/);
      const weight = weightMatch?.[1].replace(/[;,]/g, " ").trim();
      out.push({
        family,
        src: href,
        weight,
        format: "woff2",
      });
    }

    // Legacy css API: ?family=Roboto:400,700|Open+Sans:400
    if (!/css2\?/.test(href) && /\/css\?/.test(href)) {
      const familiesParam = decoded.match(/family=([^&]+)/)?.[1];
      if (familiesParam) {
        const families = decodeURIComponent(familiesParam).split("|");
        for (const f of families) {
          const family = f.split(":")[0].replace(/\+/g, " ").trim();
          if (family) {
            out.push({
              family,
              src: href,
              format: "woff2",
            });
          }
        }
      }
    }
  }
  return out;
};

/**
 * Scan inline `style="font-family:..."` attributes and the `<body>`
 * computed style declarations in `<style>` blocks. Catches sites that
 * load fonts via JS (Adobe Fonts / Typekit) or that name a system font
 * stack only — neither shows up in @font-face.
 *
 * Returns CrawledFonts without a `src` URL (we have no way to host the
 * file). The Design Agent treats sourceless fonts as "use the family
 * name, fall back to system" — still better than emitting system-ui.
 */
const extractInlineFontFamilies = (html: string): CrawledFont[] => {
  const families = new Set<string>();

  // 1. <body class="..." style="font-family: Foo, ...">
  const bodyStyleMatch = html.match(/<body[^>]*\sstyle=["']([^"']+)["']/i);
  if (bodyStyleMatch) {
    const fam = bodyStyleMatch[1].match(/font-family\s*:\s*([^;]+)/i)?.[1];
    if (fam) extractFirstFamily(fam).forEach((f) => families.add(f));
  }

  // 2. <style>body { font-family: Foo, ... }</style> and h1/h2/h3 rules
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  for (const block of styleBlocks) {
    // body / html / h1-h3 selectors — heuristic for "the main text font"
    const rules = block.matchAll(
      /(?:^|\s|,)(body|html|h[1-6])\b[^{]*\{[^}]*?font-family\s*:\s*([^;}]+)/gi,
    );
    for (const r of rules) {
      extractFirstFamily(r[2]).forEach((f) => families.add(f));
    }
  }

  return Array.from(families).map((family) => ({
    family,
    src: "",
  }));
};

/**
 * Pull the first 1-2 family names out of a CSS font-family value.
 * Skips generic families (sans-serif, serif, monospace, system-ui, etc.)
 * and obviously-quoted brand families.
 *
 * Input: `"Inter", "Helvetica Neue", system-ui, sans-serif`
 * Output: ["Inter", "Helvetica Neue"]
 */
const extractFirstFamily = (raw: string): string[] => {
  const names = raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length > 0 && !GENERIC_FAMILIES.has(s.toLowerCase()));
  return names.slice(0, 2);
};

/**
 * Merge CSS @font-face fonts + Google Fonts <link> fonts + inline
 * font-family fonts. Dedupe by family name (case-insensitive). CSS
 * @font-face wins for any family it found (it has src + weight metadata
 * the other paths don't). Google + inline fill in families CSS missed.
 */
const mergeFonts = (
  fromCss: CrawledFont[],
  fromGoogle: CrawledFont[],
  fromInline: CrawledFont[],
): CrawledFont[] => {
  const seen = new Map<string, CrawledFont>();
  const add = (f: CrawledFont) => {
    const key = f.family.toLowerCase();
    if (!seen.has(key)) seen.set(key, f);
  };
  fromCss.forEach(add);
  fromGoogle.forEach(add);
  fromInline.forEach(add);
  return Array.from(seen.values()).slice(0, 12);
};

// The font-role classifier moved to ./font-roles — see that file's header for
// why (the answer stopped being about NAMES and became about USE). Re-exported
// here because site-brand.ts, brand-identity.ts and two test files import it
// from this module and there is no reason to churn their import lines.
export {
  annotateFontUsage,
  classifyFontRoles,
  extractFontUsage,
  normalizeFamilyName,
  type CrawledFont,
  type FontRoles,
  type FontUsage,
} from "./font-roles";

// ----- Palette ---------------------------------------------------------

export const extractPalette = (
  css: string,
  themeColor?: string,
): string[] => {
  const counts = new Map<string, number>();

  // hex colors: #abc / #aabbcc / #aabbccdd
  const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  for (const raw of hexMatches) {
    const hex = normalizeHex(raw);
    if (!hex) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  // rgb()/rgba()
  const rgbMatches =
    css.match(
      /rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*[^)]+)?\)/gi,
    ) ?? [];
  for (const raw of rgbMatches) {
    const m = raw.match(/(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
    if (!m) continue;
    const r = clamp255(parseInt(m[1], 10));
    const g = clamp255(parseInt(m[2], 10));
    const b = clamp255(parseInt(m[3], 10));
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  // Score: frequency, but drop anything without enough colour in it to BE a
  // brand accent. The old bar here was isVeryNearMonochrome (chroma <= 8),
  // which is a grey detector, not a brand-colour detector: it passed gitlab's
  // #171321, mailchimp's #231e15, clerk's #222a35, render's #373145 and
  // monzo's #091723 — dark page furniture that is the most FREQUENT hex on
  // those sites and therefore led each palette. See BRAND_CHROMA_FLOOR.
  const ranked = Array.from(counts.entries())
    .filter(([hex]) => isChromatic(hex))
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);

  // Always include the theme_color if we have one and it's not already present.
  if (themeColor) {
    const norm = normalizeHex(themeColor);
    if (norm && !ranked.includes(norm)) {
      ranked.unshift(norm);
    }
  }

  // Dedupe near-duplicate colors (within ~12 in RGB space) preferring
  // the one earlier in the ranking.
  const final: string[] = [];
  for (const hex of ranked) {
    const isClose = final.some((kept) => rgbDistance(kept, hex) < 12);
    if (!isClose) final.push(hex);
    if (final.length >= 8) break;
  }

  return final;
};

// ─── Palette provenance ────────────────────────────────────────────────
//
// The palette used to be assembled by LAST WRITER WINS: extractPalette read the
// stylesheet, then the og:image arm REASSIGNED `palette` in every branch that
// succeeded — so the CSS palette survived only when the image arm failed
// outright. Measured over 60 live sites on 2026-08-09: 6/6 spot-checks had a
// final palette byte-identical to `pixelPalette.slice(0,5)`. stripe.com's own
// stylesheet declares #635bff and the crawl shipped the ORANGE of its share
// card; raycast's #ff6363 became five near-blacks; posthog's #f54e00 became
// olive; anthropic's #d97757 became greys.
//
// Colours now arrive in PROVENANCE order — how strong the site's own claim on
// the colour is — and a weaker source can never displace a stronger one:
//
//   1. css-var-named   a custom property the site NAMED brand/primary/accent
//                      (51% of hosts). The site literally told us.
//   2. css-stylesheet  chromatic hexes from the site's own CSS (81%), minus
//                      TEMPLATE_COLORS below.
//   3. site-icon       the favicon / apple-touch icon's dominant chroma (25% /
//                      15%). Startlingly accurate where present: stripe→#533afd
//                      (true #635bff), raycast→#ff6666 (true #ff6363),
//                      robinhood→#ccff00, cloudflare→#ff5500.
//   4. image           og:image pixels + the vision read — CORROBORATION ONLY.
//   5. theme-color     <meta name=theme-color>, declared by 3% of hosts.
//
export type PaletteSource =
  | "css-var-named"
  | "css-stylesheet"
  | "site-icon"
  | "image"
  | "theme-color";

/**
 * Colours that belong to a TEMPLATE, never to the brand.
 *
 * The first eight travel TOGETHER in Squarespace's social-links block
 * stylesheet — they are the SOCIAL PLATFORMS' brand colours (Facebook #3b5998,
 * GitHub #4183c4, LinkedIn #0976b4, Instagram #e4405f, …) shipped on every
 * Squarespace site whether or not it links to any of them. Measured in the
 * 60-site sweep (2026-08-09): #3b5998 sits in the CSS palette of 16 hosts and is
 * the TOP-ranked chromatic colour on 8 of them — a small business's whole
 * palette read as Facebook blue. 42% of the small-business corpus is on a site
 * builder, so this is not an edge case.
 *
 * Webflow's default link-blue is the same bug in a different flavour, and this
 * file already knew about it in prose (fusefinance.com returned #3898ec when the
 * brand is deep maroon + orange) without ever acting on it. One list now.
 *
 * ESCAPE HATCH: a hex here is dropped only when the site does NOT also name it
 * in a --brand/--primary/--accent custom property. A brand whose colour really
 * is Facebook blue keeps it by declaring it.
 */
const TEMPLATE_COLORS: Record<string, string> = {
  "#3b5998": "Facebook — Squarespace social block",
  "#0099e5": "social platform — Squarespace social block",
  "#0063dc": "Flickr — Squarespace social block",
  "#4183c4": "GitHub — Squarespace social block",
  "#e4405f": "Instagram — Squarespace social block",
  "#0976b4": "LinkedIn — Squarespace social block",
  "#f94877": "social platform — Squarespace social block",
  "#f0523d": "social platform — Squarespace social block",
  "#3898ec": "Webflow default link blue",
};

const hslOfHexLocal = (
  hex: string,
): { h: number; s: number; l: number } | null => {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const { r, g, b } = hexToRgb(norm);
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
  const mx = Math.max(rr, gg, bb),
    mn = Math.min(rr, gg, bb);
  const l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l };
  const d = mx - mn;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (mx === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60;
  else if (mx === gg) h = ((bb - rr) / d + 2) * 60;
  else h = ((rr - gg) / d + 4) * 60;
  return { h, s, l };
};

/**
 * ABSOLUTE chroma — max(r,g,b) − min(r,g,b), 0…255. The honest "how much colour
 * is in here at all" measure, and the one HSL saturation is not.
 *
 * WHY THIS EXISTS. HSL `s` is a RATIO, so it explodes towards black and white:
 * the near-black #171321 (gitlab's page background) reports s = 0.27 and the
 * near-white cream #eee9e2 (a dropbox `--…brand__coconut_600` token) reports
 * s = 0.26 — both cleared the old `s >= 0.25` bar and both read as grey to a
 * human. Shopify's #71717a, the grey the brief caught winning outright, has an
 * absolute chroma of 9 and cleared `isVeryNearMonochrome`'s `<= 8` by ONE.
 */
const chromaRange = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

/**
 * The floor a colour must clear to be a brand colour at all, measured rather
 * than guessed. Over the 38-site tune half (2026-08-09) the LEAST colourful
 * true brand accent is slack's aubergine #4a154b at chroma 54; the neutrals
 * that were beating real accents top out at 27 (#0e1029 nativecos, #091723
 * monzo, #373145 render, #222a35 clerk, #231e15 mailchimp, #171321 gitlab,
 * #eee9e2 dropbox, #71717a shopify). 32 sits in that gap with a 22-point
 * margin under the lowest real accent, so it is not a knife-edge cut.
 */
const BRAND_CHROMA_FLOOR = 32;

/**
 * "Is this a colour at all, as opposed to structure?" Same bar the deterministic
 * icon reader uses (dominantColorFromImageBytes in brand-truth.ts) so the tiers
 * agree: enough saturation to read as a hue, not sunk into black or blown out to
 * white. Deliberately looser than isSignatureCandidate (which additionally wants
 * mid-luminance) — a pale brand tint belongs in the palette even when it can't
 * be the signature.
 *
 * The chroma floor is applied HERE, which means a custom property the site
 * NAMED `--brand-…` is subject to it too. A named token that resolves to a grey
 * is still a grey.
 */
const isChromatic = (hex: string): boolean => {
  const c = hslOfHexLocal(hex);
  if (!c || c.s < 0.25 || c.l <= 0.08 || c.l >= 0.92) return false;
  return chromaRange(hex) >= BRAND_CHROMA_FLOOR;
};

/**
 * How strongly a colour reads as A BRAND HUE: absolute chroma, gently penalized
 * away from mid-luminance.
 *
 * This used HSL `s` and that measure cannot rank a brand ramp. `s` pins to 1.0
 * for EVERY colour with a zero channel, so within one ramp the DARKEST step
 * always won: blueland declares `--brand-10 … --brand-95` and the old score put
 * #0033a7 (s 1.00) above the real #133cd1 (s 0.83), 47 away from truth, purely
 * because #0033a7's red channel is 0. Absolute chroma separates them the way an
 * eye does — #133cd1 carries 190 of chroma, #0033a7 only 167 — and it is the
 * same number the BRAND_CHROMA_FLOOR gate is expressed in, so the two agree.
 */
const vividness = (hex: string): number => {
  const c = hslOfHexLocal(hex);
  if (!c) return -1;
  return (chromaRange(hex) / 255) * (1 - Math.abs(c.l - 0.5) * 0.6);
};

const hslToHex = (h: number, s: number, l: number): string => {
  const sat = Math.max(0, Math.min(1, s));
  const lum = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = lum - c / 2;
  return `#${toHex(clamp255(Math.round((r1 + m) * 255)))}${toHex(clamp255(Math.round((g1 + m) * 255)))}${toHex(clamp255(Math.round((b1 + m) * 255)))}`;
};

/** Every `--x: value` in the stylesheet, FIRST definition winning — a later
 *  `prefers-color-scheme: dark` override must not clobber the base value. */
const collectCssVars = (allCss: string): Map<string, string> => {
  const vars = new Map<string, string>();
  for (const m of allCss.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
    if (!vars.has(m[1])) vars.set(m[1], m[2].trim());
  }
  return vars;
};

/** Substitute `var(--x[, fallback])` from the custom-property table, bounded so
 *  a self-referential chain can't spin. */
const expandCssVars = (
  value: string,
  vars: Map<string, string>,
  depth = 0,
): string => {
  if (depth > 4 || !/var\(/i.test(value)) return value;
  const next = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/gi,
    (_m, name: string, fallback: string | undefined) =>
      vars.get(name) ?? fallback ?? "",
  );
  return next === value ? value : expandCssVars(next, vars, depth + 1);
};

// Squarespace declares the site owner's palette as a BARE HSL TRIPLE
// (`--accent-hsl: 21.99,100%,31.57%`) consumed as `hsla(var(--accent-hsl),1)`.
// Probed on the sweep's Squarespace hosts 2026-08-09 — maonoseattle.com's
// `--accent-hsl` is its deep orange, kasestyles.com's is its tan. That triple is
// what the owner picked in the theme editor: the strongest colour claim a site
// builder ever gives us, and the old reader threw it away because it is not a
// CSS colour token.
const BARE_HSL_RX = /^(-?[\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%$/;
const HSL_FN_RX =
  /hsla?\(\s*(-?[\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?))?\s*\)/i;

/** A custom-property VALUE → #rrggbb: hex / rgb() / hsl() / Squarespace's bare
 *  HSL triple, with var() references resolved first. null when it isn't a
 *  colour (font stacks, sizes, unresolvable var chains) or is transparent. */
const cssBrandColorToHex = (
  raw: string,
  vars: Map<string, string>,
): string | null => {
  const v = expandCssVars(raw, vars).trim();
  const fn = HSL_FN_RX.exec(v);
  if (fn) {
    const a =
      fn[4] == null ? 1
      : fn[4].endsWith("%") ? parseFloat(fn[4]) / 100
      : parseFloat(fn[4]);
    if (!(a > 0.05)) return null;
    return hslToHex(parseFloat(fn[1]), parseFloat(fn[2]) / 100, parseFloat(fn[3]) / 100);
  }
  const bare = BARE_HSL_RX.exec(v);
  if (bare) {
    return hslToHex(parseFloat(bare[1]), parseFloat(bare[2]) / 100, parseFloat(bare[3]) / 100);
  }
  return cssColorToHex(v);
};

// A property whose NAME claims the brand. Kept to brand/primary/accent — the
// floor probe also tried theme/main/key and those pull in furniture
// (`--swiper-theme-color: #007aff` is Swiper's default, present on liquiddeath
// and posthog; `--color-theme-bg-cta` is Shopify's).
const BRAND_PROP_NAME_RX = /^--[\w-]*(?:brand|primary|accent)[\w-]*$/i;
// …except when the name also says it belongs to a THIRD-PARTY WIDGET. Measured:
// `--si-primary` / `--social-links-block-main-icon-color` (Squarespace social
// icons, every Squarespace host) and `--cookiebot-primary-color: #141414`
// (toadbakery.com) match the brand pattern and are chrome.
//
// The Shopify-app prefixes were measured the same way TEMPLATE_COLORS was: the
// SAME hex on two unrelated stores is the app's default, not either brand.
// `--recharge-color-brand: #467c99` (ReCharge subscriptions) is byte-identical
// on hellotushy.com and nativecos.com, and on both it beat the real accent —
// hellotushy's own #71a7f4 is the most frequent chromatic hex in its stylesheet,
// nativecos' #0a1f8f is corroborated by its own favicon (#002277, 26 away).
// `--oke-` is Okendo reviews, `--loop-` is Loop returns, `--flyout-` is a cart
// drawer. All are prefix-anchored so a real token like `--brand-loop` is safe.
const CHROME_PROP_NAME_RX =
  /^--si-|^--recharge-|^--oke-|^--loop-|^--flyout-|social|cookie|swiper|videojs/i;

// A property naming a TEXT/ICON/BORDER role is describing where a colour is
// painted, not claiming it is the brand. Measured: sentry.io's ONLY named token
// is `--text-primary: #362d59` (a dark violet used for body copy, 127 from the
// real #6a5fc1 — which sentry's own stylesheet carries as its most frequent
// chromatic hex and its theme-color meta). monzo declares
// `--semantic-content-primary: #091723` alongside the real `--color-brand`, and
// dropbox declares `--color__glyph__primary: #1e1919`.
//
// `background`/`surface`/`fill` are deliberately NOT here: Squarespace's
// `--primaryButtonBackgroundColor` is thesaucycow's real accent, and a CTA fill
// is one of the strongest brand claims a stylesheet makes.
const ROLE_PROP_NAME_RX = /(?:^|[-_])(?:text|glyph|content|border|divider|outline|shadow|ring|caret|placeholder)(?:$|[-_])/i;

// How strong the NAME's claim is. "brand" is the site saying this colour IS the
// brand; "accent" is the weakest — a design system's whole secondary scale is
// named that way. Measured on stripe.com: ranking by vividness alone led its
// palette with #ff9014 out of `--hds-color-accentColorMode-lemon-icon-*`, a
// theme-mode illustration gradient, while `--hds-color-core-brand-600` (#533afd,
// Stripe purple) sat below it. Same shape on klarna.com, where
// `--colors-bg-brand` is the pink and `--colors-bg-accent` is a purple.
const BRAND_PROP_RANK: [RegExp, number][] = [
  [/brand/i, 0],
  [/primary/i, 1],
  [/accent/i, 2],
];
const brandPropRank = (name: string): number =>
  BRAND_PROP_RANK.find(([rx]) => rx.test(name))?.[1] ?? 3;

/**
 * Palette tier 1 — colours the site NAMED brand / primary / accent.
 *
 * Sorted by name strength, then how many properties AGREE, then vividness —
 * NOT by source order. A brand ramp is declared lightest-first (stripe.com's
 * first `--hds-color-core-brand-*` is #f5f5ff, a 25-step tint of its purple),
 * so "first declared" would lead the palette with a near-white; within one
 * named ramp the most vivid step is the brand hue and the rest are washes of it.
 *
 * A colour is scored over EVERY property that resolves to it, not the first one
 * seen. The old `seen` set froze both rank and identity at first sight, and
 * source order is arbitrary, so a colour could be locked to a weaker name than
 * the site actually gave it: hubspot declares #ff4800 as `--light-theme-
 * hubspot-brand-01` (rank "brand") AND as `--light-theme-button-primary-fill-
 * idle` (rank "primary"), the primary one appears first in the sheet, and the
 * orange was therefore ranked below a tint that happened to own a `brand` name.
 *
 * VOTES is the same corroboration argument the icon tier makes, applied inside
 * one source: a real brand colour gets referenced by many tokens (dropbox's
 * #0061fe by six, thesaucycow's #e55937 by five) while a derived tint is
 * referenced once (thesaucycow's `--darkAccent-hsl` #bd005b, which used to lead
 * its palette 104 away from truth).
 */
export const extractNamedBrandColors = (allCss: string): string[] => {
  if (!allCss) return [];
  const vars = collectCssVars(allCss);
  // NO VOTE COUNTING. Ranking by how MANY tokens resolve to a hex was measured
  // and removed: held out on 14 sites it cost more than it bought — asana went
  // #f06a6a (its actual brand red) to #879fc8, a pale UI blue that merely
  // appeared under more names. It bought exactly one row on the half it was
  // tuned against and lost one on the half it had never seen, which is the
  // definition of fitting the sample rather than the problem. Popularity among
  // token names is not brand-ness; a design system names its greys the most.
  const byHex = new Map<string, { hex: string; rank: number }>();
  for (const [name, value] of vars) {
    if (!BRAND_PROP_NAME_RX.test(name)) continue;
    if (CHROME_PROP_NAME_RX.test(name)) continue;
    if (ROLE_PROP_NAME_RX.test(name)) continue;
    const hex = cssBrandColorToHex(value, vars);
    if (!hex || !isChromatic(hex)) continue;
    const rank = brandPropRank(name);
    const prev = byHex.get(hex);
    if (prev) {
      // Keep the STRONGEST name a hex ever appeared under. That is what fixed
      // hubspot, dropbox and thesaucycow — verified by ablation, not the vote
      // count they were once credited to.
      prev.rank = Math.min(prev.rank, rank);
    } else {
      byHex.set(hex, { hex, rank });
    }
  }
  return Array.from(byHex.values())
    .sort((a, b) => a.rank - b.rank || vividness(b.hex) - vividness(a.hex))
    .slice(0, 4)
    .map((c) => c.hex);
};

/**
 * Palette tier 3 — the dominant CHROMA of the site's own icons.
 *
 * The crawl already fetched the favicon as a LOGO candidate but never mined it
 * for colour unless the accent had resolved neutral. It is one of the most
 * accurate deterministic sources we have and it is the site's own file, so it
 * outranks anything read off a share card. Best-effort: an .ico that sharp
 * can't decode, a 404, a monochrome mark → nothing, and the tier is simply
 * absent. Favicon first: it is the one measured against known brand hexes.
 */
const ICON_COLOR_TIMEOUT_MS = 4_000;
const iconAccentColors = async (
  urls: (string | undefined)[],
): Promise<string[]> => {
  const wanted = urls.filter((u): u is string => !!u).slice(0, 2);
  if (wanted.length === 0) return [];
  const found = await Promise.all(
    wanted.map(async (url) => {
      try {
        const res = await safeFetch(url, {
          signal: AbortSignal.timeout(ICON_COLOR_TIMEOUT_MS),
          headers: { "User-Agent": USER_AGENT, Accept: "image/*,*/*;q=0.5" },
          redirect: "follow",
        });
        if (!res.ok) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > 4_000_000) return null;
        return await dominantColorFromImageBytes(bytes);
      } catch {
        return null;
      }
    }),
  );
  return found.filter((h): h is string => !!h && isChromatic(h));
};

/**
 * Assemble the palette from the provenance tiers. Pure — the network work
 * happens in the callers, so this is directly testable.
 *
 * The load-bearing rule is tier 4. An og:image colour may CORROBORATE a colour
 * the site already declares (the near-duplicate merge then keeps the
 * deterministic hex, which is the exact one), but it may not introduce a NEW hue
 * while the site's own stylesheet or icons have one. That is precisely the
 * Stripe failure: the stylesheet says #635bff, the share card is orange, and the
 * orange won. When NO deterministic tier yields chroma — 19% of hosts, an
 * all-image site with a JS-injected stylesheet — the image tier is all we have
 * and it becomes the palette exactly as before.
 */
/**
 * Two independent reads DISAGREEING is evidence, and this is the one place we
 * act on it.
 *
 * When the site names no --brand/--primary/--accent token at all, the head of
 * the CSS tier is nothing more than "the most frequent chromatic hex in the
 * stylesheet" — the weakest deterministic signal we have, and the one that put
 * a page background at the top of gitlab's, clerk's, render's and mailchimp's
 * palettes. The favicon is a genuinely INDEPENDENT read: a different file,
 * decoded rather than parsed. When it disagrees SHARPLY with that weak
 * candidate, the stylesheet candidate is furniture and the icon is the brand.
 * duolingo.com is the case: its stylesheet's one chromatic colour is #00b086
 * (a teal from a promo band, 161 from the real green) and its own favicon reads
 * #77cc00 — 31 from Duolingo green.
 *
 * Three conditions, and the third is what makes it safe. Without it,
 * deathwishcoffee.com — whose favicon is a black skull reading #330000 — would
 * lose its correct #e12727 to a near-black. A favicon that carries LESS chroma
 * than the stylesheet candidate is a silhouette, not a brand colour.
 *
 * Measured over the 8 tune sites where the rule is eligible (no named token AND
 * a favicon colour): it fires once, on duolingo, and correctly abstains on the
 * other seven — discord, mailchimp, raycast, neon, netlify, drinkolipop agree
 * with their icons already, and deathwishcoffee is held back by the chroma
 * guard. It deliberately does NOT let the favicon outrank a NAMED token:
 * slack's favicon reads #33ccff off the four-colour hash and would have taken
 * its palette from the real #4a154b to a cyan.
 */
const ICON_DISAGREEMENT_MIN = 90; // = the scorer's WRONG band: a whole hue apart

const iconOverridesCss = (
  named: string[],
  css: string[],
  icon: string[],
): boolean => {
  if (named.length > 0 || icon.length === 0 || css.length === 0) return false;
  return (
    rgbDistance(css[0], icon[0]) >= ICON_DISAGREEMENT_MIN &&
    vividness(icon[0]) > vividness(css[0])
  );
};

export const mergePaletteByProvenance = (tiers: {
  named: string[];
  css: string[];
  icon: string[];
  image: string[];
  themeColor?: string;
}): string[] => {
  const named = tiers.named.map((h) => h.toLowerCase());
  const namedSet = new Set(named);
  const allowed = (hex: string): boolean =>
    !TEMPLATE_COLORS[hex.toLowerCase()] || namedSet.has(hex.toLowerCase());
  const css = tiers.css.filter(allowed);
  const icon = tiers.icon.filter(allowed);
  const deterministic = [
    ...tiers.named,
    ...(iconOverridesCss(named, css, icon) ? [icon[0], ...css] : [...css, ...icon]),
  ];
  const image = deterministic.some(isChromatic)
    ? [] // corroboration only — see the doc comment
    : tiers.image.filter(allowed);
  const themeHex = tiers.themeColor ? normalizeHex(tiers.themeColor) : null;
  const ordered = [...deterministic, ...image, ...(themeHex ? [themeHex] : [])];

  // Same near-duplicate rule extractPalette applies within the CSS tier, so a
  // colour doesn't appear twice just because two sources agree on it — and the
  // FIRST (highest-provenance) spelling of it is the one kept.
  const final: string[] = [];
  for (const raw of ordered) {
    const hex = normalizeHex(raw);
    if (!hex) continue;
    if (final.some((kept) => rgbDistance(kept, hex) < 12)) continue;
    final.push(hex);
    if (final.length >= 8) break;
  }
  return final;
};

/** Map a single CSS color TOKEN (hex, rgb(), rgba(), or the white/black
 *  keywords) to a #rrggbb, or null when it is transparent / unrecognized. */
const cssColorToHex = (raw: string): string | null => {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || /^(?:transparent|none|inherit|initial|unset|currentcolor)$/.test(v)) return null;
  if (v === "white") return "#ffffff";
  if (v === "black") return "#000000";
  const hex = v.match(/#[0-9a-f]{3,8}\b/i);
  if (hex) {
    const h = hex[0].slice(1);
    if (h.length === 8 && h.slice(6) === "00") return null; // fully transparent
    if (h.length === 4 && h[3] === "0") return null;
    return normalizeHex(hex[0]);
  }
  const rgb = v.match(/rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*([0-9.]+%?))?\s*\)/i);
  if (rgb) {
    const a = rgb[4] != null ? (rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])) : 1;
    if (!(a > 0.05)) return null; // effectively transparent
    return `#${toHex(clamp255(parseInt(rgb[1], 10)))}${toHex(clamp255(parseInt(rgb[2], 10)))}${toHex(clamp255(parseInt(rgb[3], 10)))}`;
  }
  return null;
};

/**
 * R1 (audit-2) — DETERMINISTIC CSS canvas-background reader. `background_color`
 * was set ONLY inside the vision try (extractBrandColorRoles); with vision off
 * (no z.ai) it stayed undefined and resolveCanvasPlan fell to a dark-biased
 * palette path — which is exactly why Faire/Mailchimp (real canvas: white/cream)
 * built DARK across the phase-3 loop. Read the page canvas straight from the
 * concatenated stylesheet instead: the background(-color) declared on the root
 * layout selectors (body / html / :root / #__next / #root / main, in that
 * priority), resolving a `var(--x)` against the custom-property table, first
 * OPAQUE color wins. Pure string math — no network, no vision. Returns undefined
 * when no rooted background is declared (resolveCanvasPlan then falls back).
 */
export const extractCssCanvasBackground = (allCss: string): string | undefined => {
  if (!allCss) return undefined;
  // 1) custom-property table for var() resolution (first definition wins — a
  //    later `prefers-color-scheme: dark` override does not clobber the base).
  const vars = new Map<string, string>();
  for (const m of allCss.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
    if (!vars.has(m[1])) vars.set(m[1], m[2].trim());
  }
  const resolve = (value: string, depth = 0): string | null => {
    if (depth > 4) return null;
    const v = value.trim();
    const varM = v.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/i);
    if (varM) {
      const ref = vars.get(varM[1]);
      if (ref) { const r = resolve(ref, depth + 1); if (r) return r; }
      return varM[2] ? resolve(varM[2], depth + 1) : null;
    }
    return cssColorToHex(v);
  };
  // 2) each rule's selector-list + decls (non-nested; inner rules inside a
  //    @media block still match individually, which is what we want).
  const targets = ["body", "html", ":root", "#__next", "#root", "main"];
  const byTarget = new Map<string, string[]>();
  for (const m of allCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1];
    for (const t of targets) {
      const re = new RegExp(`(?:^|,)\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,|$)`, "i");
      if (re.test(selectors)) byTarget.set(t, [...(byTarget.get(t) ?? []), m[2]]);
    }
  }
  for (const t of targets) {
    for (const decls of byTarget.get(t) ?? []) {
      const bgColor = decls.match(/(?:^|;|\s)background-color\s*:\s*([^;]+)/i);
      const bg = decls.match(/(?:^|;|\s)background\s*:\s*([^;]+)/i);
      for (const cand of [bgColor?.[1], bg?.[1]]) {
        const hex = cand ? resolve(cand) : null;
        if (hex) return hex;
      }
    }
  }
  return undefined;
};

const normalizeHex = (raw: string): string | null => {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.startsWith("#")) return null;
  const hex = trimmed.slice(1);
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  if (hex.length === 4) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  if (hex.length === 6) return `#${hex}`;
  if (hex.length === 8) return `#${hex.slice(0, 6)}`;
  return null;
};

// isVeryNearMonochrome lived here: `max - min <= 8`, the only bar the CSS
// palette had to clear. Removed 2026-08-09 — it is a GREY detector, not a
// brand-colour detector, and shopify.com's #71717a cleared it by one point and
// led that site's palette. Its job is now done by isChromatic + the measured
// BRAND_CHROMA_FLOOR.

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
};

const rgbDistance = (a: string, b: string): number => {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return Math.sqrt(
    (ca.r - cb.r) ** 2 + (ca.g - cb.g) ** 2 + (ca.b - cb.b) ** 2,
  );
};

const clamp255 = (n: number): number =>
  Math.max(0, Math.min(255, isNaN(n) ? 0 : n));

const toHex = (n: number): string => n.toString(16).padStart(2, "0");

// ----- Motion signal ---------------------------------------------------

export type MotionSignal = "high" | "medium" | "low";

export const classifyMotion = (css: string): MotionSignal => {
  const keyframes = (css.match(/@(?:-webkit-)?keyframes\s/gi) ?? []).length;
  const animations = (css.match(/\banimation\s*:/gi) ?? []).length;
  const transitions = (css.match(/\btransition\s*:/gi) ?? []).length;
  // Weight keyframes more heavily — they imply choreographed motion.
  const score = keyframes * 4 + animations * 2 + transitions;
  if (score >= 60) return "high";
  if (score >= 15) return "medium";
  return "low";
};

// ─── Helpers ─────────────────────────────────────────────────────────

const normalizeUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.hostname.length === 0) return null;
    return u.toString();
  } catch {
    return null;
  }
};

const resolveMaybe = (
  ref: string | undefined,
  baseUrl: string,
): string | undefined => {
  if (!ref) return undefined;
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return undefined;
  }
};

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, "");

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const decode = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
};
