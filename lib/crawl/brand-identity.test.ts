/**
 * Regression tests for pickSignatureColor (QA finding C1).
 *
 * Run: `npm test`. Locks the fix for the brand-fidelity failure where the
 * design agent led with the dark/neutral that covered the most pixels (Fuse
 * maroon, Tony's brown) instead of the brand's actual hue (Fuse blue, Tony's
 * red). No API key, no network.
 */
import {
  pickSignatureColor,
  dominantSvgColor,
  signatureWithLogoFallback,
  genericFor,
} from "./brand-identity";

// Real palettes captured from the QA sweep.
const FUSE = ["#440b12", "#2c060b", "#5e131c", "#ff8c42", "#ecf3fb", "#1e5fb8"];
const TONYS = ["#eb0000", "#006be1", "#ffed00", "#ff7400"];
const MONO = ["#000000", "#fdfdfd", "#b8b8b8", "#d7d7d7", "#979797"]; // Liquid Death
// corgi.insure: a Webflow site whose crawl returned only greys — the brand's
// orange survived nowhere but the logo SVG (QA G1).
const CORGI_GREYS = ["#f6f6f6", "#e8e8e8", "#c7c7c7", "#6b6b6b", "#1c1c1e"];

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

// ── G1: dominantSvgColor — pull the brand hue out of the logo markup ──────
const CORGI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">
  <path fill="#f47b20" d="M10 8h22v22H10z"/>
  <text fill="#1c1c1e" x="40" y="26">corgi</text>
</svg>`;
const MONO_SVG = `<svg viewBox="0 0 100 40"><path fill="#1c1c1e" d="M0 0h10v10H0z"/><rect fill="#ffffff" x="20" width="10" height="10"/></svg>`;
const RGB_SVG = `<svg><defs><linearGradient><stop stop-color="rgb(0, 122, 255)"/></linearGradient></defs><rect fill="#000000"/></svg>`;
const HEX3_SVG = `<svg><path fill="#f60"/><text fill="#111">x</text></svg>`; // #f60 → #ff6600

check("corgi logo SVG → the orange mark, NOT the near-black text", () => {
  assert(dominantSvgColor(CORGI_SVG) === "#f47b20", `expected #f47b20, got ${dominantSvgColor(CORGI_SVG)}`);
});

check("monochrome logo SVG (black + white only) → null", () => {
  assert(dominantSvgColor(MONO_SVG) === null, `expected null, got ${dominantSvgColor(MONO_SVG)}`);
});

check("rgb() stop-color is parsed → #007aff", () => {
  assert(dominantSvgColor(RGB_SVG) === "#007aff", `expected #007aff, got ${dominantSvgColor(RGB_SVG)}`);
});

check("3-digit hex is expanded → #ff6600", () => {
  assert(dominantSvgColor(HEX3_SVG) === "#ff6600", `expected #ff6600, got ${dominantSvgColor(HEX3_SVG)}`);
});

check("empty / colorless SVG → null", () => {
  assert(dominantSvgColor("") === null, "empty → null");
  assert(dominantSvgColor("<svg><rect/></svg>") === null, "no colors → null");
});

// ── G1: signatureWithLogoFallback — palette wins, logo is the fallback ─────
check("achromatic palette + orange logo → the logo orange (corgi)", () => {
  const sig = signatureWithLogoFallback(CORGI_GREYS, undefined, "#f47b20");
  assert(sig === "#f47b20", `expected #f47b20, got ${sig}`);
});

check("chromatic palette wins over the logo color (palette is authoritative)", () => {
  const sig = signatureWithLogoFallback(FUSE, undefined, "#f47b20");
  assert(sig === "#1e5fb8", `expected the palette blue #1e5fb8, got ${sig}`);
});

check("monochrome brand with no logo color → null (never invent)", () => {
  assert(signatureWithLogoFallback(MONO, undefined, undefined) === null, "expected null");
});

check("a grey/neutral logo color is NOT a valid fallback → null", () => {
  assert(signatureWithLogoFallback(MONO, undefined, "#cccccc") === null, "grey logo → null");
  assert(signatureWithLogoFallback(MONO, undefined, "not-a-hex") === null, "garbage logo → null");
});

// ── genericFor — the CSS generic fallback per font family (corgi bug) ─────
// f37Bolton is a grotesque SANS; the design agent shipped `'"f37Bolton", serif'`
// so when the cross-origin web font failed to load the headline fell back to a
// SERIF. genericFor is the single source of truth — a sans must degrade to
// `sans-serif`, a text serif to `serif`, a code face to `monospace`.
check("f37Bolton (grotesque sans) → sans-serif, NOT serif", () => {
  assert(genericFor("f37Bolton") === "sans-serif", `got ${genericFor("f37Bolton")}`);
});
check("Geist → sans-serif", () => {
  assert(genericFor("Geist") === "sans-serif", `got ${genericFor("Geist")}`);
});
check("Geist Mono → monospace", () => {
  assert(genericFor("Geist Mono") === "monospace", `got ${genericFor("Geist Mono")}`);
});
check("Inter → sans-serif", () => {
  assert(genericFor("Inter") === "sans-serif", `got ${genericFor("Inter")}`);
});
check("Montserrat (no style signal) → sans-serif, never serif by default", () => {
  // Display faces are overwhelmingly sans; defaulting an unknown to serif is
  // exactly the bug. The classifier must land on sans-serif here.
  assert(genericFor("Montserrat") === "sans-serif", `got ${genericFor("Montserrat")}`);
});
check("Playfair Display → serif", () => {
  assert(genericFor("Playfair Display") === "serif", `got ${genericFor("Playfair Display")}`);
});
check("Tiempos Text → serif", () => {
  assert(genericFor("Tiempos Text") === "serif", `got ${genericFor("Tiempos Text")}`);
});
check("Fraunces → serif", () => {
  assert(genericFor("Fraunces") === "serif", `got ${genericFor("Fraunces")}`);
});
check("JetBrains Mono → monospace", () => {
  assert(genericFor("JetBrains Mono") === "monospace", `got ${genericFor("JetBrains Mono")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
