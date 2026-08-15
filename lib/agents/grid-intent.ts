/**
 * GRID INTENT — the arm-B spatial representation for the P2 layout bake-off
 * (2026-07-18).
 *
 * THE QUESTION THIS MODULE EXISTS TO ANSWER: does having the composition head
 * declare its frame as a CSS `grid-template-areas` ASCII block beat having it
 * emit raw pixel `{x,y,w,h}` bounds? The research premise (LayoutNUWA: bare
 * numeric sequences fail 21.7–78% of the time and score ~0.000 mIoU, vs
 * 0.260–0.418 for code/HTML representations; LayoutGPT: 91.73% valid from
 * CSS-formatted demonstrations) says a CODE representation the model has seen
 * a million times in training beats four free integers per box. This module is
 * the treatment arm; `scripts/layout-bakeoff.ts` measures it.
 *
 * THE REPRESENTATION
 *
 *   grid: [ "..HHHHHHHH....CCCCCC....", … ]   ← one string per row
 *
 * Every cell carries exactly one character: a letter naming the element that
 * owns it, or `.` for DECLARED NEGATIVE SPACE. Two structural properties come
 * free, and they are the whole point:
 *
 *   1. DISJOINTNESS IS UNREPRESENTABLE TO VIOLATE. A cell has one owner. Two
 *      elements cannot claim the same pixel because they cannot claim the same
 *      character slot.
 *   2. RECTANGULARITY IS CHECKABLE AT PARSE TIME. A named area whose cells do
 *      not form a solid rectangle is INVALID — the same rule CSS itself
 *      enforces on `grid-template-areas`. That is a hard, countable format
 *      failure, which is exactly the metric LayoutNUWA measured.
 *
 * Both properties are structural, NOT empirical: we do not need a bake-off to
 * learn that grid cells cannot overlap. What the bake-off actually measures is
 * whether the model can USE this representation (failure rate), and whether the
 * frames it composes in it are BETTER (void size, stranded-hero, budget).
 *
 * THE LATTICE (from the plan; 32×18 on 16:9)
 *
 * Cells are SQUARE — 54×54px on every aspect — so a colSpan:rowSpan ratio reads
 * as a literal aspect ratio to the model. Squareness is what makes the grid
 * legible as geometry rather than as an arbitrary index space, and it is why
 * the plan rejected 12×8 (160×135 cells skew every aspect intuition).
 *
 * The lattice covers the SMPTE title-safe area (1728×972 at 96,54 on 16:9),
 * not the full canvas. Consequence worth stating plainly: CONTAINMENT becomes
 * free for this arm, since the safe area sits entirely inside the bottom
 * reserve (safe bottom 1026 < BOTTOM_SAFE 1042). The bake-off report must
 * therefore treat arm B's containment and inter-element disjointness counts as
 * STRUCTURAL GIMMES and not as evidence of better composition. What is NOT free
 * — and is therefore the honest contested ground — is collision with the
 * composer's deterministic slots (the chrome bar at y≥1008 reaches up into the
 * bottom grid row; the throughline anchor sits mid-frame), the stranded-hero
 * numeric contract, the singularity budget, and the void metric.
 *
 * DECLARED LAYERING. A cell has one owner, so a genuine stack (a copy card over
 * a full-bleed dashboard, the throughline motif pinned onto the hero) needs an
 * escape hatch. The `layers` sidecar is it: an area named there is an OVER-layer
 * with a z-index, and its cells are treated as wildcard fill when checking the
 * rectangularity of the areas beneath it. So the full-bleed hero may letter the
 * entire grid while the copy card punches a rectangle out of its middle, and
 * both stay valid. This is the plan's "declared layering via hierarchical
 * nesting", expressed in the representation instead of as a whitelist.
 *
 * Pure. No I/O, no env, no SDK — the same leaf posture as layout-composer and
 * composition-head, which is what lets the bake-off and the unit tests drive it
 * without a key.
 */
import type { SceneComposition, ElementSpec, ElementBounds } from "../../src/schema";

