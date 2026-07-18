/**
 * Per-VIDEO throughline anchor selection.
 *
 * WHY THIS EXISTS. `composeSceneLayout` used to pin the recurring motif to
 * `throughlineAnchorFor(aspect)` — one GLOBAL constant (16:9 → 1360,540), the
 * same point for every brand, every register, every frame. The head authors a
 * `throughline` element with real bounds and the composer discarded them, so
 * the motif landed wherever the constant pointed. Measured over the 25 stored
 * `composition.json` builds, that constant put the motif inside the head's own
 * hero box in a large share of composed scenes — a collision the COMPOSER
 * manufactured, which P1's repair ladder then paid for by trimming the copy.
 *
 * WHY NOT JUST USE THE HEAD'S BOUNDS. The anchor is not a free per-scene
 * choice: it is a CROSS-SCENE CONTRACT. `assessContinuity`
 * (lib/agents/quality-gates.ts) groups every `data-throughline`-tagged wrapper
 * by slug and measures the SPAN between its min and max literal px left/top
 * across scenes. Over `DRIFT_FRACTION` (10%) of the canvas on either axis and
 * the motif is judged to teleport; `repositionThroughline` then SNAPS every
 * occurrence to the median (a zero-token string edit that would silently undo
 * any per-scene placement we chose), and past `SEVERE_DRIFT_PX = 280` the
 * pipeline spends a retry. Consuming the head's per-scene bounds verbatim
 * would blow that span open on the first scene where the head moved the motif.
 *
 * THE RESOLUTION. The contract wants CONSISTENCY, not one specific coordinate.
 * So: choose ONE anchor per video — the position least occupied across the most
 * scenes, scored over the head's OWN authored frames — and use it in every
 * scene. Where that anchor still collides in a particular scene, displace
 * LOCALLY by the smallest offset that clears it, bounded so the resulting
 * cross-scene span stays inside the drift tolerance with margin. When no
 * bounded offset clears the collision, keep the anchor and let P1's repair
 * ladder decide — silently amputating the hero is not this module's call.
 *
 * Pure: no I/O, no LLM, no randomness. Identical scenes in → identical anchor
 * out, which is what makes the choice safe to recompute at author time
 * (plan-validate) and at build time (cast-build) without the two disagreeing.
 */
import type { SceneComposition } from "../../src/schema";
import { throughlineAnchorFor } from "./choreograph";
import { CANVAS, BOTTOM_SAFE_FRAC, THROUGHLINE_SIZE, composeSceneLayout, type Aspect } from "./layout-composer";

export type Rect = { x: number; y: number; w: number; h: number };

/** The scene shape this module reads — the head's authored composition plus the
 *  register, so an un-composed scene can still contribute its table geometry. */
export interface AnchorScene {
  register?: string;
  content?: Record<string, unknown>;
  composition?: SceneComposition;
}

export interface AnchorChoice {
  /** The one cross-scene anchor (top-left of the motif box), in canvas px. */
  anchor: { left: number; top: number };
  /** Per-scene top-left, anchor + a bounded local displacement. Same length as
   *  the input scenes, and every entry is within the drift budget of `anchor`. */
  perScene: { left: number; top: number }[];
  /** Telemetry, for the build log — never read by logic. */
  telemetry: {
    /** Scenes whose motif box collides with a scored occupant AT the anchor. */
    collidingAtAnchor: number;
    /** Scenes a bounded local displacement rescued. */
    displaced: number;
    /** Scenes still colliding after displacement (handed to the repair ladder). */
    unresolved: number;
    /** Cross-scene span of the emitted positions — must stay under the budget. */
    spanX: number;
    spanY: number;
    /** True when the choice is the historical global constant. */
    isDefaultAnchor: boolean;
  };
}

// ─── The drift budget ───────────────────────────────────────────────────────

/**
 * Mirrors `DRIFT_FRACTION` in lib/agents/quality-gates.ts. Mirrored rather than
 * imported to keep this module a dependency-light leaf on the build hot path;
 * `throughline-anchor.test.ts` pins the two together so a change there fails
 * here loudly instead of drifting apart.
 */
export const DRIFT_FRACTION = 0.1;

