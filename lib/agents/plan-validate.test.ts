/**
 * Tests for plan-validate — the AUTHOR-TIME wiring of validateScenePlan plus the
 * deterministic repair ladder. Run: `node scripts/run-tests.mjs lib/agents/plan-validate.test.ts`
 * (no API key, no credits).
 *
 * What these lock:
 *   - each rung of the ladder: (a) containment clamp, (b) undeclared-overlap
 *     shrink of the lower-focalRank box, (c) the min-legible-size refusal,
 *   - the escalation path (residue quotes PlanViolation.message VERBATIM),
 *   - the guaranteed-valid terminal fallback to the geometry tables,
 *   - a DECLARED overlap and a clean frame must PASS untouched (no FPs — the
 *     Razorpay-s2 reference-grade class must never be "repaired").
 * Overlap/containment predicates are re-derived here so a bug in the module
 * can't vouch for itself.
 */
import {
  validateAndRepairPlans,
  planValidationErrors,
  enforcePlanFallback,
  MIN_LEGIBLE_W_FRAC,
  MIN_LEGIBLE_H_FRAC,
} from "./plan-validate";
import { composeSceneLayout, CANVAS, BOTTOM_SAFE_FRAC, type ElementSlot } from "./layout-composer";
import type { Scene, SceneComposition } from "../../src/schema";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const W = CANVAS["16:9"].w;
const H = CANVAS["16:9"].h;

const CONTENT = {
  eyebrow: "THE LEGACY TRAP",
  headline: "One massive headline",
  lede: "A supporting lede.",
  illustration: "line-chart",
};

type Box = { x: number; y: number; w: number; h: number };

/** Independent re-derivation (half-open, so touching ≠ overlapping). */
const hits = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const scene = (
  register: string,
  hero: Box | null,
  copy: Box | null,
  extra?: { heroRank?: number; copyRank?: number; budget?: { brandMark: string; cta: string } },
): Scene => {
  const elements: unknown[] = [{ role: "atmosphere", subject: "field", interior: [] }];
  if (hero) elements.push({ role: "hero", subject: "dashboard", focalRank: extra?.heroRank ?? 1, bounds: { ...hero }, interior: [] });
  if (copy) elements.push({ role: "copy", subject: "stack", focalRank: extra?.copyRank ?? 2, bounds: { ...copy }, ownsCopy: ["headline"], interior: [] });
  return {
    register,
    content: { ...CONTENT },
    composition: {
      atmosphere: "a cool tonal wash",
      negativeSpace: "air along the lower right of the frame",
      budget: extra?.budget ?? { brandMark: "chrome", cta: "copy" },
      elements,
    } as unknown as SceneComposition,
  } as unknown as Scene;
};

const boundsOf = (s: Scene, role: string): Box | undefined =>
  ((s.composition as SceneComposition | undefined)?.elements ?? []).find((e) => e.role === role)?.bounds;

const slot = (s: Scene, id: string): ElementSlot | undefined =>
  composeSceneLayout(
    { register: s.register, content: s.content as Record<string, unknown>, composition: s.composition },
    "16:9",
  ).elements.find((e) => e.id === id);

// ── Rung (a): CONTAINMENT clamp ─────────────────────────────────────────────

check("rung (a): a copy box crossing the bottom reserve is repaired into the safe frame, not escalated", () => {
  // composeSceneLayout's own clampBounds keeps head bounds on-canvas, so the
  // containment arm that survives into the plan is the bottom reserve. NOTE the
  // reserve line (0.965·H = 1042) sits BELOW the chrome bar's top edge (H−72 =
  // 1008), so a bottom-reserve breach is always ALSO a chrome collision — the
  // two rungs cooperate and the box ends up clear of both.
  const s = scene("centered", { x: 1080, y: 120, w: 720, h: 600 }, { x: 120, y: 600, w: 700, h: 460 });
  const before = { ...boundsOf(s, "copy")! };
  assert(before.y + before.h > BOTTOM_SAFE_FRAC * H, "fixture must start below the bottom reserve");
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  const after = boundsOf(s, "copy")!;
  assert(r.errors.length === 0, `expected a clean repair, got ${JSON.stringify(r.errors)}`);
  assert(after.y + after.h <= BOTTOM_SAFE_FRAC * H, `copy must be lifted into the safe frame, got ${JSON.stringify(after)}`);
  assert(after.y + after.h <= H - 72, `copy must also clear the chrome bar, got ${JSON.stringify(after)}`);
  assert(after.w === before.w && after.h === before.h, "clamping to the chrome bar SHIFTS — the authored size survives");
  assert(r.events.some((e) => e.outcome === "repaired"), `expected a repair event, got ${JSON.stringify(r.events)}`);
});