export type Aspect = "16:9" | "9:16" | "1:1";

// ─── The lattice ────────────────────────────────────────────────────────────

/** Canvas, mirrored from layout-composer's CANVAS (kept a dependency-free leaf
 *  by the same doctrine that module applies to CANVAS_DIMS). */
const CANVAS: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/** Square cell edge, in px, on every aspect. 1728/32 = 972/18 = 54. */
export const CELL = 54;

/**
 * Air carved out of each area's own cells — 6px per side. Areas are adjacent on
 * the lattice, so without this two touching areas would render flush. The
 * disjointness predicate is half-open (touching ≠ overlapping), so the gutter is
 * about optics, not validity.
 */
export const GUTTER = 12;

/**
 * SMPTE title-safe: a 5% inset per side. The plan names 1728×972 at (96,54) for
 * 16:9; the other aspects are the same 5% rule, and all three land on the same
 * 54px square cell.
 */
export const SAFE: Record<Aspect, { x: number; y: number; w: number; h: number }> = {
  "16:9": { x: 96, y: 54, w: 1728, h: 972 },
  "9:16": { x: 54, y: 96, w: 972, h: 1728 },
  "1:1": { x: 54, y: 54, w: 972, h: 972 },
};

/** Grid dimensions per aspect — SAFE ÷ CELL, so cells stay square everywhere.
 *  16:9 → 32×18 (the plan's number), 9:16 → 18×32, 1:1 → 18×18. */
export const GRID: Record<Aspect, { cols: number; rows: number }> = {
  "16:9": { cols: 32, rows: 18 },
  "9:16": { cols: 18, rows: 32 },
  "1:1": { cols: 18, rows: 18 },
};

/** The character reserved for declared negative space. */
export const NULL_CELL = ".";

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** A named area's cell extent, inclusive on both ends. */
export interface AreaRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export interface GridParseResult {
  /** Area letter → its cell rectangle. Empty when `errors` is non-empty. */
  areas: Map<string, AreaRect>;
  /** Every reason this grid is an INVALID declaration, one per line. */
  errors: string[];
}

/** The failure taxonomy the bake-off counts. Kept as a closed union so the
 *  aggregate table can never silently grow an unlabelled bucket. */
export type GridFailureKind =
  | "row-count"
  | "row-length"
  | "non-rectangular"
  | "empty-grid"
  | "bad-char";

// ─── Area → pixels ──────────────────────────────────────────────────────────

/**
 * Convert one area's cell rectangle to canvas pixels — the deterministic half of
 * arm B, and the reason both arms produce the same downstream shape and are
 * scored by the same code.
 *
 * FULL-GRID SNAP: an area spanning every column AND every row is a canvas
 * TREATMENT, so it snaps to the FULL canvas rather than the safe area. Without
 * this, a full-bleed hero would measure 1728×972 = 1.68M px² against
 * layout-composer's `isFullBleedRect` threshold of 0.85·W·H = 1.76M, fail to
 * register as a treatment, and manufacture a disjointness violation against its
 * own declared over-layers. The snap is semantics, not a fudge: a full-bleed
 * treatment bleeds to the edge by definition.
 */
export const areaToBounds = (rect: AreaRect, aspect: Aspect): ElementBounds => {
  const { cols, rows } = GRID[aspect];
  const safe = SAFE[aspect];
  const spansAll = rect.c0 === 0 && rect.r0 === 0 && rect.c1 === cols - 1 && rect.r1 === rows - 1;
  if (spansAll) {
    const { w, h } = CANVAS[aspect];
    return { x: 0, y: 0, w, h };
  }
  const half = GUTTER / 2;
  return {
    x: Math.round(safe.x + rect.c0 * CELL + half),
    y: Math.round(safe.y + rect.r0 * CELL + half),
    w: Math.round((rect.c1 - rect.c0 + 1) * CELL - GUTTER),
    h: Math.round((rect.r1 - rect.r0 + 1) * CELL - GUTTER),
  };
};

// ─── The ASCII parser ───────────────────────────────────────────────────────

