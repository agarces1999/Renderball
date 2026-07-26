import { strict as assert } from "assert";
import { validateBrandInput, type DocumentBrand } from "./document-brand";
import {
  colorsInUse,
  inferAccent,
  parseFontConsts,
  parsePaletteConst,
  reskinComposition,
  resolveRoleColors,
  saturationOf,
} from "./reskin";

/**
 * The re-skin rewrites a document the user already paid for, so the bar is:
 * it must never produce source that stops compiling, and it must never
 * recolour something the user did not ask to change. Both directions are
 * pinned here with the shapes real builds actually emit.
 */

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const brandOf = (b: Partial<DocumentBrand>): DocumentBrand => ({
  v: 1,
  palette: {},
  fonts: {},
  assets: [],
  ...b,
});

/* ── the escaped-quote shape that corrupted 25 real compositions ────── */

test("font rewrite survives ESCAPED quotes in the declaration", () => {
  // Verbatim shape from src/generated: the stack is double-quoted AND the
  // family names inside are escaped. Splicing text into this produced
  // `""Georgia", serif"` — a parse error, i.e. a document that never renders.
  const src = 'const FONT_DISPLAY = "\\"Inter\\", sans-serif";\nexport const S = () => null;';
  const parsed = parseFontConsts(src);
  assert.equal(parsed.display, '"Inter", sans-serif', "unescapes the stack");

  const r = reskinComposition(src, brandOf({ fonts: { display: '"Georgia", serif' } }));
  assert.match(r.code, /const FONT_DISPLAY = `"Georgia", serif`/);
  assert.equal(r.changes.length, 1);
  // No stray quote left behind anywhere on that line.
  assert.doesNotMatch(r.code.split("\n")[0], /""/);
});

test("font rewrite handles single-quoted declarations too", () => {
  const src = `const FONT_BODY = '"Lato", system-ui, sans-serif';`;
  const r = reskinComposition(src, brandOf({ fonts: { body: '"Georgia", serif' } }));
  assert.match(r.code, /const FONT_BODY = `"Georgia", serif`/);
});

/* ── colour mapping ─────────────────────────────────────────────────── */

const CANONICAL = [
  "const PALETTE = {",
  '  accent:  "#0891B2",',
  '  canvas:  "#ffffff",',
  '  ink:     "#11141b",',
  "};",
  'const badge = { background: "#0891B2", color: "#11141b" };',
].join("\n");

test("named palette roles map exactly", () => {
  assert.equal(parsePaletteConst(CANONICAL).accent, "#0891b2");
  const roles = resolveRoleColors(CANONICAL);
  assert.deepEqual(roles.accent, ["#0891b2"]);

  const r = reskinComposition(CANONICAL, brandOf({ palette: { accent: "#7c3aed" } }));
  assert.ok(!/0891B2/i.test(r.code), "every occurrence replaced, case-insensitively");
  assert.equal(r.changes[0].occurrences, 2, "const + inline usage");
});

test("pure black and white are structural and never re-skinned", () => {
  const src = 'const shadow = "0 2px 8px #000000"; const page = "#ffffff";';
  assert.deepEqual(colorsInUse(src), []);
  const r = reskinComposition(src, brandOf({ palette: { accent: "#7c3aed" } }));
  assert.equal(r.code, src, "untouched");
});

test("accent inference skips pale background tints", () => {
  // The most-USED colour is usually the canvas. An early cut picked #f9f0ff
  // (a pale lavender background) as one deck's accent, so a re-skin would
  // have repainted the page instead of the brand.
  const src = [
    'const a = "#f9f0ff"; const b = "#f9f0ff"; const c = "#f9f0ff";',
    'const d = "#7c3aed";',
  ].join("\n");
  assert.equal(colorsInUse(src)[0].hex, "#f9f0ff", "pale colour IS the most used");
  assert.equal(inferAccent(src), "#7c3aed", "but the saturated one is the accent");
});

test("saturation separates grey chrome from brand colour", () => {
  assert.equal(saturationOf("#808080"), 0, "grey has no chroma");
  assert.ok(saturationOf("#7c3aed") > 0.5, "a brand purple is saturated");
});

// A pale tint is NOT caught by saturation — #f9f0ff is fully saturated in HSL
// (S 1.00) and merely very light (L 0.97). The lightness band is what rejects
// it, which is why accent inference needs both tests, not just chroma.
test("a pale tint is rejected by LIGHTNESS, not saturation", () => {
  assert.ok(saturationOf("#f9f0ff") > 0.9, "pale but fully chromatic");
  const src = 'const a="#f9f0ff";const b="#f9f0ff";const c="#0d9488";';
  assert.equal(inferAccent(src), "#0d9488", "picks the mid-lightness colour");
});

test("a document with no mappable colour is left alone", () => {
  const src = 'const x = "#808080";'; // grey only — no accent to map
  const r = reskinComposition(src, brandOf({ palette: { accent: "#7c3aed" } }));
  assert.equal(r.code, src);
  assert.equal(r.changes.length, 0);
});

/* ── logo + faces ───────────────────────────────────────────────────── */

test("logo swap follows the existing mark src", () => {
  const src = 'const logoSrc = "https://old.example/logo.svg";\n<img src="https://old.example/logo.svg" />';
  const r = reskinComposition(src, brandOf({ logo: "assets/brand-abc123.svg" }));
  assert.ok(!r.code.includes("old.example"));
  assert.equal(r.changes.find((c) => c.kind === "logo")?.occurrences, 2);
});

test("custom @font-face is appended, not substituted", () => {
  // Renaming the family without shipping the face would reference a font that
  // never loads.
  const src = "const BRAND_FONTS_CSS = `\n@font-face{font-family:\"Inter\";}\n`;";
  const r = reskinComposition(
    src,
    brandOf({ fonts: { faces: [{ family: "Acme", src: "assets/brand-1.woff2" }] } }),
  );
  assert.match(r.code, /font-family:"Acme"/);
  assert.match(r.code, /@font-face\{font-family:"Inter"/, "existing face kept");
});

/* ── input validation: these values are written into executable source ── */

test("rejects values that could break out of the literal", () => {
  const bad = validateBrandInput({
    palette: { accent: 'red";process.exit()//' },
    fonts: { display: "Inter`; eval(x); `" },
    logo: "javascript:alert(1)",
  });
  assert.equal(bad.ok, false);
  assert.equal(Object.keys(bad.brand.palette).length, 0);
  assert.equal(bad.brand.fonts.display, undefined);
  assert.equal(bad.brand.logo, undefined);
});

test("accepts real brand input", () => {
  const good = validateBrandInput({
    palette: { accent: "#7C3AED", canvas: "#fff" },
    fonts: { display: '"Georgia", serif' },
    logo: "assets/brand-abc123.svg",
    guidelines: "Sentence case only. Never put the logo on the accent colour.",
    assets: [
      { ref: "assets/brand-abc123.svg", name: "logo.svg", mime: "image/svg+xml", kind: "logo" },
    ],
  });
  assert.equal(good.ok, true, good.errors.join("; "));
  assert.equal(good.brand.palette.accent, "#7c3aed");
  assert.equal(good.brand.assets.length, 1);
  assert.match(good.brand.guidelines ?? "", /Sentence case/);
});

test("guidelines are bounded (they are pasted into every regen prompt)", () => {
  const v = validateBrandInput({ guidelines: "x".repeat(10_000) });
  assert.equal((v.brand.guidelines ?? "").length, 4000);
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