check("rung (a): clampIntoSafe SHIFTS rather than shrinks when the box already fits", () => {
  // A hero whose height fits the safe frame but whose y parks it over the edge:
  // the repair moves it up, it does not amputate it.
  const s = scene("centered", { x: 1000, y: 700, w: 700, h: 400 }, { x: 120, y: 160, w: 700, h: 400 });
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  const hero = boundsOf(s, "hero")!;
  assert(r.errors.length === 0, `expected a clean repair, got ${JSON.stringify(r.errors)}`);
  assert(hero.w === 700 && hero.h === 400, `size preserved by the shift, got ${JSON.stringify(hero)}`);
  assert(hero.y + hero.h <= H - 72, `shifted clear of the chrome bar, got ${JSON.stringify(hero)}`);
});

// ── Rung (b): DISJOINTNESS shrink of the lower-focalRank box ─────────────────

check("rung (b): an undeclared hero/copy overlap shrinks the LOWER-focalRank box, keeping head intent", () => {
  // The calibration class: a panel occluding the copy (rappi s0 / s4).
  const s = scene("centered", { x: 700, y: 200, w: 900, h: 620 }, { x: 200, y: 300, w: 800, h: 400 }, { heroRank: 1, copyRank: 2 });
  const heroBefore = { ...boundsOf(s, "hero")! };
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  const hero = boundsOf(s, "hero")!;
  const copy = boundsOf(s, "copy")!;
  assert(r.errors.length === 0, `expected a clean repair, got ${JSON.stringify(r.errors)}`);
  assert(!hits(hero, copy), `hero and copy must be disjoint after repair, got ${JSON.stringify({ hero, copy })}`);
  assert(
    hero.x === heroBefore.x && hero.w === heroBefore.w && hero.y === heroBefore.y && hero.h === heroBefore.h,
    "the focalRank-1 hero must be untouched — the subordinate copy is the box that moves",
  );
  assert(r.events.some((e) => e.kind === "disjointness" && e.outcome === "repaired"), `expected a repaired disjointness event, got ${JSON.stringify(r.events)}`);
});

check("rung (b): head intent SURVIVES — a repaired collision does not silently revert to the table", () => {
  const s = scene("centered", { x: 700, y: 200, w: 900, h: 620 }, { x: 200, y: 300, w: 800, h: 400 });
  validateAndRepairPlans([s], { aspect: "16:9" });
  // The table's centered hero is x:560,w:800 — the head's is x:700,w:900. If the
  // composer's safety net had fired, the plan would carry the TABLE hero.
  const planHero = slot(s, "hero")!;
  assert(planHero.bounds.x === 700 && planHero.bounds.w === 900, `head hero must survive repair, got ${JSON.stringify(planHero.bounds)}`);
});

check("rung (b): a collision with the deterministic CHROME bar shrinks the head-owned box", () => {
  // Nothing tells the head the bottom chrome bar exists; the ladder handles it.
  const s = scene("centered", { x: 1080, y: 120, w: 720, h: 600 }, { x: 120, y: 200, w: 700, h: 830 });
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  const copy = boundsOf(s, "copy")!;
  assert(r.errors.length === 0, `expected a clean repair, got ${JSON.stringify(r.errors)}`);
  assert(copy.y + copy.h <= H - 72, `copy must clear the 72px chrome bar, got ${JSON.stringify(copy)}`);
});

// ── Rung (c): the min-legible refusal ───────────────────────────────────────

check("rung (c): a repair that would leave a sub-legible sliver FAILS LOUDLY and escalates", () => {
  // A wide hero leaves exactly one trim direction open for the copy, and it
  // yields a 200px-wide sliver — below the 269px legible floor.
  const s = scene("centered", { x: 300, y: 40, w: 1600, h: 900 }, { x: 100, y: 300, w: 800, h: 400 }, { heroRank: 1, copyRank: 2 });
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  assert(r.errors.length > 0, "a sub-legible repair must escalate, not silently ship");
  const ev = r.events.find((e) => e.outcome === "escalated");
  assert(!!ev, `expected an escalated event, got ${JSON.stringify(r.events)}`);
  assert(/legible floor/.test(ev!.reason ?? ""), `the reason must name the legible floor, got "${ev!.reason}"`);
  assert(/"copy"/.test(ev!.reason ?? ""), `the reason must name the specific element, got "${ev!.reason}"`);
  assert(
    Math.round(MIN_LEGIBLE_W_FRAC * W) === 269 && Math.round(MIN_LEGIBLE_H_FRAC * H) === 119,
    "the 16:9 legible floor is 269×119px",
  );
});

// ── Escalation: verbatim messages ───────────────────────────────────────────