/**
 * Parse a `grid-template-areas` ASCII block into named area rectangles,
 * enforcing the two rules CSS itself enforces:
 *
 *   - the block is exactly `rows` strings of exactly `cols` characters;
 *   - every named area's cells form a SOLID RECTANGLE.
 *
 * `overLayers` are area letters declared in the scene's `layers` sidecar. Their
 * cells act as WILDCARD FILL when checking the rectangularity of other areas —
 * that is how a copy card can punch a hole in a full-bleed hero without making
 * the hero non-rectangular. An over-layer's own rectangle is still checked
 * strictly against its own cells.
 *
 * Returns every violation rather than the first, because the head's repair
 * prompt quotes them all and a one-at-a-time parser would burn a retry per
 * defect.
 */
export const parseGridAscii = (
  grid: unknown,
  aspect: Aspect,
  overLayers: Iterable<string> = [],
): GridParseResult => {
  const { cols, rows } = GRID[aspect];
  const errors: string[] = [];
  const areas = new Map<string, AreaRect>();

  if (!Array.isArray(grid) || grid.length === 0 || !grid.every((r) => typeof r === "string")) {
    errors.push(`grid must be an array of ${rows} strings, each exactly ${cols} characters.`);
    return { areas, errors };
  }
  const lines = grid as string[];

  if (lines.length !== rows) {
    errors.push(`grid has ${lines.length} rows — it must have exactly ${rows}.`);
  }
  lines.forEach((line, i) => {
    if (line.length !== cols) {
      errors.push(`grid row ${i} has ${line.length} characters — every row must have exactly ${cols}.`);
    }
  });
  if (errors.length > 0) return { areas, errors };

  // Collect each character's cells. A cell's owner is a single character; a
  // legal name is a letter or digit (the null cell is `.`).
  const cells = new Map<string, { c: number; r: number }[]>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = lines[r][c];
      if (ch === NULL_CELL) continue;
      if (!/^[A-Za-z0-9]$/.test(ch)) {
        errors.push(`grid cell (row ${r}, col ${c}) is "${ch}" — cells carry a single letter/digit area name or "${NULL_CELL}" for negative space.`);
        continue;
      }
      const list = cells.get(ch) ?? [];
      list.push({ c, r });
      cells.set(ch, list);
    }
  }
  if (errors.length > 0) return { areas: new Map(), errors };
  if (cells.size === 0) {
    errors.push(`grid declares no areas at all — every cell is "${NULL_CELL}".`);
    return { areas, errors };
  }

  const over = new Set([...overLayers]);

  // Rectangularity, per area. The bbox is the candidate; the area is valid iff
  // every cell inside the bbox belongs to it — or, for a NON-over-layer, to an
  // over-layer stacked on top of it.
  for (const [ch, list] of cells) {
    const c0 = Math.min(...list.map((p) => p.c));
    const c1 = Math.max(...list.map((p) => p.c));
    const r0 = Math.min(...list.map((p) => p.r));
    const r1 = Math.max(...list.map((p) => p.r));
    const bboxCells = (c1 - c0 + 1) * (r1 - r0 + 1);

    let filled = list.length;
    if (!over.has(ch)) {
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (over.has(lines[r][c])) filled++;
        }
      }
    }
    if (filled !== bboxCells) {
      errors.push(
        `area "${ch}" is not a solid rectangle — its cells span rows ${r0}-${r1} and columns ${c0}-${c1} (${bboxCells} cells) but only ${filled} are filled. Every named area must be a filled rectangle, exactly as CSS grid-template-areas requires.`,
      );
      continue;
    }
    areas.set(ch, { c0, r0, c1, r1 });
  }

  if (errors.length > 0) return { areas: new Map(), errors };
  return { areas, errors };
};

// ─── Grid scene → SceneComposition ──────────────────────────────────────────

/** The raw per-scene shape arm B's head emits. */
export interface GridSceneRaw {
  grid?: unknown;
  elements?: unknown;
  layers?: unknown;
  atmosphere?: unknown;
  negativeSpace?: unknown;
  budget?: unknown;
}

