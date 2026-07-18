/**
 * AUTHOR-TIME PLAN VALIDATION + DETERMINISTIC REPAIR (spatial P1, 2026-07-18).
 *
 * `validateScenePlan` (layout-composer.ts) has always implemented the four
 * bounds contracts — CONTAINMENT, undeclared-overlap DISJOINTNESS, the split
 * STRANDED-HERO numeric contract, and the brandMark/CTA BUDGET — and has always
 * returned typed `PlanViolation`s whose `.message` is shaped for a verbatim
 * repair prompt. Until this module it was referenced only by its own test file:
 * dead code, not missing code. This module puts it on the hot path at AUTHOR
 * time — inside the composition head's existing validate→retry loop — so a
 * violating frame is caught and fixed BEFORE any leaf element is emitted.
 *
 * Why the head loop and not cast-build: the head is the ONLY author of
 * `scene.composition`, and cast-build re-derives bounds from it immutably
 * (`composeSceneLayout({... composition: scene.composition})`). A violation
 * found in cast-build has no one to route a repair to; a violation found in the
 * head loop reuses the retry that already exists, for free.
 *
 * A head retry is NOT free, though — GLM charges a ~6-12k fixed thinking tax per
 * creative call — so every violation goes through a DETERMINISTIC REPAIR LADDER
 * first, in focalRank order (the least-dominant box is the one we are willing to
 * move):
 *
 *   (a) CONTAINMENT   → clamp the box into the safe area (canvas + bottom reserve).
 *   (b) DISJOINTNESS  → shrink the LOWER-focalRank box out of the collision,
 *                       choosing the trim that preserves the most area.
 *   (c) TOO SMALL     → if either repair would drive a box below a minimum
 *                       legible size, FAIL LOUDLY (warn + escalate) naming the
 *                       element and the reason — never silently ship a sliver.
 *   (d) STRANDED-HERO / BUDGET → escalate. Repairing these means INVENTING
 *                       composition (growing a hero, reassigning an owner);
 *                       that is the head's job, not a clamp's.
 *
 * Only what the ladder cannot repair becomes a head validation error, carrying
 * `PlanViolation.message` verbatim — which is what that field is for.
 *
 * And when even the head retry fails, `enforcePlanFallback` drops the residual
 * scene's head bounds so `composeSceneLayout` falls back to its per-register /
 * per-aspect literal geometry tables — a working, zero-LLM, provably-valid
 * layout (it re-runs `assertPlanInvariants`). We ship a plainer frame, never a
 * violating one.
 *
 * Pure except for two deliberate mutations, both on the head's freshly-parsed
 * composition objects (never the input script): repaired `element.bounds`, and
 * the terminal fallback's bounds drop.
 */
import {
  CANVAS,
  BOTTOM_SAFE_FRAC,
  composeSceneLayout,
  readHeadBounds,
  validateScenePlan,
  type Aspect,
  type PlanViolation,
  type ScenePlan,
} from "./layout-composer";
import { selectThroughlineAnchor } from "./throughline-anchor";
import type { Scene, SceneComposition, ElementSpec } from "../../src/schema";

// ─── Calibration ────────────────────────────────────────────────────────────

/**
 * The minimum legible size for a repaired content box, as a fraction of the
 * canvas. Below this a copy column cannot hold a headline and a hero stops
 * reading as the frame's subject — a repair that produces such a box is worse
 * than the violation, so the ladder refuses it and escalates instead.
 * (16:9 → 269×119px; 9:16 → 151×211px.)
 */
export const MIN_LEGIBLE_W_FRAC = 0.14;
export const MIN_LEGIBLE_H_FRAC = 0.11;

/** Breathing room left between two boxes a disjointness repair pulled apart.
 *  Applied when it fits; a repair never fails for want of a gutter. */
const GUTTER_FRAC = 0.0125;

