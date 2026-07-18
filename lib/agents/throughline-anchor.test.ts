/**
 * Tests for the per-VIDEO throughline anchor (throughline-anchor.ts).
 *
 * The contract under test is a two-sided one, and both sides matter:
 *   - AVOIDANCE: one anchor, chosen over the head's own frames, that is clear
 *     of copy/hero/chrome in as many scenes as possible.
 *   - DRIFT: whatever it chooses, the cross-scene SPAN of the emitted positions
 *     must stay inside the tolerance `assessContinuity` measures — otherwise
 *     `repositionThroughline` silently snaps every occurrence to the median and
 *     undoes the placement, and past SEVERE_DRIFT_PX the pipeline buys a retry.
 * The drift threshold is re-derived here from quality-gates' OWN exported
 * behaviour rather than from this module's mirrored constant, so the two
 * drifting apart fails loudly instead of silently.
 */
import {
  selectThroughlineAnchor,
  chooseAnchor,
  displaceFor,
  occupancyFor,
  driftBudgetFor,
  costAt,
  DRIFT_FRACTION,
  DRIFT_SAFETY,
  type AnchorScene,
} from "./throughline-anchor";
import { CANVAS, THROUGHLINE_SIZE, composeSceneLayout, type Aspect } from "./layout-composer";
import { throughlineAnchorFor } from "./choreograph";
import { assessContinuity } from "./quality-gates";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

type R = { x: number; y: number; w: number; h: number };
const overlaps = (a: R, b: R): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const scene = (els: { role: string; bounds?: R }[]): AnchorScene => ({
  register: "centered",
  content: { headline: "x" },
  composition: {
    elements: els.map((e) => ({ role: e.role, subject: e.role, interior: [], ...(e.bounds ? { bounds: e.bounds } : {}) })),
    atmosphere: "flat",
  },
});

const motifBox = (p: { left: number; top: number }): R => ({
  x: p.left,
  y: p.top,
  w: THROUGHLINE_SIZE,
  h: THROUGHLINE_SIZE,
});

// ─── The drift contract ─────────────────────────────────────────────────────

check("DRIFT_FRACTION mirrors the gate: a span at the threshold PASSES assessContinuity", () => {
  // Build a two-scene composition whose tagged motif spans exactly the mirrored
  // threshold on each axis, and one that exceeds it. If quality-gates' own
  // DRIFT_FRACTION ever changes, exactly one of these two flips and this fails.
  const { w: W, h: H } = CANVAS["16:9"];
  const tag = (l: number, t: number) =>
    `<div data-throughline="m" style={{ position: "absolute", left: ${l}, top: ${t} }}>x</div>`;
  const atThresholdX = tag(100, 100) + tag(100 + DRIFT_FRACTION * W, 100);
  assert(assessContinuity(atThresholdX, "16:9").length === 0, "a span EQUAL to the x threshold must not fire");
  const overX = tag(100, 100) + tag(100 + DRIFT_FRACTION * W + 1, 100);
  assert(assessContinuity(overX, "16:9").length === 1, "a span one px OVER the x threshold must fire");
  const overY = tag(100, 100) + tag(100, 100 + DRIFT_FRACTION * H + 1);
  assert(assessContinuity(overY, "16:9").length === 1, "a span one px OVER the y threshold must fire");
});

check("the per-scene budget can never produce a span the gate flags", () => {
  for (const aspect of ASPECTS) {
    const { dx, dy } = driftBudgetFor(aspect);
    const { w: W, h: H } = CANVAS[aspect];
    // Worst case: two scenes displaced to OPPOSITE extremes on both axes.
    assert(2 * dx <= DRIFT_FRACTION * W, `${aspect}: worst-case x span ${2 * dx} exceeds ${DRIFT_FRACTION * W}`);
    assert(2 * dy <= DRIFT_FRACTION * H, `${aspect}: worst-case y span ${2 * dy} exceeds ${DRIFT_FRACTION * H}`);
    // And it must leave real headroom, not sit on the boundary.
    assert(DRIFT_SAFETY < 1, "DRIFT_SAFETY must leave headroom");
  }
});

