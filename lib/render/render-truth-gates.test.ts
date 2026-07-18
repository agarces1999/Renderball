/**
 * Tests for the render-truth gates. findOverflow is pure (operates on measured
 * rects) so it's fully unit-testable without a browser. findRenderTruthFailures
 * is exercised for its blocking-subset logic with screenshot-less measurements
 * (the screenshot-only gates no-op without a screenshot — overflow is the blocker).
 */
import { promises as fs, existsSync } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  findOverflow,
  findCrossPieceOverlap,
  findEmptyBand,
  findEdgeCroppedPieces,
  findRenderTruthFailures,
  planEdgeCropMoves,
  hexLuminance,
  assessCanvasBrightness,
  assessCanvasCoherence,
  findCanvasCoherence,
  findCornerMarkCollision,
  findHollowCta,
  findStrayFullBleedCard,
  findIntraPieceOverlap,
  findGhostFragment,
  CANVAS_COHERENCE_RGB_DELTA,
  findStrayFragments,
  exciseStrayFragment,
  findMotifClutter,
  exciseMotifClutter,
  blankPieceInner,
  stripClutterElements,
  stripDecorationSvgIcons,
  isMotifGlyphText,
  STRAY_ISOLATION_MIN_PX,
  EDGE_CROP_FRAC,
  EDGE_CLAMP_OVERSIZE_FRAC,
  type EdgeCropFinding,
  type SlotTerritory,
} from "./render-truth-gates";
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
  tag: "div", x: 0, y: 0, w: 100, h: 100, color: "rgb(255,255,255)",
  bg: "rgba(0,0,0,0)", text: "", isImg: false, src: undefined, fontSize: 0,
  opacity: 1, piece: "", onOpaqueSurface: false, coveredAtCenter: false, ...p,
});
const scene = (i: number, els: MeasuredElement[]): SceneMeasurement => ({
  scene: i, width: 1920, height: 1080, elements: els, screenshotPath: undefined,
});

console.log("render-truth-gates");

await check("flags text whose box crosses the right edge (the Fuse clip)", () => {
  const m = scene(2, [el({ tag: "p", text: "Without becoming one...", x: 960, y: 293, w: 1112, h: 81 })]);
  const r = findOverflow(m);
  assert(r.length === 1 && r[0].kind === "overflow" && /right/.test(r[0].detail), `got ${JSON.stringify(r)}`);
});

await check("flags a flow div crossing BOTH left and right edges", () => {
  const m = scene(2, [el({ tag: "div", text: "Apply -> Decision", x: -29, y: 828, w: 1978, h: 20 })]);
  const r = findOverflow(m);
  assert(r.length === 1 && /left\+right/.test(r[0].detail), `got ${JSON.stringify(r)}`);
});

await check("flags an overflowing logo image", () => {
  const m = scene(0, [el({ tag: "img", isImg: true, src: "x/logo.png", x: 1850, y: 40, w: 200, h: 60 })]);
  const r = findOverflow(m);
  assert(r.length === 1 && r[0].kind === "overflow", `got ${JSON.stringify(r)}`);
});

await check("does NOT flag a full-bleed background (no text, not img)", () => {
  const m = scene(0, [
    el({ tag: "div", text: "", x: 0, y: 0, w: 1920, h: 1080 }),
    el({ tag: "div", text: "", x: -40, y: -40, w: 2000, h: 1160 }),
  ]);
  assert(findOverflow(m).length === 0, "full-bleed bg should not flag");
});

await check("does NOT flag content comfortably inside the canvas", () => {
  const m = scene(0, [el({ tag: "h1", text: "Headline", x: 120, y: 120, w: 1000, h: 140 })]);
  assert(findOverflow(m).length === 0, "in-bounds content flagged");
});

await check("ignores invisible (opacity 0) overflow", () => {
  const m = scene(0, [el({ tag: "p", text: "hidden", x: 960, y: 100, w: 1200, h: 40, opacity: 0 })]);
  assert(findOverflow(m).length === 0, "opacity:0 should not flag");
});

await check("a measure error surfaces as a measure-error finding", () => {
  const m: SceneMeasurement = { scene: 1, width: 1920, height: 1080, elements: [], error: "boom" };
  const r = findOverflow(m);
  assert(r.length === 1 && r[0].kind === "measure-error", `got ${JSON.stringify(r)}`);
});

await check("blocking subset = overflow + measure-error (contrast/dead-region advisory)", async () => {
  const ms = [
    scene(0, [el({ tag: "h1", text: "ok", x: 100, y: 100, w: 800, h: 120 })]),
    scene(1, [el({ tag: "p", text: "clipped lede here", x: 960, y: 286, w: 1180, h: 38 })]),
  ];
  const { findings, blocking } = await findRenderTruthFailures(ms);
  assert(blocking.length === 1 && blocking[0].scene === 1 && blocking[0].kind === "overflow", `blocking=${JSON.stringify(blocking)}`);
  assert(findings.length >= 1, "should have at least the overflow finding");
});

// Audit-1 Medium #5: findTextOverlap DELETED (superseded by intra/cross-piece
// overlap gates) — its tests were removed with it.

// ── canvas-brightness gate (light brand shipped dark) ────────────────────────
await check("hexLuminance: white ≈ 1, black = 0, off-white > 0.6, near-black < 0.1", () => {
  assert((hexLuminance("#ffffff") ?? 0) > 0.99, "white");
  assert(hexLuminance("#000000") === 0, "black");
  assert((hexLuminance("#faf7f7") ?? 0) > 0.6, "off-white is a light brand");
  assert((hexLuminance("#0e0e12") ?? 1) < 0.1, "near-black canvas");
  assert(hexLuminance("not-a-hex") === null, "garbage → null");
});

await check("assessCanvasBrightness: light brand + ≤1 dark scene → no finding", () => {
  const f = assessCanvasBrightness("#ffffff", [
    { scene: 0, lum: 0.9 }, { scene: 1, lum: 0.9 }, { scene: 2, lum: 0.05 },
  ]);
  assert(f.length === 0, `one dark contrast scene is allowed: ${JSON.stringify(f)}`);
});

await check("assessCanvasBrightness: light brand + >1 dark scene → flags each dark", () => {
  const f = assessCanvasBrightness("#faf7f7", [
    { scene: 0, lum: 0.04 }, { scene: 1, lum: 0.05 }, { scene: 2, lum: 0.92 },
  ]);
  assert(f.length === 2 && f.every((x) => x.kind === "canvas-brightness"), `got ${JSON.stringify(f)}`);
  assert(f.map((x) => x.scene).sort().join(",") === "0,1", "flags the dark scenes");
});

await check("assessCanvasBrightness: DARK brand on a dark canvas → never flags", () => {
  const f = assessCanvasBrightness("#0e0e12", [
    { scene: 0, lum: 0.03 }, { scene: 1, lum: 0.04 }, { scene: 2, lum: 0.03 },
  ]);
  assert(f.length === 0, `dark brand keeps its dark canvas: ${JSON.stringify(f)}`);
});

await check("assessCanvasBrightness: no brand bg / null scene lums handled", () => {
  assert(assessCanvasBrightness(undefined, [{ scene: 0, lum: 0.05 }]).length === 0, "no bg → no check");
  // nulls (no screenshot) are ignored; 2 real dark scenes still flag
  const f = assessCanvasBrightness("#ffffff", [
    { scene: 0, lum: null }, { scene: 1, lum: 0.05 }, { scene: 2, lum: 0.04 },
  ]);
  assert(f.length === 2, `nulls ignored, 2 dark flagged: ${JSON.stringify(f)}`);
});

// ── findCrossPieceOverlap (title colliding with a diegetic mock) ─────────────
// Reproduces the Framer defect: a transparent-backed headline from the copy
// piece clipped by the editor-mock panel from a different piece.
const HEADLINE = { tag: "h1", text: "Every pixel, exactly where you want it", fontSize: 76, x: 90, y: 106, w: 900, h: 60, piece: "s2.copy", coveredAtCenter: true };
const MOCK_PANEL = { tag: "div", bg: "rgb(18,18,20)", x: 90, y: 150, w: 1740, h: 630, piece: "s2.editor" };

await check("flags a headline clipped by a foreign mock panel (the Framer defect)", () => {
  const m = scene(2, [el(HEADLINE), el(MOCK_PANEL)]);
  const r = findCrossPieceOverlap(m);
  assert(r.length === 1 && r[0].kind === "cross-piece-overlap" && /s2\.editor/.test(r[0].detail), JSON.stringify(r));
});