/**
 * How much of the gate's tolerance we are willing to spend. The gate fires on
 * `span > threshold`, so 1.0 would sit exactly on the boundary and any rounding
 * downstream (the assembler writes integer px) could tip it over. 0.6 keeps a
 * comfortable margin AND keeps the motif reading as one object: the point of a
 * local displacement is to clear a neighbour, not to relocate the motif.
 */
export const DRIFT_SAFETY = 0.6;

/** Max per-scene displacement from the anchor on each axis. Half the allowed
 *  SPAN, because two scenes displaced to opposite extremes span twice this. */
export const driftBudgetFor = (aspect: Aspect): { dx: number; dy: number } => {
  const { w, h } = CANVAS[aspect];
  return {
    dx: Math.floor((DRIFT_FRACTION * DRIFT_SAFETY * w) / 2),
    dy: Math.floor((DRIFT_FRACTION * DRIFT_SAFETY * h) / 2),
  };
};

// ─── Occupancy ──────────────────────────────────────────────────────────────

/**
 * Weights. The motif over COPY is the defect that costs a build real quality —
 * a decorative shape painted across a headline — and the composer's own slot
 * table has always treated it as forbidden. The motif over the HERO is the
 * milder case (visual-on-visual; `ElementSlot.allowedOverlaps` even declares it
 * legal, which is exactly why it went unmeasured for so long), so it is scored
 * but does not outrank copy. Chrome carries the brand lockup and is hard.
 */
const WEIGHT = { copy: 4, chrome: 4, hero: 1 } as const;

/** A hero that blankets the frame is a canvas TREATMENT — the motif has nowhere
 *  else to be and sitting on it is the composition, not a collision. */
const isFullBleed = (r: Rect, W: number, H: number): boolean => r.w * r.h >= 0.85 * W * H;

const overlapArea = (a: Rect, b: Rect): number => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
};

export interface SceneOccupancy {
  /** Weighted rects the motif should avoid in this scene. */
  occupants: { rect: Rect; weight: number }[];
  /** The head's own authored top-left for the motif, when it authored one. */
  authored: { left: number; top: number } | null;
  /**
   * FORBIDDEN rect — a hard constraint, not a weight. Set only for a scene on
   * the deterministic TABLE path (no head bounds), where `composeSceneLayout`
   * still runs `assertPlanInvariants` and THROWS on an undeclared copy↔motif
   * overlap. Those tables were hand-checked against the old global constant, so
   * a freely-chosen anchor could crash a mixed video (some scenes composed,
   * some not). Candidates intersecting any `forbidden` rect are excluded from
   * selection outright rather than merely penalised.
   */
  forbidden: Rect | null;
}

const readBounds = (composition: SceneComposition | undefined, role: string): Rect | null => {
  const b = composition?.elements?.find((e) => e.role === role)?.bounds;
  if (!b) return null;
  const ok = [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n));
  if (!ok || b.w <= 0 || b.h <= 0) return null;
  return { x: b.x, y: b.y, w: b.w, h: b.h };
};

/**
 * The rects one scene contributes to the score.
 *
 * Derived by asking `composeSceneLayout` itself (with the motif switched OFF)
 * rather than re-reading the head's JSON: the composer decides head-bounds
 * versus table fallback, clamps, and drops BOTH head rects when hero and copy
 * collide. Re-deriving any of that here would let the scorer reason about rects
 * the build will not actually use — the exact class of bug this whole change
 * exists to remove.
 */
export const occupancyFor = (scene: AnchorScene, aspect: Aspect): SceneOccupancy => {
  const { w: W, h: H } = CANVAS[aspect];
  const occupants: { rect: Rect; weight: number }[] = [];

  let plan: ReturnType<typeof composeSceneLayout> | null = null;
  try {
    plan = composeSceneLayout(
      { register: scene.register, content: scene.content, composition: scene.composition },
      aspect,
      { hasThroughline: false },
    );
  } catch {
    plan = null; // a scene the composer itself rejects contributes nothing
  }

  const slot = (id: string): Rect | null => {
    const b = plan?.elements.find((e) => e.id === id)?.bounds;
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  };

  const hero = slot("hero");
  if (hero && !isFullBleed(hero, W, H)) occupants.push({ rect: hero, weight: WEIGHT.hero });

  const copy = slot("copy");
  if (copy) occupants.push({ rect: copy, weight: WEIGHT.copy });

  const chrome = slot("chrome") ?? { x: 0, y: H - (aspect === "9:16" ? 80 : 72), w: W, h: aspect === "9:16" ? 80 : 72 };
  occupants.push({ rect: chrome, weight: WEIGHT.chrome });

  // The table path is the one that can THROW — see SceneOccupancy.forbidden.
  const usesHeadBounds = !!(readBounds(scene.composition, "hero") ?? readBounds(scene.composition, "copy"));
  const forbidden = !usesHeadBounds && copy ? copy : null;

  const tl = readBounds(scene.composition, "throughline");
  return { occupants, authored: tl ? { left: tl.x, top: tl.y } : null, forbidden };
};

