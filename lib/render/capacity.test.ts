/**
 * Tests for the capacity-budget engine.
 *
 * Run: `node scripts/run-tests.mjs lib/render/capacity.test.ts`
 *
 * Two layers:
 *  1. SYNTHETIC metrics (a monospace-by-construction font) lock the mechanics:
 *     UAX#14 breaking on hyphen / slash / em-dash, the unbreakable-run charge,
 *     and — the load-bearing one — that the safety margin always errs toward
 *     UNDER-filling.
 *  2. The CHROMIUM GOLDEN test calibrates real system fonts in real headless
 *     Chromium and asserts the pure-Node prediction agrees with what actually
 *     paints, within the margin. This is the test that makes the engine
 *     trustworthy: without it, the budget is just another statistical guess.
 *     Skipped with a notice when Playwright/chromium is unavailable.
 */
import {
  CAPACITY_SAFETY_MARGIN,
  UNCALIBRATED_SAFETY_MARGIN,
  MAX_NEST_DEPTH,
  type TypeScale,
  capacityFor,
  describeCapacity,
  fits,
  linesNeeded,
  linesNeededPx,
  usableBox,
} from "./capacity";
import {
  CALIBRATION_GLYPHS,
  type FontMetrics,
  calibrateFont,
  cssFontFamily,
  fallbackMetrics,
  textWidth,
} from "./font-metrics";

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
 * Monospace-by-construction metrics: every calibrated glyph advances 50 at
 * 100px, so at 10px every character is exactly 5px wide and every expected line
 * count is checkable by hand.
 */
const MONO: FontMetrics = {
  family: "TestMono",
  weight: 400,
  adv: Object.fromEntries(CALIBRATION_GLYPHS.map((g) => [g, 50])),
  kern: {},
  meanAdv: 50,
  fallbackAdv: 50,
  normalLineHeight: 1.2,
  source: "chromium",
  calibratedAt: new Date().toISOString(),
};

// ── UAX#14 break opportunities ──────────────────────────────────────────────
// Each case is built so a NAIVE implementation gives a provably different (and
// too-optimistic) answer: at 10px/5px-per-char with a 60px line, three 6-char
// runs cost 3 lines when the punctuation breaks, but ceil(100/60) = 2 if you
// treat the whole thing as one unbreakable token — which is exactly what a
// space-splitter does to "auto-servicio", "24/7" and "más — rápido".

await check("UAX#14: HYPHEN is a break opportunity (space-splitting says 2, truth is 3)", () => {
  const hyphen = "aaaaaa-aaaaaa-aaaaaa"; // 20 chars = 100px @10px
  const opaque = "aaaaaaXaaaaaaXaaaaaa"; // same length, no break opportunity
  assert(linesNeededPx(MONO, hyphen, 60, 10) === 3, `hyphen → ${linesNeededPx(MONO, hyphen, 60, 10)}`);
  assert(linesNeededPx(MONO, opaque, 60, 10) === 2, `opaque → ${linesNeededPx(MONO, opaque, 60, 10)}`);
});

await check("UAX#14: SLASH is a break opportunity", () => {
  const slash = "aaaaaa/aaaaaa/aaaaaa";
  assert(linesNeededPx(MONO, slash, 60, 10) === 3, `slash → ${linesNeededPx(MONO, slash, 60, 10)}`);
  // The real-copy shape this protects: "24/7" must not be charged as one token.
  assert(linesNeededPx(MONO, "soporte 24/7", 40, 10) >= 2, "24/7 must be wrappable");
});

await check("UAX#14: EM-DASH breaks on both sides", () => {
  const dash = "aaaaaa—aaaaaa—aaaaaa";
  assert(linesNeededPx(MONO, dash, 60, 10) === 3, `em-dash → ${linesNeededPx(MONO, dash, 60, 10)}`);
  // En-dash too — the script generator emits both.
  assert(linesNeededPx(MONO, "aaaaaa–aaaaaa–aaaaaa", 60, 10) === 3, "en-dash");
});

