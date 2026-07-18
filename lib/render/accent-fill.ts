/**
 * Accent-as-fill gate — deterministic detection of a brand ACCENT used as a
 * PANEL FILL inside a hero piece.
 *
 * Why (dogfood cycle 1, 2026-07-16): Liquid Death scene 3 shipped a HUGE flat
 * #00ff00 slab covering the right half of the hero's ledger panel. Every
 * existing sensor passed it: hue-lock passed it (it IS the brand accent),
 * hero-washout passed it (white-vs-green luminance spread 243), and the vision
 * judge passed it. The defect is not color or contrast — it is PROPORTION:
 * brand accent is punctuation (chips, rules, badges, highlights), never a
 * panel fill. So this gate measures proportion.
 *
 * How: same browser-canvas pattern as hero-contrast.ts. The hero region is the
 * union of the measured rects of every element in a ".hero" piece (reused from
 * heroRegionsFromMeasurement). The scene PNG is decoded IN A BROWSER PAGE and,
 * within each hero region, a boolean mask of "accent-colored" pixels is built
 * on a stride grid, then the LARGEST AXIS-ALIGNED RECTANGLE of accent-colored
 * cells is found (maximal-rectangle-in-binary-matrix, histogram method). A
 * blocking "accent-as-fill" finding fires when that rectangle exceeds
 * ACCENT_FILL_MAX_FRAC of the hero region's area.
 *
 * "Accent-colored" (per pixel, 0-255 ints, vs each theme accent token):
 *   - pixel chroma (max−min) ≥ max(CHROMA_FLOOR, 0.5 × accent chroma) — pale
 *     and neutral pixels never match, whatever their hue;
 *   - circular hue distance ≤ HUE_TOL_DEG;
 *   - |Rec.709 luminance − accent luminance| ≤ LUMA_TOL — a dark canvas that
 *     merely shares the accent's hue family (Klarna's #0a051c under #7a5ea6)
 *     does not match.
 *   Accent tokens with chroma < NEUTRAL_ACCENT_CHROMA are skipped entirely
 *   (a neutral "accent" cannot be hue-matched).
 *
 * CALIBRATION (2026-07-17, real artifacts on disk — see accent-fill.test.ts):
 *   MUST FAIL — dogfood cycle-1 Liquid Death s3.hero
 *     (.data/dogfood/cycle1-liquiddeath/frames/scene3.png, region 864×640 @
 *     1056,220, accent #00ff00): the flat green slab measures ~44% of the
 *     region as one rectangle.
 *   MUST PASS — cycle-1 s1.hero (accent used as red rules/dots only) and the
 *     v8 Klarna heroes (.data/acceptance8/v8/scene{0,1,3,4}.png, accent
 *     #7a5ea6 — purple lives in glows and chips, never a slab).
 *   Threshold: ACCENT_FILL_MAX_FRAC = 0.30 — the failing slab is ~1.5× above
 *   it; the loudest passing hero sits well under it. (The spec band was
 *   30-35%; 0.30 keeps margin against a slab partially broken by overlaid
 *   outlines while chips/badges/buttons remain an order of magnitude smaller.)
 *
 * Fail posture: findings are returned, never thrown. Unsampleable regions land
 * in `errors` — no finding is fabricated from a measurement failure.
 */
import { promises as fs } from "fs";
import type { Page } from "playwright";
import type { SceneMeasurement } from "./measure-scene";
import { heroRegionsFromMeasurement, type HeroRegion } from "./hero-contrast";

// ── calibrated thresholds ────────────────────────────────────────────────────

/** Largest accent-colored rectangle as a fraction of the hero region's area.
 *  Above this = the accent is a panel fill, not punctuation. */
export const ACCENT_FILL_MAX_FRAC = 0.3;
/** Audit-1 Medium #6: register-aware ceiling. On a FULL-BLEED scene the hero IS
 *  the canvas, so a larger brand-colored field is a legitimate design (a
 *  full-frame brand wash), not the unfinished-slab defect. Raise the ceiling
 *  there so we don't false-fire on a deliberate full-bleed brand-color scene.
 *  Non-full-bleed registers keep the strict 0.30 (never lowered → no new FPs). */
export const ACCENT_FILL_MAX_FRAC_FULLBLEED = 0.5;
export const accentFillCeilingFor = (register?: string): number =>
  register === "full-bleed" ? ACCENT_FILL_MAX_FRAC_FULLBLEED : ACCENT_FILL_MAX_FRAC;
/** Circular hue tolerance (degrees) for "this pixel is the accent". */
export const HUE_TOL_DEG = 20;
/** Rec.709 luminance tolerance (0-255) vs the accent token. */
export const LUMA_TOL = 50;
/** Minimum pixel chroma to be judged at all (see module doc). */
export const CHROMA_FLOOR = 30;
/** Accent tokens with chroma under this are neutrals — skipped. */
export const NEUTRAL_ACCENT_CHROMA = 24;
/** Sampling grid: at most ~250k cells per region. */
const MAX_SAMPLED_CELLS = 250_000;

