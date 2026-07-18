/**
 * Tests for the Chromium-calibrated font metrics engine (Phase B arithmetic +
 * persistence + the never-silently-under-estimate contract).
 *
 * Run: `node scripts/run-tests.mjs lib/render/font-metrics.test.ts`
 *
 * The Chromium GOLDEN test (Phase A vs. real rendered widths) lives in
 * capacity.test.ts, next to the margin it validates.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  CALIBRATION_GLYPHS,
  KERN_PAIRS,
  UNCALIBRATED_ADVANCE_100,
  DEFAULT_NORMAL_LINE_HEIGHT,
  type FontMetrics,
  fallbackMetrics,
  measureText,
  textWidth,
  metricsKey,
  saveFontMetrics,
  loadFontMetrics,
  getFontMetrics,
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
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/** A synthetic calibrated font: whatever advances the test needs. */
const synth = (adv: Record<string, number>, over: Partial<FontMetrics> = {}): FontMetrics => ({
  family: "Synth",
  weight: 400,
  adv,
  kern: {},
  meanAdv: 50,
  fallbackAdv: 70,
  normalLineHeight: 1.2,
  source: "chromium",
  calibratedAt: new Date().toISOString(),
  ...over,
});

// ── Phase B arithmetic ──────────────────────────────────────────────────────

await check("advance-sum: width = Σ adv100[c] · size/100", () => {
  const m = synth({ A: 50, B: 100, C: 25 });
  assert(near(textWidth(m, "AB", 100), 150), `AB@100 → ${textWidth(m, "AB", 100)}`);
  assert(near(textWidth(m, "AB", 200), 300), `AB@200 → ${textWidth(m, "AB", 200)}`);
  assert(near(textWidth(m, "ABC", 50), 87.5), `ABC@50 → ${textWidth(m, "ABC", 50)}`);
  assert(near(textWidth(m, "", 100), 0), "empty string is 0");
});

await check("advance-sum scales strictly linearly in size", () => {
  const m = synth({ x: 37 });
  const s = "xxxxxxx";
  for (const size of [8, 12, 48, 220]) {
    assert(near(textWidth(m, s, size), 7 * 37 * (size / 100), 1e-9), `size ${size}`);
  }
});

await check("kern deltas are applied to sampled pairs only", () => {
  const m = synth({ A: 50, V: 50 }, { kern: { AV: -8 } });
  // AV picks up the delta; VA (unsampled) does not — assuming 0 over-estimates,
  // which is the safe direction.
  assert(near(textWidth(m, "AV", 100), 92), `AV → ${textWidth(m, "AV", 100)}`);
  assert(near(textWidth(m, "VA", 100), 100), `VA → ${textWidth(m, "VA", 100)}`);
  // The delta applies once per adjacency, not once per string.
  assert(near(textWidth(m, "AVAV", 100), 200 - 16), `AVAV → ${textWidth(m, "AVAV", 100)}`);
});

// ── the never-under-estimate contract ───────────────────────────────────────

await check("uncalibrated GLYPH uses the wide fallback advance and FLAGS", () => {
  const m = synth({ a: 30 }, { fallbackAdv: 90 });
  const r = measureText(m, "a☃a", 100);
  assert(near(r.width, 30 + 90 + 30), `width → ${r.width}`);
  assert(r.uncalibratedChars === 1, `uncalibratedChars → ${r.uncalibratedChars}`);
  assert(r.fallbackUsed, "an uncalibrated glyph must set fallbackUsed");
  // Fully-calibrated text on the same metrics must NOT flag.
  assert(!measureText(m, "aaa", 100).fallbackUsed, "clean text must not flag");
});

await check("fallback advance is WIDER than the mean — never under-estimates", () => {
  const m = synth({ a: 30, b: 40, c: 50 }, { meanAdv: 40, fallbackAdv: 50 });
  assert(m.fallbackAdv >= m.meanAdv, "fallbackAdv must be ≥ meanAdv");
  // An unknown glyph must cost at least as much as the widest typical one.
  assert(textWidth(m, "?", 100) >= textWidth(m, "b", 100), "unknown glyph ≥ mean glyph");
});

await check("uncalibrated FONT flags every measurement and is conservatively wide", () => {
  const m = fallbackMetrics("NeverSeenDisplay", 700);
  assert(m.source === "fallback", "source must be 'fallback'");
  assert(m.normalLineHeight === DEFAULT_NORMAL_LINE_HEIGHT, "carries a default line-height");
  const r = measureText(m, "Hola mundo", 100);
  assert(r.fallbackUsed, "uncalibrated font must always flag");
  assert(near(r.width, 10 * UNCALIBRATED_ADVANCE_100), `width → ${r.width}`);
  // 0.62em is above the mixed-case mean of every UI sans we ship (~0.50–0.55em),
  // so a blind budget on an unknown font under-fills rather than overflows.
  assert(UNCALIBRATED_ADVANCE_100 >= 58, `UNCALIBRATED_ADVANCE_100 too narrow: ${UNCALIBRATED_ADVANCE_100}`);
  // Empty string still reports the flag — the caller must know it is estimating.
  assert(measureText(m, "", 100).fallbackUsed, "empty string on a fallback font still flags");
});