await check("UAX#14: mandatory breaks (\\n) always start a new line", () => {
  assert(linesNeededPx(MONO, "ab\ncd", 1000, 10) === 2, `\\n → ${linesNeededPx(MONO, "ab\ncd", 1000, 10)}`);
  // A trailing newline must not invent a phantom line.
  assert(linesNeededPx(MONO, "abcd", 1000, 10) === 1, "single line");
});

await check("an UNBREAKABLE run wider than the box is charged ceil(w/box), never 1", () => {
  // A naive space-splitter puts a single token on a single line and reports
  // "fits" — the exact lie a blind emitter would act on.
  const url = "supercalifragilistico"; // 21 chars = 105px @10px
  assert(linesNeededPx(MONO, url, 30, 10) === 4, `→ ${linesNeededPx(MONO, url, 30, 10)}`);
  assert(linesNeededPx(MONO, url, 105, 10) === 1, "exact fit is one line");
});

await check("greedy first-fit matches browser wrapping on ordinary spaced copy", () => {
  const t = "cada marca merece"; // 4+1+5+1+6 = 17 chars = 85px
  assert(linesNeededPx(MONO, t, 85, 10) === 1, `85px → ${linesNeededPx(MONO, t, 85, 10)}`);
  // "cada marca" = 50px, +" merece" would be 85 > 60 → 2 lines.
  assert(linesNeededPx(MONO, t, 60, 10) === 2, `60px → ${linesNeededPx(MONO, t, 60, 10)}`);
  assert(linesNeededPx(MONO, t, 30, 10) === 3, `30px → ${linesNeededPx(MONO, t, 30, 10)}`);
  assert(linesNeededPx(MONO, "   ", 100, 10) === 0, "whitespace-only is 0 lines");
});

// ── the safety margin, in the conservative direction ────────────────────────

await check("MARGIN is in the mandated 3–5% band and is a named constant", () => {
  assert(CAPACITY_SAFETY_MARGIN >= 0.03 && CAPACITY_SAFETY_MARGIN <= 0.05, `${CAPACITY_SAFETY_MARGIN}`);
  assert(UNCALIBRATED_SAFETY_MARGIN > CAPACITY_SAFETY_MARGIN, "uncalibrated fonts must buy MORE headroom");
});

await check("MARGIN shrinks the usable box — never grows it", () => {
  const u = usableBox({ w: 1000, h: 500 }, MONO);
  assert(u.w === 1000 * (1 - CAPACITY_SAFETY_MARGIN), `w → ${u.w}`);
  assert(u.h === 500 * (1 - CAPACITY_SAFETY_MARGIN), `h → ${u.h}`);
  assert(u.w < 1000 && u.h < 500, "usable box must be strictly smaller");
  const uf = usableBox({ w: 1000, h: 500 }, fallbackMetrics("X"));
  assert(uf.w < u.w, "uncalibrated usable box must be narrower still");
});

await check("MARGIN makes linesNeeded err HIGH at the exact-fit boundary", () => {
  const text = "a".repeat(20); // exactly 100px @10px
  // Raw arithmetic: exactly one line. That is the case that ships overflow when
  // the real engine's shaping drifts a fraction of a percent wider.
  assert(linesNeededPx(MONO, text, 100, 10) === 1, "raw says 1 line");
  assert(linesNeeded(text, { w: 100, h: 999 }, 10, MONO) === 2, "budgeted must say 2");
});

await check("MARGIN makes fits() err toward FALSE at the exact-fit boundary", () => {
  const text = "a".repeat(20); // 100px wide, one 12px line at lh 1.2
  assert(!fits(text, { w: 100, h: 12 }, 10, MONO, 1.2), "exact-fit box must NOT be declared a fit");
  assert(fits(text, { w: 120, h: 20 }, 10, MONO, 1.2), "a box with real slack must fit");
  // Degenerate boxes are never a fit.
  assert(!fits(text, { w: 0, h: 100 }, 10, MONO), "zero width");
  assert(!fits(text, { w: 100, h: 0 }, 10, MONO), "zero height");
  assert(!fits("", { w: 0, h: 0 }, 10, MONO), "zero box");
});

// ── capacityFor ─────────────────────────────────────────────────────────────

