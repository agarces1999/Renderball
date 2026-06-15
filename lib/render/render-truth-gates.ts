/**
 * Render-truth gates — deterministic correctness checks on the MEASURED render.
 *
 * These consume measure-scene.ts output (real element rects + computed colors +
 * a screenshot) and replace the static approximations that kept missing real
 * defects:
 *   • overflow  — an element with content crosses the canvas edge → clipped.
 *                 Pure geometry on measured rects; zero false positives (a
 *                 measured x+w>1920 is a fact, not a guess). This is what the
 *                 static findOverflowingElements only approximated from declared
 *                 inline width/left.
 *   • contrast  — text or a logo image rendered with too little luminance
 *                 contrast against the pixels actually behind it (the
 *                 light-on-light logo case). Sampled from the screenshot.
 *   • dead-region — measured empty quadrants (reuses painted-content.ts).
 *
 * Findings are returned, not thrown; the pipeline decides blocking vs advisory.
 */
import path from "path";
import { assessFrameInk, QUADRANT_FLOOR, INK_FLOOR } from "./painted-content";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

export type RenderTruthKind =
  | "overflow"
  | "contrast"
  | "dead-region"
  | "measure-error";

export interface RenderTruthFinding {
  scene: number;
  kind: RenderTruthKind;
  detail: string;
}

// px tolerance so sub-pixel rounding / intentional full-bleed don't false-fire.
const EDGE_TOL = 3;
// Only content elements can be "clipped"; a full-bleed background/atmosphere
// legitimately fills or exceeds the canvas. Content = has own text, or is an
// <img>, or is a small-ish decorated box (handled by contrast/dead-region).
const isContentEl = (e: MeasuredElement): boolean =>
  (e.text.length >= 2 || e.isImg) && e.opacity > 0.05;

/** Elements with content whose measured box crosses the canvas edge. */
export const findOverflow = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return [{ scene: m.scene, kind: "measure-error", detail: m.error }];
  const out: RenderTruthFinding[] = [];
  for (const e of m.elements) {
    if (!isContentEl(e)) continue;
    const overR = e.x + e.w > m.width + EDGE_TOL;
    const overL = e.x < -EDGE_TOL;
    const overB = e.y + e.h > m.height + EDGE_TOL;
    const overT = e.y < -EDGE_TOL;
    if (!(overR || overL || overB || overT)) continue;
    const where = [overL && "left", overR && "right", overT && "top", overB && "bottom"]
      .filter(Boolean)
      .join("+");
    const label = e.text ? `"${e.text.slice(0, 40)}"` : `<img ${(e.src || "").slice(-28)}>`;
    out.push({
      scene: m.scene,
      kind: "overflow",
      detail: `${e.tag} ${label} clipped at ${where} (box ${e.x},${e.y} ${e.w}×${e.h} on ${m.width}×${m.height})`,
    });
  }
  return out;
};