/** Repair→recompose→revalidate rounds before escalating. One pass fixes the
 *  common single-collision frame; 3 covers a cascade (fixing A collides with B)
 *  while staying trivially terminating. */
const MAX_REPAIR_PASSES = 3;

/** The roles `composeSceneLayout` consumes head bounds for — and therefore the
 *  only boxes a repair can move. atmosphere / chrome / throughline are
 *  deterministic (full-bleed / fixed bar / pinned drift anchor); when one of
 *  those is half of a collision we move the head-owned partner. */
const HEAD_OWNED_ROLES = new Set(["hero", "copy"]);

/** Kinds the terminal fallback can actually cure by reverting to the geometry
 *  table. A budget violation names the wrong owner — dropping bounds is no fix. */
const GEOMETRY_KINDS = new Set<PlanViolation["kind"]>(["containment", "disjointness", "stranded-hero"]);

// ─── Public shapes ──────────────────────────────────────────────────────────

export type PlanEventOutcome = "repaired" | "escalated" | "fallback";

export interface PlanEvent {
  /** Scene index. */
  scene: number;
  kind: PlanViolation["kind"];
  /** The element(s) involved — "copy", "hero,copy". */
  detail: string;
  outcome: PlanEventOutcome;
  /** Why, for the escalated/fallback cases. */
  reason?: string;
}

export interface PlanValidationResult {
  /** Residual violations as head-facing errors (`PlanViolation.message` verbatim,
   *  scene-prefixed). Empty = the frame is valid, possibly after repair. */
  errors: string[];
  events: PlanEvent[];
  /** One-line telemetry, e.g.
   *  `plan-validate: 2 violation(s) [s0:disjointness(hero,copy), s4:containment(copy)] · 1 repaired · 1 escalated` */
  summary: string;
}

export interface PlanValidateOpts {
  aspect: Aspect;
  /** Mirrors cast-build: the motif slot is added to EVERY scene when the script
   *  has a throughline, so the plan validated here is the plan cast will build. */
  hasThroughline?: boolean;
  /**
   * Terminal mode (post-loop): a scene with residual GEOMETRY violations has its
   * head bounds DROPPED so the composer falls back to its guaranteed-valid
   * literal tables. Off during the head loop — there we want the head to retry.
   */
  terminal?: boolean;
}

// ─── Geometry helpers ───────────────────────────────────────────────────────

type Rect = { x: number; y: number; w: number; h: number };

/** Deliberately re-derived (not imported): the repair needs the SAME predicate
 *  validateScenePlan judges by, and a shared mutable helper would be a coupling
 *  the validator's own test can't vouch for. Half-open, so touching ≠ overlapping. */
const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const isLegible = (r: Rect, W: number, H: number): boolean =>
  r.w >= MIN_LEGIBLE_W_FRAC * W && r.h >= MIN_LEGIBLE_H_FRAC * H;

const isFullBleedRect = (r: Rect, W: number, H: number): boolean => r.w * r.h >= 0.85 * W * H;

/**
 * RUNG (a): shift-then-shrink a box into the canvas AND above the safe bottom.
 * Shift is PREFERRED — it preserves the size the head authored; shrinking only
 * happens when the box is genuinely taller/wider than the safe area.
 *
 * `bottomLimit` is the chrome bar's top edge when the plan carries one. That
 * matters: BOTTOM_SAFE_FRAC·H (1042 @16:9) sits BELOW the chrome bar's top
 * (1008), so clamping to the reserve alone leaves the box colliding with chrome,
 * and rung (b) would then amputate what rung (a) could have simply moved.
 * Clamping to the stricter of the two repairs both contracts with one shift.
 */