await check("does NOT flag text on its OWN opaque surface (Arc-style overlay card)", () => {
  const m = scene(0, [el({ ...HEADLINE, piece: "s0.copy", onOpaqueSurface: true }), el({ ...MOCK_PANEL, piece: "s0.browser" })]);
  assert(findCrossPieceOverlap(m).length === 0, "intentional overlay card must not flag");
});

await check("does NOT flag same-piece overlap (labels inside their own mock)", () => {
  const m = scene(1, [el({ ...HEADLINE, piece: "s1.editor", fontSize: 28 }), el({ ...MOCK_PANEL, piece: "s1.editor" })]);
  assert(findCrossPieceOverlap(m).length === 0, "same-piece is by design");
});

await check("does NOT flag overlap with a transparent atmosphere layer", () => {
  const m = scene(1, [el(HEADLINE), el({ ...MOCK_PANEL, piece: "s2.atmos", bg: "rgba(0,0,0,0)" })]);
  assert(findCrossPieceOverlap(m).length === 0, "transparent layers are not panels");
});

await check("does NOT flag tiny (<20%) grazing intersections", () => {
  const m = scene(1, [el({ ...HEADLINE, y: 100, h: 60 }), el({ ...MOCK_PANEL, y: 155 })]);
  // intersection = 5px of a 60px-tall text box ≈ 8%
  assert(findCrossPieceOverlap(m).length === 0, "grazing contact must not flag");
});

await check("text ON TOP but FULLY inside a foreign panel does not flag (sanctioned overlay)", () => {
  // The Loom-s0 pattern: a headline composed entirely over a dimmed mock. Fully
  // contained (>92%) + visibly on top = deliberate overlay, never a collision.
  const m = scene(1, [
    el({ ...HEADLINE, coveredAtCenter: false, y: 300, h: 60 }), // panel spans 150..780 → fully inside
    el(MOCK_PANEL),
  ]);
  assert(findCrossPieceOverlap(m).length === 0, "contained overlay must not flag");
});

await check("text ON TOP that STRADDLES a foreign panel edge DOES flag (the Fuse-s3 class)", () => {
  // 27% of the headline crosses into the panel while the rest sits on the
  // canvas — a contrast-breaking collision at any stacking order.
  const m = scene(1, [el({ ...HEADLINE, coveredAtCenter: false }), el(MOCK_PANEL)]);
  const r = findCrossPieceOverlap(m);
  assert(r.length === 1 && /STRADDLES/.test(r[0].detail), JSON.stringify(r));
});

await check("body text printed across another piece's label DOES flag (cross-piece text-on-text)", () => {
  const bullet = { tag: "li", text: "AI Agents: document reading, fraud checks", fontSize: 18, x: 460, y: 230, w: 480, h: 24, piece: "s3.copy", coveredAtCenter: false };
  const label = { tag: "span", text: "AI AGENTS", fontSize: 12, x: 500, y: 236, w: 90, h: 16, piece: "s3.panel2", bg: "rgba(0,0,0,0)", onOpaqueSurface: true };
  const m = scene(3, [el(bullet), el(label)]);
  const r = findCrossPieceOverlap(m);
  assert(r.length === 1 && /printed across/.test(r[0].detail), JSON.stringify(r));
});

await check("display-size text over a mock's tiny labels stays exempt (Loom overlay)", () => {
  const label = { tag: "span", text: "Sprint Planning", fontSize: 12, x: 200, y: 320, w: 120, h: 16, piece: "s0.mock", onOpaqueSurface: true };
  const m = scene(0, [
    el({ ...HEADLINE, coveredAtCenter: false, fontSize: 96, y: 300, h: 90 }), // display class, fully over the mock area
    el({ ...MOCK_PANEL, piece: "s0.mock" }),
    el(label),
  ]);
  assert(findCrossPieceOverlap(m).length === 0, JSON.stringify(findCrossPieceOverlap(m)));
});

await check("24px lede over a dimmed mock label stays exempt (annotation rule is both-sides ≤20px)", () => {
  // Loom-s0 replay FP class: body lede composed over the dimmed calendar's
  // small labels — sanctioned. Only annotation-vs-annotation collides.
  const label = { tag: "span", text: "Budget Sync", fontSize: 15, x: 300, y: 306, w: 110, h: 18, piece: "s0.atmos", onOpaqueSurface: true };
  const lede = { tag: "p", text: "Back-to-back syncs, status updates, and quick calls", fontSize: 24, x: 260, y: 300, w: 700, h: 30, piece: "s0.copy", coveredAtCenter: false };
  const m = scene(0, [el(lede), el(label)]);
  assert(findCrossPieceOverlap(m).length === 0, JSON.stringify(findCrossPieceOverlap(m)));
});

await check("does NOT flag full-bleed backgrounds as panels", () => {
  const m = scene(1, [el(HEADLINE), el({ ...MOCK_PANEL, x: 0, y: 0, w: 1920, h: 1080, piece: "s2.frame" })]);
  assert(findCrossPieceOverlap(m).length === 0, "the canvas itself is not a panel");
});

// ── Case D (v12): copy WOVEN through a foreign mock's rows (Linear s1) ──────

await check("Case D: 28px lede woven through TWO mock rows DOES flag (the Linear interleave, above the old 20px band)", () => {
  const lede = { tag: "p", text: "One issue. One focus. The noise is gone", fontSize: 28, x: 480, y: 750, w: 460, h: 60, piece: "s1.copy", coveredAtCenter: false };
  const row1 = { tag: "span", text: "Alex Diaz set status to In Progress", fontSize: 14, x: 560, y: 752, w: 300, h: 18, piece: "s1.hero", onOpaqueSurface: true };
  const row2 = { tag: "span", text: "Jordan Ngo changed priority", fontSize: 14, x: 560, y: 786, w: 280, h: 18, piece: "s1.hero", onOpaqueSurface: true };
  const m = scene(1, [el(lede), el(row1), el(row2)]);
  const r = findCrossPieceOverlap(m);
  assert(r.length === 1 && /printed across 2 text node/.test(r[0].detail), JSON.stringify(r));
  assert(/s1\.hero/.test(r[0].detail) && /s1\.copy/.test(r[0].detail), `both pieces named for dual routing: ${r[0].detail}`);
});

await check("Case D: 28px lede grazing ONE label stays exempt (the Loom-overlay sanction holds above 20px)", () => {
  const lede = { tag: "p", text: "Back-to-back syncs and quick calls", fontSize: 28, x: 260, y: 300, w: 700, h: 34, piece: "s0.copy", coveredAtCenter: false };
  const label = { tag: "span", text: "Budget Sync", fontSize: 15, x: 300, y: 306, w: 110, h: 18, piece: "s0.mock", onOpaqueSurface: true };
  const m = scene(0, [el(lede), el(label)]);
  assert(findCrossPieceOverlap(m).length === 0, JSON.stringify(findCrossPieceOverlap(m)));
});

await check("Case D: 16px copy over one 24px row still flags (annotation band, label side widened past 20px)", () => {
  const copy = { tag: "p", text: "The noise is gone — and the work that", fontSize: 16, x: 480, y: 760, w: 440, h: 22, piece: "s1.copy", coveredAtCenter: false };
  const row = { tag: "div", text: "Faster app launch", fontSize: 24, x: 520, y: 756, w: 260, h: 30, piece: "s1.hero", onOpaqueSurface: true };
  const m = scene(1, [el(copy), el(row)]);
  const r = findCrossPieceOverlap(m);
  assert(r.length === 1 && /printed across/.test(r[0].detail), JSON.stringify(r));
});

await check("Case D: 40px display copy woven through rows stays A/B territory (no text-on-text fire)", () => {
  const display = { tag: "h1", text: "Switch to Linear today", fontSize: 40, x: 480, y: 740, w: 700, h: 90, piece: "s4.copy", coveredAtCenter: false };
  const row1 = { tag: "span", text: "Faster app launch", fontSize: 14, x: 560, y: 752, w: 220, h: 18, piece: "s4.hero", onOpaqueSurface: true };
  const row2 = { tag: "span", text: "Performance P1", fontSize: 14, x: 560, y: 790, w: 200, h: 18, piece: "s4.hero", onOpaqueSurface: true };
  const m = scene(4, [el(display), el(row1), el(row2)]);
  assert(findCrossPieceOverlap(m).length === 0, JSON.stringify(findCrossPieceOverlap(m)));
});

