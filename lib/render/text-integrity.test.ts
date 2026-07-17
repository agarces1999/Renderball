//
// cycle-9 P1 — text-integrity gate calibration.
//
//  Arm 1 (icon-font-in-a-text-role) MUST fire on the cycle-8 Tony's product-path
//  Composition (swiper-icons led FONT_DISPLAY + FONT_BODY — the exact class the
//  whole gate battery missed) and MUST pass every clean spike text stack.
//  Arm 2 (orphaned copy fragment) fires on lone-char / label-colon / dotted-
//  initials copy nodes and never on real copy, diegetic labels, or numeric stats.
//
import {
  findIconFontTextStacks,
  stripIconFontsFromTextStacks,
  findOrphanedFragments,
} from "./text-integrity";
import { isIconFont } from "./crawl-theme";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("text-integrity (cycle-9 P1)");

// ── isIconFont classifier ────────────────────────────────────────────────────
check("isIconFont: catches icon/symbol families, spares real text fonts", () => {
  for (const f of ["swiper-icons", "FontAwesome", "Font Awesome 6 Free", "Material Icons", "Material Symbols Outlined", "glyphicons-halflings", "ionicons", "dashicons", "icomoon", "feather-icons", "boxicons", "remixicon"])
    assert(isIconFont(f), `${f} should be an icon font`);
  for (const f of ["Chocolate letter", "American typewriter", "Inter", "Cabinet Grotesk", "Geist", "Geist Mono", "Nib Pro", "Proxima Nova", "Helvetica Neue", "system-ui"])
    assert(!isIconFont(f), `${f} is a real text font — must NOT be flagged`);
  assert(!isIconFont(undefined), "undefined → false");
});

// ── arm 1: MUST-FIRE on the cycle-8 archived consts ──────────────────────────
// Verbatim from .data/dogfood/cycle8-tonys/gen/Composition.tsx lines 19-21.
const CYCLE8_CONSTS = `const FONT_DISPLAY = "swiper-icons, Inter, system-ui, sans-serif";
const FONT_BODY = "swiper-icons, Inter, system-ui, sans-serif";
const FONT_MONO = "ui-monospace, \\"SF Mono\\", Menlo, monospace";`;

check("arm1: cycle-8 Tony's consts FIRE on FONT_DISPLAY + FONT_BODY (not FONT_MONO)", () => {
  const findings = findIconFontTextStacks(CYCLE8_CONSTS);
  const sites = findings.map((f) => f.site).sort();
  assert(sites.length === 2, `expected 2 findings, got ${sites.length}: ${sites.join(",")}`);
  assert(sites[0] === "FONT_BODY" && sites[1] === "FONT_DISPLAY", `expected DISPLAY+BODY, got ${sites.join(",")}`);
  assert(findings.every((f) => f.family === "swiper-icons"), "offending family is swiper-icons");
});

check("arm1: strip fixes the cycle-8 consts (copy set in a letterform font after)", () => {
  const { code, stripped } = stripIconFontsFromTextStacks(CYCLE8_CONSTS);
  assert(stripped.length === 2, `stripped 2 stacks, got ${stripped.length}`);
  assert(/const FONT_DISPLAY = "Inter, system-ui, sans-serif";/.test(code), "FONT_DISPLAY now leads with Inter");
  assert(/const FONT_BODY = "Inter, system-ui, sans-serif";/.test(code), "FONT_BODY now leads with Inter");
  assert(findIconFontTextStacks(code).length === 0, "no icon-font stack remains after strip");
});

check("arm1: inline fontFamily literal with an icon primary fires + strips", () => {
  const code = `<div style={{ fontFamily: "swiper-icons, Inter, sans-serif" }}>x</div>`;
  assert(findIconFontTextStacks(code).some((f) => f.site === "inline"), "inline icon fontFamily fires");
  const { code: fixed } = stripIconFontsFromTextStacks(code);
  assert(/fontFamily: "Inter, sans-serif"/.test(fixed), "inline icon family stripped");
});

