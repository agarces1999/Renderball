/**
 * Tests for the copy-overflow rejection path (P4b).
 *
 * Run: `node scripts/run-tests.mjs lib/render/copy-fit.test.ts`
 *
 * The mechanics are locked against SYNTHETIC metrics — a monospace-by-
 * construction face where capitals are deliberately 40% wider than lowercase,
 * so every expected line count is checkable by hand and the uppercase case is
 * not an accident of whichever font a CI runner happens to have. (The
 * per-glyph arithmetic itself is already validated against real Chromium in
 * capacity.test.ts; re-measuring it here would test that suite, not this one.)
 *
 * The behaviors that matter:
 *  1. attribution — a size/transform is read off the node that CARRIES the
 *     data-content-path, not guessed by proximity;
 *  2. the UPPERCASE budget — P4a measured caps wrapping to 7 lines in a box
 *     budgeted for 5, and our eyebrow copy is routinely uppercase;
 *  3. conservatism — well-fitting copy must never be rejected, because a false
 *     rejection costs a real re-emission;
 *  4. degradation — an uncalibrated face still produces a usable verdict, just
 *     a flagged one.
 */
import { type FontMetrics, CALIBRATION_GLYPHS, METRICS_VERSION, fallbackMetrics } from "./font-metrics";
import {
  checkCopyOverflow,
  deriveFitScale,
  maxDeclaredFontSize,
  overflowRepairMessage,
  parseTaggedCopyStyles,
  predictedCopyHeight,
  FIT_SCALE_FLOOR,
} from "./copy-fit";
import { deriveTypeScale } from "./type-scale";

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

/**
 * Every glyph advances 50 at 100px (so 0.5em) EXCEPT capitals, which advance
 * 70 (0.7em) — the ~40% caps penalty P4a measured on real proportional faces,
 * reproduced exactly so the uppercase assertions are arithmetic, not vibes.
 */
const CAPS_RX = /[A-ZÁÉÍÓÚÜÑ]/;
const MONO_CAPS: FontMetrics = {
  family: "TestCaps",
  weight: 400,
  adv: Object.fromEntries(CALIBRATION_GLYPHS.map((g) => [g, CAPS_RX.test(g) ? 70 : 50])),
  kern: {},
  meanAdv: 55,
  fallbackAdv: 70,
  normalLineHeight: 1.2,
  source: "chromium",
  calibratedAt: new Date().toISOString(),
  version: METRICS_VERSION,
  resolution: "asserted",
};

const SCALE = deriveTypeScale({ role: "copy", box: { w: 800, h: 500 }, canvas: { w: 1920, h: 1080 } });

// ── attribution ─────────────────────────────────────────────────────────────

await check("reads fontSize / textTransform / lineHeight off the TAGGED node itself", () => {
  const body = `
    <div style={{ fontSize: 200 }}>
      <span data-content-path="eyebrow" style={{ fontSize: 18, textTransform: "uppercase" }}>{c.eyebrow}</span>
      <h1 data-content-path="headline" style={{ fontSize: 64, lineHeight: 1.05 }}>{c.headline}</h1>
    </div>`;
  const styles = parseTaggedCopyStyles(body);
  const eyebrow = styles.get("eyebrow");
  const headline = styles.get("headline");
  assert(eyebrow?.fontSizePx === 18, `eyebrow size ${eyebrow?.fontSizePx} — must NOT inherit the 200 above it`);
  assert(eyebrow?.uppercase === true, "eyebrow uppercase not detected");
  assert(headline?.fontSizePx === 64, `headline size ${headline?.fontSizePx}`);
  assert(headline?.uppercase === false, "headline must not inherit the eyebrow's transform");
  assert(headline?.lineHeight === 1.05, `headline leading ${headline?.lineHeight}`);
});

await check("a `>` inside a style object does not end the tag (brace/quote-aware scan)", () => {
  const body = `<h1 data-content-path="headline" style={{ fontSize: 48, content: "a > b" }}>{c.headline}</h1>`;
  assert(parseTaggedCopyStyles(body).get("headline")?.fontSizePx === 48, "tag scan desynced on a '>' in a string");
});

await check("a px lineHeight converts to a multiplier; a bare number stays one", () => {
  const px = `<p data-content-path="lede" style={{ fontSize: 20, lineHeight: 30 }}>{c.lede}</p>`;
  const mult = `<p data-content-path="lede" style={{ fontSize: 20, lineHeight: 1.4 }}>{c.lede}</p>`;
  assert(parseTaggedCopyStyles(px).get("lede")?.lineHeight === 1.5, "30px @20px must read as 1.5");
  assert(parseTaggedCopyStyles(mult).get("lede")?.lineHeight === 1.4, "1.4 must stay 1.4");
});

