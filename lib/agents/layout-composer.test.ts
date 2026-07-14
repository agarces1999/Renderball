/**
 * Tests for layout-composer — the deterministic contract issuer for
 * element-level generation. Run: `npx tsx lib/agents/layout-composer.test.ts`
 * (no API key, no credits).
 *
 * These lock the five hard invariants the element generators depend on:
 *   (a) non-atmosphere slots pairwise disjoint unless the overlap is DECLARED,
 *   (b) every slot inside the canvas,
 *   (c) split satisfies the findStrandedHero numeric contract by construction,
 *   (d) every present content field owned by exactly one element,
 *   (e) byte-identical determinism.
 * The overlap/containment checks are re-derived HERE (not imported from the
 * module) so a bug in the module's own assert can't vouch for itself.
 */
import {
  composeSceneLayout,
  CANVAS,
  SPLIT_HERO_MIN_W_FRAC,
  SPLIT_HERO_VCENTER_FRAC,
  type Aspect,
  type ElementSlot,
  type ScenePlan,
} from "./layout-composer";
import { throughlineAnchorFor } from "./choreograph";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered"];
const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

// A content object exercising EVERY ownable field (incl. deprecated `texts`).
const FULL_CONTENT = {
  eyebrow: "THE LEGACY TRAP",
  headline: "One massive headline",
  lede: "A supporting lede that establishes context.",
  bullets: ["one", "two", "three"],
  caption: "small support text",
  meta: [{ label: "ARR", value: "$4.2M" }],
  cta: { primary: "Start free", secondary: "Book a demo" },
  illustration: "line-chart",
  asset_ids: ["img_1"],
  texts: ["legacy string"],
};

// Independent re-derivations (deliberately NOT the module's internals).
const overlaps = (a: ElementSlot, b: ElementSlot): boolean =>
  a.bounds.x < b.bounds.x + b.bounds.w &&
  b.bounds.x < a.bounds.x + a.bounds.w &&
  a.bounds.y < b.bounds.y + b.bounds.h &&
  b.bounds.y < a.bounds.y + a.bounds.h;
const byId = (plan: ScenePlan, id: string): ElementSlot | undefined =>
  plan.elements.find((e) => e.id === id);

// ── (b) containment + (a) declared-overlaps, every register × every aspect,
//    with and without a throughline ──────────────────────────────────────────
for (const aspect of ASPECTS) {
  for (const register of REGISTERS) {
    for (const hasThroughline of [false, true]) {
      const label = `${register}@${aspect}${hasThroughline ? "+throughline" : ""}`;

      check(`${label}: all bounds inside the canvas`, () => {
        const { w: W, h: H } = CANVAS[aspect];
        const plan = composeSceneLayout({ register, content: FULL_CONTENT }, aspect, { hasThroughline });
        for (const el of plan.elements) {
          const { x, y, w, h } = el.bounds;
          assert(w > 0 && h > 0, `${el.id} has positive extent`);
          assert(x >= 0 && y >= 0 && x + w <= W && y + h <= H, `${el.id} (${x},${y},${w},${h}) inside ${W}×${H}`);
        }
      });

      check(`${label}: every overlap is declared (symmetric allowedOverlaps)`, () => {
        const plan = composeSceneLayout({ register, content: FULL_CONTENT }, aspect, { hasThroughline });
        const els = plan.elements;
        for (let i = 0; i < els.length; i++) {
          for (let j = i + 1; j < els.length; j++) {
            if (!overlaps(els[i], els[j])) continue;
            const declared =
              els[i].allowedOverlaps.includes(els[j].id) || els[j].allowedOverlaps.includes(els[i].id);
            assert(declared, `overlap ${els[i].id}×${els[j].id} must be declared`);
          }
        }
      });

      check(`${label}: mandatory furniture present`, () => {
        const plan = composeSceneLayout({ register, content: FULL_CONTENT }, aspect, { hasThroughline });
        const atmosphere = byId(plan, "atmosphere");
        const chrome = byId(plan, "chrome");
        const copy = byId(plan, "copy");
        const { w: W, h: H } = CANVAS[aspect];
        assert(!!copy && copy.kind === "text", "a text slot exists");
        assert(!!atmosphere && atmosphere.kind === "atmosphere", "an atmosphere slot exists");
        assert(
          atmosphere!.bounds.x === 0 && atmosphere!.bounds.y === 0 && atmosphere!.bounds.w === W && atmosphere!.bounds.h === H,
          "atmosphere is full-bleed",
        );
        assert(atmosphere!.bounds.z === 0, "atmosphere is the base layer (z0)");
        assert(!!chrome && chrome.kind === "chrome", "a chrome slot exists");
        assert(chrome!.bounds.z === 3, "chrome rides on top (z3)");
        assert(chrome!.bounds.x === 0 && chrome!.bounds.w === W, "chrome bar spans the full width");
        assert(chrome!.bounds.y + chrome!.bounds.h === H, "chrome bar is anchored to the bottom edge");
        assert(byId(plan, "throughline") !== undefined === hasThroughline, "throughline slot iff requested");
      });
    }
  }
}

