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
import {
  allocateScenePlans,
  maybeAllocateScenePlans,
  allocateEnabled,
  growHeroBounds,
  heroVoidSide,
  CATASTROPHIC_INK_VOID,
  HERO_GROWTH_AREA_CAP,
  type AllocateApplyCtx,
} from "./allocate-apply";
import { contentRect } from "./allocate-layout";
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

check("an untouchable scene ships the INPUT PLAN OBJECT (reference), with the reason + measured void recorded", () => {
  // A copy box SHORTER than the smallest step's scale floor (~90px @16:9) is
  // kept by construction — ink+padding can never undercut it. That is the
  // honest "the declared box already tells the truth" class. The layout is
  // deliberately WELL-FILLED (void under the catastrophic bar) — since the
  // gate fix, "nothing to size" alone is no longer enough to be untouchable.
  const tinyContent = { headline: "Hi" };
  const tinyComp = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "panel", focalRank: 1, bounds: { x: 200, y: 150, w: 1400, h: 700 }, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "stack", focalRank: 2, bounds: { x: 200, y: 880, w: 1400, h: 80 }, interior: [], ownsCopy: ["headline"], motion: "" },
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
  const rec = r.records[0];
  assert(r.plans[0] === plan, "an untouched scene must ship the input plan by reference");
  assert(!rec.applied && /no-text-to-size/.test(rec.reason ?? ""), `expected no-text-to-size, got ${rec.reason}`);
  assert(rec.inkVoidBefore !== null && rec.inkVoidBefore < CATASTROPHIC_INK_VOID, `fixture must sit under the catastrophic bar, got ${rec.inkVoidBefore}`);
  assert(/void=\d/.test(rec.reason ?? ""), `kept reason must carry the measured void (the null that hid the gate bug), got ${rec.reason}`);
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

// ─── GATE FIX (2026-07-22) — decoupled void repair + capped hero growth ────
//
// The live-Notion-s0 shape: a wide shallow hero mid-frame, a copy band above
// it, and a catastrophic (~33%) dead band below the hero. No text needs
// sizing (the copy owns no strings here, so it is pinned — the conservative
// class), which under the OLD gate meant the scene was never even attempted.
const mkVoidScene = (heroBounds: { x: number; y: number; w: number; h: number }) => {
  const comp = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "status card", focalRank: 1, bounds: heroBounds, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "headline band", focalRank: 2, bounds: { x: 310, y: 90, w: 1300, h: 280 }, interior: [], ownsCopy: [], motion: "" },
    ],
  } as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;
  const plan = composeSceneLayout({ register: "centered", content: {}, composition: comp }, "16:9", { hasThroughline: false });
  const ctx: AllocateApplyCtx = {
    aspect: "16:9",
    scenes: [{ content: {}, composition: comp }],
    ownedFieldsFor: () => [],
    metricsFor: () => METRICS,
  };
  return { plan, ctx };
};

check("DECOUPLED TRIGGER: a catastrophic void with no text-to-size is TRIED, not kept as no-text-to-size", () => {
  const { plan, ctx } = mkVoidScene({ x: 540, y: 390, w: 840, h: 320 });
  const r = allocateScenePlans([plan], ctx, { heroGrowth: false });
  const rec = r.records[0];
  assert(rec.inkVoidBefore !== null && rec.inkVoidBefore >= CATASTROPHIC_INK_VOID, `fixture must be catastrophic, got ${rec.inkVoidBefore}`);
  assert(!/no-text-to-size/.test(rec.reason ?? ""), `the never-tried reason must NOT appear on a catastrophic scene (got ${rec.reason})`);
  // Everything is pinned here (no strings anywhere), so the distribution is a
  // no-op and the guard keeps it — but with the TRIED-AND-GUARDED vocabulary.
  assert(!rec.applied && /^void-(no-improvement|unresolved-separation|allocate-threw)/.test(rec.reason ?? ""), `expected a void-* guard reason, got ${rec.reason}`);
  assert(r.plans[0] === plan, "a guarded void-repair attempt must still ship the input plan by reference");
});

