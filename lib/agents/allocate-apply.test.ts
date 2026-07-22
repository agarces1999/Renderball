/**
 * Tests for allocate-apply — the RB_ALLOCATE ink-based allocator post-pass.
 * Run: `node scripts/run-tests.mjs lib/agents/allocate-apply.test.ts`
 * (no API key, no network, no filesystem).
 *
 * The contracts under test, in the order the founder's brief lists them:
 *   1. HERO PASS-THROUGH — the head's hero bounds ship byte-identical.
 *   2. BOX = INK + PADDING — a flattering text box shrinks to its own
 *      predicted ink; the derivation and the budget/box consistency mechanism
 *      (type-scale step stability) live in predict-ink.test.ts and are
 *      re-asserted here THROUGH the pass.
 *   3. THROUGHLINE ANCHOR — the per-video anchor contract survives verbatim
 *      (the pipeline's "embedded motif stays a child" analogue: the pinned
 *      cross-scene box is never re-placed).
 *   4. NO-REGRESSION GUARD — an applied scene never measures worse on the ink
 *      instrument; the in-place tier is byte-identical on ink by construction.
 *   5. VALIDATE — the pass's output introduces no plan violation.
 *   6. DETERMINISM — identical input, byte-identical output.
 *   7. FLAG OFF = BYTE-IDENTICAL PIPELINE — the input ARRAY itself is
 *      returned (reference equality, not structural).
 */
import { composeSceneLayout, validateScenePlan, type ScenePlan, type ElementSlot } from "./layout-composer";
import { allocateScenePlans, maybeAllocateScenePlans, allocateEnabled, type AllocateApplyCtx } from "./allocate-apply";
import { typicalSansMetrics } from "./predict-ink";
import { deriveTypeScale } from "../render/type-scale";
import { capacityFor } from "../render/capacity";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const METRICS = typicalSansMetrics();

// ── Fixture: a realistic composed scene (the notion-s2 shape: a tall side
// column whose declared box flatters its ink — the founder's own example) ──
const CONTENT: Record<string, unknown> = {
  eyebrow: "THE TURN",
  headline: "Agents pick up the work",
  lede: "Custom Agents assign, prioritize, and route tasks on their own — summarizing, writing, and sending reports while you focus elsewhere.",
  bullets: ["Assigns and routes on its own", "Searches across all your apps", "Keeps work moving 24/7"],
};
const COMPOSITION = {
  atmosphere: "quiet gradient wash",
  elements: [
    { role: "hero", subject: "workspace panel", focalRank: 1, bounds: { x: 60, y: 80, w: 920, h: 920 }, interior: [], ownsCopy: [], motion: "" },
    { role: "copy", subject: "editorial stack", focalRank: 2, bounds: { x: 1040, y: 214, w: 800, h: 666 }, interior: [], ownsCopy: ["eyebrow", "headline", "lede", "bullets"], motion: "" },
  ],
} as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;

const composedPlan = (): ScenePlan =>
  composeSceneLayout({ register: "split", content: CONTENT, composition: COMPOSITION }, "16:9", { hasThroughline: true });

const ctxFor = (plans: ScenePlan[]): AllocateApplyCtx => ({
  aspect: "16:9",
  scenes: plans.map(() => ({ content: CONTENT, composition: COMPOSITION })),
  ownedFieldsFor: (_i, slot) =>
    slot.id === "copy" ? ["eyebrow", "headline", "lede", "bullets"] : slot.contentFields,
  metricsFor: () => METRICS,
});

const el = (plan: ScenePlan, id: string): ElementSlot => {
  const found = plan.elements.find((e) => e.id === id);
  if (!found) throw new Error(`fixture plan has no "${id}" slot`);
  return found;
};

check("flag off (the default): the input ARRAY is returned by reference", () => {
  const plans = [composedPlan()];
  const r = maybeAllocateScenePlans(plans, ctxFor(plans), {});
  assert(r.plans === plans, "flag-off must return the same array object, not a copy");
  assert(r.enabled === false && r.records.length === 0, "flag-off must report disabled with no records");
  assert(allocateEnabled({}) === false, "empty env must read as disabled");
  assert(allocateEnabled({ RB_ALLOCATE: "on" }) === true, "RB_ALLOCATE=on must enable");
  assert(allocateEnabled({ RB_ALLOCATE: "off" }) === false, "RB_ALLOCATE=off must stay disabled");
});

