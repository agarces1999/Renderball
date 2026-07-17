//
// Tests for the skeleton-bar detector (v13 #4) — the measured arm of the
// NO_PLACEHOLDER contract. Hand-built measurement fixtures: a qualifying row
// is ≥3 SIBLING flat mid-grey rounded no-text bars, each >60px wide;
// advisory at 1 row, blocking at ≥2 rows in one piece.
//
import {
  findSkeletonBars,
  isSkeletonBarCandidate,
  SKELETON_ROW_MIN_BARS,
  SKELETON_BLOCKING_MIN_ROWS,
} from "./skeleton-bars";
import type { MeasuredElement, SceneMeasurement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("skeleton-bars");

/** A canonical skeleton bar: 220x12, #d1d5db-ish grey, r4, no text. */
const bar = (parentIx: number, over: Partial<MeasuredElement> = {}): MeasuredElement => ({
  tag: "div", x: 100, y: 100, w: 220, h: 12,
  color: "rgb(0,0,0)", bg: "rgb(209, 213, 219)", text: "", isImg: false,
  fontSize: 16, opacity: 1, piece: "s3.hero", pieceKind: "diegetic",
  onOpaqueSurface: true, coveredAtCenter: false,
  radius: 4, parentIx, hasTextDesc: false, hasBgImage: false,
  ...over,
});

const scene = (elements: MeasuredElement[], over: Partial<SceneMeasurement> = {}): SceneMeasurement => ({
  scene: 3, width: 1080, height: 1080, elements, ...over,
});

check("candidate contract: the canonical grey bar qualifies; each disqualifier flips it off", () => {
  assert(isSkeletonBarCandidate(bar(5)), "canonical bar qualifies");
  assert(!isSkeletonBarCandidate(bar(5, { w: 60 })), "must be >60px wide");
  assert(!isSkeletonBarCandidate(bar(5, { h: 60 })), "60px tall is a block, not a bar");
  assert(!isSkeletonBarCandidate(bar(5, { w: 70, h: 40 })), "w < 2h is a chip/card, not a bar");
  assert(!isSkeletonBarCandidate(bar(5, { text: "Price" })), "own text disqualifies");
  assert(!isSkeletonBarCandidate(bar(5, { hasTextDesc: true })), "text descendants disqualify");
  assert(!isSkeletonBarCandidate(bar(5, { radius: 0 })), "square rect is not the skeleton look");
  assert(!isSkeletonBarCandidate(bar(5, { hasBgImage: true })), "gradient fill is not FLAT");
  assert(!isSkeletonBarCandidate(bar(5, { bg: "rgba(209, 213, 219, 0.3)" })), "translucent is not flat");
  assert(!isSkeletonBarCandidate(bar(5, { bg: "rgb(232, 0, 132)" })), "brand accent is not grey");
  assert(!isSkeletonBarCandidate(bar(5, { bg: "rgb(250, 250, 250)" })), "near-white paper is out of the grey band");
  assert(!isSkeletonBarCandidate(bar(5, { bg: "rgb(30, 30, 32)" })), "near-black surface is out of the grey band");
  assert(!isSkeletonBarCandidate(bar(5, { opacity: 0.02 })), "invisible never counts");
  assert(!isSkeletonBarCandidate(bar(-1)), "no recorded parent → never a candidate");
  assert(!isSkeletonBarCandidate(bar(5, { parentIx: undefined })), "older fixtures without parentIx fail open");
});

check("three sibling bars = ONE row → advisory finding naming the piece", () => {
  const f = findSkeletonBars(scene([bar(5), bar(5), bar(5)]));
  assert(f.length === 1, `one finding, got ${f.length}`);
  assert(f[0].kind === "skeleton-bars" && f[0].pieceId === "s3.hero", "kind + piece");
  assert(f[0].blocking === false, "single row is ADVISORY");
  assert(f[0].rows === 1 && f[0].bars === 3, `1 row / 3 bars, got ${f[0].rows}/${f[0].bars}`);
  assert(/loading-skeleton/.test(f[0].detail), "detail names the class");
  assert(/REAL rendered content/.test(f[0].repairInstruction), "repair demands real content");
});

check(`${SKELETON_BLOCKING_MIN_ROWS} rows in one piece → BLOCKING`, () => {
  const f = findSkeletonBars(scene([bar(5), bar(5), bar(5), bar(9), bar(9), bar(9)]));
  assert(f.length === 1 && f[0].rows === 2 && f[0].bars === 6, `merged piece finding, got ${JSON.stringify(f)}`);
  assert(f[0].blocking === true, "two rows must block");
});

check("two sibling bars never fire; three bars under DIFFERENT parents never fire (cycle-4 s3's real shape)", () => {
  assert(findSkeletonBars(scene([bar(5), bar(5)])).length === 0, `pairs stay silent (row floor ${SKELETON_ROW_MIN_BARS})`);
  assert(findSkeletonBars(scene([bar(4), bar(7), bar(11)])).length === 0, "scattered singletons stay silent");
});

check("rows in different pieces stay separate advisories — no cross-piece blocking", () => {
  const f = findSkeletonBars(scene([
    bar(5), bar(5), bar(5),
    bar(9, { piece: "s3.copy" }), bar(9, { piece: "s3.copy" }), bar(9, { piece: "s3.copy" }),
  ]));
  assert(f.length === 2, `two per-piece findings, got ${f.length}`);
  assert(f.every((x) => x.blocking === false && x.rows === 1), `each advisory, got ${JSON.stringify(f.map((x) => x.blocking))}`);
});

check("errored scenes return nothing; real-content rows (text-bearing) never fire", () => {
  assert(findSkeletonBars(scene([bar(5), bar(5), bar(5)], { error: "measure: boom" })).length === 0, "errored scene skipped");
  const real = [bar(5, { hasTextDesc: true }), bar(5, { hasTextDesc: true }), bar(5, { hasTextDesc: true })];
  assert(findSkeletonBars(scene(real)).length === 0, "rows carrying real text are content, not skeleton");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
