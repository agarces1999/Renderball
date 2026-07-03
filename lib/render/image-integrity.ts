/**
 * Image-integrity pass — GUARANTEE no broken or invented image URL ever ships.
 *
 * The design agent sometimes bakes an image URL that 404s: a dead/missing
 * og:image, or a guessed path like `https://brand.com/og-image.jpg` (sezane.com
 * exposes no og:image, so the agent invented one → 404 → broken-image icon in
 * the preview AND a blank box in the MP4). It may also call `search_assets`,
 * get real photos, and then not use them.
 *
 * This pass extracts every http(s) image URL in the final composition, checks
 * each is actually reachable, and DETERMINISTICALLY repairs any dead one:
 *   1. swap it for a validated URL from the pool — the scene's own search_assets
 *      photos first (intended imagery), then crawled page images; or
 *   2. if the pool is exhausted, neutralize it with a transparent pixel, so the
 *      worst case is "no image" (the scene's gradient/scrim shows) — never a
 *      broken-image icon.
 *
 * Runs in the build path on the final code, so the guarantee holds for both the
 * preview and the MP4. Pure-ish: only network is the reachability probe.
 */

// http(s) URLs that look like raster images (by extension or query). data: URLs
// are self-contained (always valid); font / SVG-namespace URLs have no image
// extension and are skipped, so we never touch Google Fonts or xmlns links.
const IMAGE_URL_RX =
  /https?:\/\/[^\s"'`)<>]+\.(?:jpe?g|png|webp|gif|avif|bmp)(?:\?[^\s"'`)<>]*)?/gi;

// ANY http(s) URL used as an element src — catches what the extension regex
// structurally misses: brand-CDN SVGs (flag icons, partner logos) and
// extension-less image paths. Measured miss: an ElevenLabs build shipped 5
// asset 404s (circle-flags/*.svg, payloadcms/*.svg, a chunked _next path) that
// IMAGE_URL_RX never saw. Both src={"…"} and src="…" forms.
const SRC_URL_RX = /src=\{?["'`](https?:\/\/[^"'`]+)["'`]\}?/gi;

// Only raster photos are sensible pool-replacements; a dead SVG icon (flag,
// partner logo) swapped for an arbitrary page photo would look worse than the
// transparent-pixel neutralize (layout preserved, nothing broken rendered).
const isRasterUrl = (u: string): boolean =>
  /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:\?|$)/i.test(u);

// 1×1 transparent GIF — renders nothing (no broken icon) when no valid swap exists.
const TRANSPARENT_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * A cached reachability probe. Uses a 1-byte ranged GET (more reliable across
 * CDNs than HEAD), accepts 2xx/206 with a non-HTML content-type (a 404 page
 * served as 200 text/html is treated as dead). Results memoized per URL.
 */
export const makeImageProbe = (): ((u: string) => Promise<boolean>) => {
  const cache = new Map<string, Promise<boolean>>();
  const check = async (u: string): Promise<boolean> => {
    if (!/^https?:\/\//i.test(u)) return true; // data:/relative — not our concern
    try {
      const res = await fetch(u, {
        method: "GET",
        headers: { Range: "bytes=0-0", "User-Agent": UA },
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
      });
      if (!(res.ok || res.status === 206)) return false;
      const ct = res.headers.get("content-type") || "";
      return !/^\s*text\/html/i.test(ct);
    } catch {
      return false;
    }
  };
  return (u: string) => {
    let p = cache.get(u);
    if (!p) {
      p = check(u);
      cache.set(u, p);
    }
    return p;
  };
};

export interface ImageRepairReport {
  code: string;
  replaced: { from: string; to: string }[];
  neutralized: string[];
}

/**
 * Validate + repair every image URL in `code`. `pool` is the ordered list of
 * known-good replacement URLs (search_assets photos, then page images).
 */
export const repairBrokenImages = async (
  code: string,
  pool: string[],
  probe: (u: string) => Promise<boolean>,
): Promise<ImageRepairReport> => {
  const srcUrls: string[] = [];
  SRC_URL_RX.lastIndex = 0;
  for (let m = SRC_URL_RX.exec(code); m; m = SRC_URL_RX.exec(code)) srcUrls.push(m[1]);
  const urls = [...new Set([...(code.match(IMAGE_URL_RX) || []), ...srcUrls])];
  if (urls.length === 0) return { code, replaced: [], neutralized: [] };

  const liveness = await Promise.all(
    urls.map(async (u) => ({ u, ok: await probe(u) })),
  );
  const dead = liveness.filter((x) => !x.ok).map((x) => x.u);
  if (dead.length === 0) return { code, replaced: [], neutralized: [] };

  // Replacement queue: http(s) pool URLs not already in the comp, probed lazily.
  const inComp = new Set(urls);
  const queue = pool.filter((p) => /^https?:\/\//i.test(p) && !inComp.has(p));
  let qi = 0;
  const nextValid = async (): Promise<string | null> => {
    while (qi < queue.length) {
      const p = queue[qi++];
      if (await probe(p)) return p;
    }
    return null;
  };

  let out = code;
  const replaced: { from: string; to: string }[] = [];
  const neutralized: string[] = [];
  for (const d of dead) {
    // Pool-swap only raster photos; dead icons/SVGs neutralize (see isRasterUrl).
    const repl = isRasterUrl(d) ? await nextValid() : null;
    if (repl) {
      out = out.split(d).join(repl);
      replaced.push({ from: d, to: repl });
    } else {
      out = out.split(d).join(TRANSPARENT_PX);
      neutralized.push(d);
    }
  }
  return { code: out, replaced, neutralized };
};