check("escalation: the residue quotes PlanViolation.message VERBATIM, scene-prefixed", () => {
  const s = scene("centered", { x: 300, y: 40, w: 1600, h: 900 }, { x: 100, y: 300, w: 800, h: 400 });
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  assert(
    r.errors.some((e) => e.startsWith("Scene 0: ") && /bounds overlap with no declared allowance/.test(e)),
    `expected the validator's own message verbatim, got ${JSON.stringify(r.errors)}`,
  );
});

check("escalation: stranded-hero and budget are NOT repaired — the head owns them", () => {
  // A split whose hero is far too narrow (< 30% W) and whose budget names a
  // nonexistent owner. Neither is a clamp's business.
  const s = scene("split", { x: 1400, y: 380, w: 300, h: 320 }, { x: 120, y: 240, w: 720, h: 600 }, { budget: { brandMark: "sidebar", cta: "copy" } });
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  assert(r.errors.some((e) => /the hero must command/.test(e)), `expected a stranded-hero error, got ${JSON.stringify(r.errors)}`);
  assert(r.errors.some((e) => /budget.brandMark/.test(e)), `expected a budget error, got ${JSON.stringify(r.errors)}`);
  const reasons = r.events.filter((e) => e.outcome === "escalated").map((e) => e.reason ?? "");
  assert(reasons.some((x) => /invent composition/.test(x)), `stranded-hero must be refused explicitly, got ${JSON.stringify(reasons)}`);
  assert(reasons.some((x) => /head's to assign/.test(x)), `budget must be refused explicitly, got ${JSON.stringify(reasons)}`);
});

// ── The guaranteed-valid fallback ───────────────────────────────────────────

check("fallback: an unrepairable scene DROPS its head bounds and reverts to the geometry table", () => {
  const s = scene("centered", { x: 300, y: 40, w: 1600, h: 900 }, { x: 100, y: 300, w: 800, h: 400 });
  const r = enforcePlanFallback([s], { aspect: "16:9" });
  assert(boundsOf(s, "hero") === undefined, "the head's hero bounds must be dropped");
  assert(boundsOf(s, "copy") === undefined, "the head's copy bounds must be dropped");
  assert(r.events.some((e) => e.outcome === "fallback"), `expected a fallback event, got ${JSON.stringify(r.events)}`);
  // And the resulting plan is the provably-valid table path.
  const hero = slot(s, "hero")!;
  const copy = slot(s, "copy")!;
  assert(hero.bounds.x === 560 && hero.bounds.w === 800, `table hero expected, got ${JSON.stringify(hero.bounds)}`);
  assert(!hits(hero.bounds, copy.bounds), "the table plan must be disjoint");
  // Re-validating the fallen-back scene is clean.
  const again = validateAndRepairPlans([s], { aspect: "16:9" });
  assert(again.errors.length === 0, `the table fallback must validate clean, got ${JSON.stringify(again.errors)}`);
});

check("fallback: a BUDGET-only residue does NOT drop bounds (a wrong owner is not a bounds defect)", () => {
  const s = scene("centered", { x: 1080, y: 160, w: 700, h: 600 }, { x: 140, y: 240, w: 760, h: 460 }, { budget: { brandMark: "sidebar", cta: "copy" } });
  enforcePlanFallback([s], { aspect: "16:9" });
  assert(boundsOf(s, "hero") !== undefined, "a budget violation must not discard the head's frame");
});

// ── No false positives ──────────────────────────────────────────────────────

check("clean: a well-composed frame passes untouched (byte-identical bounds, no events)", () => {
  const s = scene("split", { x: 1056, y: 220, w: 768, h: 640 }, { x: 120, y: 240, w: 720, h: 600 });
  const before = JSON.stringify([boundsOf(s, "hero"), boundsOf(s, "copy")]);
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  assert(r.errors.length === 0, `a clean frame must not error, got ${JSON.stringify(r.errors)}`);
  assert(r.events.length === 0, `a clean frame must not fire, got ${JSON.stringify(r.events)}`);
  assert(JSON.stringify([boundsOf(s, "hero"), boundsOf(s, "copy")]) === before, "clean bounds must be untouched");
  assert(r.summary === "plan-validate: 0 violation(s)", `unexpected summary "${r.summary}"`);
});

check("declared overlap: a full-bleed hero the copy sits ON passes — declared layering is not a defect", () => {
  // The Razorpay-s2 class: an intentional overlay on a canvas treatment. Both
  // the register-declared form (full-bleed) and the ≥85%-area form must pass.
  const declared = scene("full-bleed", { x: 0, y: 0, w: W, h: H }, { x: 120, y: 560, w: 900, h: 380 });
  const rd = validateAndRepairPlans([declared], { aspect: "16:9" });
  assert(rd.errors.length === 0 && rd.events.length === 0, `full-bleed overlay must pass, got ${JSON.stringify(rd)}`);

  const bigHero = scene("centered", { x: 0, y: 0, w: 1840, h: 1010 }, { x: 120, y: 560, w: 700, h: 380 });
  const rb = validateAndRepairPlans([bigHero], { aspect: "16:9" });
  assert(rb.errors.length === 0 && rb.events.length === 0, `a canvas-treatment hero declares the overlay, got ${JSON.stringify(rb)}`);
});

check("no-op: an UN-composed scene is skipped entirely (the table path is already provably valid)", () => {
  const bare = { register: "centered", content: { ...CONTENT } } as unknown as Scene;
  const r = validateAndRepairPlans([bare], { aspect: "16:9" });
  assert(r.errors.length === 0 && r.events.length === 0, `un-composed scenes must be skipped, got ${JSON.stringify(r)}`);
});

check("negative space: deliberate air is never a violation (no coverage/fill arm here)", () => {
  // A small hero with most of the frame empty — intentional, and NOT this
  // validator's business (the fill floor was deliberately reverted).
  const s = scene("centered", { x: 760, y: 380, w: 420, h: 300 }, { x: 200, y: 120, w: 500, h: 200 });
  const r = validateAndRepairPlans([s], { aspect: "16:9" });
  assert(r.errors.length === 0 && r.events.length === 0, `negative space must not fire, got ${JSON.stringify(r)}`);
});

// ── Multi-scene telemetry ───────────────────────────────────────────────────

check("telemetry: the summary lists violations by scene and kind, with repaired/escalated counts", () => {
  const repairable = scene("centered", { x: 700, y: 200, w: 900, h: 620 }, { x: 200, y: 300, w: 800, h: 400 });
  const clean = scene("split", { x: 1056, y: 220, w: 768, h: 640 }, { x: 120, y: 240, w: 720, h: 600 });
  const stuck = scene("centered", { x: 300, y: 40, w: 1600, h: 900 }, { x: 100, y: 300, w: 800, h: 400 });
  const r = validateAndRepairPlans([repairable, clean, stuck], { aspect: "16:9" });
  assert(/^plan-validate: 2 violation\(s\) \[/.test(r.summary), `unexpected summary "${r.summary}"`);
  assert(/s0:disjointness/.test(r.summary) && /s2:disjointness/.test(r.summary), `summary must scope by scene, got "${r.summary}"`);
  assert(/1 repaired/.test(r.summary) && /1 escalated/.test(r.summary), `summary must count outcomes, got "${r.summary}"`);
});

check("callback form: planValidationErrors repairs in place and returns only the residue", () => {
  const repairable = scene("centered", { x: 700, y: 200, w: 900, h: 620 }, { x: 200, y: 300, w: 800, h: 400 });
  const errs = planValidationErrors([repairable], { aspect: "16:9" });
  assert(errs.length === 0, `a repairable scene must not reach the head, got ${JSON.stringify(errs)}`);
  assert(!hits(boundsOf(repairable, "hero")!, boundsOf(repairable, "copy")!), "the repair must be written back");
});

check("aspects: the ladder works on 9:16 and 1:1 canvases too", () => {
  const fixtures = {
    "9:16": { hero: { x: 90, y: 200, w: 900, h: 700 }, copy: { x: 90, y: 800, w: 900, h: 600 } },
    "1:1": { hero: { x: 80, y: 120, w: 900, h: 500 }, copy: { x: 80, y: 560, w: 900, h: 340 } },
  } as const;
  for (const aspect of ["9:16", "1:1"] as const) {
    const s = scene("centered", { ...fixtures[aspect].hero }, { ...fixtures[aspect].copy });
    const r = validateAndRepairPlans([s], { aspect });
    assert(r.errors.length === 0, `${aspect} must repair cleanly, got ${JSON.stringify(r.errors)}`);
    assert(!hits(boundsOf(s, "hero")!, boundsOf(s, "copy")!), `${aspect} boxes must end disjoint`);
  }
});

check("throughline: a copy box crossing the pinned motif anchor is repaired, not shipped", () => {
  // The motif is pinned at the choreographer's anchor (16:9 → 1360,540 + 200²)
  // so the cross-scene drift gate passes; copy must not sit on it.
  const s = scene("centered", { x: 200, y: 120, w: 600, h: 380 }, { x: 1250, y: 300, w: 600, h: 300 });
  const r = validateAndRepairPlans([s], { aspect: "16:9", hasThroughline: true });
  const copy = boundsOf(s, "copy")!;
  const motif = { x: 1360, y: 540, w: 200, h: 200 };
  assert(r.errors.length === 0, `expected a clean repair, got ${JSON.stringify(r.errors)}`);
  assert(!hits(copy, motif), `copy must clear the pinned motif, got ${JSON.stringify(copy)}`);
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