check("BASELINE KNOB (voidRepair:false) restores the pre-fix gate exactly", () => {
  const { plan, ctx } = mkVoidScene({ x: 540, y: 390, w: 840, h: 320 });
  const r = allocateScenePlans([plan], ctx, { voidRepair: false, heroGrowth: false });
  const rec = r.records[0];
  assert(!rec.applied && /no-text-to-size/.test(rec.reason ?? ""), `baseline arm must keep with no-text-to-size, got ${rec.reason}`);
  assert(r.plans[0] === plan, "baseline arm must ship the input plan by reference");
  assert(rec.inkVoidBefore !== null, "even the baseline arm records the measured void (telemetry fix)");
});

check("HERO GROWTH: fills a hero-adjacent catastrophic void — capped, aspect-true, containing, separately reported", () => {
  const { plan, ctx } = mkVoidScene({ x: 540, y: 390, w: 840, h: 320 });
  const before = { ...el(plan, "hero").bounds };
  const r = allocateScenePlans([plan], ctx); // both fixes on (the shipping posture)
  const rec = r.records[0];
  assert(rec.applied, `expected the growth tier to act, got reason=${rec.reason} skip=${rec.heroGrowthSkipped}`);
  assert(!!rec.heroGrowth, `heroGrowth must be recorded (skip=${rec.heroGrowthSkipped})`);
  assert(/^void-/.test(rec.reason ?? ""), `the distribution outcome must stay visible on a growth-only scene, got ${rec.reason}`);
  assert(rec.placement === undefined, "a growth-only scene must not claim a distribution placement");
  assert(rec.resized.length === 0, "growth is not a text resize and must not appear in resized[]");
  const after = el(r.plans[0], "hero").bounds;
  const areaFactor = (after.w * after.h) / (before.w * before.h);
  assert(areaFactor > 1.0 && areaFactor <= HERO_GROWTH_AREA_CAP + 0.01, `area factor ${areaFactor.toFixed(3)} must be within (1, ${HERO_GROWTH_AREA_CAP}]`);
  const aspectBefore = before.w / before.h;
  const aspectAfter = after.w / after.h;
  assert(Math.abs(aspectAfter - aspectBefore) / aspectBefore < 0.02, `aspect must be preserved (${aspectBefore.toFixed(3)} → ${aspectAfter.toFixed(3)})`);
  assert(
    after.x <= before.x && after.y <= before.y && after.x + after.w >= before.x + before.w && after.y + after.h >= before.y + before.h,
    "the grown box must CONTAIN the original (growth extends, never moves)",
  );
  const C = contentRect("16:9");
  assert(after.x >= C.x && after.y >= C.y && after.x + after.w <= C.x + C.w && after.y + after.h <= C.y + C.h, "growth must respect the title-safe content rect");
  assert(
    rec.heroGrowth!.inkVoidBefore !== null &&
      rec.heroGrowth!.inkVoidAfter !== null &&
      rec.heroGrowth!.inkVoidAfter < rec.heroGrowth!.inkVoidBefore,
    "growth must measurably improve the ink view (the guard's own record)",
  );
  // The other elements are untouched by growth.
  assert(JSON.stringify(el(r.plans[0], "copy").bounds) === JSON.stringify(el(plan, "copy").bounds), "growth must not move the copy");
});

check("HERO GROWTH determinism: identical input → byte-identical grown plans and records", () => {
  const run = () => {
    const { plan, ctx } = mkVoidScene({ x: 540, y: 390, w: 840, h: 320 });
    return allocateScenePlans([plan], ctx);
  };
  const a = run();
  const b = run();
  assert(JSON.stringify(a.plans) === JSON.stringify(b.plans), "grown plans differ across identical runs");
  assert(JSON.stringify(a.records) === JSON.stringify(b.records), "growth records differ across identical runs");
});

check("HERO GROWTH guard-revert: growth that cannot materially improve the lattice view is SKIPPED, scene untouched", () => {
  // The live-Notion-s4 shape: hero bottom at 680 sits 49px above the next
  // lattice row's centre, and the 1.3× cap buys only +42px of height — the
  // growth is instrument-invisible, so the do-no-harm rule must revert it.
  const { plan, ctx } = mkVoidScene({ x: 460, y: 380, w: 1000, h: 300 });
  const heroBefore = JSON.stringify(el(plan, "hero").bounds);
  const r = allocateScenePlans([plan], ctx);
  const rec = r.records[0];
  assert(!rec.applied, `expected the scene kept, got applied with reason=${rec.reason}`);
  assert(!rec.heroGrowth, "no heroGrowth record on a reverted growth");
  assert(/^no-improvement/.test(rec.heroGrowthSkipped ?? ""), `expected a no-improvement skip, got ${rec.heroGrowthSkipped}`);
  assert(JSON.stringify(el(r.plans[0], "hero").bounds) === heroBefore, "hero must be untouched after a guard revert");
  assert(r.plans[0] === plan, "the kept scene ships the input plan by reference");
});