// ── findEmptyBand (barbell) — needs a real settled-frame screenshot ─────────
// Full 1920×1080 dark canvas with bright content strips at given y-bands.
const frameWithBands = async (bands: [number, number][]): Promise<string> => {
  const W = 1920, H = 1080;
  const blocks = await Promise.all(
    bands.map(async ([top, h]) =>
      sharp({ create: { width: W, height: h, channels: 3, background: { r: 235, g: 235, b: 240 } } }).png().toBuffer().then((input) => ({ input, top })),
    ),
  );
  const buf = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 12, g: 12, b: 18 } } })
    .composite(blocks.map((b) => ({ input: b.input, left: 0, top: b.top })))
    .png()
    .toBuffer();
  const p = path.join(os.tmpdir(), `rb-band-${Math.abs(bands[0][0])}-${bands.length}-${bands[0][1]}.png`);
  await fs.writeFile(p, buf);
  return p;
};

await check("findEmptyBand flags a barbell (top+bottom clusters, empty middle)", async () => {
  // clusters at y 120..300 and y 900..1000 → empty middle ~600px (56% of 1080)
  const shot = await frameWithBands([[120, 180], [900, 100]]);
  const m: SceneMeasurement = { scene: 3, width: 1920, height: 1080, elements: [], screenshotPath: shot };
  const r = await findEmptyBand(m);
  await fs.unlink(shot).catch(() => {});
  assert(r.length === 1 && r[0].kind === "barbell" && /empty horizontal band/.test(r[0].detail), `got ${JSON.stringify(r)}`);
});

await check("findEmptyBand passes a frame whose interior is filled top-to-bottom", async () => {
  // content strips distributed across the interior (dark canvas stays the majority,
  // so it's the dominant background) — gaps ≤120px, no band near the 30% gate.
  const shot = await frameWithBands([[120, 120], [360, 120], [600, 120], [840, 90]]);
  const m: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: shot };
  const r = await findEmptyBand(m);
  await fs.unlink(shot).catch(() => {});
  assert(r.length === 0, `filled interior must not flag, got ${JSON.stringify(r)}`);
});

await check("findEmptyBand no-ops without a screenshot (rects-only measurement)", async () => {
  const r = await findEmptyBand(scene(1, [el({ text: "hi", y: 40 })]));
  assert(r.length === 0, "no screenshotPath ⇒ no barbell finding");
});

await check("barbell joins the blocking subset when requested", async () => {
  const shot = await frameWithBands([[120, 180], [900, 100]]);
  const ms: SceneMeasurement[] = [{ scene: 0, width: 1920, height: 1080, elements: [], screenshotPath: shot }];
  const { blocking } = await findRenderTruthFailures(ms, { blockingKinds: ["overflow", "measure-error", "barbell"] });
  await fs.unlink(shot).catch(() => {});
  assert(blocking.some((f) => f.kind === "barbell"), `barbell should block: ${JSON.stringify(blocking)}`);
});

// ── piece-edge crop (v10 — dogfood cycle-1 bottom-cropped mocks) ────────────

await check("edge-crop: a piece union running past the canvas bottom by >2% of its height FIRES, named + blocking", () => {
  // Cycle-1 shape: a bottom hero band whose content renders taller than its
  // slot — union 560,700 → 1180 (100px past the 1080 bottom = 26% of h=480).
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", x: 560, y: 700, w: 800, h: 380 }),
    el({ piece: "s0.hero", pieceKind: "diegetic", x: 600, y: 900, w: 400, h: 280 }),
  ]);
  const r = findEdgeCroppedPieces(m);
  assert(r.length === 1, `one finding, got ${r.length}: ${JSON.stringify(r)}`);
  const f = r[0];
  assert(f.kind === "piece-edge-crop" && f.blocking === true, "kind + blocking");
  assert(f.pieceId === "s0.hero" && f.edge === "bottom" && f.overflowPx === 100, `names piece/edge/overflow: ${JSON.stringify(f)}`);
  assert(f.detail.includes("s0.hero") && /bottom/.test(f.detail), `humanized detail: ${f.detail}`);
  assert(f.repairInstruction.length > 60, "actionable repair instruction");
});

await check("edge-crop: right-edge clip fires; within-tolerance clip does not", () => {
  const right = scene(1, [el({ piece: "s1.hero", pieceKind: "diegetic", x: 1600, y: 300, w: 400, h: 300 })]);
  const rf = findEdgeCroppedPieces(right);
  assert(rf.length === 1 && rf[0].edge === "right" && rf[0].overflowPx === 80, `right clip fires: ${JSON.stringify(rf)}`);
  // 2% of h=500 = 10px tolerance; 8px past the bottom stays under it.
  const ok = scene(2, [el({ piece: "s2.hero", pieceKind: "diegetic", x: 100, y: 588, w: 600, h: 500 })]);
  assert(findEdgeCroppedPieces(ok).length === 0, "sub-tolerance clip must not fire");
  assert(EDGE_CROP_FRAC === 0.02, "the tolerance is the documented 2%");
});

await check("edge-crop: atmosphere/chrome and full-canvas treatments are exempt; measure-error scenes skip", () => {
  const m = scene(3, [
    el({ piece: "s3.atmosphere", pieceKind: "atmosphere", x: 0, y: 0, w: 1920, h: 1200 }),
    el({ piece: "s3.chrome", pieceKind: "chrome", x: 0, y: 1008, w: 1920, h: 90 }),
    // full-bleed hero: ≥85% of canvas area = a canvas treatment, owns the edge
    el({ piece: "s3.hero", pieceKind: "diegetic", x: 0, y: 0, w: 1920, h: 1120 }),
  ]);
  assert(findEdgeCroppedPieces(m).length === 0, "exempt kinds + canvas treatments never fire");
  const err = { ...scene(4, [el({ piece: "s4.hero", pieceKind: "diegetic", x: 0, y: 900, w: 500, h: 400 })]), error: "boom" };
  assert(findEdgeCroppedPieces(err).length === 0, "measure-error scenes skip (fail-closed elsewhere)");
});

// ─── clamp-vs-slot planner (v11 #3 — the cycle-2 s2.hero clamp ricochet) ─────

const cropFinding = (p: Partial<EdgeCropFinding>): EdgeCropFinding => ({
  kind: "piece-edge-crop", scene: 2, pieceId: "s2.hero", blocking: true, edge: "right",
  overflowPx: 100, union: { x: 1100, y: 200, w: 800, h: 500 }, detail: "d", repairInstruction: "r", ...p,
});
const slot = (p: Partial<SlotTerritory>): SlotTerritory => ({
  pieceId: "s2.hero", scene: 2, kind: "diegetic", bounds: { x: 1092, y: 200, w: 768, h: 560 }, ...p,
});
const CANVAS_DIMS = { w: 1920, h: 1080 };

await check("planEdgeCropMoves: OVERSIZED piece (cycle-2 shape — ~1266px in a 768px slot) routes regen, never clamps", () => {
  const f = cropFinding({ overflowPx: 438, union: { x: 1092, y: 200, w: 1266, h: 500 } });
  const plan = planEdgeCropMoves([f], [slot({})], CANVAS_DIMS, 12);
  assert(plan.moves.length === 0, "no clamp for a mis-sized piece");
  assert(plan.regens.length === 1 && plan.regens[0].reason === "oversized-for-slot", `regen routed: ${JSON.stringify(plan.regens)}`);
  assert(/1266px wide in a 768px slot/.test(plan.regens[0].detail), "detail names the measured vs slot widths");
  assert(/~1266px wide/.test(plan.regens[0].repairInstruction) && /768px/.test(plan.regens[0].repairInstruction), "instruction carries both sizes");
  assert(/never exceed it/i.test(plan.regens[0].repairInstruction), "instruction demands fill-the-wrapper");
  assert(1266 > 768 * EDGE_CLAMP_OVERSIZE_FRAC, "fixture is genuinely over the 25% oversize line");
});

await check("planEdgeCropMoves: clamp landing on a NEIGHBOR's territory routes regen instead", () => {
  // Piece fits its slot (echoes cycle 2: the s2.hero clamp shoved it into the
  // copy column) but the move crosses onto the copy slot.
  const f = cropFinding({ overflowPx: 438, union: { x: 1220, y: 240, w: 700, h: 480 } });
  const slots = [
    slot({ bounds: { x: 1152, y: 200, w: 768, h: 560 } }),
    slot({ pieceId: "s2.copy", kind: "text", bounds: { x: 120, y: 240, w: 720, h: 560 } }),
  ];
  const plan = planEdgeCropMoves([f], slots, CANVAS_DIMS, 12);
  assert(plan.moves.length === 0, "no clamp when the move invades a neighbor");
  assert(plan.regens.length === 1 && plan.regens[0].reason === "clamp-would-invade-neighbor", `got ${JSON.stringify(plan.regens)}`);
  assert(/s2\.copy/.test(plan.regens[0].detail), "the invaded neighbor is named");
});

