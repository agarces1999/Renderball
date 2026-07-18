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

// R4 (audit-2) dropped the inert `severe` flag; these calibration tests still
// verify a WIDE marooned-island void is DETECTED + advisory on a soft register.
const WIDE_VOID_FRAC = 0.32;
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

await check("a REALISTIC (sub-severe) void on a SPLIT scene ADVISES (never blocks) — honors 's2 must pass'", async () => {
  // A realistic weighted-column split void (~30% — the Robinhood s2 28.5% class,
  // BELOW the 0.32 severe floor) advises. A SEVERE void (≥0.32) blocks on any
  // register (tested below) — a legit split column is never 60% empty. Short
  // block (low column-ink) so the white canvas stays the dominant background.
  const p = await writeFrame("leftonly2", [{ x: 0, y: 150, w: 224, h: 100 }]); // painted left 70%, right 30% void
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

await check("full-bleed is exempt from the COLUMN void arm (a left/right void is the barbell's; P3-C6: the ROW arm runs on full-bleed edge bands, see below)", async () => {
  // leftonly3 is a COLUMN void (left 40% inked, right 60% empty) — every ROW
  // carries ink, so the row arm finds no empty run and full-bleed stays clean.
  const p = await writeFrame("leftonly3", [{ x: 0, y: 0, w: 128, h: H }]);
  const r = await assessOccupancy([sceneAt(0, p, [])], ["full-bleed"]);
  assert(r.findings.length === 0, `full-bleed column void exempt, got ${JSON.stringify(r.findings)}`);
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

// cycle-10 P3: the light/minimal "orphaned empty card" — a SOLID card-sized panel
// with no interior content that the under-furnished arm used to skip.
await check("ORPHANED-CARD (P3): a SOLID card-sized panel with NO children advises orphaned=true", async () => {
  const card = el({ piece: "s2.copy", pieceKind: "text", bg: "rgb(255,255,255)", x: 900, y: 400, w: 320, h: 240 });
  const m: SceneMeasurement = { scene: 2, width: 1920, height: 1080, elements: [card], screenshotPath: undefined };
  const r = await assessOccupancy([m], ["split"]);
  assert(r.cardAdvisories.length === 1, `one advisory for the empty card, got ${JSON.stringify(r.cardAdvisories)}`);
  assert(r.cardAdvisories[0].orphaned === true, "flagged orphaned");
  assert(r.cardAdvisories[0].blocking === false, "orphaned advisory never blocks");
  assert(r.cardAdvisories[0].coverage === 0, `empty → 0 coverage, got ${r.cardAdvisories[0].coverage}`);
});

await check("ORPHANED-CARD (P3): a GRADIENT-only empty slab is NOT flagged (ambient territory)", async () => {
  const blob = el({ piece: "s2.atmosphere", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", hasBgImage: true, x: 900, y: 400, w: 320, h: 240 });
  const m: SceneMeasurement = { scene: 2, width: 1920, height: 1080, elements: [blob], screenshotPath: undefined };
  const r = await assessOccupancy([m], ["split"]);
  assert(r.cardAdvisories.length === 0, `gradient-only empty slab skipped, got ${JSON.stringify(r.cardAdvisories)}`);
});

await check("ORPHANED-CARD (P3): a merely under-furnished card stays orphaned=false", async () => {
  const card = el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(30,30,40)", x: 100, y: 100, w: 300, h: 300 });
  const kid = el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(200,200,200)", x: 110, y: 110, w: 60, h: 40, parentIx: 0 });
  const m: SceneMeasurement = { scene: 3, width: 1920, height: 1080, elements: [card, kid], screenshotPath: undefined };
  const r = await assessOccupancy([m], ["split"]);
  assert(r.cardAdvisories.length === 1 && r.cardAdvisories[0].orphaned === false, `under-furnished (2.7%) not orphaned, got ${JSON.stringify(r.cardAdvisories)}`);
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

// ── P3-C5: the HORIZONTAL-void arm on the real Vanta frames ───────────────────
if (existsSync(framePath("p3-cycle4-vanta", 3))) {
  await check("P3-C5 CALIBRATION: Vanta s3 (list) yields a ROW-axis bottom void via assessOccupancy", async () => {
    const m: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle4-vanta", 3) };
    const r = await assessOccupancy([m], ["list"]);
    const row = r.findings.filter((f) => f.axis === "row");
    assert(row.length === 1, `one row-void on s3, got ${JSON.stringify(r.findings.map((f) => ({ axis: f.axis, region: f.region, run: (f.runFracW * 100).toFixed(0) })))}`);
    assert(row[0].region === "bottom", `bottom band, got ${row[0].region}`);
    assert(row[0].blocking === false, `list advises (furnish converges), got blocking=${row[0].blocking}`);
    assert(!!row[0].rowBand && row[0].rowBand.endFracH > 0.94, `bottom-anchored rowBand, got ${JSON.stringify(row[0].rowBand)}`);
  });
  await check("P3-C5 CALIBRATION: Vanta s0 (quote) + s1 (split) yield NO row void (no FP)", async () => {
    const m0: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle4-vanta", 0) };
    const m1: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle4-vanta", 1) };
    const r0 = await assessOccupancy([m0], ["quote"]);
    const r1 = await assessOccupancy([m1], ["split"]);
    assert(r0.findings.filter((f) => f.axis === "row").length === 0, `s0 no row void, got ${JSON.stringify(r0.findings.map((f) => f.axis))}`);
    assert(r1.findings.filter((f) => f.axis === "row").length === 0, `s1 no row void, got ${JSON.stringify(r1.findings.map((f) => f.axis))}`);
  });
} else {
  console.log("  … Vanta row-void calibration skipped (.data/dogfood/p3-cycle4-vanta absent)");
}

// ── P3-C6 #2: the ROW arm now runs on FULL-BLEED edge bands (Scale AI s2 upper
// void). Full-bleed stays exempt from the COLUMN arm (barbell owns those).
// Calibrated on the real full-bleed s2 frames: Scale s2 (0.237 top, start 0.107)
// FIRES top; Deel s2 (0.289 bottom) FIRES bottom; Faire s2 (0.111 filled) +
// Vanta s2 (0.033 filled) PASS. Advisory (furnish converges; no regen).
if (existsSync(framePath("p3-cycle5-scaleai", 2))) {
  await check("P3-C6 #2 CALIBRATION: Scale AI s2 (full-bleed) yields a TOP row-void (advisory) — the upper-band void", async () => {
    const m: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle5-scaleai", 2) };
    const r = await assessOccupancy([m], ["full-bleed"]);
    const row = r.findings.filter((f) => f.axis === "row");
    assert(row.length === 1, `one full-bleed row-void, got ${JSON.stringify(r.findings.map((f) => ({ axis: f.axis, region: f.region, run: (f.runFracW * 100).toFixed(0) })))}`);
    assert(row[0].region === "top", `top band, got ${row[0].region}`);
    assert(row[0].blocking === false, `full-bleed advises (furnish converges), got blocking=${row[0].blocking}`);
    // The column arm stays exempt for full-bleed (barbell owns those).
    assert(r.findings.filter((f) => f.axis === "column").length === 0, "no column void on full-bleed (column arm stays exempt)");
  });
  if (existsSync(framePath("p3-cycle2-deel", 2))) {
    await check("P3-C6 #2 CALIBRATION: Deel s2 (full-bleed, catastrophic bottom void) FIRES a bottom row-void", async () => {
      const m: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle2-deel", 2) };
      const r = await assessOccupancy([m], ["full-bleed"]);
      const row = r.findings.filter((f) => f.axis === "row");
      assert(row.length === 1 && row[0].region === "bottom", `bottom row-void, got ${JSON.stringify(r.findings.map((f) => ({ axis: f.axis, region: f.region })))}`);
    });
  }
  if (existsSync(framePath("p3-cycle3-faire", 2)) && existsSync(framePath("p3-cycle4-vanta", 2))) {
    await check("P3-C6 #2 CALIBRATION: Faire s2 + Vanta s2 (filled full-bleed) yield NO row void (no FP)", async () => {
      const mf: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle3-faire", 2) };
      const mv: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: framePath("p3-cycle4-vanta", 2) };
      const rf = await assessOccupancy([mf], ["full-bleed"]);
      const rv = await assessOccupancy([mv], ["full-bleed"]);
      assert(rf.findings.length === 0, `Faire s2 filled → no void, got ${JSON.stringify(rf.findings.map((f) => f.axis))}`);
      assert(rv.findings.length === 0, `Vanta s2 filled → no void, got ${JSON.stringify(rv.findings.map((f) => f.axis))}`);
    });
  }
} else {
  console.log("  … Scale AI full-bleed row-void calibration skipped (.data/dogfood/p3-cycle5-scaleai absent)");
}

// ── Audit-1 High #3: SEVERE void is FLAGGED-severe (furnished), NOT a blocking
// regen on an advisory register. A void band ≥ OCCUPANCY_SEVERE_VOID_FLOOR is a
// small card marooned in a large void; before, the severe floor OVERRODE the
// register into a blocking regen that never converged (the audit's central
// finding). Now the register decides `blocking` (quote/centered block;
// split/stat/list advise) and the `severe` flag routes the deterministic
// post-loop FURNISH — a severe void on a `list` scene converges via furnish, not
// a thrashing regen. Synthetic frame: a wide void band, no anchor.
{
  // A frame that is empty except a small painted card near the left — the widest
  // empty run (the right ~65% of the frame) is a severe void.
  const cardW = Math.round(0.28 * W);
  const severePath = await writeFrame("severe-void", [{ x: 8, y: 150, w: cardW, h: 100 }]);
  await check("WIDE void (≥0.32) on a `list` register is DETECTED + advisory (furnish converges it, not regen)", async () => {
    const m = sceneAt(0, severePath, []); // registers[0] = "list"
    const r = await assessOccupancy([m], ["list"]);
    const voids = r.findings.filter((f) => f.kind === "occupancy-void");
    assert(voids.length === 1, `one void, got ${JSON.stringify(r.findings)}`);
    assert(voids[0].runFracW >= WIDE_VOID_FRAC, `wide band ${(voids[0].runFracW * 100).toFixed(0)}% ≥ ${WIDE_VOID_FRAC * 100}%`);
    assert(voids[0].blocking === false, `list-register wide void must NOT force a blocking regen (furnish owns it), got blocking=${voids[0].blocking}`);
  });
  await check("WIDE void on a `quote` register STILL blocks (its register blocks)", async () => {
    const m = sceneAt(0, severePath, []);
    const r = await assessOccupancy([m], ["quote"]);
    const voids = r.findings.filter((f) => f.kind === "occupancy-void");
    assert(voids.length === 1 && voids[0].blocking === true, `quote wide void blocks, got ${JSON.stringify(voids)}`);
  });
}

// Real-frame calibration: Fuse s3 (list) severe void is FLAGGED severe (furnished
// downstream), NOT blocking on the list register; Fuse s2 (stat) stays clean.
const fuseFrame = (s: number): string => path.join(DF, "fullpipe-fuse", "frames", `scene${s}.png`);
if (existsSync(fuseFrame(3))) {
  await check("CALIBRATION: Fuse s3 (list) wide void is detected+advisory (furnished), s2 (stat) clean", async () => {
    // The real Fuse per-scene registers, indexed by scene number.
    const fuseRegisters = ["full-bleed", "list", "stat", "list", "centered"];
    const s3: SceneMeasurement = { scene: 3, width: 1920, height: 1080, elements: [], screenshotPath: fuseFrame(3) };
    const s2: SceneMeasurement = { scene: 2, width: 1920, height: 1080, elements: [], screenshotPath: fuseFrame(2) };
    const r3 = await assessOccupancy([s3], fuseRegisters);
    const r2 = await assessOccupancy([s2], fuseRegisters);
    // The original calibration target: the COLUMN wide void (a right-edge void on
    // the marooned card). The P3-C5 row arm may additionally flag a bottom band on
    // the same frame — both detected + advisory (furnish converges, no regen).
    const v3col = r3.findings.filter((f) => f.kind === "occupancy-void" && f.runFracW >= WIDE_VOID_FRAC && f.axis === "column");
    assert(v3col.length === 1 && v3col[0].scene === 3, `Fuse s3 must produce a WIDE column void, got ${JSON.stringify(r3.findings.map((f) => ({ axis: f.axis, run: f.runFracW })))}`);
    assert(r3.findings.every((f) => f.blocking === false), `every Fuse s3 (list) void advises (furnish converges, no regen), got ${JSON.stringify(r3.findings.map((f) => ({ axis: f.axis, blocking: f.blocking })))}`);
    assert(!r2.findings.some((f) => f.blocking), `Fuse s2 must NOT block, got ${JSON.stringify(r2.findings)}`);
  });
} else {
  console.log("  … Fuse severe-void calibration skipped (.data/dogfood/fullpipe-fuse absent)");
}

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
