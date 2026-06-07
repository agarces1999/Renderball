/**
 * Regression tests for findDuplicatedEyebrows (QA B3).
 *
 * Run: `npm test`. Locks the detector for the eyebrow/kicker duplication where
 * the per-scene editorial tag is echoed in the BrandChrome pill AND rendered as
 * the headline kicker (Coniglio "COMIENZA EL DÍA", Stripe "THE CHALLENGE").
 * No API key, no network.
 */
import {
  findDuplicatedEyebrows,
  findDecorativeFillerIcons,
} from "./quality-gates";

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

// The bug: eyebrow echoed in the chrome pill AND as the kicker.
const DUP = `
  <BrandChrome category="THE CHALLENGE" sceneIndex={1} totalScenes={5} />
  <h6 className="eyebrow">— THE CHALLENGE</h6>
  <h1>Payments for the internet</h1>`;
// Clean: chrome carries a stable label, eyebrow appears once (kicker only).
const CLEAN = `
  <BrandChrome category="LAUNCH · 2026" sceneIndex={1} totalScenes={5} />
  <h6 className="eyebrow">— THE CHALLENGE</h6>
  <h1>Payments for the internet</h1>`;

check("flags an eyebrow echoed in chrome + kicker", () => {
  const dup = findDuplicatedEyebrows(DUP, ["THE CHALLENGE"]);
  assert(dup.includes("THE CHALLENGE"), `expected flag, got ${JSON.stringify(dup)}`);
});

check("clean — eyebrow appears once (kicker only) → no flag", () => {
  const dup = findDuplicatedEyebrows(CLEAN, ["THE CHALLENGE"]);
  assert(dup.length === 0, `expected none, got ${JSON.stringify(dup)}`);
});

check("case-insensitive + dash-prefix tolerant", () => {
  const code = `<span>the challenge</span><div>— The Challenge</div>`;
  const dup = findDuplicatedEyebrows(code, ["THE CHALLENGE"]);
  assert(dup.includes("THE CHALLENGE"), "should match across case + dash prefix");
});

check("ignores trivial / empty eyebrows", () => {
  assert(findDuplicatedEyebrows("AA AA", ["AA"]).length === 0, "short skipped");
  assert(findDuplicatedEyebrows("x x x", [""]).length === 0, "empty skipped");
});

check("multiple scenes — only the duplicated tag is flagged", () => {
  const code = `<span>THE TURN</span> ... <span>THE PROOF</span><div>THE PROOF</div>`;
  const dup = findDuplicatedEyebrows(code, ["THE TURN", "THE PROOF"]);
  assert(
    !dup.includes("THE TURN") && dup.includes("THE PROOF"),
    `got ${JSON.stringify(dup)}`,
  );
});

// ── D4: generic decorative-filler icons (Sparkles/Sparkle) ───────────
check("flags Sparkles + Sparkle filler icons", () => {
  const code = `<Sparkles size={12} /> ... <Sparkle /> ... <Check />`;
  assert(findDecorativeFillerIcons(code) === 2, "should count both shine icons");
});
check("does not flag literal icons (Check / Lock / Zap)", () => {
  const code = `<Check /><Lock /><Zap /><Leaf /><Recycle />`;
  assert(findDecorativeFillerIcons(code) === 0, "literal icons are fine");
});
check("does not match a longer identifier that starts with Sparkle", () => {
  // \\b guards against <SparkleField> etc.
  assert(findDecorativeFillerIcons("<SparkleField />") === 0, "no false match");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