await check("planEdgeCropMoves: a fitting piece over free canvas clamps exactly as v10 did (bottom+right combine)", () => {
  const fs2 = [
    cropFinding({ pieceId: "s4.hero", scene: 4, edge: "bottom", overflowPx: 40, union: { x: 1100, y: 640, w: 700, h: 480 } }),
    cropFinding({ pieceId: "s4.hero", scene: 4, edge: "right", overflowPx: 20, union: { x: 1100, y: 640, w: 700, h: 480 } }),
  ];
  const slots = [
    slot({ pieceId: "s4.hero", scene: 4, bounds: { x: 1092, y: 560, w: 768, h: 480 } }),
    slot({ pieceId: "s4.copy", scene: 4, kind: "text", bounds: { x: 120, y: 240, w: 720, h: 560 } }),
  ];
  const plan = planEdgeCropMoves(fs2, slots, CANVAS_DIMS, 12);
  assert(plan.regens.length === 0, "clean move, no regen");
  assert(plan.moves.length === 1 && plan.moves[0].dy === -52 && plan.moves[0].dx === -32, `combined move with margin: ${JSON.stringify(plan.moves)}`);
});

await check("planEdgeCropMoves: atmosphere/full-bleed neighbors never count as invaded territory", () => {
  const f = cropFinding({ overflowPx: 50, union: { x: 1160, y: 240, w: 760, h: 480 } });
  const slots = [
    slot({ bounds: { x: 1092, y: 200, w: 768, h: 560 } }),
    slot({ pieceId: "s2.atmosphere", kind: "atmosphere", bounds: { x: 0, y: 0, w: 1920, h: 1080 } }),
    slot({ pieceId: "s2.throughline", kind: "diegetic", bounds: { x: 0, y: 0, w: 1920, h: 1080 } }), // full-bleed treatment
  ];
  const plan = planEdgeCropMoves([f], slots, CANVAS_DIMS, 12);
  assert(plan.moves.length === 1 && plan.regens.length === 0, `full-bleed neighbors exempt: ${JSON.stringify(plan)}`);
});

await check("planEdgeCropMoves: an ALREADY-overlapping neighbor doesn't block the clamp (only NEW invasions do)", () => {
  // Declared overlap exists pre-move (e.g. hero over the connector's corner);
  // the clamp only makes it no worse — still a legal deterministic move.
  const f = cropFinding({ overflowPx: 30, union: { x: 1130, y: 240, w: 760, h: 480 } });
  const slots = [
    slot({ bounds: { x: 1092, y: 200, w: 768, h: 560 } }),
    slot({ pieceId: "s2.badge", kind: "diegetic", bounds: { x: 1100, y: 250, w: 200, h: 200 } }),
  ];
  const plan = planEdgeCropMoves([f], slots, CANVAS_DIMS, 12);
  assert(plan.moves.length === 1 && plan.regens.length === 0, `pre-existing overlap tolerated: ${JSON.stringify(plan)}`);
});

// Audit-1 Medium #5: findInteriorClip DELETED (superseded by intra-piece
// overlap + edge-crop) — its tests + the interiorScene fixture removed with it.

// ── v15 (#4): stray motif fragments ──────────────────────────────────────────
// Measured bg is always the browser's computed rgb()/rgba() (never hex); the
// accent list stays hex (rgbOf parses both). Excise, by contrast, matches the
// hex/const literals in the emitted CODE.
const panel = (p: Partial<MeasuredElement>): MeasuredElement =>
  el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgb(17,17,17)", x: 200, y: 200, w: 600, h: 600, ...p });
const bar = (p: Partial<MeasuredElement>): MeasuredElement =>
  el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgb(204,255,0)", h: 6, w: 400, ...p });

await check("findStrayFragments: a thin accent bar CROSSING its panel's right edge fires (the cycle-6 lime rule)", () => {
  const m = scene(2, [panel({}), bar({ x: 600, y: 400 })]); // panel right=800, bar right=1000 → overhang 200 (50%)
  const r = findStrayFragments(m, ["#ccff00"]);
  assert(r.length === 1 && r[0].form === "crossing" && r[0].edge === "right", `got ${JSON.stringify(r)}`);
  assert(r[0].overhangPx === 200, `overhang 200px, got ${r[0].overhangPx}`);
});

await check("findStrayFragments: a bar fully INSIDE its panel is clean (grazing/contained never fires)", () => {
  const m = scene(2, [panel({}), bar({ x: 300, y: 400, w: 300 })]); // 300-600 inside 200-800
  assert(findStrayFragments(m, ["#ccff00"]).length === 0, "contained bar is grammar, not a fragment");
});

await check("findStrayFragments: an ISOLATED accent bar (>80px from all its piece content) fires + connector/throughline exempt", () => {
  const far = el({ piece: "s4.hero", pieceKind: "diegetic", tag: "span", text: "hi", x: 900, y: 900, w: 200, h: 40 });
  const orphan = bar({ piece: "s4.hero", bg: "rgb(255,0,0)", w: 200, h: 6, x: 100, y: 100 });
  const iso = findStrayFragments(scene(4, [far, orphan]), ["#ff0000"]);
  assert(iso.length === 1 && iso[0].form === "isolated", `isolated fires: ${JSON.stringify(iso)}`);
  // Same geometry on a throughline piece is EXEMPT (throughlines ARE thin rules).
  const thru = findStrayFragments(scene(4, [
    { ...far, piece: "s4.throughline" },
    { ...orphan, piece: "s4.throughline" },
  ]), ["#ff0000"]);
  assert(thru.length === 0, `throughline exempt: ${JSON.stringify(thru)}`);
});

await check("findStrayFragments: with accent hexes supplied, a NEUTRAL hairline never fires (dividers are grammar)", () => {
  const m = scene(2, [panel({}), bar({ x: 600, y: 400, bg: "rgb(136,136,136)" })]);
  assert(findStrayFragments(m, ["#ccff00"]).length === 0, "neutral bar excluded when accent-filtered");
  // …but WITHOUT an accent list, geometry alone still flags it.
  assert(findStrayFragments(m).length === 1, "no accent filter → geometry fires");
});

await check("findStrayFragments: the bar IS the whole piece (no other content) → a motif, not a fragment", () => {
  const solo = bar({ piece: "s1.hero", bg: "rgb(255,0,0)", w: 200, h: 6, x: 100, y: 100 });
  assert(findStrayFragments(scene(1, [solo]), ["#ff0000"]).length === 0, "a lone bar-piece is a motif");
});

await check("exciseStrayFragment: a CROSSING bar clips its long-axis dimension to end at the panel edge", () => {
  const code = `<div style={{ position: "absolute", width: 400, height: 6, background: "#ccff00" }} />`;
  const finding = findStrayFragments(scene(2, [panel({}), bar({ x: 600, y: 400 })]), ["#ccff00"])[0];
  const r = exciseStrayFragment(code, finding);
  assert(r.action === "clipped", `clipped, got ${r.action}: ${r.detail}`);
  assert(/width: 198\b/.test(r.code), `width 400→198 (400-200-2), got: ${r.code}`);
});

await check("exciseStrayFragment: an ISOLATED self-closing childless bar is REMOVED; a childful one is not", () => {
  const finding = findStrayFragments(scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", tag: "span", text: "hi", x: 900, y: 900, w: 200, h: 40 }),
    bar({ piece: "s4.hero", bg: "rgb(255,0,0)", w: 200, h: 6, x: 100, y: 100 }),
  ]), ["#ff0000"])[0];
  const selfClose = `<span/><div style={{ width: 200, height: 6, background: "#ff0000" }} /><span/>`;
  const r = exciseStrayFragment(selfClose, finding);
  assert(r.action === "removed" && !/#ff0000/.test(r.code), `removed, got ${r.action}: ${r.code}`);
  const childful = `<div style={{ width: 200, height: 6, background: "#ff0000" }}>oops</div>`;
  assert(exciseStrayFragment(childful, finding).action === "none", "childful element is never removed");
});

await check("exciseStrayFragment: ambiguous (2 matching spans) and palette-const backgrounds", () => {
  const finding = findStrayFragments(scene(2, [panel({}), bar({ x: 600, y: 400 })]), ["#ccff00"])[0];
  const two = `<div style={{ width: 400, height: 6, background: "#ccff00" }} /><i style={{ width: 400, height: 6, background: "#ccff00" }} />`;
  assert(exciseStrayFragment(two, finding).action === "none", "2 matches → ambiguous, no repair");
  const bareConst = `<div style={{ width: 400, height: 6, background: ACCENT }} />`;
  const r = exciseStrayFragment(bareConst, finding, { ACCENT: "#ccff00" });
  assert(r.action === "clipped" && /width: 198\b/.test(r.code), `palette-resolved bg clips: ${r.action} ${r.code}`);
});

