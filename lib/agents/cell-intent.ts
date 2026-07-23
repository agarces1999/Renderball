/**
 * CELL INTENT — arm C of the P2 layout bake-off (2026-07-18).
 *
 * THE CONFOUND THIS MODULE EXISTS TO ELIMINATE. Arm B (grid-intent.ts) fused two
 * independent ideas into one treatment:
 *
 *   1. DISCRETIZATION — place things on a coarse integer lattice instead of a
 *      continuous pixel plane. The research behind it is LocVLM (integer bins
 *      beat normalized floats on 3/3 localization tasks) and LayoutPrompter
 *      (frozen-LLM SOTA on a 90×160 INTEGER canvas).
 *   2. ASCII-ART ENCODING — express that lattice as a `grid-template-areas`
 *      picture. The research behind THAT is LayoutNUWA (code/HTML syntax beats
 *      bare numeric sequences).
 *
 * Arm B lost decisively, and its dominant defect was the model MISCOUNTING
 * CHARACTERS PER ROW — a failure mode neither paper had, introduced by the
 * picture and by nothing else. So arm B's loss cannot be read as evidence
 * against discretization; the two variables moved together.
 *
 * ARM C MOVES EXACTLY ONE. Same 32×18 lattice, same square 54px cells, same
 * title-safe containment, same `areaToBounds` conversion, same `layers` sidecar,
 * same downstream `SceneComposition` — everything spatial is imported from
 * grid-intent so it CANNOT drift. The single change: the head states each area's
 * rectangle as FOUR INTEGERS in the existing JSON schema
 * (`colStart`/`colSpan`/`rowStart`/`rowSpan`) instead of drawing it. No
 * character counting is possible, because there is no picture.
 *
 * If arm C parses near arm A's rate, arm B's failure was the ASCII art. If arm C
 * also fails, discretization itself is the problem. That is the whole experiment.
 *
 * WHAT IS DELIBERATELY *NOT* MADE EASIER FOR ARM C. Arm B got cell-ownership
 * uniqueness free by construction (a character slot has one owner, so undeclared
 * overlap is unrepresentable). In arm C overlap IS representable, so it is
 * CHECKED and rejected as an invalid declaration — arm C therefore carries a
 * format-failure mode arm B could not have. This is conservative against arm C
 * on purpose: it keeps the two arms semantically equivalent (same guarantees,
 * different encoding) rather than handing arm C a cheaper contract. Containment
 * and inter-element disjointness are consequently the SAME structural gimmes for
 * arm C as for arm B, and the report must label them so.
 *
 * INDEXING IS 0-BASED AND STATED EXPLICITLY IN THE PROMPT (`colStart` 0…cols-1,
 * `colStart + colSpan ≤ cols`). CSS grid lines are 1-based, which is the
 * representation the model has seen most; 0-based-with-spans was chosen anyway
 * because the 1-based/inclusive-end pair is the classic off-by-one, and a
 * silent ±1 would be indistinguishable from bad composition in the scores. The
 * legal range is written into the contract line, the placement bullet and the
 * repair errors, so the convention is never left to inference. Disclosed as a
 * design choice, not tuned: it was fixed before the run and not revised.
 *
 * NEGATIVE SPACE. Arm B DRAWS its air (the `.` cells). Arm C cannot, so it
 * declares it: a `voids: [{colStart,colSpan,rowStart,rowSpan}]` list of the
 * rectangles meant to stay empty. Like arm B's `.` cells this is inert
 * downstream — it exists so the model must commit to WHERE the air is rather
 * than leaving it as residue. `negativeSpace` stays the same PROSE sentence both
 * other arms emit (schema-validator requires ≥N words there); changing its type
 * would have failed every scene on a schema mismatch of my own making and
 * confounded the very thing under test.
 *
 * Pure. No I/O, no env, no SDK — same leaf posture as grid-intent.
 */
import type { SceneComposition, ElementSpec } from "../../src/schema";
import { GRID, areaToBounds, type AreaRect, type Aspect } from "./grid-intent";

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** The integer rectangle the head emits per element — start + span, 0-based. */
export interface CellRect {
  colStart: number;
  colSpan: number;
  rowStart: number;
  rowSpan: number;
}

/** The failure taxonomy the bake-off counts. Closed union, same doctrine as
 *  grid-intent's: the aggregate table can never grow an unlabelled bucket. */