export interface GridSceneResult {
  composition: SceneComposition | null;
  errors: string[];
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Convert one emitted grid scene into the SAME `SceneComposition` shape arm A
 * emits directly — pixel bounds and all. Everything downstream
 * (`composeSceneLayout`, `validateScenePlan`, `checkSceneComposition`, the void
 * metric) then operates on an identical object for both arms, which is the only
 * way the two are scored by the same code.
 *
 * `atmosphere`-role elements carry no area (they are the full-bleed base layer),
 * matching the pixel arm's contract exactly.
 */
export const gridSceneToComposition = (raw: GridSceneRaw, aspect: Aspect): GridSceneResult => {
  const errors: string[] = [];

  const layersRaw = Array.isArray(raw.layers) ? raw.layers : [];
  const zByArea = new Map<string, number>();
  for (const l of layersRaw) {
    if (l && typeof l === "object") {
      const a = (l as { area?: unknown }).area;
      const z = (l as { zIndex?: unknown }).zIndex;
      if (typeof a === "string" && a.length === 1) zByArea.set(a, typeof z === "number" ? z : 1);
    }
  }

  const { areas, errors: gridErrors } = parseGridAscii(raw.grid, aspect, zByArea.keys());
  errors.push(...gridErrors);

  const rawEls = Array.isArray(raw.elements) ? raw.elements : [];
  if (rawEls.length === 0) errors.push(`scene declares no elements[].`);

  const elements: ElementSpec[] = [];
  const claimed = new Set<string>();

  for (const e of rawEls) {
    if (!e || typeof e !== "object") continue;
    const el = e as Record<string, unknown>;
    const role = typeof el.role === "string" ? el.role : "";
    const spec: ElementSpec = {
      role,
      subject: typeof el.subject === "string" ? el.subject : "",
      interior: asStringArray(el.interior),
      ownsCopy: asStringArray(el.ownsCopy),
      motion: typeof el.motion === "string" ? el.motion : undefined,
      focalRank: typeof el.focalRank === "number" ? el.focalRank : undefined,
    };

    // atmosphere is the full-bleed base layer — no area, no bounds, same as the
    // pixel arm.
    if (role !== "atmosphere") {
      const area = typeof el.area === "string" ? el.area : "";
      if (!area) {
        errors.push(`element "${role}" declares no area — every non-atmosphere element names the single grid character it owns.`);
      } else if (!areas.has(area)) {
        if (gridErrors.length === 0) {
          errors.push(`element "${role}" claims area "${area}", which appears nowhere in the grid.`);
        }
      } else {
        claimed.add(area);
        spec.bounds = areaToBounds(areas.get(area)!, aspect);
      }
    }
    elements.push(spec);
  }

  // An area drawn but owned by nobody is an undeclared region: it reserves
  // territory no element will ever paint, which is a silent void.
  if (gridErrors.length === 0) {
    for (const a of areas.keys()) {
      if (!claimed.has(a)) {
        errors.push(`area "${a}" is drawn in the grid but no element claims it — every named area belongs to exactly one element.`);
      }
    }
  }

  if (errors.length > 0) return { composition: null, errors };

  return {
    composition: {
      elements,
      atmosphere: typeof raw.atmosphere === "string" ? raw.atmosphere : "",
      negativeSpace: typeof raw.negativeSpace === "string" ? raw.negativeSpace : undefined,
      budget:
        raw.budget && typeof raw.budget === "object"
          ? {
              brandMark: String((raw.budget as { brandMark?: unknown }).brandMark ?? ""),
              cta: String((raw.budget as { cta?: unknown }).cta ?? ""),
            }
          : undefined,
    },
    errors,
  };
};

// ─── The void metric ────────────────────────────────────────────────────────

/**
 * THE LARGEST MAXIMAL CONTIGUOUS UNCLAIMED RECTANGLE, as a fraction of the safe
 * area — the plan's void-SIZE gate metric.
 *
 * Why this and NOT total coverage: mandating full coverage is exactly the
 * over-fill regression already shipped and reverted. A frame is allowed to be
 * mostly empty; what it is not allowed to have is one enormous dead hole with
 * all the mass shoved around it. Size of the biggest hole captures that;
 * coverage does not.
 *
 * Standard maximal-rectangle-in-a-binary-matrix: walk rows keeping a histogram
 * of consecutive free cells per column, and for each row solve largest-rectangle
 * -in-histogram with a monotonic stack. O(cols·rows).
 */
export const largestVoidCells = (occupied: boolean[][], cols: number, rows: number): number => {
  const heights = new Array<number>(cols).fill(0);
  let best = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[c] = occupied[r][c] ? 0 : heights[c] + 1;
    }
    // Largest rectangle in this row's histogram, monotonic-stack sweep. The
    // sentinel pass (i === cols) drains whatever is left on the stack.
    const stack: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const h = i === cols ? 0 : heights[i];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const left = stack.length === 0 ? -1 : stack[stack.length - 1];
        const areaCells = heights[top] * (i - left - 1);
        if (areaCells > best) best = areaCells;
      }
      stack.push(i);
    }
  }
  return best;
};

