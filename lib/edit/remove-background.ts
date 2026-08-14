/**
 * Background removal for generated icons — step 2 of the icon pipeline
 * (founder, 2026-08-14: "icons should be a generated image with removed
 * background").
 *
 * Deliberately NOT a segmentation model. The icon prompt (generate-icon.ts)
 * asks for a single centered mark on a plain background, and the 2026-08-14
 * probe showed the callable models deliver exactly that — a uniform (if not
 * pure-white) field. On that material, flood fill from the borders is
 * deterministic, dependency-free (sharp is already in the stack), and runs in
 * milliseconds — no second model call, no new provider, no per-image bill.
 * If a generation ignores the prompt and paints a scene, the fill removes
 * only the border-connected field and the icon still lands — imperfect, not
 * broken; the user regenerates.
 *
 * Mechanics:
 *   1. Estimate the background color from the border pixels (channel median).
 *   2. BFS from every border pixel, claiming pixels within TOLERANCE of the
 *      background color. Only border-CONNECTED regions are removed — a white
 *      shirt inside the mark survives even on a white background.
 *   3. Soften: claimed pixels get alpha from their distance to the background
 *      color (a hard binary cut leaves a halo of antialiased edge pixels).
 *   4. Trim to the content's bounding box plus padding, so the icon fills the
 *      box it was drawn into instead of floating in the generator's margins.
 */
import sharp from "sharp";

export interface RemoveBackgroundResult {
  png: Buffer;
  /** Share of pixels removed — a sanity signal (icons land ~0.5–0.9). */
  removedRatio: number;
}

/** Euclidean RGB distance within which a pixel counts as "the background". */
const TOLERANCE = 42;
/** Content bbox padding, as a fraction of the trimmed dimension. */
const PAD_FRAC = 0.06;

export const removeBackground = async (png: Buffer): Promise<RemoveBackgroundResult> => {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = data; // RGBA

  // 1. Background estimate: median of the border ring, per channel.
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const pushBorder = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    rs.push(px[i]);
    gs.push(px[i + 1]);
    bs.push(px[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    pushBorder(x, 0);
    pushBorder(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    pushBorder(0, y);
    pushBorder(w - 1, y);
  }
  const median = (a: number[]) => a.sort((m, n) => m - n)[Math.floor(a.length / 2)];
  const bgR = median(rs);
  const bgG = median(gs);
  const bgB = median(bs);

  const dist = (i: number) => {
    const dr = px[i] - bgR;
    const dg = px[i + 1] - bgG;
    const db = px[i + 2] - bgB;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  // 2. BFS flood fill from the border.
  const claimed = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const tryClaim = (x: number, y: number) => {
    const p = y * w + x;
    if (claimed[p]) return;
    if (dist(p * 4) > TOLERANCE) return;
    claimed[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < w; x++) {
    tryClaim(x, 0);
    tryClaim(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryClaim(0, y);
    tryClaim(w - 1, y);
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) tryClaim(x - 1, y);
    if (x < w - 1) tryClaim(x + 1, y);
    if (y > 0) tryClaim(x, y - 1);
    if (y < h - 1) tryClaim(x, y + 1);
  }

  // 3. Alpha: claimed pixels fade by closeness to the background so the
  // antialiased rim keeps its partial coverage instead of leaving a halo.
  let removed = 0;
  for (let p = 0; p < w * h; p++) {
    if (!claimed[p]) continue;
    removed++;
    const d = dist(p * 4);
    // d = 0 → fully background (alpha 0); d = TOLERANCE → keep ~half.
    const alpha = Math.max(0, Math.min(1, (d / TOLERANCE - 0.4) / 0.6));
    px[p * 4 + 3] = Math.round(px[p * 4 + 3] * alpha);
  }

  // 4. Content bbox on meaningful alpha.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const removedRatio = removed / (w * h);
  if (maxX < 0) {
    // Everything vanished (a blank generation) — return the original rather
    // than an empty file; the user sees what the model actually made.
    return { png, removedRatio };
  }
  const padX = Math.round((maxX - minX + 1) * PAD_FRAC);
  const padY = Math.round((maxY - minY + 1) * PAD_FRAC);
  const left = Math.max(0, minX - padX);
  const top = Math.max(0, minY - padY);
  const cw = Math.min(w, maxX + padX + 1) - left;
  const ch = Math.min(h, maxY + padY + 1) - top;

  const out = await sharp(px, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left, top, width: cw, height: ch })
    .png()
    .toBuffer();
  return { png: out, removedRatio };
};
