/**
 * Tests for the deterministic type scale (P4b).
 *
 * Run: `node scripts/run-tests.mjs lib/render/type-scale.test.ts`
 *
 * What these lock, and why each matters:
 *  - the ramp is a real ramp (monotone, aligned, above the legibility floor);
 *  - the ROLE start step reflects design intent, not geometry;
 *  - a SMALL box downshifts and a generous box never upshifts — the property
 *    the whole "derive it, don't ask the head" decision rests on;
 *  - the scale is PURE: same input, same answer, every time (a budget is only
 *    meaningful if the re-emission is measured against the same number the
 *    first emission was given);
 *  - the override hook is additive and wins, so a later head-authored scale
 *    threads through without a call-site change.
 */
import {
  BODY_RAMP,
  DEFAULT_START_STEP,
  HEADLINE_LINE_HEIGHT,
  HEADLINE_RAMP,
  MIN_BODY_PX,
  MIN_HEADLINE_EM_PER_LINE,
  MIN_HEADLINE_PX,
  ROLE_START_STEP,
  deriveTypeScale,
  describeTypeScale,
} from "./type-scale";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

const CANVAS_16_9 = { w: 1920, h: 1080 };
const CANVAS_9_16 = { w: 1080, h: 1920 };

// ── the ramps themselves ────────────────────────────────────────────────────

await check("ramps are index-aligned, monotone-descending, and above the legibility floor", () => {
  assert(HEADLINE_RAMP.length === BODY_RAMP.length, "ramps must be index-aligned");
  for (let i = 1; i < HEADLINE_RAMP.length; i++) {
    assert(HEADLINE_RAMP[i] < HEADLINE_RAMP[i - 1], `headline ramp not descending at ${i}`);
    assert(BODY_RAMP[i] <= BODY_RAMP[i - 1], `body ramp not descending at ${i}`);
  }
  assert(HEADLINE_RAMP[HEADLINE_RAMP.length - 1] >= MIN_HEADLINE_PX, "smallest headline step below the floor");
  assert(BODY_RAMP[BODY_RAMP.length - 1] >= MIN_BODY_PX, "smallest body step below the floor");
  // Headline type is always larger than body type at the same step — otherwise
  // the "display" step is not display type.
  for (let i = 0; i < HEADLINE_RAMP.length; i++) {
    assert(HEADLINE_RAMP[i] > BODY_RAMP[i], `step ${i}: headline not larger than body`);
  }
});

// ── role intent ─────────────────────────────────────────────────────────────

await check("a roomy COPY box gets larger type than a roomy HERO box (design intent, not geometry)", () => {
  const box = { w: 900, h: 600 };
  const copy = deriveTypeScale({ role: "copy", box, canvas: CANVAS_16_9 });
  const hero = deriveTypeScale({ role: "hero", box, canvas: CANVAS_16_9 });
  assert(copy.headlinePx > hero.headlinePx, `copy ${copy.headlinePx} must exceed hero ${hero.headlinePx}`);
  assert(copy.step === ROLE_START_STEP.copy, `copy should sit at its start step, got ${copy.step}`);
  assert(hero.step === ROLE_START_STEP.hero, `hero should sit at its start step, got ${hero.step}`);
  assert(!copy.downshifted && !hero.downshifted, "a roomy box must not downshift");
});

await check("an unknown role lands at the default mid-ramp step", () => {
  const s = deriveTypeScale({ role: "totally-new-role", box: { w: 900, h: 600 }, canvas: CANVAS_16_9 });
  assert(s.step === DEFAULT_START_STEP, `expected default step ${DEFAULT_START_STEP}, got ${s.step}`);
});

// ── the small-box downshift (the load-bearing behavior) ─────────────────────

await check("SMALL BOX DOWNSHIFT: a short copy box steps down the ramp", () => {
  const roomy = deriveTypeScale({ role: "copy", box: { w: 900, h: 600 }, canvas: CANVAS_16_9 });
  const short = deriveTypeScale({ role: "copy", box: { w: 900, h: 150 }, canvas: CANVAS_16_9 });
  assert(short.step > roomy.step, `short box must downshift: ${short.step} vs ${roomy.step}`);
  assert(short.downshifted, "short box must report downshifted");
  assert(short.headlinePx < roomy.headlinePx, "downshift must actually shrink the type");
});

await check("SMALL BOX DOWNSHIFT: a NARROW copy box steps down even when it is tall", () => {
  const wide = deriveTypeScale({ role: "copy", box: { w: 900, h: 900 }, canvas: CANVAS_16_9 });
  const narrow = deriveTypeScale({ role: "copy", box: { w: 260, h: 900 }, canvas: CANVAS_16_9 });
  assert(narrow.step > wide.step, `narrow box must downshift: ${narrow.step} vs ${wide.step}`);
  // The width rule is what it claims to be: the chosen size fits the em budget.
  assert(
    narrow.headlinePx * MIN_HEADLINE_EM_PER_LINE <= 260,
    `${narrow.headlinePx}px × ${MIN_HEADLINE_EM_PER_LINE}em must fit in 260px`,
  );
});

