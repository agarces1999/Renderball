/**
 * Painted-content verification — pixel truth for rendered frames.
 *
 * Every existing gate in the pipeline is STATIC (parse, compile, SSR-eval):
 * none of them verifies that content actually PAINTS in the frames the user
 * exports. The sentry build (01KTQH4GC70VM6R4412Q729152) shipped a scene whose
 * eyebrow/h1/lede/bullets — all `opacity: 0` + `animation: s1fade … forwards`
 * with delays >= 2.3s — play in the browser preview but NEVER appear in the
 * rendered MP4 at any timestamp. The exported video silently lost content the
 * user approved, and every gate passed.
 *
 * This module measures "ink": pixels that differ meaningfully from the frame's
 * dominant background tone. It is pure measurement over PNG bytes (sharp), no
 * DOM, no renderer — so the dogfood stills path and any offline QA can call it
 * against real extracted frames, which are the only honest source of truth.
 *
 * ── Calibration (against the real frames in .data/dogfood/*-settled/) ──────
 * Measured at the defaults (colorDistance 32, sampleWidth 320), best frame per
 * scene across the sentry / raycast / posthog dogfood builds:
 *
 *   broken scene (sentry scene-1, invisible text)   inkRatio 0.0097–0.0135
 *   legit sparse dark-UI (raycast scene-0 / 1) best inkRatio 0.0297 / 0.0344
 *   everything else                            best inkRatio 0.06 – 0.13
 *
 * The floor suggested a priori (~0.04) would falsely flag the legitimate
 * Raycast dark-command-palette scenes, so INK_FLOOR is 0.02 — the geometric
 * midpoint of the empirical gap between "broken" (<= 0.0135) and "sparse but
 * real" (>= 0.0297): sqrt(0.0135 * 0.0297) ≈ 0.0200. With per-scene best-frame
 * scoring, the ONLY low-ink scene across all three real builds is the one that
 * is genuinely broken.
 *
 * QUADRANT_FLOOR (0.004 — "near-zero" = under 0.4% of a quadrant painted) is
 * the pixel-truth version of the "100% screen usage" rule: rich-but-asymmetric
 * frames pass (raycast scene-2-p80's lightest quadrant is 0.008, 2x margin;
 * posthog scene-4's lightest is 0.10) while genuinely dead quadrants in the
 * same corpus measure 0.001–0.003.
 *
 * Background detection is a dominant-bucket histogram (4 bits/channel), so the
 * soft radial gradients these comps use as backdrops do NOT count as ink: the
 * sentry gradient backdrop measures 0.000 ink in its empty quadrants at the
 * default colorDistance.
 */
import sharp from "sharp";

/** Per-quadrant ink share — each value is 0..1 of that quadrant's pixels. */
export interface QuadrantInk {
  tl: number;
  tr: number;
  bl: number;
  br: number;
}

export type QuadrantKey = keyof QuadrantInk;

export interface FrameInk {
  /** Share of sampled pixels differing meaningfully from the background, 0..1. */
  inkRatio: number;
  quadrants: QuadrantInk;
  /** Dominant background tone (diagnostics — what "ink" is measured against). */
  background: { r: number; g: number; b: number };
}

export interface InkOptions {
  /**
   * Euclidean RGB distance from the dominant background tone above which a
   * pixel counts as ink. 32 keeps soft backdrop gradients out of the count
   * while catching anti-aliased text (see calibration table above).
   */
  colorDistance?: number;
  /** Width the frame is downsampled to before measuring (speed, not fidelity). */
  sampleWidth?: number;
}

export interface VerifyOptions extends InkOptions {
  /** A scene whose BEST frame has less ink than this is flagged "low-ink". */
  inkFloor?: number;
  /** A best-frame quadrant with less ink than this is flagged "empty-quadrant". */
  quadrantFloor?: number;
}

export type PaintFlag = "low-ink" | "empty-quadrant" | "no-frames";

