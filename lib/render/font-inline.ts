/**
 * Font-inline pass — GUARANTEE brand @font-face fonts actually load in BOTH the
 * preview iframe and the Remotion MP4 render.
 *
 * The design agent bakes the brand's web font straight from the brand CDN:
 *   @font-face { font-family: "f37Bolton";
 *                src: url("https://corgi.insure/media/…otf?dpl=…") format("opentype"); }
 *
 * Cross-origin web fonts are CORS-restricted (unlike <img>, which loads cross-
 * origin freely). If the brand's CDN doesn't send `Access-Control-Allow-Origin`
 * — corgi.insure doesn't — the @font-face silently fails in the iframe AND in the
 * Remotion headless render, and the headline falls back to the generic. The
 * brand's actual display face never appears.
 *
 * Fix: at build time, download each brand font once and rewrite its url(...) to a
 * self-contained `data:` URL. data: URLs are origin-less — never CORS-blocked —
 * so the font loads SAME-ORIGIN in both contexts. This mirrors how the brand logo
 * already survives both contexts as a data: URL (see logo-inject.ts), and keeps
 * "preview IS the MP4" true (identical bytes baked into the one Composition.tsx).
 *
 * Runs in the build path's finalization (AFTER the design + animation agents, so
 * neither agent ever has to reproduce a multi-KB base64 string) on the final code.
 * Dead-URL safe: a font that won't fetch keeps its original remote URL, so the
 * worst case is exactly today's behavior — never a crash, never a broken build.
 */

// http(s) URLs that look like a font file (by extension, query string allowed).
// Mirrors image-integrity's IMAGE_URL_RX. Targeted to font extensions so we never
// touch image / SVG-namespace / Pexels url()s — only @font-face sources.
const FONT_URL_RX =
  /https?:\/\/[^\s"'`)<>]+\.(?:woff2|woff|otf|ttf|eot)(?:\?[^\s"'`)<>]*)?/gi;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// CSS-correct MIME per font extension so the browser's @font-face decoder accepts
// the data: URL. (A wrong/empty MIME makes some engines reject the font.)
const MIME_BY_EXT: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  otf: "font/otf",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
};

/** Lower-cased font extension from a URL (query/hash stripped); woff2 default. */
const fontExt = (url: string): string => {
  const m = url.split(/[?#]/)[0].match(/\.(woff2|woff|otf|ttf|eot)$/i);
  return m ? m[1].toLowerCase() : "woff2";
};

/**
 * A cached font downloader. Returns a `data:<mime>;base64,…` URL for a reachable
 * font, or null on any failure (dead URL, network, empty body, IO) so the caller
 * leaves the original remote URL in place. Results memoized per URL — the same
 * font URL appears once in BRAND_FONTS_CSS but may recur across design + animated
 * copies, and we never want to download it twice. `fetchImpl` is injectable for
 * unit tests (no network).
 */
export const makeFontFetcher = (
  opts: { fetchImpl?: typeof fetch } = {},
): ((u: string) => Promise<string | null>) => {
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, Promise<string | null>>();
  const load = async (u: string): Promise<string | null> => {
    if (!/^https?:\/\//i.test(u)) return null; // data:/relative — nothing to do
    try {
      const res = await doFetch(u, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(10000),
        redirect: "follow",
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0) return null;
      const mime = MIME_BY_EXT[fontExt(u)] ?? "font/woff2";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null; // dead URL / network / IO → keep the remote URL, never crash
    }
  };
  return (u: string) => {
    let p = cache.get(u);
    if (!p) {
      p = load(u);
      cache.set(u, p);
    }
    return p;
  };
};

export interface FontInlineReport {
  code: string;
  /** Remote font URLs that were downloaded + rewritten to data: URLs. */
  inlined: string[];
  /** Remote font URLs that could NOT be fetched (left as cross-origin url()s). */
  failed: string[];
}

/**
 * Rewrite every cross-origin @font-face font URL in `code` to a same-origin data:
 * URL. `fetchFont` downloads + encodes one URL (see makeFontFetcher). Each unique
 * remote URL is replaced everywhere it occurs — the font src appears once in the
 * shared BRAND_FONTS_CSS const, but a defensive global replace is harmless.
 */
export const inlineFontFaces = async (
  code: string,
  fetchFont: (u: string) => Promise<string | null>,
): Promise<FontInlineReport> => {
  const urls = [...new Set(code.match(FONT_URL_RX) || [])];
  if (urls.length === 0) return { code, inlined: [], failed: [] };

  const results = await Promise.all(
    urls.map(async (u) => ({ u, data: await fetchFont(u) })),
  );

  let out = code;
  const inlined: string[] = [];
  const failed: string[] = [];
  for (const { u, data } of results) {
    if (data) {
      out = out.split(u).join(data);
      inlined.push(u);
    } else {
      failed.push(u);
    }
  }
  return { code: out, inlined, failed };
};