await check("maxDeclaredFontSize finds the largest declared size anywhere in the body", () => {
  const body = `<div style={{ fontSize: 18 }}><h1 style={{ fontSize: "96px" }}>x</h1><p style={{ fontSize: 22 }}>y</p></div>`;
  assert(maxDeclaredFontSize(body) === 96, `got ${maxDeclaredFontSize(body)}`);
});

// ── the core check ──────────────────────────────────────────────────────────

const HEADLINE_40 = "Cada marca hoy tiene una senal mas clara"; // 40 chars

await check("copy that FITS is not rejected (false rejections cost a real re-emission)", () => {
  // 40 chars @ 40px mono-0.5em = 800px of text; box is 900 wide → 1 line,
  // 44px tall. A 400px box swallows it many times over.
  const body = `<h1 data-content-path="headline" style={{ fontSize: 40 }}>{c.headline}</h1>`;
  const r = checkCopyOverflow({
    body,
    entries: [{ path: "headline", text: HEADLINE_40 }],
    box: { w: 900, h: 400 },
    scale: SCALE,
    metrics: MONO_CAPS,
  });
  assert(!r.overflows, `must fit: ${r.totalPx}px into ${r.availablePx}px`);
  assert(r.entries[0].lines === 1, `expected 1 line, got ${r.entries[0].lines}`);
});

await check("copy that OVERFLOWS is rejected, and the worst offender is named", () => {
  // Same 40 chars at 120px = 2400px of text in a 900px box → 3 lines ≈ 396px,
  // which cannot fit a 200px-tall box.
  const body = `<h1 data-content-path="headline" style={{ fontSize: 120 }}>{c.headline}</h1>`;
  const r = checkCopyOverflow({
    body,
    entries: [{ path: "headline", text: HEADLINE_40 }],
    box: { w: 900, h: 200 },
    scale: SCALE,
    metrics: MONO_CAPS,
  });
  assert(r.overflows, `must overflow: ${r.totalPx}px vs ${r.availablePx}px`);
  assert(r.worst?.path === "headline", `worst should be the headline, got ${r.worst?.path}`);
  assert(r.entries[0].lines >= 3, `expected ≥3 lines, got ${r.entries[0].lines}`);
});

// ── the uppercase budget (the P4a-measured defect) ──────────────────────────

await check("UPPERCASE: identical copy overflows when the node transforms it, and fits when it does not", () => {
  const entries = [{ path: "eyebrow", text: HEADLINE_40 }];
  const box = { w: 900, h: 120 };
  // @40px: mixed case = 40×0.5×40 = 800px → 1 line. UPPERCASED = 40×0.7×40 =
  // 1120px → 2 lines. Two lines at 1.5 leading = 120px, which the 4%-margined
  // box (115px) cannot hold. This is exactly the class P4a measured.
  const mixed = `<p data-content-path="eyebrow" style={{ fontSize: 40 }}>{c.eyebrow}</p>`;
  const caps = `<p data-content-path="eyebrow" style={{ fontSize: 40, textTransform: "uppercase" }}>{c.eyebrow}</p>`;
  const rMixed = checkCopyOverflow({ body: mixed, entries, box, scale: SCALE, metrics: MONO_CAPS });
  const rCaps = checkCopyOverflow({ body: caps, entries, box, scale: SCALE, metrics: MONO_CAPS });
  assert(!rMixed.overflows, `mixed case must fit: ${rMixed.totalPx}px vs ${rMixed.availablePx}px`);
  assert(rCaps.overflows, `ALL CAPS must overflow: ${rCaps.totalPx}px vs ${rCaps.availablePx}px`);
  assert(rCaps.entries[0].lines > rMixed.entries[0].lines, "caps must cost more lines than mixed case");
  assert(rCaps.entries[0].rendered === HEADLINE_40.toUpperCase(), "caps text must be measured UPPERCASED");
  assert(rCaps.entries[0].uppercase, "the entry must report that it is uppercase");
});

