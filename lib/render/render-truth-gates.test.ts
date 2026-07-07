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
  findRenderTruthFailures,
  hexLuminance,
  assessCanvasBrightness,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
