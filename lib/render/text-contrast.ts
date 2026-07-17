/**
 * Per-text-node contrast (v15, Lever C) — measured legibility against the
 * LOCAL backdrop each text node actually sits on.
 *
 * Cycle-6 evidence (Robinhood): s0 shipped a GHOST headline — white text
 * inside the panel the v12 washout lift had just repainted WHITE — and s4
 * shipped dim grey mock-interior labels on near-black. Both sailed through
 * every existing arm: the washout gate judges REGION luminance statistics
 * (the ghost's panel had plenty of spread from other content), the vision
 * judge called both scenes clean, and the old render-truth `contrast`
 * advisory computed text color vs the MEAN of the text's own box — a proxy
 * that both under-fires (a busy box's mean sits mid-scale) and false-fires
 * (cycle-4 s4 flagged a perfectly legible navy-on-cream headline at
 * "1.15:1" because the box mean averaged the glyphs in).
 *
 * v15 RETIRES that whole-box advisory (render-truth-gates findContrast's
 * text arm) and replaces it with this: per text node, the LOCAL BACKDROP is
 * sampled from the screenshot as the DOMINANT luminance cluster of the
 * node's (slightly grown) rect — the mode excludes the glyphs and the
 * antialiasing fringe, so the ratio is text-ink vs the surface actually
 * behind it. The text color is the DOM's computed color composited with the
 * element's own opacity and the color's alpha (dimness via rgba/opacity is
 * real dimness).
 *
 * Verdict bands (WCAG contrast ratio):
 *   ratio < TEXT_CONTRAST_BLOCK_RATIO at ≥ TEXT_CONTRAST_BLOCK_MIN_PX
 *     → BLOCKING text-contrast finding (the ghost class);
 *   TEXT_CONTRAST_BLOCK_RATIO ≤ ratio < TEXT_CONTRAST_ADVISORY_RATIO
 *     → advisory (the dim-labels class rides along on regens);
 *   small text (TEXT_CONTRAST_SMALL_MIN_PX..BLOCK_MIN_PX) under the block
 *     ratio → advisory only (mock micro-labels are routinely 11-13px; a
 *     blocking arm there would fight intentional diegetic dimness).
 *
 * Precision guards:
 *   - a BUSY backdrop (dominant cluster < BUSY_BACKDROP_MIN_FRAC of sampled
 *     pixels — photography, gradients with wide range) never BLOCKS: the
 *     mode is not a faithful "the surface" there; it advises instead;
 *   - covered nodes (something painted on top) are the cross-piece gate's
 *     territory — skipped;
 *   - oversized decorative type (≥ DECORATIVE_MIN_PX at ≤ DECORATIVE_MAX_OPACITY)
 *     is the intentional watermark-numeral device — skipped;
 *   - per-scene caps keep regen prompts bounded.
 *
 * CALIBRATION (2026-07-17, sampled on the archived dogfood frames via the
 * re-measured element walks — see text-contrast.test.ts for pinned nodes):
 *   MUST FIRE (blocking) — Robinhood s0 ghost headline (white on the lifted
 *     white panel, ratio ~1.0-1.3);
 *   MUST FIRE (≥ advisory) — Robinhood s4 dim mock labels;
 *   MUST PASS — every clean frame across cycles 1-6 (no blocking finding).
 *
 * Fail posture: sharp is dynamic-imported; its absence or a read failure
 * degrades to errors[] (never a fabricated finding, never a throw).
 */
import type { MeasuredElement, SceneMeasurement } from "./measure-scene";

// ── calibrated bands ─────────────────────────────────────────────────────────

export const TEXT_CONTRAST_BLOCK_RATIO = 2.5;
export const TEXT_CONTRAST_ADVISORY_RATIO = 4.5;
/** Blocking arm applies at/above this computed font size. */
export const TEXT_CONTRAST_BLOCK_MIN_PX = 14;
/** Small-text advisory arm floor — mock interior micro-labels are routinely
 *  8-10px (cycle-6 s4's "Account Setup"/"Step 4 of 4" measured 8.5/9px). */
export const TEXT_CONTRAST_SMALL_MIN_PX = 8;
/** Dominant-cluster share below which the backdrop is "busy" (never blocks).
 *  Calibrated: the cycle-6 ghost samples 0.49 (must block, 1.4x margin);
 *  photo/gradient backdrops sample 0.2-0.4. */
export const BUSY_BACKDROP_MIN_FRAC = 0.35;
/** Saturated display text (channel spread ≥ this) on a strongly hue-distant
 *  backdrop reads by CHROMATIC contrast the luminance ratio can't see (lime
 *  "MURDER" on white measured 1.33:1 yet reads) — ≥32px such text demotes to
 *  advisory, never blocks. Same-hue-on-same-hue keeps blocking (the rgb
 *  distance guard fails there). */
