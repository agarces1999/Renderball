/**
 * The FREE tier of the brand read — everything a document's CREATION is
 * allowed to spend, which is nothing.
 *
 * WHY THIS FILE EXISTS AT ALL. `lib/crawl/extract-brand.ts` is the full crawl,
 * and it is not free: it fires `extractDesignLanguage` (a homepage screenshot
 * plus a vision read), `extractBrandColorRoles` (a second vision read) and the
 * logo-discovery agent. Measured cost ~$0.0043 and 10-25s. The founder's rule
 * on the record is that free/deterministic work runs automatically and
 * anything paid waits for a click — so the automatic path cannot be that
 * function, and today that function has no "don't spend" mode to ask for.
 *
 * So this module reads the same site over the same network with ZERO model
 * calls: HTML + stylesheets + two icons. Measured over ten live sites (2026-
 * 08-09): median 1.4s, max 4.6s, reached 9/10, a chromatic colour on 9/10 and
 * a real brand font on 7/10. It is deliberately narrower than the full crawl
 * and it says so in `BrandExtract` terms rather than inventing a second
 * vocabulary — it returns a real `BrandExtract`, so
 * `brandExtractYield`, `resolveBrandIdentity`, the BrandKit persistence gate
 * and the design pipeline all read it with no special case anywhere.
 *
 * ONE CRAWL, NOT TWO — how the duplication is bounded. Every piece of brand
 * JUDGEMENT is imported from lib/crawl and never re-implemented here: the
 * palette provenance order, the template-colour blocklist, the font-role
 * classifier, the CSS canvas reader, the content-type gate, the SSRF-guarded
 * fetch. What is local is only the mechanical GATHERING — find the <title>,
 * find the stylesheets, fetch them — because those helpers are module-private
 * in extract-brand.ts. The right end state is `extractBrand(url, { tier })`
 * with this file deleted; see the report accompanying this change.
 *
 * KNOWN NARROWER THAN THE FULL CRAWL, stated so nobody discovers it later:
 * no logo discovery (that is the paid agent), no `<link>`-only Google-Fonts
 * family parsing when Google's CSS itself is rate-limited, no inline
 * `style="font-family:…"` scan, no page-image harvest, no design language.
 * A user who wants those clicks for them (tier "vision").
 */
import type { BrandExtract } from "../../app/new/schema";
import { safeFetch } from "../crawl/ssrf-guard";
import {
  annotateFontUsage,
  classifyFontRoles,
  extractCssCanvasBackground,
  extractFonts,
  extractNamedBrandColors,
  extractPalette,
  isHtmlContentType,
  mergePaletteByProvenance,
  type CrawledFont,
} from "../crawl/extract-brand";
import { dominantColorFromImageBytes, isNeutralAccentHex } from "../crawl/brand-truth";

// Bounds copied from extract-brand.ts on purpose: a free read that took longer
// than the paid one would be a strange thing to offer.
const HTML_TIMEOUT_MS = 10_000;
const CSS_TIMEOUT_MS = 5_000;
const ICON_TIMEOUT_MS = 4_000;
const MAX_STYLESHEETS = 10;
const MAX_IMPORTED_SHEETS = 5;
const MAX_CSS_BYTES = 500_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; RenderballBrandExtract/0.3; +https://renderball.com/bot)";

/**
 * "yoursite.com" → "https://yoursite.com/". null when there is no host to read.
 *
 * Exported because the panel, the create route and the brand route all have to
 * agree on what counts as a URL worth crawling; three different opinions about
 * that is how a field ends up firing a background job on every keystroke.
 */
export const normalizeSiteUrl = (raw: string): string | null => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    // A hostname with no dot is a LAN name, not a website. safeFetch would
    // refuse it anyway; refusing here means the UI never says "reading…" about
    // an address that was never going to resolve.
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
};

/** "https://www.stripe.com/pricing" → "stripe.com" — what a person calls their site. */
export const siteHost = (url: string): string =>
  (url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0] || url;

const resolveMaybe = (ref: string | undefined, baseUrl: string): string | undefined => {
  if (!ref) return undefined;
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return undefined;
  }
};

const decodeEntities = (s: string | undefined): string | undefined =>
  s
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();

const headOf = (html: string): string =>
  html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 50_000);

const titleOf = (head: string): string | undefined =>
  decodeEntities(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " "));

