/**
 * Truth-validator numeral scope. The witness-build regression (2026-08-27):
 * SVG attribute strings flooded 136 false violations. Geometry is never a
 * claim; only viewer-readable text is.
 */
import { findInventedNumerals, findLogoViolation, findUnstablePieceIds } from "./validators";

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

await check("apostrophes in prose never create phantom string literals (Atlas regression)", () => {
  const code = `
    <p>the quarter's growth. It steadied the whole network.</p>
    <div style={{ left: 96, top: 620 }} />
    <p>that's the right call.</p>`;
  const v = findInventedNumerals(code, "no numbers", 6);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("hex colors, rgba strings, and coordinate constants are geometry, not claims (Disney regression)", () => {
  const code = `const NAVY = "#050D1F"; const MUTE = "rgba(255,255,255,0.64)"; const PTS = "1150 780"; const ARC = "M0,395 L80,392";
    <div><p>Reliability over volume.</p></div>`;
  const v = findInventedNumerals(code, "no numbers", 6);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("generic type annotations never turn data arrays into phantom JSX text (Disney regression)", () => {
  const code = `const BARS: Array<[string, number]> = [
      ["Retention", 600],
      ["Engagement", 545],
    ];
    <div><p>Winning now depends on retention.</p></div>`;
  const v = findInventedNumerals(code, "no numbers", 6);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("flags a missing logo only when a logo exists", () => {
  assert(findLogoViolation("<div/>", "https://cdn.example.com/logo.png").length === 1, "missing logo not flagged");
  assert(findLogoViolation('<img src="https://cdn.example.com/logo.png"/>', "https://cdn.example.com/logo.png").length === 0, "present logo flagged");
  assert(findLogoViolation("<div/>", null).length === 0, "null logo flagged");
});

await check("computed and duplicate Piece ids are violations the patch pass fixes (Deel class)", () => {
  const computed = '{rows.map((r, i) => (<Piece key={r} id={`s1.p${4 + i}`} kind="diegetic"><p/></Piece>))}';
  const v1 = findUnstablePieceIds(computed);
  assert(v1.length === 1 && v1[0].kind === "unstable-piece-id", `computed id flagged: ${JSON.stringify(v1)}`);
  assert(/literal/i.test(v1[0].patch) && /inside one Piece/i.test(v1[0].patch), "patch teaches the fix");

  const dup = '<Piece id="s1.p3" kind="text"><h1/></Piece><Piece id="s1.p3" kind="diegetic"><p/></Piece>';
  const v2 = findUnstablePieceIds(dup);
  assert(v2.length === 1 && v2[0].detail === "s1.p3", `duplicate flagged once: ${JSON.stringify(v2)}`);

  const clean = '<Piece id="s0.p1" kind="text"><h1/></Piece><Piece id="s0.p2" kind="chrome"><div/></Piece>';
  assert(findUnstablePieceIds(clean).length === 0, "literal unique ids pass");
});


// ── the ab7 phantom-flood class (2026-09-02): non-visible byte classes ──────

await check("base64 data-URI consts produce ZERO numeral flags (the 11-phantom logo flood)", () => {
  const code = `const LOGO_URL =\n  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgNTMgMjkgNDIgNDEgNDUgNDMgMDAiPjwvc3ZnPg==";\n<img src={LOGO_URL} alt="Stripe"/>`;
  const v = findInventedNumerals(code, "no numbers", 4);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("font-face template literals and asset URLs produce ZERO flags (the 178166 hash)", () => {
  const code = "const FACES = `@font-face{font-family:\"Sohne\";src:url(https://cdn.x.com/fonts/Sohne.cb178166.woff2) format(\"woff2\");font-display:swap;}`;\n<style>{FACES}</style>";
  const v = findInventedNumerals(code, "no numbers", 4);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("mid-string hex colors produce ZERO flags (the 533 leak)", () => {
  const v = findInventedNumerals(`const BORDER = "1px solid #533afd"; <div><p>Clean page</p></div>`, "no numbers", 4);
  assert(v.length === 0, `expected 0, got ${JSON.stringify(v.map((x) => x.detail))}`);
});

await check("REAL fabrications still flag after the stripping (the shipped 135-currencies lie)", () => {
  const v = findInventedNumerals(`<div><p>135 currencies, 40+ methods</p></div>`, "global payments brief, no figures approved", 4);
  const toks = v.map((x) => x.detail);
  assert(toks.includes("135") && toks.includes("40"), `expected 135+40 flagged, got ${JSON.stringify(toks)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