// ── (c) the split contract, explicit numbers (mirrors findStrandedHero) ─────
check("split@16:9 satisfies the stranded-hero numeric contract", () => {
  const plan = composeSceneLayout({ register: "split", content: FULL_CONTENT }, "16:9");
  const hero = byId(plan, "hero")!;
  const copy = byId(plan, "copy")!;
  // Explicit gate numbers for 1920×1080: w ≥ 576, cy in 270..810.
  assert(hero.bounds.w >= 0.3 * 1920, `hero w=${hero.bounds.w} ≥ 576 (30% of 1920)`);
  assert(hero.bounds.w >= SPLIT_HERO_MIN_W_FRAC * 1920, "matches the exported constant too");
  const cy = hero.bounds.y + hero.bounds.h / 2;
  assert(Math.abs(cy - 540) <= 0.25 * 1080, `hero cy=${cy} within 540±270`);
  assert(Math.abs(cy - 540) <= SPLIT_HERO_VCENTER_FRAC * 1080, "matches the exported constant too");
  const heroCx = hero.bounds.x + hero.bounds.w / 2;
  const copyCx = copy.bounds.x + copy.bounds.w / 2;
  assert((heroCx - 960) * (copyCx - 960) < 0, `centroids ${heroCx} vs ${copyCx} on OPPOSITE halves of 960`);
});

check("split@9:16 satisfies the same contract on the vertical canvas", () => {
  const plan = composeSceneLayout({ register: "split", content: FULL_CONTENT }, "9:16");
  const hero = byId(plan, "hero")!;
  const copy = byId(plan, "copy")!;
  assert(hero.bounds.w >= 0.3 * 1080, `hero w=${hero.bounds.w} ≥ 324 (30% of 1080)`);
  const cy = hero.bounds.y + hero.bounds.h / 2;
  assert(Math.abs(cy - 960) <= 0.25 * 1920, `hero cy=${cy} within 960±480`);
  const heroCx = hero.bounds.x + hero.bounds.w / 2;
  const copyCx = copy.bounds.x + copy.bounds.w / 2;
  assert((heroCx - 540) * (copyCx - 540) < 0, "centroids on opposite halves of 540");
});

check("split@16:9: hero and copy do not touch (independent generation is safe)", () => {
  const plan = composeSceneLayout({ register: "split", content: FULL_CONTENT }, "16:9");
  assert(!overlaps(byId(plan, "hero")!, byId(plan, "copy")!), "hero and copy are disjoint");
});

