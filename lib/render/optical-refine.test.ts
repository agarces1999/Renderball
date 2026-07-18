/**
 * Tests for the optical refinement post-pass (spatial P5a).
 *
 * Run: `node scripts/run-tests.mjs lib/render/optical-refine.test.ts`
 *
 * The guardrails matter more than the feature, so they are tested first and
 * hardest:
 *  - NEVER introduces a violation — including the case where the adjustment
 *    logic's own emptiness heuristic is fooled (a DIAGONAL neighbour), which is
 *    exactly why the validator-and-revert exists rather than trusting the
 *    heuristic;
 *  - IDEMPOTENT — refine∘refine === refine, the property that lets the pass sit
 *    anywhere on the hot path without an ordering contract;
 *  - BOUNDED — every adjustment capped as a fraction of the box AND the canvas;
 *  - TITLE-SAFE — never pushes an element out, and never drags an
 *    already-outside element in (that would be an un-asked-for layout change);
 *  - NO-OP is BYTE-IDENTICAL, by reference;
 *  - OFF by default.
 *
 * Then the three adjustments in isolation, and finally the property that holds
 * over every real register × aspect the composer can emit.
 */
import { CANVAS, composeSceneLayout, validateScenePlan, type Aspect, type ElementSlot, type ScenePlan } from "../agents/layout-composer";
import { fallbackMetrics } from "./font-metrics";
import { deriveTypeScale } from "./type-scale";
import {
  CLEARANCE_FRAC,
  FOCAL_BLEED_FRAC,
  INK_INSET_CONFIDENCE,
  MAX_BLEED_BOX_FRAC,
  MAX_INSET_FRAC,
  OPTICAL_CENTER_MIN_MARGIN_FRAC,
  OPTICAL_CENTER_RISE_FRAC,
  TITLE_SAFE_FRAC,
  edgeRoom,
  focalSlotId,
  inkInsetFor,
  isCenteredFocal,
  maybeRefineScenePlan,
  opticalRefineEnabled,
  refineScenePlan,
  refineRegionFor,
  titleSafeRect,
  type RefineOpts,
} from "./optical-refine";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

// ── fixtures ────────────────────────────────────────────────────────────────

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];
const REGISTERS = ["centered", "stat", "quote", "full-bleed", "split", "list"];
const CONTENT = { headline: "A real headline", lede: "Some supporting copy.", illustration: "a dashboard" };

/** The production-shaped opts: real metrics fallback + the real P4b type scale. */
const opts = (aspect: Aspect, extra?: Partial<RefineOpts>): RefineOpts => ({
  aspect,
  content: CONTENT,
  metricsFor: () => fallbackMetrics("Test Sans", 700),
  typeScaleFor: (slot) => deriveTypeScale({ role: slot.id, box: slot.bounds, canvas: CANVAS[aspect] }),
  ...extra,
});

const slot = (
  id: string,
  kind: ElementSlot["kind"],
  b: { x: number; y: number; w: number; h: number },
  allowedOverlaps: string[] = ["atmosphere"],
): ElementSlot => ({
  id,
  kind,
  bounds: { ...b, z: 1 },
  contentFields: [],
  paletteRoles: [],
  allowedOverlaps,
});

const atmosphere = (aspect: Aspect): ElementSlot =>
  slot("atmosphere", "atmosphere", { x: 0, y: 0, ...CANVAS[aspect] }, []);

const planOf = (aspect: Aspect, ...els: ElementSlot[]): ScenePlan => ({
  register: "centered",
  elements: [atmosphere(aspect), ...els],
});

const rectOf = (p: ScenePlan, id: string) => {
  const e = p.elements.find((x) => x.id === id);
  if (!e) throw new Error(`no slot "${id}"`);
  return { x: e.bounds.x, y: e.bounds.y, w: e.bounds.w, h: e.bounds.h };
};

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 1 — never introduce a violation
// ════════════════════════════════════════════════════════════════════════════

