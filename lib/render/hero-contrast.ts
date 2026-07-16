/**
 * Hero-contrast gate — deterministic WASHOUT detection for hero pieces.
 *
 * Why (acceptance v5, 2026-07-16): scene 0's hero shipped as a beautiful desk
 * tableau painted pale-blue-on-pale-blue. The vision judge's readability
 * clause PASSED it — opinion failed — so this gate measures instead: it
 * samples the ACTUAL rendered pixels of the hero's region on the scene
 * screenshot and computes luminance statistics. A hero whose region has
 * neither tonal spread nor variance is a washout, regardless of how tasteful
 * the judge found it.
 *
 * How: the gate loop already captures a PNG per scene (measure-scene.ts) and
 * already measured every element's bounds. The hero region is the union of
 * the measured rects of every element belonging to a piece whose data-piece
 * id ends in ".hero", clamped to the canvas. The PNG buffer is decoded IN A
 * BROWSER PAGE — data-URI into an <img>, drawn to a <canvas>, getImageData on
 * the hero-bounds region — so there is no Node-side PNG dependency (Playwright
 * is already a dependency of the measure path). Rec.709 luminance per sampled
 * pixel (L = 0.2126R + 0.7152G + 0.0722B, 0–255), then:
 *
 *   spread = p95 − p5 of the luminance distribution
 *   stdDev = standard deviation of the luminance distribution
 *
 * A hero is a WASHOUT (blocking "hero-washout" finding) when BOTH fall below
 * the calibrated floors — spread alone can be faked by a couple of dark
 * pixels; variance alone by dithered noise. Both low = a flat, single-tone
 * region where a product mock should be.
 *
 * CALIBRATION (2026-07-16, measured on the real artifacts. Bounds are NOT
 * persisted in the v5 build report, so hero bounds were RE-MEASURED via the
 * exact SSR/measure path that produced the PNGs — measureScenes on the v5
 * genDir src/generated/CAST_SPIKE_A5_GLM52 and on the reassembled Duolingo
 * reference 01KWTMK9WXRZNF7X553R9AN63M. Validity check: the freshly rendered
 * frames' region stats matched the archived PNGs on disk to within rounding
 * on every region, so the re-measured bounds are exact for the disk PNGs):
 *
 *   MUST FAIL — v5 scene 0 hero (s0.hero, the pale-blue-on-pale-blue desk
 *     tableau vision passed; 800x540 @ 1020,270 on
 *     .data/acceptance5/glm52-fireworks/scene0.png):
 *       spread 30, stdDev 15.1
 *   MUST PASS — v5 scene 1 hero (s1.hero, the tab cluster — decent contrast;
 *     768x640 @ 1056,220): spread 227, stdDev 54.8
 *   MUST PASS — v5 s3.hero (780x520 @ 1020,280): spread 62, stdDev 27.7
 *              — v5 s4.hero (825x280 @ 560,700):  spread 90, stdDev 25.9
 *   MUST PASS — Duolingo reference s3.hero (the only ".hero" piece in the
 *     reference build; 560x421 @ 680,279 on
 *     .data/acceptance/reference/scene3.png): spread 90, stdDev 24.0
 *   also fails (correctly) — v5 s2.hero, the hollow lone-element hero:
 *     spread 0, stdDev 5.5 (double-caught: the per-hero density floor names
 *     it too — a void is both thin AND flat).
 *   context — Duolingo reference main diegetic pieces: s1.phone 229/68.4,
 *     s2.cards 26/24.4, s4.panel 12/22.8 — low-spread but high-variance
 *     surfaces, which is exactly why the gate requires BOTH floors breached.
 *
 *   Floors: WASHOUT_SPREAD_FLOOR = 45, WASHOUT_STDDEV_FLOOR = 19.
 *   The failing hero sits at 0.67x / 0.79x of the floors; the nearest passing
 *   hero on each axis (v5 s3.hero spread 62 = 1.38x; ref s3.hero stdDev 24.0
 *   = 1.26x) clears them — and because BOTH must be under to fire, reference
 *   pieces whose spread is low but whose variance is real (s4.panel 12/22.8)
 *   still pass.
 *
 * Fail posture: findings are returned, never thrown. A region that cannot be
 * sampled (decode error, degenerate bounds) is reported in `errors` — the
 * caller decides; no finding is fabricated from a measurement failure.
 */
