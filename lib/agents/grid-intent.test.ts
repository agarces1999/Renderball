/**
 * Tests for grid-intent — arm B of the P2 layout bake-off. Run:
 * `node scripts/run-tests.mjs lib/agents/grid-intent.test.ts` (no API key).
 *
 * These lock the three pieces the bake-off's numbers stand on, because a bug in
 * any of them would silently manufacture the result:
 *   (a) area → pixel conversion (the deterministic half of arm B — if it drifts,
 *       both arms stop being scored on the same geometry),
 *   (b) the ASCII parser's INVALID-DECLARATION rules — the non-rectangular area
 *       and the wrong-row-length case are the failure-rate metric itself, so a
 *       parser that quietly accepted them would report a fake 0% failure rate,
 *   (c) the maximal-rectangle void metric, checked against rectangles whose
 *       largest hole is known by hand.
 *
 * Containment is re-derived here against layout-composer's OWN constants rather
 * than asserted against grid-intent's, so the module cannot vouch for itself on
 * the one property the bake-off treats as a structural gimme.
 */
import {
  GRID,
  SAFE,
  CELL,
  GUTTER,
  areaToBounds,
  parseGridAscii,
  gridSceneToComposition,
  largestVoidCells,
  voidFraction,
  buildGridWorkedExample,
  type Aspect,
  type AreaRect,
} from "./grid-intent";
import { CANVAS, BOTTOM_SAFE_FRAC } from "./layout-composer";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

/** Build an ASCII block by painting rectangles, so a test's INPUT is never the
 *  thing under test. */
const draw = (aspect: Aspect, rects: { ch: string; r: AreaRect }[]): string[] => {
  const { cols, rows } = GRID[aspect];
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const hit = rects.find((x) => c >= x.r.c0 && c <= x.r.c1 && r >= x.r.r0 && r <= x.r.r1);
      line += hit ? hit.ch : ".";
    }
    lines.push(line);
  }
  return lines;
};

// ─── (a) The lattice + area → pixel conversion ──────────────────────────────

check("lattice: cells are SQUARE on every aspect, and the grid tiles the safe area exactly", () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = GRID[aspect];
    const safe = SAFE[aspect];
    assert(cols * CELL === safe.w, `${aspect}: ${cols}×${CELL} ≠ safe width ${safe.w}`);
    assert(rows * CELL === safe.h, `${aspect}: ${rows}×${CELL} ≠ safe height ${safe.h}`);
  }
  // The plan's headline number.
  assert(GRID["16:9"].cols === 32 && GRID["16:9"].rows === 18, "16:9 must be the plan's 32×18");
});

check("areaToBounds: a single cell lands at the right pixel, inset by the gutter", () => {
  const b = areaToBounds({ c0: 0, r0: 0, c1: 0, r1: 0 }, "16:9");
  const safe = SAFE["16:9"];
  assert(b.x === safe.x + GUTTER / 2, `x ${b.x}`);
  assert(b.y === safe.y + GUTTER / 2, `y ${b.y}`);
  assert(b.w === CELL - GUTTER && b.h === CELL - GUTTER, `size ${b.w}×${b.h}`);
});

check("areaToBounds: colSpan:rowSpan IS the aspect ratio (square cells, equal gutter)", () => {
  // A 16-wide × 9-tall area must come out 16:9 once the equal gutter is added back.
  const b = areaToBounds({ c0: 2, r0: 2, c1: 17, r1: 10 }, "16:9");
  const ratio = (b.w + GUTTER) / (b.h + GUTTER);
  assert(Math.abs(ratio - 16 / 9) < 1e-9, `expected 16:9, got ${ratio}`);
});

check("areaToBounds: adjacent areas never overlap (disjointness is structural)", () => {
  const left = areaToBounds({ c0: 0, r0: 0, c1: 15, r1: 17 }, "16:9");
  const right = areaToBounds({ c0: 16, r0: 0, c1: 31, r1: 17 }, "16:9");
  assert(left.x + left.w <= right.x, `left ends ${left.x + left.w}, right starts ${right.x}`);
});