const SCALE: TypeScale = { headlinePx: 48, bodyPx: 20, headlineLineHeight: 1.1, bodyLineHeight: 1.5 };

await check("capacityFor: row + headline-row counts follow the margined box", () => {
  const c = capacityFor({ w: 600, h: 300 }, SCALE, MONO);
  // usable = 576 × 288. headline line box = 52.8 → 5. body row = 30 → 9.
  assert(c.maxHeadlineRows === 5, `maxHeadlineRows → ${c.maxHeadlineRows}`);
  assert(c.maxRows === 9, `maxRows → ${c.maxRows}`);
  assert(c.marginApplied === CAPACITY_SAFETY_MARGIN, `marginApplied → ${c.marginApplied}`);
  assert(c.estimated === false, "a Chromium-calibrated budget is not an estimate");
  assert(c.maxDepth >= 1 && c.maxDepth <= MAX_NEST_DEPTH, `maxDepth → ${c.maxDepth}`);
  assert(c.chipsPerRow >= 1 && c.maxChips >= c.chipsPerRow, `chips → ${c.chipsPerRow}/${c.maxChips}`);
  // Capitals are wider, so the ALL-CAPS budget must be strictly smaller. (MONO
  // is uniform-width by construction, so the two coincide there — the real
  // separation is asserted against Chromium in the golden test below.)
  assert(c.headlineCharsUppercase <= c.headlineChars, `caps budget ${c.headlineCharsUppercase} > mixed ${c.headlineChars}`);
});

await check("capacityFor: headlineChars holds for ANY word sequence, not just one", () => {
  const box = { w: 600, h: 300 };
  const c = capacityFor(box, SCALE, MONO);
  assert(c.headlineChars > 0, "must be positive");
  const usable = usableBox(box, MONO);
  // Wrap waste is sequence-dependent, so the budget is only meaningful if it
  // survives sequences the engine has never seen. Five unrelated vocabularies,
  // short to long, all written to EXACTLY the budgeted length.
  const vocabs = [
    ["a", "de", "un", "el", "por", "sin"],
    ["Cada", "marca", "hoy", "más", "señal"],
    ["propio", "video", "crecer", "rápido", "diseño"],
    ["crecimiento", "experiencia", "inmediato", "plataforma"],
    ["extraordinariamente", "internacionalización", "responsabilidades"],
  ];
  for (const words of vocabs) {
    let t = "";
    let i = 0;
    while (t.length < c.headlineChars) t += (t ? " " : "") + words[i++ % words.length];
    t = t.slice(0, c.headlineChars).replace(/[ \t]+$/, "");
    const rows = linesNeededPx(MONO, t, usable.w, SCALE.headlinePx);
    assert(
      rows <= c.maxHeadlineRows,
      `budget of ${c.headlineChars} chars needed ${rows} rows (allowed ${c.maxHeadlineRows}) for ${JSON.stringify(words[0])}-style copy`,
    );
  }
  // And the budget must also fit the RAW, unmargined box — the margin is
  // headroom, not the only thing keeping it honest.
  const plain = "abcde ".repeat(200).slice(0, c.headlineChars).replace(/[ \t]+$/, "");
  assert(
    linesNeededPx(MONO, plain, box.w, SCALE.headlinePx) <= c.maxHeadlineRows,
    "budgeted length must also fit the RAW box",
  );
});

await check("capacityFor: an UNCALIBRATED font yields a smaller, flagged budget", () => {
  const box = { w: 600, h: 300 };
  const good = capacityFor(box, SCALE, MONO);
  const est = capacityFor(box, SCALE, fallbackMetrics("Unknown Display"));
  assert(est.estimated === true, "must flag");
  assert(est.marginApplied === UNCALIBRATED_SAFETY_MARGIN, `marginApplied → ${est.marginApplied}`);
  assert(est.headlineChars < good.headlineChars, `${est.headlineChars} !< ${good.headlineChars}`);
  assert(est.headlineCharsUppercase < good.headlineCharsUppercase, "the caps budget must shrink too");
  assert(est.maxRows <= good.maxRows, `${est.maxRows} !<= ${good.maxRows}`);
  assert(describeCapacity(est).includes("ESTIMATE"), "the instruction must say it is an estimate");
  assert(!describeCapacity(good).includes("ESTIMATE"), "a measured budget must not");
});