await check("STRAY_ISOLATION_MIN_PX is the calibrated 80px floor", () => {
  assert(STRAY_ISOLATION_MIN_PX === 80, `floor is 80, got ${STRAY_ISOLATION_MIN_PX}`);
});

// ── motif clutter (ghost glyphs + floating brand pills on decoration layers) ──
console.log("motif-clutter");

await check("isMotifGlyphText: motif glyphs true; words / prices / arrows false", () => {
  assert(isMotifGlyphText("✓") && isMotifGlyphText("★ ★") && isMotifGlyphText("❤"), "glyphs true");
  assert(!isMotifGlyphText("Klarna") && !isMotifGlyphText("$248") && !isMotifGlyphText("→ Buy") && !isMotifGlyphText(""), "non-glyph false");
});

await check("decorative-glyph in the ATMOSPHERE layer fires (the s4 ghost ✓)", () => {
  const m = scene(4, [
    el({ piece: "s4.atmosphere", pieceKind: "atmosphere", text: "✓", x: 260, y: 190, w: 60, h: 64, opacity: 0.06 }),
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,255,255)", x: 700, y: 200, w: 400, h: 600 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Klarna" });
  assert(r.length === 1 && r[0].form === "decorative-glyph" && r[0].pieceId === "s4.atmosphere", `got ${JSON.stringify(r)}`);
});

await check("a ✓ in a CONTENT piece (hero checkout row) is NEVER touched", () => {
  const m = scene(0, [el({ piece: "s0.hero", pieceKind: "diegetic", text: "✓", x: 620, y: 604, w: 18, h: 18 })]);
  assert(findMotifClutter(m, { brandName: "Klarna" }).length === 0, "content-layer glyph exempt");
});