check("arm1: clean spike stacks pass (no false fire)", () => {
  const clean = [
    `const FONT_DISPLAY = "\\"Nib Pro\\", Georgia, serif";\nconst FONT_BODY = "Inter, system-ui, sans-serif";\nconst FONT_MONO = "ui-monospace, Menlo, monospace";`, // Robinhood-class
    `const FONT_DISPLAY = "\\"Cabinet Grotesk\\", sans-serif";\nconst FONT_BODY = "\\"American typewriter\\", Courier New, monospace";`, // Tony's AFTER the P0 crawl-theme fix
    `<div style={{ fontFamily: FONT_BODY }}>real copy</div>`,
  ];
  for (const c of clean) assert(findIconFontTextStacks(c).length === 0, `clean stack must not fire: ${c.slice(0, 40)}`);
});

// ── arm 2: orphaned copy fragments (measured) ────────────────────────────────
const el = (p: Partial<MeasuredElement>): MeasuredElement => ({
  tag: "div", x: 0, y: 0, w: 40, h: 40, color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)",
  text: "", isImg: false, fontSize: 20, opacity: 1, piece: "s1.copy", pieceKind: "text",
  onOpaqueSurface: false, coveredAtCenter: false, ...p,
});
const scene = (n: number, els: Partial<MeasuredElement>[]): SceneMeasurement => ({
  scene: n, width: 1920, height: 1080, elements: els.map(el), screenshotPath: `/x/s${n}.png`,
});

check("arm2: cycle-8-shaped copy fragments FIRE (lone char / label-colon / dotted initials)", () => {
  const m = scene(1, [
    { piece: "s1.copy", pieceKind: "text", text: "D", fontSize: 46 },        // headline collapsed
    { piece: "s1.copy", pieceKind: "text", text: "T.R.A.T.", fontSize: 15 }, // lede sentence-initials
    { piece: "s1.copy", pieceKind: "text", text: "S:", fontSize: 13.5 },     // bullet label-colon
    { piece: "s1.copy", pieceKind: "text", text: "P :", fontSize: 13.5 },    // spaced variant
  ]);
  const findings = findOrphanedFragments(m);
  assert(findings.length === 4, `expected 4 fragment findings, got ${findings.length}`);
  const forms = findings.map((f) => f.form).sort();
  assert(forms.includes("lone-char") && forms.includes("dotted-initials") && forms.includes("label-colon"), `forms: ${forms.join(",")}`);
});

check("arm2: real full copy PASSES (no false fire)", () => {
  const m = scene(1, [
    { text: "Decades of looking away", fontSize: 46 },
    { text: "The system works because nobody asks. Reports get filed.", fontSize: 15 },
    { text: "Supply reports: filed and forgotten", fontSize: 13.5 },
    { text: "THE INDUSTRY LOOKS AWAY", fontSize: 11 },
    { text: "Looking away is not an accident — it's the system.", fontSize: 11 },
  ]);
  assert(findOrphanedFragments(m).length === 0, "full copy must not fire");
});

check("arm2: diegetic labels + numeric stats + accent punctuation are excluded", () => {
  const m = scene(1, [
    { piece: "s1.hero", pieceKind: "diegetic", text: "S", fontSize: 24 },     // a mock initial — not copy
    { piece: "s1.hero", pieceKind: "diegetic", text: "6 TIER", fontSize: 20 },// stat value
    { piece: "s3.hero", pieceKind: "diegetic", text: "P:", fontSize: 14 },    // mock field label
    { piece: "s1.copy", pieceKind: "text", text: "/", fontSize: 20 },         // accent slash (not alnum)
    { piece: "s1.copy", pieceKind: "text", text: "5", fontSize: 46 },         // lone DIGIT is not a letter
    { piece: "s1.copy", pieceKind: "text", text: "D", fontSize: 9 },          // below the copy font floor
  ]);
  assert(findOrphanedFragments(m).length === 0, "diegetic/numeric/punct/tiny must all be excluded");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