/**
 * Rasterize a set of painted rectangles onto the safe-area lattice and return
 * the largest void as a fraction of the safe area.
 *
 * A cell counts as OCCUPIED when its CENTRE falls inside any painted rect —
 * deterministic, cheap, and identical for both arms (both are scored from the
 * composed `ScenePlan`, not from their own native representation, so neither
 * gets a home-field rasterization).
 *
 * Callers pass the plan's content slots and EXCLUDE atmosphere: the full-bleed
 * base layer covers every cell and would drive every void to zero, measuring
 * nothing. The chrome bar IS included — it is real painted mass.
 */
export const voidFraction = (
  rects: { x: number; y: number; w: number; h: number }[],
  aspect: Aspect,
): { fraction: number; cells: number; totalCells: number } => {
  const { cols, rows } = GRID[aspect];
  const safe = SAFE[aspect];
  const occupied: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));

  for (let r = 0; r < rows; r++) {
    const cy = safe.y + r * CELL + CELL / 2;
    for (let c = 0; c < cols; c++) {
      const cx = safe.x + c * CELL + CELL / 2;
      for (const rect of rects) {
        if (cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h) {
          occupied[r][c] = true;
          break;
        }
      }
    }
  }

  const cells = largestVoidCells(occupied, cols, rows);
  return { fraction: cells / (cols * rows), cells, totalCells: cols * rows };
};

// ─── The arm-B prompt blocks ────────────────────────────────────────────────

/**
 * The SPATIAL half of the head's system prompt, in grid dialect. Everything
 * else in the head prompt (interior inventories, copy ownership, accent
 * discipline, register shapes, the singularity budget, the worked example's
 * non-spatial content) is IDENTICAL to the pixel arm — the bake-off changes ONE
 * variable, the representation of place.
 *
 * `composition-head.ts` selects between this and the pixel blocks on the
 * `intent` option, so the two arms are one code path with a switch, not a fork.
 */