check("HERO GROWTH adjacency: a catastrophic void remote from the hero never grows it", () => {
  const comp = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "chip", focalRank: 1, bounds: { x: 96, y: 54, w: 400, h: 300 }, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "column", focalRank: 2, bounds: { x: 500, y: 54, w: 500, h: 930 }, interior: [], ownsCopy: [], motion: "" },
    ],
  } as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;
  const plan = composeSceneLayout({ register: "centered", content: {}, composition: comp }, "16:9", { hasThroughline: false });
  const ctx: AllocateApplyCtx = { aspect: "16:9", scenes: [{ content: {}, composition: comp }], ownedFieldsFor: () => [], metricsFor: () => METRICS };
  const r = allocateScenePlans([plan], ctx);
  const rec = r.records[0];
  assert(rec.inkVoidBefore !== null && rec.inkVoidBefore >= CATASTROPHIC_INK_VOID, `fixture must be catastrophic, got ${rec.inkVoidBefore}`);
  assert(rec.heroGrowthSkipped === "not-hero-adjacent", `expected not-hero-adjacent, got ${rec.heroGrowthSkipped}`);
  assert(!rec.heroGrowth && JSON.stringify(el(r.plans[0], "hero").bounds) === JSON.stringify(el(plan, "hero").bounds), "hero untouched");
});

check("HERO GROWTH treatment exclusion: a canvas-treatment hero (Checkr s2 shape) is structurally unreachable", () => {
  // final-checkr s2's geometry: an 88.7%-of-frame dashboard inset 40px from
  // every edge. The void instrument EXCLUDES it (canvas treatment), so the
  // scene scores a huge artefact void — which must never arm distribution OR
  // growth. Two independent locks; the record must say so.
  const comp = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "dashboard", focalRank: 1, bounds: { x: 40, y: 40, w: 1840, h: 1000 }, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "corner copy", focalRank: 2, bounds: { x: 280, y: 820, w: 720, h: 180 }, interior: [], ownsCopy: [], motion: "" },
    ],
  } as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;
  const plan = composeSceneLayout({ register: "full-bleed", content: {}, composition: comp }, "16:9", { hasThroughline: false });
  const before = JSON.stringify(plan.elements.map((e) => e.bounds));
  const ctx: AllocateApplyCtx = { aspect: "16:9", scenes: [{ content: {}, composition: comp }], ownedFieldsFor: () => [], metricsFor: () => METRICS };
  const r = allocateScenePlans([plan], ctx);
  const rec = r.records[0];
  assert(!rec.applied && r.plans[0] === plan, "a treatment scene must ship untouched");
  assert(/no-text-to-size/.test(rec.reason ?? "") && /treatment-artifact/.test(rec.reason ?? ""), `the keep reason must name the artefact, got ${rec.reason}`);
  assert(rec.heroGrowthSkipped === "treatment-bleed", `growth must record its unreachability, got ${rec.heroGrowthSkipped}`);
  assert(JSON.stringify(r.plans[0].elements.map((e) => e.bounds)) === before, "no bounds may change on a treatment scene");
});