check("hero passes through byte-identical; throughline keeps its anchor verbatim", () => {
  const plan = composedPlan();
  const heroBefore = JSON.stringify(el(plan, "hero").bounds);
  const motifBefore = JSON.stringify(el(plan, "throughline").bounds);
  const r = allocateScenePlans([plan], ctxFor([plan]));
  const out = r.plans[0];
  assert(JSON.stringify(el(out, "hero").bounds) === heroBefore, "hero bounds must never change");
  assert(JSON.stringify(el(out, "throughline").bounds) === motifBefore, "the throughline's per-video anchor box must never change");
  assert(!r.records[0].moved.includes("hero") && !r.records[0].resized.some((x) => x.id === "hero"), "hero must appear in no change list");
});

check("a flattering copy box shrinks to ink+padding and the freed px are accounted", () => {
  const plan = composedPlan();
  const before = el(plan, "copy").bounds;
  const r = allocateScenePlans([plan], ctxFor([plan]));
  const rec = r.records[0];
  assert(rec.applied, `expected the scene to apply, got reason=${rec.reason}`);
  const after = el(r.plans[0], "copy").bounds;
  assert(after.h < before.h, `copy must shrink (${before.h} → ${after.h})`);
  assert(after.w === before.w, "the measure (width) is preserved — the ink was wrapped at it");
  const resized = rec.resized.find((x) => x.id === "copy");
  assert(!!resized, "the shrink must be recorded");
  assert(rec.freedPxTotal > 0 && !!rec.freedTo, "freed px must be accounted with a destination");
  assert(rec.inkVoidBefore !== null && rec.inkVoidAfter !== null, "ink-void telemetry must be measured");
});

check("budget/box consistency THROUGH the pass: the sized box derives the same type-scale step and a real capacity", () => {
  const plan = composedPlan();
  const stepBefore = deriveTypeScale({ role: "copy", box: { w: el(plan, "copy").bounds.w, h: el(plan, "copy").bounds.h }, canvas: { w: 1920, h: 1080 } }).step;
  const r = allocateScenePlans([plan], ctxFor([plan]));
  const after = el(r.plans[0], "copy").bounds;
  const scaleAfter = deriveTypeScale({ role: "copy", box: { w: after.w, h: after.h }, canvas: { w: 1920, h: 1080 } });
  assert(scaleAfter.step === stepBefore, `sizing-to-ink drifted the type-scale step ${stepBefore} → ${scaleAfter.step} — box and budget would disagree`);
  const cap = capacityFor({ w: after.w, h: after.h }, scaleAfter, METRICS);
  assert(cap.headlineChars > 0 && cap.maxRows > 0, "the sized box must still afford a real capacity budget");
});

check("the pass's output introduces NO plan violation (re-validated, like the pipeline does)", () => {
  const plan = composedPlan();
  const r = allocateScenePlans([plan], ctxFor([plan]));
  const before = validateScenePlan(plan, "16:9", { composition: COMPOSITION, content: CONTENT }).map((v) => `${v.pieceId}:${v.kind}`);
  const after = validateScenePlan(r.plans[0], "16:9", { composition: COMPOSITION, content: CONTENT }).map((v) => `${v.pieceId}:${v.kind}`);
  const introduced = after.filter((v) => !before.includes(v));
  assert(introduced.length === 0, `allocation introduced violations: ${introduced.join(", ")}`);
});

