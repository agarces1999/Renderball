/**
 * Tests for the v15 occupancy budget (Lever B).
 *
 * Run: `node scripts/run-tests.mjs lib/render/occupancy.test.ts`
 *
 * Two layers:
 *  1. SYNTHETIC frames + elements lock the mechanics: the empty-column void
 *     band (blocking on quote/centered, advisory on split/stat), the
 *     diegetic-anchor exemption (a sparse drawn motif whose region paints ≥3%
 *     ink while its columns stay below the column floor), and the card-interior
 *     furnish advisory.
 *  2. REAL dogfood frames (.data/dogfood/cycleN/frames, gitignored) lock the
 *     column-run CALIBRATION: Robinhood s0 fires (≥floor), s1 passes, and the
 *     LiquidDeath-s2 22.7% false positive stays below the corrected 0.23 floor.
 *     Skipped with a notice when .data is absent (fresh clone / CI).
 */
import { promises as fs, existsSync } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  assessOccupancy,
  OCCUPANCY_RUN_FLOOR,
  OCCUPANCY_BLOCKING_REGISTERS,
  OCCUPANCY_ADVISORY_REGISTERS,
  CARD_INTERIOR_FLOOR,
} from "./occupancy";
import { assessEmptyColumnRun, COLUMN_INK_FLOOR } from "./painted-content";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

const el = (p: Partial<MeasuredElement>): MeasuredElement => ({
  tag: "div", x: 0, y: 0, w: 100, h: 100, color: "rgb(0,0,0)",
  bg: "rgba(0,0,0,0)", text: "", isImg: false, src: undefined, fontSize: 0,
  opacity: 1, piece: "", onOpaqueSurface: false, coveredAtCenter: false, ...p,
});

// ── synthetic frames (W=320 H=400: below BAND_SAMPLE_WIDTH so no resize, and
//    the tall frame lets a thin motif read as low column-ink but high region-ink) ──
const W = 320;
const H = 400;
const BLACK = { r: 0, g: 0, b: 0 };
type Rect = { x: number; y: number; w: number; h: number; color?: { r: number; g: number; b: number } };
const frame = (rects: Rect[]): Promise<Buffer> =>
  sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(rects.map((r) => ({ input: { create: { width: r.w, height: r.h, channels: 3, background: r.color ?? BLACK } }, top: r.y, left: r.x })))
    .png()
    .toBuffer();

const tmp = path.join(os.tmpdir(), `rb-occ-${process.pid}`);
const writeFrame = async (name: string, rects: Rect[]): Promise<string> => {
  await fs.mkdir(tmp, { recursive: true });
  const p = path.join(tmp, `${name}.png`);
  await fs.writeFile(p, await frame(rects));
  return p;
};

const sceneAt = (i: number, screenshotPath: string | undefined, els: MeasuredElement[]): SceneMeasurement => ({
  scene: i, width: W, height: H, elements: els, screenshotPath,
});

console.log("occupancy");

await check("void band on a QUOTE scene BLOCKS (right 60% empty, no anchor)", async () => {
  const p = await writeFrame("leftonly", [{ x: 0, y: 0, w: 128, h: H }]); // left 40% inked, right 60% void
  const r = await assessOccupancy([sceneAt(0, p, [])], ["quote"]);
  assert(r.findings.length === 1, `one void, got ${JSON.stringify(r.findings)}`);
  assert(r.findings[0].blocking === true, "quote → blocking");
  assert(r.findings[0].runFracW >= OCCUPANCY_RUN_FLOOR, `run ${r.findings[0].runFracW} ≥ ${OCCUPANCY_RUN_FLOOR}`);
  assert(r.findings[0].region === "right", `right void, got ${r.findings[0].region}`);
  assert(/FURNISH THE VOID/.test(r.findings[0].repairInstruction), "routing furnishes the void");
});

