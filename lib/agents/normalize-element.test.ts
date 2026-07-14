/**
 * Tests for the hue-locking normalizer — the architecture-level brand-color
 * guarantee. The policy under test: neutrals pass; brand-hue tints/shades
 * pass; foreign chromatic hues get hue-snapped keeping their own S/L/alpha.
 * The motivating defect: two builds this week shipped scenes with the brand
 * orange entirely absent ("palette is muted earth tones").
 */
import { normalizeElementColors, lockColor, brandHues, hexToRgb, rgbToHsl } from "./normalize-element";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("normalize-element (hue-locking)");

// HubSpot-ish palette: orange signature + navy + neutrals.
const PALETTE = ["#ff7a59", "#213343", "#ffffff", "#0b0e13", "#f5f8fa"];

check("brandHues extracts chromatic hues only (neutrals carry no hue identity)", () => {
  const hues = brandHues(PALETTE);
  assert(hues.length === 2, `expected 2 chromatic hues (orange + navy), got ${hues.length}: ${hues}`);
});

check("neutrals pass through untouched (whites, grays, near-blacks)", () => {
  for (const c of ["#ffffff", "#888888", "#0b0e13", "#f0f0f2"]) {
    assert(lockColor(c, brandHues(PALETTE)) === null, `${c} is neutral — must be allowed`);
  }
});

check("tints/shades of the brand hue pass (gradients and glows survive)", () => {
  // Lighter and darker oranges near the brand hue.
  for (const c of ["#ff9b80", "#cc5233", "#ffe3db"]) {
    const r = lockColor(c, brandHues(PALETTE));
    assert(r === null, `${c} is a brand-hue tint/shade — must be allowed, got ${r}`);
  }
});

check("a FOREIGN hue gets snapped to the nearest brand hue, keeping its own S/L", () => {
  const teal = "#2dd4bf"; // saturated teal — no business on a HubSpot canvas
  const out = lockColor(teal, brandHues(PALETTE));
  assert(out !== null, "foreign hue must be rewritten");
  const [r, g, b] = hexToRgb(out!)!;
  const hsl = rgbToHsl(r, g, b);
  const before = rgbToHsl(...hexToRgb(teal)!);
  assert(Math.abs(hsl.l - before.l) < 0.02, "lightness preserved (weight of the element unchanged)");
  assert(Math.abs(hsl.s - before.s) < 0.02, "saturation preserved");
});

check("all-neutral brand ⇒ chromatic colors are desaturated (no invented hue)", () => {
  const out = lockColor("#ff0000", brandHues(["#111111", "#ffffff", "#999999"]));
  assert(out !== null, "chromatic on a neutral brand must be rewritten");
  const [r, g, b] = hexToRgb(out!)!;
  assert(r === g && g === b, `expected grayscale, got ${out}`);
});

check("normalizeElementColors rewrites hex AND rgba() in real TSX, counts changes", () => {
  const code = `
    <div style={{ background: "#14b8a6", color: "#ffffff" }}>
      <span style={{ boxShadow: "0 0 40px rgba(20, 184, 166, 0.5)" }}>x</span>
      <svg><rect fill="#ff7a59" /><circle fill="#7c3aed" /></svg>
    </div>`;
  const { code: out, changes } = normalizeElementColors(code, PALETTE);
  assert(!/#14b8a6/i.test(out), "foreign teal hex rewritten");
  assert(!/#7c3aed/i.test(out), "foreign violet SVG fill rewritten");
  assert(/#ff7a59/i.test(out), "brand orange untouched");
  assert(/#ffffff/i.test(out), "white untouched");
  assert(/rgba\(\d+, \d+, \d+, 0\.5\)/.test(out), "rgba alpha preserved through the rewrite");
  assert(!/rgba\(20, 184, 166/.test(out), "rgba teal rewritten");
  assert(changes.length === 3, `3 distinct rewrites expected, got ${changes.length}`);
});

check("data-URIs are shielded (base64 bodies never rewritten)", () => {
  // Green is genuinely foreign to the orange/navy brand (red would pass as
  // orange-family within the hue tolerance — that's policy, not a bug).
  const uri = "data:image/png;base64," + "aAbB0#00ff00zZ".repeat(10);
  const code = `<Img src="${uri}" style={{ borderColor: "#00ff00" }} />`;
  const { code: out } = normalizeElementColors(code, PALETTE);
  assert(out.includes(uri), "data-URI must be byte-identical");
  assert(!/borderColor: "#00ff00"/.test(out), "the real style color IS rewritten");
});

check("idempotent: normalizing twice equals normalizing once", () => {
  const code = `<div style={{ background: "#14b8a6" }} />`;
  const once = normalizeElementColors(code, PALETTE).code;
  const twice = normalizeElementColors(once, PALETTE).code;
  assert(once === twice, "second pass must be a no-op");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
