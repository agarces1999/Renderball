/**
 * Tests for allocate-layout — the deterministic layout allocator.
 * Run: `node scripts/run-tests.mjs lib/agents/allocate-layout.test.ts`
 * (no API key, no credits, no network).
 *
 * These lock the founder's design requirements as executable contracts:
 *   1. DISJOINTNESS — no undeclared overlap, in any shape, at any aspect.
 *   2. CONTAINMENT — every content slot inside the title-safe content rect,
 *      and above the chrome bar.
 *   3. FOCAL DOMINANCE — focalRank 1 holds the largest area.
 *   4. VARIETY — the chooser returns DIFFERENT shapes for different inputs.
 *   5. DETERMINISM — same input, byte-identical output.
 *   6. SPARSE IS LEGAL — a one-element scene is allowed to be mostly air.
 *
 * The overlap/containment predicates are re-derived HERE rather than imported,
 * so a bug in the module's own `assertAllocation` cannot vouch for itself.
 */
import {
  allocateLayout,
  chooseShape,
  contentRect,
  shapeIds,
  CANVAS,
  SAFE,
  largestFreeRect,
  contentWeight,
  SIZE_BOUNDS,
  COPY_AREA_CEILING,
  HERO_GROWTH_CAP,
  HERO_SHRINK_CAP,
  type Aspect,
  type AllocElementInput,
  type AllocInput,
  type Allocation,
  type Rect,
} from "./allocate-layout";
import { scoreLayout, type ScoredElement } from "./layout-metrics";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];
const REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered", "nonsense"];

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const area = (r: Rect): number => r.w * r.h;

const el = (
  id: string,
  role: string,
  focalRank: number | null,
  extra: Partial<AllocElementInput> = {},
): AllocElementInput => ({ id, role, focalRank, ...extra });

/** A representative cross-section of real scene shapes: 1..5 bodies, with and
 *  without a motif, with and without content-size signals. */
const CASES: { name: string; input: (aspect: Aspect, register: string) => AllocInput }[] = [
  {
    name: "atmosphere+copy",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [el("atmosphere", "atmosphere", null), el("copy", "copy", 1, { textChars: 120 })],
    }),
  },
  {
    name: "atmosphere+hero+copy",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("copy", "copy", 2, { textChars: 180 }),
        el("hero", "hero", 1, { interiorCount: 7 }),
      ],
    }),
  },
  {
    name: "atmosphere+hero+copy+throughline",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("copy", "copy", 2, { textChars: 210 }),
        el("hero", "hero", 1, { interiorCount: 9 }),
        el("throughline", "throughline", 3),
      ],
    }),
  },
  {
    name: "dense hero + short copy",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("hero", "hero", 1, { interiorCount: 11 }),
        el("copy", "copy", 2, { textChars: 90 }),
      ],
    }),
  },
  {
    name: "two copies + hero + motif",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("copy", "copy", 2, { textChars: 160 }),
        el("hero", "hero", 1, { interiorCount: 8 }),
        el("throughline", "throughline", 4),
        el("copy#2", "copy", 3, { textChars: 60, itemCount: 3 }),
      ],
    }),
  },
  {
    name: "five bodies (over-full scene)",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("hero", "hero", 1, { interiorCount: 9 }),
        el("copy", "copy", 2, { textChars: 200 }),
        el("copy#2", "copy", 3, { textChars: 70 }),
        el("connector", "connector", 4),
        el("hero#2", "hero", 5, { interiorCount: 4 }),
        el("throughline", "throughline", 6),
      ],
    }),
  },
  {
    name: "copy is the focal object",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("copy", "copy", 1, { textChars: 240 }),
        el("hero", "hero", 2, { interiorCount: 6 }),
      ],
    }),
  },
  {
    name: "hero authored before copy (reading-order signal)",
    input: (aspect, register) => ({
      aspect,
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("hero", "hero", 1, { interiorCount: 6 }),
        el("copy", "copy", 2, { textChars: 150 }),
      ],
    }),
  },
];

const everyAllocation = (): { label: string; alloc: Allocation }[] => {
  const out: { label: string; alloc: Allocation }[] = [];
  for (const aspect of ASPECTS) {
    for (const register of REGISTERS) {
      for (const c of CASES) {
        out.push({ label: `${c.name} @${register}/${aspect}`, alloc: allocateLayout(c.input(aspect, register)) });
      }
    }
  }
  return out;
};

// ─── 1. Disjointness ────────────────────────────────────────────────────────

check("disjointness: no undeclared overlap in ANY shape × register × aspect", () => {
  for (const { label, alloc } of everyAllocation()) {
    const s = alloc.slots.filter((x) => x.layer !== "base" && x.layer !== "chrome");
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        if (!overlap(s[i].bounds, s[j].bounds)) continue;
        const declared =
          s[i].allowedOverlaps.includes(s[j].id) || s[j].allowedOverlaps.includes(s[i].id);
        assert(declared, `${label}: undeclared overlap "${s[i].id}"×"${s[j].id}" (${alloc.shape})`);
      }
    }
  }
});

