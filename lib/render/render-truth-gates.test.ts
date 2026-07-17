/**
 * Tests for the render-truth gates. findOverflow is pure (operates on measured
 * rects) so it's fully unit-testable without a browser. findRenderTruthFailures
 * is exercised for its blocking-subset logic with screenshot-less measurements
 * (contrast/dead-region no-op without a screenshot — overflow is the blocker).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  findOverflow,
  findTextOverlap,
  findCrossPieceOverlap,
  findEmptyBand,
  findEdgeCroppedPieces,
  findRenderTruthFailures,
  findInteriorClip,
  planEdgeCropMoves,
  hexLuminance,
  assessCanvasBrightness,
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
  INTERIOR_CLIP_FRAC,
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

// ── text-on-text overlap (wrapping headline buries the lede) ─────────────────
const txt = (p: Partial<MeasuredElement>): MeasuredElement =>
  el({ fontSize: 24, text: "x", bg: "rgba(0,0,0,0)", ...p });

await check("flags a wrapped headline overrunning the lede (the Canva scene-2/4 defect)", () => {
  // headline @top:132 wraps to ~336px tall (ends ~468); lede hardcoded @top:340
  // sits entirely inside the headline's box — a full collision.
  const m = scene(2, [
    txt({ tag: "h1", text: "One design, every surface", x: 80, y: 132, w: 440, h: 336, fontSize: 80 }),
    txt({ tag: "p", text: "Make one design for any format in a tap.", x: 80, y: 340, w: 440, h: 80 }),
  ]);
  const r = findTextOverlap(m);
  assert(r.length === 1 && r[0].kind === "text-overlap", `got ${JSON.stringify(r)}`);
});

await check("does NOT flag a container whose text contains the child's (ul ⊇ li)", () => {
  const m = scene(0, [
    txt({ tag: "ul", text: "Real-time · Fractional · Free", x: 80, y: 470, w: 440, h: 120 }),
    txt({ tag: "li", text: "Real-time", x: 80, y: 470, w: 440, h: 36 }),
  ]);
  assert(findTextOverlap(m).length === 0, "container/child text containment must not flag");
});

await check("does NOT flag text sitting on an opaque chip/card (intentional overlap)", () => {
  // a label on a colored badge: the label's own bg is the chip color (opaque).
  const m = scene(1, [
    txt({ tag: "span", text: "SALE", x: 600, y: 270, w: 80, h: 40, bg: "rgba(216,27,96,1)" }),
    txt({ tag: "span", text: "Social Post", x: 690, y: 275, w: 120, h: 30, bg: "rgba(216,27,96,1)" }),
  ]);
  assert(findTextOverlap(m).length === 0, "text on an opaque surface must not flag");
});

await check("does NOT flag cleanly stacked, non-overlapping text", () => {
  const m = scene(0, [
    txt({ tag: "h1", text: "Headline here", x: 80, y: 120, w: 600, h: 160, fontSize: 80 }),
    txt({ tag: "p", text: "A lede comfortably below.", x: 80, y: 320, w: 600, h: 70 }),
  ]);
  assert(findTextOverlap(m).length === 0, "non-overlapping stack must not flag");
});

await check("does NOT flag an inline accent (em OR span) inside its headline", () => {
  // measure-scene reports the h1 and its inline accent as separate elements; the
  // accent sits inside the h1 by design — never a collision, whatever the tag.
  const em = scene(1, [
    txt({ tag: "h1", text: "The market was built for the", x: 96, y: 188, w: 760, h: 162, fontSize: 78 }),
    txt({ tag: "em", text: "few", x: 538, y: 262, w: 130, h: 95, fontSize: 78 }),
  ]);
  assert(findTextOverlap(em).length === 0, "inline <em> accent must not flag");
  // The real Robinhood case: "everyone" is a styled <span> inside the headline.
  const span = scene(1, [
    txt({ tag: "h1", text: "Investing for", x: 393, y: 139, w: 1135, h: 120, fontSize: 96 }),
    txt({ tag: "span", text: "everyone", x: 1041, y: 139, w: 486, h: 120, fontSize: 96 }),
  ]);
  assert(findTextOverlap(span).length === 0, "inline <span> accent must not flag");
});

await check("does NOT flag a tiny (<30%) incidental overlap", () => {
  const m = scene(0, [
    txt({ tag: "h1", text: "Alpha", x: 80, y: 120, w: 400, h: 120 }),
    txt({ tag: "p", text: "Bravo", x: 80, y: 235, w: 400, h: 120 }), // only ~4% overlap
  ]);
  assert(findTextOverlap(m).length === 0, "minor incidental overlap must not flag");
});

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

// ─── interior clip advisory (v11 #6 — cycle-2 s2 price chips cut mid-glyph) ──

/** A hero panel (3 siblings forming a big union) + one chip. */
const interiorScene = (chip: MeasuredElement): SceneMeasurement =>
  scene(2, [
    el({ piece: "s2.hero", pieceKind: "diegetic", x: 1100, y: 200, w: 700, h: 500, bg: "rgb(255,255,255)" }),
    el({ piece: "s2.hero", pieceKind: "diegetic", tag: "span", text: "Futuredew", x: 1130, y: 240, w: 200, h: 24, fontSize: 14 }),
    el({ piece: "s2.hero", pieceKind: "diegetic", tag: "span", text: "serum + oil", x: 1130, y: 280, w: 200, h: 24, fontSize: 12 }),
    chip,
  ]);