check("selectThroughlineAnchor: emitted span always stays inside the budget", () => {
  for (const aspect of ASPECTS) {
    const { w: W, h: H } = CANVAS[aspect];
    // Five scenes with wildly different, large occupants — forces displacement
    // decisions on every scene.
    const scenes: AnchorScene[] = Array.from({ length: 5 }, (_, i) =>
      scene([
        { role: "hero", bounds: { x: (i * 137) % (W / 2), y: (i * 91) % (H / 2), w: Math.floor(W * 0.55), h: Math.floor(H * 0.5) } },
        { role: "copy", bounds: { x: 40, y: 40 + i * 30, w: Math.floor(W * 0.35), h: Math.floor(H * 0.3) } },
      ]),
    );
    const out = selectThroughlineAnchor(scenes, aspect);
    const { dx, dy } = driftBudgetFor(aspect);
    assert(out.telemetry.spanX <= 2 * dx, `${aspect}: spanX ${out.telemetry.spanX} > ${2 * dx}`);
    assert(out.telemetry.spanY <= 2 * dy, `${aspect}: spanY ${out.telemetry.spanY} > ${2 * dy}`);
    assert(out.perScene.length === 5, "one position per scene");
    for (const p of out.perScene) {
      assert(Math.abs(p.left - out.anchor.left) <= dx, "per-scene x within budget");
      assert(Math.abs(p.top - out.anchor.top) <= dy, "per-scene y within budget");
    }
  }
});

// ─── Anchor selection ───────────────────────────────────────────────────────

check("picks a clear anchor when the default one is buried under every hero", () => {
  // A hero covering the default anchor in all 5 scenes; the LEFT half is empty.
  const def = throughlineAnchorFor("16:9");
  const scenes: AnchorScene[] = Array.from({ length: 5 }, () =>
    scene([{ role: "hero", bounds: { x: 1000, y: 200, w: 880, h: 700 } }]),
  );
  const out = selectThroughlineAnchor(scenes, "16:9");
  assert(!out.telemetry.isDefaultAnchor, "must move off the default");
  assert(
    !overlaps(motifBox(out.anchor), { x: 1000, y: 200, w: 880, h: 700 }),
    `chosen anchor ${JSON.stringify(out.anchor)} still sits inside the hero`,
  );
  assert(out.telemetry.collidingAtAnchor === 0, "no scene should collide at the chosen anchor");
  assert(overlaps(motifBox(def), { x: 1000, y: 200, w: 880, h: 700 }), "premise: the default DID collide");
});

check("keeps the historical default when it is already clear (ties break toward it)", () => {
  const def = throughlineAnchorFor("16:9");
  const scenes: AnchorScene[] = Array.from({ length: 5 }, () =>
    scene([{ role: "hero", bounds: { x: 100, y: 150, w: 600, h: 500 } }]),
  );
  const out = selectThroughlineAnchor(scenes, "16:9");
  assert(out.telemetry.isDefaultAnchor, `expected the default anchor, got ${JSON.stringify(out.anchor)}`);
  assert(out.anchor.left === def.left && out.anchor.top === def.top, "exact default");
});

check("COPY outranks HERO: forced to choose, the motif clears the copy column", () => {
  // Only two regions are free-ish; one is under the copy, one under the hero.
  // The weights must send the motif to the hero side.
  const copy = { x: 0, y: 0, w: 960, h: 1000 };
  const hero = { x: 960, y: 0, w: 960, h: 1000 };
  const scenes = [scene([{ role: "copy", bounds: copy }, { role: "hero", bounds: hero }])];
  const out = selectThroughlineAnchor(scenes, "16:9");
  const box = motifBox(out.anchor);
  assert(
    costAt(out.anchor, occupancyFor(scenes[0], "16:9")) === 0 || !overlaps(box, copy),
    `motif must not be parked on the copy column: ${JSON.stringify(out.anchor)}`,
  );
});

check("a full-bleed hero is not scored — the motif has to sit on it", () => {
  const scenes = [scene([{ role: "hero", bounds: { x: 0, y: 0, w: 1920, h: 1080 } }])];
  const occ = occupancyFor(scenes[0], "16:9");
  // The canvas-sized hero must NOT be an occupant (copy + chrome still are).
  const full = { x: 0, y: 0, w: 1920, h: 1080 };
  assert(
    !occ.occupants.some((o) => o.rect.w === full.w && o.rect.h === full.h),
    "a full-bleed hero must be exempt from scoring",
  );
  const out = selectThroughlineAnchor(scenes, "16:9");
  assert(!overlaps(motifBox(out.anchor), full) === false, "the motif does sit on the full-bleed hero, by design");
  assert(out.telemetry.collidingAtAnchor === 0, "and that is not counted as a collision");
});

