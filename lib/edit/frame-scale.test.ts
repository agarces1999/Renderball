//
// Host-side slide fitting.
//
// This replaces a `fit()` script that ran INSIDE the scene document. Two shipped bugs
// came from that arrangement and both are really the same one — the scale was a fact
// the editor had to discover from a document it does not own:
//
//   * unmeasurable → fell back to 1 → every drawn box came out roughly half size;
//   * the morph path's ancestor sync copied a transform-less style onto the live
//     canvas → the slide snapped to 1:1 → "everything expanded again".
//
// So the tests below care most about the round trip (a point must survive
// host→canvas→host unchanged) and about NULL — refusing to answer when no honest
// answer exists is the whole point, and returning 1 is what caused the damage.
//
import { fitFrame, hostToCanvas, canvasToHost, hostScaleEnabled } from "./frame-scale";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log("\n▶ frame-scale");

const CANVAS = { w: 1920, h: 1080 };

check("a WIDER container letterboxes left/right, never distorts", () => {
  const f = fitFrame({ w: 2000, h: 1080 }, CANVAS)!;
  assert(near(f.scale, 1), `scale should be height-limited at 1, got ${f.scale}`);
  assert(near(f.left, 40) && near(f.top, 0), `expected 40px pillarbox, got ${f.left}/${f.top}`);
});

check("a TALLER container letterboxes top/bottom", () => {
  const f = fitFrame({ w: 1920, h: 1200 }, CANVAS)!;
  assert(near(f.scale, 1), `got ${f.scale}`);
  assert(near(f.top, 60) && near(f.left, 0), `expected 60px letterbox, got ${f.left}/${f.top}`);
});

check("the editor's real case: a 1000px-wide frame scales down, does not snap to 1:1", () => {
  // The exact shape of the "everything expanded" bug: a 1920 canvas in a ~1000 frame.
  const f = fitFrame({ w: 1000, h: 563 }, CANVAS)!;
  assert(f.scale < 1, `must scale DOWN, got ${f.scale}`);
  assert(near(f.scale, 1000 / 1920, 1e-6), `expected width-limited ${1000 / 1920}, got ${f.scale}`);
  assert(f.width <= 1000 + 1e-9 && f.height <= 563 + 1e-9, `overflows: ${f.width}x${f.height}`);
});

check("ROUND TRIP: a host point survives host → canvas → host", () => {
  const f = fitFrame({ w: 1000, h: 700 }, CANVAS)!;
  for (const p of [{ x: 0, y: 0 }, { x: 500, y: 350 }, { x: 999, y: 699 }, { x: 123.4, y: 456.7 }]) {
    const c = hostToCanvas(p, f)!;
    const back = canvasToHost(c, f)!;
    assert(near(back.x, p.x, 1e-9) && near(back.y, p.y, 1e-9), `drifted: ${JSON.stringify({ p, c, back })}`);
  }
});

check("the canvas ORIGIN maps to the letterbox corner, not to (0,0)", () => {
  // Getting this wrong is how a drawn box lands offset from where the user drew it.
  const f = fitFrame({ w: 2000, h: 1080 }, CANVAS)!;
  const origin = canvasToHost({ x: 0, y: 0 }, f)!;
  assert(near(origin.x, 40) && near(origin.y, 0), `origin should sit at the pillarbox: ${JSON.stringify(origin)}`);
});

check("a full-canvas box maps to the full rendered frame", () => {
  const f = fitFrame({ w: 1000, h: 563 }, CANVAS)!;
  const tl = canvasToHost({ x: 0, y: 0 }, f)!;
  const br = canvasToHost({ x: CANVAS.w, y: CANVAS.h }, f)!;
  assert(near(br.x - tl.x, f.width, 1e-9), `width mismatch: ${br.x - tl.x} vs ${f.width}`);
  assert(near(br.y - tl.y, f.height, 1e-9), `height mismatch: ${br.y - tl.y} vs ${f.height}`);
});

check("an un-laid-out container returns NULL, never a scale of 1", () => {
  // The fallback-to-1 that halved every drawn box. Null is the contract.
  for (const c of [{ w: 0, h: 0 }, { w: 0, h: 500 }, { w: 500, h: 0 }, { w: -10, h: 100 }, { w: NaN, h: 100 }]) {
    assert(fitFrame(c, CANVAS) === null, `should be null for ${JSON.stringify(c)}`);
  }
});

check("a zero-size canvas returns NULL too", () => {
  assert(fitFrame({ w: 1000, h: 500 }, { w: 0, h: 0 }) === null, "should be null");
});

check("the coordinate helpers propagate NULL rather than inventing a point", () => {
  assert(hostToCanvas({ x: 10, y: 10 }, null) === null, "hostToCanvas must not guess");
  assert(canvasToHost({ x: 10, y: 10 }, null) === null, "canvasToHost must not guess");
});

check("portrait canvases fit too (9:16 decks)", () => {
  const f = fitFrame({ w: 1000, h: 700 }, { w: 1080, h: 1920 })!;
  assert(near(f.scale, 700 / 1920, 1e-6), `should be height-limited, got ${f.scale}`);
  assert(f.width <= 1000 && f.height <= 700, `overflows: ${f.width}x${f.height}`);
});

check("an EXACT-fit container has zero letterbox — the headless export case", () => {
  // export-static drives this at exactly canvas size; scale must be exactly 1 and the
  // frame must sit at the origin, or every exported PNG shifts.
  const f = fitFrame({ w: 1920, h: 1080 }, CANVAS)!;
  assert(f.scale === 1 && f.left === 0 && f.top === 0, JSON.stringify(f));
});

check("the seam is OFF by default — the shipped path is untouched", () => {
  // Turning this on changes what the editor, the preview and the share viewer render.
  // Until all three scale the frame themselves, the scene document must keep doing it.
  assert(hostScaleEnabled({}) === false, "must default OFF");
  assert(hostScaleEnabled({ RB_HOST_SCALE: "" }) === false, "empty is OFF");
  assert(hostScaleEnabled({ RB_HOST_SCALE: "off" }) === false, "off is OFF");
  assert(hostScaleEnabled({ RB_HOST_SCALE: "nonsense" }) === false, "unknown is OFF");
});

check("the seam turns on for the affirmative spellings only", () => {
  for (const v of ["on", "1", "true", "yes", "ON", " On "]) {
    assert(hostScaleEnabled({ RB_HOST_SCALE: v }) === true, `expected ON for ${JSON.stringify(v)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