// ─── Candidate generation + scoring ─────────────────────────────────────────

/** Grid step for the exhaustive scan. 20px is finer than any collision this
 *  resolves and keeps the scan under ~5k candidates at 16:9 (microseconds). */
const GRID_STEP = 20;

/** The region a motif box may legally occupy: fully on canvas and clear of the
 *  bottom reserve that `validateScenePlan` enforces for content slots. */
const legalRange = (aspect: Aspect): { maxLeft: number; maxTop: number } => {
  const { w: W, h: H } = CANVAS[aspect];
  return {
    maxLeft: W - THROUGHLINE_SIZE,
    maxTop: Math.floor(BOTTOM_SAFE_FRAC * H) - THROUGHLINE_SIZE,
  };
};

const clampToLegal = (p: { left: number; top: number }, aspect: Aspect): { left: number; top: number } => {
  const { maxLeft, maxTop } = legalRange(aspect);
  return {
    left: Math.max(0, Math.min(Math.round(p.left), maxLeft)),
    top: Math.max(0, Math.min(Math.round(p.top), maxTop)),
  };
};

const boxAt = (p: { left: number; top: number }): Rect => ({
  x: p.left,
  y: p.top,
  w: THROUGHLINE_SIZE,
  h: THROUGHLINE_SIZE,
});

/** Weighted overlap of a motif box at `p` against one scene's occupants. */
export const costAt = (p: { left: number; top: number }, occ: SceneOccupancy): number => {
  const box = boxAt(p);
  let total = 0;
  for (const o of occ.occupants) total += overlapArea(box, o.rect) * o.weight;
  return total;
};

const collidesAt = (p: { left: number; top: number }, occ: SceneOccupancy): boolean => costAt(p, occ) > 0;

/**
 * Choose ONE anchor for the whole video. Candidates are the historical default,
 * every head-authored motif position, and an exhaustive grid — scored by total
 * weighted occupancy across all scenes. Ties break toward the DEFAULT anchor
 * (nearest wins), so a video whose frames leave the old constant clear keeps
 * it: the film wrapper centers its match-cut camera push there, and a choice
 * that changes nothing should change nothing.
 */
export const chooseAnchor = (occupancies: SceneOccupancy[], aspect: Aspect): { left: number; top: number } => {
  const fallback = throughlineAnchorFor(aspect);
  const def = clampToLegal(fallback, aspect);
  if (occupancies.length === 0) return def;

  const { maxLeft, maxTop } = legalRange(aspect);
  const candidates: { left: number; top: number }[] = [def];
  for (const occ of occupancies) if (occ.authored) candidates.push(clampToLegal(occ.authored, aspect));
  for (let left = 0; left <= maxLeft; left += GRID_STEP) {
    for (let top = 0; top <= maxTop; top += GRID_STEP) candidates.push({ left, top });
  }

  // HARD constraint first (see SceneOccupancy.forbidden): a candidate that
  // would make the table path throw is not a candidate. If that leaves nothing,
  // fall back to the historical constant, which every table was hand-checked
  // against — a plainer choice, never a crash.
  const forbidden = occupancies.map((o) => o.forbidden).filter((r): r is Rect => r !== null);
  const legal = candidates.filter((c) => !forbidden.some((f) => overlapArea(boxAt(c), f) > 0));
  const pool = legal.length > 0 ? legal : [def];

  let best = def;
  let bestCost = Infinity;
  let bestCollisions = Infinity;
  let bestDist = Infinity;
  for (const c of pool) {
    let cost = 0;
    let collisions = 0;
    for (const occ of occupancies) {
      const k = costAt(c, occ);
      cost += k;
      if (k > 0) collisions++;
    }
    const dist = Math.hypot(c.left - def.left, c.top - def.top);
    // Primary: fewest scenes with ANY collision (the founder's "unoccupied
    // across the most scenes"). Then total weighted area. Then stay near the
    // historical anchor.
    const better =
      collisions < bestCollisions ||
      (collisions === bestCollisions && cost < bestCost) ||
      (collisions === bestCollisions && cost === bestCost && dist < bestDist);
    if (better) {
      best = c;
      bestCost = cost;
      bestCollisions = collisions;
      bestDist = dist;
    }
  }
  return best;
};

