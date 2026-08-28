/**
 * Truth-validator numeral scope. The witness-build regression (2026-08-27):
 * SVG attribute strings flooded 136 false violations. Geometry is never a
 * claim; only viewer-readable text is.
 */
import { findInventedNumerals, findLogoViolation } from "./validators";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("harness-validators");

await check("ignores SVG path/viewBox attribute strings and style objects", () => {
  const code = `
    export const Section0 = () => (
      <div style={{ position: "absolute", top: 150, fontSize: 92 }}>
        <svg viewBox="0 0 1920 1080" width={960}>
          <path d="M0,395 L80,392 L110,120 L140,390" strokeWidth="3.5" strokeDasharray="4 4" />
        </svg>
        <p>Roast-date honesty, every single bag.</p>
      </div>
    );`;
  const v = findInventedNumerals(code, "no numbers in this brief", 6);
  assert(v.length === 0, `expected 0 violations, got ${v.length}: ${v.map((x) => x.detail).join(",")}`);
});

await check("catches an invented numeral in visible JSX text", () => {
  const v = findInventedNumerals(`<div><h1>We serve 4,000 cafes</h1></div>`, "coffee brief with no numbers", 6);
  assert(v.length === 1 && v[0].detail === "4,000", `got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("catches an invented numeral in a rendered string literal", () => {
  const v = findInventedNumerals(`const LABELS = ["Founded 1987", "Single origin"]; <div>{LABELS[0]}</div>`, "no numbers", 6);
  assert(v.length === 1 && v[0].detail === "1987", `got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("allows numerals present in the approved copy and page indices", () => {
  const v = findInventedNumerals(`<div><h1>94% sell-through</h1><span>03 — 06</span></div>`, "pilot hit 94% sell-through", 6);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("flags a missing logo only when a logo exists", () => {
  assert(findLogoViolation("<div/>", "https://cdn.example.com/logo.png").length === 1, "missing logo not flagged");
  assert(findLogoViolation('<img src="https://cdn.example.com/logo.png"/>', "https://cdn.example.com/logo.png").length === 0, "present logo flagged");
  assert(findLogoViolation("<div/>", null).length === 0, "null logo flagged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