export const gridSpatialBlocks = (aspect: Aspect): string[] => {
  const { cols, rows } = GRID[aspect];
  const safe = SAFE[aspect];
  const { w: W, h: H } = CANVAS[aspect];
  return [
    `FRAME COMPOSITION — you compose the frame as a CSS GRID, exactly the way \`grid-template-areas\` works. The safe frame is ${safe.w}×${safe.h}px and is divided into a ${cols}×${rows} lattice of SQUARE ${CELL}×${CELL}px cells, so an area's colSpan:rowSpan IS its aspect ratio (a 6×6 area is a square; a 16×9 area is widescreen). Compose it like a senior art director — the way a premium launch frame (Apple, Linear, Stripe) is composed, NOT like a form dumped in a column:`,
    `- EMIT A "grid" FIELD: exactly ${rows} strings of exactly ${cols} characters each. Every character is either a single LETTER naming the element that owns that cell, or "${NULL_CELL}" for DELIBERATE NEGATIVE SPACE.`,
    `- EVERY NAMED AREA MUST BE A SOLID RECTANGLE. All cells carrying a given letter must form a filled rectangle — no L-shapes, no gaps, no other letter inside its span. This is the same rule CSS enforces on grid-template-areas, and a non-rectangular area is rejected as an invalid declaration.`,
    `- ONE DOMINANT FOCAL OBJECT. Exactly one element is the hero the eye lands on first — usually the diegetic hero (a product screen, dashboard, device mock). Give it focalRank 1 and sizeClass "dominant", and draw it LARGE with its area's centre near the lattice's optical centre (around column ${Math.round(cols / 2)}, row ${Math.round(rows / 2)}) — never jammed into a corner. Everything else is subordinate: focalRank 2, 3, … descending, sizeClass "supporting" or "accent".`,
    `- DELIBERATE NEGATIVE SPACE IS DRAWN, NOT IMPLIED. The "${NULL_CELL}" cells ARE your negative space — place them where you want the frame to breathe (a quiet band, a margin, the gutter beside the focal object) and name that intent in negativeSpace. Air is a composed choice around the focal object, not a corner-clustered accident with a huge blank middle.`,
    `- MASS FILLS THE FRAME. Distribute the areas so the whole lattice reads as composed. Do NOT leave one enormous contiguous block of "${NULL_CELL}" cells with all the mass shoved into a corner — a single dead region larger than about a quarter of the lattice is the void defect. Small, intentional pockets of air are correct; one giant hole is not.`,
    `- ONE GRID SYSTEM per scene: pick a single spatial system (a two-column split, a centered stack, a card-over-field) and draw every area on it. Do not mix incompatible systems in one frame.`,
    `- DECLARED LAYERING via the "layers" sidecar. A cell has ONE owner, so when an element must genuinely sit ON TOP of another (a copy card over a full-bleed dashboard; the throughline motif pinned onto the hero), draw the upper element's rectangle INSIDE the lower one's span and list it in layers as { "area": "<letter>", "zIndex": <n> }. An area named in layers is an over-layer: its cells do not break the rectangle of the area beneath it. Use this ONLY for intentional stacking — undeclared overlap is impossible here by construction, and that is the point.`,
    `- SINGULARITY BUDGET: exactly ONE brand mark and ONE CTA per scene. In budget, name WHICH element owns each: a role ("hero"/"copy"), "chrome" for the corner brand lockup, or "none" when the scene carries neither. Never let two elements both render a brand pill or a call-to-action — duplicate brand marks and competing CTAs are the single loudest "AI slop" tell.`,
    `- THE CORNER LOCKUP IS ALWAYS PROVIDED. The app paints ONE clean brand lockup in the frame's TOP-LEFT corner on every scene automatically — you do NOT author it, and it is the scene's single brand mark by default (set budget.brandMark to "chrome"). Therefore NEVER author a brand logo, wordmark, or brand-name mark in the frame's upper-left, and never name "the [brand] logo upper-left" in any element's interior — it collides with the provided corner lockup and ships as a garbled double wordmark. A brand mark may appear inside a hero ONLY as diegetic product chrome INSIDE a device/app mock (a small logo in the mock's own sidebar or header), placed well clear of the frame's own top-left corner. If you truly need the mark on a role instead of the chrome, that role must place it away from the top-left corner and you must NOT also expect the corner lockup — but "chrome" is the right answer for almost every scene.`,
    `- THE APP PAINTS A CHROME BAR across the BOTTOM of the frame. Keep the last lattice row ("${NULL_CELL}" or an area you are content to see crowded) free of anything that must stay readable.`,
    ``,
    `PER-ELEMENT PLACEMENT: every non-atmosphere element carries an "area" (the single character it owns in the grid), a "sizeClass" ("dominant" | "supporting" | "accent"), and a focalRank. The text (copy) element's area width is a MAX width — its height flows. atmosphere is the full-bleed base layer: it carries NO area, NO sizeClass and NO focalRank. The lattice maps deterministically to the ${W}×${H} canvas — you never write pixels.`,
  ];
};

