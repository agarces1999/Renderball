/**
 * Skeleton-bar detector (v13 #4) — the MEASURED arm of the NO_PLACEHOLDER
 * contract.
 *
 * Why: cycle-4 (Oatly) s3 shipped claim rows whose interiors read as a
 * loading-skeleton — wide grey rounded bars where copy should be. The prompt
 * already BANS the idiom ("never emit skeleton/placeholder bars"); prompts are
 * norms, and the bake-off evidence says models meet checked rules and miss
 * prose norms. This is the check: rendered DOM measured in the real browser,
 * grey no-text bars found geometrically.
 *
 * Shape (per the cycle-5 fix contract): ≥3 SIBLING flat mid-grey rounded
 * rects, each >60px wide, with no text descendants = one skeleton ROW →
 * structural finding `skeleton_bars`, ADVISORY; a piece carrying ≥2 such rows
 * is BLOCKING (a whole panel of fake loading content).
 *
 * Definitions (measured fields from measure-scene's PAGE_WALK):
 *   sibling   — same nearest-recorded-ancestor (`parentIx`).
 *   flat      — own solid background (alpha ≥ 0.9), no background-image/
 *               gradient, opacity > 0.05.
 *   mid-grey  — near-neutral (max−min channel ≤ 16) with mean channel in
 *               [100, 235]: the skeleton grey band. Near-black (dark-canvas
 *               surfaces) and near-white (paper cards) stay out.
 *   rounded   — computed border-top-left-radius ≥ 3px.
 *   bar       — w > 60px, and 4px ≤ h ≤ 48px with w ≥ 2h (a BAR, not a card
 *               or an avatar block).
 *   no text   — no own text and no text anywhere in the subtree
 *               (`hasTextDesc` false).
 *
 * Calibration note (2026-07-17): cycle-4 s3's actual bars measure 306x10
 * r3 GRADIENT-filled, ONE bar per claim card (two different parents) — below
 * this detector's ≥3-sibling firing shape and excluded by `flat`. That
 * instance is the motivating CLASS, not a must-fire fixture; the detector is
 * the forward arm for the canonical ≥3-stacked-bars skeleton look. Elements
 * measured without `parentIx`/`radius`/`hasTextDesc` (older fixtures) are
 * never candidates — fail-open by construction.
 */
import type { MeasuredElement, SceneMeasurement } from "./measure-scene";

/** A qualifying bar must be wider than this. */
export const SKELETON_BAR_MIN_W = 60;
/** Sibling bars needed under one parent to make a skeleton row. */
export const SKELETON_ROW_MIN_BARS = 3;
/** Rows in one piece at which the finding turns blocking. */
export const SKELETON_BLOCKING_MIN_ROWS = 2;
/** Mid-grey band: mean RGB channel within this range… */
export const SKELETON_GREY_MEAN_MIN = 100;
export const SKELETON_GREY_MEAN_MAX = 235;
/** …and near-neutral: max−min channel at most this. */
export const SKELETON_GREY_NEUTRAL_MAX = 16;
const MIN_RADIUS = 3;
const BAR_MIN_H = 4;
const BAR_MAX_H = 48;

export interface SkeletonBarFinding {
  kind: "skeleton-bars";
  scene: number;
  /** Piece carrying the bars — regen routing targets this id. */
  pieceId: string;
  /** Advisory at 1 row; blocking at ≥SKELETON_BLOCKING_MIN_ROWS rows. */
  blocking: boolean;
  /** Sibling clusters of ≥SKELETON_ROW_MIN_BARS qualifying bars. */
  rows: number;
  /** Total qualifying bars across those rows. */
  bars: number;
  detail: string;
  repairInstruction: string;
}

const rgbOf = (c: string): [number, number, number] | null => {
  const m = /rgba?\(([^)]+)\)/.exec(c || "");
  if (!m) return null;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  return p.length >= 3 && p.slice(0, 3).every((v) => !Number.isNaN(v))
    ? [p[0], p[1], p[2]]
    : null;
};