await check("findInteriorClip: a price chip protruding >30% of its width past the panel edge fires (advisory)", () => {
  // Panel union (without the chip) ends at x=1800; the chip is 120 wide with
  // 60px (50%) sticking out — the cycle-2 "$36.0" mid-glyph class.
  const chip = el({ piece: "s2.hero", pieceKind: "diegetic", tag: "span", text: "$36.00", x: 1740, y: 300, w: 120, h: 24, fontSize: 12 });
  const r = findInteriorClip(interiorScene(chip));
  assert(r.length === 1 && r[0].kind === "interior-clip", `got ${JSON.stringify(r)}`);
  assert(/\$36\.0/.test(r[0].detail) && /right/.test(r[0].detail), "names the clipped value and edge");
  assert(0.5 > INTERIOR_CLIP_FRAC, "fixture is genuinely over the 30% line");
});

await check("findInteriorClip: chips fully inside, mild overhang, and fully-outside elements never fire", () => {
  const inside = el({ piece: "s2.hero", tag: "span", text: "$36.00", x: 1600, y: 300, w: 120, h: 24 });
  assert(findInteriorClip(interiorScene(inside)).length === 0, "inside → clean");
  // 24px of 120 (20%) overhang — a sanctioned badge-breaks-the-edge pattern.
  const mild = el({ piece: "s2.hero", tag: "span", text: "$36.00", x: 1704, y: 300, w: 120, h: 24 });
  assert(findInteriorClip(interiorScene(mild)).length === 0, "≤30% overhang → clean");
  // Center outside the union = its own composition, not a clip.
  const outside = el({ piece: "s2.hero", tag: "span", text: "$36.00", x: 1810, y: 300, w: 120, h: 24 });
  assert(findInteriorClip(interiorScene(outside)).length === 0, "fully-outside → clean");
});

await check("findInteriorClip: tiny pieces (no panel-scale union) and measure-error scenes are skipped", () => {
  const m = scene(1, [
    el({ piece: "s1.badge", tag: "span", text: "hello", x: 0, y: 0, w: 60, h: 20 }),
    el({ piece: "s1.badge", tag: "span", text: "world", x: 40, y: 0, w: 60, h: 20 }),
    el({ piece: "s1.badge", x: 0, y: 0, w: 80, h: 30 }),
  ]);
  assert(findInteriorClip(m).length === 0, "sub-panel unions never fire");
  const err = { ...scene(1, []), error: "boom" };
  assert(findInteriorClip(err).length === 0, "measure-error scenes skip");
});

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