await check("code-point iteration: an astral glyph costs ONE fallback advance", () => {
  const m = synth({ a: 30 }, { fallbackAdv: 90 });
  const r = measureText(m, "a🎬a", 100); // surrogate pair
  assert(r.uncalibratedChars === 1, `astral char counted ${r.uncalibratedChars} times (want 1)`);
  assert(near(r.width, 150), `width → ${r.width}`);
});

// ── calibration set coverage ────────────────────────────────────────────────

await check("calibration set covers ASCII + the accented Latin glyphs we ship", () => {
  const set = new Set(CALIBRATION_GLYPHS);
  for (let c = 0x20; c <= 0x7e; c++) {
    assert(set.has(String.fromCharCode(c)), `missing ASCII ${JSON.stringify(String.fromCharCode(c))}`);
  }
  // Spanish is generated copy, not a nicety — these are load-bearing.
  for (const g of "áéíóúüñÁÉÍÓÚÜÑ¿¡") assert(set.has(g), `missing Spanish glyph ${g}`);
  // Other crawled-brand Latin.
  for (const g of "çÇàèìòùâêîôûãõäëïöß") assert(set.has(g), `missing Latin glyph ${g}`);
  // Typographic punctuation the script generator actually emits.
  for (const g of "—–‘’“”…•€£°™®✓→") assert(set.has(g), `missing typographic glyph ${g}`);
  assert(set.size >= 180 && set.size <= 260, `calibration set size ${set.size} outside the ~200 target`);
  assert(set.size === CALIBRATION_GLYPHS.length, "calibration set must be deduped");
});

await check("kern-pair sample is a real sample of 2-char pairs over the calibrated set", () => {
  const set = new Set(CALIBRATION_GLYPHS);
  assert(KERN_PAIRS.length >= 100, `kern sample too small: ${KERN_PAIRS.length}`);
  assert(KERN_PAIRS.length <= 500, `kern sample too large to cache: ${KERN_PAIRS.length}`);
  assert(new Set(KERN_PAIRS).size === KERN_PAIRS.length, "kern pairs must be deduped");
  for (const p of KERN_PAIRS) {
    assert(Array.from(p).length === 2, `not a 2-char pair: ${JSON.stringify(p)}`);
    for (const c of p) assert(set.has(c), `kern pair ${p} uses uncalibrated glyph ${c}`);
  }
  // The classic diagonals must be in the sample or the model misses most delta.
  for (const p of ["AV", "Ta", "Wa", "Yo", "r.", "1."]) {
    assert(KERN_PAIRS.includes(p), `kern sample missing ${p}`);
  }
});

// ── persistence ─────────────────────────────────────────────────────────────

await check("metricsKey is filesystem-safe and weight-scoped", () => {
  assert(metricsKey("Cabinet Grotesk", 700) === "cabinet-grotesk-700", metricsKey("Cabinet Grotesk", 700));
  assert(metricsKey("  F37 Bolton!! ", 400) === "f37-bolton-400", metricsKey("  F37 Bolton!! ", 400));
  assert(metricsKey("Inter") !== metricsKey("Inter", 700), "weight must scope the key");
  assert(!/[^a-z0-9-]/.test(metricsKey("Söhne / Buch", 300)), metricsKey("Söhne / Buch", 300));
});

const tmp = path.join(os.tmpdir(), `rb-fontmetrics-${process.pid}`);

await check("save → load roundtrip preserves the table", async () => {
  const m = synth({ A: 51.25, á: 47.5 }, { family: "Test Face", weight: 600, kern: { AV: -3.5 } });
  const file = await saveFontMetrics(m, tmp);
  assert(file.endsWith("test-face-600.json"), file);
  const back = await loadFontMetrics("Test Face", 600, tmp);
  assert(back !== null, "roundtrip returned null");
  assert(near(back!.adv["á"], 47.5), `á → ${back!.adv["á"]}`);
  assert(near(back!.kern["AV"], -3.5), `AV → ${back!.kern["AV"]}`);
  assert(back!.source === "chromium", "source survived");
});

await check("missing / corrupt cache degrades to null, never throws", async () => {
  assert((await loadFontMetrics("Nope", 400, tmp)) === null, "missing → null");
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, "broken-400.json"), "{not json", "utf8");
  assert((await loadFontMetrics("Broken", 400, tmp)) === null, "corrupt → null");
  // A shape-valid but table-less file is also rejected — it would read as
  // "every glyph is 0px wide", the worst possible under-estimate.
  await fs.writeFile(path.join(tmp, "hollow-400.json"), JSON.stringify({ adv: null }), "utf8");
  assert((await loadFontMetrics("Hollow", 400, tmp)) === null, "hollow → null");
  await fs.writeFile(path.join(tmp, "nofb-400.json"), JSON.stringify({ adv: { a: 10 } }), "utf8");
  assert((await loadFontMetrics("Nofb", 400, tmp)) === null, "missing fallbackAdv → null");
});

await check("getFontMetrics always returns usable metrics, flagged when uncached", async () => {
  const m = await getFontMetrics("Definitely Not Cached", 400, tmp);
  assert(m.source === "fallback", `source → ${m.source}`);
  assert(measureText(m, "abc", 100).fallbackUsed, "must flag");
});

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
