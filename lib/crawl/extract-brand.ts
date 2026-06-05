import type { BrandExtract } from "../../app/new/schema";
import {
  extractPaletteFromImage,
  extractPaletteFromPixels,
  refinePaletteWithPixels,
} from "./vision-brand";

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
): Promise<BrandExtract> => {
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
    const res = await fetch(url, {
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
    html = await res.text();
  } catch (err) {
    return {
      url,
      fetched_at,
      ok: false,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Pull HTML signals.
  const headSlice =
    html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 50_000);
  const bodySlice = html.slice(0, 80_000);

  const title = decode(extractTitle(headSlice));
  const description = decode(extractMetaName(headSlice, "description"));
  const og_image = resolveMaybe(
    extractMetaProperty(headSlice, "og:image"),
    url,
  );
  const theme_color = extractMetaName(headSlice, "theme-color");
  const favicon = resolveMaybe(
    extractLinkRel(headSlice, /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/i),
    url,
  );
  const apple_touch_icon = resolveMaybe(
    extractLinkRel(headSlice, /(?:^|\s)apple-touch-icon(?:\s|$)/i),
    url,
  );
  const headlines = extractHeadlines(bodySlice);
  const body_excerpts = extractBodyExcerpts(bodySlice);
  // Strip logo-grid containers from the body BEFORE extracting page_images
  // and discovering the brand logo. Marketing sites (Webflow especially)
  // pack customer/partner logos into "Trusted by" carousels — we don't
  // want any of those reaching the agents as either "the brand's logo"
  // or "real product imagery."
  const bodyWithoutLogoGrids = stripLogoGridContainers(bodySlice);
  const page_images = extractPageImages(bodyWithoutLogoGrids, url);
  const logoResult = await discoverLogoHd(
    bodyWithoutLogoGrids,
    url,
    og_image,
    apple_touch_icon,
    favicon,
    title,
  );

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
  const fontsFromCss = extractFonts(allCss, url);
  const fontsFromGoogle = extractGoogleFontsFromLinks(html);
  const fontsFromInline = extractInlineFontFamilies(html);
  const fonts = mergeFonts(fontsFromCss, fontsFromGoogle, fontsFromInline);
  const font_roles = classifyFontRoles(fonts);
  let palette = extractPalette(allCss, theme_color);
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
  try {
    const [visionPalette, pixelPalette] = await Promise.all([
      extractPaletteFromImage(og_image),
      extractPaletteFromPixels(og_image, { maxColors: 8 }),
    ]);
    if (visionPalette.length >= 3 && pixelPalette.length >= 2) {
      palette = refinePaletteWithPixels(visionPalette, pixelPalette);
    } else if (visionPalette.length >= 3) {
      palette = visionPalette;
    } else if (pixelPalette.length >= 3) {
      palette = pixelPalette.slice(0, 5); // pixel-only: trim noisy tail clusters
    }
  } catch {
    /* keep the CSS palette */
  }

  return {
    url,
    title,
    description,
    og_image,
    theme_color,
    favicon,
    apple_touch_icon,
    headlines,
    body_excerpts,
    page_images,
    logo_hd: logoResult?.url,
    logo_confidence: logoResult?.confidence,
    logo_source: logoResult?.source,
    fonts,
    font_roles,
    palette,
    motion_signal,
    fetched_at,
    ok: true,
  };
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
): Promise<{ url: string; confidence: number; source: string } | undefined> => {
  let baseHostname: string;
  try {
    baseHostname = new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }

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
  const result = await findBrandLogo(baseHostname, brandTitle, candidates);
  if (result.ok)
    return { url: result.url, confidence: result.confidence, source: result.source };
  // Agent rejected all candidates → return undefined so the wizard
  // prompts the user to upload a logo PNG/SVG.
  return undefined;
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
    const res = await fetch(clearbit, {
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
        const res = await fetch(candidate, {
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
    /\bw-nav-brand\b|class=["'][^"']*(?:nav-?brand|logo-?link|navbar[^"']*logo|brand[^"']*logo)[^"']*["']/i,
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
    const res = await fetch(href, {
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

export interface CrawledFont {
  family: string;
  src: string;
  weight?: string; // raw CSS value, e.g. "400", "700", "100 900"
  style?: string; // "normal" | "italic"
  format?: string; // "woff2" | "woff" | "ttf" | "otf"
}

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
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "revert",
]);
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

/**
 * Classify the crawled fonts into three roles: display (large headlines),
 * body (paragraphs/lede), mono (URLs/code/diegetic UI).
 *
 * Heuristic — family names usually signal role. We don't render to detect
 * x-height / contrast, so we lean on naming conventions:
 *   - MONO:  contains "mono", "code", "courier", "consol", "menlo", "fira code",
 *            "jetbrains", "ibm plex mono", "source code"
 *   - DISPLAY: serif-feeling family names ("tiempos", "merriweather",
 *              "playfair", "lora", "freight", "garamond", "caslon", "bodoni",
 *              "didot", "minion", "miller", "noe", "times", "georgia",
 *              "serif" in name), OR contains "headline" / "display" hint
 *   - BODY: everything else (sans-serif default)
 *
 * Returns the FIRST family matching each role (the most "canonical" pick).
 * If a role has no match, the caller falls back to system fonts.
 */
export interface FontRoles {
  display?: string;
  body?: string;
  mono?: string;
}

/**
 * Icon-font name patterns — these are not text fonts and must NOT be
 * routed to display/body/mono roles. Common offenders:
 *   - webflow-icons (Webflow's stock icon set, dropped on every site)
 *   - material-icons / material-symbols-* (Google Material icons)
 *   - fa-* / Font Awesome
 *   - icon-* / glyph* / glyphicons (generic naming)
 *   - simple-icons (brand-logo glyphs)
 * Without this filter, the first @font-face block on most Webflow sites
 * (which is webflow-icons) was being picked as the display font, then
 * routed onto h1/h2/h3 elements — garbling them into icon-glyph soup.
 */
// Catches: prefix `icon-foo`, AND the `<brand>-icons` / `<brand>_icon` SUFFIX
// form (`swiper-icons`, `oatly-icons` — these slipped through the prefix-only
// pattern and got routed onto headlines as a "display font", forcing a generic
// serif fallback). The suffix alternative requires a word + `-icon(s)`, so real
// names like `sodimac` or `Recoleta` are NOT caught.
const ICON_FONT_RX =
  /\b(webflow-?icons?|material-?(?:icons?|symbols?(?:-[a-z]+)?)|font[\s-]*awesome|fa-[a-z0-9-]+|icon-[a-z0-9-]+|[a-z0-9]+[-_]icons?|glyph[a-z0-9-]*|simple-?icons|remixicon|feather-?icons|hero-?icons|lucide-?icons|bootstrap-?icons|ionicons|tabler-?icons|phosphor-?icons|octicons|ant-?design[-_]?icons|line-?icons|streamline)\b/i;

const MONO_RX =
  /\b(mono|code|courier|consol|menlo|jetbrains|ibm[\s-]*plex[\s-]*mono|source[\s-]*code|fira[\s-]*code|roboto[\s-]*mono|space[\s-]*mono)\b/i;
const SERIF_RX =
  /\b(tiempos|merriweather|playfair|lora|freight|garamond|caslon|bodoni|didot|minion|miller|noe|times|georgia|cambria|baskerville|crimson|cormorant|libre[\s-]*baskerville|source[\s-]*serif|noto[\s-]*serif|roboto[\s-]*serif|pt[\s-]*serif|sentinel|chronicle|gt[\s-]*super|portrait|larken|fraunces|signifier|romana|literata|recoleta|reckless|romie|domaine|saol)\b/i;
const DISPLAY_HINT_RX = /\b(headline|display|hero|h1|h2|title)\b/i;
const SERIF_FAMILY_RX = /\bserif\b/i; // catches "X Serif" naming

export const classifyFontRoles = (fonts: CrawledFont[]): FontRoles => {
  const roles: FontRoles = {};
  for (const f of fonts) {
    const name = f.family;
    if (!name) continue;
    // Skip icon fonts entirely — they're not text faces and routing
    // them onto h*/p/span would render headlines as icon glyphs.
    if (ICON_FONT_RX.test(name)) continue;
    if (!roles.mono && MONO_RX.test(name)) {
      roles.mono = name;
      continue;
    }
    if (
      !roles.display &&
      (SERIF_RX.test(name) ||
        DISPLAY_HINT_RX.test(name) ||
        SERIF_FAMILY_RX.test(name))
    ) {
      roles.display = name;
      continue;
    }
    if (!roles.body) {
      roles.body = name;
    }
  }
  // Reasonable fallbacks: if we have a body but no display, the body family
  // becomes the display too (still better than system-ui). If display but no
  // body, body falls back to display.
  if (!roles.display && roles.body) roles.display = roles.body;
  if (!roles.body && roles.display) roles.body = roles.display;
  return roles;
};

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

  // Score: frequency, but penalize near-grays / pure black-or-white so
  // brand accents float to the top.
  const ranked = Array.from(counts.entries())
    .filter(([hex]) => !isVeryNearMonochrome(hex))
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

const isVeryNearMonochrome = (hex: string): boolean => {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min <= 8) return true; // near-gray
  // Don't kill brand light/dark neutrals entirely — but the strict near-gray
  // filter above already exempts saturated colors close to black or white.
  return false;
};

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
