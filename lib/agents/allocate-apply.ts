/**
 * RB_ALLOCATE — the ink-based allocator post-pass (2026-07-22). OFF BY
 * DEFAULT; `RB_ALLOCATE=on` enables it. Deterministic, zero-LLM, zero-I/O.
 *
 * WHY IT EXISTS. The ink re-score (ALLOCATOR_INK_RESCORE.md) passed its
 * pre-registered gate: scoring on PREDICTED INK instead of declared boxes, the
 * round-2 allocator still beats the head — mean ink-void 18.1% → 14.5%,
 * catastrophic (>25%) ink-voids 16 → 0, ink focal dominance 59/82 → 77/82 —
 * and the verdict is stable under a ±15% uniform predictor bias. The two
 * measured facts underneath: a diegetic piece paints its declared box
 * pixel-exact (21/21), a text piece never does (0/10; the box runs 1.04–2.09×
 * its ink). So the pass sizes TEXT to its ink and redistributes the
 * subordinates, and touches nothing whose box is already truthful.
 *
 * WHAT IT DOES, per scene, between plan composition and the manifest:
 *   1. HERO: untouched. Bounds and treatment (bleed vs placed, from the
 *      authored area) pass through verbatim — the head's hero scale is the one
 *      honest signal on disk, three experiments deep.
 *   2. TEXT: box = predicted ink + type-scale padding (`inkSizedBox`), from
 *      the element's OWN verbatim strings, at the same type scale + metrics
 *      the capacity budget downstream will use — box and budget cannot
 *      disagree, and `RB_ENFORCE_BOX` has nothing to truncate on owned copy by
 *      construction. Sizing only ever SHRINKS; ink that exceeds the authored
 *      box keeps the authored box.
 *   3. SUBORDINATE PLACEMENT: the round-2 distribution machinery
 *      (`allocateLayout` mode "pipeline") — shapes per register, reading-order
 *      slot mapping, title-safe containment, disjoint by construction; the
 *      throughline stays pinned to its per-video anchor (the cross-scene drift
 *      contract), and separation keeps a full gutter of hero clearance.
 *   4. FREED SPACE is accounted: per scene, the pass logs how many px the
 *      shrink released and where they went (hero breathing room / spacing
 *      rhythm / declared negative space), decided from measured clearance
 *      deltas, not vibes.
 *   5. SAFETY: `validateScenePlan` re-runs over the output. It should pass by
 *      construction; if it ever reports a violation the input plan did not
 *      already carry, that is an allocator BUG — logged loudly, scene
 *      reverted. An unresolved separation likewise reverts the scene. Any
 *      throw degrades to the input plans. Flag off returns the input ARRAY BY
 *      REFERENCE — byte-identical pipeline behaviour, tested.
 */
import type { ScenePlan, ElementSlot, Aspect } from "./layout-composer";
import { validateScenePlan, CANVAS } from "./layout-composer";
import type { SceneComposition } from "../../src/schema";
import { allocateLayout, type AllocElementInput, type Rect } from "./allocate-layout";
import { inkSizedBox, predictInkRect, type OwnedField } from "./predict-ink";
import { scoreLayout, type ScoredElement } from "./layout-metrics";
import type { FontMetrics } from "../render/font-metrics";

const ENABLED = new Set(["on", "1", "true", "yes"]);

/** `RB_ALLOCATE=on|1|true|yes`. Off by default, everywhere. */
export const allocateEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  ENABLED.has(String(env.RB_ALLOCATE ?? "").trim().toLowerCase());

/** One scene's outcome — persisted as `allocated.json` next to composition.json
 *  so future dry runs can diff the allocator's plan against what shipped. */