const clampIntoSafe = (r: Rect, W: number, H: number, bottomLimit?: number): Rect => {
  const bottom = Math.min(Math.floor(BOTTOM_SAFE_FRAC * H), bottomLimit ?? Infinity);
  const w = Math.max(1, Math.min(r.w, W));
  const h = Math.max(1, Math.min(r.h, bottom));
  const x = Math.max(0, Math.min(Math.round(r.x), W - w));
  const y = Math.max(0, Math.min(Math.round(r.y), bottom - h));
  return { x, y, w, h };
};

/** The chrome bar's top edge — the real bottom of usable content territory. */
const safeBottomOf = (plan: ScenePlan): number | undefined =>
  plan.elements.find((e) => e.kind === "chrome")?.bounds.y;

/**
 * RUNG (b): trim `victim` until it clears `keeper`, taking the trim that leaves
 * the most area. Four candidates (pull each edge back to the keeper's opposite
 * edge); returns null when none survives with positive extent — e.g. the keeper
 * fully contains the victim, which is a composition problem, not a clamp's.
 */
const shrinkOut = (victim: Rect, keeper: Rect, gutter: number): Rect | null => {
  const candidates: Rect[] = [
    { x: victim.x, y: victim.y, w: keeper.x - gutter - victim.x, h: victim.h },
    { x: keeper.x + keeper.w + gutter, y: victim.y, w: victim.x + victim.w - (keeper.x + keeper.w + gutter), h: victim.h },
    { x: victim.x, y: victim.y, w: victim.w, h: keeper.y - gutter - victim.y },
    { x: victim.x, y: keeper.y + keeper.h + gutter, w: victim.w, h: victim.y + victim.h - (keeper.y + keeper.h + gutter) },
  ]
    .map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) }))
    .filter((c) => c.w > 0 && c.h > 0 && !rectsOverlap(c, keeper));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (area(c) > area(best) ? c : best));
};

// ─── Composition access ─────────────────────────────────────────────────────

const elementsOf = (comp: SceneComposition | undefined): ElementSpec[] =>
  comp && Array.isArray(comp.elements) ? (comp.elements as ElementSpec[]) : [];

/** The element `composeSceneLayout` reads for a role — the FIRST match, same
 *  as its own `.find(e => e.role === role)`. */
const specFor = (comp: SceneComposition | undefined, role: string): ElementSpec | undefined =>
  elementsOf(comp).find((e) => e?.role === role);

/** focalRank as a SORT KEY: 1 = the dominant focal object, ascending = more
 *  subordinate. Unranked sorts last (most willing to move). */
const focalRankOf = (comp: SceneComposition | undefined, role: string): number => {
  const r = Number(specFor(comp, role)?.focalRank);
  return Number.isFinite(r) && r > 0 ? r : 99;
};

const writeBounds = (comp: SceneComposition | undefined, role: string, rect: Rect): boolean => {
  const spec = specFor(comp, role);
  if (!spec) return false;
  spec.bounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  return true;
};

// ─── Violation discovery ────────────────────────────────────────────────────

/**
 * The composer's SILENT SAFETY NET, surfaced as a violation.
 *
 * `composeSceneLayout` drops BOTH head bounds to the deterministic table when
 * the head places hero and copy so they collide — correct (never ship
 * interleaved content) but invisible, and it discards the head's whole frame
 * intent for that scene. Surfacing it lets the ladder do the surgical thing
 * instead: shrink the subordinate box out of the collision and KEEP the frame
 * the head composed. Phrased exactly like validateScenePlan's own disjointness
 * message so the head sees one consistent contract.
 */
const netFiredViolations = (
  comp: SceneComposition | undefined,
  register: string | undefined,
  aspect: Aspect,
): PlanViolation[] => {
  if (register === "full-bleed") return []; // copy-over-canvas is the register's declared composition
  const { w: W, h: H } = CANVAS[aspect];
  const hero = readHeadBounds(comp, "hero", aspect);
  const copy = readHeadBounds(comp, "copy", aspect);
  if (!hero || !copy) return [];
  if (isFullBleedRect(hero, W, H)) return []; // a canvas-treatment hero declares the overlap
  if (!rectsOverlap(hero, copy)) return [];
  return [
    {
      pieceId: "copy",
      kind: "disjointness",
      message: `"hero" and "copy" bounds overlap with no declared allowance — content elements must sit in disjoint territory.`,
    },
  ];
};