await check("UPPERCASE: a css-string `text-transform: uppercase` is honored too", () => {
  const body = `<p data-content-path="eyebrow" style={{ fontSize: 40 }} css="text-transform: uppercase">{c.eyebrow}</p>`;
  const r = checkCopyOverflow({
    body,
    entries: [{ path: "eyebrow", text: HEADLINE_40 }],
    box: { w: 900, h: 120 },
    scale: SCALE,
    metrics: MONO_CAPS,
  });
  assert(r.entries[0].uppercase, "css-string uppercase must be detected");
});

// ── fallbacks + degradation ─────────────────────────────────────────────────

await check("an untagged DISPLAY field inherits the body's largest size only when asked", () => {
  // The headline node declares no size; the body's largest is 120px.
  const body = `<div><h1 style={{ fontSize: 120 }}><span data-content-path="headline">{c.headline}</span></h1></div>`;
  const args = {
    body,
    entries: [{ path: "headline", text: HEADLINE_40 }],
    box: { w: 900, h: 200 },
    scale: SCALE,
    metrics: MONO_CAPS,
  };
  const inherit = checkCopyOverflow({ ...args, inheritLargestForDisplay: true });
  const plain = checkCopyOverflow({ ...args, inheritLargestForDisplay: false });
  assert(inherit.entries[0].sizePx === 120, `expected inherited 120, got ${inherit.entries[0].sizePx}`);
  assert(plain.entries[0].sizePx === SCALE.headlinePx, `expected declared scale, got ${plain.entries[0].sizePx}`);
  assert(inherit.overflows, "the inherited 120px headline must be seen to overflow");
});

await check("UNCALIBRATED metrics still produce a verdict — flagged, and MORE conservative", () => {
  const body = `<h1 data-content-path="headline" style={{ fontSize: 40 }}>{c.headline}</h1>`;
  const entries = [{ path: "headline", text: HEADLINE_40 }];
  const box = { w: 900, h: 400 };
  const est = checkCopyOverflow({ body, entries, box, scale: SCALE, metrics: fallbackMetrics("Nope", 700) });
  const cal = checkCopyOverflow({ body, entries, box, scale: SCALE, metrics: MONO_CAPS });
  assert(est.estimated, "an uncalibrated face must flag the report as an estimate");
  assert(!cal.estimated, "a measured face must not be flagged");
  // 10% margin vs 4% — the uncalibrated verdict has strictly less room.
  assert(est.availablePx < cal.availablePx, `uncalibrated box ${est.availablePx} must be tighter than ${cal.availablePx}`);
});

await check("empty / whitespace copy is skipped rather than charged", () => {
  const body = `<h1 data-content-path="headline" style={{ fontSize: 40 }}>{c.headline}</h1>`;
  const r = checkCopyOverflow({
    body,
    entries: [{ path: "headline", text: "   " }],
    box: { w: 900, h: 40 },
    scale: SCALE,
    metrics: MONO_CAPS,
  });
  assert(!r.overflows && r.entries.length === 0, "blank copy must not manufacture an overflow");
});

await check("a degenerate box does not manufacture a rejection (capacity reports the ~0 budget instead)", () => {
  const body = `<h1 data-content-path="headline" style={{ fontSize: 40 }}>{c.headline}</h1>`;
  const r = checkCopyOverflow({
    body,
    entries: [{ path: "headline", text: HEADLINE_40 }],
    box: { w: 0, h: 0 },
    scale: SCALE,
    metrics: MONO_CAPS,
  });
  assert(!r.overflows, "a zero box is a geometry signal, not an emission defect");
});

await check("stacked fields share the box (a stack that fits individually can still overflow)", () => {
  const body = [
    `<p data-content-path="eyebrow" style={{ fontSize: 30 }}>{c.eyebrow}</p>`,
    `<h1 data-content-path="headline" style={{ fontSize: 60 }}>{c.headline}</h1>`,
    `<p data-content-path="lede" style={{ fontSize: 30 }}>{c.lede}</p>`,
  ].join("\n");
  const entries = [
    { path: "eyebrow", text: "Presentamos" },
    { path: "headline", text: HEADLINE_40 },
    { path: "lede", text: HEADLINE_40 },
  ];
  const roomy = checkCopyOverflow({ body, entries, box: { w: 900, h: 600 }, scale: SCALE, metrics: MONO_CAPS });
  const tight = checkCopyOverflow({ body, entries, box: { w: 900, h: 180 }, scale: SCALE, metrics: MONO_CAPS });
  assert(!roomy.overflows, `600px box must hold the stack (${roomy.totalPx}px)`);
  assert(tight.overflows, `180px box must not (${tight.totalPx}px)`);
  assert(tight.entries.length === 3, "every owned field must be measured");
});