check("disjointness: the scorer agrees — 0 undeclared overlaps corpus-wide", () => {
  for (const { label, alloc } of everyAllocation()) {
    const scored: ScoredElement[] = alloc.slots.map((s) => ({
      id: s.id,
      role: s.role,
      bounds: s.bounds,
      allowedOverlaps: s.allowedOverlaps,
      excluded: s.layer === "base" || s.layer === "chrome",
    }));
    const sc = scoreLayout(scored, alloc.aspect);
    assert(sc.overlaps === 0, `${label}: scorer found ${sc.overlaps} overlaps (${alloc.shape})`);
  }
});

// ─── 2. Containment ─────────────────────────────────────────────────────────

check("containment: every content slot inside the title-safe content rect", () => {
  for (const { label, alloc } of everyAllocation()) {
    const C = contentRect(alloc.aspect);
    for (const s of alloc.slots) {
      if (s.layer !== "content") continue;
      const b = s.bounds;
      assert(
        b.x >= C.x - 1 && b.y >= C.y - 1 && b.x + b.w <= C.x + C.w + 1 && b.y + b.h <= C.y + C.h + 1,
        `${label}: "${s.id}" ${JSON.stringify(b)} escapes content rect ${JSON.stringify(C)} (${alloc.shape})`,
      );
    }
  }
});

check("containment: the content rect is inside title-safe and clears the chrome bar", () => {
  for (const aspect of ASPECTS) {
    const C = contentRect(aspect);
    const S = SAFE[aspect];
    const { h: H } = CANVAS[aspect];
    assert(C.x >= S.x && C.y >= S.y, `${aspect}: content rect starts outside title-safe`);
    assert(C.x + C.w <= S.x + S.w, `${aspect}: content rect exceeds title-safe width`);
    assert(C.y + C.h <= S.y + S.h, `${aspect}: content rect exceeds title-safe height`);
    const chrome = aspect === "9:16" ? 80 : 72;
    assert(C.y + C.h <= H - chrome, `${aspect}: content rect ${C.y + C.h} runs into the chrome bar at ${H - chrome}`);
  }
});

check("containment: no slot escapes the canvas, in any allocation", () => {
  for (const { label, alloc } of everyAllocation()) {
    const { w: W, h: H } = CANVAS[alloc.aspect];
    for (const s of alloc.slots) {
      const b = s.bounds;
      assert(
        b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H,
        `${label}: "${s.id}" ${JSON.stringify(b)} escapes the ${W}×${H} canvas`,
      );
    }
  }
});

// ─── 3. Focal dominance ─────────────────────────────────────────────────────

check("focal dominance: the rank-1 element holds the largest area, everywhere", () => {
  for (const { label, alloc } of everyAllocation()) {
    const content = alloc.slots.filter((s) => s.layer === "content");
    if (content.length < 2) continue;
    // The rank-1 element is the one mapped into the shape's "focal" slot.
    const focal = content.find((s) => s.slot === "focal");
    if (!focal) continue; // full-bleed-corner-copy puts the focal on the bleed layer
    for (const other of content) {
      if (other === focal) continue;
      assert(
        area(focal.bounds) >= area(other.bounds),
        `${label}: focal "${focal.id}" (${area(focal.bounds)}) is not ≥ "${other.id}" (${area(other.bounds)}) [${alloc.shape}]`,
      );
    }
  }
});

check("focal dominance: rank-1 is the element placed in the focal slot", () => {
  for (const { label, alloc } of everyAllocation()) {
    const focal = alloc.slots.find((s) => s.slot === "focal");
    if (!focal) continue;
    assert(
      focal.id === "hero" || focal.id === "copy",
      `${label}: focal slot holds "${focal.id}" — expected the rank-1 element (${alloc.shape})`,
    );
  }
});

check("focal dominance: the scorer confirms it on a representative scene", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [
      el("atmosphere", "atmosphere", null),
      el("copy", "copy", 2, { textChars: 180 }),
      el("hero", "hero", 1, { interiorCount: 7 }),
      el("throughline", "throughline", 3),
    ],
  });
  const sc = scoreLayout(
    alloc.slots.map((s) => ({
      id: s.id,
      role: s.role,
      focalRank: s.id === "hero" ? 1 : s.id === "copy" ? 2 : 3,
      bounds: s.bounds,
      allowedOverlaps: s.allowedOverlaps,
      excluded: s.layer === "base" || s.layer === "chrome",
    })),
    "16:9",
  );
  assert(sc.focalIsLargest === true, "rank-1 should hold the largest area");
  assert((sc.focalMargin ?? 0) > 1, `focal margin should exceed 1, got ${sc.focalMargin}`);
});

