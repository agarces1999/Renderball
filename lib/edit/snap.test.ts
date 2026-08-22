//
// Snapping.
//
// Most of these are about NOT snapping. A pull you cannot escape is worse than none —
// the position you want becomes the one position the editor refuses to give you — so
// the bypass, the threshold edge, and "leave it alone when nothing is near" matter more
// than the happy path.
//
import { snapBox, DEFAULT_SNAP_THRESHOLD, type Box } from "./snap";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ snap");

const CANVAS = { w: 1920, h: 1080 };
const box = (x: number, y: number, w = 200, h = 100): Box => ({ x, y, w, h });

check("nothing nearby leaves the box exactly where it was", () => {
  const r = snapBox(box(613, 407), [box(20, 20, 50, 50)], CANVAS);
  assert(r.x === 613 && r.y === 407, JSON.stringify(r));
  assert(!r.snapped && r.guides.length === 0, "should not claim a snap");
});

check("a left edge just off a sibling's left edge is pulled onto it", () => {
  const sibling = box(400, 800);
  const r = snapBox(box(404, 300), [sibling], CANVAS);
  assert(r.x === 400, `expected x=400, got ${r.x}`);
  assert(r.guides.some((g) => g.axis === "x" && g.at === 400 && g.source === "sibling"), JSON.stringify(r.guides));
});

check("CENTRES align, not just edges", () => {
  const sibling = box(400, 800, 200, 100); // centre x = 500
  const moving = box(403, 300, 194, 100); // centre x = 500 exactly when x = 403
  const r = snapBox(moving, [sibling], CANVAS);
  assert(Math.abs(r.x + moving.w / 2 - 500) < 1e-6, `centres should meet, got centre ${r.x + moving.w / 2}`);
});

check("BYPASS returns the raw position and no guides", () => {
  // Cmd/Ctrl held. Without this, the one position you want is unreachable.
  const r = snapBox(box(401, 300), [box(400, 800)], CANVAS, { bypass: true });
  assert(r.x === 401 && r.y === 300, JSON.stringify(r));
  assert(r.guides.length === 0 && !r.snapped, "bypass must suppress guides too");
});

check("the threshold is a hard edge, not a suggestion", () => {
  const sib = [box(400, 800)];
  const inside = snapBox(box(400 + DEFAULT_SNAP_THRESHOLD - 1, 300), sib, CANVAS);
  assert(inside.x === 400, `just inside should snap, got ${inside.x}`);
  const outside = snapBox(box(400 + DEFAULT_SNAP_THRESHOLD + 1, 300), sib, CANVAS);
  assert(outside.x === 400 + DEFAULT_SNAP_THRESHOLD + 1, `just outside must not snap, got ${outside.x}`);
});

check("threshold 0 disables snapping entirely", () => {
  const r = snapBox(box(401, 300), [box(400, 800)], CANVAS, { threshold: 0 });
  assert(r.x === 401 && !r.snapped, JSON.stringify(r));
});

check("the two axes decide independently", () => {
  // Left edge near a sibling's left; top edge near the canvas's vertical middle.
  const r = snapBox(box(403, 540 - 2), [box(400, 900)], CANVAS);
  assert(r.x === 400, `x should snap to the sibling: ${r.x}`);
  assert(r.y === 540, `y should snap to the canvas middle: ${r.y}`);
  assert(r.guides.length === 2, `both guides should show: ${JSON.stringify(r.guides)}`);
});

check("a SIBLING wins a genuine tie against the canvas", () => {
  // The moving left edge sits at 957: 3px from the canvas centre (960) and 3px from
  // this sibling's left edge (954). Equal distance, so the tie-break decides, and
  // aligning to your own content is the likelier intent.
  const r = snapBox(box(957, 300), [box(954, 800)], CANVAS);
  const g = r.guides.find((x) => x.axis === "x");
  assert(g?.source === "sibling", `expected the sibling to win, got ${JSON.stringify(g)}`);
  assert(r.x === 954, `should land on the sibling edge, got ${r.x}`);
});

check("but a CLOSER canvas target still beats a further sibling", () => {
  // The tie-break must not become a preference. Canvas centre 3px away, sibling 6px.
  const r = snapBox(box(957, 300), [box(963, 800)], CANVAS);
  const g = r.guides.find((x) => x.axis === "x");
  assert(g?.source === "canvas" && r.x === 960, `distance must win: ${JSON.stringify({ x: r.x, g })}`);
});

check("canvas edges and thirds are targets", () => {
  assert(snapBox(box(3, 300), [], CANVAS).x === 0, "left edge");
  assert(snapBox(box(640 - 3, 300), [], CANVAS).x === 640, "first third");
  assert(snapBox(box(1920 - 200 + 2, 300), [], CANVAS).x === 1720, "right edge, by the box's right side");
});

check("the closest candidate wins when several are in range", () => {
  const r = snapBox(box(404, 300), [box(400, 800), box(406, 900)], CANVAS);
  assert(r.x === 406, `406 is 2 away and 400 is 4 away; got ${r.x}`);
});

check("a guide spans BOTH boxes so it visibly connects them", () => {
  const moving = box(404, 100, 200, 100); // y 100..200
  const sibling = box(400, 800, 200, 100); // y 800..900
  const g = snapBox(moving, [sibling], CANVAS).guides.find((x) => x.axis === "x");
  assert(!!g, "expected a vertical guide");
  assert(g!.from <= 100 && g!.to >= 900, `guide should span both: ${JSON.stringify(g)}`);
});

check("size is never changed by snapping — it only moves", () => {
  const moving = box(404, 302, 173, 91);
  const r = snapBox(moving, [box(400, 300)], CANVAS);
  // The result carries only a position; assert the caller can keep its own size by
  // checking the snap never implies a different one.
  assert(typeof r.x === "number" && typeof r.y === "number", "position only");
  assert(!("w" in r) && !("h" in r), "a snap result must not carry a size");
});

check("an empty canvas still snaps to the page", () => {
  const r = snapBox(box(2, 2), [], CANVAS);
  assert(r.x === 0 && r.y === 0, JSON.stringify(r));
  assert(r.guides.every((g) => g.source === "canvas"), "all page guides");
});

check("a box already exactly aligned reports the snap without moving", () => {
  const r = snapBox(box(400, 300), [box(400, 800)], CANVAS);
  assert(r.x === 400 && r.snapped, JSON.stringify(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
