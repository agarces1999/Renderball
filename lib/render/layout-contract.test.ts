/**
 * Tests for the stranded-hero / layout composer gate. The founder-doctrine
 * defect (Fuse scene 1, 2026-07-08): a small diegetic UI piece shipped alone
 * in the bottom-right corner of the frame — "we should never build a scene
 * with a small UI element cornered on an edge". The gate measures LEGO piece
 * boxes on the real render; these tests drive it with the geometry classes
 * that must (and must not) fire.
 */
import { findStrandedHero } from "./render-truth-gates";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const el = (
  piece: string,
  pieceKind: string,
  x: number,
  y: number,
  w: number,
  h: number,
  over: Partial<MeasuredElement> = {},
): MeasuredElement => ({
  tag: "div", x, y, w, h,
  color: "rgb(20,20,20)", bg: "rgb(255,255,255)",
  text: "", isImg: false, fontSize: 16, opacity: 1,
  piece, pieceKind, onOpaqueSurface: false, coveredAtCenter: false,
  ...over,
});

const scene = (elements: MeasuredElement[]): SceneMeasurement => ({
  scene: 1, width: 1920, height: 1080, elements,
});

console.log("layout-contract (stranded hero)");

check("REAL FUSE GEOMETRY: small UI piece alone in the bottom-right corner FIRES", () => {
  // The shipped defect: a ~380×260 diegetic mock at the bottom-right of a
  // 1920×1080 frame, headline text in the upper-left, nothing anchoring it.
  const m = scene([
    el("s1.copy", "text", 140, 180, 700, 320, { text: "The rescue plan", fontSize: 64 }),
    el("s1.hero", "diegetic", 1450, 760, 380, 260),
    el("s1.hero", "diegetic", 1470, 780, 340, 60, { text: "Dashboard" }),
    el("s1.chrome", "chrome", 60, 40, 160, 40),
  ]);
  const f = findStrandedHero(m);
  assert(f.length === 1, `want exactly 1 finding, got ${f.length}`);
  assert(f[0].kind === "stranded-hero", "kind");
  assert(/corner/i.test(f[0].detail), "detail must name the corner defect");
  assert(/30%/.test(f[0].detail), "detail must carry the numeric contract (the retry instruction)");
});

check("a REAL hero (split layout done right) does NOT fire, even with register=split", () => {
  // Text column left, hero filling the right column, vertically centered.
  const m = scene([
    el("s1.copy", "text", 140, 330, 640, 420, { text: "Headline", fontSize: 64 }),
    el("s1.hero", "diegetic", 1000, 240, 780, 600),
    el("s1.chrome", "chrome", 60, 40, 160, 40),
  ]);
  assert(findStrandedHero(m, "split").length === 0, "compliant split scene must pass");
});

check("small but CENTERED visual (a deliberate focal object) does not fire", () => {
  const m = scene([
    el("s1.copy", "text", 560, 140, 800, 160, { text: "One promise", fontSize: 72 }),
    el("s1.hero", "diegetic", 780, 440, 360, 300), // centered-ish, small — fine
  ]);
  assert(findStrandedHero(m).length === 0, "centered small visual is a choice, not a defect");
});

check("badge-size corner accents are below the area floor (no fire)", () => {
  const m = scene([
    el("s1.copy", "text", 300, 300, 1000, 400, { text: "Quote", fontSize: 80 }),
    el("s1.badge", "image", 1720, 940, 120, 80, { isImg: true }), // 9.6k px² « 40k
  ]);
  assert(findStrandedHero(m, "quote").length === 0, "tiny corner badge must not fire");
});

check("chrome + atmosphere pieces are never hero candidates", () => {
  const m = scene([
    el("s1.atmos", "atmosphere", 0, 0, 1920, 1080),
    el("s1.chrome", "chrome", 1700, 980, 180, 60),
    el("s1.copy", "text", 200, 300, 1200, 400, { text: "Type-only scene", fontSize: 88 }),
  ]);
  assert(findStrandedHero(m).length === 0, "no diegetic/image piece ⇒ nothing to judge");
});

check("split contract: narrow hero fires with the 30% width number in the detail", () => {
  const m = scene([
    el("s1.copy", "text", 140, 330, 640, 420, { text: "Headline", fontSize: 64 }),
    el("s1.hero", "diegetic", 1250, 340, 420, 400), // centered vertically, but only 420px wide
  ]);
  const f = findStrandedHero(m, "split");
  assert(f.length === 1, `want 1 finding, got ${f.length}: ${JSON.stringify(f.map((x) => x.detail))}`);
  assert(/576px/.test(f[0].detail), "detail must state the computed 30% floor (576px at 1920)");
});

check("split contract: hero glued to the top edge fires the vertical-centering rule", () => {
  const m = scene([
    el("s1.copy", "text", 140, 330, 640, 420, { text: "Headline", fontSize: 64 }),
    el("s1.hero", "diegetic", 1000, 20, 780, 300), // wide enough, but centers at y=170
  ]);
  const f = findStrandedHero(m, "split");
  assert(f.length === 1, `want 1 finding, got ${f.length}`);
  assert(/vertically/i.test(f[0].detail), "detail must name vertical centering");
});

check("split contract: hero and text stacked on the SAME half fires opposite-column", () => {
  const m = scene([
    el("s1.copy", "text", 1100, 140, 700, 260, { text: "Headline", fontSize: 64 }),
    el("s1.hero", "diegetic", 1180, 460, 640, 480), // both on the right half
  ]);
  const f = findStrandedHero(m, "split");
  assert(f.length === 1, `want 1 finding, got ${f.length}`);
  assert(/OPPOSITE/i.test(f[0].detail), "detail must demand opposite columns");
});

check("non-split registers skip the column contract (only the corner rule applies)", () => {
  // Same same-half geometry as above, but register=stat — no contract to break.
  const m = scene([
    el("s1.copy", "text", 1100, 140, 700, 260, { text: "97%", fontSize: 200 }),
    el("s1.hero", "diegetic", 1180, 460, 640, 480),
  ]);
  assert(findStrandedHero(m, "stat").length === 0, "stat register has no column contract");
});

check("full-bleed visual (≥85% of canvas) is a canvas treatment, not a hero", () => {
  const m = scene([
    el("s1.photo", "image", 0, 0, 1920, 1040, { isImg: true }),
    el("s1.copy", "text", 200, 400, 900, 280, { text: "Over imagery", fontSize: 72 }),
  ]);
  assert(findStrandedHero(m, "full-bleed").length === 0, "full-bleed image excluded");
});

check("measure-errored scenes and piece-less builds fail open (no findings)", () => {
  const errored: SceneMeasurement = { scene: 0, width: 1920, height: 1080, elements: [], error: "boom" };
  assert(findStrandedHero(errored).length === 0, "error ⇒ no findings (measure-error gate owns it)");
  const untagged = scene([el("", "", 1500, 800, 300, 200)]);
  assert(findStrandedHero(untagged).length === 0, "no data-piece tagging ⇒ nothing to judge");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