export interface SceneVerdict {
  scene: number;
  ok: boolean;
  flags: PaintFlag[];
  /** Index (into the scene's frames array) of the max-ink frame. -1 if none. */
  bestFrame: number;
  /** The best frame's measurements (zeroes when the scene had no frames). */
  inkRatio: number;
  quadrants: QuadrantInk;
  emptyQuadrants: QuadrantKey[];
  /** Every candidate frame's score, in input order — for manifests/debugging. */
  frames: { inkRatio: number; quadrants: QuadrantInk }[];
}

export interface PaintReport {
  ok: boolean;
  scenes: SceneVerdict[];
}

/** See the calibration table in the module header before changing these. */
export const INK_FLOOR = 0.02;
export const QUADRANT_FLOOR = 0.004;
export const DEFAULT_COLOR_DISTANCE = 32;
export const DEFAULT_SAMPLE_WIDTH = 320;
/** A downsampled row carrying less than this share of ink counts as "empty". */
export const ROW_INK_FLOOR = 0.006;
/** Wider sample for the band scan → more vertical rows (finer band resolution). */
export const BAND_SAMPLE_WIDTH = 480;

const ZERO_QUADRANTS: QuadrantInk = { tl: 0, tr: 0, bl: 0, br: 0 };

/**
 * Longest run of `true` in `empty[loInc..hiExc)`. Pure (no image) — the
 * band-scan's core, unit-tested directly. Returns the run length + its start
 * index (both in the caller's row units).
 */