import { promises as fs } from "fs";
import type { Page } from "playwright";
import type { SceneMeasurement } from "./measure-scene";

// ── calibrated floors ────────────────────────────────────────────────────────

/** p95−p5 luminance spread floor. Failing hero measured 30; nearest passing
 *  hero 62 (see module header for the full calibration table). */
export const WASHOUT_SPREAD_FLOOR = 45;
/** Luminance standard-deviation floor. Failing hero measured 15.1; nearest
 *  passing hero 24.0. BOTH floors must be breached to fire. */
export const WASHOUT_STDDEV_FLOOR = 19;

/** Regions thinner than this in either dimension are unmeasurable noise. */
const MIN_REGION_PX = 8;
/** Sampling stride cap: at most ~250k pixels are sampled per region. */
const MAX_SAMPLED_PIXELS = 250_000;

// ── types ────────────────────────────────────────────────────────────────────

export interface HeroRegion {
  scene: number;
  pieceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HeroLuminanceStats {
  scene: number;
  pieceId: string;
  region: { x: number; y: number; w: number; h: number };
  mean: number;
  stdDev: number;
  p05: number;
  p95: number;
  /** p95 − p05 — the tonal range actually painted in the hero region. */
  spread: number;
  sampledPixels: number;
}

export interface HeroWashoutFinding {
  kind: "hero-washout";
  scene: number;
  /** The hero piece the finding names — retry routing targets this id. */
  pieceId: string;
  blocking: true;
  detail: string;
  repairInstruction: string;
  stats: HeroLuminanceStats;
}

export interface HeroContrastResult {
  /** Stats for EVERY measurable hero region (pass or fail) — report fodder. */
  stats: HeroLuminanceStats[];
  findings: HeroWashoutFinding[];
  /** Regions/scenes that could not be sampled (no finding fabricated). */
  errors: string[];
}

// ── hero bounds from the measure pass ────────────────────────────────────────

/**
 * Hero regions of one measured scene: per piece whose id ends in ".hero", the
 * union of its member elements' measured rects, clamped to the canvas. The
 * piece wrapper itself is display:contents (no box — measure-scene skips
 * 0x0 rects), so the union of member boxes IS the hero's painted footprint.
 */
export const heroRegionsFromMeasurement = (m: SceneMeasurement): HeroRegion[] => {
  const byPiece = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const el of m.elements) {
    if (!el.piece || !el.piece.endsWith(".hero")) continue;
    if (el.w <= 0 || el.h <= 0) continue;
    const b = byPiece.get(el.piece) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, el.x);
    b.y0 = Math.min(b.y0, el.y);
    b.x1 = Math.max(b.x1, el.x + el.w);
    b.y1 = Math.max(b.y1, el.y + el.h);
    byPiece.set(el.piece, b);
  }
  const out: HeroRegion[] = [];
  for (const [pieceId, b] of byPiece) {
    const x = Math.max(0, Math.floor(b.x0));
    const y = Math.max(0, Math.floor(b.y0));
    const w = Math.min(m.width, Math.ceil(b.x1)) - x;
    const h = Math.min(m.height, Math.ceil(b.y1)) - y;
    if (w < MIN_REGION_PX || h < MIN_REGION_PX) continue;
    out.push({ scene: m.scene, pieceId, x, y, w, h });
  }
  return out.sort((a, b2) => a.pieceId.localeCompare(b2.pieceId));
};