await check("the SAME void on a SPLIT scene ADVISES (never blocks) — honors 's2 must pass'", async () => {
  const p = await writeFrame("leftonly2", [{ x: 0, y: 0, w: 128, h: H }]);
  const r = await assessOccupancy([sceneAt(0, p, [])], ["split"]);
  assert(r.findings.length === 1 && r.findings[0].blocking === false, `split → advisory, got ${JSON.stringify(r.findings)}`);
  assert(OCCUPANCY_ADVISORY_REGISTERS.has("split") && !OCCUPANCY_BLOCKING_REGISTERS.has("split"), "split is advisory-only");
});

await check("a FURNISHED quote frame (content across the width) passes", async () => {
  // Content spread as 4 thin bands with sub-floor gaps (all < 0.23·W = 73.6px);
  // total ink stays < half the frame so WHITE remains the dominant background.
  const p = await writeFrame("furnished", [
    { x: 20, y: 0, w: 30, h: H },
    { x: 110, y: 0, w: 30, h: H },
    { x: 200, y: 0, w: 30, h: H },
    { x: 280, y: 0, w: 30, h: H },
  ]);
  const r = await assessOccupancy([sceneAt(0, p, [])], ["quote"]);
  assert(r.findings.length === 0, `no void, got ${JSON.stringify(r.findings)}`);
});

await check("a non-judged register (full-bleed) is exempt from the void arm", async () => {
  const p = await writeFrame("leftonly3", [{ x: 0, y: 0, w: 128, h: H }]);
  const r = await assessOccupancy([sceneAt(0, p, [])], ["full-bleed"]);
  assert(r.findings.length === 0, `full-bleed exempt, got ${JSON.stringify(r.findings)}`);
});

await check("DIEGETIC-ANCHOR EXEMPTION: a sparse motif in the void (region ≥3% ink, columns empty) is STAGED, not a defect", async () => {
  // A thin 80×5 bar: each column carries 5/400 = 1.25% ink (< the 1.5% column
  // floor → still an empty column) but its 80×80 anchor region is 6.25% inked.
  const motifPath = await writeFrame("motif", [
    { x: 0, y: 0, w: 128, h: H }, // left content
    { x: 192, y: 180, w: 80, h: 5 }, // the sparse motif inside the right void
  ]);
  const anchor = el({ tag: "svg", piece: "s0.hero", pieceKind: "diegetic", x: 192, y: 160, w: 80, h: 80 });
  const r = await assessOccupancy([sceneAt(0, motifPath, [anchor])], ["quote"]);
  assert(r.findings.length === 0, `anchored void is exempt, got ${JSON.stringify(r.findings)}`);
  assert(r.stats.length === 1 && !!r.stats[0].anchor, `anchor recorded: ${JSON.stringify(r.stats[0])}`);
  // Without the anchor ELEMENT (same pixels, but no drawn-motif piece), it fires.
  const r2 = await assessOccupancy([sceneAt(0, motifPath, [])], ["quote"]);
  assert(r2.findings.length === 1 && r2.findings[0].blocking, "no anchor element → the void fires");
});

await check("a plain opaque near-canvas slab does NOT anchor (an invisible panel IS the defect)", async () => {
  const p = await writeFrame("slab", [{ x: 0, y: 0, w: 128, h: H }]); // right void, all white
  // An opaque div (no svg/img/text/bg-image) centered in the void must not exempt it.
  const slab = el({ tag: "div", piece: "s0.hero", pieceKind: "diegetic", bg: "rgb(250,250,250)", x: 180, y: 150, w: 100, h: 100 });
  const r = await assessOccupancy([sceneAt(0, p, [slab])], ["quote"]);
  assert(r.findings.length === 1 && r.findings[0].blocking, `plain slab never anchors, got ${JSON.stringify(r.findings)}`);
});