// ── (d) exclusive content ownership with EVERY field present ────────────────
check("ownership: every present field owned by exactly one element (16:9, all registers)", () => {
  const OWNABLE = ["eyebrow", "headline", "lede", "bullets", "caption", "meta", "cta", "texts", "illustration", "asset_ids"];
  for (const register of REGISTERS) {
    const plan = composeSceneLayout({ register, content: FULL_CONTENT }, "16:9", { hasThroughline: true });
    const owners = new Map<string, string[]>();
    for (const el of plan.elements) {
      for (const f of el.contentFields) owners.set(f, [...(owners.get(f) ?? []), el.id]);
    }
    for (const f of OWNABLE) {
      const who = owners.get(f) ?? [];
      assert(who.length === 1, `${register}: "${f}" owned by [${who.join(",")}] — want exactly 1`);
    }
  }
});

check("ownership: copy owns ALL copy fields; hero owns the visual fields", () => {
  const plan = composeSceneLayout({ register: "split", content: FULL_CONTENT }, "16:9");
  const copy = byId(plan, "copy")!;
  const hero = byId(plan, "hero")!;
  for (const f of ["eyebrow", "headline", "lede", "bullets", "caption", "meta", "cta", "texts"]) {
    assert(copy.contentFields.includes(f), `copy owns ${f}`);
  }
  for (const f of ["illustration", "asset_ids"]) {
    assert(hero.contentFields.includes(f), `hero owns ${f}`);
    assert(!copy.contentFields.includes(f), `copy does NOT own ${f}`);
  }
});

check("ownership: empty arrays / blank strings are ABSENT, not owned", () => {
  const plan = composeSceneLayout(
    { register: "centered", content: { headline: "H", bullets: [], eyebrow: "  ", asset_ids: [] } },
    "16:9",
  );
  const copy = byId(plan, "copy")!;
  assert(copy.contentFields.includes("headline"), "headline present → owned");
  assert(!copy.contentFields.includes("bullets"), "bullets: [] is absent");
  assert(!copy.contentFields.includes("eyebrow"), "whitespace eyebrow is absent");
  assert(byId(plan, "hero")!.contentFields.length === 0, "no visual fields → hero slot stays, owns nothing");
});

check("ownership: missing content object → empty ownership, no crash", () => {
  const plan = composeSceneLayout({ register: "list" }, "16:9");
  assert(byId(plan, "copy")!.contentFields.length === 0, "nothing to own");
});

// ── (e) determinism — byte-identical output for identical inputs ────────────
check("determinism: same inputs → byte-identical ScenePlan", () => {
  for (const register of REGISTERS) {
    for (const aspect of ASPECTS) {
      const a = composeSceneLayout({ register, content: { ...FULL_CONTENT } }, aspect, { hasThroughline: true });
      const b = composeSceneLayout({ register, content: { ...FULL_CONTENT } }, aspect, { hasThroughline: true });
      assert(JSON.stringify(a) === JSON.stringify(b), `${register}@${aspect} is deterministic`);
    }
  }
});

// ── register semantics ───────────────────────────────────────────────────────
check("hero slots: split/stat/list/full-bleed/centered always; quote only with visuals", () => {
  for (const register of ["split", "stat", "list", "full-bleed", "centered"]) {
    const bare = composeSceneLayout({ register, content: { headline: "H" } }, "16:9");
    assert(byId(bare, "hero") !== undefined, `${register} carries a hero even without visual fields`);
    assert(byId(bare, "hero")!.kind === "diegetic", `${register} hero is diegetic`);
  }
  const quoteBare = composeSceneLayout({ register: "quote", content: { headline: "Q" } }, "16:9");
  assert(byId(quoteBare, "hero") === undefined, "text-only quote stands alone (no hero)");
  const quoteViz = composeSceneLayout({ register: "quote", content: { headline: "Q", illustration: "sparkline" } }, "16:9");
  assert(byId(quoteViz, "hero") !== undefined, "quote with visual intent earns a hero");
  assert(byId(quoteViz, "hero")!.contentFields.includes("illustration"), "…and owns it");
});

