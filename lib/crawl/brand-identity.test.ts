/**
 * Regression tests for pickSignatureColor (QA finding C1).
 *
 * Run: `npm test`. Locks the fix for the brand-fidelity failure where the
 * design agent led with the dark/neutral that covered the most pixels (Fuse
 * maroon, Tony's brown) instead of the brand's actual hue (Fuse blue, Tony's
 * red). No API key, no network.
 */
import { pickSignatureColor } from "./brand-identity";

// Real palettes captured from the QA sweep.
const FUSE = ["#440b12", "#2c060b", "#5e131c", "#ff8c42", "#ecf3fb", "#1e5fb8"];
const TONYS = ["#eb0000", "#006be1", "#ffed00", "#ff7400"];
const MONO = ["#000000", "#fdfdfd", "#b8b8b8", "#d7d7d7", "#979797"]; // Liquid Death

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

// ── The bug: leading with the dark neutral instead of the brand hue ──────
check("Fuse → the blue brand hue, NOT the dark maroon", () => {
  const sig = pickSignatureColor(FUSE);
  assert(sig === "#1e5fb8", `expected #1e5fb8, got ${sig}`);
});

check("Fuse → never a near-black/deep-shade neutral", () => {
  const sig = pickSignatureColor(FUSE);
  assert(
    sig !== null && !["#440b12", "#2c060b", "#5e131c"].includes(sig),
    `got a dark neutral: ${sig}`,
  );
});

// ── theme_color is the most authoritative signal ─────────────────────────
check("chromatic theme_color wins (Tony's red)", () => {
  const sig = pickSignatureColor(TONYS, "#eb0000");
  assert(sig === "#eb0000", `expected #eb0000, got ${sig}`);
});

check("a NEUTRAL theme_color is ignored → falls back to a vivid palette hue", () => {
  const sig = pickSignatureColor(FUSE, "#000000");
  assert(sig === "#1e5fb8", `expected #1e5fb8, got ${sig}`);
});

// ── Monochrome brands keep their monochrome (never invent a color) ────────
check("monochrome brand (Liquid Death) → null", () => {
  assert(pickSignatureColor(MONO) === null, "expected null for greyscale palette");
});

// ── Even the imperfect fallback beats a brown neutral ────────────────────
check("Tony's without theme_color → a vivid chromatic color, not brown", () => {
  const sig = pickSignatureColor(TONYS);
  assert(sig !== null, "should pick a color");
  assert(
    ["#ff7400", "#eb0000", "#006be1"].includes(sig as string),
    `expected a saturated brand color, got ${sig}`,
  );
});

// ── Degenerate inputs ────────────────────────────────────────────────────
check("empty / garbage palette → null", () => {
  assert(pickSignatureColor([]) === null, "empty → null");
  assert(pickSignatureColor(["not-a-color", "#zzz"]) === null, "garbage → null");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
