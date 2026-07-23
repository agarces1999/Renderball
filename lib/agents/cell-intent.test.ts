/**
 * Tests for cell-intent — arm C of the P2 layout bake-off. Run:
 * `node scripts/run-tests.mjs lib/agents/cell-intent.test.ts` (no API key).
 *
 * Arm C's entire claim is that the SAME lattice, stated as integers instead of
 * drawn as ASCII, parses reliably. That claim is only meaningful if the parser
 * genuinely rejects what it says it rejects — a permissive parser would report a
 * fake 0% format-failure rate and "prove" the hypothesis by not looking. So
 * these lock, in order of what could fabricate the result:
 *
 *   (a) THE REJECTIONS — out-of-range spans, non-integers, missing coordinates,
 *       and undeclared overlap. Undeclared overlap matters most: arm B got
 *       cell-ownership uniqueness free by construction, so if arm C silently
 *       accepted overlap it would be scored on a WEAKER contract than the arm it
 *       is being compared against.
 *   (b) CELLS → PIXELS, including the full-grid full-bleed snap, asserted to be
 *       IDENTICAL to what arm B's converter produces for the same block — if the
 *       two discrete arms disagreed on geometry they would not be comparable.
 *   (c) The prompt's own worked example parses clean at every aspect (the "an
 *       exemplar must pass its advertised validator" rule).
 */
import {
  cellRectToArea,
  rectsOverlap,
  parseCellRect,
  cellSceneToComposition,
  classifyCellError,
  buildCellWorkedExample,
  type CellRect,
} from "./cell-intent";
import { GRID, SAFE, CELL, GUTTER, areaToBounds, type Aspect } from "./grid-intent";
import { CANVAS } from "./layout-composer";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

/** A minimal well-formed element, so a test's INPUT is never the thing under
 *  test beyond the one field it perturbs. */
const el = (role: string, rect: Partial<CellRect>, extra: Record<string, unknown> = {}) => ({
  role,
  subject: `the ${role}`,
  interior: [],
  ownsCopy: [],
  ...rect,
  ...extra,
});

// ─── (b) cells → pixels ─────────────────────────────────────────────────────

check("cellRectToArea: start+span becomes the inclusive corner rect", () => {
  const a = cellRectToArea({ colStart: 4, colSpan: 6, rowStart: 2, rowSpan: 3 });
  assert(a.c0 === 4 && a.c1 === 9, `columns ${a.c0}…${a.c1}, expected 4…9`);
  assert(a.r0 === 2 && a.r1 === 4, `rows ${a.r0}…${a.r1}, expected 2…4`);
});

check("cells → pixels lands EXACTLY where arm B's ASCII lands for the same block", () => {
  for (const aspect of ASPECTS) {
    const rect: CellRect = { colStart: 3, colSpan: 8, rowStart: 2, rowSpan: 5 };
    const viaCells = areaToBounds(cellRectToArea(rect), aspect);
    // The corner rect arm B's parser would derive from the same painted cells.
    const viaGrid = areaToBounds({ c0: 3, c1: 10, r0: 2, r1: 6 }, aspect);
    assert(
      JSON.stringify(viaCells) === JSON.stringify(viaGrid),
      `${aspect}: cells ${JSON.stringify(viaCells)} ≠ grid ${JSON.stringify(viaGrid)}`,
    );
    // And re-derived independently from the lattice constants, so the shared
    // converter cannot vouch for itself.
    const safe = SAFE[aspect];
    assert(viaCells.x === Math.round(safe.x + 3 * CELL + GUTTER / 2), `${aspect}: x ${viaCells.x}`);
    assert(viaCells.w === Math.round(8 * CELL - GUTTER), `${aspect}: w ${viaCells.w}`);
  }
});