check("growHeroBounds geometry: cap, aspect, void-directed anchor, obstacle ladder, treatment ceiling", () => {
  const C = contentRect("16:9");
  const canvas = { w: 1920, h: 1080 };
  const hero = { x: 500, y: 400, w: 400, h: 200 };
  // Void to the RIGHT: left edge anchored, grows rightward.
  const right = growHeroBounds(hero, { x: 918, y: 378, w: 540, h: 270 }, [], C, canvas, 24);
  assert(!!right, "growth toward a right-adjacent void must succeed in the open frame");
  assert(right!.x === hero.x, "right-void growth anchors the left edge");
  assert(right!.w > hero.w && right!.h > hero.h, "both axes grow (aspect preserved)");
  assert((right!.w * right!.h) / (hero.w * hero.h) <= HERO_GROWTH_AREA_CAP + 0.01, "area cap holds");
  assert(Math.abs(right!.w / right!.h - hero.w / hero.h) < 0.05, "aspect ratio preserved");
  // Obstacle directly in the growth path: the ladder must shrink k or bail —
  // never overlap.
  const obstacle = { x: 940, y: 380, w: 200, h: 240 };
  const guarded = growHeroBounds(hero, { x: 918, y: 378, w: 540, h: 270 }, [obstacle], C, canvas, 24);
  if (guarded) {
    const overlaps = guarded.x < obstacle.x + obstacle.w && obstacle.x < guarded.x + guarded.w && guarded.y < obstacle.y + obstacle.h && obstacle.y < guarded.y + guarded.h;
    assert(!overlaps, "grown hero must stay disjoint from obstacles");
  }
  // Treatment ceiling: a hero already near 85% cannot grow at all.
  assert(growHeroBounds({ x: 40, y: 40, w: 1840, h: 1000 }, { x: 96, y: 54, w: 540, h: 270 }, [], C, canvas, 24) === null, "a treatment-size hero must never grow");
  // Remote void: not adjacent → null.
  assert(growHeroBounds(hero, { x: 1500, y: 54, w: 300, h: 300 }, [], C, canvas, 24) === null, "a remote void never grows the hero");
  // heroVoidSide sanity: lattice-quantised edges within CELL/2 read as adjacent.
  assert(heroVoidSide({ x: 96, y: 702, w: 1728, h: 324 }, { x: 540, y: 390, w: 840, h: 320 }, 24) === "below", "the live-s0 band reads as below-adjacent");
});

check("DISTRIBUTION WITHOUT RESIZE: kept-tight text is MOVED (size intact) when it materially improves the void", () => {
  // A copy whose declared box is truthful (short box, enough text) parked in
  // the top-left corner, hero pinned right — the shape machinery should pull
  // the copy toward the frame's structure and close part of the void.
  const content = { headline: "The routing engine now assigns, prioritizes and ships the work" };
  const comp = {
    atmosphere: "wash",
    elements: [
      { role: "hero", subject: "panel", focalRank: 1, bounds: { x: 1100, y: 300, w: 700, h: 480 }, interior: [], ownsCopy: [], motion: "" },
      { role: "copy", subject: "kicker", focalRank: 2, bounds: { x: 96, y: 54, w: 600, h: 90 }, interior: [], ownsCopy: ["headline"], motion: "" },
    ],
  } as unknown as NonNullable<AllocateApplyCtx["scenes"][number]["composition"]>;
  const plan = composeSceneLayout({ register: "centered", content, composition: comp }, "16:9", { hasThroughline: false });
  const ctx: AllocateApplyCtx = {
    aspect: "16:9",
    scenes: [{ content, composition: comp }],
    ownedFieldsFor: (_i, slot) => (slot.id === "copy" ? ["headline"] : slot.contentFields),
    metricsFor: () => METRICS,
  };
  const copyBefore = { ...el(plan, "copy").bounds };
  const r = allocateScenePlans([plan], ctx, { heroGrowth: false }); // isolate FIX 1
  const rec = r.records[0];
  assert(rec.inkVoidBefore !== null && rec.inkVoidBefore >= CATASTROPHIC_INK_VOID, `fixture must be catastrophic, got ${rec.inkVoidBefore}`);
  assert(rec.resized.length === 0, `void-repair must not resize text (sizing stays as-is), got ${JSON.stringify(rec.resized)}`);
  if (rec.applied) {
    assert(rec.reason === "void-distributed", `an applied void-repair must carry the distinct reason, got ${rec.reason}`);
    assert(rec.placement === "distributed", "void-repair ships through the distribution tier");
    const copyAfter = el(r.plans[0], "copy").bounds;
    assert(copyAfter.w === copyBefore.w && copyAfter.h === copyBefore.h, "the kept-tight copy keeps its exact size");
    assert(rec.moved.includes("copy"), "the copy must be the thing that moved");
    assert(JSON.stringify(el(r.plans[0], "hero").bounds) === JSON.stringify(el(plan, "hero").bounds), "hero stays pinned");
    assert(rec.inkVoidAfter !== null && rec.inkVoidAfter < rec.inkVoidBefore!, "the move must have paid for itself");
  } else {
    // The guard is allowed to reject — but then the reason must say TRIED.
    assert(/^void-/.test(rec.reason ?? ""), `a rejected attempt must carry the tried-and-guarded vocabulary, got ${rec.reason}`);
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