export const largestEmptyRun = (
  empty: ReadonlyArray<boolean>,
  loInc: number,
  hiExc: number,
): { len: number; start: number } => {
  let runStart = -1;
  let best = 0;
  let bestStart = loInc;
  for (let y = loInc; y <= hiExc; y++) {
    const isEmpty = y < hiExc && empty[y] === true;
    if (isEmpty) {
      if (runStart < 0) runStart = y;
    } else if (runStart >= 0) {
      if (y - runStart > best) {
        best = y - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  return { len: best, start: bestStart };
};

export interface EmptyBand {
  /** Tallest empty horizontal band within the safe interior, as a fraction of frame H. */
  bandFracH: number;
  /** Where that band starts, as a fraction of frame H (diagnostics). */
  startFracH: number;
}

/**
 * The tallest horizontal band carrying (almost) no painted ink, within the safe
 * interior (top/bottom margins are expected clear). Pixel-truth version of the
 * barbell / empty-lower-half check — robust where an element-rect scan is not:
 * thin-bar visualizations (waveforms, sparklines, bar charts) ARE ink so their
 * body never reads empty, and soft gradient backdrops are discarded by the same
 * dominant-background subtraction assessFrameInk uses.
 */
export const assessEmptyBand = async (
  input: string | Buffer,
  opts: InkOptions & {
    rowInkFloor?: number;
    topMargin?: number;
    bottomMargin?: number;
  } = {},
): Promise<EmptyBand> => {
  const colorDistance = opts.colorDistance ?? DEFAULT_COLOR_DISTANCE;
  const sampleWidth = opts.sampleWidth ?? BAND_SAMPLE_WIDTH;
  const rowFloor = opts.rowInkFloor ?? ROW_INK_FLOOR;
  const topMargin = opts.topMargin ?? 0.1;
  const bottomMargin = opts.bottomMargin ?? 0.1;

  const { data, info } = await sharp(input)
    .resize({ width: sampleWidth, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const N = W * H;

  // Dominant background tone (same histogram as assessFrameInk).
  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    const r = data[p];
    const g = ch >= 3 ? data[p + 1] : r;
    const b = ch >= 3 ? data[p + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) {
      e[0]++;
      e[1] += r;
      e[2] += g;
      e[3] += b;
    } else {
      buckets.set(key, [1, r, g, b]);
    }
  }
  let dom: [number, number, number, number] = [1, 0, 0, 0];
  for (const e of buckets.values()) if (e[0] > dom[0]) dom = e;
  const bgR = dom[1] / dom[0];
  const bgG = dom[2] / dom[0];
  const bgB = dom[3] / dom[0];

  // Per-row ink share → an "empty" row is one below the floor.
  const d2 = colorDistance * colorDistance;
  const empty: boolean[] = new Array(H);
  for (let y = 0; y < H; y++) {
    let ink = 0;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * ch;
      const r = data[p];
      const g = ch >= 3 ? data[p + 1] : r;
      const b = ch >= 3 ? data[p + 2] : r;
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      if (dr * dr + dg * dg + db * db > d2) ink++;
    }
    empty[y] = W > 0 && ink / W < rowFloor;
  }
  const lo = Math.floor(H * topMargin);
  const hi = Math.ceil(H * (1 - bottomMargin));
  const run = largestEmptyRun(empty, lo, hi);
  return { bandFracH: H > 0 ? run.len / H : 0, startFracH: H > 0 ? run.start / H : 0 };
};

/** A downsampled COLUMN carrying less than this share of ink counts as
 *  "empty" (v15 occupancy). Higher than ROW_INK_FLOOR by design: faint
 *  atmosphere texture (ring lines, grain) must not break a void run — a
 *  column crossed only by a hairline or sparse texture is still a void.
 *  Calibrated with the v15 occupancy sweep (see occupancy.ts header). */
export const COLUMN_INK_FLOOR = 0.015;

export interface EmptyColumnRun {
  /** Widest contiguous run of empty columns, as a fraction of frame W. */
  runFracW: number;
  /** Where that run starts, as a fraction of frame W. */
  startFracW: number;
  /** Where it ends (exclusive), as a fraction of frame W. */
  endFracW: number;
}

/**
 * v15 (occupancy, Lever B) — the VERTICAL twin of assessEmptyBand: the widest
 * contiguous run of columns carrying (almost) no painted ink, over the FULL
 * width (margins included — a void that swallows a margin is still a void;
 * the caller's floor absorbs normal gutters). Same dominant-background
 * subtraction, so soft atmosphere gradients don't count as ink.
 */
export const assessEmptyColumnRun = async (
  input: string | Buffer,
  opts: InkOptions & { colInkFloor?: number } = {},
): Promise<EmptyColumnRun> => {
  const colorDistance = opts.colorDistance ?? DEFAULT_COLOR_DISTANCE;
  const sampleWidth = opts.sampleWidth ?? BAND_SAMPLE_WIDTH;
  const colFloor = opts.colInkFloor ?? COLUMN_INK_FLOOR;

  const { data, info } = await sharp(input)
    .resize({ width: sampleWidth, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const N = W * H;

  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    const r = data[p];
    const g = ch >= 3 ? data[p + 1] : r;
    const b = ch >= 3 ? data[p + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) {
      e[0]++;
      e[1] += r;
      e[2] += g;
      e[3] += b;
    } else {
      buckets.set(key, [1, r, g, b]);
    }
  }
  let dom: [number, number, number, number] = [1, 0, 0, 0];
  for (const e of buckets.values()) if (e[0] > dom[0]) dom = e;
  const bgR = dom[1] / dom[0];
  const bgG = dom[2] / dom[0];
  const bgB = dom[3] / dom[0];

  const d2 = colorDistance * colorDistance;
  const empty: boolean[] = new Array(W).fill(true);
  for (let x = 0; x < W; x++) {
    let ink = 0;
    for (let y = 0; y < H; y++) {
      const p = (y * W + x) * ch;
      const r = data[p];
      const g = ch >= 3 ? data[p + 1] : r;
      const b = ch >= 3 ? data[p + 2] : r;
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      if (dr * dr + dg * dg + db * db > d2) ink++;
    }
    empty[x] = H > 0 && ink / H < colFloor;
  }
  const run = largestEmptyRun(empty, 0, W);
  return {
    runFracW: W > 0 ? run.len / W : 0,
    startFracW: W > 0 ? run.start / W : 0,
    endFracW: W > 0 ? (run.start + run.len) / W : 0,
  };
};

export interface EmptyRowRun {
  /** Tallest contiguous run of empty rows, as a fraction of frame H. */
  runFracH: number;
  /** Where that run starts, as a fraction of frame H. */
  startFracH: number;
  /** Where it ends (exclusive), as a fraction of frame H. */
  endFracH: number;
  /** Leading empty rows from the top edge, as a fraction of H (the top margin). */
  topMarginFracH: number;
  /** Trailing empty rows to the bottom edge, as a fraction of H (bottom margin). */
  bottomMarginFracH: number;
}

/**
 * P3-C5 (occupancy, horizontal-void arm) — the HORIZONTAL twin of
 * assessEmptyColumnRun: the tallest contiguous run of ROWS carrying (almost) no
 * painted ink, over the FULL height (margins included — a bottom/top band that
 * swallows a margin is still a void; the caller's floor + edge-anchor absorb
 * normal gutters). The column-run arm sees only VERTICAL voids (a left/right
 * empty band); a content-top-weighted scene that abandons the bottom third
 * (Vanta s3) is invisible to it. Same dominant-background subtraction, so soft
 * atmosphere gradients don't count as ink. ROW_INK_FLOOR (not COLUMN_INK_FLOOR):
 * a row crossed only by a hairline/sparse texture is still empty.
 */
export const assessEmptyRowRun = async (
  input: string | Buffer,
  opts: InkOptions & { rowInkFloor?: number } = {},
): Promise<EmptyRowRun> => {
  const colorDistance = opts.colorDistance ?? DEFAULT_COLOR_DISTANCE;
  const sampleWidth = opts.sampleWidth ?? BAND_SAMPLE_WIDTH;
  const rowFloor = opts.rowInkFloor ?? ROW_INK_FLOOR;

  const { data, info } = await sharp(input)
    .resize({ width: sampleWidth, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const N = W * H;

  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    const r = data[p];
    const g = ch >= 3 ? data[p + 1] : r;
    const b = ch >= 3 ? data[p + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) {
      e[0]++;
      e[1] += r;
      e[2] += g;
      e[3] += b;
    } else {
      buckets.set(key, [1, r, g, b]);
    }
  }
  let dom: [number, number, number, number] = [1, 0, 0, 0];
  for (const e of buckets.values()) if (e[0] > dom[0]) dom = e;
  const bgR = dom[1] / dom[0];
  const bgG = dom[2] / dom[0];
  const bgB = dom[3] / dom[0];

  const d2 = colorDistance * colorDistance;
  const empty: boolean[] = new Array(H).fill(true);
  for (let y = 0; y < H; y++) {
    let ink = 0;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * ch;
      const r = data[p];
      const g = ch >= 3 ? data[p + 1] : r;
      const b = ch >= 3 ? data[p + 2] : r;
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      if (dr * dr + dg * dg + db * db > d2) ink++;
    }
    empty[y] = W > 0 && ink / W < rowFloor;
  }
  const run = largestEmptyRun(empty, 0, H);
  // Leading / trailing empty margins (distinguish a one-sided abandoned edge from
  // symmetric breathing room around vertically-centered content).
  let top = 0;
  while (top < H && empty[top]) top++;
  let bottom = 0;
  while (bottom < H && empty[H - 1 - bottom]) bottom++;
  return {
    runFracH: H > 0 ? run.len / H : 0,
    startFracH: H > 0 ? run.start / H : 0,
    endFracH: H > 0 ? (run.start + run.len) / H : 0,
    topMarginFracH: H > 0 ? top / H : 0,
    bottomMarginFracH: H > 0 ? bottom / H : 0,
  };
};

/**
 * v15 (occupancy anchors) — ink share per FRACTIONAL region (x/y/w/h all as
 * fractions of the frame), dominant-background subtracted like everything
 * else here. Used to pixel-verify that a claimed "anchor" motif actually
 * paints (a transparent wrapper or near-canvas gradient measures ~0).
 */
export const assessRegionInk = async (
  input: string | Buffer,
  regions: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  opts: InkOptions = {},
): Promise<number[]> => {
  if (regions.length === 0) return [];
  const colorDistance = opts.colorDistance ?? DEFAULT_COLOR_DISTANCE;
  const sampleWidth = opts.sampleWidth ?? BAND_SAMPLE_WIDTH;
  const { data, info } = await sharp(input)
    .resize({ width: sampleWidth, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const N = W * H;
  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    const r = data[p];
    const g = ch >= 3 ? data[p + 1] : r;
    const b = ch >= 3 ? data[p + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) { e[0]++; e[1] += r; e[2] += g; e[3] += b; }
    else buckets.set(key, [1, r, g, b]);
  }
  let dom: [number, number, number, number] = [1, 0, 0, 0];
  for (const e of buckets.values()) if (e[0] > dom[0]) dom = e;
  const bgR = dom[1] / dom[0];
  const bgG = dom[2] / dom[0];
  const bgB = dom[3] / dom[0];
  const d2 = colorDistance * colorDistance;
  return regions.map((reg) => {
    const x0 = Math.max(0, Math.floor(reg.x * W));
    const y0 = Math.max(0, Math.floor(reg.y * H));
    const x1 = Math.min(W, Math.ceil((reg.x + reg.w) * W));
    const y1 = Math.min(H, Math.ceil((reg.y + reg.h) * H));
    let ink = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * W + x) * ch;
        const r = data[p];
        const g = ch >= 3 ? data[p + 1] : r;
        const b = ch >= 3 ? data[p + 2] : r;
        const dr = r - bgR;
        const dg = g - bgG;
        const db = b - bgB;
        if (dr * dr + dg * dg + db * db > d2) ink++;
        n++;
      }
    }
    return n > 0 ? ink / n : 0;
  });
};

/**
 * Measure how much of a frame is actually painted.
 *
 * 1. Downsample to `sampleWidth` (measurement does not need full resolution).
 * 2. Find the dominant background tone: a 4-bit-per-channel histogram's most
 *    populous bucket, averaged. Robust to the soft gradients the generated
 *    comps use as backdrops (the gradient spreads across buckets; its densest
 *    band wins and nearby bands stay within `colorDistance`).
 * 3. Ink = pixels whose Euclidean RGB distance from that tone exceeds
 *    `colorDistance`, tallied overall and per screen quadrant.
 */
export const assessFrameInk = async (
  input: string | Buffer,
  opts: InkOptions = {},
): Promise<FrameInk> => {
  const colorDistance = opts.colorDistance ?? DEFAULT_COLOR_DISTANCE;
  const sampleWidth = opts.sampleWidth ?? DEFAULT_SAMPLE_WIDTH;

  const { data, info } = await sharp(input)
    .resize({ width: sampleWidth, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const ch = info.channels; // 3 for RGB; 1 for grayscale sources
  const N = W * H;

  // Dominant background tone — most populous 4-bit/channel bucket, averaged.
  // Map key: 12-bit bucket id → [count, sumR, sumG, sumB].
  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    const r = data[p];
    const g = ch >= 3 ? data[p + 1] : r;
    const b = ch >= 3 ? data[p + 2] : r;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) {
      e[0]++;
      e[1] += r;
      e[2] += g;
      e[3] += b;
    } else {
      buckets.set(key, [1, r, g, b]);
    }
  }
  let dom: [number, number, number, number] = [1, 0, 0, 0];
  for (const e of buckets.values()) if (e[0] > dom[0]) dom = e;
  const bgR = dom[1] / dom[0];
  const bgG = dom[2] / dom[0];
  const bgB = dom[3] / dom[0];

  // Ink tally, overall + per quadrant (denominators counted, not assumed, so
  // odd dimensions stay exact).
  const d2 = colorDistance * colorDistance;
  let ink = 0;
  const q = { tl: 0, tr: 0, bl: 0, br: 0 };
  const qn = { tl: 0, tr: 0, bl: 0, br: 0 };
  for (let y = 0; y < H; y++) {
    const bottom = y * 2 >= H;
    for (let x = 0; x < W; x++) {
      const right = x * 2 >= W;
      const key: QuadrantKey = bottom ? (right ? "br" : "bl") : right ? "tr" : "tl";
      qn[key]++;
      const p = (y * W + x) * ch;
      const r = data[p];
      const g = ch >= 3 ? data[p + 1] : r;
      const b = ch >= 3 ? data[p + 2] : r;
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      if (dr * dr + dg * dg + db * db > d2) {
        ink++;
        q[key]++;
      }
    }
  }

  return {
    inkRatio: N > 0 ? ink / N : 0,
    quadrants: {
      tl: qn.tl > 0 ? q.tl / qn.tl : 0,
      tr: qn.tr > 0 ? q.tr / qn.tr : 0,
      bl: qn.bl > 0 ? q.bl / qn.bl : 0,
      br: qn.br > 0 ? q.br / qn.br : 0,
    },
    background: { r: Math.round(bgR), g: Math.round(bgG), b: Math.round(bgB) },
  };
};

/**
 * Per-scene painted-content verdicts over candidate frames.
 *
 * `framesPerScene[i]` is the list of candidate frames (paths or PNG buffers)
 * extracted from scene i — e.g. the dogfood stills path samples each scene at
 * several progress points. Each scene is judged on its BEST (max-ink) frame,
 * so build-up/exit choreography can't fail a scene that does paint at its
 * peak; a scene whose best moment is still near-blank is genuinely broken:
 *
 *   "low-ink"        best frame's inkRatio < inkFloor — the invisible-content
 *                    failure mode (content that previews but never paints in
 *                    the export).
 *   "empty-quadrant" a best-frame quadrant under quadrantFloor — pixel-truth
 *                    "100% screen usage".
 *   "no-frames"      nothing to judge (treated as not ok).
 */
export const verifyPaintedScenes = async (
  framesPerScene: ReadonlyArray<ReadonlyArray<string | Buffer>>,
  opts: VerifyOptions = {},
): Promise<PaintReport> => {
  const inkFloor = opts.inkFloor ?? INK_FLOOR;
  const quadrantFloor = opts.quadrantFloor ?? QUADRANT_FLOOR;

  const scenes: SceneVerdict[] = [];
  for (let i = 0; i < framesPerScene.length; i++) {
    const frames = framesPerScene[i];
    if (frames.length === 0) {
      scenes.push({
        scene: i,
        ok: false,
        flags: ["no-frames"],
        bestFrame: -1,
        inkRatio: 0,
        quadrants: { ...ZERO_QUADRANTS },
        emptyQuadrants: ["tl", "tr", "bl", "br"],
        frames: [],
      });
      continue;
    }

    const scored: FrameInk[] = [];
    for (const f of frames) scored.push(await assessFrameInk(f, opts));

    let bestFrame = 0;
    for (let k = 1; k < scored.length; k++) {
      if (scored[k].inkRatio > scored[bestFrame].inkRatio) bestFrame = k;
    }
    const best = scored[bestFrame];

    const emptyQuadrants = (Object.keys(best.quadrants) as QuadrantKey[]).filter(
      (k) => best.quadrants[k] < quadrantFloor,
    );
    const flags: PaintFlag[] = [];
    if (best.inkRatio < inkFloor) flags.push("low-ink");
    if (emptyQuadrants.length > 0) flags.push("empty-quadrant");

    scenes.push({
      scene: i,
      ok: flags.length === 0,
      flags,
      bestFrame,
      inkRatio: best.inkRatio,
      quadrants: best.quadrants,
      emptyQuadrants,
      frames: scored.map((s) => ({ inkRatio: s.inkRatio, quadrants: s.quadrants })),
    });
  }

  return { ok: scenes.every((s) => s.ok), scenes };
};