await check("the chosen step always satisfies its own height rule (copy = 2 headline lines + 2 body lines)", () => {
  for (const h of [120, 180, 240, 360, 520, 800]) {
    const s = deriveTypeScale({ role: "copy", box: { w: 900, h }, canvas: CANVAS_16_9 });
    const need = 2 * s.headlinePx * s.headlineLineHeight + 2 * s.bodyPx * s.bodyLineHeight;
    // The very smallest step is the floor — it ships even when nothing fits,
    // because the emitter still needs a number (capacity.ts reports the ~0
    // budget separately, which is the honest signal).
    const atFloor = s.step === HEADLINE_RAMP.length - 1;
    assert(atFloor || need <= h, `h=${h}: step ${s.step} needs ${need.toFixed(0)}px`);
  }
});

await check("NEVER upshifts: a giant box does not earn type above the role's nominal step", () => {
  const s = deriveTypeScale({ role: "hero", box: { w: 1900, h: 1060 }, canvas: CANVAS_16_9 });
  assert(s.step === ROLE_START_STEP.hero, `giant hero box must stay at its start step, got ${s.step}`);
  assert(s.headlinePx === HEADLINE_RAMP[ROLE_START_STEP.hero], "size must equal the ramp step");
});

await check("degenerate boxes fall to the floor step rather than throwing or returning zero", () => {
  for (const box of [{ w: 0, h: 0 }, { w: -5, h: 40 }, { w: 10, h: 10 }]) {
    const s = deriveTypeScale({ role: "copy", box, canvas: CANVAS_16_9 });
    assert(s.headlinePx >= MIN_HEADLINE_PX, `headline ${s.headlinePx} below floor`);
    assert(s.bodyPx >= MIN_BODY_PX, `body ${s.bodyPx} below floor`);
    assert(s.step === HEADLINE_RAMP.length - 1, `expected floor step, got ${s.step}`);
  }
});

// ── canvas independence ─────────────────────────────────────────────────────

await check("a PORTRAIT canvas does not inflate type (scale keys off the SHORT side)", () => {
  const box = { w: 900, h: 600 };
  const land = deriveTypeScale({ role: "copy", box, canvas: CANVAS_16_9 });
  const port = deriveTypeScale({ role: "copy", box, canvas: CANVAS_9_16 });
  assert(
    land.headlinePx === port.headlinePx,
    `16:9 ${land.headlinePx} vs 9:16 ${port.headlinePx} — both share a 1080 short side`,
  );
});

// ── purity + the override hook ──────────────────────────────────────────────

await check("PURE: identical inputs give identical output (a re-emission is judged by the same number)", () => {
  const args = { role: "copy", box: { w: 760, h: 340 }, canvas: CANVAS_16_9 };
  const a = deriveTypeScale(args);
  const b = deriveTypeScale(args);
  assert(JSON.stringify(a) === JSON.stringify(b), "derivation is not deterministic");
});

await check("OVERRIDE is additive and wins (the head-authored-scale hook)", () => {
  const base = deriveTypeScale({ role: "copy", box: { w: 900, h: 600 }, canvas: CANVAS_16_9 });
  const over = deriveTypeScale({
    role: "copy",
    box: { w: 900, h: 600 },
    canvas: CANVAS_16_9,
    override: { headlinePx: 132, headlineLineHeight: 0.95 },
  });
  assert(over.headlinePx === 132, `override ignored: ${over.headlinePx}`);
  assert(over.headlineLineHeight === 0.95, `line-height override ignored: ${over.headlineLineHeight}`);
  // Unspecified fields still come from the derivation.
  assert(over.bodyPx === base.bodyPx, "an override must not disturb unspecified fields");
  assert(over.step === base.step, "an override must not disturb the reported step");
});

await check("describeTypeScale states the sizes AND that they are a ceiling", () => {
  const s = deriveTypeScale({ role: "copy", box: { w: 900, h: 600 }, canvas: CANVAS_16_9 });
  const text = describeTypeScale(s);
  assert(text.includes(`${s.headlinePx}px`), "must state the headline size");
  assert(text.includes(`${s.bodyPx}px`), "must state the body size");
  assert(/CEILING/.test(text), "must state that the headline size is a ceiling");
  assert(s.headlineLineHeight === HEADLINE_LINE_HEIGHT, "default headline leading changed unexpectedly");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