const metaOf = (head: string, key: "name" | "property", value: string): string | undefined => {
  const tags = head.match(/<meta\s[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const k = tag.match(new RegExp(`${key}=["']([^"']+)["']`, "i"))?.[1];
    if (!k || k.toLowerCase() !== value) continue;
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (content?.trim()) return decodeEntities(content);
  }
  return undefined;
};

const linkRelOf = (head: string, relRx: RegExp): string | undefined => {
  const tags = head.match(/<link\s[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] ?? "";
    if (!relRx.test(rel)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) return href;
  }
  return undefined;
};

const inlineStylesOf = (html: string): string =>
  (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [])
    .map((m) => m.replace(/<style[^>]*>/i, "").replace(/<\/style>/i, ""))
    .join("\n");

const stylesheetLinksOf = (html: string, baseUrl: string): string[] => {
  const hrefs: string[] = [];
  for (const tag of html.match(/<link\s[^>]*>/gi) ?? []) {
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] ?? "";
    if (!/(?:^|\s)stylesheet(?:\s|$)/i.test(rel)) continue;
    const resolved = resolveMaybe(tag.match(/href=["']([^"']+)["']/i)?.[1], baseUrl);
    if (resolved) hrefs.push(resolved);
  }
  return Array.from(new Set(hrefs));
};

// Font services — Typekit above all — are pulled with `@import` inside the
// site's own CSS rather than a <link>, so a link-only scan loses the brand's
// real face. Followed one level, font hosts first so the cap favours them.
const FONT_IMPORT_HINT_RX =
  /typekit|adobe|fonts\.googleapis|fonts\.bunny|fontshare|cloud\.typography|fonts\.net|fast\.fonts/i;