export interface SceneAllocationRecord {
  scene: number;
  /** False ⇒ the input plan shipped untouched; `reason` says why. */
  applied: boolean;
  reason?: string;
  shape?: string;
  /**
   * How the resized text landed:
   *   - "distributed"  — the round-2 shape machinery placed it, and the ink
   *     view measured no worse than the input (the no-regression guard);
   *   - "in-place"     — the distribution was rejected (unresolved separation
   *     or a worse ink-void), so the box shrank at its own anchor instead:
   *     same x/y/w, ink untouched by construction, only the reserved bottom
   *     band released. The null-risk application of "the box is a ceiling".
   */
  placement?: "distributed" | "in-place";
  /** Elements whose centre moved > 2px. */
  moved: string[];
  /** Text elements sized to ink. */
  resized: { id: string; from: Rect; to: Rect; freedPx: number }[];
  /** Largest ink-void (fraction of title-safe) before → after, scored on the
   *  same predicted-ink view the re-score used. */
  inkVoidBefore: number | null;
  inkVoidAfter: number | null;
  freedPxTotal: number;
  /** Where the released space went (measured, per the module note). */
  freedTo?: "hero-breathing" | "spacing-rhythm" | "negative-space";
  /** Final bounds by element id — the diffable artifact. */
  bounds: Record<string, Rect>;
}

export interface AllocateApplyCtx {
  aspect: Aspect;
  scenes: {
    content?: Record<string, unknown>;
    composition?: SceneComposition;
  }[];
  /** The copy-field names a slot owns (cast-build's ownedCopyFields). */
  ownedFieldsFor: (sceneIndex: number, slot: ElementSlot) => string[];
  /** The metrics the slot's capacity budget will be computed with. */
  metricsFor: (slot: ElementSlot) => FontMetrics;
}

export interface AllocateApplyResult {
  plans: ScenePlan[];
  records: SceneAllocationRecord[];
  enabled: boolean;
}

const PINNED_ROLES = new Set(["hero", "throughline"]);
const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

/** Edge-to-edge gap between two rects (0 when they touch or overlap). */
const rectGap = (a: Rect, b: Rect): number => {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.max(dx, dy) === 0 ? 0 : Math.hypot(dx, dy);
};

/** The ink view of a plan: text bounds → predicted ink rect; everything else
 *  verbatim. The same transformation the ink re-score scored, so the pass's
 *  telemetry and the offline evidence speak one language. */
const inkScore = (
  elements: { id: string; role: string; bounds: Rect }[],
  fieldsById: Map<string, OwnedField[]>,
  metricsById: Map<string, FontMetrics>,
  aspect: Aspect,
): number | null => {
  try {
    const canvas = CANVAS[aspect];
    const scored: ScoredElement[] = elements
      .filter((e) => e.role !== "atmosphere" && e.role !== "chrome")
      .map((e) => {
        const fields = fieldsById.get(e.id);
        const metrics = metricsById.get(e.id);
        if (!fields || fields.length === 0 || !metrics) return { id: e.id, role: e.role, bounds: e.bounds };
        const { rect } = predictInkRect(e.bounds, fields, canvas, metrics);
        return { id: e.id, role: e.role, bounds: rect };
      });
    return scored.length > 0 ? scoreLayout(scored, aspect).largestVoid : null;
  } catch {
    return null;
  }
};

/**
 * FREED-SPACE DESTINATION. Deterministic, measured: compare the hero's
 * clearance (nearest free-element edge gap) and the mean inter-element gap
 * before vs after. The largest material increase names the destination;
 * neither increasing means the space dissolved into the frame's margins —
 * declared negative space.
 */