check("areaToBounds: every non-full-grid area is contained AND clears the bottom reserve", () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = GRID[aspect];
    const { w: W, h: H } = CANVAS[aspect];
    // The worst case for each contract: the full-width, full-height-minus-one
    // area (full-grid would snap to canvas), and the bottom-row strip.
    const cases: AreaRect[] = [
      { c0: 0, r0: 0, c1: cols - 1, r1: rows - 2 },
      { c0: 0, r0: rows - 1, c1: cols - 1, r1: rows - 1 },
      { c0: cols - 1, r0: rows - 1, c1: cols - 1, r1: rows - 1 },
    ];
    for (const rect of cases) {
      const b = areaToBounds(rect, aspect);
      assert(b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H, `${aspect} ${JSON.stringify(b)} escapes ${W}×${H}`);
      assert(b.y + b.h <= BOTTOM_SAFE_FRAC * H, `${aspect} ${JSON.stringify(b)} crosses the bottom reserve ${BOTTOM_SAFE_FRAC * H}`);
    }
  }
});

check("areaToBounds: an area spanning the WHOLE grid snaps to the full canvas (a treatment bleeds)", () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = GRID[aspect];
    const { w: W, h: H } = CANVAS[aspect];
    const b = areaToBounds({ c0: 0, r0: 0, c1: cols - 1, r1: rows - 1 }, aspect);
    assert(b.x === 0 && b.y === 0 && b.w === W && b.h === H, `${aspect}: ${JSON.stringify(b)}`);
    // …and it must clear layout-composer's full-bleed threshold, which is the
    // whole reason the snap exists.
    assert(b.w * b.h >= 0.85 * W * H, `${aspect}: snapped treatment must read as full-bleed`);
  }
});

// ─── (b) The ASCII parser — the failure-rate metric itself ──────────────────

check("parseGridAscii: a well-formed two-area block parses to the right rectangles", () => {
  const grid = draw("16:9", [
    { ch: "H", r: { c0: 16, r0: 2, c1: 29, r1: 15 } },
    { ch: "C", r: { c0: 2, r0: 5, c1: 12, r1: 12 } },
  ]);
  const { areas, errors } = parseGridAscii(grid, "16:9");
  assert(errors.length === 0, `unexpected errors: ${errors.join(" | ")}`);
  assert(areas.size === 2, `expected 2 areas, got ${areas.size}`);
  assert(JSON.stringify(areas.get("H")) === JSON.stringify({ c0: 16, r0: 2, c1: 29, r1: 15 }), `H ${JSON.stringify(areas.get("H"))}`);
});

check("parseGridAscii: a NON-RECTANGULAR named area is an INVALID declaration", () => {
  // An L-shape: bbox is 4×4 but only 12 of the 16 cells are filled.
  const grid = draw("16:9", [
    { ch: "H", r: { c0: 4, r0: 4, c1: 7, r1: 7 } },
  ]);
  const rows = [...grid];
  rows[4] = rows[4].slice(0, 6) + ".." + rows[4].slice(8); // punch the top-right corner out
  rows[5] = rows[5].slice(0, 6) + ".." + rows[5].slice(8);
  const { areas, errors } = parseGridAscii(rows, "16:9");
  assert(errors.length === 1, `expected exactly 1 error, got ${errors.length}: ${errors.join(" | ")}`);
  assert(errors[0].includes("not a solid rectangle"), `wrong message: ${errors[0]}`);
  assert(areas.size === 0, "an invalid grid must yield no areas");
});

check("parseGridAscii: a WRONG-ROW-LENGTH row is an INVALID declaration, and names the row", () => {
  const grid = draw("16:9", [{ ch: "H", r: { c0: 4, r0: 4, c1: 7, r1: 7 } }]);
  grid[3] = grid[3].slice(0, 31); // one character short
  const { areas, errors } = parseGridAscii(grid, "16:9");
  assert(errors.some((e) => e.includes("row 3") && e.includes("31 characters")), `expected a row-3 length error, got: ${errors.join(" | ")}`);
  assert(areas.size === 0, "an invalid grid must yield no areas");
});