/** The arm-B output contract line + the shape of the worked example. */
export const gridOutputBlocks = (aspect: Aspect): string[] => {
  const { cols, rows } = GRID[aspect];
  return [
    `OUTPUT: ONLY JSON — a single array of scene objects, one per scene, in scene order. No prose, no markdown fences, no keys beyond the contract:`,
    `[{ "grid": [${rows} strings of ${cols} chars], "elements": [{ "role", "subject", "area", "sizeClass", "focalRank", "interior": [...], "ownsCopy": [...], "motion" }], "layers": [{ "area", "zIndex" }], "atmosphere", "negativeSpace", "budget": { "brandMark", "cta" } }]`,
  ];
};

/**
 * The arm-B worked example — the SAME fictional coffee-subscription scene as the
 * pixel arm's `WORKED_EXAMPLE`, with identical subjects, interiors, ownsCopy,
 * motion, atmosphere, negativeSpace and budget. ONLY the placement is
 * re-expressed. Holding the example's content constant is what keeps this a
 * one-variable experiment; a richer example on either side would be tuning.
 *
 * Built rather than pasted so the ASCII is guaranteed well-formed at every
 * aspect (a malformed exemplar would teach the failure it is measuring — the
 * same "the prompt's own exemplar must pass its advertised validator" rule the
 * pixel arm's retry-audit class 9 established).
 */
export const buildGridWorkedExample = (aspect: Aspect): string => {
  const { cols, rows } = GRID[aspect];
  // Editorial copy stack left, phone hero right of centre, atmosphere behind.
  const copy: AreaRect = { c0: 1, r0: 4, c1: Math.round(cols * 0.36), r1: rows - 6 };
  const hero: AreaRect = { c0: Math.round(cols * 0.5), r0: 2, c1: cols - 3, r1: rows - 3 };
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      if (c >= hero.c0 && c <= hero.c1 && r >= hero.r0 && r <= hero.r1) line += "H";
      else if (c >= copy.c0 && c <= copy.c1 && r >= copy.r0 && r <= copy.r1) line += "C";
      else line += NULL_CELL;
    }
    lines.push(line);
  }
  return JSON.stringify(
    [
      {
        grid: lines,
        elements: [
          {
            role: "hero",
            subject: "the Brewline mobile checkout screen in a rounded phone frame",
            area: "H",
            sizeClass: "dominant",
            focalRank: 1,
            interior: [
              "cart panel on a crisp off-white surface, charcoal ink — bright against the roast-brown canvas",
              'order row "Colombia Huila 12oz — $18.50" inside the cart panel',
              'delivery chip "Ships Thursday, Feb 12"',
              'subscription toggle ON, labeled "Every 2 weeks"',
              'price line "Subtotal $18.50 · Shipping FREE"',
              'pay button "Pay $18.50" in the accent',
              'loyalty banner "340 beans — 160 to a free bag"',
            ],
            ownsCopy: [],
            motion: 'the "Pay $18.50" button fills with the accent as the delivery chip settles into place',
          },
          {
            role: "copy",
            subject: "the editorial stack left of the phone: eyebrow, headline, lede",
            area: "C",
            sizeClass: "supporting",
            focalRank: 2,
            interior: ["eyebrow line in mono caps", "headline in display type", "lede at reading size beneath"],
            ownsCopy: ["eyebrow", "headline", "lede"],
            motion: "the headline rises as one block, then holds",
          },
          {
            role: "atmosphere",
            subject: "a warm roast-brown field behind everything",
            interior: ["radial glow upper-left", "drifting steam wisps", "fine film grain"],
            ownsCopy: [],
            motion: "the steam wisps drift upward on an 11s loop",
          },
        ],
        layers: [],
        atmosphere: "warm roast-brown radial wash, steam wisps drifting upward through fine grain",
        negativeSpace:
          "the lower third and the wide gutter between the editorial column and the phone stay open, so the checkout reads as the one focal object with air around it",
        budget: { brandMark: "chrome", cta: "hero" },
      },
    ],
    null,
    1,
  );
};