// ── in-browser sampling ──────────────────────────────────────────────────────

// Runs INSIDE the page (serialized by Playwright — a REAL function, not a
// string: Playwright evaluates string pageFunctions as bare expressions and
// drops the argument): decode the PNG from a data-URI, draw to canvas,
// getImageData per region, return luminance stats. Percentiles via a 256-bin
// histogram; stride keeps sampling bounded. Must stay closure-free.
const pageSampler = async (args: {
  dataUri: string;
  regions: { x: number; y: number; w: number; h: number }[];
  maxSampled: number;
}): Promise<RawRegionStats[]> => {
  const { dataUri, regions, maxSampled } = args;
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return regions.map(() => ({ error: "no 2d canvas context" }));
  ctx.drawImage(img, 0, 0);
  const out: RawRegionStats[] = [];
  for (const r of regions) {
    const x = Math.max(0, Math.min(r.x, canvas.width - 1));
    const y = Math.max(0, Math.min(r.y, canvas.height - 1));
    const w = Math.min(r.w, canvas.width - x);
    const h = Math.min(r.h, canvas.height - y);
    if (w < 1 || h < 1) {
      out.push({ error: "region outside image bounds" });
      continue;
    }
    const data = ctx.getImageData(x, y, w, h).data;
    const total = w * h;
    const stride = Math.max(1, Math.floor(Math.sqrt(total / maxSampled)));
    const hist = new Array(256).fill(0);
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let py = 0; py < h; py += stride) {
      for (let px = 0; px < w; px += stride) {
        const i = (py * w + px) * 4;
        const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        const bin = Math.max(0, Math.min(255, Math.round(L)));
        hist[bin] += 1;
        n += 1;
        sum += L;
        sumSq += L * L;
      }
    }
    if (n === 0) {
      out.push({ error: "no pixels sampled" });
      continue;
    }
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const pct = (q: number): number => {
      const target = q * n;
      let acc = 0;
      for (let b = 0; b < 256; b++) {
        acc += hist[b];
        if (acc >= target) return b;
      }
      return 255;
    };
    out.push({ mean, stdDev: Math.sqrt(variance), p05: pct(0.05), p95: pct(0.95), sampledPixels: n });
  }
  return out;
};

interface RawRegionStats {
  error?: string;
  mean?: number;
  stdDev?: number;
  p05?: number;
  p95?: number;
  sampledPixels?: number;
}

/**
 * Luminance stats for arbitrary regions of one PNG buffer, sampled in the
 * given (already-open) browser page. Exposed so callers with non-".hero"
 * regions (e.g. a gallery comparing a reference build's main diegetic piece)
 * can reuse the exact sampling path the gate uses.
 */
export const luminanceStatsForRegions = async (
  page: Page,
  png: Buffer,
  regions: { x: number; y: number; w: number; h: number }[],
): Promise<RawRegionStats[]> => {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return await page.evaluate(pageSampler, {
    dataUri,
    regions: regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    maxSampled: MAX_SAMPLED_PIXELS,
  });
};

// ── the gate ─────────────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;

const findingFor = (stats: HeroLuminanceStats): HeroWashoutFinding => ({
  kind: "hero-washout",
  scene: stats.scene,
  pieceId: stats.pieceId,
  blocking: true,
  detail:
    `scene ${stats.scene}: hero piece "${stats.pieceId}" is a WASHOUT — its rendered region ` +
    `(${stats.region.w}x${stats.region.h} at ${stats.region.x},${stats.region.y}) has luminance ` +
    `spread ${round1(stats.spread)} (p95−p5; floor ≥${WASHOUT_SPREAD_FLOOR}) and std-dev ` +
    `${round1(stats.stdDev)} (floor ≥${WASHOUT_STDDEV_FLOOR}). The hero paints in a single tonal ` +
    `band — near-tone-on-tone with no readable structure, whatever the vision judge thought of it.`,
  repairInstruction:
    `Repaint "${stats.pieceId}" with REAL tonal contrast against its own fills and the canvas: ` +
    `anchor the mock on a surface that separates from the background (a distinctly lighter/darker ` +
    `panel, a card with a visible edge and shadow), use INK-dark text and accent-colored elements ` +
    `for interior details, and reserve pale tints for at most the surface itself — never for the ` +
    `content painted on it. The region's luminance spread (p95−p5) must comfortably exceed ` +
    `${WASHOUT_SPREAD_FLOOR} once real darks and accents are present.`,
  stats,
});