const cssAlphaOf = (c: string): number => {
  const m = /rgba?\(([^)]+)\)/.exec(c || "");
  if (!m) return 0;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  return p.length >= 4 ? (Number.isNaN(p[3]) ? 1 : p[3]) : 1;
};

/** One flat mid-grey rounded no-text bar, per the module-header definition. */
export const isSkeletonBarCandidate = (e: MeasuredElement): boolean => {
  if (e.parentIx === undefined || e.parentIx < 0) return false;
  if (e.w <= SKELETON_BAR_MIN_W || e.h < BAR_MIN_H || e.h > BAR_MAX_H) return false;
  if (e.w < 2 * e.h) return false;
  if (e.isImg || e.text !== "" || e.hasTextDesc !== false) return false;
  if ((e.radius ?? 0) < MIN_RADIUS) return false;
  if (e.opacity <= 0.05 || e.hasBgImage) return false;
  if (cssAlphaOf(e.bg) < 0.9) return false;
  const rgb = rgbOf(e.bg);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  const mean = (r + g + b) / 3;
  return (
    Math.max(r, g, b) - Math.min(r, g, b) <= SKELETON_GREY_NEUTRAL_MAX &&
    mean >= SKELETON_GREY_MEAN_MIN &&
    mean <= SKELETON_GREY_MEAN_MAX
  );
};

/**
 * Skeleton-bar findings for one measured scene: one finding per piece that
 * carries at least one skeleton row (≥3 qualifying sibling bars).
 *
 * Audit-1 Medium #5: DOWNGRADED to advisory (blocking always false). The gate
 * never fired across dogfood cycles 1-9, and its mid-grey band [100,235] is
 * blind to the real risk — a light-brand near-white skeleton (~#eee) — so it
 * could only ever block a defect it cannot see. It rides along as a telemetry/
 * repair advisory; a scene is never blocked on it. (SKELETON_BLOCKING_MIN_ROWS
 * is kept only to describe the "whole panel of it" wording.)
 */
export const findSkeletonBars = (m: SceneMeasurement): SkeletonBarFinding[] => {
  if (m.error) return [];
  const byParent = new Map<number, MeasuredElement[]>();
  for (const e of m.elements) {
    if (!isSkeletonBarCandidate(e)) continue;
    const key = e.parentIx as number;
    byParent.set(key, [...(byParent.get(key) ?? []), e]);
  }
  const byPiece = new Map<string, { rows: number; bars: number }>();
  for (const group of byParent.values()) {
    if (group.length < SKELETON_ROW_MIN_BARS) continue;
    const pieceId = group[0].piece || "";
    const acc = byPiece.get(pieceId) ?? { rows: 0, bars: 0 };
    acc.rows += 1;
    acc.bars += group.length;
    byPiece.set(pieceId, acc);
  }
  const out: SkeletonBarFinding[] = [];
  for (const [pieceId, acc] of byPiece) {
    const wholePanel = acc.rows >= SKELETON_BLOCKING_MIN_ROWS;
    out.push({
      kind: "skeleton-bars",
      scene: m.scene,
      pieceId,
      blocking: false, // advisory only (see header) — never blocks a scene
      rows: acc.rows,
      bars: acc.bars,
      detail:
        `scene ${m.scene}: ${pieceId || "(no piece)"} renders ${acc.rows} skeleton row(s) — ` +
        `${acc.bars} flat mid-grey rounded no-text bars >${SKELETON_BAR_MIN_W}px wide stacked as siblings. ` +
        `That is the loading-skeleton look: fake content where real content should be` +
        `${wholePanel ? " (≥2 rows = a whole panel of it)" : ""}.`,
      repairInstruction:
        `Replace every grey placeholder bar with REAL rendered content: concrete labels, values, and ` +
        `copy in the brand's palette and type (rows with names, prices, stats — never abstract grey ` +
        `capsules). If a row exists only to fill space, delete it and let a real element own the region.`,
    });
  }
  return out.sort((a, b) => a.pieceId.localeCompare(b.pieceId));
};
