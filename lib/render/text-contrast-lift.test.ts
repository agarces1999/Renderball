//
// Deterministic contrast lift.
//
// The founder case is pinned first: a deck shipped with exactly one contrast warning,
// { fg: "#64748b", bg: "#f1f5f9", ratio: 4.3 }, and the report was "the element on
// the right is bad on visibility". 4.3 sits in the advisory band, so nothing repaired
// it. This module is the repair; the tests below are mostly about it never doing
// harm, because a colour repair that overshoots is worse than one that declines.
//
import { liftTextColor, rgbToHsl, hslToHex, parseHex } from "./text-contrast-lift";
import { contrastRatio } from "../agents/contrast";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

console.log("\n▶ text-contrast-lift");

check("THE FOUNDER CASE: #64748b on #f1f5f9 (4.3) reaches AA", () => {
  const before = contrastRatio("#64748b", "#f1f5f9");
  assert(near(before, 4.3, 0.1), `fixture drifted: expected ~4.3, got ${before.toFixed(2)}`);
  const r = liftTextColor("#64748b", "#f1f5f9");
  assert(r.changed, "should have lifted");
  assert(r.ratio >= 4.5, `still failing AA: ${r.ratio.toFixed(2)}`);
});

check("hue and saturation survive — slate stays slate, never black", () => {
  const [h0, s0] = rgbToHsl(...(parseHex("#64748b") as [number, number, number]));
  const r = liftTextColor("#64748b", "#f1f5f9");
  const [h1, s1] = rgbToHsl(...(parseHex(r.color) as [number, number, number]));
  assert(near(h0, h1, 2), `hue drifted ${h0.toFixed(1)} -> ${h1.toFixed(1)}`);
  assert(near(s0, s1, 0.02), `saturation drifted ${s0.toFixed(3)} -> ${s1.toFixed(3)}`);
  assert(r.color.toLowerCase() !== "#000000", "must not collapse to black");
});

check("it stops at the target — the MINIMUM change that passes", () => {
  // Overshooting is its own defect: a designer's mid-grey should not become ink-black
  // because the search ran to the extreme.
  const r = liftTextColor("#64748b", "#f1f5f9");
  assert(r.ratio >= 4.5, `under target: ${r.ratio.toFixed(2)}`);
  assert(r.ratio < 5.2, `overshot to ${r.ratio.toFixed(2)} — should land just past 4.5`);
});

check("LIGHT text on a DARK surface gets LIGHTER, not darker", () => {
  // The inverted-direction bug: pushing this DOWN would cross the backdrop's own
  // luminance, making it briefly invisible before recovering.
  const fg = "#6b7280"; // grey-500
  const bg = "#111827"; // grey-900
  const before = contrastRatio(fg, bg);
  assert(before < 4.5, `fixture must start failing, got ${before.toFixed(2)}`);
  const r = liftTextColor(fg, bg);
  assert(r.changed && r.ratio >= 4.5, `did not reach AA: ${r.ratio.toFixed(2)}`);
  const [, , lBefore] = rgbToHsl(...(parseHex(fg) as [number, number, number]));
  const [, , lAfter] = rgbToHsl(...(parseHex(r.color) as [number, number, number]));
  assert(lAfter > lBefore, `went the wrong way: lightness ${lBefore.toFixed(3)} -> ${lAfter.toFixed(3)}`);
});

check("DARK text on a LIGHT surface gets DARKER", () => {
  const fg = "#9ca3af", bg = "#ffffff";
  const r = liftTextColor(fg, bg);
  const [, , lBefore] = rgbToHsl(...(parseHex(fg) as [number, number, number]));
  const [, , lAfter] = rgbToHsl(...(parseHex(r.color) as [number, number, number]));
  assert(r.ratio >= 4.5, `did not reach AA: ${r.ratio.toFixed(2)}`);
  assert(lAfter < lBefore, `went the wrong way: ${lBefore.toFixed(3)} -> ${lAfter.toFixed(3)}`);
});

check("already-passing colour is returned untouched", () => {
  const r = liftTextColor("#111827", "#ffffff");
  assert(!r.changed && r.reason === "already-passing", JSON.stringify(r));
  assert(r.color === "#111827", "must not rewrite a passing colour");
});

check("pale text on a mid backdrop FLIPS polarity rather than staying invisible", () => {
  // Nowhere lighter to go: white against #d0d0d0 is only 1.5:1. Declining would leave
  // the label unreadable, so the lift inverts to dark text instead.
  const fg = "#f0f0f0", bg = "#d0d0d0";
  assert(contrastRatio(fg, bg) < 4.5, "fixture must start failing");
  const r = liftTextColor(fg, bg);
  assert(r.changed && r.ratio >= 4.5, `did not reach AA: ${JSON.stringify(r)}`);
  const [, , lAfter] = rgbToHsl(...(parseHex(r.color) as [number, number, number]));
  assert(lAfter < 0.5, `expected a flip to dark text, got lightness ${lAfter.toFixed(3)}`);
});

check("a genuinely impossible target declines rather than claiming a fix", () => {
  // 21:1 is white-on-black exactly; nothing else can reach it.
  const r = liftTextColor("#64748b", "#808080", 21);
  assert(!r.changed, `should not have changed: ${JSON.stringify(r)}`);
  assert(r.reason === "unreachable", `expected unreachable, got ${r.reason}`);
});

check("non-hex input is declined, not guessed at", () => {
  for (const bad of ["rgba(0,0,0,.5)", "currentColor", "", "#12345", "var(--x)"]) {
    const r = liftTextColor(bad, "#ffffff");
    assert(!r.changed && r.reason === "unparseable", `${bad} -> ${JSON.stringify(r)}`);
  }
});

check("3-digit hex is understood", () => {
  const r = liftTextColor("#999", "#fff");
  assert(r.changed && r.ratio >= 4.5, JSON.stringify(r));
});

check("hsl round-trip is stable for the colours we actually emit", () => {
  for (const hex of ["#64748b", "#818fff", "#0a0a0a", "#f1f5f9", "#ff5f57", "#28c840"]) {
    const [h, s, l] = rgbToHsl(...(parseHex(hex) as [number, number, number]));
    const back = hslToHex(h, s, l);
    assert(back.toLowerCase() === hex.toLowerCase(), `${hex} -> ${back}`);
  }
});

check("SWEEP: every failing pair either reaches AA or says why", () => {
  const greys = ["#64748b", "#6b7280", "#9ca3af", "#a1a1aa", "#818fff", "#94a3b8"];
  const backdrops = ["#ffffff", "#f1f5f9", "#0a0a0a", "#111827", "#1e293b"];
  let lifted = 0, declined = 0;
  for (const fg of greys) {
    for (const bg of backdrops) {
      const r = liftTextColor(fg, bg);
      if (r.reason === "already-passing") continue;
      if (r.changed) {
        assert(r.ratio >= 4.5, `claimed a lift but ${fg} on ${bg} is ${r.ratio.toFixed(2)}`);
        // hue preserved on every one
        const [h0] = rgbToHsl(...(parseHex(fg) as [number, number, number]));
        const [h1] = rgbToHsl(...(parseHex(r.color) as [number, number, number]));
        assert(near(h0, h1, 2), `hue drifted for ${fg} on ${bg}`);
        lifted++;
      } else {
        assert(r.reason === "unreachable", `${fg} on ${bg}: no lift and no reason`);
        declined++;
      }
    }
  }
  assert(lifted > 0, "the sweep lifted nothing — fixtures are wrong");
  console.log(`      (${lifted} lifted, ${declined} declined as unreachable)`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
