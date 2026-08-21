/**
 * Placement of the marquee's generate controls.
 *
 * The bar used to always sit BELOW the drawn box, which reads as a detached
 * toolbar rather than as the box asking what belongs in it. It now goes inside
 * whenever the box can hold it.
 *
 * "Can hold it" used to mean one fixed 560×40 row, so inside effectively meant
 * "boxes wider than 588px" — an ordinary tall-narrow box still got the detached
 * bar, and near the canvas edge that bar was clamped across its neighbours
 * (founder screenshot, 2026-08-21: a ~480px-wide box, controls outside and
 * running off the right edge with Cancel cut in half). A stacked shape now
 * covers the narrow case with the identical controls. Every branch is pinned
 * here rather than eyeballed once.
 */
import { genBarPosition } from "../../app/preview/[id]/ElementEditor";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const BAR_W = 560;
const BAR_H = 40;

const run = () => {
  console.log("gen-bar-position");

  check("a roomy box holds the bar INSIDE, centred both ways", () => {
    const box = { left: 100, top: 100, width: 900, height: 500 };
    const p = genBarPosition(box, 1200, 800);
    assert(p.inside, "a 900×500 box must hold a 560×40 bar");
    assert(p.left === 100 + (900 - BAR_W) / 2, `left centred, got ${p.left}`);
    assert(p.top === 100 + (500 - BAR_H) / 2, `top centred, got ${p.top}`);
    // and it must actually be within the box
    assert(p.left >= box.left && p.left + BAR_W <= box.left + box.width, "bar escapes horizontally");
    assert(p.top >= box.top && p.top + BAR_H <= box.top + box.height, "bar escapes vertically");
  });

  check("a NARROW but tall box now holds the controls inside, stacked", () => {
    const box = { left: 100, top: 100, width: 300, height: 500 };
    const p = genBarPosition(box, 1200, 800);
    assert(p.inside && p.layout === "stack", `expected stacked inside, got ${p.layout}`);
    assert(p.width <= 300 - 20, `panel must fit the box with padding, got ${p.width}`);
    assert(p.left >= box.left && p.left + p.width <= box.left + box.width, "panel escapes horizontally");
    assert(p.top >= box.top && p.top + 116 <= box.top + box.height, "panel escapes vertically");
  });

  check("the founder's box (~480×590) is inside, not clamped off-canvas", () => {
    // The reported case: controls sat outside and ran off the right edge.
    const box = { left: 447, top: 128, width: 482, height: 590 };
    const p = genBarPosition(box, 1256, 978);
    assert(p.inside, "a 482×590 box must hold the controls");
    assert(p.left + p.width <= 1256, "controls must not overflow the canvas");
  });

  check("a box too SHORT for even the stack falls outside, below", () => {
    const box = { left: 100, top: 100, width: 300, height: 90 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside && p.layout === "outside", `expected outside, got ${p.layout}`);
    assert(p.top === 100 + 90 + 8, `should sit under the box, got ${p.top}`);
  });

  check("a WIDE but flat box falls outside, below", () => {
    const box = { left: 100, top: 100, width: 900, height: 50 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "50px tall cannot hold a 40px bar with padding");
    assert(p.top === 100 + 50 + 8, `should sit under the box, got ${p.top}`);
  });

  check("a small box near the BOTTOM flips the bar above it", () => {
    const box = { left: 100, top: 700, width: 200, height: 80 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "too small to hold even the stacked panel");
    assert(p.top < box.top, `must flip above the box, got ${p.top} vs box top ${box.top}`);
  });

  check("a small box near the RIGHT edge clamps so the bar stays on canvas", () => {
    const box = { left: 1100, top: 100, width: 80, height: 80 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "tiny box");
    assert(p.left + BAR_W <= 1200, `bar must not overflow the canvas, got right edge ${p.left + BAR_W}`);
  });

  check("exactly at the row threshold, the bar goes inside as a row", () => {
    const box = { left: 0, top: 0, width: BAR_W + 28, height: BAR_H + 28 };
    const p = genBarPosition(box, 1200, 800);
    assert(p.inside && p.layout === "row", `expected a row, got ${p.layout}`);
  });

  check("one pixel too narrow for the row degrades to the stack when the box is tall enough", () => {
    const p = genBarPosition({ left: 0, top: 0, width: BAR_W + 27, height: 200 }, 1200, 800);
    assert(p.inside && p.layout === "stack", `expected the stack, got ${p.layout}`);
  });

  check("one pixel too narrow for the row AND too short for the stack goes outside", () => {
    // 587×68 holds neither shape — the honest fallback, not a silent squeeze.
    const p = genBarPosition({ left: 0, top: 0, width: BAR_W + 27, height: BAR_H + 28 }, 1200, 800);
    assert(!p.inside && p.layout === "outside", `expected outside, got ${p.layout}`);
  });

  check("exactly at the stack threshold it is inside; one pixel under it is outside", () => {
    const fits = genBarPosition({ left: 0, top: 0, width: 232 + 20, height: 116 + 20 }, 1200, 800);
    assert(fits.inside && fits.layout === "stack", `threshold must fit: ${fits.layout}`);
    const misses = genBarPosition({ left: 0, top: 0, width: 232 + 19, height: 116 + 20 }, 1200, 800);
    assert(!misses.inside, "one pixel too narrow for the stack must fall outside");
  });

  check("the stacked panel never grows past its cap in a very wide-but-short box", () => {
    const box = { left: 0, top: 0, width: 540, height: 140 };
    const p = genBarPosition(box, 1200, 800);
    assert(p.layout === "stack", `expected the stack, got ${p.layout}`);
    assert(p.width === 320, `panel should cap at 320, got ${p.width}`);
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

run();