await check("CARD-INTERIOR advisory: an opaque card whose interior is <40% furnished advises (never blocks)", async () => {
  const card = el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(30,30,40)", x: 100, y: 100, w: 300, h: 300 });
  const kid = el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(200,200,200)", x: 110, y: 110, w: 60, h: 40, parentIx: 0 });
  const m: SceneMeasurement = { scene: 3, width: 1920, height: 1080, elements: [card, kid], screenshotPath: undefined };
  const r = await assessOccupancy([m], ["split"]);
  assert(r.cardAdvisories.length === 1, `one card advisory, got ${JSON.stringify(r.cardAdvisories)}`);
  assert(r.cardAdvisories[0].blocking === false, "card advisory never blocks");
  assert(r.cardAdvisories[0].coverage < CARD_INTERIOR_FLOOR, `coverage ${r.cardAdvisories[0].coverage} < ${CARD_INTERIOR_FLOOR}`);
});

await check("a WELL-FURNISHED card interior does not advise", async () => {
  const card = el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(30,30,40)", x: 100, y: 100, w: 300, h: 300 });
  const kid = el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(200,200,200)", x: 110, y: 110, w: 280, h: 280, parentIx: 0 });
  const m: SceneMeasurement = { scene: 3, width: 1920, height: 1080, elements: [card, kid], screenshotPath: undefined };
  const r = await assessOccupancy([m], ["split"]);
  assert(r.cardAdvisories.length === 0, `well-furnished card, got ${JSON.stringify(r.cardAdvisories)}`);
});

await check("measure-error scenes and empty registers are skipped cleanly", async () => {
  const err: SceneMeasurement = { scene: 0, width: W, height: H, elements: [], error: "boom" };
  const r = await assessOccupancy([err], ["quote"]);
  assert(r.findings.length === 0 && r.errors.length === 0, "measure-error skipped, no fabricated findings");
});

await check("OCCUPANCY_RUN_FLOOR is the corrected 0.23", () => {
  assert(Math.abs(OCCUPANCY_RUN_FLOOR - 0.23) < 1e-9, `floor is 0.23, got ${OCCUPANCY_RUN_FLOOR}`);
});

// ── real-frame calibration (skipped when .data absent) ───────────────────────
const DF = path.join(process.cwd(), ".data", "dogfood");
const framePath = (dir: string, s: number): string => path.join(DF, dir, "frames", `scene${s}.png`);
if (existsSync(framePath("cycle6-robinhood", 0))) {
  await check("CALIBRATION: Robinhood s0 void FIRES (≥0.23) and s1 PASSES (<0.23)", async () => {
    const s0 = await assessEmptyColumnRun(framePath("cycle6-robinhood", 0), { colInkFloor: COLUMN_INK_FLOOR });
    const s1 = await assessEmptyColumnRun(framePath("cycle6-robinhood", 1), { colInkFloor: COLUMN_INK_FLOOR });
    assert(s0.runFracW >= OCCUPANCY_RUN_FLOOR, `s0 ${(s0.runFracW * 100).toFixed(1)}% ≥ 23%`);
    assert(s1.runFracW < OCCUPANCY_RUN_FLOOR, `s1 ${(s1.runFracW * 100).toFixed(1)}% < 23%`);
  });
  if (existsSync(framePath("cycle1-liquiddeath", 2))) {
    await check("CALIBRATION: the LiquidDeath-s2 22.7% false positive stays BELOW the corrected 0.23 floor", async () => {
      const s2 = await assessEmptyColumnRun(framePath("cycle1-liquiddeath", 2), { colInkFloor: COLUMN_INK_FLOOR });
      assert(s2.runFracW < OCCUPANCY_RUN_FLOOR, `LD s2 ${(s2.runFracW * 100).toFixed(1)}% < 23% (the 0.22→0.23 bump)`);
    });
  }
  if (existsSync(framePath("cycle4-oatly", 2))) {
    await check("CALIBRATION: Oatly s2 (postage-stamp carton) FIRES (≥0.23)", async () => {
      const s2 = await assessEmptyColumnRun(framePath("cycle4-oatly", 2), { colInkFloor: COLUMN_INK_FLOOR });
      assert(s2.runFracW >= OCCUPANCY_RUN_FLOOR, `Oatly s2 ${(s2.runFracW * 100).toFixed(1)}% ≥ 23%`);
    });
  }
} else {
  console.log("  … real-frame calibration skipped (.data/dogfood absent)");
}

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