/**
 * The smallest bounded displacement from `anchor` that clears this scene, or
 * `anchor` itself when none does. Searched in rings of increasing offset so the
 * FIRST clearing offset found is the smallest; axis order is deterministic so
 * two equally-small offsets always resolve the same way.
 */
export const displaceFor = (
  anchor: { left: number; top: number },
  occ: SceneOccupancy,
  aspect: Aspect,
): { left: number; top: number } => {
  if (!collidesAt(anchor, occ)) return anchor;
  const { dx, dy } = driftBudgetFor(aspect);
  const { maxLeft, maxTop } = legalRange(aspect);
  const step = 10;
  const maxRing = Math.ceil(Math.max(dx, dy) / step);

  let bestPartial: { left: number; top: number } | null = null;
  let bestPartialCost = costAt(anchor, occ);

  for (let ring = 1; ring <= maxRing; ring++) {
    const candidates: { left: number; top: number }[] = [];
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue; // ring shell only
        const ox = i * step;
        const oy = j * step;
        if (Math.abs(ox) > dx || Math.abs(oy) > dy) continue;
        const p = { left: anchor.left + ox, top: anchor.top + oy };
        if (p.left < 0 || p.top < 0 || p.left > maxLeft || p.top > maxTop) continue;
        candidates.push(p);
      }
    }
    // Deterministic order within a ring: by |offset|, then left, then top.
    candidates.sort(
      (a, b) =>
        Math.hypot(a.left - anchor.left, a.top - anchor.top) - Math.hypot(b.left - anchor.left, b.top - anchor.top) ||
        a.left - b.left ||
        a.top - b.top,
    );
    for (const p of candidates) {
      if (occ.forbidden && overlapArea(boxAt(p), occ.forbidden) > 0) continue; // would throw
      const k = costAt(p, occ);
      if (k === 0) return p; // cleared — smallest such offset wins
      if (k < bestPartialCost) {
        bestPartialCost = k;
        bestPartial = p;
      }
    }
  }
  // Nothing inside the budget clears it. Keep the ANCHOR rather than ship a
  // half-measure that spends drift for no guarantee — the repair ladder owns
  // this case, and a stable motif is the better input for it.
  void bestPartial;
  return anchor;
};

/**
 * The whole decision for one video: one anchor + the per-scene positions.
 * `scenes` must be every scene of the video, in order.
 */
export const selectThroughlineAnchor = (scenes: AnchorScene[], aspect: Aspect): AnchorChoice => {
  const def = clampToLegal(throughlineAnchorFor(aspect), aspect);
  const occupancies = scenes.map((s) => occupancyFor(s, aspect));
  const anchor = chooseAnchor(occupancies, aspect);

  let collidingAtAnchor = 0;
  let displaced = 0;
  let unresolved = 0;
  const perScene = occupancies.map((occ) => {
    if (!collidesAt(anchor, occ)) return anchor;
    collidingAtAnchor++;
    const p = displaceFor(anchor, occ, aspect);
    if (p.left === anchor.left && p.top === anchor.top) unresolved++;
    else displaced++;
    return p;
  });

  const lefts = perScene.map((p) => p.left);
  const tops = perScene.map((p) => p.top);
  return {
    anchor,
    perScene,
    telemetry: {
      collidingAtAnchor,
      displaced,
      unresolved,
      spanX: perScene.length ? Math.max(...lefts) - Math.min(...lefts) : 0,
      spanY: perScene.length ? Math.max(...tops) - Math.min(...tops) : 0,
      isDefaultAnchor: anchor.left === def.left && anchor.top === def.top,
    },
  };
};