/** The undeclared-overlap partner of `pieceId` in the composed plan. The plan is
 *  the authority on WHETHER there is a violation (validateScenePlan); this only
 *  recovers the second id, which PlanViolation carries only inside its message. */
const overlapPartner = (plan: ScenePlan, pieceId: string): string | null => {
  const self = plan.elements.find((e) => e.id === pieceId);
  if (!self) return null;
  for (const other of plan.elements) {
    if (other.id === pieceId) continue;
    if (self.kind === "atmosphere" || other.kind === "atmosphere") continue;
    if (!rectsOverlap(self.bounds, other.bounds)) continue;
    if (self.allowedOverlaps.includes(other.id) || other.allowedOverlaps.includes(self.id)) continue;
    return other.id;
  }
  return null;
};

/** The rect a repair must respect for an element: the head's bounds when it owns
 *  one, otherwise the composer's deterministic slot (chrome bar, motif anchor). */
const rectFor = (plan: ScenePlan, comp: SceneComposition | undefined, id: string, aspect: Aspect): Rect | null => {
  if (HEAD_OWNED_ROLES.has(id)) {
    const head = readHeadBounds(comp, id, aspect);
    if (head) return head;
  }
  const slot = plan.elements.find((e) => e.id === id);
  return slot ? { x: slot.bounds.x, y: slot.bounds.y, w: slot.bounds.w, h: slot.bounds.h } : null;
};

// ─── The ladder ─────────────────────────────────────────────────────────────

interface LadderOutcome {
  repaired: boolean;
  /** Violations the ladder declined — with the loud reason when it refused. */
  blocked: { violation: PlanViolation; detail: string; reason: string }[];
}