await check("throughline brand pill with budget!=throughline (scene 0/1/2) → floating-brand-mark", () => {
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", bg: "rgb(255,255,255)", x: 560, y: 160, w: 800, h: 560 }),
    el({ piece: "s0.throughline", pieceKind: "diegetic", text: "Klarna", x: 1376, y: 560, w: 168, h: 44 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Klarna", brandMarkOwner: "none" });
  assert(r.length === 1 && r[0].form === "floating-brand-mark" && r[0].pieceId === "s0.throughline", `got ${JSON.stringify(r)}`);
});

await check("throughline brand pill budgeted AND on the hero (scene 3 grid legend) → KEPT", () => {
  const m = scene(3, [
    el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(30,30,40)", x: 1020, y: 270, w: 780, h: 540 }),
    el({ piece: "s3.throughline", pieceKind: "diegetic", text: "Klarna", x: 1400, y: 560, w: 140, h: 40 }),
  ]);
  assert(findMotifClutter(m, { brandName: "Klarna", brandMarkOwner: "throughline" }).length === 0, "sanctioned on-content motif mark stays");
});

await check("throughline brand pill budgeted but FLOATING off content (scene 4) → still fires", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(30,30,40)", x: 660, y: 120, w: 600, h: 840 }),
    el({ piece: "s4.throughline", pieceKind: "diegetic", text: "Klarna", x: 1400, y: 560, w: 140, h: 40 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Klarna", brandMarkOwner: "throughline" });
  assert(r.length === 1 && r[0].form === "floating-brand-mark", `pill 140px right of the phone is floating: ${JSON.stringify(r)}`);
});

await check("a full-bleed hero wrapper does NOT mask a floating pill (budget arm)", () => {
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", bg: "rgb(10,5,28)", x: 0, y: 0, w: 1920, h: 1080 }), // full-bleed wrapper
    el({ piece: "s0.hero", pieceKind: "diegetic", bg: "rgb(255,255,255)", x: 560, y: 160, w: 780, h: 560 }), // the actual card
    el({ piece: "s0.throughline", pieceKind: "diegetic", text: "Klarna", x: 1500, y: 560, w: 150, h: 44 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Klarna", brandMarkOwner: "none" });
  assert(r.length === 1 && r[0].form === "floating-brand-mark", `full-bleed wrapper excluded from anchors: ${JSON.stringify(r)}`);
});

await check("blankPieceInner empties a throughline wrapper but preserves the data-piece box", () => {
  const thr = '<div data-piece="s0.throughline" data-kind="diegetic" style={{ left: 1360 }}>\n  <div><span>Klarna</span></div>\n</div>';
  const b = blankPieceInner(thr);
  assert(b.blanked && !b.code.includes("Klarna"), `blanked: ${JSON.stringify(b)}`);
  assert(b.code.includes('data-piece="s0.throughline"') && b.code.includes("style={{ left: 1360 }}"), "wrapper + style preserved");
});

await check("stripClutterElements removes glyph leaves but keeps gradient/texture divs", () => {
  const atm = '<div data-piece="s4.atmosphere"><div style={{ opacity: 0.06 }}>✓</div><div style={{ background: "radial-gradient(x)" }} /><div style={{ opacity: 0.06 }}>✓</div></div>';
  const s = stripClutterElements(atm, isMotifGlyphText);
  assert(s.removed === 2 && !s.code.includes("✓"), `removed 2 glyphs: ${JSON.stringify(s)}`);
  assert(s.code.includes("radial-gradient"), "gradient div kept");
});

await check("an isolated throughline with NO brand text (empty badge slot) → floating-motif", () => {
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", bg: "rgb(255,255,255)", x: 560, y: 160, w: 670, h: 560 }),
    el({ piece: "s0.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", x: 1360, y: 540, w: 200, h: 200 }),
    el({ piece: "s0.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", x: 1386, y: 617, w: 148, h: 46 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Klarna" });
  assert(r.length === 1 && r[0].form === "floating-motif" && r[0].pieceId === "s0.throughline", `empty slot floats: ${JSON.stringify(r)}`);
});

await check("a throughline that sits ON the hero is NOT flagged as floating-motif", () => {
  const m = scene(3, [
    el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(30,30,40)", x: 1020, y: 270, w: 780, h: 540 }),
    el({ piece: "s3.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", x: 1360, y: 540, w: 200, h: 200 }),
  ]);
  assert(findMotifClutter(m, { brandName: "Klarna", brandMarkOwner: "throughline" }).length === 0, "integrated throughline stays");
});

// ── P3-C2 #1: throughline PROTRUSION clamp (Brex s2/s3/s4 pinned-right chips) ──
// The chip is <80px off the hero edge (the gap arm keeps it) but sticks out past
// the hero's painted envelope into empty canvas. Coordinates from the real Brex
// composition + frame geometry (hero envelopes measured from the frames).
await check("Brex s2: 'RECEIPT AUTO-MATCHED' chip fully right of the dashboard → protruding-motif", () => {
  const m = scene(2, [
    // dashboard hero: 300..1360 (bounded, browser-style frame)
    el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgb(20,22,26)", x: 300, y: 130, w: 1060, h: 815 }),
    // copy column content ends ~y640 (above the chip) — chip is not covered by it
    el({ piece: "s2.copy", pieceKind: "text", text: "Expenses that manage themselves", x: 1420, y: 300, w: 360, h: 340 }),
    // the chip the cast pinned at bottom-right, 11px off the hero edge, below the copy
    el({ piece: "s2.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "RECEIPT AUTO-MATCHED", x: 1371, y: 705, w: 159, h: 22 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Brex", brandMarkOwner: "throughline" });
  assert(r.length === 1 && r[0].form === "protruding-motif" && r[0].pieceId === "s2.throughline", `got ${JSON.stringify(r)}`);
});

await check("Brex s3: '9.8M RECEIPTS…' chip pokes ~45px past the card's right edge → protruding-motif", () => {
  const m = scene(3, [
    // stat card hero: painted envelope 355..1565
    el({ piece: "s3.hero", pieceKind: "diegetic", bg: "rgb(22,25,30)", x: 355, y: 205, w: 1210, h: 665 }),
    // chip 1310..1610 overlaps the 30x tile inside the card AND juts 45px past 1565
    el({ piece: "s3.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "9.8M RECEIPTS AUTOMATED THIS QUARTER", x: 1310, y: 628, w: 300, h: 24 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Brex", brandMarkOwner: "throughline" });
  assert(r.length === 1 && r[0].form === "protruding-motif", `got ${JSON.stringify(r)}`);
});

await check("Brex s4: 'RECEIPTS AUTOMATED — NOTHING TO CHASE' juts ~140px past the mock → protruding-motif", () => {
  const m = scene(4, [
    // onboarding mock hero: 460..1460
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(26,20,16)", x: 460, y: 255, w: 1000, h: 560 }),
    el({ piece: "s4.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "RECEIPTS AUTOMATED — NOTHING TO CHASE", x: 1345, y: 630, w: 255, h: 20 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Brex", brandMarkOwner: "throughline" });
  assert(r.length === 1 && r[0].form === "protruding-motif", `got ${JSON.stringify(r)}`);
});

await check("a throughline FULLY INSIDE the hero envelope (the reference's in-mock slot) is KEPT", () => {
  const m = scene(2, [
    el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgb(20,22,26)", x: 300, y: 130, w: 1060, h: 815 }),
    // authored-in-hero chip at 340,420,210,32 — comfortably inside 300..1360
    el({ piece: "s2.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "RECEIPT AUTO-MATCHED", x: 340, y: 420, w: 210, h: 32 }),
  ]);
  assert(findMotifClutter(m, { brandName: "Brex", brandMarkOwner: "throughline" }).length === 0, "in-hero motif stays");
});

await check("a chip whose overhang lands ON the copy column bridges two panels → KEPT (not protruding)", () => {
  const m = scene(2, [
    el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgb(20,22,26)", x: 300, y: 130, w: 1060, h: 815 }),
    // tall copy panel whose surface DOES cover the chip's overhang region
    el({ piece: "s2.copy", pieceKind: "text", bg: "rgb(24,26,30)", text: "Expenses that manage themselves", x: 1400, y: 300, w: 380, h: 520 }),
    el({ piece: "s2.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "RECEIPT AUTO-MATCHED", x: 1330, y: 500, w: 200, h: 30 }),
  ]);
  assert(findMotifClutter(m, { brandName: "Brex", brandMarkOwner: "throughline" }).length === 0, "chip bridging hero→copy stays");
});

await check("a small in-hero motif poking a rounded-corner sliver (~10px) past the hero is KEPT", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(26,20,16)", x: 460, y: 255, w: 1000, h: 560 }),
    // chip poking only 10px past the right edge — below the PROTRUSION_MIN_PX floor
    el({ piece: "s4.throughline", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "chip", x: 1400, y: 500, w: 70, h: 24 }),
  ]);
  assert(findMotifClutter(m, { brandName: "Brex", brandMarkOwner: "throughline" }).length === 0, "sub-floor sliver stays");
});

await check("exciseMotifClutter blanks a PROTRUDING throughline piece end-to-end", () => {
  const thr = '<div data-piece="s2.throughline" data-kind="diegetic"><div><span>RECEIPT AUTO-MATCHED</span></div></div>';
  const r = exciseMotifClutter(thr, [{ kind: "motif-clutter", scene: 2, pieceId: "s2.throughline", form: "protruding-motif", text: "", rect: { x: 1371, y: 705, w: 159, h: 22 }, detail: "" }], { brandName: "Brex" });
  assert(r.action === "blanked" && !r.code.includes("AUTO-MATCHED"), `got ${JSON.stringify(r)}`);
});

await check("SVG-drawn ghost checkmark in atmosphere fires (measured as a small <svg>)", () => {
  const m = scene(4, [
    el({ piece: "s4.atmosphere", pieceKind: "atmosphere", tag: "svg", text: "", x: 300, y: 320, w: 26, h: 26, opacity: 0.06 }),
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,255,255)", x: 560, y: 700, w: 800, h: 280 }),
  ]);
  const r = findMotifClutter(m, { brandName: "Klarna" });
  assert(r.length === 1 && r[0].form === "decorative-glyph", `svg icon flagged: ${JSON.stringify(r)}`);
});

await check("stripDecorationSvgIcons removes a {…map…} checkmark group but keeps washes/grain", () => {
  const atm =
    '<div data-piece="s4.atmosphere">' +
    '<div style={{ background: "radial-gradient(x)" }} />' +
    '{[{ top: "30%" }, { top: "58%" }].map((ck, i) => (' +
    '<svg key={i} width={ck.size} height={ck.size} viewBox="0 0 24 24" style={{ opacity: 0.06 }}>' +
    '<path d="M5 12.5 L10 17.5 L19 7" stroke="#3ecfcf" fill="none" /></svg>))}' +
    '<div style={{ backgroundImage: "url(grain.svg)" }} /></div>';
  const r = stripDecorationSvgIcons(atm);
  assert(r.removed === 1 && !r.code.includes("M5 12.5") && !r.code.includes(".map("), `map group removed: ${JSON.stringify(r)}`);
  assert(r.code.includes("radial-gradient") && r.code.includes("url(grain.svg)"), "washes + grain kept");
});

await check("stripDecorationSvgIcons keeps a full-bleed (large-viewBox) atmosphere svg", () => {
  const atm = '<div data-piece="s0.atmosphere"><svg viewBox="0 0 1920 1080" width="100%"><path d="M0 0 L1920 1080" /></svg></div>';
  assert(stripDecorationSvgIcons(atm).removed === 0, "large background svg is not an icon");
});

await check("exciseMotifClutter blanks a throughline floating-mark piece end-to-end", () => {
  const thr = '<div data-piece="s2.throughline" data-kind="diegetic"><div><span>Klarna</span></div></div>';
  const r = exciseMotifClutter(thr, [{ kind: "motif-clutter", scene: 2, pieceId: "s2.throughline", form: "floating-brand-mark", text: "Klarna", rect: { x: 0, y: 0, w: 0, h: 0 }, detail: "" }], { brandName: "Klarna" });
  assert(r.action === "blanked" && !r.code.includes("Klarna"), `got ${JSON.stringify(r)}`);
});

// ── canvas COHERENCE (P3-C1: a scene shipped on an off-brand canvas) ─────────
// Calibrated on the real Fuse frames (agent-measured median RGB vs brand
// #440b12): s3 collapsed to neutral near-black (26,26,30); the rest stayed warm.
const FUSE_BRAND_BG = "#440b12";
const FUSE_SCENE_RGB: [number, number, number][] = [
  [60, 10, 16], // s0 burgundy
  [76, 24, 30], // s1 burgundy
  [79, 17, 24], // s2 burgundy (MUST PASS)
  [26, 26, 30], // s3 neutral near-black (MUST FIRE)
  [68, 12, 18], // s4 burgundy
];
await check("assessCanvasCoherence: Fuse s3 off-brand canvas FIRES, s0/s1/s2/s4 PASS", () => {
  const f = assessCanvasCoherence(
    FUSE_BRAND_BG,
    FUSE_SCENE_RGB.map((rgb, scene) => ({ scene, rgb })),
  );
  assert(f.length === 1, `exactly one off-brand scene, got ${f.length}: ${JSON.stringify(f.map((x) => x.scene))}`);
  assert(f[0].scene === 3 && f[0].kind === "canvas-coherence", `must be scene 3, got ${JSON.stringify(f[0])}`);
  assert(/chroma collapsed/.test(f[0].detail), `should note the chroma collapse: ${f[0].detail}`);
});
await check("assessCanvasCoherence: a coherent burgundy scene at the RGB-delta boundary stays PASS", () => {
  // dist ~ CANVAS_COHERENCE_RGB_DELTA-1 with intact chroma must not fire.
  const near: [number, number, number] = [68 + CANVAS_COHERENCE_RGB_DELTA - 5, 11, 18];
  const f = assessCanvasCoherence(FUSE_BRAND_BG, [{ scene: 0, rgb: near }]);
  assert(f.length === 0, `just-inside coherent scene should pass, got ${JSON.stringify(f)}`);
});
await check("assessCanvasCoherence: neutral-canvas brand (no chroma reference) never flags a neutral scene", () => {
  const f = assessCanvasCoherence("#0e0e12", [
    { scene: 0, rgb: [14, 14, 18] },
    { scene: 1, rgb: [20, 20, 24] },
  ]);
  assert(f.length === 0, `a near-black brand can't be "off" by being near-black: ${JSON.stringify(f)}`);
});
await check("assessCanvasCoherence: unparseable / missing brand bg → skipped (never fabricates)", () => {
  assert(assessCanvasCoherence(undefined, [{ scene: 0, rgb: [0, 0, 0] }]).length === 0, "undefined bg skips");
  assert(assessCanvasCoherence("not-a-hex", [{ scene: 0, rgb: [0, 0, 0] }]).length === 0, "bad hex skips");
});

// ── Audit-1 High #4: coherence gets the SAME dark-scene budget as brightness ──
await check("assessCanvasCoherence: a LIGHT brand's ONE deliberate dark scene PASSES (budget), a SECOND is flagged", () => {
  const WHITE = "#ffffff";
  const one = assessCanvasCoherence(WHITE, [
    { scene: 0, rgb: [250, 250, 250] }, // canvas
    { scene: 1, rgb: [252, 252, 252] }, // canvas
    { scene: 2, rgb: [20, 20, 24] }, // ONE deliberate dark contrast scene
  ]);
  assert(one.length === 0, `one luminance-inversion scene is within budget, got ${JSON.stringify(one.map((f) => f.scene))}`);
  const two = assessCanvasCoherence(WHITE, [
    { scene: 0, rgb: [250, 250, 250] },
    { scene: 1, rgb: [20, 20, 24] }, // dark #1 — allowed
    { scene: 2, rgb: [22, 22, 26] }, // dark #2 — over budget → flagged
  ]);
  assert(two.length === 1 && two[0].scene === 2, `the excess inversion is flagged, got ${JSON.stringify(two.map((f) => f.scene))}`);
  assert(/contrast canvas too many/.test(two[0].detail), "names the budget overflow");
});

await check("assessCanvasCoherence: a HUE-DRIFT scene is off-brand regardless of budget", () => {
  // Brand blue; a green canvas is a different hue, not a lightness inversion.
  const off = assessCanvasCoherence("#1e5fb8", [{ scene: 0, rgb: [40, 150, 60] }]);
  assert(off.length === 1 && /hue drifted/.test(off[0].detail), `hue drift must fire off-brand: ${JSON.stringify(off)}`);
});

await check("assessCanvasCoherence: a neutral brand + an INVENTED saturated hue is off-brand", () => {
  // Near-white brand; a scene that paints a saturated teal invented a color.
  const off = assessCanvasCoherence("#f4f4f6", [{ scene: 0, rgb: [16, 150, 150] }]);
  assert(off.length === 1 && /invented a saturated hue/.test(off[0].detail), `invented hue must fire: ${JSON.stringify(off)}`);
});

// ── corner-mark collision (P3-C1: a duplicate brand lockup in the corner) ────
const chromeMark = (text = "Fuse"): MeasuredElement =>
  el({ tag: "span", text, piece: "s0.chrome", pieceKind: "chrome", x: 40, y: 44, w: 92, h: 30 });
await check("findCornerMarkCollision: hero mark OVERLAPPING the corner chrome FIRES (Fuse s0/s4)", () => {
  const m = scene(0, [
    chromeMark("Fuse"),
    // the head's "Fuse logo upper-left" inside the hero, overlapping the chrome
    el({ tag: "span", text: "Fuse", piece: "s0.hero", pieceKind: "diegetic", x: 52, y: 50, w: 120, h: 44 }),
  ]);
  const r = findCornerMarkCollision(m, { brandName: "Fuse" });
  assert(r.length === 1 && r[0].kind === "corner-mark-collision", `got ${JSON.stringify(r)}`);
  assert(/s0\.hero/.test(r[0].detail), `routes to the hero: ${r[0].detail}`);
});
await check("findCornerMarkCollision: a DISTANT in-mock brand mark PASSES (Fuse s2 sidebar)", () => {
  const m = scene(2, [
    chromeMark("Fuse"),
    // "Fuse" inside the product mock sidebar, ~330px off the corner chrome
    el({ tag: "span", text: "Fuse", piece: "s2.hero", pieceKind: "diegetic", x: 465, y: 136, w: 90, h: 28 }),
  ]);
  assert(findCornerMarkCollision(m, { brandName: "Fuse" }).length === 0, "distant in-mock mark is not a collision");
});
await check("findCornerMarkCollision: a single clean corner mark PASSES (Fuse s3)", () => {
  const m = scene(3, [chromeMark("Fuse"), el({ tag: "div", text: "Application Portal", piece: "s3.hero", x: 700, y: 400, w: 500, h: 300 })]);
  assert(findCornerMarkCollision(m, { brandName: "Fuse" }).length === 0, "only the chrome mark → no collision");
});
await check("findCornerMarkCollision: no corner chrome mark → nothing to collide with", () => {
  const m = scene(0, [el({ tag: "span", text: "Fuse", piece: "s0.hero", pieceKind: "diegetic", x: 52, y: 50, w: 120, h: 44 })]);
  assert(findCornerMarkCollision(m, { brandName: "Fuse" }).length === 0, "no chrome mark measured → skip");
});
await check("findCornerMarkCollision: no brand name → gate skipped", () => {
  const m = scene(0, [chromeMark("Fuse"), el({ text: "Fuse", piece: "s0.hero", x: 52, y: 50, w: 120, h: 44 })]);
  assert(findCornerMarkCollision(m, {}).length === 0, "no brandName → skip");
});

// ── P3-C2 #2: hollow CTA (Brex s4 empty orange pill) ─────────────────────────
const BREX_BG = "#15191e";
await check("findHollowCta: Brex s4 empty orange pill (80×30, no text) FIRES", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,89,0)", text: "", hasTextDesc: false, x: 855, y: 655, w: 80, h: 30 }),
  ]);
  const r = findHollowCta(m, { brandBackground: BREX_BG });
  assert(r.length === 1 && r[0].kind === "hollow-cta" && /s4\.hero/.test(r[0].detail), `got ${JSON.stringify(r)}`);
});
await check("findHollowCta: a LABELED CTA ('Start now') PASSES", () => {
  const m = scene(4, [
    el({ piece: "s4.copy", pieceKind: "text", bg: "rgb(255,89,0)", text: "Start now", hasTextDesc: true, x: 900, y: 210, w: 120, h: 44 }),
  ]);
  assert(findHollowCta(m, { brandBackground: BREX_BG }).length === 0, "labeled CTA is not hollow");
});
await check("findHollowCta: a pill with a text DESCENDANT (label in a child span) PASSES", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,89,0)", text: "", hasTextDesc: true, x: 855, y: 655, w: 120, h: 40 }),
  ]);
  assert(findHollowCta(m, { brandBackground: BREX_BG }).length === 0, "text descendant → labeled");
});
await check("findHollowCta: a NEUTRAL empty card (low chroma) PASSES (accent-only)", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(34,38,44)", text: "", hasTextDesc: false, x: 855, y: 655, w: 120, h: 40 }),
  ]);
  assert(findHollowCta(m, { brandBackground: BREX_BG }).length === 0, "neutral panel is not an accent CTA");
});
await check("findHollowCta: a thin accent RULE (h<26) PASSES (stray-fragment territory)", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,89,0)", text: "", hasTextDesc: false, x: 855, y: 655, w: 200, h: 6 }),
  ]);
  assert(findHollowCta(m, { brandBackground: BREX_BG }).length === 0, "thin rule is not a button");
});
await check("findHollowCta: a large accent PANEL (w>460) PASSES (accent-as-fill territory)", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,89,0)", text: "", hasTextDesc: false, x: 300, y: 400, w: 900, h: 80 }),
  ]);
  assert(findHollowCta(m, { brandBackground: BREX_BG }).length === 0, "big slab is accent-as-fill, not hollow-cta");
});
await check("findHollowCta: a SQUARE icon chip (aspect ~1) PASSES", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", bg: "rgb(255,89,0)", text: "", hasTextDesc: false, x: 855, y: 655, w: 44, h: 40 }),
  ]);
  assert(findHollowCta(m, { brandBackground: BREX_BG }).length === 0, "square icon chip is not a label-bearing button");
});

