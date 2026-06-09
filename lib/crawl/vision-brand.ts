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

import { getAnthropic, MODELS } from "../anthropic";
import { usageOf, type Usage } from "../usage";

const HEX_RX = /#[0-9a-fA-F]{6}\b/g;

const isVisionSafe = (u?: string): u is string =>
  typeof u === "string" &&
  /^https:\/\//i.test(u) &&
  /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(u);

/**
 * Read a brand's real color palette (hex) off its hero/share image.
 * Returns 0 colors on any failure (caller falls back to the CSS palette).
 * `opts.onUsage` (when given) receives the resolved model + token usage of the
 * vision call so the crawl's cost lands in the usage log — fired per API call,
 * never when the image is skipped or the call fails.
 */
export const extractPaletteFromImage = async (
  imageUrl: string | undefined,
  opts: {
    client?: ReturnType<typeof getAnthropic>;
    model?: string;
    onUsage?: (model: string, usage: Usage) => void;
  } = {},
): Promise<string[]> => {
  if (!isVisionSafe(imageUrl)) return [];
  try {
    const client = opts.client ?? getAnthropic();
    const model = opts.model ?? MODELS.qaAgent; // Haiku — vision-capable, cheap
    const resp = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { type: "image", source: { type: "url", url: imageUrl } } as any,
            {
              type: "text",
              text:
                "This is a brand's website hero / share image. Extract the brand's ACTUAL color palette as hex codes: the dominant background, the main text color, the signature accent, and 1-2 supporting colors. Order by importance (the dominant brand/background color first, the accent second). Ignore photographic colors (skin, sky) — focus on the brand's deliberate UI colors. Return ONLY a JSON array of 4-6 lowercase hex strings, e.g. [\"#4a0e0e\",\"#ff6a2b\",\"#ffffff\"]. No prose.",
            },
          ],
        },
      ],
    });
    opts.onUsage?.(model, usageOf(resp.usage));
    const text = resp.content.find((c) => c.type === "text");
    if (!text || text.type !== "text") return [];
    const hexes = (text.text.match(HEX_RX) || []).map((h) => h.toLowerCase());
    // dedupe, preserve order, cap
    return [...new Set(hexes)].slice(0, 6);
  } catch {
    return []; // best-effort — keep the CSS palette on any failure
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

    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
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

    // Greedy pick by frequency, skipping any color within ~38 euclidean of an
    // already-chosen one (so we don't return five near-identical off-whites).
    const MIN_DIST2 = 38 * 38;
    const chosen: typeof reps = [];
    for (const c of reps) {
      if (chosen.some((x) => dist2(x, c) < MIN_DIST2)) continue;
      chosen.push(c);
      if (chosen.length >= maxColors) break;
    }

    // Guarantee one vivid accent: brand accents are small-area and can miss the
    // frequency cut. If nothing chosen is saturated, append the most-saturated
    // bucket that covers ≥1% of pixels.
    if (chosen.length < maxColors && !chosen.some((c) => saturation(c) > 0.45)) {
      const accent = reps
        .filter((c) => c.n / totalPx > 0.01 && saturation(c) > 0.45)
        .sort((a, b) => saturation(b) - saturation(a))[0];
      if (accent && !chosen.some((x) => dist2(x, accent) < MIN_DIST2)) {
        chosen.push(accent);
      }
    }

    return chosen.map((c) => toHex(c.r, c.g, c.b));
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