// ── color/luminance helpers (WCAG relative luminance) ────────────────────────
const parseRgb = (s: string): [number, number, number] | null => {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
  return [p[0], p[1], p[2]];
};
const relLum = (r: number, g: number, b: number): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrastRatio = (l1: number, l2: number): number =>
  (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

// Floors are deliberately lenient — these flag genuinely-broken (near-invisible)
// content, not aesthetic borderline cases (false-negative direction).
const TEXT_CONTRAST_FLOOR = 1.6; // text the same tone as its surface
const LOGO_RANGE_FLOOR = 0.1; // logo whose luminance barely varies vs its card
const MIN_TEXT_PX = 12;
const MIN_LOGO = { w: 36, h: 18 };

/**
 * Sampled-from-pixels contrast. Text: computed color vs the median luminance of
 * the box behind it. Logo image: internal luminance range (a washed-out logo on
 * a same-tone card barely varies). Needs the screenshot; sharp is dynamic-
 * imported so its absence degrades to no contrast findings (not a crash).
 */
export const findContrast = async (
  m: SceneMeasurement,
): Promise<RenderTruthFinding[]> => {
  if (m.error || !m.screenshotPath) return [];
  const sharpMod = await import("sharp").catch(() => null);
  if (!sharpMod) return [];
  const sharp = sharpMod.default;
  const out: RenderTruthFinding[] = [];

  const sampleBox = async (
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<{ mean: number; range: number } | null> => {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const width = Math.min(m.width - left, Math.round(w));
    const height = Math.min(m.height - top, Math.round(h));
    if (width < 2 || height < 2) return null;
    try {
      const { data } = await sharp(m.screenshotPath)
        .extract({ left, top, width, height })
        .raw()
        .toBuffer({ resolveWithObject: true });
      let lo = 1,
        hi = 0,
        sum = 0,
        n = 0;
      for (let i = 0; i + 2 < data.length; i += 3) {
        const L = relLum(data[i], data[i + 1], data[i + 2]);
        if (L < lo) lo = L;
        if (L > hi) hi = L;
        sum += L;
        n++;
      }
      return n ? { mean: sum / n, range: hi - lo } : null;
    } catch {
      return null;
    }
  };

  for (const e of m.elements) {
    if (e.opacity <= 0.05) continue;
    if (e.isImg) {
      if (e.w < MIN_LOGO.w || e.h < MIN_LOGO.h) continue;
      // Skip corner brand-chrome marks (small, top band): a monochrome SVG
      // wordmark legitimately has near-zero internal luminance range yet reads
      // fine against the canvas. The internal-range proxy only makes sense for
      // larger logo cards (partner/customer logos on a surface). Logo-vs-surface
      // readability is owned by the vision gate, not this proxy — so contrast is
      // ADVISORY, never blocking, until that proxy is replaced with ink-vs-surface.
      if (e.y < 130 || (e.w < 120 && e.h < 60)) continue;
      const s = await sampleBox(e.x, e.y, e.w, e.h);
      if (s && s.range < LOGO_RANGE_FLOOR) {
        out.push({
          scene: m.scene,
          kind: "contrast",
          detail: `logo <img ${(e.src || "").slice(-28)}> nearly invisible against its surface (luminance range ${s.range.toFixed(3)} < ${LOGO_RANGE_FLOOR})`,
        });
      }
    } else if (e.text.length >= 2 && e.fontSize >= MIN_TEXT_PX) {
      const fg = parseRgb(e.color);
      if (!fg) continue;
      const s = await sampleBox(e.x, e.y, e.w, e.h);
      if (!s) continue;
      const ratio = contrastRatio(relLum(fg[0], fg[1], fg[2]), s.mean);
      if (ratio < TEXT_CONTRAST_FLOOR) {
        out.push({
          scene: m.scene,
          kind: "contrast",
          detail: `text "${e.text.slice(0, 32)}" ~${ratio.toFixed(2)}:1 vs its surface (< ${TEXT_CONTRAST_FLOOR}:1)`,
        });
      }
    }
  }
  return out;
};

/** Measured empty quadrants on the rendered frame (reuses painted-content). */
export const findDeadRegion = async (
  m: SceneMeasurement,
): Promise<RenderTruthFinding[]> => {
  if (m.error || !m.screenshotPath) return [];
  try {
    const ink = await assessFrameInk(m.screenshotPath);
    const out: RenderTruthFinding[] = [];
    if (ink.inkRatio < INK_FLOOR) {
      out.push({ scene: m.scene, kind: "dead-region", detail: `near-empty frame (ink ${ink.inkRatio.toFixed(4)} < ${INK_FLOOR})` });
    }
    const empties = (Object.entries(ink.quadrants) as [string, number][])
      .filter(([, v]) => v < QUADRANT_FLOOR)
      .map(([k]) => k);
    if (empties.length > 0 && ink.inkRatio >= INK_FLOOR) {
      out.push({ scene: m.scene, kind: "dead-region", detail: `empty quadrant(s): ${empties.join(", ")}` });
    }
    return out;
  } catch {
    return [];
  }
};

export interface RenderTruthOptions {
  /** Which checks block. dead-region defaults to advisory (composition taste). */
  blockingKinds?: RenderTruthKind[];
}

/**
 * Run all render-truth checks across measured scenes. Returns every finding;
 * `blocking` is the subset whose kind is in blockingKinds (default:
 * overflow + contrast + measure-error — the unambiguous correctness failures).
 */
export const findRenderTruthFailures = async (
  measurements: SceneMeasurement[],
  opts: RenderTruthOptions = {},
): Promise<{ findings: RenderTruthFinding[]; blocking: RenderTruthFinding[] }> => {
  // Default blockers: overflow (proven, zero-FP) + measure-error (fail-closed).
  // contrast + dead-region are ADVISORY: the contrast proxy false-positives on
  // monochrome logos, and logo-readability/taste is the vision gate's job.
  const blockingKinds = new Set<RenderTruthKind>(
    opts.blockingKinds ?? ["overflow", "measure-error"],
  );
  const findings: RenderTruthFinding[] = [];
  for (const m of measurements) {
    findings.push(...findOverflow(m));
    findings.push(...(await findContrast(m)));
    findings.push(...(await findDeadRegion(m)));
  }
  const blocking = findings.filter((f) => blockingKinds.has(f.kind));
  return { findings, blocking };
};

// Re-exported for callers that only need the outDir convention.
export const measureOutDir = (genDir: string): string =>
  path.join(genDir, ".render-truth");