check("a block spanning the WHOLE lattice snaps to the full canvas (full-bleed)", () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = GRID[aspect];
    const b = areaToBounds(
      cellRectToArea({ colStart: 0, colSpan: cols, rowStart: 0, rowSpan: rows }),
      aspect,
    );
    assert(b.x === 0 && b.y === 0, `${aspect}: origin ${b.x},${b.y}`);
    assert(b.w === CANVAS[aspect].w && b.h === CANVAS[aspect].h, `${aspect}: ${b.w}×${b.h}`);
  }
});

// ─── (a) the rejections ─────────────────────────────────────────────────────

check("in-range integers parse clean at every aspect", () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = GRID[aspect];
    const r = parseCellRect(
      { colStart: 0, colSpan: cols, rowStart: 0, rowSpan: rows },
      aspect,
      "element",
    );
    assert(r.errors.length === 0, `${aspect}: ${r.errors.join(" ")}`);
    assert(r.rect !== null, `${aspect}: no rect`);
  }
});

check("a colSpan running off the right edge is REJECTED", () => {
  const { cols } = GRID["16:9"];
  const r = parseCellRect(
    { colStart: cols - 4, colSpan: 8, rowStart: 0, rowSpan: 4 },
    "16:9",
    "element \"hero\"",
  );
  assert(r.rect === null, "an out-of-range block must not produce a rect");
  assert(
    r.errors.some((e) => /runs off the lattice/.test(e) && e.includes(`≤ ${cols}`)),
    `expected an off-lattice error naming the ceiling, got: ${r.errors.join(" ")}`,
  );
  assert(classifyCellError(r.errors[0]) === "out-of-range", "classified wrong");
});

check("a rowSpan running off the bottom edge is REJECTED", () => {
  const { rows } = GRID["16:9"];
  const r = parseCellRect({ colStart: 0, colSpan: 4, rowStart: rows - 1, rowSpan: 3 }, "16:9", "element");
  assert(r.rect === null, "an out-of-range block must not produce a rect");
  assert(r.errors.some((e) => /rows .* runs off the lattice/.test(e)), r.errors.join(" "));
});

check("a NEGATIVE start is REJECTED (0-based lattice, no wraparound)", () => {
  const r = parseCellRect({ colStart: -2, colSpan: 4, rowStart: 0, rowSpan: 4 }, "16:9", "element");
  assert(r.rect === null, "a negative start must not produce a rect");
  assert(r.errors.some((e) => /0-based/.test(e)), r.errors.join(" "));
});

check("a ZERO or negative span is REJECTED (a span is a count, never 0)", () => {
  for (const bad of [0, -3]) {
    const r = parseCellRect({ colStart: 2, colSpan: bad, rowStart: 2, rowSpan: 4 }, "16:9", "element");
    assert(r.rect === null, `colSpan ${bad} must not produce a rect`);
    assert(r.errors.some((e) => /at least 1/.test(e)), r.errors.join(" "));
  }
});

check("a FRACTIONAL coordinate is REJECTED — the lattice is integers", () => {
  const r = parseCellRect({ colStart: 2.5, colSpan: 4, rowStart: 2, rowSpan: 4 }, "16:9", "element");
  assert(r.rect === null, "a float must not produce a rect");
  assert(r.errors.some((e) => /whole number/.test(e)), r.errors.join(" "));
  assert(classifyCellError(r.errors[0]) === "non-integer", "classified wrong");
});

check("a STRING coordinate is REJECTED (no coercion — '4' is not 4)", () => {
  const r = parseCellRect({ colStart: "4", colSpan: 4, rowStart: 2, rowSpan: 4 }, "16:9", "element");
  assert(r.rect === null, "a string must not produce a rect");
  assert(r.errors.some((e) => /whole number/.test(e)), r.errors.join(" "));
});

check("a PARTIAL rect (three of four fields) is REJECTED, naming the missing one", () => {
  const r = parseCellRect({ colStart: 4, colSpan: 6, rowStart: 2 }, "16:9", "element");
  assert(r.rect === null, "a partial rect must not produce a rect");
  assert(r.errors.some((e) => /rowSpan/.test(e)), `expected rowSpan named, got: ${r.errors.join(" ")}`);
});