check("full-bleed: hero is the canvas treatment; overlaid copy/chrome are DECLARED", () => {
  const plan = composeSceneLayout({ register: "full-bleed", content: FULL_CONTENT }, "16:9", { hasThroughline: true });
  const hero = byId(plan, "hero")!;
  assert(hero.bounds.w === 1920 && hero.bounds.h === 1080, "hero spans the full canvas (≥85% ⇒ gate treats it as a treatment)");
  const copy = byId(plan, "copy")!;
  const chrome = byId(plan, "chrome")!;
  assert(overlaps(hero, copy) && overlaps(hero, chrome), "copy and chrome really do sit on the hero");
  for (const id of ["copy", "chrome", "throughline"]) {
    assert(hero.allowedOverlaps.includes(id), `full-bleed hero declares ${id} may overlap it`);
  }
  assert(copy.bounds.z > hero.bounds.z, "overlaid copy paints ABOVE the treatment (z decides)");
});

check("unknown / absent register falls back to centered (the schema default)", () => {
  const a = composeSceneLayout({ register: "mystery", content: { headline: "H" } }, "16:9");
  const b = composeSceneLayout({ content: { headline: "H" } }, "16:9");
  const c = composeSceneLayout({ register: "centered", content: { headline: "H" } }, "16:9");
  assert(a.register === "centered" && b.register === "centered", "normalized to centered");
  assert(JSON.stringify(a) === JSON.stringify(c), "identical plan to an explicit centered");
});

// ── throughline slot ─────────────────────────────────────────────────────────
check("throughline: pinned EXACTLY to the choreographer's anchor, per aspect", () => {
  for (const aspect of ASPECTS) {
    const plan = composeSceneLayout({ register: "split", content: FULL_CONTENT }, aspect, { hasThroughline: true });
    const tl = byId(plan, "throughline")!;
    const anchor = throughlineAnchorFor(aspect);
    assert(tl.bounds.x === anchor.left && tl.bounds.y === anchor.top, `${aspect}: box at (${anchor.left},${anchor.top})`);
    assert(tl.bounds.w <= 280 && tl.bounds.h <= 280, "small motif (inside the 280px drift tolerance)");
    assert(tl.paletteRoles.length === 1 && tl.paletteRoles[0] === "accent", "the motif IS the accent thread");
  }
  // 16:9 anchor is the load-bearing one for the match cut: assert the numbers.
  const plan = composeSceneLayout({ register: "split", content: FULL_CONTENT }, "16:9", { hasThroughline: true });
  const tl = byId(plan, "throughline")!;
  assert(tl.bounds.x === 1360 && tl.bounds.y === 540, "16:9 anchor is (1360, 540) per throughlineAnchorFor");
});

check("throughline: never overlaps copy or chrome at any register × aspect", () => {
  for (const register of REGISTERS) {
    for (const aspect of ASPECTS) {
      const plan = composeSceneLayout({ register, content: FULL_CONTENT }, aspect, { hasThroughline: true });
      const tl = byId(plan, "throughline")!;
      assert(!overlaps(tl, byId(plan, "copy")!), `${register}@${aspect}: motif clear of copy`);
      assert(!overlaps(tl, byId(plan, "chrome")!), `${register}@${aspect}: motif clear of chrome`);
    }
  }
});

// ── palette-role doctrine ────────────────────────────────────────────────────
check("accent is declared, never default: plain copy is ink-only; stat/quote copy earns accent", () => {
  const centered = composeSceneLayout({ register: "centered", content: FULL_CONTENT }, "16:9");
  assert(!byId(centered, "copy")!.paletteRoles.includes("accent"), "centered copy is ink-only");
  const stat = composeSceneLayout({ register: "stat", content: FULL_CONTENT }, "16:9");
  assert(byId(stat, "copy")!.paletteRoles.includes("accent"), "the stat metric may take accent");
  const quote = composeSceneLayout({ register: "quote", content: FULL_CONTENT }, "16:9");
  assert(byId(quote, "copy")!.paletteRoles.includes("accent"), "quote emphasis may take accent");
  assert(byId(centered, "chrome")!.paletteRoles.join() === "ink", "chrome is ink-only");
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