await check("capacityFor: degenerate / absurd boxes return an all-zero budget", () => {
  for (const box of [{ w: 0, h: 0 }, { w: -50, h: 100 }, { w: 100, h: 0 }]) {
    const c = capacityFor(box, SCALE, MONO);
    assert(
      c.headlineChars === 0 && c.headlineCharsUppercase === 0 && c.maxRows === 0 && c.maxChips === 0 && c.maxDepth === 0,
      JSON.stringify({ box, c }),
    );
  }
  // A box too short for even one headline line yields no headline budget.
  const tiny = capacityFor({ w: 600, h: 20 }, SCALE, MONO);
  assert(tiny.maxHeadlineRows === 0 && tiny.headlineChars === 0, JSON.stringify(tiny));
});

await check("describeCapacity reads as an instruction an emitter can obey", () => {
  const s = describeCapacity(capacityFor({ w: 600, h: 300 }, SCALE, MONO));
  assert(/holds at most \d+ headline characters/.test(s), s);
  assert(/\d+ if set in ALL CAPS/.test(s), s);
  assert(/Write to fit\./.test(s), s);
});

// ── CHROMIUM GOLDEN: pure-Node prediction vs. what actually paints ──────────
//
// The whole premise is Chromium agreement. Calibrate real fonts in real
// headless Chromium, then compare our browser-free arithmetic against the widths
// and line counts the same engine actually lays out.

type GoldenFont = { family: string; weight: number };
// CSS GENERIC families on purpose: this test must prove Chromium agreement on
// ANY machine (CI runs headless ubuntu, where "Helvetica"/"Georgia" may silently
// substitute). `sans-serif`/`serif`/`monospace` are guaranteed to resolve, and
// guaranteed to resolve to genuinely proportional / genuinely monospaced faces —
// which is exactly what the calibration assertions below check.
const GOLDEN_FONTS: GoldenFont[] = [
  { family: "sans-serif", weight: 400 },
  { family: "sans-serif", weight: 700 },
  { family: "serif", weight: 400 },
  { family: "monospace", weight: 400 },
];

// Deliberately adversarial: ligature candidates (fi/ffl), kern-heavy caps
// (AV/Ta/Wo), Spanish accents + inverted punctuation, digits/percent, curly
// quotes, em-dashes, and a long unbreakable compound.
const GOLDEN_STRINGS = [
  "Cada marca merece su propio video",
  "AVATAR Ta Wo Yo LT PA — kerning bait",
  "efficient affluent office waffle fifty",
  "¿Listo para crecer? ¡Empieza hoy!",
  "Más rápido. Más señal. Menos ruido.",
  "Diseño español: ñ, á, é, í, ó, ú, ü",
  "97% de retención · 24/7 · +1,240 marcas",
  "“Un solo clic” — y el video ya está",
  "auto-servicio inmediato para equipos",
  "supercalifragilisticoexpialidoso",
  "The quick brown fox jumps over the lazy dog",
  "€1.499 / mes — sin permanencia",
];
const GOLDEN_SIZES = [16, 28, 64];

const PAGE_TRUTH = (args: { cases: { text: string; cssFamily: string; weight: number; size: number }[] }) => {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;";
  document.body.appendChild(host);
  const span = document.createElement("span");
  host.appendChild(span);
  const out = args.cases.map((c) => {
    // Plain, DEFAULT text rendering — ligatures and kerning ON, exactly as the
    // scene renders. No measurement-only tweaks; this is ground truth.
    span.style.cssText =
      `display:inline-block;white-space:pre;font-family:${c.cssFamily};` +
      `font-weight:${c.weight};font-size:${c.size}px;`;
    span.textContent = c.text;
    return span.getBoundingClientRect().width;
  });
  host.remove();
  return out;
};

