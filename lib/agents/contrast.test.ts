/**
 * Regression tests for the WCAG contrast primitives + B1 severity threshold.
 *
 * Run: `npm test`. Locks the math behind the B1 gate (severe <3:1 contrast →
 * blocking) so e.g. the Fuse 2.1:1 white-on-orange pair is classified severe.
 * No API key, no network.
 */
import {
  contrastRatio,
  luminance,
  MIN_CONTRAST_RATIO,
  SEVERE_CONTRAST_RATIO,
} from "./contrast";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

check("thresholds are the documented values", () => {
  assert(MIN_CONTRAST_RATIO === 4.5, `MIN=${MIN_CONTRAST_RATIO}`);
  assert(SEVERE_CONTRAST_RATIO === 3.0, `SEVERE=${SEVERE_CONTRAST_RATIO}`);
});

check("white on dark navy is highly readable (>7:1)", () => {
  const r = contrastRatio("#ffffff", "#0c2941");
  assert(r > 7, `expected >7, got ${r.toFixed(2)}`);
});

check("the Fuse failure — light tint on orange — is SEVERE (<3:1)", () => {
  const r = contrastRatio("#ecf3fb", "#ff8c42");
  assert(r < SEVERE_CONTRAST_RATIO, `expected <3, got ${r.toFixed(2)}`);
});

check("accent-on-primary (cyan on navy ≈3:1) is MINOR, not severe", () => {
  // ~3.05:1 — borderline-readable for large headlines, so it's flagged by the
  // soft <4.5 gate but does NOT trip the severe (<3:1) blocking tier.
  const r = contrastRatio("#0072ce", "#0c2941");
  assert(
    r >= SEVERE_CONTRAST_RATIO && r < MIN_CONTRAST_RATIO,
    `expected the 3.0–4.5 minor band, got ${r.toFixed(2)}`,
  );
});

check("a real body pair clears the 4.5 floor", () => {
  const r = contrastRatio("#0c2941", "#ffffff");
  assert(r >= MIN_CONTRAST_RATIO, `expected >=4.5, got ${r.toFixed(2)}`);
});

check("contrast ratio is symmetric (fg/bg order doesn't matter)", () => {
  const a = contrastRatio("#123456", "#abcdef");
  const b = contrastRatio("#abcdef", "#123456");
  assert(Math.abs(a - b) < 1e-9, `asymmetric: ${a} vs ${b}`);
});

check("identical colors → 1:1, which is severe", () => {
  const r = contrastRatio("#3898ec", "#3898ec");
  assert(
    Math.abs(r - 1) < 1e-9 && r < SEVERE_CONTRAST_RATIO,
    `expected 1, got ${r}`,
  );
});

check("luminance bounds: black ≈ 0, white ≈ 1", () => {
  assert(luminance("#000000") < 0.01, "black should be ~0");
  assert(luminance("#ffffff") > 0.99, "white should be ~1");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