await check("GUARDRAIL: a DIAGONAL neighbour fools the emptiness heuristic — and the revert catches it", () => {
  // hero's up-left quadrant is "empty" on both the top band and the left band
  // (copy shares neither the x-range nor the y-range), so the per-edge room
  // measurement permits growth in both. Growing both at once walks into copy.
  // This is the exact case the validator-and-revert exists for.
  const hero = slot("hero", "diegetic", { x: 1000, y: 600, w: 400, h: 300 });
  const copy = slot("copy", "text", { x: 560, y: 260, w: 430, h: 330 });
  const p = planOf("16:9", hero, copy);

  const before = validateScenePlan(p, "16:9", { content: CONTENT });
  assert(before.length === 0, `fixture must start clean, got ${JSON.stringify(before)}`);

  // Confirm the trap is real: unguarded, both edges would grow into copy.
  const room = edgeRoom(
    { x: 1000, y: 600, w: 400, h: 300 },
    [{ x: 560, y: 260, w: 430, h: 330 }],
    refineRegionFor("diegetic", "16:9"),
    Math.round(CLEARANCE_FRAC * 1080),
  );
  assert(room.top > 0 && room.left > 0, "the diagonal neighbour must NOT block either band (that is the trap)");

  const r = refineScenePlan(p, opts("16:9", { typeScaleFor: () => undefined }));
  assert(r.reverted.includes("hero"), `hero's bleed must be REVERTED, got reverted=${JSON.stringify(r.reverted)}`);
  assert(!overlap(rectOf(r.plan, "hero"), rectOf(r.plan, "copy")), "reverted plan must be collision-free");
  assert(
    JSON.stringify(rectOf(r.plan, "hero")) === JSON.stringify({ x: 1000, y: 600, w: 400, h: 300 }),
    "a reverted element must return EXACTLY to its input rect",
  );
  assert(/REVERTED/.test(r.summary), `summary must name the revert: ${r.summary}`);
});

await check("GUARDRAIL: the refined plan's violations are always a SUBSET of the input plan's", () => {
  // The property, over every real register × aspect the composer can emit.
  for (const aspect of ASPECTS) {
    for (const register of REGISTERS) {
      for (const hasThroughline of [false, true]) {
        const p = composeSceneLayout({ register, content: CONTENT }, aspect, { hasThroughline });
        const base = new Set(validateScenePlan(p, aspect, { content: CONTENT }).map((v) => v.message));
        const r = refineScenePlan(p, opts(aspect));
        for (const v of validateScenePlan(r.plan, aspect, { content: CONTENT })) {
          assert(base.has(v.message), `${register}@${aspect} (tl=${hasThroughline}) gained a violation: ${v.message}`);
        }
      }
    }
  }
});