const freedDestination = (
  before: { id: string; role: string; bounds: Rect }[],
  after: { id: string; role: string; bounds: Rect }[],
  gutter: number,
): "hero-breathing" | "spacing-rhythm" | "negative-space" => {
  const contentOf = (els: { id: string; role: string; bounds: Rect }[]) =>
    els.filter((e) => e.role !== "atmosphere" && e.role !== "chrome");
  const heroClearance = (els: { id: string; role: string; bounds: Rect }[]): number => {
    const c = contentOf(els);
    const hero = c.find((e) => e.role === "hero");
    if (!hero) return 0;
    const others = c.filter((e) => e !== hero);
    if (others.length === 0) return 0;
    return Math.min(...others.map((o) => rectGap(hero.bounds, o.bounds)));
  };
  const meanGap = (els: { id: string; role: string; bounds: Rect }[]): number => {
    const c = contentOf(els);
    const gaps: number[] = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) gaps.push(rectGap(c[i].bounds, c[j].bounds));
    return gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  };
  const heroDelta = heroClearance(after) - heroClearance(before);
  const gapDelta = meanGap(after) - meanGap(before);
  if (heroDelta >= gutter && heroDelta >= gapDelta) return "hero-breathing";
  if (gapDelta >= gutter) return "spacing-rhythm";
  return "negative-space";
};

/** Same signature key for a violation, so "new vs pre-existing" is exact. */
const violationKey = (v: { pieceId: string; kind: string }): string => `${v.pieceId}:${v.kind}`;

/**
 * The pass. Pure given its inputs; the flag check lives in
 * `maybeAllocateScenePlans` so this stays directly testable.
 */