check("NO coordinates at all is REJECTED as a missing rect, not as four bad fields", () => {
  const r = parseCellRect({ role: "hero" }, "16:9", "element \"hero\"");
  assert(r.rect === null, "no rect must not produce a rect");
  assert(r.errors.length === 1, `expected ONE error, got ${r.errors.length}: ${r.errors.join(" ")}`);
  assert(classifyCellError(r.errors[0]) === "missing-rect", "classified wrong");
});

check("EVERY defect is reported, not just the first (one repair round, not four)", () => {
  const r = parseCellRect({ colStart: -1, colSpan: 99, rowStart: -1, rowSpan: 99 }, "16:9", "element");
  // A negative start and an off-lattice end are INDEPENDENT facts; the head can
  // only fix both in one round if it hears both.
  assert(r.errors.some((e) => /0-based/.test(e)), `missing the negative-start error: ${r.errors.join(" ")}`);
  assert(
    r.errors.some((e) => /columns .* runs off the lattice/.test(e)),
    `missing the column off-lattice error: ${r.errors.join(" ")}`,
  );
  assert(
    r.errors.some((e) => /rows .* runs off the lattice/.test(e)),
    `missing the row off-lattice error: ${r.errors.join(" ")}`,
  );
});

// ─── (a) undeclared overlap — the contract arm B got for free ───────────────

check("rectsOverlap: sharing a single cell counts, sharing only an edge index does not", () => {
  const a = { c0: 0, c1: 5, r0: 0, r1: 5 };
  assert(rectsOverlap(a, { c0: 5, c1: 9, r0: 5, r1: 9 }), "cell (5,5) is shared — must overlap");
  assert(!rectsOverlap(a, { c0: 6, c1: 9, r0: 0, r1: 5 }), "adjacent columns must not overlap");
  assert(!rectsOverlap(a, { c0: 0, c1: 5, r0: 6, r1: 9 }), "adjacent rows must not overlap");
});

check("UNDECLARED overlap between two content elements is REJECTED", () => {
  const res = cellSceneToComposition(
    {
      elements: [
        el("hero", { colStart: 0, colSpan: 16, rowStart: 0, rowSpan: 10 }),
        el("copy", { colStart: 8, colSpan: 12, rowStart: 4, rowSpan: 8 }),
      ],
      negativeSpace: "the right band stays open",
    },
    "16:9",
  );
  assert(res.composition === null, "an overlapping scene must not compose");
  assert(
    res.errors.some((e) => /claim overlapping cells/.test(e)),
    `expected an overlap error, got: ${res.errors.join(" ")}`,
  );
  assert(classifyCellError(res.errors[0]) === "undeclared-overlap", "classified wrong");
});

check("DECLARED overlap (an over-layer in `layers`) is ACCEPTED", () => {
  const res = cellSceneToComposition(
    {
      elements: [
        el("hero", { colStart: 0, colSpan: 32, rowStart: 0, rowSpan: 18 }, { area: "hero" }),
        el("copy", { colStart: 2, colSpan: 10, rowStart: 4, rowSpan: 6 }, { area: "card" }),
      ],
      layers: [{ area: "card", zIndex: 2 }],
      negativeSpace: "the lower right stays open",
    },
    "16:9",
  );
  assert(res.errors.length === 0, `declared stacking must parse: ${res.errors.join(" ")}`);
  assert(res.composition !== null, "no composition");
  // The full-lattice hero snapped to full-bleed; the card kept its lattice block.
  const [hero, copy] = res.composition!.elements;
  assert(hero.bounds!.w === CANVAS["16:9"].w, `hero should be full-bleed, got w ${hero.bounds!.w}`);
  assert(copy.bounds!.w === Math.round(10 * CELL - GUTTER), `card w ${copy.bounds!.w}`);
});

