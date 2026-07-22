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
 *
 * GATE FIX (2026-07-22) — TEXT-SHRINKING IS NO LONGER THE ENTRY TICKET FOR
 * ALL ACTION. The first shipping cut gated every tier behind `anyResize`: if
 * no text box needed sizing, the scene was kept and distribution was never
 * attempted. Live evidence (3 pinned-script Notion runs): s0/s3/s4 each
 * recorded `no-text-to-size(kept=1,no-strings=0)` while occupancy blocked
 * those same scenes at 24–39% void in every run. A scene can have
 * perfectly-sized text AND a giant hole — the gate conflated "nothing to
 * size" with "nothing to do". Two additions, both still under RB_ALLOCATE
 * (no new flag):
 *
 *   FIX 1 — VOID REPAIR WITHOUT RESIZE. When nothing needs sizing but the
 *   scene's before ink-void is CATASTROPHIC (≥ CATASTROPHIC_INK_VOID of
 *   title-safe, the corpus bar every re-score table used), Tier 1
 *   distribution is attempted anyway: kept-tight text keeps its truthful
 *   SIZE (fixedSize — sizing stays untouched) but its POSITION is freed to
 *   the shape machinery. Hero and throughline stay pinned. Because no shrink
 *   pays for the move, the guard demands material IMPROVEMENT
 *   (≥ MIN_VOID_IMPROVE), not merely no-regression. Catastrophic-but-
 *   treatment scenes are exempt: a ≥85% canvas element makes the void number
 *   an instrument artefact (round-1 finding #4), never a licence to act.
 *
 *   FIX 2 — CAPPED HERO GROWTH, a separate tier, separately guarded and
 *   reported (`record.heroGrowth` / `heroGrowthSkipped`). Arms ONLY when the
 *   before ink-void is catastrophic AND that void is adjacent to the hero;
 *   structurally unreachable for a canvas-treatment hero (≥85% of frame —
 *   the round-2 bleed signal). Grows the hero into the adjacent dead region:
 *   area ≤ HERO_GROWTH_AREA_CAP (1.3×), aspect ratio preserved, growth never
 *   moves the hero (grown ⊇ original), moving edges stay inside the
 *   title-safe content rect, disjointness maintained against every
 *   non-embedded element, and the grown box must stay below the treatment
 *   threshold. Same do-no-harm rule: growth that does not materially improve
 *   the ink view reverts. Since diegetic ink = box (21/21 measured), a grown
 *   hero fills its new box by construction, and this pass runs before the
 *   element briefs, so the leaf receives the grown bounds automatically.
 *
 * REASON VOCABULARY (telemetry must distinguish "tried and guarded" from
 * "never tried" — that ambiguity is what hid the gate bug):
 *   kept, never tried:  no-elements · no-text-to-size(kept=K,no-strings=N,
 *                       void=P%[:treatment-artifact])
 *   tried and guarded:  void-no-improvement:A%→B% · void-unresolved-
 *                       separation:… · void-allocate-threw:… (the un-prefixed
 *                       twins remain the resize path's vocabulary)
 *   applied:            void-distributed (distribution-without-resize) ·
 *                       reason unset (resize path, distribution clean) ·
 *                       guard-note reasons on in-place placements
 *   growth tier:        record.heroGrowth (applied) / heroGrowthSkipped =
 *                       treatment-bleed | not-hero-adjacent |
 *                       void-already-repaired | no-room |
 *                       no-improvement:A%→B% | validate:…
 */
import type { ScenePlan, ElementSlot, Aspect } from "./layout-composer";
import { validateScenePlan, CANVAS } from "./layout-composer";
import type { SceneComposition } from "../../src/schema";
import { allocateLayout, contentRect, type AllocElementInput, type Rect } from "./allocate-layout";
import { inkSizedBox, predictInkRect, type OwnedField } from "./predict-ink";
import { scoreLayout, type LayoutScore, type ScoredElement } from "./layout-metrics";
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
  /**
   * Kept scenes: why (never-tried `no-text-to-size(…)` vs tried-and-guarded
   * `void-no-improvement:…` — the distinction the gate bug hid). Applied
   * scenes: the tier-1 rejection note when the shipped placement fell back
   * (`ink-void-regression:…`), or `void-distributed` when the decoupled
   * void-repair path is what acted. See the module header's vocabulary.
   */
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
  /**
   * FIX 2 — the capped hero-growth tier's own record. Present only when the
   * hero actually grew; `inkVoidBefore/After` here are measured at the
   * growth step (i.e. after any distribution), so the tier's contribution is
   * attributable separately from Tier 1's.
   */
  heroGrowth?: { from: Rect; to: Rect; areaFactor: number; inkVoidBefore: number | null; inkVoidAfter: number | null };
  /** Why the growth tier, once ARMED (catastrophic void + a hero present),
   *  did not apply: treatment-bleed | not-hero-adjacent |
   *  void-already-repaired | no-room | no-improvement:A%→B% | validate:… */
  heroGrowthSkipped?: string;
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

// ─── Gate-fix constants (2026-07-22) ────────────────────────────────────────

/**
 * CATASTROPHIC ink-void threshold, fraction of title-safe. The corpus bar:
 * every re-score table counted "scenes with ink-void > 25%" as the failure
 * class (head 16, allocator 0), and the live Notion runs blocked s0/s3/s4 at
 * 24–39%. Below it, an all-tight scene is genuinely "nothing to do".
 */
export const CATASTROPHIC_INK_VOID = 0.25;

/**
 * Material-improvement bar for SPECULATIVE moves — distribution attempted
 * without a resize paying for it, and hero growth. The resize path keeps its
 * original no-regression tolerance (a shrink is worth shipping at equal
 * void); a pure move or growth that buys less than 2pp of ink-void is churn
 * and reverts. 2pp is the same materiality bar the pre-registered gate used
 * for the corpus mean.
 */
export const MIN_VOID_IMPROVE = 0.02;

/**
 * FIX 2's hard area cap: a grown hero may claim at most 1.3× its authored
 * area. DISTINCT from allocate-layout's HERO_GROWTH_CAP (1.6), which bounds
 * the round-2 dry-run RESIZE solver — this one bounds a production post-pass
 * whose mandate is filling an adjacent hole, not re-sizing the composition.
 */
export const HERO_GROWTH_AREA_CAP = 1.3;

/** Canvas-treatment threshold — the round-2 bleed signal (authored hero area
 *  ≥85% of frame), same 0.85 layout-metrics.isCanvasTreatment uses. A
 *  treatment hero never grows, and a grown hero must never BECOME one. */
const TREATMENT_FRAC = 0.85;

const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export type VoidSide = "left" | "right" | "above" | "below";

/**
 * Which side of the hero the void sits on, or null when not adjacent. The
 * void rect is lattice-quantised (54px cells, centre-sampled — see
 * layout-metrics), so its edge can sit up to CELL/2 = 27px away from (or
 * slightly inside) the ink edge that actually bounds it; the tolerance covers
 * that worst case plus the standard 2px slack. Ties break in the fixed order
 * below > right > above > left (largest shared edge first) — deterministic.
 */
export const heroVoidSide = (v: Rect, hero: Rect, gutter: number): VoidSide | null => {
  const tol = Math.max(gutter, 27) + 2;
  const ox = Math.min(hero.x + hero.w, v.x + v.w) - Math.max(hero.x, v.x);
  const oy = Math.min(hero.y + hero.h, v.y + v.h) - Math.max(hero.y, v.y);
  const cands: { side: VoidSide; shared: number }[] = [];
  if (ox > 0) {
    if (Math.abs(v.y - (hero.y + hero.h)) <= tol) cands.push({ side: "below", shared: ox });
    if (Math.abs(hero.y - (v.y + v.h)) <= tol) cands.push({ side: "above", shared: ox });
  }
  if (oy > 0) {
    if (Math.abs(v.x - (hero.x + hero.w)) <= tol) cands.push({ side: "right", shared: oy });
    if (Math.abs(hero.x - (v.x + v.w)) <= tol) cands.push({ side: "left", shared: oy });
  }
  if (cands.length === 0) return null;
  const rank: Record<VoidSide, number> = { below: 0, right: 1, above: 2, left: 3 };
  cands.sort((a, b) => b.shared - a.shared || rank[a.side] - rank[b.side]);
  return cands[0].side;
};

/**
 * FIX 2's geometry: the largest aspect-preserving growth of `hero` toward the
 * adjacent void that (a) stays ≤ HERO_GROWTH_AREA_CAP × the original area,
 * (b) stays BELOW the canvas-treatment threshold, (c) never moves the hero —
 * the grown box CONTAINS the original, (d) moves an edge only inside the
 * title-safe content rect `C` (an edge the head already parked outside C is
 * frozen), and (e) overlaps no obstacle. The edge opposite the void is
 * anchored; the perpendicular axis expands about the hero's centre, clamped.
 * A deterministic k-ladder takes the largest factor that clears the
 * obstacles. Returns null when no real growth is possible.
 */
export const growHeroBounds = (
  hero: Rect,
  voidRect: Rect,
  obstacles: Rect[],
  C: Rect,
  canvas: { w: number; h: number },
  gutter: number,
): Rect | null => {
  const side = heroVoidSide(voidRect, hero, gutter);
  if (!side) return null;
  const area = hero.w * hero.h;
  if (area <= 0) return null;
  const kArea = Math.sqrt(HERO_GROWTH_AREA_CAP);
  // Strictly below the treatment threshold — growth must never manufacture a
  // canvas treatment (that changes the frame's character AND blinds the void
  // instrument to the hero).
  const kTreat = Math.sqrt((TREATMENT_FRAC * canvas.w * canvas.h) / area) * 0.999;
  // Per-edge growth room: an edge inside the content rect may extend to it;
  // an edge already outside is frozen (growth claims no new off-safe ground).
  const L = hero.x >= C.x ? C.x : hero.x;
  const T = hero.y >= C.y ? C.y : hero.y;
  const R = hero.x + hero.w <= C.x + C.w ? C.x + C.w : hero.x + hero.w;
  const B = hero.y + hero.h <= C.y + C.h ? C.y + C.h : hero.y + hero.h;
  const kRoom = Math.min((R - L) / hero.w, (B - T) / hero.h);
  const kMax = Math.min(kArea, kTreat, kRoom);
  if (kMax <= 1.01) return null;
  const clampTo = (pref: number, lo: number, hi: number): number => Math.min(Math.max(pref, lo), hi);
  for (const f of [1, 0.85, 0.7, 0.55, 0.4, 0.25]) {
    const k = 1 + (kMax - 1) * f;
    // Floor, not round: the 1.3× area cap is HARD, and rounding both axes up
    // can leak past it (840×320 @ √1.3 rounds to 958×365 = 1.301×).
    const w = Math.floor(hero.w * k);
    const h = Math.floor(hero.h * k);
    if (w <= hero.w || h <= hero.h) continue; // rounding ate the growth
    let x: number;
    let y: number;
    if (side === "right" || side === "left") {
      x = side === "right" ? hero.x : hero.x + hero.w - w;
      y = clampTo(Math.round(hero.y + hero.h / 2 - h / 2), Math.max(T, hero.y + hero.h - h), Math.min(hero.y, B - h));
    } else {
      y = side === "below" ? hero.y : hero.y + hero.h - h;
      x = clampTo(Math.round(hero.x + hero.w / 2 - w / 2), Math.max(L, hero.x + hero.w - w), Math.min(hero.x, R - w));
    }
    const g: Rect = { x, y, w, h };
    if (!rectContains({ x: L, y: T, w: R - L, h: B - T }, g)) continue;
    if (!rectContains(g, hero)) continue; // growth must extend, never move
    if (obstacles.some((o) => rectsOverlap(g, o))) continue;
    return g;
  }
  return null;
};

/** Edge-to-edge gap between two rects (0 when they touch or overlap). */
const rectGap = (a: Rect, b: Rect): number => {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.max(dx, dy) === 0 ? 0 : Math.hypot(dx, dy);
};

/** The ink view of a plan: text bounds → predicted ink rect; everything else
 *  verbatim. The same transformation the ink re-score scored, so the pass's
 *  telemetry and the offline evidence speak one language. Returns the FULL
 *  score — the gate fix needs the void RECT (hero adjacency) and the
 *  canvas-treatment count (artefact exemption), not just the void fraction. */
const inkScore = (
  elements: { id: string; role: string; bounds: Rect }[],
  fieldsById: Map<string, OwnedField[]>,
  metricsById: Map<string, FontMetrics>,
  aspect: Aspect,
): LayoutScore | null => {
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
    return scored.length > 0 ? scoreLayout(scored, aspect) : null;
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
 * Attribution knobs for offline replays and tests ONLY. Production
 * (`maybeAllocateScenePlans`) always runs both fixes — they share RB_ALLOCATE,
 * no separate flag. `voidRepair:false` restores the pre-fix gate (text-shrink
 * as the entry ticket); `heroGrowth:false` runs FIX 1 without FIX 2, so a
 * replay can attribute every delta to exactly one fix.
 */
export interface AllocateApplyOpts {
  voidRepair?: boolean;
  heroGrowth?: boolean;
}

/**
 * The pass. Pure given its inputs; the flag check lives in
 * `maybeAllocateScenePlans` so this stays directly testable.
 */
export const allocateScenePlans = (plans: ScenePlan[], ctx: AllocateApplyCtx, opts?: AllocateApplyOpts): AllocateApplyResult => {
  const { aspect } = ctx;
  const { w: W, h: H } = CANVAS[aspect];
  const allowVoidRepair = opts?.voidRepair !== false;
  const allowHeroGrowth = opts?.heroGrowth !== false;
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
      // would read as a change that never happened. Same for a tentatively
      // recorded hero growth; heroGrowthSkipped stays (a why-not is still true).
      record.resized = [];
      record.moved = [];
      record.freedPxTotal = 0;
      delete record.heroGrowth;
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
      // Kept-tight text with strings: its SIZE is truthful (ink+padding fills
      // it), so in the void-repair path its POSITION may be freed to the
      // shape machinery at that exact size. Sizing stays untouched either way.
      const keptTightFree = new Map<string, { size: { w: number; h: number }; chars: number }>();
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
          const chars = fields.reduce((n, f) => n + (typeof f.value === "string" ? f.value.length : JSON.stringify(f.value ?? "").length), 0);
          const sized = inkSizedBox(el.bounds, fields, { w: W, h: H }, metrics);
          if (sized.kept) {
            // The declared box already tells the truth (ink+padding fills it).
            keptTight++;
            keptTightFree.set(el.id, { size: { w: el.bounds.w, h: el.bounds.h }, chars });
            inputs.push({ ...base, pinnedBounds: el.bounds });
            continue;
          }
          anyResize = true;
          sizedById.set(el.id, sized.box);
          record.resized.push({ id: el.id, from: round(el.bounds), to: { x: el.bounds.x, y: el.bounds.y, ...sized.box }, freedPx: sized.freedPx });
          record.freedPxTotal += sized.freedPx;
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

      const beforeEls = plan.elements.map((e) => ({ id: e.id, role: e.id, bounds: e.bounds as Rect }));
      const beforeScore = inkScore(beforeEls, fieldsById, metricsById, aspect);
      const beforeVoid = beforeScore?.largestVoid ?? null;
      // ALWAYS recorded now, kept scenes included — a kept scene with a
      // measured 33% void must be visible as such (the null here is what hid
      // the gate bug in the live telemetry).
      record.inkVoidBefore = beforeVoid;
      record.inkVoidAfter = beforeVoid;

      // A ≥85% canvas element makes the void number an instrument artefact
      // (round-1 finding #4: final-checkr s2 scores 55.6% void BECAUSE its
      // reference-grade dashboard is excluded) — never a licence to act.
      const treatmentArtefact = (beforeScore?.canvasTreatments ?? 0) > 0;
      const rawCatastrophic = beforeVoid !== null && beforeVoid >= CATASTROPHIC_INK_VOID;
      const catastrophic = rawCatastrophic && !treatmentArtefact;
      // FIX 1 — the decoupled trigger: distribution is attemptable on a
      // catastrophic void even when no text needed sizing.
      const voidRepair = allowVoidRepair && !anyResize && catastrophic;

      if (!anyResize && !voidRepair) {
        // The growth tier's unreachability for a canvas-treatment scene is
        // RECORDED, not silent — the controls' proof reads this marker.
        if (allowHeroGrowth && rawCatastrophic && treatmentArtefact && plan.elements.some((e) => e.id === "hero")) {
          record.heroGrowthSkipped = "treatment-bleed";
        }
        const voidNote =
          beforeVoid === null ? "" : `,void=${(beforeVoid * 100).toFixed(1)}%${treatmentArtefact ? ":treatment-artifact" : ""}`;
        return keep(`no-text-to-size(kept=${keptTight},no-strings=${noStrings}${voidNote})`);
      }

      // ── Tier 1: DISTRIBUTE (the round-2 shape machinery) ────────────────
      const hero = plan.elements.find((e) => e.id === "hero");
      const heroTreatment = hero ? (hero.bounds.w * hero.bounds.h >= TREATMENT_FRAC * W * H ? "bleed" : "placed") : null;
      const mapBack = (slots: { id: string; bounds: Rect }[]): ElementSlot[] =>
        plan.elements.map((el) => {
          const slot = slots.find((s) => s.id === el.id);
          if (!slot) throw new Error(`allocate-apply: slot "${el.id}" missing from allocation`);
          if (el.id === "atmosphere" || el.id === "chrome") return el;
          // Bounds only — z (the paint layer) and every other slot field are
          // contracts this pass has no authority over.
          return { ...el, bounds: { ...el.bounds, ...round(slot.bounds) } };
        });
      // In the void-repair path the kept-tight text keeps its truthful SIZE
      // but its POSITION is freed to the shape machinery. Everywhere else the
      // inputs ship exactly as classified (the resize path is untouched by
      // the gate fix).
      const tier1Inputs = voidRepair
        ? inputs.map((inp) => {
            const free = keptTightFree.get(inp.id);
            if (!free) return inp;
            return { id: inp.id, role: inp.role, focalRank: 2, fixedSize: free.size, textChars: free.chars } as AllocElementInput;
          })
        : inputs;
      let placement: "distributed" | "in-place" = "distributed";
      let shape: string | undefined;
      let nextElements: ElementSlot[] | null = null;
      let guardNote = "";
      try {
        const alloc = allocateLayout({ aspect, register: plan.register, elements: tier1Inputs, mode: "pipeline", heroTreatment });
        if (alloc.unresolved && alloc.unresolved.length > 0) {
          guardNote = `${voidRepair ? "void-" : ""}unresolved-separation:${alloc.unresolved.map((p) => p.join("×")).join(",")}`;
        } else {
          nextElements = mapBack(alloc.slots);
          shape = alloc.shape;
          // THE NO-REGRESSION GUARD. The distribution must measure NO WORSE
          // than the input on the same ink instrument the re-score used —
          // round 2's own evidence is that repositioning alone can hurt, and
          // this pass's mandate is sizing truth, not speculative moves. In
          // the void-repair path nothing pays for the move except the void it
          // closes, so the bar is material IMPROVEMENT, not no-regression.
          const afterVoid =
            inkScore(
              nextElements.map((e) => ({ id: e.id, role: e.id, bounds: e.bounds as Rect })),
              fieldsById,
              metricsById,
              aspect,
            )?.largestVoid ?? null;
          const rejected = voidRepair
            ? beforeVoid === null || afterVoid === null || afterVoid > beforeVoid - MIN_VOID_IMPROVE
            : beforeVoid !== null && afterVoid !== null && afterVoid > beforeVoid + 0.005;
          if (rejected) {
            guardNote = voidRepair
              ? `void-no-improvement:${beforeVoid === null ? "—" : (beforeVoid * 100).toFixed(1) + "%"}→${afterVoid === null ? "—" : (afterVoid * 100).toFixed(1) + "%"}`
              : `ink-void-regression:${(beforeVoid! * 100).toFixed(1)}%→${(afterVoid! * 100).toFixed(1)}%`;
            nextElements = null;
            shape = undefined;
          }
        }
      } catch (err) {
        guardNote = `${voidRepair ? "void-" : ""}allocate-threw:${err instanceof Error ? err.message : String(err)}`;
      }

      // ── Tier 2: SHRINK IN PLACE — the null-risk application of the ink
      // premise. Same anchor, same measure, height down to ink+padding: the
      // ink view is byte-identical to the input's by construction, boxes stop
      // lying, and the reserved bottom band is released. Only reachable when
      // something actually resized — the void-repair path has nothing to
      // shrink, so a rejected distribution there ships NO tier-1/2 change. ──
      if (!nextElements && sizedById.size > 0) {
        placement = "in-place";
        nextElements = plan.elements.map((el) => {
          const sized = sizedById.get(el.id);
          if (!sized) return el;
          return { ...el, bounds: { ...el.bounds, h: sized.h } };
        });
      }
      /** True when tier 1 shipped a distribution (before growth composes on
       *  top) — placement/reason attribution reads this, not nextElements. */
      const distributionApplied = nextElements !== null && placement === "distributed";

      // ── Tier 3: CAPPED HERO GROWTH (FIX 2) — separate, separately guarded,
      // separately reported. Arms only on a catastrophic (non-artefact)
      // before-void with a hero on the scene; structurally unreachable for a
      // canvas-treatment hero. Applied on the CURRENT candidate (post
      // distribution), growing into the CURRENT void. ──────────────────────
      if (allowHeroGrowth && rawCatastrophic && hero) {
        const heroArea = hero.bounds.w * hero.bounds.h;
        if (treatmentArtefact || heroArea >= TREATMENT_FRAC * W * H || heroTreatment === "bleed") {
          record.heroGrowthSkipped = "treatment-bleed";
        } else if (!beforeScore?.voidRect || heroVoidSide(beforeScore.voidRect, hero.bounds as Rect, gutter) === null) {
          record.heroGrowthSkipped = "not-hero-adjacent";
        } else {
          const currentEls = (nextElements ?? plan.elements).map((e) => ({ id: e.id, role: e.id, bounds: e.bounds as Rect }));
          const currentScore = nextElements ? inkScore(currentEls, fieldsById, metricsById, aspect) : beforeScore;
          const v = currentScore?.voidRect ?? null;
          // The hero is pinned through tiers 1–2, so its bounds here are the
          // plan's own.
          const heroBounds = hero.bounds as Rect;
          if (!currentScore || !v || currentScore.largestVoid < CATASTROPHIC_INK_VOID) {
            record.heroGrowthSkipped = "void-already-repaired";
          } else if (heroVoidSide(v, heroBounds, gutter) === null) {
            record.heroGrowthSkipped = "not-hero-adjacent";
          } else {
            // Obstacles: every current element except the hero itself, the
            // canvas layers, and anything the head already parked inside or
            // across the hero (embedded children / upstream-declared
            // geometry — growth cannot make those overlaps NEW).
            const obstacles = currentEls
              .filter((e) => e.id !== hero.id && e.role !== "atmosphere" && e.role !== "chrome")
              .filter((e) => !rectContains(heroBounds, e.bounds) && !rectsOverlap(heroBounds, e.bounds))
              .map((e) => e.bounds);
            const grownBounds = growHeroBounds(heroBounds, v, obstacles, contentRect(aspect), { w: W, h: H }, gutter);
            if (!grownBounds) {
              record.heroGrowthSkipped = "no-room";
            } else {
              const grownEls = currentEls.map((e) => (e.id === hero.id ? { ...e, bounds: grownBounds } : e));
              const grownVoid = inkScore(grownEls, fieldsById, metricsById, aspect)?.largestVoid ?? null;
              if (grownVoid === null || grownVoid > currentScore.largestVoid - MIN_VOID_IMPROVE) {
                record.heroGrowthSkipped = `no-improvement:${(currentScore.largestVoid * 100).toFixed(1)}%→${grownVoid === null ? "—" : (grownVoid * 100).toFixed(1) + "%"}`;
              } else {
                // Separately validated: growth must not introduce a plan
                // violation; if it does, ONLY the growth reverts — a clean
                // tier-1 result is not forfeit to a tier-3 bug.
                const candidate = (nextElements ?? plan.elements).map((el) =>
                  el.id === hero.id ? { ...el, bounds: { ...el.bounds, ...grownBounds } } : el,
                );
                const growBaseline = new Set(validateScenePlan(plan, aspect, { composition, content }).map(violationKey));
                const growIntroduced = validateScenePlan({ ...plan, elements: candidate }, aspect, { composition, content }).filter(
                  (x) => !growBaseline.has(violationKey(x)),
                );
                if (growIntroduced.length > 0) {
                  record.heroGrowthSkipped = `validate:${growIntroduced.map(violationKey).join(",")}`;
                } else {
                  record.heroGrowth = {
                    from: round(heroBounds),
                    to: round(grownBounds),
                    areaFactor: Number(((grownBounds.w * grownBounds.h) / Math.max(1, heroArea)).toFixed(3)),
                    inkVoidBefore: currentScore.largestVoid,
                    inkVoidAfter: grownVoid,
                  };
                  nextElements = candidate;
                }
              }
            }
          }
        }
      }

      // Nothing shipped: every armed tier was tried and guarded. Keep the
      // scene with the DISTINCT tried-and-guarded reason — never the
      // never-tried "no-text-to-size".
      if (!nextElements) return keep(guardNote || "void-no-improvement:—→—");

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
      // A growth-only scene shipped no tier-1/2 outcome — placement stays
      // unset there rather than claiming a distribution that never happened.
      if (distributionApplied || sizedById.size > 0) record.placement = placement;
      record.shape = shape;
      if (guardNote) record.reason = guardNote; // why the distribution tier was rejected
      // The decoupled path's applied marker — telemetry must distinguish a
      // distribution the gate fix unlocked from the resize path's.
      if (voidRepair && distributionApplied) record.reason = "void-distributed";
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
      record.inkVoidAfter = inkScore(afterEls, fieldsById, metricsById, aspect)?.largestVoid ?? null;
      if (record.freedPxTotal > 0) record.freedTo = freedDestination(beforeEls, afterEls, gutter);
      // resized[].to carries the FINAL placed rect, not the pre-placement one.
      for (const r of record.resized) {
        const fin = nextElements.find((e) => e.id === r.id);
        if (fin) r.to = round(fin.bounds);
      }
      for (const el of nextElements) record.bounds[el.id] = round(el.bounds);

      const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
      const growNote = record.heroGrowth
        ? ` grew hero ${record.heroGrowth.from.w}×${record.heroGrowth.from.h}→${record.heroGrowth.to.w}×${record.heroGrowth.to.h} (${record.heroGrowth.areaFactor}x, void ${pct(record.heroGrowth.inkVoidBefore)}→${pct(record.heroGrowth.inkVoidAfter)})`
        : "";
      console.log(
        `[allocate] s${i} ${record.placement ?? "grow-only"}${shape ? ` shape=${shape}` : ""} resized ${record.resized.length} [${record.resized.map((r) => `${r.id} ${r.from.w}×${r.from.h}→${r.to.w}×${r.to.h}`).join(", ")}] moved ${record.moved.length} [${record.moved.join(", ")}]${growNote} ink-void ${pct(record.inkVoidBefore)}→${pct(record.inkVoidAfter)} freed ${(record.freedPxTotal / 1000).toFixed(0)}kpx→${record.freedTo ?? "—"}`,
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
