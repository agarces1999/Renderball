/**
 * Geometry guard for suggested layouts.
 *
 * The model proposes regions; it is not trusted to do arithmetic. Layout models
 * routinely return boxes that hang off the canvas, collide with each other, or
 * come back a few pixels tall — and any of those, drawn on the canvas as a
 * clickable target, becomes a broken element the moment it is accepted. So the
 * intent is kept and the numbers are re-checked. These tests pin that contract.
 */
import { sanitizeSuggestions, parseOccupied } from "./suggest-layout";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const CANVAS = { w: 1920, h: 1080 };
const region = (o: Record<string, unknown>) => ({ label: "R", prompt: "build a thing", ...o });

const run = () => {
  console.log("suggest-layout");

  check("a clean set passes through, in order", () => {
    const out = sanitizeSuggestions(
      { regions: [region({ x: 100, y: 100, w: 800, h: 300 }), region({ label: "B", x: 100, y: 500, w: 800, h: 300 })] },
      CANVAS,
    );
    assert(out.length === 2, `expected 2, got ${out.length}`);
    assert(out[1].label === "B", "order must be preserved");
  });

  check("a region hanging off the RIGHT edge is pulled back inside", () => {
    const out = sanitizeSuggestions({ regions: [region({ x: 1800, y: 100, w: 400, h: 200 })] }, CANVAS);
    assert(out.length === 1, "should be kept, not dropped");
    const b = out[0].bounds;
    assert(b.x + b.w <= CANVAS.w, `escapes right: ${b.x}+${b.w}`);
  });

  check("a region hanging off the BOTTOM is pulled back inside", () => {
    const out = sanitizeSuggestions({ regions: [region({ x: 100, y: 1000, w: 400, h: 400 })] }, CANVAS);
    const b = out[0].bounds;
    assert(b.y + b.h <= CANVAS.h, `escapes bottom: ${b.y}+${b.h}`);
  });

  check("negative coordinates are clamped to the canvas", () => {
    const out = sanitizeSuggestions({ regions: [region({ x: -300, y: -80, w: 600, h: 300 })] }, CANVAS);
    const b = out[0].bounds;
    assert(b.x >= 0 && b.y >= 0, `negative origin survived: ${b.x},${b.y}`);
  });

  check("a sliver too small to hold anything is DROPPED", () => {
    const out = sanitizeSuggestions({ regions: [region({ x: 10, y: 10, w: 40, h: 8 })] }, CANVAS);
    assert(out.length === 0, "a 40×8 region must not be offered");
  });

  check("the second of two OVERLAPPING regions is dropped, the first survives", () => {
    const out = sanitizeSuggestions(
      { regions: [region({ label: "first", x: 100, y: 100, w: 800, h: 400 }), region({ label: "second", x: 300, y: 200, w: 800, h: 400 })] },
      CANVAS,
    );
    assert(out.length === 1, `expected 1 survivor, got ${out.length}`);
    assert(out[0].label === "first", "the earlier region wins a collision");
  });

  check("a region landing on an EXISTING element is dropped", () => {
    const occupied = [{ x: 100, y: 100, w: 500, h: 300 }];
    const out = sanitizeSuggestions({ regions: [region({ x: 200, y: 150, w: 400, h: 200 })] }, CANVAS, occupied);
    assert(out.length === 0, "must not propose a box on top of existing content");
  });

  // Regression: a boolean "do these touch at all" test rejected EVERY proposal
  // on a real slide, because measured element boxes graze constantly — Suggest
  // returned "no usable regions" on a page with obvious free space. Sitting on
  // content is disqualifying; sharing an edge with it is not.
  check("a region that merely GRAZES existing content is kept", () => {
    const occupied = [{ x: 0, y: 0, w: 1000, h: 200 }];
    // 5% of this region overlaps the occupied strip.
    const out = sanitizeSuggestions({ regions: [region({ x: 0, y: 190, w: 1000, h: 200 })] }, CANVAS, occupied);
    assert(out.length === 1, "a light graze must not disqualify a region");
  });

  // Regression: a one-directional coverage test let a LARGE region completely
  // contain a small text block — only a few percent of the region, so it passed
  // — and it rendered as a box drawn over the KPI rows.
  check("a big region that SWALLOWS a small existing element is dropped", () => {
    const kpiRow = [{ x: 1376, y: 489, w: 281, h: 25 }];
    const out = sanitizeSuggestions({ regions: [region({ x: 900, y: 420, w: 950, h: 400 })] }, CANVAS, kpiRow);
    assert(out.length === 0, "a region containing existing text must be dropped, however large it is");
  });

  check("a region that clips only the EDGE of an element is still allowed", () => {
    // 20% of this text block pokes into the region — a graze, not a swallow.
    const text = [{ x: 0, y: 380, w: 500, h: 100 }];
    const out = sanitizeSuggestions({ regions: [region({ x: 0, y: 460, w: 900, h: 300 })] }, CANVAS, text);
    assert(out.length === 1, "an edge clip must not disqualify the region");
  });

  check("a region sitting SQUARELY on existing content is still dropped", () => {
    const occupied = [{ x: 0, y: 0, w: 1000, h: 400 }];
    const out = sanitizeSuggestions({ regions: [region({ x: 100, y: 50, w: 700, h: 300 })] }, CANVAS, occupied);
    assert(out.length === 0, "a region mostly on top of content must be dropped");
  });

  check("two regions may share an edge without either being dropped", () => {
    const out = sanitizeSuggestions(
      { regions: [region({ label: "top", x: 100, y: 100, w: 800, h: 300 }), region({ label: "bottom", x: 100, y: 400, w: 800, h: 300 })] },
      CANVAS,
    );
    assert(out.length === 2, `stacked-but-not-overlapping regions must both survive, got ${out.length}`);
  });

  check("a region with no prompt is dropped — nothing to build", () => {
    const out = sanitizeSuggestions({ regions: [{ label: "Empty", x: 100, y: 100, w: 600, h: 300 }] }, CANVAS);
    assert(out.length === 0, "a region without a prompt is not actionable");
  });

  check("non-numeric or missing coordinates are dropped, not coerced", () => {
    const out = sanitizeSuggestions(
      { regions: [region({ x: "left", y: 100, w: 600, h: 300 }), region({ y: 100, w: 600, h: 300 })] },
      CANVAS,
    );
    assert(out.length === 0, "garbage geometry must not become a box at 0,0");
  });

  check("more than six regions are capped", () => {
    const many = Array.from({ length: 12 }, (_, i) => region({ label: `R${i}`, x: 10, y: i * 90, w: 300, h: 80 }));
    const out = sanitizeSuggestions({ regions: many }, CANVAS);
    assert(out.length <= 6, `expected at most 6, got ${out.length}`);
  });

  check("junk input yields an empty list rather than throwing", () => {
    assert(sanitizeSuggestions(null, CANVAS).length === 0, "null");
    assert(sanitizeSuggestions({}, CANVAS).length === 0, "no regions key");
    assert(sanitizeSuggestions({ regions: "nope" }, CANVAS).length === 0, "regions not an array");
    assert(sanitizeSuggestions({ regions: [null, 5, "x"] }, CANVAS).length === 0, "non-objects");
  });

  check("a missing label falls back rather than rendering an empty chip", () => {
    const out = sanitizeSuggestions({ regions: [{ prompt: "a chart", x: 100, y: 100, w: 600, h: 300 }] }, CANVAS);
    assert(out.length === 1 && out[0].label.length > 0, "label must never be empty");
  });

  // ── parseOccupied: browser-measured rectangles are untrusted request input ──

  check("well-formed occupied rectangles survive, rounded", () => {
    const out = parseOccupied([{ x: 10.4, y: 20.6, w: 100.2, h: 50.9 }]);
    assert(out.length === 1, "should keep a valid rect");
    assert(out[0].x === 10 && out[0].y === 21 && out[0].w === 100 && out[0].h === 51, `rounded: ${JSON.stringify(out[0])}`);
  });

  check("non-numeric or zero-area rectangles are dropped", () => {
    const out = parseOccupied([
      { x: "a", y: 0, w: 10, h: 10 },
      { x: 0, y: 0, w: 0, h: 10 },
      { x: 0, y: 0, w: 10, h: -5 },
      { x: 0, y: 0 },
      null,
      "nope",
    ]);
    assert(out.length === 0, `expected all dropped, got ${JSON.stringify(out)}`);
  });

  check("a flood of rectangles is capped so a crafted body can't inflate the prompt", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ x: i, y: i, w: 5, h: 5 }));
    assert(parseOccupied(many).length <= 40, "must cap the list");
  });

  check("a non-array occupied value yields an empty list", () => {
    assert(parseOccupied(undefined).length === 0, "undefined");
    assert(parseOccupied({ x: 1 }).length === 0, "object");
    assert(parseOccupied("boxes").length === 0, "string");
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

run();
