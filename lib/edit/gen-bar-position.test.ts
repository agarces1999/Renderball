/**
 * Placement of the marquee's generate prompt bar.
 *
 * The bar used to always sit BELOW the drawn box, which reads as a detached
 * toolbar rather than as the box asking what belongs in it. It now goes inside
 * whenever the box can hold it, and only falls outside when the box is too
 * small — so both branches are pinned here rather than eyeballed once.
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

  check("a box too NARROW falls outside, below", () => {
    const box = { left: 100, top: 100, width: 300, height: 500 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "300px wide cannot hold a 560px bar");
    assert(p.top === 100 + 500 + 8, `should sit under the box, got ${p.top}`);
  });

  check("a box too SHORT falls outside, below", () => {
    const box = { left: 100, top: 100, width: 900, height: 50 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "50px tall cannot hold a 40px bar with padding");
    assert(p.top === 100 + 50 + 8, `should sit under the box, got ${p.top}`);
  });

  check("a small box near the BOTTOM flips the bar above it", () => {
    const box = { left: 100, top: 700, width: 300, height: 80 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "too narrow to hold the bar");
    assert(p.top < box.top, `must flip above the box, got ${p.top} vs box top ${box.top}`);
  });

  check("a small box near the RIGHT edge clamps so the bar stays on canvas", () => {
    const box = { left: 1100, top: 100, width: 80, height: 80 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "tiny box");
    assert(p.left + BAR_W <= 1200, `bar must not overflow the canvas, got right edge ${p.left + BAR_W}`);
  });

  check("exactly at the fit threshold, the bar goes inside", () => {
    const box = { left: 0, top: 0, width: BAR_W + 28, height: BAR_H + 28 };
    const p = genBarPosition(box, 1200, 800);
    assert(p.inside, "a box exactly big enough must count as fitting");
  });

  check("one pixel under the threshold, it goes outside", () => {
    const box = { left: 0, top: 0, width: BAR_W + 27, height: BAR_H + 28 };
    const p = genBarPosition(box, 1200, 800);
    assert(!p.inside, "a box one pixel too narrow must fall outside");
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

run();