export const SATURATED_SPREAD_MIN = 120;
export const SATURATED_MIN_PX = 32;
export const SATURATED_BD_DIST_MIN = 150;
/** Oversized low-opacity type = deliberate decorative watermark — skipped. */
const DECORATIVE_MIN_PX = 100;
const DECORATIVE_MAX_OPACITY = 0.35;
/** Rect grow (px per side) so thin glyph-tight rects still sample backdrop. */
const SAMPLE_PAD_PX = 3;
const MIN_TEXT_LEN = 2;
const MAX_BLOCKING_PER_SCENE = 4;
const MAX_ADVISORY_PER_SCENE = 4;
/** Luma histogram bin width (0-255 → 32 bins). */
const BIN_W = 8;

// ── types ────────────────────────────────────────────────────────────────────

export interface TextContrastStat {
  scene: number;
  pieceId: string;
  text: string;
  fontSize: number;
  /** WCAG ratio of the effective text color vs the sampled local backdrop. */
  ratio: number;
  /** Sampled dominant backdrop color. */
  backdrop: { r: number; g: number; b: number };
  /** Dominant-cluster share of sampled pixels (low = busy backdrop). */
  backdropFrac: number;
  /** Saturated display text on a hue-distant backdrop (chromatic contrast —
   *  never blocks; see SATURATED_* docs). */
  chromatic?: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface TextContrastFinding {
  kind: "text-contrast";
  scene: number;
  pieceId: string;
  blocking: boolean;
  ratio: number;
  detail: string;
  repairInstruction: string;
  stats: TextContrastStat;
}

export interface TextContrastResult {
  /** Every judged node with ratio under the advisory ceiling (report fodder). */
  stats: TextContrastStat[];
  findings: TextContrastFinding[];
  advisories: TextContrastFinding[];
  errors: string[];
}

// ── color math (WCAG) ────────────────────────────────────────────────────────

export const relLum = (r: number, g: number, b: number): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export const wcagRatio = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number => {
  const la = relLum(a.r, a.g, a.b);
  const lb = relLum(b.r, b.g, b.b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Parse a css color into rgba (rgb()/rgba()/#hex). null when unparseable. */
export const parseCssColor = (
  s: string,
): { r: number; g: number; b: number; a: number } | null => {
  const t = (s || "").trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(t);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(t);
  if (hex3) {
    const [r, g, b] = hex3[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(t);
  if (!m) return null;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 && !Number.isNaN(p[3]) ? p[3] : 1 };
};

// ── candidate selection ──────────────────────────────────────────────────────

/** The node's VISIBLE rect (clip-aware when the walk provides it) — sampling
 *  the LAYOUT rect would read pixels where the text does not paint (the
 *  cycle-6 ghost span's layout box extends past its clipped panel onto the
 *  canvas, which made the backdrop look dark and the ghost look fine). */
export const judgeRect = (e: MeasuredElement): { x: number; y: number; w: number; h: number } =>
  typeof e.vw === "number" && typeof e.vh === "number"
    ? { x: e.vx ?? e.x, y: e.vy ?? e.y, w: e.vw, h: e.vh }
    : { x: e.x, y: e.y, w: e.w, h: e.h };

export const isJudgeableTextNode = (e: MeasuredElement, canvasArea: number): boolean => {
  const v = judgeRect(e);
  return (
    !e.isImg &&
    e.text.trim().length >= MIN_TEXT_LEN &&
    e.fontSize >= TEXT_CONTRAST_SMALL_MIN_PX &&
    e.opacity > 0.05 &&
    !e.coveredAtCenter &&
    v.w >= 4 &&
    v.h >= 4 &&
    v.w * v.h < 0.6 * canvasArea &&
    !(e.fontSize >= DECORATIVE_MIN_PX && e.opacity <= DECORATIVE_MAX_OPACITY)
  );
};

// ── backdrop sampling ────────────────────────────────────────────────────────

interface RawImage {
  data: Buffer | Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/**
 * Dominant-cluster backdrop of a rect on a raw RGB(A) buffer: 32-bin luma
 * histogram with per-bin RGB sums; the modal bin merged with its neighbors is
 * the backdrop cluster (glyphs + antialias fringe live in other bins).
 *
 * GLYPH-DOMINATION fix: for large display type the glyphs can OUTNUMBER the
 * backdrop inside the tight rect (LiquidDeath's 72px "TO PLASTIC BOTTLES"
 * sampled its own white glyphs as "backdrop" → a false 1.0:1). When the modal
 * cluster is fg-toned (rgb distance < 60 from the node's computed color), the
 * backdrop is instead the largest cluster whose luma clearly differs from the
 * fg (>16, carrying ≥15% of pixels). When NO such cluster exists the rect is
 * fg-toned wall-to-wall — the true ghost (cycle-6 s0) — and the modal cluster
 * stands, correctly reporting ~1:1.
 */
export const sampleBackdrop = (
  img: RawImage,
  rect: { x: number; y: number; w: number; h: number },
  fg?: { r: number; g: number; b: number },
  opts?: { allowAltCluster?: boolean },
): { r: number; g: number; b: number; frac: number } | null => {
  const x0 = Math.max(0, Math.floor(rect.x - SAMPLE_PAD_PX));
  const y0 = Math.max(0, Math.floor(rect.y - SAMPLE_PAD_PX));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w + SAMPLE_PAD_PX));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h + SAMPLE_PAD_PX));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const bins = new Array(32).fill(0);
  const sums = Array.from({ length: 32 }, () => [0, 0, 0]);
  const total = (x1 - x0) * (y1 - y0);
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 40_000)));
  let n = 0;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * img.width + x) * img.channels;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const bin = Math.min(31, Math.floor(luma / BIN_W));
      bins[bin] += 1;
      sums[bin][0] += r;
      sums[bin][1] += g;
      sums[bin][2] += b;
      n += 1;
    }
  }
  if (n === 0) return null;
  const clusterAt = (center: number): { r: number; g: number; b: number; frac: number } | null => {
    let cn = 0;
    const c = [0, 0, 0];
    for (const b of [center - 1, center, center + 1]) {
      if (b < 0 || b > 31) continue;
      cn += bins[b];
      c[0] += sums[b][0];
      c[1] += sums[b][1];
      c[2] += sums[b][2];
    }
    if (cn === 0) return null;
    return { r: c[0] / cn, g: c[1] / cn, b: c[2] / cn, frac: cn / n };
  };
  let mode = 0;
  for (let b = 1; b < 32; b++) if (bins[b] > bins[mode]) mode = b;
  const modal = clusterAt(mode);
  if (!modal) return null;
  if (fg && opts?.allowAltCluster) {
    const dist = Math.sqrt((modal.r - fg.r) ** 2 + (modal.g - fg.g) ** 2 + (modal.b - fg.b) ** 2);
    if (dist < 60) {
      // Modal cluster is the glyphs — find the largest clearly-non-fg cluster.
      const fgLuma = 0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b;
      let alt = -1;
      for (let b = 0; b < 32; b++) {
        const binLuma = b * BIN_W + BIN_W / 2;
        if (Math.abs(binLuma - fgLuma) <= 16) continue;
        if (alt === -1 || bins[b] > bins[alt]) alt = b;
      }
      if (alt !== -1) {
        const altCluster = clusterAt(alt);
        if (altCluster && altCluster.frac >= 0.15) return altCluster;
      }
    }
  }
  return modal;
};

