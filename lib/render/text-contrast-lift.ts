//
// Deterministic repair for text that is legible-but-dim.
//
// THE GAP. text-contrast.ts measures every text node against the surface actually
// behind it and sorts the result into three bands:
//
//   ratio < 2.5  at >=14px   → BLOCKING (the ghost class: white on white)
//   2.5 <= ratio < 4.5       → advisory — "rides along on regens" (its own words)
//   ratio >= 4.5             → clean (WCAG AA for body text)
//
// The middle band has no repair of its own. It only improves if the piece happens to
// be regenerated for some OTHER reason, so a dim label on an otherwise-clean scene
// ships dim. Founder report, 2026-08-22: "the element on the right is bad on
// visibility" — that deck's warnings.json recorded exactly one entry,
// { fg: "#64748b", bg: "#f1f5f9", ratio: 4.3 }. Slate-500 on slate-100, a hair under
// AA, seen and shipped. His eye agreed with WCAG, not with our band.
//
// THE REPAIR. Darkening a colour to hit a contrast target is arithmetic, not
// judgment: no model call, no round trip, ~0ms. We move LIGHTNESS only and keep hue
// and saturation exactly, so slate-500 becomes a darker slate and never becomes
// black — the brand still reads as the brand.
//
// WHY LIGHTNESS-ONLY MATTERS (the doctrine in docs/SPATIAL_QUALITY.md: repairs must
// never manufacture defects). The washout-lift next door learned this the expensive
// way — forcing ink onto a sparse panel turned invisible emptiness into a black
// monolith. A hue-preserving nudge cannot do that: the worst case is text a few steps
// darker than the designer chose, which is the whole point.
//
// SCOPE. Advisory band only. Blocking ghosts (< 2.5) are a different defect — white
// text on a white panel usually means the LAYOUT is wrong, and quietly darkening the
// glyphs would paper over it. Those keep routing to a regen.
//
import { contrastRatio, luminance, MIN_CONTRAST_RATIO } from "../agents/contrast";

/** Parse `#rgb` / `#rrggbb` to 0-255 triplets. Returns null for anything else. */
export const parseHex = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

const toHex = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b]
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("");

/** sRGB → HSL, h in [0,360), s and l in [0,1]. */
export const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l]; // achromatic
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
};

/** HSL → sRGB hex. */
export const hslToHex = (h: number, s: number, l: number): string => {
  if (s === 0) {
    const v = l * 255;
    return toHex(v, v, v);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((h % 360) + 360) % 360 / 360;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return toHex(channel(hk + 1 / 3) * 255, channel(hk) * 255, channel(hk - 1 / 3) * 255);
};

export interface LiftResult {
  /** The colour to write. Equal to the input when no lift was needed or possible. */
  color: string;
  /** Contrast achieved against the same backdrop. */
  ratio: number;
  /** Did the colour change? */
  changed: boolean;
  /** Why nothing happened, when `changed` is false. */
  reason?: "already-passing" | "unparseable" | "unreachable";
}

/**
 * Darken (or lighten) `fg` against `bg` until it reaches `target` contrast, moving
 * LIGHTNESS only.
 *
 * Direction is chosen by which side of the backdrop the text already sits on, so
 * light-on-dark stays light-on-dark: nudging a pale label DOWN toward a dark panel
 * would cross through the backdrop's own luminance and get worse before it got
 * better. Binary search on lightness — contrast is monotonic in lightness once the
 * direction is fixed, so ~12 iterations land within a thousandth.
 *
 * Returns the input unchanged, with a reason, when the target cannot be reached even
 * at pure black/white — a mid-grey backdrop genuinely has no AA-passing colour at
 * some hues, and returning the best-but-still-failing colour would silently claim a
 * fix that is not one.
 */
export const liftTextColor = (
  fg: string,
  bg: string,
  target: number = MIN_CONTRAST_RATIO,
): LiftResult => {
  const fgRgb = parseHex(fg);
  const bgRgb = parseHex(bg);
  if (!fgRgb || !bgRgb) return { color: fg, ratio: 0, changed: false, reason: "unparseable" };

  const startRatio = contrastRatio(toHex(...fgRgb), toHex(...bgRgb));
  if (startRatio >= target) {
    return { color: fg, ratio: startRatio, changed: false, reason: "already-passing" };
  }

  const [h, s, l] = rgbToHsl(...fgRgb);
  const bgHex = toHex(...bgRgb);

  /**
   * Smallest lightness change toward `extreme` that reaches the target, or null if
   * even the extreme falls short. Contrast is monotonic in lightness once the
   * direction is fixed, so a binary search finds the colour CLOSEST to the
   * designer's — overshooting to pure black would be its own defect.
   */
  const search = (extreme: 0 | 1): { color: string; ratio: number } | null => {
    if (contrastRatio(hslToHex(h, s, extreme), bgHex) < target) return null;
    const down = extreme === 0;
    let lo = down ? extreme : l;
    let hi = down ? l : extreme;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const ok = contrastRatio(hslToHex(h, s, mid), bgHex) >= target;
      if (down) { if (ok) lo = mid; else hi = mid; }
      else { if (ok) hi = mid; else lo = mid; }
    }
    let chosen = down ? lo : hi;
    let color = hslToHex(h, s, chosen);
    // Rounding to 8-bit channels can land a hair under; step once more if so.
    if (contrastRatio(color, bgHex) < target) {
      chosen = down ? Math.max(0, chosen - 0.02) : Math.min(1, chosen + 0.02);
      color = hslToHex(h, s, chosen);
    }
    const ratio = contrastRatio(color, bgHex);
    return ratio >= target ? { color, ratio } : null;
  };

  // FIRST push away from the backdrop — text darker than its surface gets darker
  // still, lighter gets lighter. That is the smallest, least surprising change, and
  // it keeps light-on-dark reading as light-on-dark.
  const away: 0 | 1 = luminance(toHex(...fgRgb)) < luminance(bgHex) ? 0 : 1;
  // If that side cannot reach the target — pale text on a merely-mid backdrop has
  // nowhere lighter to go — FLIP instead of giving up. Inverting the polarity is a
  // visible change, but near-invisible text is the defect we were asked to fix, and
  // an honest flip beats declining while the label stays unreadable.
  const best = search(away) ?? search(away === 0 ? 1 : 0);
  if (!best) return { color: fg, ratio: startRatio, changed: false, reason: "unreachable" };

  return { color: best.color, ratio: best.ratio, changed: best.color.toLowerCase() !== fg.toLowerCase() };
};