// ── the repair instruction ──────────────────────────────────────────────────

await check("the repair message forbids rewriting the copy and prescribes SMALLER type", () => {
  const body = `<h1 data-content-path="headline" style={{ fontSize: 120, textTransform: "uppercase" }}>{c.headline}</h1>`;
  const r = checkCopyOverflow({
    body,
    entries: [{ path: "headline", text: HEADLINE_40 }],
    box: { w: 900, h: 200 },
    scale: SCALE,
    metrics: MONO_CAPS,
  });
  const msg = overflowRepairMessage(r, SCALE);
  assert(/must NOT be shortened/.test(msg), "must forbid rewriting the fixed copy");
  assert(/ALL CAPS/.test(msg), "must call out the uppercase cost when the field is uppercase");
  assert(/data-content-path="headline"/.test(msg), "must name the offending field");
  // The prescribed size must be strictly tighter than what was declared.
  const prescribed = Number(/headline at (\d+)px or less/.exec(msg)?.[1]);
  assert(prescribed > 0 && prescribed < SCALE.headlinePx, `prescribed ${prescribed} must be under ${SCALE.headlinePx}`);
});


// ── shrink-to-fit (Bug 2, the text arm) ─────────────────────────────────────
//
// The contract: text is NEVER clipped. Copy that already fits is left alone;
// copy that does not gets SMALLER, monotonically with how badly it overruns,
// and never smaller than the legibility floor.

const fitArgs = (text: string, box: { w: number; h: number }) => ({
  entries: [{ path: "headline", text }],
  box,
  scale: SCALE,
  metrics: MONO_CAPS,
});

await check("copy that already fits is NOT scaled", () => {
  const s = deriveFitScale(fitArgs("Short", { w: 800, h: 500 }));
  assert(s === 1, `expected no downscale, got ${s}`);
});

await check("copy that overruns its box scales DOWN rather than growing past it", () => {
  const long = "Ship the whole story in one frame ".repeat(6);
  const box = { w: 600, h: 200 };
  assert(predictedCopyHeight(fitArgs(long, box), 1) > box.h, "premise: it overruns at full size");
  const s = deriveFitScale(fitArgs(long, box));
  assert(s < 1, `expected a downscale, got ${s}`);
  assert(s >= FIT_SCALE_FLOOR, `must not go below the legibility floor: ${s}`);
});

await check("the chosen factor actually fits — and is the LARGEST one that does", () => {
  const long = "Ship the whole story in one frame ".repeat(4);
  const box = { w: 600, h: 260 };
  const args = fitArgs(long, box);
  const s = deriveFitScale(args);
  if (s < 1) {
    // Anything larger than the chosen step must fail to fit.
    assert(predictedCopyHeight(args, s + 0.05) > box.h * (1 - 0.04), `${s + 0.05} would also have fit — not the largest`);
  }
});

await check("monotone: worse overrun never yields a LARGER scale", () => {
  const box = { w: 600, h: 220 };
  let prev = 1.01;
  for (const n of [1, 3, 6, 12, 30]) {
    const s = deriveFitScale(fitArgs("Ship the whole story ".repeat(n), box));
    assert(s <= prev, `n=${n}: scale ${s} rose above ${prev}`);
    prev = s;
  }
});

await check("hopeless copy floors at FIT_SCALE_FLOOR — it never shrinks to nothing", () => {
  const s = deriveFitScale(fitArgs("word ".repeat(500), { w: 300, h: 80 }));
  assert(s === FIT_SCALE_FLOOR, `expected the floor ${FIT_SCALE_FLOOR}, got ${s}`);
});

await check("uppercase fields are measured UPPERCASED (P4a's caps penalty applies here too)", () => {
  const text = "ship the whole story in one single frame today";
  const box = { w: 500, h: 120 };
  const mixed = deriveFitScale({ ...fitArgs(text, box) });
  const caps = deriveFitScale({ ...fitArgs(text, box), uppercasePaths: new Set(["headline"]) });
  assert(caps <= mixed, `caps (${caps}) must never need a LARGER box than mixed case (${mixed})`);
});

await check("no owned copy ⇒ no scaling (nothing to fit)", () => {
  assert(deriveFitScale({ entries: [], box: { w: 100, h: 100 }, scale: SCALE, metrics: MONO_CAPS }) === 1, "empty");
  assert(deriveFitScale(fitArgs("x", { w: 100, h: 0 })) === 1, "degenerate box degrades to no-op");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
