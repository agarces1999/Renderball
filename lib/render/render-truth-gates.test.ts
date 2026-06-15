/**
 * Tests for the render-truth gates. findOverflow is pure (operates on measured
 * rects) so it's fully unit-testable without a browser. findRenderTruthFailures
 * is exercised for its blocking-subset logic with screenshot-less measurements
 * (contrast/dead-region no-op without a screenshot — overflow is the blocker).
 */
import { findOverflow, findRenderTruthFailures } from "./render-truth-gates";
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