// ── the gate ─────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const findingFor = (s: TextContrastStat, blocking: boolean): TextContrastFinding => ({
  kind: "text-contrast",
  scene: s.scene,
  pieceId: s.pieceId,
  blocking,
  ratio: s.ratio,
  detail:
    `scene ${s.scene}: text "${s.text.slice(0, 40)}" (piece ${s.pieceId}, ${s.fontSize}px at ` +
    `${s.rect.x},${s.rect.y}) measures ${round2(s.ratio)}:1 against its LOCAL backdrop ` +
    `rgb(${Math.round(s.backdrop.r)},${Math.round(s.backdrop.g)},${Math.round(s.backdrop.b)}) — ` +
    `${blocking ? `under the ${TEXT_CONTRAST_BLOCK_RATIO}:1 legibility floor: near-invisible` : `in the dim band (${TEXT_CONTRAST_BLOCK_RATIO}-${TEXT_CONTRAST_ADVISORY_RATIO}:1): readable but anemic`}.`,
  repairInstruction: blocking
    ? `Recolor this text so it reads against the surface it actually sits on: pick the palette ink ` +
      `most luminance-distant from that backdrop (dark ink on light surfaces, white/near-white on dark) — ` +
      `target comfortably above ${TEXT_CONTRAST_ADVISORY_RATIO}:1. Never repaint the surface to match the text; ` +
      `fix the TEXT color (or give the text its own opaque contrasting chip).`
    : `ADVISORY (non-blocking) — while regenerating, ALSO lift this text's contrast against its local ` +
      `backdrop above ${TEXT_CONTRAST_ADVISORY_RATIO}:1 (a decisive ink, not another mid-grey).`,
  stats: s,
});