await check("GUARDRAIL: a plan that ALREADY violates keeps its violations and gains none", () => {
  // A pre-existing containment violation (copy across the bottom reserve). The
  // pass must neither "fix" it (not its job) nor add to it.
  const copy = slot("copy", "text", { x: 200, y: 700, w: 800, h: 370 }); // 1070 > 0.965·1080
  const p = planOf("16:9", copy);
  const before = validateScenePlan(p, "16:9", { content: CONTENT });
  assert(before.length > 0, "fixture must start dirty");
  const r = refineScenePlan(p, opts("16:9"));
  const after = validateScenePlan(r.plan, "16:9", { content: CONTENT });
  const base = new Set(before.map((v) => v.kind));
  for (const v of after) assert(base.has(v.kind), `gained a ${v.kind} violation`);
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 2 — idempotency
// ════════════════════════════════════════════════════════════════════════════

await check("GUARDRAIL: refine(refine(p)) === refine(p), on every register × aspect", () => {
  for (const aspect of ASPECTS) {
    for (const register of REGISTERS) {
      const p = composeSceneLayout({ register, content: CONTENT }, aspect, { hasThroughline: true });
      const once = refineScenePlan(p, opts(aspect)).plan;
      const twice = refineScenePlan(once, opts(aspect)).plan;
      assert(
        JSON.stringify(once) === JSON.stringify(twice),
        `${register}@${aspect} not idempotent:\n  once=${JSON.stringify(once.elements.map((e) => e.bounds))}\n  twice=${JSON.stringify(twice.elements.map((e) => e.bounds))}`,
      );
    }
  }
});

await check("GUARDRAIL: a THIRD pass still changes nothing (outsets cannot compound)", () => {
  const p = composeSceneLayout({ register: "centered", content: CONTENT }, "16:9");
  const a = refineScenePlan(p, opts("16:9")).plan;
  const b = refineScenePlan(a, opts("16:9")).plan;
  const c = refineScenePlan(b, opts("16:9")).plan;
  assert(JSON.stringify(b) === JSON.stringify(c), "third pass drifted");
  // And the refinement really did DO something, or this test proves nothing.
  assert(JSON.stringify(p.elements.map((e) => e.bounds)) !== JSON.stringify(a.elements.map((e) => e.bounds)), "fixture was a no-op");
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 3 — the caps
// ════════════════════════════════════════════════════════════════════════════

await check("CAP: an ink outset never exceeds MAX_INSET_FRAC of the box on either axis", () => {
  // A deliberately absurd type scale — 400px headline in a 300px box. Only the
  // cap can stop it.
  const copy = slot("copy", "text", { x: 700, y: 400, w: 500, h: 300 });
  const p = planOf("16:9", copy);
  const r = refineScenePlan(
    p,
    opts("16:9", {
      typeScaleFor: () => ({ headlinePx: 400, bodyPx: 40, headlineLineHeight: 3, bodyLineHeight: 1.5, step: 0, downshifted: false }),
    }),
  );
  const out = rectOf(r.plan, "copy");
  assert(out.h - 300 <= Math.ceil(2 * MAX_INSET_FRAC * 300) + 1, `height grew ${out.h - 300}px, past the cap`);
  assert(out.w - 500 <= Math.ceil(2 * MAX_INSET_FRAC * 500) + 1, `width grew ${out.w - 500}px, past the cap`);
});

await check("CAP: focal bleed is bounded by BOTH the canvas fraction and the box fraction", () => {
  const { w: W, h: H } = CANVAS["16:9"];
  const canvasCap = Math.round(FOCAL_BLEED_FRAC * Math.min(W, H));

  // (a) A LARGE focal element in open space — the canvas cap binds.
  const big = slot("hero", "diegetic", { x: 600, y: 300, w: 700, h: 400 });
  const rBig = refineScenePlan(planOf("16:9", big), opts("16:9", { typeScaleFor: () => undefined }));
  const outBig = rectOf(rBig.plan, "hero");
  assert(outBig.x >= 600 - canvasCap, `bled ${600 - outBig.x}px left, past the ${canvasCap}px canvas cap`);
  assert(outBig.w <= 700 + 2 * canvasCap, `width grew ${outBig.w - 700}px, past 2×${canvasCap}`);

  // (b) A SMALL focal element in the same open space — the box cap binds first,
  //     so a tiny element cannot be inflated out of proportion to itself.
  const small = slot("hero", "diegetic", { x: 900, y: 500, w: 160, h: 120 });
  const rSmall = refineScenePlan(planOf("16:9", small), opts("16:9", { typeScaleFor: () => undefined }));
  const outSmall = rectOf(rSmall.plan, "hero");
  const boxCap = Math.round(MAX_BLEED_BOX_FRAC * 120);
  assert(boxCap < canvasCap, "fixture must have the box cap bind (else it proves nothing)");
  assert(outSmall.w <= 160 + 2 * boxCap, `small element grew ${outSmall.w - 160}px wide, past 2×${boxCap}`);
  assert(outSmall.h <= 120 + 2 * boxCap, `small element grew ${outSmall.h - 120}px tall, past 2×${boxCap}`);
});

await check("CAP: the optical lift is exactly OPTICAL_CENTER_RISE_FRAC of the container height", () => {
  const { h: H } = CANVAS["16:9"];
  const hero = slot("hero", "diegetic", { x: 660, y: 340, w: 600, h: 400 }); // cy = 540 = H/2
  const r = refineScenePlan(planOf("16:9", hero), opts("16:9", { typeScaleFor: () => undefined }));
  const el = (r.plan.elements.find((e) => e.id === "hero") as { opticalAdjustments?: string[] }).opticalAdjustments ?? [];
  assert(el.includes("optical-center"), `expected a lift, got ${JSON.stringify(el)}`);
  // The lift moves the TOP edge up by the rise; the bleed then grows both edges
  // equally, so the rise is recoverable from the center's displacement.
  const out = rectOf(r.plan, "hero");
  const cyBefore = 340 + 400 / 2;
  const cyAfter = out.y + out.h / 2;
  assert(
    Math.abs(cyBefore - cyAfter - Math.round(OPTICAL_CENTER_RISE_FRAC * H)) <= 1,
    `center moved ${cyBefore - cyAfter}px, expected ${Math.round(OPTICAL_CENTER_RISE_FRAC * H)}px`,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 4 — title-safe
// ════════════════════════════════════════════════════════════════════════════

await check("title-safe is SMPTE 90%: 16:9 → 1728×972 at (96,54)", () => {
  const s = titleSafeRect("16:9");
  assert(s.x === 96 && s.y === 54 && s.w === 1728 && s.h === 972, `got ${JSON.stringify(s)}`);
  assert(TITLE_SAFE_FRAC === 0.9, "TITLE_SAFE_FRAC drifted off the SMPTE convention");
  // Text is clamped to title-safe; a visual treatment gets the frame (minus the
  // bottom reserve) — that difference IS what "bleed" means.
  assert(refineRegionFor("text", "16:9").w === 1728, "text region must be title-safe");
  assert(refineRegionFor("diegetic", "16:9").w === 1920, "a visual region must be the full frame width");
});

await check("TITLE-SAFE: a text box flush against the safe edge is never pushed out", () => {
  const s = titleSafeRect("16:9");
  const copy = slot("copy", "text", { x: s.x, y: s.y, w: 900, h: 500 });
  const r = refineScenePlan(planOf("16:9", copy), opts("16:9"));
  const out = rectOf(r.plan, "copy");
  assert(out.x >= s.x, `pushed left of title-safe: ${out.x} < ${s.x}`);
  assert(out.y >= s.y, `pushed above title-safe: ${out.y} < ${s.y}`);
  assert(out.x + out.w <= s.x + s.w, "pushed right of title-safe");
  assert(out.y + out.h <= s.y + s.h, "pushed below title-safe");
});

await check("TITLE-SAFE: an element ALREADY outside is never pushed further out — nor dragged in", () => {
  // The head parked this copy column at x=20, well left of title-safe. The pass
  // must not make that worse, and must not silently "fix" it either: that is a
  // layout change nobody asked for, and P1's ladder owns that box.
  const copy = slot("copy", "text", { x: 20, y: 400, w: 700, h: 300 });
  const r = refineScenePlan(planOf("16:9", copy), opts("16:9"));
  const out = rectOf(r.plan, "copy");
  assert(out.x >= 20, `pushed FURTHER out: ${out.x} < 20`);
  assert(out.x <= 96, `dragged INTO title-safe (an un-asked-for layout change): ${out.x}`);
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 5 — the no-op is byte-identical
// ════════════════════════════════════════════════════════════════════════════

await check("NO-OP: a frame needing no refinement comes back BY REFERENCE", () => {
  // A full-bleed hero has zero room on every edge and is not "centered in a
  // large field"; the copy has no type scale, so no ink inset. Nothing to do.
  const { w: W, h: H } = CANVAS["16:9"];
  const hero = slot("hero", "diegetic", { x: 0, y: 0, w: W, h: H }, ["atmosphere", "copy", "chrome"]);
  const copy = slot("copy", "text", { x: 120, y: 560, w: 900, h: 380 });
  const p = planOf("16:9", hero, copy);
  const r = refineScenePlan(p, opts("16:9", { typeScaleFor: () => undefined }));
  assert(r.plan === p, "a no-op must return the INPUT object, not a structural copy");
  assert(r.adjusted.length === 0 && r.reverted.length === 0, "no-op must report nothing");
  assert(r.summary === "optical-refine: no-op", `summary: ${r.summary}`);
});

await check("NO-OP: a plan of only exempt slots (atmosphere + chrome) is untouched", () => {
  const p: ScenePlan = {
    register: "centered",
    elements: [atmosphere("16:9"), slot("chrome", "chrome", { x: 0, y: 1008, w: 1920, h: 72 })],
  };
  const r = refineScenePlan(p, opts("16:9"));
  assert(r.plan === p, "exempt-only plan must come back by reference");
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 6 — the flag
// ════════════════════════════════════════════════════════════════════════════

await check("FLAG: off by default; only explicit on-values enable it", () => {
  assert(!opticalRefineEnabled({}), "must be OFF when unset");
  assert(!opticalRefineEnabled({ RB_OPTICAL_REFINE: "off" }), "off must be off");
  assert(!opticalRefineEnabled({ RB_OPTICAL_REFINE: "" }), "empty must be off");
  assert(!opticalRefineEnabled({ RB_OPTICAL_REFINE: "maybe" }), "an unknown value must be off");
  for (const v of ["on", "ON", " on ", "1", "true", "yes"]) {
    assert(opticalRefineEnabled({ RB_OPTICAL_REFINE: v }), `"${v}" should enable`);
  }
});

await check("FLAG: maybeRefineScenePlan is a pure pass-through when off, and refines when on", () => {
  const p = composeSceneLayout({ register: "centered", content: CONTENT }, "16:9");
  assert(maybeRefineScenePlan(p, opts("16:9"), {}) === p, "flag off must return the input by reference");
  const on = maybeRefineScenePlan(p, opts("16:9"), { RB_OPTICAL_REFINE: "on" });
  assert(on !== p, "flag on must refine");
  assert(JSON.stringify(on.elements.map((e) => e.bounds)) !== JSON.stringify(p.elements.map((e) => e.bounds)), "flag on changed nothing");
});

await check("FLAG: an internal throw ships the INPUT plan — polish can never break a build", () => {
  const p = composeSceneLayout({ register: "centered", content: CONTENT }, "16:9");
  const boom = maybeRefineScenePlan(
    p,
    opts("16:9", {
      typeScaleFor: () => {
        throw new Error("synthetic failure");
      },
    }),
    { RB_OPTICAL_REFINE: "on" },
  );
  assert(boom === p, "a throw must degrade to the input plan, not propagate");
});

// ════════════════════════════════════════════════════════════════════════════
// ADJUSTMENT 1 — per-type ink insets
// ════════════════════════════════════════════════════════════════════════════

await check("INK INSET: derived from the type scale — asymmetric (top ≫ bottom) and size-proportional", () => {
  const m = fallbackMetrics("Test Sans", 700);
  const s = (px: number) => ({ headlinePx: px, bodyPx: 20, headlineLineHeight: 1.1, bodyLineHeight: 1.5, step: 2, downshifted: false });
  const at68 = inkInsetFor(s(68), m);
  const at34 = inkInsetFor(s(34), m);

  assert(at68.top > at68.bottom * 3, `top ${at68.top} must dominate bottom ${at68.bottom} — ink hangs LOW in its box`);
  assert(Math.abs(at68.top / at34.top - 2) < 1e-6, "the inset must scale linearly with type size");
  assert(at68.side > 0 && at68.side < at68.top, "side bearing is real but smaller than the leading band");
  assert(inkInsetFor(s(0), m).top === 0, "a zero type scale yields no inset");

  // The confidence factor is applied, not ignored: the raw geometric band for
  // Inter-like metrics is (0.8·1.2 − 0.71)·size = 0.25·size.
  const raw = 0.25 * 68;
  assert(Math.abs(at68.top - INK_INSET_CONFIDENCE * raw) < 0.5, `top ${at68.top} does not match ${INK_INSET_CONFIDENCE}×${raw}`);
});

await check("INK INSET: a taller line-height widens the band (half-leading is real)", () => {
  const m = fallbackMetrics("Test Sans", 700);
  const tight = inkInsetFor({ headlinePx: 60, bodyPx: 20, headlineLineHeight: 1.1, bodyLineHeight: 1.5, step: 2, downshifted: false }, m);
  const loose = inkInsetFor({ headlinePx: 60, bodyPx: 20, headlineLineHeight: 1.8, bodyLineHeight: 1.5, step: 2, downshifted: false }, m);
  assert(loose.top > tight.top, "extra leading must widen the top band");
  assert(loose.bottom > tight.bottom, "extra leading must widen the bottom band too");
});

await check("INK INSET: OUTSETS the text box, and lifts it more than it drops it", () => {
  const p = composeSceneLayout({ register: "centered", content: CONTENT }, "16:9");
  const before = rectOf(p, "copy");
  const r = refineScenePlan(p, opts("16:9"));
  const after = rectOf(r.plan, "copy");
  assert(after.y < before.y, `copy must move UP to meet its ink: ${after.y} vs ${before.y}`);
  assert(after.h > before.h, "the box must grow, not merely shift");
  const up = before.y - after.y;
  const down = after.y + after.h - (before.y + before.h);
  assert(up > down, `the correction must be asymmetric: up ${up} vs down ${down}`);
  const adj = (r.adjusted.find((a) => a.id === "copy")?.adjustments ?? []) as string[];
  assert(adj.includes("ink-inset"), `expected ink-inset, got ${JSON.stringify(adj)}`);
});

await check("INK INSET: role-aware — a diegetic hero's box IS its visual edge, so it gets none", () => {
  const hero = slot("hero", "diegetic", { x: 600, y: 700, w: 700, h: 250 });
  const r = refineScenePlan(planOf("16:9", hero), opts("16:9"));
  const adj = (r.adjusted.find((a) => a.id === "hero")?.adjustments ?? []) as string[];
  assert(!adj.includes("ink-inset"), `a non-text slot must not get an ink inset: ${JSON.stringify(adj)}`);
});

await check("INK INSET: skipped entirely when the type scale is unknown (never guessed)", () => {
  const p = composeSceneLayout({ register: "centered", content: CONTENT }, "16:9");
  const r = refineScenePlan(p, opts("16:9", { typeScaleFor: () => undefined }));
  const adj = (r.adjusted.find((a) => a.id === "copy")?.adjustments ?? []) as string[];
  assert(!adj.includes("ink-inset"), "no type scale must mean no ink inset");
});

// ════════════════════════════════════════════════════════════════════════════
// ADJUSTMENT 2 — optical centering
// ════════════════════════════════════════════════════════════════════════════

await check("OPTICAL CENTER: applies to a centered element floating in a large field", () => {
  const canvas = { x: 0, y: 0, ...CANVAS["16:9"] };
  assert(isCenteredFocal({ x: 660, y: 340, w: 600, h: 400 }, canvas), "a centered floating box must qualify");
});

await check("OPTICAL CENTER: does NOT apply to an anchored or a frame-spanning element", () => {
  const canvas = { x: 0, y: 0, ...CANVAS["16:9"] };
  assert(!isCenteredFocal({ x: 560, y: 700, w: 800, h: 280 }, canvas), "a bottom-anchored band is not centered");
  assert(!isCenteredFocal({ x: 200, y: 40, w: 800, h: 280 }, canvas), "a top-pinned box is not centered");
  const need = OPTICAL_CENTER_MIN_MARGIN_FRAC * 1080;
  assert(
    !isCenteredFocal({ x: 200, y: Math.floor(need) - 10, w: 800, h: 1080 - 2 * (Math.floor(need) - 10) }, canvas),
    "a near-full-height column's centering is incidental, not designed",
  );
});

await check("OPTICAL CENTER: only the FOCAL element is lifted, never every centered box", () => {
  // Two centered boxes; only the rank-1 focal earns the lift.
  const hero = slot("hero", "diegetic", { x: 1100, y: 340, w: 600, h: 400 });
  const copy = slot("copy", "text", { x: 200, y: 340, w: 700, h: 400 });
  const r = refineScenePlan(planOf("16:9", hero, copy), opts("16:9", { typeScaleFor: () => undefined }));
  const heroAdj = (r.adjusted.find((a) => a.id === "hero")?.adjustments ?? []) as string[];
  const copyAdj = (r.adjusted.find((a) => a.id === "copy")?.adjustments ?? []) as string[];
  assert(heroAdj.includes("optical-center"), `the focal element must be lifted: ${JSON.stringify(heroAdj)}`);
  assert(!copyAdj.includes("optical-center"), `a non-focal centered box must NOT be lifted: ${JSON.stringify(copyAdj)}`);
});

await check("OPTICAL CENTER: the head's focalRank overrides the hero convention", () => {
  const hero = slot("hero", "diegetic", { x: 1100, y: 340, w: 600, h: 400 });
  const copy = slot("copy", "text", { x: 200, y: 340, w: 700, h: 400 });
  const p = planOf("16:9", hero, copy);
  assert(focalSlotId(p) === "hero", "without a composition, hero is focal by convention");
  const composition = { elements: [{ role: "copy", focalRank: 1 }, { role: "hero", focalRank: 2 }] } as never;
  assert(focalSlotId(p, composition) === "copy", "a declared focalRank 1 must win");
});

// ════════════════════════════════════════════════════════════════════════════
// ADJUSTMENT 3 — focal bleed
// ════════════════════════════════════════════════════════════════════════════

await check("FOCAL BLEED: expands into declared-empty space, and NOT toward an occupied edge", () => {
  // copy sits directly LEFT of hero with a tight gutter; the right side is open.
  const hero = slot("hero", "diegetic", { x: 1000, y: 400, w: 600, h: 300 });
  const copy = slot("copy", "text", { x: 200, y: 400, w: 795, h: 300 }); // 5px gutter
  const r = refineScenePlan(planOf("16:9", hero, copy), opts("16:9", { typeScaleFor: () => undefined }));
  const out = rectOf(r.plan, "hero");
  assert(out.x >= 1000, `hero must NOT bleed left into copy's gutter: ${out.x}`);
  assert(out.x + out.w > 1600, `hero must bleed right into open space: ${out.x + out.w}`);
  assert(!overlap(out, rectOf(r.plan, "copy")), "bleed must never create an overlap");
});

await check("FOCAL BLEED: never applied to a text element (it would invalidate its capacity budget)", () => {
  // copy is declared rank-1 focal AND has open space on every side.
  const copy = slot("copy", "text", { x: 700, y: 400, w: 500, h: 300 });
  const composition = { elements: [{ role: "copy", focalRank: 1 }] } as never;
  const r = refineScenePlan(planOf("16:9", copy), opts("16:9", { composition, typeScaleFor: () => undefined }));
  const adj = (r.adjusted.find((a) => a.id === "copy")?.adjustments ?? []) as string[];
  assert(!adj.includes("focal-bleed"), `text must never bleed: ${JSON.stringify(adj)}`);
});

await check("FOCAL BLEED: never crosses the bottom reserve (the containment contract)", () => {
  const { h: H } = CANVAS["16:9"];
  const reserve = Math.floor(0.965 * H);
  const hero = slot("hero", "diegetic", { x: 600, y: 800, w: 700, h: 240 }); // bottom = 1040, just inside
  const r = refineScenePlan(planOf("16:9", hero), opts("16:9", { typeScaleFor: () => undefined }));
  const out = rectOf(r.plan, "hero");
  assert(out.y + out.h <= reserve, `bled past the bottom reserve: ${out.y + out.h} > ${reserve}`);
});

await check("EXEMPT: the throughline motif is NEVER moved (its position is a cross-scene contract)", () => {
  // Pinned to throughlineAnchorFor(aspect) so the cross-scene drift gate passes
  // by construction. Even a legal bleed would trade "identical in every scene"
  // for "still inside the tolerance" — a strictly worse guarantee.
  for (const aspect of ASPECTS) {
    const p = composeSceneLayout({ register: "centered", content: CONTENT }, aspect, { hasThroughline: true });
    const before = rectOf(p, "throughline");
    // Declared rank-1 focal, to prove the exemption beats even an explicit vote.
    const composition = { elements: [{ role: "throughline", focalRank: 1 }] } as never;
    const r = refineScenePlan(p, opts(aspect, { composition }));
    assert(focalSlotId(p, composition) !== "throughline", "the motif must never be selectable as focal");
    assert(JSON.stringify(rectOf(r.plan, "throughline")) === JSON.stringify(before), `motif moved at ${aspect}`);
  }
});

await check("EXEMPT: atmosphere and chrome are never moved either", () => {
  const p = composeSceneLayout({ register: "centered", content: CONTENT }, "16:9", { hasThroughline: true });
  const before = { atmosphere: rectOf(p, "atmosphere"), chrome: rectOf(p, "chrome") };
  const r = refineScenePlan(p, opts("16:9"));
  assert(JSON.stringify(rectOf(r.plan, "atmosphere")) === JSON.stringify(before.atmosphere), "atmosphere moved");
  assert(JSON.stringify(rectOf(r.plan, "chrome")) === JSON.stringify(before.chrome), "chrome bar moved");
});

// ════════════════════════════════════════════════════════════════════════════
// edgeRoom — the emptiness measurement the growths share
// ════════════════════════════════════════════════════════════════════════════

await check("edgeRoom: measures to the region when empty, and to the neighbour when not", () => {
  const region = { x: 0, y: 0, w: 1000, h: 1000 };
  const r = { x: 400, y: 400, w: 200, h: 200 };
  const empty = edgeRoom(r, [], region, 0);
  assert(empty.top === 400 && empty.left === 400 && empty.right === 400 && empty.bottom === 400, `open room wrong: ${JSON.stringify(empty)}`);

  const withNeighbour = edgeRoom(r, [{ x: 400, y: 250, w: 200, h: 100 }], region, 10);
  assert(withNeighbour.top === 40, `top room should stop 10px short of the neighbour at 350: ${withNeighbour.top}`);
  assert(withNeighbour.bottom === 400, "an above-neighbour must not constrain the bottom edge");
});

await check("edgeRoom: an ALREADY-overlapping neighbour blocks nothing (declared overlaps stay declared)", () => {
  const region = { x: 0, y: 0, w: 1000, h: 1000 };
  const r = { x: 400, y: 400, w: 200, h: 200 };
  // A full-bleed treatment the element already sits on top of.
  const room = edgeRoom(r, [{ x: 0, y: 0, w: 1000, h: 1000 }], region, 10);
  assert(room.top === 400 && room.bottom === 400 && room.left === 400 && room.right === 400, `overlapping neighbour must not constrain: ${JSON.stringify(room)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