/**
 * Run washout detection over measured scenes. For each scene with a
 * screenshot and at least one ".hero" piece, samples the hero region(s) on
 * the scene PNG and emits a blocking "hero-washout" finding when both
 * calibrated floors are breached. Pass an existing Playwright `page` to reuse
 * a browser (the spike loop); otherwise a headless chromium is launched and
 * closed internally.
 */
export const assessHeroWashout = async (
  measurements: SceneMeasurement[],
  opts?: { page?: Page },
): Promise<HeroContrastResult> => {
  const result: HeroContrastResult = { stats: [], findings: [], errors: [] };
  const work: { m: SceneMeasurement; regions: HeroRegion[] }[] = [];
  for (const m of measurements) {
    if (!m.screenshotPath) {
      // No screenshot = the measure gate already failed this scene closed;
      // nothing for the contrast gate to add.
      continue;
    }
    const regions = heroRegionsFromMeasurement(m);
    if (regions.length > 0) work.push({ m, regions });
  }
  if (work.length === 0) return result;

  let page = opts?.page ?? null;
  let browser: import("playwright").Browser | null = null;
  if (!page) {
    try {
      // Same CJS/ESM interop dance as measure-scene.ts (hot-recompile can
      // re-wrap the module so `chromium` lands under `.default`).
      const pw = (await import("playwright")) as unknown as {
        chromium?: typeof import("playwright").chromium;
        default?: { chromium?: typeof import("playwright").chromium };
      };
      const chromium = pw.chromium ?? pw.default?.chromium;
      if (!chromium) throw new Error("playwright loaded but `chromium` export is undefined");
      browser = await chromium.launch({ args: ["--no-sandbox"] });
      page = await browser.newPage();
    } catch (err) {
      result.errors.push(
        `hero-contrast: browser unavailable — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
      if (browser) await browser.close().catch(() => {});
      return result;
    }
  }

  try {
    for (const { m, regions } of work) {
      let png: Buffer;
      try {
        png = await fs.readFile(m.screenshotPath!);
      } catch (err) {
        result.errors.push(`scene ${m.scene}: screenshot unreadable — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let raw: RawRegionStats[];
      try {
        raw = await luminanceStatsForRegions(page, png, regions);
      } catch (err) {
        result.errors.push(`scene ${m.scene}: sampling failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        continue;
      }
      for (const [i, r] of raw.entries()) {
        const region = regions[i];
        if (r.error || r.mean === undefined) {
          result.errors.push(`scene ${m.scene} ${region.pieceId}: ${r.error ?? "no stats returned"}`);
          continue;
        }
        const stats: HeroLuminanceStats = {
          scene: region.scene,
          pieceId: region.pieceId,
          region: { x: region.x, y: region.y, w: region.w, h: region.h },
          mean: round1(r.mean),
          stdDev: round1(r.stdDev ?? 0),
          p05: r.p05 ?? 0,
          p95: r.p95 ?? 0,
          spread: (r.p95 ?? 0) - (r.p05 ?? 0),
          sampledPixels: r.sampledPixels ?? 0,
        };
        result.stats.push(stats);
        if (stats.spread < WASHOUT_SPREAD_FLOOR && stats.stdDev < WASHOUT_STDDEV_FLOOR) {
          result.findings.push(findingFor(stats));
        }
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return result;
};