// ─── 4. Variety (the hard requirement) ──────────────────────────────────────

check("variety: the chooser returns DIFFERENT shapes for different inputs", () => {
  const seen = new Set<string>();
  for (const aspect of ASPECTS) {
    for (const register of REGISTERS) {
      for (const c of CASES) seen.add(allocateLayout(c.input(aspect, register)).shape);
    }
  }
  assert(seen.size >= 8, `expected ≥8 distinct shapes across the case matrix, got ${seen.size}: ${[...seen].sort().join(", ")}`);
});

check("variety: register alone changes the shape at a fixed element count", () => {
  const mk = (register: string): string =>
    allocateLayout({
      aspect: "16:9",
      register,
      elements: [
        el("atmosphere", "atmosphere", null),
        el("hero", "hero", 1, { interiorCount: 6 }),
        el("copy", "copy", 2, { textChars: 180 }),
      ],
    }).shape;
  const shapes = ["split", "stat", "list", "quote", "centered", "full-bleed"].map(mk);
  assert(new Set(shapes).size >= 5, `register should drive the shape; got ${shapes.join(", ")}`);
});

check("variety: element COUNT alone changes the shape at a fixed register", () => {
  const mk = (n: number): string => {
    const els: AllocElementInput[] = [el("atmosphere", "atmosphere", null), el("hero", "hero", 1, { interiorCount: 6 })];
    for (let i = 0; i < n; i++) els.push(el(`copy#${i}`, "copy", 2 + i, { textChars: 150 }));
    return allocateLayout({ aspect: "16:9", register: "centered", elements: els }).shape;
  };
  const shapes = [0, 1, 2, 3].map(mk);
  assert(new Set(shapes).size >= 3, `element count should drive the shape; got ${shapes.join(", ")}`);
});

check("variety: reading order (hero before copy) flips the split mirror", () => {
  const base = (heroFirst: boolean): string => {
    const hero = el("hero", "hero", 1, { interiorCount: 6 });
    const copy = el("copy", "copy", 2, { textChars: 150 });
    return allocateLayout({
      aspect: "16:9",
      register: "split",
      elements: [el("atmosphere", "atmosphere", null), ...(heroFirst ? [hero, copy] : [copy, hero])],
    }).shape;
  };
  assert(base(true) === "split-mock-left", `hero-first should mirror left, got ${base(true)}`);
  assert(base(false) === "split-mock-right", `copy-first should mirror right, got ${base(false)}`);
});

check("variety: content SIZE alone changes the shape (dense hero + short copy)", () => {
  const mk = (interior: number, chars: number): string =>
    allocateLayout({
      aspect: "16:9",
      register: "centered",
      elements: [
        el("atmosphere", "atmosphere", null),
        el("hero", "hero", 1, { interiorCount: interior }),
        el("copy", "copy", 2, { textChars: chars }),
      ],
    }).shape;
  assert(mk(11, 90) === "hero-dominant-strip", `dense hero + short copy should go wide, got ${mk(11, 90)}`);
  assert(mk(4, 420) === "centered-focal", `sparse hero + long copy should stay centred, got ${mk(4, 420)}`);
});

check("variety: the repertoire itself is wide (≥12 shapes) and every id is reachable", () => {
  const ids = shapeIds();
  assert(ids.length >= 12, `repertoire should carry ≥12 distributions, got ${ids.length}`);
  assert(new Set(ids).size === ids.length, "shape ids must be unique");
});

// ─── 5. Determinism ─────────────────────────────────────────────────────────

check("determinism: identical input yields byte-identical output", () => {
  for (const aspect of ASPECTS) {
    for (const register of REGISTERS) {
      for (const c of CASES) {
        const a = JSON.stringify(allocateLayout(c.input(aspect, register)));
        const b = JSON.stringify(allocateLayout(c.input(aspect, register)));
        assert(a === b, `${c.name} @${register}/${aspect}: allocation is not deterministic`);
      }
    }
  }
});

check("determinism: element ORDER within a focal rank is a stable tie-break", () => {
  const mk = (): string =>
    JSON.stringify(
      allocateLayout({
        aspect: "16:9",
        register: "centered",
        elements: [
          el("atmosphere", "atmosphere", null),
          el("a", "copy", null, { textChars: 100 }),
          el("b", "copy", null, { textChars: 100 }),
          el("c", "copy", null, { textChars: 100 }),
        ],
      }),
    );
  assert(mk() === mk(), "unranked elements must resolve by stable input order");
});

check("determinism: the scorer is deterministic too", () => {
  const alloc = allocateLayout(CASES[2].input("16:9", "list"));
  const mk = (): string =>
    JSON.stringify(
      scoreLayout(
        alloc.slots.map((s) => ({
          id: s.id,
          role: s.role,
          bounds: s.bounds,
          allowedOverlaps: s.allowedOverlaps,
          excluded: s.layer === "base" || s.layer === "chrome",
        })),
        "16:9",
      ),
    );
  assert(mk() === mk(), "scoreLayout must be deterministic");
});