const applyLadder = (
  violations: PlanViolation[],
  plan: ScenePlan,
  comp: SceneComposition | undefined,
  aspect: Aspect,
  sceneIndex: number,
  events: PlanEvent[],
): LadderOutcome => {
  const { w: W, h: H } = CANVAS[aspect];
  const gutter = Math.round(GUTTER_FRAC * Math.min(W, H));
  const bottomLimit = safeBottomOf(plan);
  const out: LadderOutcome = { repaired: false, blocked: [] };

  // Ladder order: containment before disjointness (a box shifted into the safe
  // area often resolves its collision for free, preserving the authored size),
  // then within a kind, focalRank order — the box we are most willing to move is
  // the one the head ranked least dominant.
  const rungOrder = (v: PlanViolation): number => (v.kind === "containment" ? 0 : v.kind === "disjointness" ? 1 : 2);
  const ordered = [...violations].sort(
    (a, b) => rungOrder(a) - rungOrder(b) || focalRankOf(comp, b.pieceId) - focalRankOf(comp, a.pieceId),
  );

  for (const v of ordered) {
    // RUNG (d): not geometry we may invent — the head owns these.
    if (v.kind === "stranded-hero" || v.kind === "budget") {
      out.blocked.push({
        violation: v,
        detail: v.pieceId,
        reason: v.kind === "budget" ? "budget ownership is the head's to assign" : "growing a hero would invent composition",
      });
      continue;
    }

    // RUNG (a) — containment: clamp into the safe area.
    if (v.kind === "containment") {
      const role = v.pieceId;
      if (!HEAD_OWNED_ROLES.has(role)) {
        out.blocked.push({ violation: v, detail: role, reason: `"${role}" is a deterministic slot, not head-authored` });
        continue;
      }
      const cur = readHeadBounds(comp, role, aspect);
      if (!cur) {
        out.blocked.push({ violation: v, detail: role, reason: `"${role}" carries no head bounds to clamp` });
        continue;
      }
      const fixed = clampIntoSafe(cur, W, H, bottomLimit);
      // Already safe — an earlier rung in this same pass resolved it. Silent.
      if (sameRect(fixed, cur)) continue;
      if (!isLegible(fixed, W, H)) {
        out.blocked.push({
          violation: v,
          detail: role,
          reason: `clamping "${role}" to the safe area leaves ${fixed.w}×${fixed.h}px, below the ${Math.round(MIN_LEGIBLE_W_FRAC * W)}×${Math.round(MIN_LEGIBLE_H_FRAC * H)}px legible floor`,
        });
        continue;
      }
      if (!writeBounds(comp, role, fixed)) {
        out.blocked.push({ violation: v, detail: role, reason: `"${role}" has no composition element to write back to` });
        continue;
      }
      out.repaired = true;
      events.push({ scene: sceneIndex, kind: "containment", detail: role, outcome: "repaired" });
      continue;
    }

    // RUNG (b) — disjointness: shrink the lower-focalRank box out of the collision.
    const partner = overlapPartner(plan, v.pieceId);
    let pair: [string, string] | null = partner ? [v.pieceId, partner] : null;
    if (!pair) {
      // The composer's safety net already swapped table bounds in, so the PLAN
      // shows no collision — recover the pair from the head's own bounds (this
      // is the netFiredViolations case).
      const hero = readHeadBounds(comp, "hero", aspect);
      const copy = readHeadBounds(comp, "copy", aspect);
      if (hero && copy && rectsOverlap(hero, copy)) pair = ["hero", "copy"];
    }
    if (!pair) {
      out.blocked.push({ violation: v, detail: v.pieceId, reason: "could not resolve the colliding pair" });
      continue;
    }
    const detail = pair.join(",");

    // Only a head-authored box can be moved; among two, the least dominant
    // (highest focalRank number), then the smaller (least mass displaced).
    const movable = pair
      .filter((id) => HEAD_OWNED_ROLES.has(id) && readHeadBounds(comp, id, aspect))
      .sort((a, b) => {
        const dr = focalRankOf(comp, b) - focalRankOf(comp, a);
        if (dr !== 0) return dr;
        return area(readHeadBounds(comp, a, aspect)!) - area(readHeadBounds(comp, b, aspect)!);
      });
    if (movable.length === 0) {
      out.blocked.push({ violation: v, detail, reason: "neither element is head-authored — nothing to move" });
      continue;
    }
    const victimId = movable[0];
    const keeperId = pair[0] === victimId ? pair[1] : pair[0];
    const victim = readHeadBounds(comp, victimId, aspect)!;
    const keeper = rectFor(plan, comp, keeperId, aspect);
    if (!keeper) {
      out.blocked.push({ violation: v, detail, reason: `no rect for "${keeperId}"` });
      continue;
    }

    // Already disjoint — an earlier rung in this same pass resolved it. Silent.
    if (!rectsOverlap(victim, keeper)) continue;

    // Gutter first; fall back to a flush trim rather than fail for want of air.
    const withGutter = shrinkOut(victim, keeper, gutter);
    const flush = shrinkOut(victim, keeper, 0);
    const candidate =
      withGutter && isLegible(clampIntoSafe(withGutter, W, H, bottomLimit), W, H)
        ? withGutter
        : flush;
    if (!candidate) {
      out.blocked.push({
        violation: v,
        detail,
        reason: `"${keeperId}" leaves no clear territory for "${victimId}" — the boxes are nested, not merely adjacent`,
      });
      continue;
    }
    const fixed = clampIntoSafe(candidate, W, H, bottomLimit);
    // RUNG (c) — FAIL LOUDLY rather than ship a sliver.
    if (!isLegible(fixed, W, H)) {
      out.blocked.push({
        violation: v,
        detail,
        reason: `shrinking "${victimId}" clear of "${keeperId}" leaves ${fixed.w}×${fixed.h}px, below the ${Math.round(MIN_LEGIBLE_W_FRAC * W)}×${Math.round(MIN_LEGIBLE_H_FRAC * H)}px legible floor`,
      });
      continue;
    }
    if (rectsOverlap(fixed, keeper) || sameRect(fixed, victim) || !writeBounds(comp, victimId, fixed)) {
      out.blocked.push({ violation: v, detail, reason: `shrinking "${victimId}" made no progress` });
      continue;
    }
    out.repaired = true;
    events.push({ scene: sceneIndex, kind: "disjointness", detail, outcome: "repaired" });
  }

  return out;
};