check("overlap is checked ONLY once every rect parsed (no cascade on a bad rect)", () => {
  const res = cellSceneToComposition(
    {
      elements: [
        el("hero", { colStart: 0, colSpan: 99, rowStart: 0, rowSpan: 10 }),
        el("copy", { colStart: 0, colSpan: 12, rowStart: 0, rowSpan: 8 }),
      ],
    },
    "16:9",
  );
  assert(res.composition === null, "must not compose");
  assert(
    !res.errors.some((e) => /claim overlapping cells/.test(e)),
    `overlap noise must not stack on a range error: ${res.errors.join(" ")}`,
  );
});

check("atmosphere carries NO rect and is not overlap-checked (it is the base layer)", () => {
  const res = cellSceneToComposition(
    {
      elements: [
        el("hero", { colStart: 4, colSpan: 20, rowStart: 2, rowSpan: 12 }),
        { role: "atmosphere", subject: "a warm field", interior: [], ownsCopy: [] },
      ],
      negativeSpace: "the outer margin stays open",
    },
    "16:9",
  );
  assert(res.errors.length === 0, res.errors.join(" "));
  const atmos = res.composition!.elements.find((e) => e.role === "atmosphere")!;
  assert(atmos.bounds === undefined, "atmosphere must carry no bounds");
});

check("an empty elements[] is REJECTED", () => {
  const res = cellSceneToComposition({ elements: [] }, "16:9");
  assert(res.composition === null, "an empty scene must not compose");
  assert(res.errors.some((e) => /no elements/.test(e)), res.errors.join(" "));
});

check("negativeSpace stays PROSE — the schema downstream requires a sentence", () => {
  const res = cellSceneToComposition(
    {
      elements: [el("hero", { colStart: 4, colSpan: 20, rowStart: 2, rowSpan: 12 })],
      negativeSpace: "the quiet band beneath the hero stays open",
      budget: { brandMark: "chrome", cta: "hero" },
    },
    "16:9",
  );
  assert(typeof res.composition!.negativeSpace === "string", "negativeSpace must be a string");
  assert(res.composition!.budget!.brandMark === "chrome", "budget lost");
});

// ─── (c) the exemplar must pass its own contract ────────────────────────────

check("the worked example parses CLEAN at every aspect and is in range", () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = GRID[aspect];
    const scenes = JSON.parse(buildCellWorkedExample(aspect)) as Record<string, unknown>[];
    assert(scenes.length === 1, `${aspect}: expected 1 example scene`);
    const res = cellSceneToComposition(scenes[0], aspect);
    assert(res.errors.length === 0, `${aspect}: exemplar failed its own parser: ${res.errors.join(" ")}`);
    assert(res.composition !== null, `${aspect}: no composition`);

    // Every declared void is in range too — the prompt asks for the same rigor.
    for (const v of (scenes[0].voids ?? []) as CellRect[]) {
      assert(
        v.colStart >= 0 && v.colStart + v.colSpan <= cols,
        `${aspect}: exemplar void columns ${v.colStart}+${v.colSpan} off-lattice`,
      );
      assert(
        v.rowStart >= 0 && v.rowStart + v.rowSpan <= rows,
        `${aspect}: exemplar void rows ${v.rowStart}+${v.rowSpan} off-lattice`,
      );
      assert(v.colSpan >= 1 && v.rowSpan >= 1, `${aspect}: exemplar void has a non-positive span`);
    }
  }
});

check("the worked example's hero and copy do NOT overlap (it teaches the rule it states)", () => {
  for (const aspect of ASPECTS) {
    const scenes = JSON.parse(buildCellWorkedExample(aspect)) as { elements: Record<string, unknown>[] }[];
    const rects = scenes[0].elements
      .filter((e) => e.role !== "atmosphere")
      .map((e) => cellRectToArea(e as unknown as CellRect));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert(!rectsOverlap(rects[i], rects[j]), `${aspect}: exemplar elements ${i} and ${j} overlap`);
      }
    }
  }
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