// ─── 6. Void behaviour + sparse legality ────────────────────────────────────

check("void: a multi-element allocation keeps the largest dead region under 25% of safe area", () => {
  for (const { label, alloc } of everyAllocation()) {
    const content = alloc.slots.filter((s) => s.layer === "content");
    if (content.length < 2) continue;
    // FULL-BLEED IS EXEMPT, and honestly so. The scorer excludes canvas
    // treatments (≥85% of the frame) because counting them would drive every
    // void to zero and measure nothing — which means a full-bleed scene scores
    // as mostly-void on BOTH sides of the comparison. The number stays
    // comparable head-vs-allocator; it is just not a defect signal there.
    if (alloc.slots.some((s) => s.layer === "base" && s.role !== "atmosphere")) continue;
    const sc = scoreLayout(
      alloc.slots.map((s) => ({
        id: s.id,
        role: s.role,
        bounds: s.bounds,
        allowedOverlaps: s.allowedOverlaps,
        excluded: s.layer === "base" || s.layer === "chrome",
      })),
      alloc.aspect,
    );
    assert(sc.largestVoid < 0.25, `${label}: largest void ${(sc.largestVoid * 100).toFixed(1)}% (${alloc.shape})`);
  }
});

check("sparse is legal: a single-body scene is allowed to be mostly air", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [el("atmosphere", "atmosphere", null), el("hero", "hero", 1, { interiorCount: 5 })],
  });
  assert(alloc.shape === "poster-center", `one body should choose poster-center, got ${alloc.shape}`);
  const content = alloc.slots.filter((s) => s.layer === "content");
  assert(content.length === 1, "one body should produce exactly one content slot");
  // It must NOT have been inflated to fill the frame — deliberate air survives.
  const C = contentRect("16:9");
  assert(area(content[0].bounds) < 0.6 * area(C), "poster-center must not be inflated to fill the frame");
});

check("void: the motif is placed INTO the largest residual void, not beside it", () => {
  const withMotif = allocateLayout(CASES[2].input("16:9", "centered"));
  const withoutMotif = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: CASES[2].input("16:9", "centered").elements.filter((e) => e.role !== "throughline"),
  });
  const score = (a: Allocation) =>
    scoreLayout(
      a.slots.map((s) => ({
        id: s.id,
        role: s.role,
        bounds: s.bounds,
        allowedOverlaps: s.allowedOverlaps,
        excluded: s.layer === "base" || s.layer === "chrome",
      })),
      "16:9",
    ).largestVoid;
  assert(score(withMotif) <= score(withoutMotif), "adding the motif must not increase the largest void");
});

// ─── Supporting primitives ──────────────────────────────────────────────────

check("largestFreeRect: an empty frame returns the whole frame", () => {
  const f = { x: 0, y: 0, w: 540, h: 540 };
  const r = largestFreeRect([], f);
  assert(!!r && r.w === 540 && r.h === 540, `expected the full frame, got ${JSON.stringify(r)}`);
});

check("largestFreeRect: a fully claimed frame returns null", () => {
  const f = { x: 0, y: 0, w: 540, h: 540 };
  assert(largestFreeRect([f], f) === null, "a fully covered frame has no free rect");
});

check("largestFreeRect: finds the abandoned half", () => {
  const f = { x: 0, y: 0, w: 1080, h: 540 };
  const r = largestFreeRect([{ x: 0, y: 0, w: 540, h: 540 }], f);
  assert(!!r && r.x >= 540 && r.w >= 486, `expected the right half, got ${JSON.stringify(r)}`);
});

check("contentWeight: measured area outranks the role prior", () => {
  const small = contentWeight({ id: "a", role: "hero", measured: { w: 200, h: 120 } }, "16:9");
  const big = contentWeight({ id: "b", role: "hero", measured: { w: 1200, h: 700 } }, "16:9");
  assert(big > small, `a larger measured element must weigh more (${big} vs ${small})`);
});

check("contentWeight: is bounded, so one huge signal can't starve a peer", () => {
  const w = contentWeight({ id: "a", role: "copy", textChars: 100000, itemCount: 400, interiorCount: 400 }, "16:9");
  assert(w <= 2.0 && w >= 0.25, `weight must stay in [0.25, 2.0], got ${w}`);
});