// ─── Per-scene driver ───────────────────────────────────────────────────────

const runScene = (
  scene: Scene,
  index: number,
  opts: PlanValidateOpts & { throughlineAt?: { left: number; top: number } },
  errors: string[],
  events: PlanEvent[],
): void => {
  const comp = scene?.composition as SceneComposition | undefined;
  if (!comp || typeof comp !== "object" || elementsOf(comp).length === 0) return; // un-composed → the table path, already provably valid
  const { aspect } = opts;
  const content = (scene.content ?? {}) as Record<string, unknown>;

  let residual: PlanViolation[] = [];
  let blocked: LadderOutcome["blocked"] = [];

  for (let pass = 0; pass <= MAX_REPAIR_PASSES; pass++) {
    const plan = composeSceneLayout(
      { register: scene.register, content, composition: comp },
      aspect,
      { hasThroughline: opts.hasThroughline, throughlineAt: opts.throughlineAt },
    );
    residual = [
      ...netFiredViolations(comp, scene.register, aspect),
      ...validateScenePlan(plan, aspect, { composition: comp, content }),
    ];
    if (residual.length === 0) return; // clean, possibly after repair
    if (pass === MAX_REPAIR_PASSES) {
      blocked = residual.map((violation) => ({ violation, detail: violation.pieceId, reason: `unresolved after ${MAX_REPAIR_PASSES} repair passes` }));
      break;
    }
    const outcome = applyLadder(residual, plan, comp, aspect, index, events);
    blocked = outcome.blocked;
    if (!outcome.repaired) break; // the ladder is out of moves — escalate
  }

  // Escalate the residue, quoting PlanViolation.message VERBATIM (its purpose).
  const seen = new Set<string>();
  for (const v of residual) {
    if (seen.has(v.message)) continue;
    seen.add(v.message);
    const why = blocked.find((b) => b.violation.message === v.message);
    errors.push(`Scene ${index}: ${v.message}`);
    events.push({
      scene: index,
      kind: v.kind,
      detail: why?.detail ?? v.pieceId,
      outcome: "escalated",
      reason: why?.reason,
    });
    if (why) {
      // FAIL LOUDLY (rung c and every other refusal): the specific element + why.
      console.warn(`[plan-validate] s${index} ${v.kind}(${why.detail}) NOT repairable — ${why.reason}`);
    }
  }

  // Guaranteed-valid fallback: the head retried and still ships a violating
  // frame, so drop its bounds for this scene and let composeSceneLayout use its
  // per-register / per-aspect literal tables (which re-run assertPlanInvariants
  // and are therefore provably disjoint + contained). A plainer frame beats a
  // broken one. Scoped to geometry — a budget owner is not a bounds problem.
  if (opts.terminal && residual.some((v) => GEOMETRY_KINDS.has(v.kind))) {
    let dropped = false;
    for (const role of HEAD_OWNED_ROLES) {
      const spec = specFor(comp, role);
      if (spec?.bounds) {
        delete spec.bounds;
        dropped = true;
      }
    }
    if (dropped) {
      events.push({ scene: index, kind: "containment", detail: "hero,copy", outcome: "fallback", reason: "reverted to the deterministic geometry table" });
      console.warn(`[plan-validate] s${index} head bounds DROPPED — falling back to the deterministic ${scene.register ?? "centered"} geometry table`);
    }
  }
};