// ── P3-C2 #4b: intra-piece control/copy collision (Brex s0 bottom-center) ─────
await check("findIntraPieceOverlap: a 'Submit for Approval' pill overlapping helper text in the SAME hero FIRES", () => {
  const m = scene(0, [
    // the button pill (solid bg) — excluded by isOverlapText, so text-overlap misses it
    el({ piece: "s0.hero", pieceKind: "diegetic", tag: "button", bg: "rgb(111,115,123)", text: "Submit for Approval", fontSize: 18, x: 848, y: 862, w: 227, h: 40 }),
    // the helper line it lands on
    el({ piece: "s0.hero", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "1 required field missing · receipt not yet categorized", fontSize: 14, x: 755, y: 878, w: 380, h: 20 }),
  ]);
  const r = findIntraPieceOverlap(m);
  assert(r.length === 1 && r[0].kind === "intra-piece-overlap" && /s0\.hero/.test(r[0].detail), `got ${JSON.stringify(r)}`);
});
await check("findIntraPieceOverlap: two ADJACENT chips (no overlap) PASS", () => {
  const m = scene(2, [
    el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgb(255,89,0)", text: "AUTO-CATEGORIZED", fontSize: 13, x: 1190, y: 440, w: 130, h: 26 }),
    el({ piece: "s2.hero", pieceKind: "diegetic", bg: "rgba(0,0,0,0)", text: "Uber — $24.50 — Travel", fontSize: 16, x: 700, y: 435, w: 300, h: 24 }),
  ]);
  assert(findIntraPieceOverlap(m).length === 0, "chip beside a row is not a collision");
});
await check("findIntraPieceOverlap: a button LABEL fully inside its own button (containment) PASSES", () => {
  const m = scene(4, [
    el({ piece: "s4.hero", pieceKind: "diegetic", tag: "button", bg: "rgb(255,89,0)", text: "Start now", fontSize: 20, x: 900, y: 210, w: 130, h: 48 }),
    el({ piece: "s4.hero", pieceKind: "diegetic", tag: "span", bg: "rgba(0,0,0,0)", text: "Start now", fontSize: 20, x: 915, y: 222, w: 100, h: 24 }),
  ]);
  assert(findIntraPieceOverlap(m).length === 0, "label inside its own control is by design");
});
await check("findIntraPieceOverlap: a collision across DIFFERENT pieces is NOT this gate's job", () => {
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", tag: "button", bg: "rgb(111,115,123)", text: "Submit for Approval", fontSize: 18, x: 848, y: 862, w: 227, h: 40 }),
    el({ piece: "s0.copy", pieceKind: "text", bg: "rgba(0,0,0,0)", text: "1 required field missing", fontSize: 14, x: 800, y: 878, w: 300, h: 20 }),
  ]);
  assert(findIntraPieceOverlap(m).length === 0, "cross-piece is cross-piece-overlap's job");
});