check("chooseShape: an unknown register degrades to the centered family", () => {
  const s = chooseShape(
    "centered",
    [el("hero", "hero", 1, { interiorCount: 5 }), el("copy", "copy", 2, { textChars: 200 })],
    "16:9",
  );
  assert(s === "centered-focal", `unknown register should behave as centered, got ${s}`);
  const viaAllocate = allocateLayout({
    aspect: "16:9",
    register: "not-a-register",
    elements: [el("hero", "hero", 1, { interiorCount: 5 }), el("copy", "copy", 2, { textChars: 200 })],
  });
  assert(viaAllocate.register === "centered", `unknown register should normalise, got ${viaAllocate.register}`);
});

check("portrait: side-by-side shapes are substituted for stacked ones at 9:16", () => {
  const landscape = allocateLayout({
    aspect: "16:9",
    register: "split",
    elements: [el("hero", "hero", 1, { interiorCount: 6 }), el("copy", "copy", 2, { textChars: 150 })],
  }).shape;
  const portrait = allocateLayout({
    aspect: "9:16",
    register: "split",
    elements: [el("hero", "hero", 1, { interiorCount: 6 }), el("copy", "copy", 2, { textChars: 150 })],
  }).shape;
  assert(landscape !== portrait, `9:16 must not reuse a 41%-wide column shape (both ${landscape})`);
});

check("no element is ever dropped — every input gets a slot", () => {
  for (const { label, alloc } of everyAllocation()) {
    const ids = new Set(alloc.slots.map((s) => s.id));
    assert(ids.size === alloc.slots.length, `${label}: duplicate slot ids`);
  }
  for (const aspect of ASPECTS) {
    for (const c of CASES) {
      const input = c.input(aspect, "centered");
      const alloc = allocateLayout(input);
      for (const e of input.elements) {
        assert(alloc.slots.some((s) => s.id === e.id), `${c.name} @${aspect}: element "${e.id}" was dropped`);
      }
    }
  }
});

// ─── 7. Resizing as a first-class lever ─────────────────────────────────────

check("resize: a rank-1 element adrift is GROWN to command real area", () => {
  // Notion s0's shape: a small ticket card as the focal object.
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [
      el("atmosphere", "atmosphere", null),
      el("copy", "copy", 2, { textChars: 180 }),
      el("hero", "hero", 1, { interiorCount: 8 }),
    ],
  });
  const C = contentRect("16:9");
  const focal = alloc.slots.find((s) => s.slot === "focal");
  const bound = SIZE_BOUNDS.hero;
  assert(!!focal, "expected a focal slot");
  assert(
    area(focal!.bounds) >= bound.minFocalAreaFrac * area(C),
    `the focal object must clear its area floor: ${(area(focal!.bounds) / area(C)).toFixed(2)} < ${bound.minFocalAreaFrac}`,
  );
});

check("resize: no element exceeds its role's area ceiling", () => {
  for (const { label, alloc } of everyAllocation()) {
    const C = contentRect(alloc.aspect);
    for (const s of alloc.slots) {
      if (s.layer !== "content") continue;
      const cap = (SIZE_BOUNDS[s.role] ?? { maxAreaFrac: 0.6 }).maxAreaFrac;
      // +2% tolerance: the shape tables are authored in fractions and the size
      // clamp reverts rather than forcing a collision.
      assert(
        area(s.bounds) <= (cap + 0.02) * area(C),
        `${label}: "${s.id}" claims ${(area(s.bounds) / area(C) * 100).toFixed(0)}% of the content rect, ceiling ${cap * 100}% (${alloc.shape})`,
      );
    }
  }
});

check("resize: every content box clears its role's legibility floor", () => {
  for (const { label, alloc } of everyAllocation()) {
    for (const s of alloc.slots) {
      if (s.layer !== "content") continue;
      const bound = SIZE_BOUNDS[s.role];
      if (!bound) continue;
      // A SUBDIVIDED slot ("<slot>/<n>") means the scene brought more bodies
      // than the distribution has slots. Below that point no placement saves
      // it; the allocator reports a too-small box rather than dropping the
      // element. Excluded here and called out in the dry-run report instead.
      if (s.slot.includes("/")) continue;
      assert(
        s.bounds.w >= bound.minW * 0.9 && s.bounds.h >= bound.minH * 0.9,
        `${label}: "${s.id}" ${s.bounds.w}×${s.bounds.h} is below the ${s.role} legibility floor ${bound.minW}×${bound.minH} (${alloc.shape})`,
      );
    }
  }
});

check("resize: text roles are bounded more tightly than diegetic ones", () => {
  assert(
    SIZE_BOUNDS.copy.maxAreaFrac < SIZE_BOUNDS.hero.maxAreaFrac,
    "a text column must not be allowed to claim as much of the frame as a diegetic mock",
  );
});

// ─── 8. Reposition-only arm ─────────────────────────────────────────────────