const PAGE_LINES = (args: {
  cases: { text: string; cssFamily: string; weight: number; size: number; w: number; lh: number }[];
}) => {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;";
  document.body.appendChild(host);
  const out = args.cases.map((c) => {
    const d = document.createElement("div");
    d.style.cssText =
      `width:${c.w}px;font-family:${c.cssFamily};font-weight:${c.weight};` +
      `font-size:${c.size}px;line-height:${c.lh};white-space:normal;` +
      `overflow-wrap:normal;word-break:normal;`;
    d.textContent = c.text;
    host.appendChild(d);
    const lines = Math.round(d.getBoundingClientRect().height / (c.size * c.lh));
    d.remove();
    return lines;
  });
  host.remove();
  return out;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: any = null;
try {
  const pw = (await import("playwright")) as unknown as {
    chromium?: typeof import("playwright").chromium;
    default?: { chromium?: typeof import("playwright").chromium };
  };
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (chromium) {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  }
} catch {
  browser = null;
}

if (!page) {
  console.log("  … CHROMIUM GOLDEN skipped (playwright/chromium unavailable — run `npx playwright install chromium`)");
} else {
  const calibrated: { font: GoldenFont; m: FontMetrics }[] = [];
  await check("GOLDEN: Phase A calibrates real fonts in real Chromium", async () => {
    for (const f of GOLDEN_FONTS) {
      const m = await calibrateFont({ family: f.family, weight: f.weight, page });
      assert(m.source === "chromium", `${f.family} ${f.weight} fell back instead of calibrating`);
      assert(Object.keys(m.adv).length >= CALIBRATION_GLYPHS.length - 2, `${f.family}: sparse table`);
      // Accented + typographic glyph coverage is real, not a fallback.
      for (const g of "áéíóúñü¿¡—…€") {
        assert(typeof m.adv[g] === "number" && m.adv[g] > 0, `${f.family}: no measured advance for ${g}`);
      }
      assert(m.fallbackAdv >= m.meanAdv, `${f.family}: fallbackAdv must be ≥ meanAdv`);
      assert(m.normalLineHeight > 0.8 && m.normalLineHeight < 2, `${f.family}: lineHeight ${m.normalLineHeight}`);
      calibrated.push({ font: f, m });
    }
    // A monospace face must measure as one: strong evidence the per-glyph pass
    // is reading real advances rather than a fallback default.
    const mono = calibrated.find((c) => c.font.family === "monospace")!.m;
    const spread = Math.abs(mono.adv["W"] - mono.adv["i"]) / mono.adv["W"];
    assert(spread < 0.02, `the monospace face did not measure monospaced (spread ${(spread * 100).toFixed(1)}%)`);
    // A proportional face must NOT.
    const sans = calibrated.find((c) => c.font.family === "sans-serif")!.m;
    assert(sans.adv["W"] > sans.adv["i"] * 2, "sans-serif must measure proportionally");
    // Weight must actually change the metrics — proof the weight axis is wired.
    const bold = calibrated.find((c) => c.font.family === "sans-serif" && c.font.weight === 700)!.m;
    assert(bold.meanAdv > sans.meanAdv, `bold (${bold.meanAdv.toFixed(2)}) must be wider than regular (${sans.meanAdv.toFixed(2)})`);
  });

  await check(`GOLDEN: pure-Node width agrees with Chromium within ${(CAPACITY_SAFETY_MARGIN * 100).toFixed(0)}%`, async () => {
    const cases: { text: string; cssFamily: string; weight: number; size: number; family: string }[] = [];
    for (const { font } of calibrated) {
      for (const text of GOLDEN_STRINGS) {
        for (const size of GOLDEN_SIZES) {
          cases.push({ text, cssFamily: cssFontFamily(font.family), family: font.family, weight: font.weight, size });
        }
      }
    }
    const actual = (await page.evaluate(PAGE_TRUTH, { cases })) as number[];
    let maxDrift = 0;
    let worst = "";
    let maxUnder = 0; // the DANGEROUS direction: predicted narrower than reality
    let worstUnder = "";
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const m = calibrated.find((x) => x.font.family === c.family && x.font.weight === c.weight)!.m;
      const predicted = textWidth(m, c.text, c.size);
      const drift = (predicted - actual[i]) / actual[i];
      if (Math.abs(drift) > maxDrift) {
        maxDrift = Math.abs(drift);
        worst = `${c.family} ${c.weight} @${c.size}px ${JSON.stringify(c.text.slice(0, 32))} predicted ${predicted.toFixed(2)} actual ${actual[i].toFixed(2)}`;
      }
      if (-drift > maxUnder) {
        maxUnder = -drift;
        worstUnder = `${c.family} ${c.weight} @${c.size}px ${JSON.stringify(c.text.slice(0, 32))}`;
      }
    }
    console.log(`      max |drift| ${(maxDrift * 100).toFixed(3)}% over ${cases.length} measurements — ${worst}`);
    console.log(`      max UNDER-prediction ${(maxUnder * 100).toFixed(3)}%${worstUnder ? ` — ${worstUnder}` : ""}`);
    assert(
      maxDrift <= CAPACITY_SAFETY_MARGIN,
      `max drift ${(maxDrift * 100).toFixed(3)}% exceeds the ${(CAPACITY_SAFETY_MARGIN * 100).toFixed(0)}% margin — ${worst}`,
    );
  });

  await check("GOLDEN: budgeted line counts never UNDER-count what Chromium lays out", async () => {
    const lh = 1.3;
    const cases: { text: string; cssFamily: string; weight: number; size: number; w: number; lh: number; family: string }[] = [];
    for (const { font } of calibrated) {
      for (const text of GOLDEN_STRINGS) {
        for (const w of [180, 320, 640]) {
          cases.push({ text, cssFamily: cssFontFamily(font.family), family: font.family, weight: font.weight, size: 28, w, lh });
        }
      }
    }
    const actual = (await page.evaluate(PAGE_LINES, { cases })) as number[];
    const misses: string[] = [];
    let exact = 0;
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const m = calibrated.find((x) => x.font.family === c.family && x.font.weight === c.weight)!.m;
      const predicted = linesNeededPx(m, c.text, c.w * (1 - CAPACITY_SAFETY_MARGIN), c.size);
      if (predicted === actual[i]) exact++;
      // Predicting MORE lines than reality is the safe direction (under-fill).
      // Predicting fewer is the defect this whole engine exists to prevent.
      if (predicted < actual[i]) {
        misses.push(`${c.family} ${c.weight} w=${c.w} ${JSON.stringify(c.text.slice(0, 28))}: predicted ${predicted} < actual ${actual[i]}`);
      }
    }
    console.log(`      ${exact}/${cases.length} line counts exact, 0 under-counts required`);
    assert(misses.length === 0, `under-counted ${misses.length} case(s):\n      ${misses.slice(0, 5).join("\n      ")}`);
  });

  await check("GOLDEN: fits()===true implies Chromium does NOT overflow the box", async () => {
    const lh = 1.3;
    const size = 28;
    const boxes = [
      { w: 200, h: 60 }, { w: 200, h: 160 }, { w: 340, h: 80 },
      { w: 340, h: 200 }, { w: 700, h: 45 }, { w: 700, h: 130 },
    ];
    const cases: { text: string; cssFamily: string; weight: number; size: number; w: number; lh: number }[] = [];
    const meta: { m: FontMetrics; box: { w: number; h: number }; text: string; family: string }[] = [];
    for (const { font, m } of calibrated) {
      for (const text of GOLDEN_STRINGS) {
        for (const box of boxes) {
          cases.push({ text, cssFamily: cssFontFamily(font.family), weight: font.weight, size, w: box.w, lh });
          meta.push({ m, box, text, family: `${font.family} ${font.weight}` });
        }
      }
    }
    const actualLines = (await page.evaluate(PAGE_LINES, { cases })) as number[];
    let claimedFit = 0;
    const violations: string[] = [];
    for (let i = 0; i < meta.length; i++) {
      const { m, box, text, family } = meta[i];
      if (!fits(text, box, size, m, lh)) continue;
      claimedFit++;
      const realHeight = actualLines[i] * size * lh;
      if (realHeight > box.h + 0.5) {
        violations.push(`${family} ${JSON.stringify(text.slice(0, 24))} in ${box.w}×${box.h}: fits() said yes but paints ${realHeight.toFixed(1)}px`);
      }
    }
    console.log(`      ${claimedFit}/${meta.length} cases claimed a fit; ${violations.length} overflowed`);
    assert(claimedFit > 0, "the fixture proved nothing — no case claimed a fit");
    assert(violations.length === 0, `fits() lied on ${violations.length} case(s):\n      ${violations.slice(0, 5).join("\n      ")}`);
  });

  await check("GOLDEN: a capacityFor budget, written to the letter, actually fits in Chromium", async () => {
    const scale: TypeScale = { headlinePx: 56, bodyPx: 22, headlineLineHeight: 1.1, bodyLineHeight: 1.5 };
    const box = { w: 760, h: 340 };
    // Vocabularies the budget engine has never seen, short to long. A budget
    // that only holds for its own filler is worthless to a blind emitter.
    const VOCABS = [
      ["Cada", "marca", "merece", "señal", "propia", "más", "clara", "hoy"],
      ["Ship", "your", "brand", "story", "as", "video", "in", "minutes", "not", "weeks"],
      ["crecimiento", "experiencia", "inmediato", "automático", "resultados"],
      ["AUTOMATIZA", "TU", "MARCA", "AHORA", "MISMO"],
    ];
    const cases: { text: string; cssFamily: string; weight: number; size: number; w: number; lh: number }[] = [];
    const meta: { budgetChars: number; rows: number; family: string; vocab: string }[] = [];
    for (const { font, m } of calibrated) {
      const c = capacityFor(box, scale, m);
      for (const words of VOCABS) {
        // All-caps copy is budgeted by the ALL-CAPS number — the whole point of
        // it existing. Using headlineChars here overflowed by 2–3 lines.
        const isCaps = words.every((w) => w === w.toUpperCase());
        const budget = isCaps ? c.headlineCharsUppercase : c.headlineChars;
        let text = "";
        let i = 0;
        while (text.length < budget) text += (text ? " " : "") + words[i++ % words.length];
        text = text.slice(0, budget).replace(/[ \t]+$/, "");
        cases.push({ text, cssFamily: cssFontFamily(font.family), weight: font.weight, size: scale.headlinePx, w: box.w, lh: 1.1 });
        meta.push({ budgetChars: budget, rows: c.maxHeadlineRows, family: `${font.family} ${font.weight}`, vocab: isCaps ? "ALLCAPS" : words[0] });
      }
    }
    const actualLines = (await page.evaluate(PAGE_LINES, { cases })) as number[];
    const violations: string[] = [];
    for (let i = 0; i < meta.length; i++) {
      const { budgetChars, rows, family, vocab } = meta[i];
      assert(budgetChars > 10, `${family}: implausible budget of ${budgetChars} chars`);
      const painted = actualLines[i] * scale.headlinePx * 1.1;
      if (actualLines[i] > rows || painted > box.h) {
        violations.push(`${family} / ${vocab}-style: ${budgetChars} chars wrapped to ${actualLines[i]} lines (budget ${rows}), painting ${painted.toFixed(0)}px into ${box.h}px`);
      }
    }
    // The caps budget must actually be TIGHTER on real proportional fonts —
    // otherwise it is decoration, not a safeguard.
    for (const { font, m } of calibrated) {
      if (font.family === "monospace") continue;
      const c = capacityFor(box, scale, m);
      assert(
        c.headlineCharsUppercase < c.headlineChars,
        `${font.family} ${font.weight}: caps budget ${c.headlineCharsUppercase} must be tighter than mixed ${c.headlineChars}`,
      );
    }
    const budgets = Array.from(new Set(meta.map((x) => `${x.family}=${x.budgetChars}ch/${x.rows}L`)));
    console.log(`      ${meta.length} budget×vocabulary combinations, ${violations.length} overflowed — ${budgets.join(", ")}`);
    assert(violations.length === 0, `budget overflowed:\n      ${violations.slice(0, 5).join("\n      ")}`);
  });

  await browser.close().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
