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
 *
 * v12 (dogfood cycle 4) adds the RENDER-TRUTH arm: the reachability probe can
 * pass a URL that still fails to DECODE (cycle 3: the model retyped the brand
 * logo's data: URI into three differently-corrupted base64 strings — every one
 * "fetchable", every one a broken-image glyph on the frame). measureScenes now
 * reports each <img>'s decoded naturalWidth; findBrokenRenderedImages keys on
 * naturalWidth === 0 (the browser's own verdict), and
 * swapBrokenImagesForWordmark deterministically replaces the broken mounts
 * with a text wordmark (brand name in the display face) at zero tokens.
 */
import type { SceneMeasurement } from "./measure-scene";

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

// ── v12: measured broken-image detection + wordmark swap ─────────────────────

export interface BrokenRenderedImage {
  scene: number;
  /** The measured src ATTRIBUTE value (what the DOM actually mounted). */
  src: string;
  /** Enclosing LEGO piece id ("" outside any piece — e.g. the chrome mark). */
  pieceId: string;
}

/**
 * Every measured <img> whose decoded naturalWidth is EXACTLY 0 — the browser's
 * own "this image did not decode" verdict (broken-image glyph territory).
 * Undefined naturalWidth (older fixtures / non-imgs) never flags. Deduped by
 * src per scene.
 */
export const findBrokenRenderedImages = (
  measurements: SceneMeasurement[],
): BrokenRenderedImage[] => {
  const out: BrokenRenderedImage[] = [];
  const seen = new Set<string>();
  for (const m of measurements) {
    if (m.error) continue;
    for (const e of m.elements) {
      if (!e.isImg || !e.src) continue;
      if (e.imgNaturalWidth !== 0) continue; // undefined (unmeasured) or decoded fine
      if (e.opacity <= 0.05) continue; // invisible mounts can't ship a glyph
      const key = `${m.scene}|${e.src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ scene: m.scene, src: e.src, pieceId: e.piece ?? "" });
    }
  }
  return out;
};

export interface WordmarkSwapResult {
  code: string;
  /** One entry per replaced tag site. */
  swapped: { src: string; via: "tag-swap" | "chrome-wordmark" }[];
}

/** Balanced `{{ … }}` span starting at `at` (the index of the first "{"). */
const styleObjectSpan = (s: string, at: number): { start: number; end: number } | null => {
  if (s.slice(at, at + 2) !== "{{") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start: at, end: i + 1 };
    }
  }
  return null;
};

/** Resolve a tag's src attribute to its runtime string, using `constSource`
 *  for identifier lookups (`src={LOGO_SRC}` → the injected const's value). */
const resolveTagSrc = (tag: string, constSource: string): string | null => {
  const lit = /\bsrc\s*=\s*(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|\{\s*`([^`]*)`\s*\})/.exec(tag);
  if (lit) return lit[1] ?? lit[2] ?? lit[3] ?? lit[4] ?? null;
  const ident = /\bsrc\s*=\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/.exec(tag);
  if (ident) {
    const decl = new RegExp(`const\\s+${ident[1]}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(constSource);
    if (decl) return decl[1] ?? decl[2] ?? null;
  }
  return null;
};

/**
 * Deterministically replace every <Img>/<img> mount whose resolved src is in
 * `brokenSrcs` with a text WORDMARK (the brand name in the display face) — the
 * layout keeps the mount's own style/size, the frame gains a legible mark
 * instead of a broken-image glyph. Also covers the BrandChrome corner mark
 * (whose <Img> lives inside the shim file, not in `code`): when a broken src
 * is the value bound to `logoSrc={IDENT}`, the binding is rewritten to the
 * chrome's built-in wordmark fallback.
 *
 * `opts.constSource` resolves identifier srcs when transforming a fragment
 * (a cached piece body) that references consts declared elsewhere.
 */
export const swapBrokenImagesForWordmark = (
  code: string,
  brokenSrcs: string[],
  brandName: string,
  opts?: { constSource?: string },
): WordmarkSwapResult => {
  const broken = new Set(brokenSrcs.filter(Boolean));
  if (broken.size === 0 || !brandName) return { code, swapped: [] };
  const constSource = opts?.constSource ?? code;
  const swapped: WordmarkSwapResult["swapped"] = [];
  const name = JSON.stringify(brandName);

  // (a) Tag swaps: every <Img …/> / <img …/> whose resolved src is broken.
  const tagRx = /<(?:Img|img)\b[^<]*?\/>|<(?:Img|img)\b[^<]*?>(?:\s*<\/(?:Img|img)>)?/g;
  let out = "";
  let last = 0;
  for (let m = tagRx.exec(code); m; m = tagRx.exec(code)) {
    const tag = m[0];
    const src = resolveTagSrc(tag, constSource);
    if (src === null || !broken.has(src)) continue;
    // Carry the mount's own sizing: its style object (if any) + width/height attrs.
    const styleAt = tag.search(/\bstyle\s*=\s*\{\{/);
    let inner = "";
    if (styleAt !== -1) {
      const open = tag.indexOf("{{", styleAt);
      const span = styleObjectSpan(tag, open);
      if (span) inner = tag.slice(span.start + 2, span.end - 2).trim().replace(/,\s*$/, "");
    }
    const wAttr = /\bwidth\s*=\s*\{?\s*(\d+(?:\.\d+)?)\s*\}?/.exec(tag);
    const hAttr = /\bheight\s*=\s*\{?\s*(\d+(?:\.\d+)?)\s*\}?/.exec(tag);
    const sizing = [
      wAttr ? `width: ${wAttr[1]}` : "",
      hAttr ? `height: ${hAttr[1]}` : "",
    ].filter(Boolean);
    const fontSize = hAttr ? Math.max(12, Math.min(64, Math.round(Number(hAttr[1]) * 0.55))) : 20;
    const style = [
      inner,
      ...sizing,
      `display: "inline-flex"`,
      `alignItems: "center"`,
      `justifyContent: "center"`,
      `overflow: "hidden"`,
      `whiteSpace: "nowrap"`,
      `fontFamily: FONT_DISPLAY`,
      `fontWeight: 800`,
      `letterSpacing: "-0.02em"`,
      `lineHeight: 1`,
      `fontSize: ${fontSize}`,
    ]
      .filter(Boolean)
      .join(", ");
    out += code.slice(last, m.index) + `<span data-rb-wordmark-fallback="" style={{ ${style} }}>{${name}}</span>`;
    last = m.index + tag.length;
    swapped.push({ src, via: "tag-swap" });
  }
  out += code.slice(last);

  // (b) Chrome mark: `logoSrc={IDENT}` whose const value is broken — the tag
  // itself lives in the BrandChrome shim, so rewrite the BINDING to the
  // chrome's own wordmark fallback (logoSrc undefined + wordmark set).
  const bindRx = /\blogoSrc\s*=\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g;
  out = out.replace(bindRx, (whole, ident: string) => {
    const decl = new RegExp(`const\\s+${ident}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(constSource);
    const val = decl ? (decl[1] ?? decl[2]) : null;
    if (val === null || val === undefined || !broken.has(val)) return whole;
    swapped.push({ src: val, via: "chrome-wordmark" });
    return `logoSrc={undefined} wordmark={${name}}`;
  });

  return { code: out, swapped };
};