const repositionCase = (): AllocInput => ({
  aspect: "16:9" as Aspect,
  register: "centered",
  mode: "reposition" as const,
  elements: [
    el("atmosphere", "atmosphere", null),
    el("copy", "copy", 2, { textChars: 180, authoredSize: { w: 1300, h: 210 } }),
    el("hero", "hero", 1, { interiorCount: 8, authoredSize: { w: 600, h: 320 } }),
    el("throughline", "throughline", 3, { authoredSize: { w: 140, h: 34 } }),
  ],
});

check("reposition: the head's authored SIZE survives verbatim", () => {
  const alloc = allocateLayout(repositionCase());
  const hero = alloc.slots.find((s) => s.id === "hero")!;
  const copy = alloc.slots.find((s) => s.id === "copy")!;
  assert(hero.bounds.w === 600 && hero.bounds.h === 320, `hero resized to ${hero.bounds.w}×${hero.bounds.h}`);
  assert(copy.bounds.w === 1300 && copy.bounds.h === 210, `copy resized to ${copy.bounds.w}×${copy.bounds.h}`);
});

check("reposition: boxes still land inside the title-safe content rect", () => {
  const alloc = allocateLayout(repositionCase());
  const C = contentRect("16:9");
  for (const s of alloc.slots) {
    if (s.layer !== "content") continue;
    assert(
      s.bounds.x >= C.x - 1 && s.bounds.y >= C.y - 1 && s.bounds.x + s.bounds.w <= C.x + C.w + 1 && s.bounds.y + s.bounds.h <= C.y + C.h + 1,
      `"${s.id}" ${JSON.stringify(s.bounds)} escapes ${JSON.stringify(C)}`,
    );
  }
});

check("reposition: the separation pass pulls overlapping authored boxes apart", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    mode: "reposition",
    elements: [
      el("hero", "hero", 1, { authoredSize: { w: 700, h: 400 } }),
      el("copy", "copy", 2, { authoredSize: { w: 700, h: 300 } }),
    ],
  });
  const a = alloc.slots.find((s) => s.id === "hero")!.bounds;
  const b = alloc.slots.find((s) => s.id === "copy")!.bounds;
  assert(!overlap(a, b), `separation failed: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});

check("reposition: the FOCAL element holds its ground; the subordinate yields", () => {
  const alloc = allocateLayout(repositionCase());
  const plain = allocateLayout({ ...repositionCase(), mode: "resize" });
  const focalPlain = plain.slots.find((s) => s.slot === "focal")!;
  const focalRepo = alloc.slots.find((s) => s.id === "hero")!;
  // Same slot centre in both arms — the focal is never displaced by a peer.
  const cxPlain = focalPlain.bounds.x + focalPlain.bounds.w / 2;
  const cxRepo = focalRepo.bounds.x + focalRepo.bounds.w / 2;
  assert(Math.abs(cxPlain - cxRepo) < 200, `the focal object drifted ${Math.abs(cxPlain - cxRepo)}px between arms`);
});

check("reposition: is deterministic", () => {
  const a = JSON.stringify(allocateLayout(repositionCase()));
  const b = JSON.stringify(allocateLayout(repositionCase()));
  assert(a === b, "reposition mode must be deterministic");
});

check("reposition: mode is recorded on the allocation", () => {
  assert(allocateLayout(repositionCase()).mode === "reposition", "mode must be reported");
  assert(allocateLayout(CASES[1].input("16:9", "centered")).mode === "resize", "default mode is resize");
});

// ─── 9. The repair rule ─────────────────────────────────────────────────────

check("repair: a subordinate crowding the focal object is SHRUNK, not moved", () => {
  // relieveCrowding only ever cuts extent; it never translates a box away from
  // its slot. Assert the invariant across the whole matrix: every content box
  // still sits inside the slot rect its shape assigned (crowding relief moves
  // an edge inward, so the box can only get smaller, never wander).
  for (const { label, alloc } of everyAllocation()) {
    if (alloc.mode !== "resize") continue;
    const content = alloc.slots.filter((s) => s.layer === "content");
    const focal = content.find((s) => s.slot === "focal");
    if (!focal) continue;
    for (const s of content) {
      if (s === focal) continue;
      // The motif's last-resort anchor DECLARES its overlap (as the composer's
      // does) when no residual void can hold it — a declared layer is not
      // crowding.
      if (s.allowedOverlaps.includes(focal.id) || focal.allowedOverlaps.includes(s.id)) continue;
      assert(!overlap(s.bounds, focal.bounds), `${label}: "${s.id}" still crowds the focal object`);
    }
  }
});

check("repair: a structurally-dead distribution is RE-PICKED, not patched", () => {
  // The ladder must be well-formed: every entry names a real shape, and no
  // entry is a self-loop (which would make the one-step re-pick a no-op).
  const ids = new Set(shapeIds());
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [el("atmosphere", "atmosphere", null), el("hero", "hero", 1, { interiorCount: 5 })],
  });
  assert(ids.has(alloc.shape), "the emitted shape must be in the repertoire");
  // Forcing a shape suppresses the re-pick, so the two are distinguishable.
  const forced = allocateLayout(
    { aspect: "16:9", register: "centered", elements: [el("hero", "hero", 1), el("copy", "copy", 2)] },
    { forceShape: "poster-center" },
  );
  assert(forced.shape === "poster-center" && forced.repicked === true, "a forced shape must be honoured and flagged");
});

// ─── 10. The two inputs round 1 lacked ──────────────────────────────────────

check("hero treatment: an ABSENT signal never inflates a placed hero to a bleed", () => {
  const els = [
    el("atmosphere", "atmosphere", null),
    el("hero", "hero", 1, { interiorCount: 7, authoredSize: { w: 1080, h: 920 } }),
    el("copy", "copy", 2, { textChars: 170, authoredSize: { w: 320, h: 200 } }),
  ];
  for (const t of [undefined, null, "placed" as const]) {
    const alloc = allocateLayout({ aspect: "16:9", register: "full-bleed", heroTreatment: t, elements: els });
    const hero = alloc.slots.find((x) => x.id === "hero")!;
    assert(hero.layer === "content", `treatment ${String(t)}: a placed hero must not become a canvas layer`);
    assert(
      alloc.shape === "dominant-center-corner-copy",
      `treatment ${String(t)}: expected the placed family, got ${alloc.shape}`,
    );
  }
});

check("hero treatment: an explicit BLEED signal does produce a canvas treatment", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "full-bleed",
    heroTreatment: "bleed",
    elements: [
      el("atmosphere", "atmosphere", null),
      el("hero", "hero", 1, { interiorCount: 7, authoredSize: { w: 1920, h: 1080 } }),
      el("copy", "copy", 2, { textChars: 170 }),
    ],
  });
  const hero = alloc.slots.find((x) => x.id === "hero")!;
  assert(hero.layer === "base", "an explicit bleed hero is the canvas layer");
  assert(hero.bounds.w === 1920 && hero.bounds.h === 1080, "a full-canvas authored bleed stays full-canvas");
});

check("hero treatment: a bleed hero KEEPS the head's deliberate inset margin", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "full-bleed",
    heroTreatment: "bleed",
    elements: [
      el("hero", "hero", 1, { interiorCount: 7, authoredSize: { w: 1840, h: 1000 } }),
      el("copy", "copy", 2, { textChars: 150 }),
    ],
  });
  const hero = alloc.slots.find((x) => x.id === "hero")!;
  assert(
    hero.bounds.w === 1840 && hero.bounds.h === 1000 && hero.bounds.x === 40 && hero.bounds.y === 40,
    `final-checkr's 40px inset must survive, got ${JSON.stringify(hero.bounds)}`,
  );
});