// ── P3-C2 #4a: oversized ghost word-fragment (Brex s0 'DRAFT' watermark) ──────
await check("findGhostFragment: a giant faint 'DRAFT' watermark FIRES", () => {
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", text: "DRAFT", fontSize: 220, opacity: 0.2, x: 1000, y: 90, w: 700, h: 240 }),
  ]);
  const r = findGhostFragment(m);
  assert(r.length === 1 && r[0].kind === "ghost-fragment" && /DRAFT/.test(r[0].detail), `got ${JSON.stringify(r)}`);
});
await check("findGhostFragment: a full-opacity display HEADLINE (multi-word) PASSES", () => {
  const m = scene(0, [
    el({ piece: "s0.copy", pieceKind: "text", text: "The expense report is still on someone's desk", fontSize: 72, opacity: 1, x: 240, y: 120, w: 1200, h: 90 }),
  ]);
  assert(findGhostFragment(m).length === 0, "readable headline is not a ghost fragment");
});
await check("findGhostFragment: a giant FULL-OPACITY stat counter '35,000' PASSES (not faint)", () => {
  const m = scene(3, [
    el({ piece: "s3.hero", pieceKind: "diegetic", text: "35,000", fontSize: 200, opacity: 1, x: 640, y: 300, w: 460, h: 180 }),
  ]);
  assert(findGhostFragment(m).length === 0, "a legible counter is full-opacity → kept");
});
await check("findGhostFragment: a faint but SMALL label PASSES (must be oversized)", () => {
  const m = scene(0, [
    el({ piece: "s0.hero", pieceKind: "diegetic", text: "held", fontSize: 20, opacity: 0.25, x: 900, y: 600, w: 80, h: 24 }),
  ]);
  assert(findGhostFragment(m).length === 0, "small faint label is fine");
});

// ── real-frame calibration for the two P3-C1 gates (skipped when .data absent) ─
const FUSE_FRAMES = path.join(process.cwd(), ".data", "dogfood", "fullpipe-fuse", "frames");
if (existsSync(path.join(FUSE_FRAMES, "scene3.png"))) {
  await check("CALIBRATION: findCanvasCoherence on real Fuse frames — s3 FIRES, others PASS", async () => {
    const ms: SceneMeasurement[] = [0, 1, 2, 3, 4].map((i) => ({
      scene: i, width: 1920, height: 1080, elements: [], screenshotPath: path.join(FUSE_FRAMES, `scene${i}.png`),
    }));
    const f = await findCanvasCoherence(ms, FUSE_BRAND_BG);
    assert(f.length === 1 && f[0].scene === 3, `only s3 off-brand, got ${JSON.stringify(f.map((x) => x.scene))}`);
  });
} else {
  console.log("  … Fuse real-frame calibration skipped (.data/dogfood/fullpipe-fuse absent)");
}

// ── findStrayFullBleedCard (P3-C5 #2a — Vanta s2 stray empty black card) ──────
{
  // The primary mock's content (a chart panel with text) the stray card floats over.
  const mockContent = () => el({ tag: "div", text: "Continuous Monitoring", piece: "s2.hero", pieceKind: "diegetic", x: 300, y: 250, w: 1500, h: 600, hasTextDesc: true });
  await check("stray-card FIRES: a solid EMPTY card floating over the mock on full-bleed (Vanta s2)", () => {
    const strayCard = el({ tag: "div", text: "", piece: "s2.strayblock", pieceKind: "diegetic", x: 1360, y: 545, w: 200, h: 195, bg: "rgb(20,20,24)", hasTextDesc: false });
    const m = scene(2, [mockContent(), strayCard]);
    const r = findStrayFullBleedCard(m, "full-bleed");
    assert(r.length === 1 && r[0].kind === "stray-card" && /s2\.strayblock/.test(r[0].detail), `expected one stray-card on s2.strayblock, got ${JSON.stringify(r)}`);
  });
  await check("stray-card PASSES: the same card on a NON-full-bleed register is not flagged", () => {
    const strayCard = el({ tag: "div", text: "", piece: "s2.strayblock", pieceKind: "diegetic", x: 1360, y: 545, w: 200, h: 195, bg: "rgb(20,20,24)", hasTextDesc: false });
    const m = scene(2, [mockContent(), strayCard]);
    assert(findStrayFullBleedCard(m, "centered").length === 0, "only full-bleed is in scope");
    assert(findStrayFullBleedCard(m, undefined).length === 0, "undefined register is not in scope");
  });
  await check("stray-card PASSES: a LABELLED card (carries text) is a real panel, not stray", () => {
    const labelled = el({ tag: "div", text: "", piece: "s2.card", pieceKind: "diegetic", x: 1360, y: 545, w: 200, h: 195, bg: "rgb(20,20,24)", hasTextDesc: true });
    const m = scene(2, [mockContent(), labelled]);
    assert(findStrayFullBleedCard(m, "full-bleed").length === 0, "a card with a text descendant is furnished");
  });
  await check("stray-card PASSES: a standalone empty card touching NO content (orphan-advisory's job)", () => {
    const lonely = el({ tag: "div", text: "", piece: "s2.block", pieceKind: "diegetic", x: 60, y: 60, w: 200, h: 195, bg: "rgb(20,20,24)", hasTextDesc: false });
    const faraway = el({ tag: "div", text: "hi", piece: "s2.hero", pieceKind: "diegetic", x: 1600, y: 800, w: 200, h: 100, hasTextDesc: true });
    const m = scene(2, [lonely, faraway]);
    assert(findStrayFullBleedCard(m, "full-bleed").length === 0, "a non-occluding empty card is not a blocking stray card");
  });
  await check("stray-card PASSES: a transparent/gradient panel (hasBgImage) is deliberate décor", () => {
    const gradient = el({ tag: "div", text: "", piece: "s2.glow", pieceKind: "diegetic", x: 1360, y: 545, w: 200, h: 195, bg: "rgba(0,0,0,0)", hasBgImage: true, hasTextDesc: false });
    const m = scene(2, [mockContent(), gradient]);
    assert(findStrayFullBleedCard(m, "full-bleed").length === 0, "a gradient/bg-image panel is not an empty stray card");
  });
  await check("stray-card PASSES: the huge primary mock surface itself (> canvas frac) is not a stray card", () => {
    const bigMock = el({ tag: "div", text: "", piece: "s2.hero", pieceKind: "diegetic", x: 40, y: 40, w: 1840, h: 1000, bg: "rgb(20,20,24)", hasTextDesc: false });
    const label = el({ tag: "div", text: "hi", piece: "s2.copy", pieceKind: "text", x: 100, y: 100, w: 300, h: 80, hasTextDesc: true });
    const m = scene(2, [bigMock, label]);
    assert(findStrayFullBleedCard(m, "full-bleed").length === 0, "the mock surface itself exceeds the max card fraction");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