export type CellFailureKind =
  | "missing-rect"
  | "non-integer"
  | "out-of-range"
  | "undeclared-overlap"
  | "no-elements";

/** Convert start+span to the inclusive corner rect grid-intent's converter
 *  takes. Shared conversion is what makes both discrete arms land on identical
 *  pixels for an identical placement. */
export const cellRectToArea = (r: CellRect): AreaRect => ({
  c0: r.colStart,
  r0: r.rowStart,
  c1: r.colStart + r.colSpan - 1,
  r1: r.rowStart + r.rowSpan - 1,
});

/** Inclusive-rectangle overlap. Half-open in spirit: sharing an edge index is
 *  overlap (cell 5 belongs to whoever claims it), touching spans are not. */
export const rectsOverlap = (a: AreaRect, b: AreaRect): boolean =>
  a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;

// ─── The integer parser ─────────────────────────────────────────────────────

export interface CellRectParse {
  rect: CellRect | null;
  errors: string[];
}

/**
 * Read one element's four integers off a raw object and enforce the lattice
 * bounds. This is arm C's whole format contract — the analogue of arm B's
 * row-count / row-length / rectangularity rules — so it returns EVERY defect
 * rather than the first (the head re-emits all scenes per repair round; one
 * defect per retry would burn the budget).
 *
 * Rejected: a missing field, a non-integer (floats included — the point of a
 * lattice is integers), a non-positive span, and any rect that runs off the
 * lattice. Accepted: anything that names a real block of cells.
 */
export const parseCellRect = (
  raw: Record<string, unknown>,
  aspect: Aspect,
  label: string,
): CellRectParse => {
  const { cols, rows } = GRID[aspect];
  const errors: string[] = [];
  const fields = ["colStart", "colSpan", "rowStart", "rowSpan"] as const;

  const present = fields.filter((f) => raw[f] !== undefined && raw[f] !== null);
  if (present.length === 0) {
    return {
      rect: null,
      errors: [
        `${label} declares no cell rectangle — every non-atmosphere element carries integer colStart, colSpan, rowStart, rowSpan on the ${cols}×${rows} lattice.`,
      ],
    };
  }

  const vals: Record<string, number> = {};
  for (const f of fields) {
    const v = raw[f];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(
        `${label} has ${f} = ${JSON.stringify(v)} — every one of colStart, colSpan, rowStart, rowSpan must be a whole number (no decimals, no strings, no omissions).`,
      );
      continue;
    }
    vals[f] = v;
  }
  if (errors.length > 0) return { rect: null, errors };

  const rect: CellRect = {
    colStart: vals.colStart,
    colSpan: vals.colSpan,
    rowStart: vals.rowStart,
    rowSpan: vals.rowSpan,
  };

  if (rect.colSpan < 1 || rect.rowSpan < 1) {
    errors.push(
      `${label} has colSpan ${rect.colSpan} and rowSpan ${rect.rowSpan} — both spans must be at least 1 (a span is a COUNT of cells, never 0 and never negative).`,
    );
  }
  if (rect.colStart < 0 || rect.rowStart < 0) {
    errors.push(
      `${label} starts at column ${rect.colStart}, row ${rect.rowStart} — the lattice is 0-based, so colStart must be 0…${cols - 1} and rowStart must be 0…${rows - 1}.`,
    );
  }
  // NOTE: deliberately NOT gated on a non-negative start. A negative start and
  // an off-lattice end are two independent facts, and the head repairs both in
  // one round only if it hears both. (Gating on `colSpan >= 1` is different: a
  // non-positive span makes the computed end meaningless, so reporting it would
  // be noise on top of the real defect.)
  if (rect.colSpan >= 1 && rect.colStart + rect.colSpan > cols) {
    errors.push(
      `${label} spans columns ${rect.colStart}…${rect.colStart + rect.colSpan - 1}, which runs off the lattice — colStart + colSpan must be ≤ ${cols} (columns are numbered 0…${cols - 1}).`,
    );
  }
  if (rect.rowSpan >= 1 && rect.rowStart + rect.rowSpan > rows) {
    errors.push(
      `${label} spans rows ${rect.rowStart}…${rect.rowStart + rect.rowSpan - 1}, which runs off the lattice — rowStart + rowSpan must be ≤ ${rows} (rows are numbered 0…${rows - 1}).`,
    );
  }

  return errors.length > 0 ? { rect: null, errors } : { rect, errors };
};