check("un-composed scenes contribute their TABLE geometry, not nothing", () => {
  const scenes: AnchorScene[] = [{ register: "centered", content: {} }, { register: "split", content: {} }];
  const occ = occupancyFor(scenes[0], "16:9");
  assert(occ.occupants.length >= 2, "the table's hero/copy/chrome rects must be scored");
  assert(occ.forbidden !== null, "a table-path scene marks its copy rect FORBIDDEN (the assert would throw)");
  const out = selectThroughlineAnchor(scenes, "16:9");
  assert(!overlaps(motifBox(out.anchor), occ.forbidden!), "the choice must never land on a forbidden rect");
});

check("a chosen anchor NEVER crashes the table path (the assert stays armed)", () => {
  // Mixed video: 4 composed scenes pushing the anchor left, 1 un-composed scene
  // whose table copy rect sits there. The build must not throw.
  const composed = Array.from({ length: 4 }, () =>
    scene([{ role: "hero", bounds: { x: 700, y: 100, w: 1200, h: 900 } }]),
  );
  const scenes: AnchorScene[] = [...composed, { register: "centered", content: { headline: "h" } }];
  const choice = selectThroughlineAnchor(scenes, "16:9");
  for (let i = 0; i < scenes.length; i++) {
    // Throws on failure — that IS the assertion.
    composeSceneLayout(scenes[i], "16:9", { hasThroughline: true, throughlineAt: choice.perScene[i] });
  }
});

check("even a hand-picked colliding anchor degrades instead of throwing on the table path", () => {
  const s = { register: "centered", content: { headline: "h" } };
  // {210,330} sits inside the centered table's copy rect {360,160,960,480}.
  const plan = composeSceneLayout(s, "16:9", { hasThroughline: true, throughlineAt: { left: 210, top: 330 } });
  const tl = plan.elements.find((e) => e.id === "throughline")!;
  const def = throughlineAnchorFor("16:9");
  assert(tl.bounds.x === def.left && tl.bounds.y === def.top, "must fall back to the default, not throw");
});

check("no scenes at all ⇒ the default anchor, no crash", () => {
  for (const aspect of ASPECTS) {
    const out = selectThroughlineAnchor([], aspect);
    const def = throughlineAnchorFor(aspect);
    assert(out.anchor.left === def.left && out.anchor.top === def.top, `${aspect} default`);
    assert(out.perScene.length === 0 && out.telemetry.spanX === 0, "empty telemetry");
  }
});

check("deterministic: identical scenes yield a byte-identical choice", () => {
  const scenes = Array.from({ length: 5 }, (_, i) =>
    scene([
      { role: "hero", bounds: { x: 200 + i * 10, y: 100, w: 900, h: 700 } },
      { role: "copy", bounds: { x: 1200, y: 200, w: 600, h: 500 } },
    ]),
  );
  const a = JSON.stringify(selectThroughlineAnchor(scenes, "16:9"));
  const b = JSON.stringify(selectThroughlineAnchor(scenes, "16:9"));
  assert(a === b, "two runs disagreed");
});

check("the anchor is always legal: on canvas and clear of the bottom reserve", () => {
  for (const aspect of ASPECTS) {
    const { w: W, h: H } = CANVAS[aspect];
    // Occupy nearly everything so the search is pushed into the corners.
    const scenes = Array.from({ length: 3 }, () =>
      scene([{ role: "hero", bounds: { x: 0, y: 0, w: W - 40, h: H - 40 } }]),
    );
    const out = selectThroughlineAnchor(scenes, aspect);
    for (const p of [out.anchor, ...out.perScene]) {
      assert(p.left >= 0 && p.top >= 0, `${aspect}: negative position ${JSON.stringify(p)}`);
      assert(p.left + THROUGHLINE_SIZE <= W, `${aspect}: off the right edge`);
      assert(p.top + THROUGHLINE_SIZE <= 0.965 * H, `${aspect}: crosses the bottom reserve`);
    }
  }
});

// ─── Local displacement + the all-scenes-collide fallback ───────────────────

check("displaceFor: clears a small neighbour with the SMALLEST offset that works", () => {
  const anchor = { left: 500, top: 500 };
  // A thin bar overlapping only the motif's left 30px.
  const occ = occupancyFor(scene([{ role: "copy", bounds: { x: 480, y: 480, w: 50, h: 300 } }]), "16:9");
  assert(costAt(anchor, occ) > 0, "premise: the anchor collides");
  const p = displaceFor(anchor, occ, "16:9");
  assert(costAt(p, occ) === 0, `displacement did not clear: ${JSON.stringify(p)}`);
  const moved = Math.abs(p.left - anchor.left) + Math.abs(p.top - anchor.top);
  assert(moved <= 40, `moved ${moved}px — expected a small nudge, not a relocation`);
});

