/**
 * Tests for the render-truth gates. findOverflow is pure (operates on measured
 * rects) so it's fully unit-testable without a browser. findRenderTruthFailures
 * is exercised for its blocking-subset logic with screenshot-less measurements
 * (contrast/dead-region no-op without a screenshot — overflow is the blocker).
 */
import {
  findOverflow,
  findTextOverlap,
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
  opacity: 1, ...p,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