check("parseGridAscii: a WRONG-ROW-COUNT block is an INVALID declaration", () => {
  const grid = draw("16:9", [{ ch: "H", r: { c0: 4, r0: 4, c1: 7, r1: 7 } }]).slice(0, 17);
  const { errors } = parseGridAscii(grid, "16:9");
  assert(errors.some((e) => e.includes("17 rows")), `expected a row-count error, got: ${errors.join(" | ")}`);
});

check("parseGridAscii: an all-null grid declares nothing and is rejected", () => {
  const { errors } = parseGridAscii(draw("16:9", []), "16:9");
  assert(errors.some((e) => e.includes("no areas at all")), `got: ${errors.join(" | ")}`);
});

check("parseGridAscii: a DECLARED over-layer may punch a hole without breaking the area beneath", () => {
  // A full-grid hero with a copy card cut out of its middle. Without the
  // layers declaration the hero is non-rectangular; with it, both are valid.
  const { cols, rows } = GRID["16:9"];
  const grid = draw("16:9", [
    { ch: "C", r: { c0: 2, r0: 11, c1: 12, r1: 15 } },
    { ch: "H", r: { c0: 0, r0: 0, c1: cols - 1, r1: rows - 1 } },
  ]);
  const bare = parseGridAscii(grid, "16:9");
  assert(bare.errors.some((e) => e.includes("not a solid rectangle")), "undeclared hole must be invalid");

  const declared = parseGridAscii(grid, "16:9", ["C"]);
  assert(declared.errors.length === 0, `declared over-layer must be valid: ${declared.errors.join(" | ")}`);
  assert(declared.areas.get("H")!.c1 === cols - 1 && declared.areas.get("H")!.r1 === rows - 1, "hero must still span the grid");
});

check("gridSceneToComposition: a valid scene yields pixel bounds on every non-atmosphere element", () => {
  const grid = draw("16:9", [
    { ch: "H", r: { c0: 16, r0: 2, c1: 29, r1: 15 } },
    { ch: "C", r: { c0: 2, r0: 5, c1: 12, r1: 12 } },
  ]);
  const { composition, errors } = gridSceneToComposition(
    {
      grid,
      elements: [
        { role: "hero", subject: "a dashboard", area: "H", focalRank: 1, interior: ["a", "b"], ownsCopy: [] },
        { role: "copy", subject: "the stack", area: "C", focalRank: 2, interior: ["c"], ownsCopy: ["headline"] },
        { role: "atmosphere", subject: "a field", interior: ["glow"], ownsCopy: [] },
      ],
      atmosphere: "a wash",
      budget: { brandMark: "chrome", cta: "hero" },
    },
    "16:9",
  );
  assert(errors.length === 0, `errors: ${errors.join(" | ")}`);
  const els = composition!.elements;
  assert(!!els.find((e) => e.role === "hero")!.bounds, "hero must carry bounds");
  assert(!els.find((e) => e.role === "atmosphere")!.bounds, "atmosphere must carry NO bounds (full-bleed)");
  assert(els.find((e) => e.role === "copy")!.ownsCopy!.includes("headline"), "ownsCopy must survive");
});

check("gridSceneToComposition: claiming an area the grid never draws is an error", () => {
  const grid = draw("16:9", [{ ch: "H", r: { c0: 16, r0: 2, c1: 29, r1: 15 } }]);
  const { composition, errors } = gridSceneToComposition(
    { grid, elements: [{ role: "hero", subject: "x", area: "Z", interior: [] }], atmosphere: "a" },
    "16:9",
  );
  assert(composition === null, "must not compose");
  assert(errors.some((e) => e.includes('claims area "Z"')), `got: ${errors.join(" | ")}`);
});

check("gridSceneToComposition: an area nobody claims is an error (silent reserved territory)", () => {
  const grid = draw("16:9", [
    { ch: "H", r: { c0: 16, r0: 2, c1: 29, r1: 15 } },
    { ch: "C", r: { c0: 2, r0: 5, c1: 12, r1: 12 } },
  ]);
  const { errors } = gridSceneToComposition(
    { grid, elements: [{ role: "hero", subject: "x", area: "H", interior: [] }], atmosphere: "a" },
    "16:9",
  );
  assert(errors.some((e) => e.includes('area "C" is drawn')), `got: ${errors.join(" | ")}`);
});