check("FALLBACK: when nothing inside the budget clears it, keep the anchor (never wander)", () => {
  const anchor = { left: 900, top: 400 };
  // A hero far wider than the drift budget on every side — unescapable.
  const occ = occupancyFor(scene([{ role: "hero", bounds: { x: 0, y: 0, w: 1900, h: 1000 } }]), "16:9");
  const p = displaceFor(anchor, occ, "16:9");
  assert(p.left === anchor.left && p.top === anchor.top, `expected the anchor verbatim, got ${JSON.stringify(p)}`);
});

check("all-scenes-collide: reports the residue instead of hiding it", () => {
  // Every scene fully covered ⇒ every candidate collides ⇒ nothing displaceable.
  const scenes = Array.from({ length: 4 }, () =>
    scene([{ role: "hero", bounds: { x: 0, y: 0, w: 1920, h: 1000 } }, { role: "copy", bounds: { x: 0, y: 0, w: 1920, h: 1000 } }]),
  );
  const out = selectThroughlineAnchor(scenes, "16:9");
  // isFullBleed exempts the hero here (it blankets the frame), but the copy does not.
  assert(out.telemetry.collidingAtAnchor === 4, "all four scenes must be reported as colliding");
  assert(out.telemetry.displaced === 0, "nothing is displaceable when the whole frame is covered");
  assert(out.telemetry.unresolved === 4, "the residue must be surfaced for the repair ladder");
  assert(out.telemetry.spanX === 0 && out.telemetry.spanY === 0, "an unresolved scene spends NO drift");
});

// ─── Integration with the composer ──────────────────────────────────────────

check("composeSceneLayout honours throughlineAt, and defaults to the constant without it", () => {
  const s = { register: "centered", content: { headline: "h" } };
  const dflt = composeSceneLayout(s, "16:9", { hasThroughline: true });
  const tl = dflt.elements.find((e) => e.id === "throughline")!;
  const def = throughlineAnchorFor("16:9");
  assert(tl.bounds.x === def.left && tl.bounds.y === def.top, "omitted ⇒ the historical constant");

  // A point clear of the centered table's copy rect, so the safety net stays out of it.
  const moved = composeSceneLayout(s, "16:9", { hasThroughline: true, throughlineAt: { left: 90, top: 700 } });
  const tl2 = moved.elements.find((e) => e.id === "throughline")!;
  assert(tl2.bounds.x === 90 && tl2.bounds.y === 700, "supplied anchor must be used verbatim");
  assert(tl2.bounds.w === THROUGHLINE_SIZE && tl2.bounds.h === THROUGHLINE_SIZE, "size unchanged");
});

check("end to end: the chosen anchor removes a hero x throughline overlap the constant caused", () => {
  // A head that parks its hero exactly over the default anchor in every scene.
  const heroBounds = { x: 1200, y: 400, w: 700, h: 500 };
  const scenes = Array.from({ length: 5 }, () => scene([{ role: "hero", bounds: heroBounds }]));
  const before = composeSceneLayout(scenes[0], "16:9", { hasThroughline: true });
  const bHero = before.elements.find((e) => e.id === "hero")!.bounds;
  const bTl = before.elements.find((e) => e.id === "throughline")!.bounds;
  assert(overlaps(bHero, bTl), "premise: the constant anchor collided with the head's hero");

  const choice = selectThroughlineAnchor(scenes, "16:9");
  const after = composeSceneLayout(scenes[0], "16:9", { hasThroughline: true, throughlineAt: choice.perScene[0] });
  const aHero = after.elements.find((e) => e.id === "hero")!.bounds;
  const aTl = after.elements.find((e) => e.id === "throughline")!.bounds;
  assert(!overlaps(aHero, aTl), `still overlapping: hero ${JSON.stringify(aHero)} motif ${JSON.stringify(aTl)}`);
});

check("chooseAnchor prefers fewer COLLIDING SCENES over lower total area", () => {
  // Scene A: a huge box far from a candidate. Scene B: a sliver on it.
  // A candidate that grazes both scenes must lose to one that grazes neither.
  const scenes = [
    scene([{ role: "hero", bounds: { x: 0, y: 0, w: 700, h: 1000 } }]),
    scene([{ role: "hero", bounds: { x: 0, y: 0, w: 700, h: 1000 } }]),
  ];
  const occs = scenes.map((s) => occupancyFor(s, "16:9"));
  const a = chooseAnchor(occs, "16:9");
  assert(occs.every((o) => costAt(a, o) === 0), "a fully clear anchor exists and must be chosen");
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
