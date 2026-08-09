/**
 * Vision-based brand palette extraction.
 *
 * Why: CSS-frequency palette extraction picks up a site builder's DEFAULT
 * template colors (Webflow ships a big default stylesheet whose link-blue
 * #3898ec / grays out-count the brand's real colors). For fusefinance.com the
 * crawl returned Webflow blue when the brand is actually deep maroon + orange.
 *
 * A vision pass reads the brand's ACTUAL colors off its hero/share image —
 * what renders, not what's in the polluted CSS. Uses the cheap vision-capable
 * model (Haiku). Best-effort: returns [] on any failure so the caller keeps
 * the CSS palette.
 */

import { VISION_MODEL } from "../anthropic";
import { callZaiVision } from "../render/zai-vision";
import { type Usage } from "../usage";
import { safeFetch } from "./ssrf-guard";

// Prompt for the by-role color read. Kept verbatim from the prior SDK path —
// only the transport changed (now native GLM-5V-Turbo, which can actually SEE).
const COLOR_ROLES_PROMPT =
  'This is a brand\'s website hero / share image. Identify the brand\'s ACTUAL colors BY ROLE. "background" = the dominant page/canvas color the content sits ON (often a deep brand color, NOT necessarily black). "text" = the main reading-text color. "accent" = the signature highlight used for CTAs/emphasis (distinct from the background). "supporting" = 1-2 other deliberate brand colors. Ignore photographic colors (skin, sky); focus on deliberate UI colors. Return ONLY a JSON object with lowercase hex values, e.g. {"background":"#440b12","text":"#ffffff","accent":"#ec6839","supporting":["#f4e9df"]}. Omit any role you can\'t identify. No prose.';

const HEX_RX = /#[0-9a-fA-F]{6}\b/g;

const isVisionSafe = (u?: string): u is string =>
  typeof u === "string" &&
  /^https:\/\//i.test(u) &&
  /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(u);

/**
 * The brand's color palette by SEMANTIC ROLE, read off its hero/share image.
 * `background` is the page CANVAS color (Fuse = burgundy #440b12) — distinct
 * from `accent`, the signature hue for CTAs/emphasis (Fuse = orange #ec6839).
 * `supporting` holds any extra brand colors. Any role may be absent.
 */
export interface BrandColorRoles {
  background?: string;
  text?: string;
  accent?: string;
  supporting: string[];
}

/**
 * Pull the first balanced JSON object out of an assistant text response,
 * tolerating prose/markdown fences around it. Returns null when none parses.
 */
const parseFirstJsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const asHex = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/#[0-9a-fA-F]{6}\b/);
  return m ? m[0].toLowerCase() : undefined;
};

/**
 * Read a brand's color palette BY ROLE off its hero/share image, so the canvas
 * background can be treated as an authoritative field downstream rather than
 * inferred from a flat palette. One vision call (cheap Haiku). `opts.onUsage`
 * (when given) receives the resolved model + token usage so the crawl's cost
 * lands in the usage log — fired per API call, never when skipped or on failure.
 * Best-effort: returns {supporting:[]} on any failure (image skipped, no key,
 * timeout, unparseable response) so callers degrade to the CSS palette.
 */
export const extractBrandColorRoles = async (
  imageUrl: string | undefined,
  opts: {
    // The vision call, injected for tests. Default: native GLM-5V-Turbo. The old
    // Anthropic-compat SDK path silently DROPPED the image → the model was blind
    // → it returned a stray UI color (Robinhood shipped BLUE; brand is lime-green
    // #ccff00). thinking MUST be disabled here: on a terse extraction task the
    // model otherwise spends the whole token budget reasoning and returns nothing.
    visionCall?: (
      image: string,
      prompt: string,
    ) => Promise<{ text: string; usage: Usage }>;
    onUsage?: (model: string, usage: Usage) => void;
  } = {},
): Promise<BrandColorRoles> => {
  if (!isVisionSafe(imageUrl)) return { supporting: [] };
  try {
    const visionCall =
      opts.visionCall ??
      ((image, prompt) =>
        callZaiVision(image, prompt, { disableThinking: true, maxTokens: 500, stage: "crawl" }));
    const { text, usage } = await visionCall(imageUrl, COLOR_ROLES_PROMPT);
    opts.onUsage?.(VISION_MODEL, usage);
    const obj = parseFirstJsonObject(text);
    if (!obj) return { supporting: [] };
    const supporting = Array.isArray(obj.supporting)
      ? obj.supporting.map(asHex).filter((h): h is string => !!h)
      : [];
    return {
      background: asHex(obj.background),
      text: asHex(obj.text),
      accent: asHex(obj.accent),
      supporting,
    };
  } catch {
    return { supporting: [] }; // best-effort — keep the CSS palette on any failure
  }
};