check("the arm-B worked example is itself VALID at every aspect (the exemplar must pass its own contract)", () => {
  for (const aspect of ASPECTS) {
    const parsedExample = JSON.parse(buildGridWorkedExample(aspect)) as { grid: string[]; layers: unknown[] }[];
    const { errors } = parseGridAscii(parsedExample[0].grid, aspect);
    assert(errors.length === 0, `${aspect}: ${errors.join(" | ")}`);
  }
});

// ─── (c) The void metric ────────────────────────────────────────────────────

/** occupancy from a string picture — "#" occupied, "." free. */
const bitmap = (picture: string[]): boolean[][] => picture.map((row) => [...row].map((c) => c === "#"));

check("largestVoidCells: an all-free matrix is one big void", () => {
  const m = bitmap(["....", "....", "...."]);
  assert(largestVoidCells(m, 4, 3) === 12, `got ${largestVoidCells(m, 4, 3)}`);
});

check("largestVoidCells: an all-occupied matrix has no void", () => {
  const m = bitmap(["####", "####"]);
  assert(largestVoidCells(m, 4, 2) === 0, `got ${largestVoidCells(m, 4, 2)}`);
});

check("largestVoidCells: finds the largest RECTANGLE, not the largest connected blob", () => {
  // The free cells form an 8-cell L. The biggest RECTANGLE inside it is 2×3 = 6.
  const m = bitmap([
    "..###",
    "..###",
    "..#..",
    "#####",
  ]);
  assert(largestVoidCells(m, 5, 4) === 6, `expected 6, got ${largestVoidCells(m, 5, 4)}`);
});

check("largestVoidCells: a wide short band beats a tall thin one when it is larger", () => {
  const m = bitmap([
    ".....",
    ".....",
    "#####",
    "#..##",
    "#..##",
    "#..##",
  ]);
  // Top band 5×2 = 10; the thin column is 2×3 = 6.
  assert(largestVoidCells(m, 5, 6) === 10, `expected 10, got ${largestVoidCells(m, 5, 6)}`);
});

check("voidFraction: a frame painted edge to edge has ~zero void; an empty frame has all of it", () => {
  const { w: W, h: H } = CANVAS["16:9"];
  const full = voidFraction([{ x: 0, y: 0, w: W, h: H }], "16:9");
  assert(full.fraction === 0, `full-bleed void ${full.fraction}`);
  const empty = voidFraction([], "16:9");
  assert(empty.fraction === 1, `empty void ${empty.fraction}`);
});

check("voidFraction: a half-frame hero leaves ~half the safe area as the largest void", () => {
  const safe = SAFE["16:9"];
  const { cols, rows } = GRID["16:9"];
  // Paint the left 16 of 32 columns.
  const v = voidFraction([{ x: safe.x, y: safe.y, w: 16 * CELL, h: safe.h }], "16:9");
  assert(v.cells === 16 * rows, `expected ${16 * rows} free cells, got ${v.cells}`);
  assert(Math.abs(v.fraction - 0.5) < 1e-9, `expected 0.5, got ${v.fraction}`);
  assert(v.totalCells === cols * rows, `totalCells ${v.totalCells}`);
});

check("voidFraction: the metric is the LARGEST HOLE, not total emptiness", () => {
  const safe = SAFE["16:9"];
  // Two 8-column bands with an 8-column hole between them and 8 columns after.
  const a = { x: safe.x, y: safe.y, w: 8 * CELL, h: safe.h };
  const b = { x: safe.x + 16 * CELL, y: safe.y, w: 8 * CELL, h: safe.h };
  const v = voidFraction([a, b], "16:9");
  // Total free = 16 of 32 columns (0.5), but the largest CONTIGUOUS hole is 8.
  assert(Math.abs(v.fraction - 0.25) < 1e-9, `expected 0.25 (largest hole), got ${v.fraction}`);
});

for (const { name, fn } of checks) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