// ─── Public entry points ────────────────────────────────────────────────────

const summarize = (events: PlanEvent[]): string => {
  const acted = events.filter((e) => e.outcome !== "fallback");
  if (acted.length === 0) return "plan-validate: 0 violation(s)";
  const repaired = acted.filter((e) => e.outcome === "repaired").length;
  const escalated = acted.filter((e) => e.outcome === "escalated").length;
  const fallbacks = events.filter((e) => e.outcome === "fallback").length;
  const list = acted.map((e) => `s${e.scene}:${e.kind}(${e.detail})`).join(", ");
  return [
    `plan-validate: ${acted.length} violation(s) [${list}]`,
    `${repaired} repaired`,
    `${escalated} escalated`,
    ...(fallbacks > 0 ? [`${fallbacks} table-fallback`] : []),
  ].join(" · ");
};

/**
 * Validate (and deterministically repair) the consumed ScenePlan for every
 * composed scene. Repairs are written back onto `scene.composition`; the residue
 * is returned as head-facing errors.
 *
 * Wire this into the composition head's `validate` callback ALONGSIDE
 * `checkSceneComposition` — plan violations then become head validation errors
 * and reuse the retry loop that already exists.
 */
export const validateAndRepairPlans = (scenes: Scene[], opts: PlanValidateOpts): PlanValidationResult => {
  const errors: string[] = [];
  const events: PlanEvent[] = [];
  // The motif's anchor is a CROSS-SCENE decision, so it is chosen here — where
  // every scene is in hand — and threaded into each per-scene compose. cast-build
  // recomputes it from the same pure function over the same scenes, so the plan
  // validated here is the plan cast will build; deriving it per-scene instead
  // would let author-time and build-time disagree about where the motif sits.
  // Computed ONCE, before the ladder mutates any bounds: recomputing it per
  // repair pass would let the motif chase the boxes it is being cleared of.
  const choice = opts.hasThroughline
    ? selectThroughlineAnchor(
        scenes.map((s) => ({
          register: s.register,
          content: (s.content ?? {}) as Record<string, unknown>,
          composition: s.composition as SceneComposition | undefined,
        })),
        opts.aspect,
      )
    : null;
  scenes.forEach((scene, i) =>
    runScene(scene, i, { ...opts, throughlineAt: choice?.perScene[i] }, errors, events),
  );
  return { errors, events, summary: summarize(events) };
};

/**
 * The head-loop callback form: repairs in place, returns only the residual
 * errors, and logs telemetry when anything fired. `label` prefixes the log so a
 * build log can tell the preview path from the dogfood harness.
 */
export const planValidationErrors = (
  scenes: Scene[],
  opts: PlanValidateOpts & { label?: string },
): string[] => {
  const result = validateAndRepairPlans(scenes, opts);
  if (result.events.length > 0) {
    console.log(`${opts.label ? `[${opts.label}] ` : ""}${result.summary}`);
  }
  return result.errors;
};

/**
 * Terminal pass — run ONCE on the scenes the head finally returned. Repairs what
 * it can and, for any scene still violating a geometry contract, drops the head
 * bounds so the composer's guaranteed-valid literal tables take over. Returns
 * the telemetry (residual errors are informational at this point: nothing
 * downstream retries, and the plan is now valid by construction).
 */
export const enforcePlanFallback = (
  scenes: Scene[],
  opts: Omit<PlanValidateOpts, "terminal"> & { label?: string },
): PlanValidationResult => {
  const result = validateAndRepairPlans(scenes, { ...opts, terminal: true });
  if (result.events.length > 0) {
    console.log(`${opts.label ? `[${opts.label}] ` : ""}${result.summary}`);
  }
  return result;
};