// ── types ────────────────────────────────────────────────────────────────────

export interface AccentFillStats {
  scene: number;
  pieceId: string;
  region: { x: number; y: number; w: number; h: number };
  /** Largest axis-aligned accent-colored rectangle, canvas px. */
  rect: { x: number; y: number; w: number; h: number };
  /** rect area / region area. THE gate metric. */
  largestRectFrac: number;
  /** Total accent-colored fraction of the region (context, not the trigger). */
  coverageFrac: number;
  /** The accent hexes the mask matched against. */
  accents: string[];
}

export interface AccentFillFinding {
  kind: "accent-as-fill";
  scene: number;
  pieceId: string;
  blocking: true;
  detail: string;
  repairInstruction: string;
  stats: AccentFillStats;
}

export interface AccentFillResult {
  stats: AccentFillStats[];
  findings: AccentFillFinding[];
  errors: string[];
}

// ── accent token prep (Node side) ────────────────────────────────────────────

interface AccentSpec {
  hex: string;
  hue: number;
  chroma: number;
  luma: number;
}

const hexToRgb = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

const hueOf = (r: number, g: number, b: number): number => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return ((h * 60) % 360 + 360) % 360;
};

/** Parse + filter the theme accent hexes into judgeable specs. */
export const accentSpecs = (accents: string[]): AccentSpec[] => {
  const out: AccentSpec[] = [];
  for (const hex of accents) {
    const rgb = hexToRgb(hex);
    if (!rgb) continue;
    const [r, g, b] = rgb;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma < NEUTRAL_ACCENT_CHROMA) continue; // neutral "accent" — unjudgeable by hue
    out.push({ hex, hue: hueOf(r, g, b), chroma, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b });
  }
  return out;
};

// ── in-browser sampling (closure-free — serialized by Playwright) ────────────

interface RawAccentStats {
  error?: string;
  bestCells?: number;
  bestX?: number; // cell coords, ×stride for px offsets within the region
  bestY?: number;
  bestW?: number; // cells
  bestH?: number;
  matchedCells?: number;
  totalCells?: number;
  stride?: number;
}

const pageAccentSampler = async (args: {
  dataUri: string;
  regions: { x: number; y: number; w: number; h: number }[];
  accents: { hue: number; chroma: number; luma: number }[];
  hueTol: number;
  lumaTol: number;
  chromaFloor: number;
  maxCells: number;
}): Promise<RawAccentStats[]> => {
  const { dataUri, regions, accents, hueTol, lumaTol, chromaFloor, maxCells } = args;
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return regions.map(() => ({ error: "no 2d canvas context" }));
  ctx.drawImage(img, 0, 0);
  const out: RawAccentStats[] = [];
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
    const stride = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxCells)));
    const cols = Math.floor((w - 1) / stride) + 1;
    const rows = Math.floor((h - 1) / stride) + 1;
    // Boolean mask of accent-colored cells.
    const mask = new Uint8Array(cols * rows);
    let matched = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = (cy * stride * w + cx * stride) * 4;
        const pr = data[i];
        const pg = data[i + 1];
        const pb = data[i + 2];
        const max = pr > pg ? (pr > pb ? pr : pb) : pg > pb ? pg : pb;
        const min = pr < pg ? (pr < pb ? pr : pb) : pg < pb ? pg : pb;
        const chroma = max - min;
        if (chroma < chromaFloor) continue;
        let hue = 0;
        if (chroma > 0) {
          if (max === pr) hue = ((pg - pb) / chroma) % 6;
          else if (max === pg) hue = (pb - pr) / chroma + 2;
          else hue = (pr - pg) / chroma + 4;
          hue = ((hue * 60) % 360 + 360) % 360;
        }
        const luma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
        for (const a of accents) {
          if (chroma < 0.5 * a.chroma) continue;
          const dh = Math.abs(hue - a.hue);
          if (Math.min(dh, 360 - dh) > hueTol) continue;
          if (Math.abs(luma - a.luma) > lumaTol) continue;
          mask[cy * cols + cx] = 1;
          matched++;
          break;
        }
      }
    }
    // Largest rectangle of true cells — histogram method, O(cols×rows).
    let best = 0;
    let bestX = 0, bestY = 0, bestW = 0, bestH = 0;
    const heights = new Int32Array(cols);
    const stackX = new Int32Array(cols + 1);
    const stackH = new Int32Array(cols + 1);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        heights[cx] = mask[cy * cols + cx] ? heights[cx] + 1 : 0;
      }
      let top = 0;
      for (let cx = 0; cx <= cols; cx++) {
        const hgt = cx < cols ? heights[cx] : 0;
        let startX = cx;
        while (top > 0 && stackH[top - 1] >= hgt) {
          top--;
          const rw = cx - stackX[top];
          const area = rw * stackH[top];
          if (area > best) {
            best = area;
            bestX = stackX[top];
            bestY = cy - stackH[top] + 1;
            bestW = rw;
            bestH = stackH[top];
          }
          startX = stackX[top];
        }
        stackX[top] = startX;
        stackH[top] = hgt;
        top++;
      }
    }
    out.push({
      bestCells: best,
      bestX, bestY, bestW, bestH,
      matchedCells: matched,
      totalCells: cols * rows,
      stride,
    });
  }
  return out;
};