/** Classify a parse error for the aggregate failure table. */
export const classifyCellError = (message: string): CellFailureKind =>
  message.includes("declares no cell rectangle")
    ? "missing-rect"
    : message.includes("must be a whole number") || message.includes("must be at least 1")
      ? "non-integer"
      : message.includes("runs off the lattice") || message.includes("the lattice is 0-based")
        ? "out-of-range"
        : message.includes("overlap")
          ? "undeclared-overlap"
          : "no-elements";

// ─── Cell scene → SceneComposition ──────────────────────────────────────────

/** The raw per-scene shape arm C's head emits. Identical to arm B's minus
 *  `grid`, plus the per-element integers and the `voids` declaration. */
export interface CellSceneRaw {
  elements?: unknown;
  layers?: unknown;
  atmosphere?: unknown;
  negativeSpace?: unknown;
  voids?: unknown;
  budget?: unknown;
}

export interface CellSceneResult {
  composition: SceneComposition | null;
  errors: string[];
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Convert one emitted cell scene into the SAME `SceneComposition` arms A and B
 * produce — pixel bounds and all — so `composeSceneLayout`, `validateScenePlan`,
 * `checkSceneComposition` and the void metric cannot tell the three arms apart.
 *
 * `atmosphere`-role elements carry no rect (they are the full-bleed base layer),
 * matching both other arms exactly.
 *
 * UNDECLARED OVERLAP IS AN INVALID DECLARATION (see the module doc): two content
 * elements claiming the same cells is rejected unless the upper one is named in
 * the `layers` sidecar, which is precisely the guarantee arm B got structurally.
 */
export const cellSceneToComposition = (raw: CellSceneRaw, aspect: Aspect): CellSceneResult => {
  const errors: string[] = [];

  // The layers sidecar keys on the element's `area` name, byte-identical to arm
  // B, so an over-layer is declared the same way in both discrete arms.
  const layersRaw = Array.isArray(raw.layers) ? raw.layers : [];
  const over = new Set<string>();
  for (const l of layersRaw) {
    if (l && typeof l === "object") {
      const a = (l as { area?: unknown }).area;
      if (typeof a === "string" && a.length > 0) over.add(a);
    }
  }

  const rawEls = Array.isArray(raw.elements) ? raw.elements : [];
  if (rawEls.length === 0) errors.push(`scene declares no elements[].`);

  const elements: ElementSpec[] = [];
  const placed: { label: string; area: string; rect: AreaRect }[] = [];

  for (const e of rawEls) {
    if (!e || typeof e !== "object") continue;
    const el = e as Record<string, unknown>;
    const role = typeof el.role === "string" ? el.role : "";
    const area = typeof el.area === "string" ? el.area : "";
    const label = `element "${role || area || "?"}"`;

    const spec: ElementSpec = {
      role,
      subject: typeof el.subject === "string" ? el.subject : "",
      interior: asStringArray(el.interior),
      ownsCopy: asStringArray(el.ownsCopy),
      motion: typeof el.motion === "string" ? el.motion : undefined,
      focalRank: typeof el.focalRank === "number" ? el.focalRank : undefined,
    };

    if (role !== "atmosphere") {
      const { rect, errors: rectErrors } = parseCellRect(el, aspect, label);
      if (rect) {
        const areaRect = cellRectToArea(rect);
        spec.bounds = areaToBounds(areaRect, aspect);
        placed.push({ label, area, rect: areaRect });
      } else {
        errors.push(...rectErrors);
      }
    }
    elements.push(spec);
  }

  // Pairwise overlap, checked only when every rect parsed — otherwise the head
  // gets a cascade of overlap noise on top of the real defect.
  if (errors.length === 0) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        if (!rectsOverlap(a.rect, b.rect)) continue;
        // An over-layer stacking on the element beneath it is the DECLARED case.
        if ((a.area && over.has(a.area)) || (b.area && over.has(b.area))) continue;
        errors.push(
          `${a.label} (columns ${a.rect.c0}…${a.rect.c1}, rows ${a.rect.r0}…${a.rect.r1}) and ${b.label} (columns ${b.rect.c0}…${b.rect.c1}, rows ${b.rect.r0}…${b.rect.r1}) claim overlapping cells. Two elements may not own the same cell: either move one so the rectangles are disjoint, or, if the stack is intentional, give the upper element an "area" name and declare it in layers as { "area": "<name>", "zIndex": <n> }.`,
        );
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

// ─── The arm-C prompt blocks ────────────────────────────────────────────────

/**
 * The SPATIAL half of the head's system prompt, in integer-cell dialect.
 *
 * Held DELIBERATELY parallel to `gridSpatialBlocks`, bullet for bullet, so the
 * only difference between arms B and C is HOW a rectangle is stated. Every
 * non-spatial block (interior inventories, copy ownership, accent discipline,
 * register shapes, the budget, the worked example's content) is untouched and
 * shared with arm A via composition-head.
 */
export const cellSpatialBlocks = (aspect: Aspect): string[] => {
  const { cols, rows } = GRID[aspect];
  return [
    `FRAME COMPOSITION — you compose the frame on a GRID, the way CSS grid placement works. The safe frame is divided into a ${cols}×${rows} lattice of SQUARE cells: columns are numbered 0…${cols - 1} left to right, rows 0…${rows - 1} top to bottom. Because the cells are square, an element's colSpan:rowSpan IS its aspect ratio (a 6×6 block is a square; a 16×9 block is widescreen). Compose it like a senior art director — the way a premium launch frame (Apple, Linear, Stripe) is composed, NOT like a form dumped in a column:`,
    `- EVERY ELEMENT IS PLACED BY FOUR WHOLE NUMBERS: colStart (0…${cols - 1}), colSpan (≥1), rowStart (0…${rows - 1}), rowSpan (≥1). The block must fit on the lattice: colStart + colSpan ≤ ${cols}, and rowStart + rowSpan ≤ ${rows}. Whole numbers only — no decimals, no pixels, no percentages.`,
    `- TWO ELEMENTS MAY NEVER OWN THE SAME CELL. Each element's block is its exclusive territory; blocks must not overlap unless the stack is DECLARED (see layering below). An undeclared overlap is rejected as an invalid declaration.`,
    `- ONE DOMINANT FOCAL OBJECT. Exactly one element is the hero the eye lands on first — usually the diegetic hero (a product screen, dashboard, device mock). Give it focalRank 1 and sizeClass "dominant", and make its block LARGE with its centre near the lattice's optical centre (around column ${Math.round(cols / 2)}, row ${Math.round(rows / 2)}) — never jammed into a corner. Everything else is subordinate: focalRank 2, 3, … descending, sizeClass "supporting" or "accent".`,
    `- DELIBERATE NEGATIVE SPACE IS DECLARED, NOT IMPLIED. List the rectangles you are keeping EMPTY in "voids", each as { "colStart", "colSpan", "rowStart", "rowSpan" } — place them where you want the frame to breathe (a quiet band, a margin, the gutter beside the focal object) and name that intent in negativeSpace. Air is a composed choice around the focal object, not a corner-clustered accident with a huge blank middle.`,
    `- MASS FILLS THE FRAME. Distribute the blocks so the whole lattice reads as composed. Do NOT leave one enormous contiguous region of unclaimed cells with all the mass shoved into a corner — a single dead region larger than about a quarter of the lattice is the void defect. Small, intentional pockets of air are correct; one giant hole is not.`,
    `- ONE GRID SYSTEM per scene: pick a single spatial system (a two-column split, a centered stack, a card-over-field) and place every block on it. Do not mix incompatible systems in one frame.`,
    `- DECLARED LAYERING via the "layers" sidecar. A cell has ONE owner, so when an element must genuinely sit ON TOP of another (a copy card over a full-bleed dashboard; the throughline motif pinned onto the hero), give BOTH elements a short "area" name, place the upper element's block INSIDE the lower one's, and list the upper one in layers as { "area": "<name>", "zIndex": <n> }. An area named in layers is an over-layer: it is allowed to overlap the block beneath it. Use this ONLY for intentional stacking — every other overlap is an error.`,
    `- SINGULARITY BUDGET: exactly ONE brand mark and ONE CTA per scene. In budget, name WHICH element owns each: a role ("hero"/"copy"), "chrome" for the corner brand lockup, or "none" when the scene carries neither. Never let two elements both render a brand pill or a call-to-action — duplicate brand marks and competing CTAs are the single loudest "AI slop" tell.`,
    `- THE CORNER LOCKUP IS ALWAYS PROVIDED. The app paints ONE clean brand lockup in the frame's TOP-LEFT corner on every scene automatically — you do NOT author it, and it is the scene's single brand mark by default (set budget.brandMark to "chrome"). Therefore NEVER author a brand logo, wordmark, or brand-name mark in the frame's upper-left, and never name "the [brand] logo upper-left" in any element's interior — it collides with the provided corner lockup and ships as a garbled double wordmark. A brand mark may appear inside a hero ONLY as diegetic product chrome INSIDE a device/app mock (a small logo in the mock's own sidebar or header), placed well clear of the frame's own top-left corner. If you truly need the mark on a role instead of the chrome, that role must place it away from the top-left corner and you must NOT also expect the corner lockup — but "chrome" is the right answer for almost every scene.`,
    `- THE APP PAINTS A CHROME BAR across the BOTTOM of the frame. Keep the last lattice row (row ${rows - 1}) free of anything that must stay readable.`,
    ``,
    `PER-ELEMENT PLACEMENT: every non-atmosphere element carries colStart, colSpan, rowStart and rowSpan (whole numbers on the ${cols}×${rows} lattice), a "sizeClass" ("dominant" | "supporting" | "accent"), and a focalRank. The text (copy) element's colSpan is a MAX width — its height flows. atmosphere is the full-bleed base layer: it carries NO cell rectangle, NO sizeClass and NO focalRank. The lattice maps deterministically to the canvas — you never write pixels.`,
  ];
};

/** The arm-C output contract line + the shape of the worked example. */
export const cellOutputBlocks = (aspect: Aspect): string[] => {
  const { cols, rows } = GRID[aspect];
  return [
    `OUTPUT: ONLY JSON — a single array of scene objects, one per scene, in scene order. No prose, no markdown fences, no keys beyond the contract:`,
    `[{ "elements": [{ "role", "subject", "area", "colStart", "colSpan", "rowStart", "rowSpan", "sizeClass", "focalRank", "interior": [...], "ownsCopy": [...], "motion" }], "layers": [{ "area", "zIndex" }], "voids": [{ "colStart", "colSpan", "rowStart", "rowSpan" }], "atmosphere", "negativeSpace", "budget": { "brandMark", "cta" } }]`,
    `Every colStart is 0…${cols - 1} and every rowStart is 0…${rows - 1}; colStart + colSpan ≤ ${cols} and rowStart + rowSpan ≤ ${rows}.`,
  ];
};

/**
 * The arm-C worked example — the SAME fictional coffee-subscription scene as
 * arms A and B, with identical subjects, interiors, ownsCopy, motion,
 * atmosphere, negativeSpace and budget. ONLY the placement is re-expressed.
 * Holding the example's content constant is what keeps this a one-variable
 * experiment.
 *
 * The rectangles are the SAME BLOCKS arm B's exemplar draws, computed from the
 * same expressions — so the two discrete arms' examples describe a
 * pixel-identical frame and differ only in notation. Built rather than pasted so
 * it is guaranteed in-range at every aspect (the "the prompt's own exemplar must
 * pass its advertised validator" rule).
 */
export const buildCellWorkedExample = (aspect: Aspect): string => {
  const { cols, rows } = GRID[aspect];
  // Editorial copy stack left, phone hero right of centre, atmosphere behind —
  // the identical geometry buildGridWorkedExample paints.
  const copy = { c0: 1, r0: 4, c1: Math.round(cols * 0.36), r1: rows - 6 };
  const hero = { c0: Math.round(cols * 0.5), r0: 2, c1: cols - 3, r1: rows - 3 };
  const span = (r: { c0: number; r0: number; c1: number; r1: number }): CellRect => ({
    colStart: r.c0,
    colSpan: r.c1 - r.c0 + 1,
    rowStart: r.r0,
    rowSpan: r.r1 - r.r0 + 1,
  });

  return JSON.stringify(
    [
      {
        elements: [
          {
            role: "hero",
            subject: "the Brewline mobile checkout screen in a rounded phone frame",
            area: "hero",
            ...span(hero),
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
            area: "copy",
            ...span(copy),
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
        voids: [
          { colStart: 0, colSpan: cols, rowStart: rows - 2, rowSpan: 2 },
          { colStart: copy.c1 + 1, colSpan: hero.c0 - copy.c1 - 1, rowStart: 4, rowSpan: rows - 9 },
        ],
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
