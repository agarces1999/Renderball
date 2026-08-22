//
// Cascading toolbar inserts.
//
// Pinned to the real numbers: the founder's deck is 1920x1080, its default text box
// is 768x172 centred at (576, 454), and four inserts produced four pieces at exactly
// that coordinate.
//
import { cascadeBox, CASCADE_STEP, type Box } from "./cascade-box";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ cascade-box");

const CANVAS = { w: 1920, h: 1080 };
/** The real default text box from src/generated/01KY7ZGC4MVDD5J1DSB35GAW5T. */
const BASE: Box = { x: 576, y: 454, w: 768, h: 172 };

check("an empty canvas leaves the box where it was", () => {
  const r = cascadeBox(BASE, [], CANVAS);
  assert(r.x === BASE.x && r.y === BASE.y, JSON.stringify(r));
});

check("THE BUG: four successive inserts land in four different places", () => {
  const placed: Box[] = [];
  for (let i = 0; i < 4; i++) placed.push(cascadeBox(BASE, placed, CANVAS));
  const coords = placed.map((b) => `${b.x},${b.y}`);
  assert(new Set(coords).size === 4, `expected 4 distinct positions, got ${JSON.stringify(coords)}`);
  assert(coords[0] === "576,454", `first should keep the centred spot: ${coords[0]}`);
  assert(coords[1] === `${576 + CASCADE_STEP},${454 + CASCADE_STEP}`, `second should step: ${coords[1]}`);
});

check("each cascaded box stays fully on the canvas", () => {
  const placed: Box[] = [];
  for (let i = 0; i < 10; i++) placed.push(cascadeBox(BASE, placed, CANVAS));
  for (const b of placed) {
    assert(b.x >= 0 && b.y >= 0, `negative origin: ${JSON.stringify(b)}`);
    assert(b.x + b.w <= CANVAS.w, `runs off the right: ${JSON.stringify(b)}`);
    assert(b.y + b.h <= CANVAS.h, `runs off the bottom: ${JSON.stringify(b)}`);
  }
});

check("it stops at the edge rather than walking off it", () => {
  // A box already near the bottom-right has almost nowhere to cascade to.
  const tight: Box = { x: 1100, y: 880, w: 768, h: 172 };
  const r = cascadeBox(tight, [tight], CANVAS);
  assert(r.x + r.w <= CANVAS.w && r.y + r.h <= CANVAS.h, `left the canvas: ${JSON.stringify(r)}`);
});

check("a NEARBY-but-not-identical box still counts as occupied", () => {
  // Within the same-place tolerance: 6px off is the same place to a human eye.
  const r = cascadeBox(BASE, [{ ...BASE, x: BASE.x + 6, y: BASE.y + 6 }], CANVAS);
  assert(r.x !== BASE.x || r.y !== BASE.y, `should have moved: ${JSON.stringify(r)}`);
});

check("a box far away does NOT push the insert around", () => {
  const r = cascadeBox(BASE, [{ x: 20, y: 20, w: 200, h: 100 }], CANVAS);
  assert(r.x === BASE.x && r.y === BASE.y, `moved for an unrelated box: ${JSON.stringify(r)}`);
});

check("a gap in the middle of the cascade is reused", () => {
  // Slots 0 and 2 taken, slot 1 free — the insert should take slot 1, not slot 3.
  const taken = [
    { ...BASE },
    { ...BASE, x: BASE.x + 2 * CASCADE_STEP, y: BASE.y + 2 * CASCADE_STEP },
  ];
  const r = cascadeBox(BASE, taken, CANVAS);
  assert(r.x === BASE.x + CASCADE_STEP && r.y === BASE.y + CASCADE_STEP, `expected slot 1, got ${JSON.stringify(r)}`);
});

check("when every slot is taken it falls back to the base rather than failing", () => {
  const taken: Box[] = [];
  for (let i = 0; i < 10; i++) taken.push({ ...BASE, x: BASE.x + i * CASCADE_STEP, y: BASE.y + i * CASCADE_STEP });
  const r = cascadeBox(BASE, taken, CANVAS);
  assert(Number.isFinite(r.x) && Number.isFinite(r.y), `must still return a usable box: ${JSON.stringify(r)}`);
  assert(r.w === BASE.w && r.h === BASE.h, "size must never change");
});

check("size is never altered by cascading", () => {
  const placed: Box[] = [];
  for (let i = 0; i < 5; i++) {
    const b = cascadeBox(BASE, placed, CANVAS);
    assert(b.w === BASE.w && b.h === BASE.h, `size drifted: ${JSON.stringify(b)}`);
    placed.push(b);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