// ── the gate ─────────────────────────────────────────────────────────────────

const pct = (f: number): string => `${Math.round(f * 1000) / 10}%`;

const findingFor = (stats: AccentFillStats, ceiling: number = ACCENT_FILL_MAX_FRAC): AccentFillFinding => ({
  kind: "accent-as-fill",
  scene: stats.scene,
  pieceId: stats.pieceId,
  blocking: true,
  detail:
    `scene ${stats.scene}: hero piece "${stats.pieceId}" uses the brand accent as a PANEL FILL — ` +
    `a single flat accent-colored rectangle of ${stats.rect.w}x${stats.rect.h}px covers ` +
    `${pct(stats.largestRectFrac)} of the hero's region (ceiling ${pct(ceiling)}; ` +
    `accent ${stats.accents.join("/")}). Accent at slab scale reads as an unfinished color block, ` +
    `whatever the hue-lock and washout gates thought of it.`,
  repairInstruction:
    `Repaint "${stats.pieceId}" so the brand accent is PUNCTUATION, never a fill: keep accent for ` +
    `chips, rules, badges, highlights, small buttons and data moments, and rebuild the slab area as ` +
    `a real furnished surface (a neutral/cardFill panel carrying rows, labels, values, or a product ` +
    `visual). No single accent-colored rectangle may dominate the piece — the largest one must stay ` +
    `well under ${pct(ACCENT_FILL_MAX_FRAC)} of the piece's area.`,
  stats,
});

/**
 * Run accent-as-fill detection over measured scenes. Probes every ".hero"
 * piece region on the scene PNG against the theme accent tokens. Pass an
 * existing Playwright `page` to reuse a browser; otherwise a headless chromium
 * is launched and closed internally.
 */
export const assessAccentFill = async (
  measurements: SceneMeasurement[],
  accents: string[],
  opts?: { page?: Page; registers?: (string | undefined)[] },
): Promise<AccentFillResult> => {
  const result: AccentFillResult = { stats: [], findings: [], errors: [] };
  const specs = accentSpecs(accents);
  if (specs.length === 0) return result; // no judgeable accent — nothing to probe

  const work: { m: SceneMeasurement; regions: HeroRegion[] }[] = [];
  for (const m of measurements) {
    if (!m.screenshotPath) continue; // measure gate already failed this scene closed
    const regions = heroRegionsFromMeasurement(m);
    if (regions.length > 0) work.push({ m, regions });
  }
  if (work.length === 0) return result;

  let page = opts?.page ?? null;
  let browser: import("playwright").Browser | null = null;
  if (!page) {
    try {
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
        `accent-fill: browser unavailable — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
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
      let raw: RawAccentStats[];
      try {
        raw = await page.evaluate(pageAccentSampler, {
          dataUri: `data:image/png;base64,${png.toString("base64")}`,
          regions: regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
          accents: specs.map((a) => ({ hue: a.hue, chroma: a.chroma, luma: a.luma })),
          hueTol: HUE_TOL_DEG,
          lumaTol: LUMA_TOL,
          chromaFloor: CHROMA_FLOOR,
          maxCells: MAX_SAMPLED_CELLS,
        });
      } catch (err) {
        result.errors.push(`scene ${m.scene}: sampling failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        continue;
      }
      for (const [i, r] of raw.entries()) {
        const region = regions[i];
        if (r.error || r.totalCells === undefined || r.totalCells === 0) {
          result.errors.push(`scene ${m.scene} ${region.pieceId}: ${r.error ?? "no cells sampled"}`);
          continue;
        }
        const stride = r.stride ?? 1;
        const stats: AccentFillStats = {
          scene: region.scene,
          pieceId: region.pieceId,
          region: { x: region.x, y: region.y, w: region.w, h: region.h },
          rect: {
            x: region.x + (r.bestX ?? 0) * stride,
            y: region.y + (r.bestY ?? 0) * stride,
            w: (r.bestW ?? 0) * stride,
            h: (r.bestH ?? 0) * stride,
          },
          largestRectFrac:
            Math.round((((r.bestCells ?? 0) * stride * stride) / (region.w * region.h)) * 1000) / 1000,
          coverageFrac:
            Math.round((((r.matchedCells ?? 0) * stride * stride) / (region.w * region.h)) * 1000) / 1000,
          accents: specs.map((a) => a.hex),
        };
        result.stats.push(stats);
        const ceiling = accentFillCeilingFor(opts?.registers?.[m.scene]);
        if (stats.largestRectFrac > ceiling) {
          result.findings.push(findingFor(stats, ceiling));
        }
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return result;
};
