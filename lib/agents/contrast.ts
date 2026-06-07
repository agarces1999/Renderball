/**
 * WCAG contrast primitives + readability thresholds.
 *
 * Pure and dependency-free so the contrast gate can be unit-tested without
 * bundling the whole pipeline (which pulls in the Anthropic SDK, store, etc.).
 */

/** Body-text readability floor (WCAG AA normal text). */
export const MIN_CONTRAST_RATIO = 4.5;

/**
 * Below this, text is unreadable even at large headline sizes (WCAG's
 * large-text floor is 3:1). A pair under this is a BLOCKING quality failure —
 * white-on-orange at 2.1:1 must never ship — as opposed to the 3.0–4.5 band,
 * which is a polish-level nudge.
 */
export const SEVERE_CONTRAST_RATIO = 3.0;

/** WCAG relative luminance (0–1) of a `#rrggbb` hex. */
export const luminance = (hex: string): number => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG contrast ratio (1–21) between two `#rrggbb` hexes. */
export const contrastRatio = (fg: string, bg: string): number => {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
};