check("no-regression guard: an applied scene never measures worse on ink (both tiers)", () => {
  const plan = composedPlan();
  const r = allocateScenePlans([plan], ctxFor([plan]));
  const rec = r.records[0];
  assert(rec.applied, `expected applied, got ${rec.reason}`);
  assert(
    rec.inkVoidBefore !== null && rec.inkVoidAfter !== null && rec.inkVoidAfter <= rec.inkVoidBefore + 0.005,
    `ink-void regressed ${rec.inkVoidBefore} → ${rec.inkVoidAfter}`,
  );
  assert(rec.placement === "distributed" || rec.placement === "in-place", "an applied scene must name its tier");
  if (rec.placement === "in-place") {
    assert(rec.inkVoidAfter === rec.inkVoidBefore, "in-place shrink must leave the ink view byte-identical");
  }
});

check("an untouchable scene ships the INPUT PLAN OBJECT (reference), with the reason recorded", () => {
  // A copy box SHORTER than the smallest step's scale floor (~90px @16:9) is
  // kept by construction — ink+padding can never undercut it. That is the
  // honest "the declared box already tells the truth" class.
  const tinyContent = { headline: "Hi" };
  const tinyComp = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "panel", focalRank: 1, bounds: { x: 400, y: 200, w: 900, h: 560 }, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "stack", focalRank: 2, bounds: { x: 400, y: 840, w: 900, h: 64 }, interior: [], ownsCopy: ["headline"], motion: "" },
    ],
  } as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;
  const plan = composeSceneLayout({ register: "centered", content: tinyContent, composition: tinyComp }, "16:9", { hasThroughline: false });
  const ctx: AllocateApplyCtx = {
    aspect: "16:9",
    scenes: [{ content: tinyContent, composition: tinyComp }],
    ownedFieldsFor: (_i, slot) => (slot.id === "copy" ? ["headline"] : slot.contentFields),
    metricsFor: () => METRICS,
  };
  const r = allocateScenePlans([plan], ctx);
  assert(r.plans[0] === plan, "an untouched scene must ship the input plan by reference");
  assert(!r.records[0].applied && /no-text-to-size/.test(r.records[0].reason ?? ""), `expected no-text-to-size, got ${r.records[0].reason}`);
});

check("deterministic: identical input → byte-identical plans and records", () => {
  const mk = () => {
    const plan = composedPlan();
    return allocateScenePlans([plan], ctxFor([plan]));
  };
  const a = mk();
  const b = mk();
  assert(JSON.stringify(a.plans) === JSON.stringify(b.plans), "plans differ across identical runs");
  assert(JSON.stringify(a.records) === JSON.stringify(b.records), "records differ across identical runs");
});

check("a text element with NO owned strings is never touched", () => {
  const bare = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "panel", focalRank: 1, bounds: { x: 60, y: 80, w: 920, h: 920 }, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "stack", focalRank: 2, bounds: { x: 1040, y: 214, w: 800, h: 666 }, interior: [], ownsCopy: [], motion: "" },
    ],
  } as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;
  const plan = composeSceneLayout({ register: "split", content: {}, composition: bare }, "16:9", { hasThroughline: false });
  const before = JSON.stringify(el(plan, "copy").bounds);
  const ctx: AllocateApplyCtx = {
    aspect: "16:9",
    scenes: [{ content: {}, composition: bare }],
    ownedFieldsFor: () => [],
    metricsFor: () => METRICS,
  };
  const r = allocateScenePlans([plan], ctx);
  assert(JSON.stringify(el(r.plans[0], "copy").bounds) === before, "string-less copy must pass through verbatim");
  assert(!r.records[0].applied && /no-strings=1/.test(r.records[0].reason ?? ""), `expected a no-strings skip, got ${r.records[0].reason}`);
});

check("the record's bounds map is the complete, diffable final geometry", () => {
  const plan = composedPlan();
  const r = allocateScenePlans([plan], ctxFor([plan]));
  const rec = r.records[0];
  for (const slot of r.plans[0].elements) {
    const b = rec.bounds[slot.id];
    assert(!!b, `record.bounds missing "${slot.id}"`);
    assert(
      b.x === Math.round(slot.bounds.x) && b.y === Math.round(slot.bounds.y) && b.w === Math.round(slot.bounds.w) && b.h === Math.round(slot.bounds.h),
      `record.bounds["${slot.id}"] disagrees with the shipped plan`,
    );
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