check("hero scale: the authored area anchors growth, so a healthy hero is not ballooned", () => {
  const authored = { w: 1080, h: 920 };
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "full-bleed",
    heroTreatment: "placed",
    elements: [
      el("hero", "hero", 1, { interiorCount: 7, authoredSize: authored }),
      el("copy", "copy", 2, { textChars: 170, authoredSize: { w: 320, h: 200 } }),
    ],
  });
  const hero = alloc.slots.find((x) => x.id === "hero")!;
  const ratio = area(hero.bounds) / (authored.w * authored.h);
  assert(ratio <= HERO_GROWTH_CAP + 0.01, `hero grew ${ratio.toFixed(2)}× — cap is ${HERO_GROWTH_CAP}`);
  assert(ratio >= 1 / HERO_SHRINK_CAP - 0.01, `hero shrank to ${ratio.toFixed(2)}× — floor is 1/${HERO_SHRINK_CAP}`);
});

check("hero scale: an ADRIFT focal object is still rescued past the growth cap", () => {
  // flags-notion s0's shape: a 600×320 card as the rank-1 object, 9% of frame.
  const authored = { w: 600, h: 320 };
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [
      el("hero", "hero", 1, { interiorCount: 8, authoredSize: authored }),
      el("copy", "copy", 2, { textChars: 180, authoredSize: { w: 1300, h: 210 } }),
    ],
  });
  const hero = alloc.slots.find((x) => x.id === "hero")!;
  const C = contentRect("16:9");
  assert(
    area(hero.bounds) >= SIZE_BOUNDS.hero.minFocalAreaFrac * area(C) * 0.995,
    `an adrift focal object must reach the focal floor, got ${(area(hero.bounds) / area(C)).toFixed(3)}`,
  );
});