export const allocateScenePlans = (plans: ScenePlan[], ctx: AllocateApplyCtx): AllocateApplyResult => {
  const { aspect } = ctx;
  const { w: W, h: H } = CANVAS[aspect];
  const gutter = Math.round(0.022 * Math.min(W, H));
  const records: SceneAllocationRecord[] = [];

  const out = plans.map((plan, i): ScenePlan => {
    const record: SceneAllocationRecord = {
      scene: i,
      applied: false,
      moved: [],
      resized: [],
      inkVoidBefore: null,
      inkVoidAfter: null,
      freedPxTotal: 0,
      bounds: {},
    };
    records.push(record);
    const keep = (reason: string): ScenePlan => {
      record.reason = reason;
      // The scene ships untouched — a non-empty resized[] on a reverted scene
      // would read as a change that never happened.
      record.resized = [];
      record.moved = [];
      record.freedPxTotal = 0;
      for (const el of plan.elements) record.bounds[el.id] = round(el.bounds);
      return plan;
    };

    try {
      if (!plan.elements || plan.elements.length === 0) return keep("no-elements");
      const content = ctx.scenes[i]?.content;
      const composition = ctx.scenes[i]?.composition;

      // ── Classify + size ─────────────────────────────────────────────────
      const fieldsById = new Map<string, OwnedField[]>();
      const metricsById = new Map<string, FontMetrics>();
      const sizedById = new Map<string, { w: number; h: number }>();
      const inputs: AllocElementInput[] = [];
      let anyResize = false;
      let keptTight = 0;
      let noStrings = 0;
      for (const el of plan.elements) {
        const base: AllocElementInput = { id: el.id, role: el.id, focalRank: null };
        if (el.id === "atmosphere" || el.id === "chrome") {
          inputs.push(base);
          continue;
        }
        if (el.kind === "text") {
          const names = ctx.ownedFieldsFor(i, el);
          const fields: OwnedField[] = (names ?? [])
            .map((name) => ({ name, value: content?.[name] }))
            .filter((f) => f.value !== null && f.value !== undefined);
          const metrics = ctx.metricsFor(el);
          if (fields.length === 0) {
            // Nothing measurable — do not touch what we cannot predict.
            noStrings++;
            inputs.push({ ...base, pinnedBounds: el.bounds });
            continue;
          }
          fieldsById.set(el.id, fields);
          metricsById.set(el.id, metrics);
          const sized = inkSizedBox(el.bounds, fields, { w: W, h: H }, metrics);
          if (sized.kept) {
            // The declared box already tells the truth (ink+padding fills it).
            keptTight++;
            inputs.push({ ...base, pinnedBounds: el.bounds });
            continue;
          }
          anyResize = true;
          sizedById.set(el.id, sized.box);
          record.resized.push({ id: el.id, from: round(el.bounds), to: { x: el.bounds.x, y: el.bounds.y, ...sized.box }, freedPx: sized.freedPx });
          record.freedPxTotal += sized.freedPx;
          const chars = fields.reduce((n, f) => n + (typeof f.value === "string" ? f.value.length : JSON.stringify(f.value ?? "").length), 0);
          inputs.push({ ...base, focalRank: 2, fixedSize: sized.box, textChars: chars });
          continue;
        }
        if (PINNED_ROLES.has(el.id)) {
          inputs.push({ ...base, focalRank: el.id === "hero" ? 1 : 3, pinnedBounds: el.bounds });
          continue;
        }
        // Unknown role (a future slot kind): pin — never touch what we do not
        // understand.
        inputs.push({ ...base, pinnedBounds: el.bounds });
      }
      if (!anyResize) return keep(`no-text-to-size(kept=${keptTight},no-strings=${noStrings})`);

      const beforeEls = plan.elements.map((e) => ({ id: e.id, role: e.id, bounds: e.bounds as Rect }));
      const beforeVoid = inkScore(beforeEls, fieldsById, metricsById, aspect);

      // ── Tier 1: DISTRIBUTE (the round-2 shape machinery) ────────────────
      const hero = plan.elements.find((e) => e.id === "hero");
      const heroTreatment = hero ? (hero.bounds.w * hero.bounds.h >= 0.85 * W * H ? "bleed" : "placed") : null;
      const mapBack = (slots: { id: string; bounds: Rect }[]): ElementSlot[] =>
        plan.elements.map((el) => {
          const slot = slots.find((s) => s.id === el.id);
          if (!slot) throw new Error(`allocate-apply: slot "${el.id}" missing from allocation`);
          if (el.id === "atmosphere" || el.id === "chrome") return el;
          // Bounds only — z (the paint layer) and every other slot field are
          // contracts this pass has no authority over.
          return { ...el, bounds: { ...el.bounds, ...round(slot.bounds) } };
        });
      let placement: "distributed" | "in-place" = "distributed";
      let shape: string | undefined;
      let nextElements: ElementSlot[] | null = null;
      let guardNote = "";
      try {
        const alloc = allocateLayout({ aspect, register: plan.register, elements: inputs, mode: "pipeline", heroTreatment });
        if (alloc.unresolved && alloc.unresolved.length > 0) {
          guardNote = `unresolved-separation:${alloc.unresolved.map((p) => p.join("×")).join(",")}`;
        } else {
          nextElements = mapBack(alloc.slots);
          shape = alloc.shape;
          // THE NO-REGRESSION GUARD. The distribution must measure NO WORSE
          // than the input on the same ink instrument the re-score used —
          // round 2's own evidence is that repositioning alone can hurt, and
          // this pass's mandate is sizing truth, not speculative moves.
          const afterVoid = inkScore(
            nextElements.map((e) => ({ id: e.id, role: e.id, bounds: e.bounds as Rect })),
            fieldsById,
            metricsById,
            aspect,
          );
          if (beforeVoid !== null && afterVoid !== null && afterVoid > beforeVoid + 0.005) {
            guardNote = `ink-void-regression:${(beforeVoid * 100).toFixed(1)}%→${(afterVoid * 100).toFixed(1)}%`;
            nextElements = null;
            shape = undefined;
          }
        }
      } catch (err) {
        guardNote = `allocate-threw:${err instanceof Error ? err.message : String(err)}`;
      }

      // ── Tier 2: SHRINK IN PLACE — the null-risk application of the ink
      // premise. Same anchor, same measure, height down to ink+padding: the
      // ink view is byte-identical to the input's by construction, boxes stop
      // lying, and the reserved bottom band is released. ─────────────────────
      if (!nextElements) {
        placement = "in-place";
        nextElements = plan.elements.map((el) => {
          const sized = sizedById.get(el.id);
          if (!sized) return el;
          return { ...el, bounds: { ...el.bounds, h: sized.h } };
        });
      }
      const nextPlan: ScenePlan = { ...plan, elements: nextElements };

      // ── Re-validate (should pass by construction) ───────────────────────
      const baseline = new Set(validateScenePlan(plan, aspect, { composition, content }).map(violationKey));
      const after = validateScenePlan(nextPlan, aspect, { composition, content });
      const introduced = after.filter((v) => !baseline.has(violationKey(v)));
      if (introduced.length > 0) {
        // A violation the allocator INTRODUCED is a bug in this pass — the
        // design claim is disjoint-by-construction. Loud on purpose.
        console.error(
          `[allocate] BUG — scene ${i} allocation introduced ${introduced.length} plan violation(s) and was REVERTED: ${introduced.map((v) => `${v.pieceId}/${v.kind}: ${v.message}`).join(" · ")}`,
        );
        return keep(`validate:${introduced.map(violationKey).join(",")}`);
      }

      // ── Telemetry ───────────────────────────────────────────────────────
      const afterEls = nextElements.map((e) => ({ id: e.id, role: e.id, bounds: e.bounds as Rect }));
      record.applied = true;
      record.placement = placement;
      record.shape = shape;
      if (guardNote) record.reason = guardNote; // why the distribution tier was rejected
      // MOVED = the anchor (top-left) displaced. Deliberately not the centre:
      // an in-place height shrink shifts the centre while the block's anchor —
      // where its ink starts — stays exactly put.
      record.moved = nextElements
        .filter((el) => {
          const prev = plan.elements.find((p) => p.id === el.id)!;
          return Math.hypot(prev.bounds.x - el.bounds.x, prev.bounds.y - el.bounds.y) > 2;
        })
        .map((el) => el.id);
      record.inkVoidBefore = beforeVoid;
      record.inkVoidAfter = inkScore(afterEls, fieldsById, metricsById, aspect);
      if (record.freedPxTotal > 0) record.freedTo = freedDestination(beforeEls, afterEls, gutter);
      // resized[].to carries the FINAL placed rect, not the pre-placement one.
      for (const r of record.resized) {
        const fin = nextElements.find((e) => e.id === r.id);
        if (fin) r.to = round(fin.bounds);
      }
      for (const el of nextElements) record.bounds[el.id] = round(el.bounds);

      const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
      console.log(
        `[allocate] s${i} ${placement}${shape ? ` shape=${shape}` : ""} resized ${record.resized.length} [${record.resized.map((r) => `${r.id} ${r.from.w}×${r.from.h}→${r.to.w}×${r.to.h}`).join(", ")}] moved ${record.moved.length} [${record.moved.join(", ")}] ink-void ${pct(record.inkVoidBefore)}→${pct(record.inkVoidAfter)} freed ${(record.freedPxTotal / 1000).toFixed(0)}kpx→${record.freedTo ?? "—"}`,
      );
      return nextPlan;
    } catch (err) {
      // The pass must never break a build.
      console.warn(`[allocate] scene ${i} skipped — ${err instanceof Error ? err.message : err}`);
      return keep(`error:${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { plans: out, records, enabled: true };
};

/**
 * The production entry point. Flag off (the default) returns the input array
 * BY REFERENCE — the pipeline is byte-identical with the flag down, and the
 * test asserts identity, not equality.
 */
export const maybeAllocateScenePlans = (
  plans: ScenePlan[],
  ctx: AllocateApplyCtx,
  env: Record<string, string | undefined> = process.env,
): AllocateApplyResult => {
  if (!allocateEnabled(env)) return { plans, records: [], enabled: false };
  try {
    return allocateScenePlans(plans, ctx);
  } catch (err) {
    console.warn(`[allocate] pass skipped entirely — ${err instanceof Error ? err.message : err}`);
    return { plans, records: [], enabled: false };
  }
};