/**
 * Judge every text node of every measured scene against its sampled local
 * backdrop. Needs the scene screenshots; sharp decodes them (dynamic import —
 * absence degrades to errors, not a crash).
 */
export const assessTextNodeContrast = async (
  measurements: SceneMeasurement[],
): Promise<TextContrastResult> => {
  const result: TextContrastResult = { stats: [], findings: [], advisories: [], errors: [] };
  const sharpMod = await import("sharp").catch(() => null);
  if (!sharpMod) {
    result.errors.push("text-contrast: sharp unavailable — gate skipped");
    return result;
  }
  const sharp = sharpMod.default;

  for (const m of measurements) {
    if (m.error || !m.screenshotPath) continue;
    let img: RawImage;
    try {
      const { data, info } = await sharp(m.screenshotPath)
        .raw()
        .toBuffer({ resolveWithObject: true });
      img = { data, width: info.width, height: info.height, channels: info.channels };
    } catch (err) {
      result.errors.push(
        `scene ${m.scene}: screenshot decode failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
      continue;
    }
    const canvasArea = m.width * m.height;
    const sceneStats: TextContrastStat[] = [];
    for (const e of m.elements) {
      if (!isJudgeableTextNode(e, canvasArea)) continue;
      const fg = parseCssColor(e.color);
      if (!fg) continue;
      // Glyph-domination alt-cluster switch only for DISPLAY sizes (≥32px):
      // below that, glyphs cannot outnumber the backdrop in the rect, so a
      // fg-toned modal cluster IS a ghost backdrop (Patagonia's 20px dark-on-
      // dark wordmark must not reinterpret its light surround as backdrop).
      const bd = sampleBackdrop(img, judgeRect(e), fg, {
        allowAltCluster: e.fontSize >= SATURATED_MIN_PX,
      });
      if (!bd) continue;
      // Effective ink: the computed color composited over the backdrop with
      // the color's alpha × the element's own opacity.
      const a = Math.max(0, Math.min(1, fg.a * e.opacity));
      const eff = {
        r: a * fg.r + (1 - a) * bd.r,
        g: a * fg.g + (1 - a) * bd.g,
        b: a * fg.b + (1 - a) * bd.b,
      };
      const ratio = wcagRatio(eff, bd);
      if (ratio >= TEXT_CONTRAST_ADVISORY_RATIO) continue;
      // Saturated display text on a hue-distant backdrop reads chromatically —
      // record it, but mark it never-blocking (see SATURATED_* docs).
      const spread = Math.max(fg.r, fg.g, fg.b) - Math.min(fg.r, fg.g, fg.b);
      const bdDist = Math.sqrt((fg.r - bd.r) ** 2 + (fg.g - bd.g) ** 2 + (fg.b - bd.b) ** 2);
      const chromatic =
        e.fontSize >= SATURATED_MIN_PX && spread >= SATURATED_SPREAD_MIN && bdDist >= SATURATED_BD_DIST_MIN;
      sceneStats.push({
        scene: m.scene,
        pieceId: e.piece || `s${m.scene}.hero`,
        text: e.text.slice(0, 60),
        fontSize: e.fontSize,
        ratio: round2(ratio),
        backdrop: { r: Math.round(bd.r), g: Math.round(bd.g), b: Math.round(bd.b) },
        backdropFrac: round2(bd.frac),
        chromatic,
        rect: judgeRect(e),
      });
    }
    // Worst-first; dedupe identical (piece,text) repeats (inline children of
    // the same node re-report the same run).
    sceneStats.sort((a, b) => a.ratio - b.ratio);
    const seen = new Set<string>();
    let blockingCount = 0;
    let advisoryCount = 0;
    for (const s of sceneStats) {
      const key = `${s.pieceId}|${s.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.stats.push(s);
      const solidBackdrop = s.backdropFrac >= BUSY_BACKDROP_MIN_FRAC;
      const bigEnoughToBlock = s.fontSize >= TEXT_CONTRAST_BLOCK_MIN_PX;
      if (s.ratio < TEXT_CONTRAST_BLOCK_RATIO && bigEnoughToBlock && solidBackdrop && !s.chromatic) {
        if (blockingCount < MAX_BLOCKING_PER_SCENE) {
          result.findings.push(findingFor(s, true));
          blockingCount += 1;
        }
      } else if (advisoryCount < MAX_ADVISORY_PER_SCENE) {
        result.advisories.push(findingFor(s, false));
        advisoryCount += 1;
      }
    }
  }
  return result;
};