const cssImportsOf = (css: string, baseUrl: string): string[] => {
  const rx = /@import\s+(?:url\(\s*["']?([^)"']+)["']?\s*\)|["']([^"']+)["']|([^\s;"']+))/gi;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(css)) !== null) {
    const resolved = resolveMaybe(m[1] || m[2] || m[3], baseUrl);
    if (resolved && /^https?:\/\//i.test(resolved)) urls.push(resolved);
  }
  return Array.from(
    new Set([
      ...urls.filter((u) => FONT_IMPORT_HINT_RX.test(u)),
      ...urls.filter((u) => !FONT_IMPORT_HINT_RX.test(u)),
    ]),
  );
};

const fetchCss = async (href: string): Promise<string> => {
  try {
    const res = await safeFetch(href, {
      signal: AbortSignal.timeout(CSS_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: "text/css,*/*;q=0.1" },
      redirect: "follow",
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, MAX_CSS_BYTES);
  } catch {
    return "";
  }
};

/**
 * Palette tier 3 — the site's OWN icons, mined for chroma.
 *
 * Measured across 59 hosts: the favicon is startlingly accurate where it
 * exists (stripe → #533afd against a true #635bff, raycast → #ff6666 against
 * #ff6363, cloudflare → #ff5500), and it costs one small image fetch and zero
 * tokens. Neutral results are dropped — a black-and-white mark is structure,
 * not a brand hue.
 */
const iconChroma = async (urls: (string | undefined)[]): Promise<string[]> => {
  const wanted = urls.filter((u): u is string => !!u).slice(0, 2);
  const found = await Promise.all(
    wanted.map(async (u) => {
      try {
        const res = await safeFetch(u, {
          signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
          headers: { "User-Agent": USER_AGENT, Accept: "image/*,*/*;q=0.5" },
          redirect: "follow",
        });
        if (!res.ok) return null;
        const hex = await dominantColorFromImageBytes(Buffer.from(await res.arrayBuffer()));
        return hex && !isNeutralAccentHex(hex) ? hex : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((h): h is string => !!h);
};

/**
 * Google's own CSS carries the @font-face blocks, so a fetched
 * `fonts.googleapis.com` stylesheet already flows through `extractFonts`. This
 * is the backstop for when that fetch is rate-limited: the family names are
 * sitting in the link's own query string. No `src`, so `resolveBrandIdentity`
 * will treat these as families without a loadable face — which is the truth.
 */
const googleFamiliesOf = (html: string): CrawledFont[] => {
  const out: CrawledFont[] = [];
  for (const tag of html.match(/<link\s[^>]*>/gi) ?? []) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || !/fonts\.googleapis\.com\/css/i.test(href)) continue;
    for (const m of href.matchAll(/family=([^&:]+)/gi)) {
      const family = decodeURIComponent(m[1]).replace(/\+/g, " ").trim();
      if (family) out.push({ family, src: "" });
    }
  }
  return out;
};

/**
 * Read a site's brand deterministically. NEVER throws, NEVER calls a model.
 *
 * The `ok: false` returns mirror the full crawl's, including the content-type
 * gate: ramp.com answers this User-Agent with `text/markdown` on a 200, and
 * before that gate existed the crawl returned `ok: true` having parsed
 * nothing — a silent failure the caller could not tell from a real extract.
 */
export const readSiteBrand = async (rawUrl: string): Promise<BrandExtract> => {
  const fetched_at = new Date().toISOString();
  const url = normalizeSiteUrl(rawUrl);
  if (!url) return { url: rawUrl, fetched_at, ok: false, error: "Not a valid URL." };

  let html: string;
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!res.ok) return { url, fetched_at, ok: false, error: `HTTP ${res.status} from ${url}` };
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

  // Vision and pixel work are https-only downstream; an http:// icon silently
  // disables the icon tier, so upgrade the near-universal case.
  const https = (u: string | undefined): string | undefined =>
    u && /^http:\/\//i.test(u) ? u.replace(/^http:\/\//i, "https://") : u;

  const head = headOf(html);
  const title = titleOf(head);
  const description = metaOf(head, "name", "description");
  const theme_color = metaOf(head, "name", "theme-color");
  const og_image = https(resolveMaybe(metaOf(head, "property", "og:image"), url));
  const favicon = https(
    resolveMaybe(linkRelOf(head, /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/i), url),
  );
  const apple_touch_icon = https(
    resolveMaybe(linkRelOf(head, /(?:^|\s)apple-touch-icon(?:\s|$)/i), url),
  );

  // Icons overlap the stylesheet fetches — two independent networks of work,
  // and the whole read measures a 1.4s median.
  const iconsP = iconChroma([favicon, apple_touch_icon]);

  const inlineCss = inlineStylesOf(html);
  const cssLinks = stylesheetLinksOf(html, url).slice(0, MAX_STYLESHEETS);
  const fetchedCss = await Promise.all(cssLinks.map((h) => fetchCss(h)));
  const baseCss = [inlineCss, ...fetchedCss].join("\n");

  const importHrefs = cssImportsOf(baseCss, url)
    .filter((h) => !cssLinks.includes(h))
    .slice(0, MAX_IMPORTED_SHEETS);
  const importedCss = importHrefs.length
    ? await Promise.all(importHrefs.map((h) => fetchCss(h)))
    : [];
  const allCss = [baseCss, ...importedCss].join("\n");

  // A CSS url() resolves against ITS OWN stylesheet, not the page — resolving
  // against the page root drops path segments and the font 404s.
  const declared = [
    ...extractFonts(inlineCss, url),
    ...fetchedCss.flatMap((css, i) => extractFonts(css, cssLinks[i])),
    ...importedCss.flatMap((css, i) => extractFonts(css, importHrefs[i])),
  ];
  const seen = new Set(declared.map((f) => f.family.toLowerCase()));
  for (const g of googleFamiliesOf(html)) {
    if (seen.has(g.family.toLowerCase())) continue;
    seen.add(g.family.toLowerCase());
    declared.push(g);
  }
  // Which of those the site actually puts on a headline — the difference
  // between a face that is downloaded and a face a reader sees. Same judgement
  // as the full crawl, imported not re-implemented; see lib/crawl/font-roles.
  const fonts = annotateFontUsage(declared, allCss);

  const palette = mergePaletteByProvenance({
    named: extractNamedBrandColors(allCss),
    css: extractPalette(allCss),
    icon: await iconsP,
    // The og:image tier is the one that needs a model to be worth anything —
    // a share card's dominant colour with no vision pass to select FROM it is
    // how "#635bff" became an orange. Empty here on purpose, not by omission.
    image: [],
    themeColor: theme_color,
  });

  return {
    url,
    fetched_at,
    ok: true,
    title,
    description,
    og_image,
    theme_color,
    favicon,
    apple_touch_icon,
    fonts,
    font_roles: classifyFontRoles(fonts),
    palette,
    background_color: extractCssCanvasBackground(allCss),
  };
};