// ─── Pixel-exact palette extraction ──────────────────────────────────
//
// Why: the vision pass (above) ESTIMATES hex codes by eye — it nails the hue
// family but is off by ~10-20 per channel (Fuse: read #3d1625 for a true
// #3F1114, +17 on blue → too purple). For precise brand color, decode the
// actual image pixels and cluster them. Returns the dominant colors as the
// MEAN of each cluster's real pixels — exact (modulo the source JPEG), not
// guessed.
//
// Best-effort: dynamic-imports sharp inside try/catch, returns [] on any
// failure (missing native binary, non-image URL, decode error) so the caller
// falls back to the vision palette, then the CSS palette.

const isPixelSafe = (u?: string): u is string =>
  typeof u === "string" && /^https:\/\//i.test(u);

const toHex = (r: number, g: number, b: number): string =>
  "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

const parseHex = (h: string): { r: number; g: number; b: number } | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

const dist2 = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;

// Saturation in [0,1] (HSV S). Brand accents (Fuse orange) are high-saturation
// but small-area, so they can rank low by frequency — we surface one explicitly.
const saturation = (c: { r: number; g: number; b: number }): number => {
  const mx = Math.max(c.r, c.g, c.b);
  const mn = Math.min(c.r, c.g, c.b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

/** A colour cluster: its pixel count and the precise mean of its pixels. */
export interface PixelBucket {
  n: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Pick the representative colours out of frequency-ordered clusters.
 *
 * Greedy by frequency, skipping any colour within ~38 euclidean of an
 * already-chosen one (so we don't return five near-identical off-whites), then
 * GUARANTEE one vivid accent: brand accents are small-area — a button on a busy
 * share card — and routinely miss the frequency cut.
 *
 * The guarantee was FIXED, not deleted, on 2026-08-09. It could not fire as
 * written: it was gated on `chosen.length < maxColors`, i.e. on the list NOT
 * being full, and the crawl calls this with maxColors: 8 — which the greedy fill
 * reaches on the great majority of real og:images. So on exactly the busy images
 * that needed rescuing, the rescue stood down. It now DISPLACES the weakest
 * member instead: `chosen` is frequency-ordered, so its last entry is the
 * least-present colour in the image and a real brand accent outranks it. The
 * caller's maxColors contract is preserved.
 *
 * Split out of extractPaletteFromPixels so it can be tested without a network
 * fetch or a sharp decode — the reason the dead guard survived this long.
 */
export const choosePaletteBuckets = (
  reps: PixelBucket[],
  maxColors: number,
  totalPx: number,
): PixelBucket[] => {
  const MIN_DIST2 = 38 * 38;
  const chosen: PixelBucket[] = [];
  for (const c of reps) {
    if (chosen.some((x) => dist2(x, c) < MIN_DIST2)) continue;
    chosen.push(c);
    if (chosen.length >= maxColors) break;
  }
  if (!chosen.some((c) => saturation(c) > 0.45)) {
    const accent = reps
      .filter((c) => totalPx > 0 && c.n / totalPx > 0.01 && saturation(c) > 0.45)
      .sort((a, b) => saturation(b) - saturation(a))[0];
    if (accent && !chosen.some((x) => dist2(x, accent) < MIN_DIST2)) {
      if (chosen.length >= maxColors) chosen[chosen.length - 1] = accent;
      else chosen.push(accent);
    }
  }
  return chosen;
};

/**
 * Read a brand's color palette by sampling ACTUAL pixels of its hero/share
 * image. Returns precise dominant hexes (mean of each cluster), dominant
 * first, with one saturated accent guaranteed when present. [] on any failure.
 */
export const extractPaletteFromPixels = async (
  imageUrl: string | undefined,
  opts: { maxColors?: number } = {},
): Promise<string[]> => {
  if (!isPixelSafe(imageUrl)) return [];
  const maxColors = opts.maxColors ?? 5;
  try {
    // Dynamic import so a missing/broken native binary degrades gracefully and
    // sharp never leaks into a client bundle.
    const sharpMod = await import("sharp").catch(() => null);
    if (!sharpMod) return [];
    const sharp = sharpMod.default;

    const res = await safeFetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const ctype = res.headers.get("content-type") || "";
    if (ctype && !/^image\//i.test(ctype)) return []; // not an image — bail
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 12_000_000) return [];

    // Downscale for speed (≤160×160 → ≤25.6k samples) and read raw bytes.
    const { data, info } = await sharp(buf)
      .resize(160, 160, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels; // 3 (RGB) or 4 (RGBA)

    // Histogram on a coarse 12-bit grid (16 levels/channel) so near-identical
    // pixels merge, but accumulate the PRECISE running mean per bucket so the
    // representative color is exact, not snapped to the grid.
    const buckets = new Map<
      number,
      { n: number; r: number; g: number; b: number }
    >();
    for (let i = 0; i + ch - 1 < data.length; i += ch) {
      if (ch === 4 && data[i + 3] < 128) continue; // skip transparent px
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = buckets.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else {
        buckets.set(key, { n: 1, r, g, b });
      }
    }
    if (buckets.size === 0) return [];

    const reps = [...buckets.values()].map((e) => ({
      n: e.n,
      r: Math.round(e.r / e.n),
      g: Math.round(e.g / e.n),
      b: Math.round(e.b / e.n),
    }));
    reps.sort((a, b) => b.n - a.n); // dominant first
    const totalPx = reps.reduce((s, c) => s + c.n, 0);

    return choosePaletteBuckets(reps, maxColors, totalPx).map((c) =>
      toHex(c.r, c.g, c.b),
    );
  } catch {
    return []; // best-effort — fall back to the vision/CSS palette
  }
};

// ─── Hybrid: vision SELECTS, pixels CORRECT ──────────────────────────
//
// Vision is good at semantics (it knows Fuse's orange is a brand accent even
// though it's a tiny area of the share image) but estimates hex by eye
// (#3d1625 for a true ~#440c12). Pixel clustering is exact but only sees what's
// PROMINENT (it misses the small orange entirely). So: keep vision's color
// SELECTION, but snap each picked color to the nearest precise pixel cluster
// when one is close enough — correcting the hex without changing which colors
// were chosen. Colors with no nearby cluster (a small accent) keep their vision
// value, since pixels can't improve what they didn't capture.
//
// Snap radius: ~34 euclidean. Wide enough to pull a hand-estimated hue onto its
// real value (maroon: vision↔pixel ≈ 23), tight enough not to collapse two
// genuinely-different brand colors into one.
const SNAP_DIST2 = 34 * 34;

/**
 * Snap ONE hex onto the nearest precise pixel cluster when one is close enough
 * (within SNAP_DIST2). The single-color analogue of refinePaletteWithPixels:
 * vision SELECTS the role color, pixels CORRECT its hand-estimated hex. Returns
 * the input unchanged when no cluster is close (or no pixel palette exists), so
 * a small role color pixels never captured keeps its vision value.
 */
export const snapHexToPixels = (hex: string, pixel: string[]): string =>
  refinePaletteWithPixels([hex], pixel)[0] ?? hex;

export const refinePaletteWithPixels = (
  semantic: string[],
  pixel: string[],
): string[] => {
  const px = pixel
    .map(parseHex)
    .filter((c): c is { r: number; g: number; b: number } => c !== null);
  if (px.length === 0) return semantic;
  return semantic.map((h) => {
    const c = parseHex(h);
    if (!c) return h;
    let best: { r: number; g: number; b: number } | null = null;
    let bestD = Infinity;
    for (const p of px) {
      const d = dist2(c, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best && bestD <= SNAP_DIST2 ? toHex(best.r, best.g, best.b) : h;
  });
};