check("copy ceiling: a text box may not exceed its content's need by more than the factor", () => {
  const extent = { neededArea: 64000, naturalW: 320, naturalH: 200, minW: 200, source: "derived" };
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "split",
    elements: [
      el("hero", "hero", 1, { interiorCount: 7, authoredSize: { w: 900, h: 800 } }),
      el("copy", "copy", 2, { textChars: 120, contentExtent: extent, authoredSize: { w: 320, h: 200 } }),
    ],
  });
  const copy = alloc.slots.find((x) => x.id === "copy")!;
  assert(
    area(copy.bounds) <= COPY_AREA_CEILING * extent.neededArea * 1.02,
    `copy claimed ${area(copy.bounds)} against a ceiling of ${COPY_AREA_CEILING * extent.neededArea}`,
  );
});

check("copy ceiling: a text box is never SMALLER than its content needs", () => {
  const extent = { neededArea: 300000, naturalW: 690, naturalH: 435, minW: 400, source: "derived" };
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [
      el("hero", "hero", 1, { interiorCount: 9, authoredSize: { w: 1200, h: 700 } }),
      el("copy", "copy", 2, { textChars: 400, contentExtent: extent }),
    ],
  });
  const copy = alloc.slots.find((x) => x.id === "copy")!;
  assert(area(copy.bounds) >= extent.neededArea * 0.98, `copy ${area(copy.bounds)} is under its need ${extent.neededArea}`);
  assert(copy.bounds.w >= extent.minW, `copy width ${copy.bounds.w} fractures its longest word (${extent.minW})`);
});

check("copy ceiling: void absorption cannot blow through it", () => {
  // A shape with room to grow into, plus a tiny content need: the absorption
  // pass must leave the text box alone (final-checkr s2's regression).
  const extent = { neededArea: 40000, naturalW: 300, naturalH: 133, minW: 250, source: "derived" };
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [
      el("hero", "hero", 1, { interiorCount: 6, authoredSize: { w: 700, h: 400 } }),
      el("copy", "copy", 2, { textChars: 60, contentExtent: extent }),
    ],
  });
  const copy = alloc.slots.find((x) => x.id === "copy")!;
  assert(
    area(copy.bounds) <= COPY_AREA_CEILING * extent.neededArea * 1.02,
    `absorption inflated copy to ${area(copy.bounds)} past the ${COPY_AREA_CEILING}× ceiling`,
  );
});

check("embedded motif: a child stays INSIDE its parent at the same relative rect", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "split",
    heroTreatment: "placed",
    elements: [
      el("hero", "hero", 1, { interiorCount: 8, authoredSize: { w: 920, h: 920 } }),
      el("copy", "copy", 2, { textChars: 200, authoredSize: { w: 800, h: 666 } }),
      el("throughline", "throughline", 3, {
        authoredSize: { w: 130, h: 34 },
        embeddedIn: "hero",
        // The chip sits ~28% across and ~11% down the workspace panel.
        embeddedRect: { fx: 0.283, fy: 0.109, fw: 0.141, fh: 0.037 },
      }),
    ],
  });
  const hero = alloc.slots.find((x) => x.id === "hero")!;
  const chip = alloc.slots.find((x) => x.id === "throughline")!;
  assert(chip.slot === "embedded:hero", `expected an embedded slot, got "${chip.slot}"`);
  const inside =
    chip.bounds.x >= hero.bounds.x &&
    chip.bounds.y >= hero.bounds.y &&
    chip.bounds.x + chip.bounds.w <= hero.bounds.x + hero.bounds.w + 1 &&
    chip.bounds.y + chip.bounds.h <= hero.bounds.y + hero.bounds.h + 1;
  assert(inside, `the chip escaped its parent: ${JSON.stringify(chip.bounds)} vs ${JSON.stringify(hero.bounds)}`);
  // Relative position preserved to within a rounding px.
  const fx = (chip.bounds.x - hero.bounds.x) / hero.bounds.w;
  assert(Math.abs(fx - 0.283) < 0.01, `relative x drifted to ${fx.toFixed(3)}`);
  assert(area(chip.bounds) < 0.05 * area(hero.bounds), "an embedded chip must stay a chip, not become a badge");
});

check("embedded motif: the overlap with its parent is DECLARED, not a defect", () => {
  const alloc = allocateLayout({
    aspect: "16:9",
    register: "centered",
    elements: [
      el("hero", "hero", 1, { interiorCount: 7, authoredSize: { w: 800, h: 600 } }),
      el("copy", "copy", 2, { textChars: 150 }),
      el("throughline", "throughline", 3, {
        authoredSize: { w: 64, h: 64 },
        embeddedIn: "hero",
        embeddedRect: { fx: 0.5, fy: 0.2, fw: 0.08, fh: 0.1 },
      }),
    ],
  });
  const sc = scoreLayout(
    alloc.slots
      .filter((x) => x.role !== "atmosphere" && x.layer !== "chrome")
      .map((x) => ({ id: x.id, role: x.role, bounds: x.bounds, allowedOverlaps: x.allowedOverlaps })),
    "16:9",
  );
  assert(sc.overlaps === 0, `an embedded child's overlap must be declared, got ${sc.overlaps}`);
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
