//
// decoration-over-text requires PAINTED ink — the #113 hollow-frame phantom, pinned.
//
// The fixture reproduces the witnessed specimen (2026-08-24, scene 3 of the witness
// deck): a drawn-rectangle motif — transparent container, transparent svg, stroke-only
// rect, 691x188 — framing text runs of other pieces. Four blocking findings fired; the
// vision judge scored the scene clean.
//
import { findDecorationOverText } from "./render-truth-gates";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ decoration-ink");

const el = (over: Partial<MeasuredElement>): MeasuredElement =>
  ({
    tag: "div", x: 0, y: 0, w: 100, h: 40, color: "rgb(10,10,10)", bg: "rgba(0, 0, 0, 0)",
    text: "", isImg: false, fontSize: 16, opacity: 1, piece: "", pieceKind: "",
    onOpaqueSurface: false, coveredAtCenter: false, radius: 0, parentIx: -1,
    hasTextDesc: false, hasBgImage: false, decorative: false,
    ...over,
  }) as MeasuredElement;

/** Text first, decoration LATER (paints on top) — the order the gate requires. */
const scene = (deco: Partial<MeasuredElement>): SceneMeasurement =>
  ({
    scene: 3, width: 1920, height: 1080, error: undefined,
    elements: [
      el({ piece: "s3.copy", text: "Founders ship faster here", fontSize: 22, x: 1100, y: 400, w: 500, h: 60 }),
      el({ piece: "s3.throughline", decorative: true, x: 1038, y: 356, w: 691, h: 188, ...deco }),
    ],
  }) as SceneMeasurement;

check("THE SPECIMEN: a stroke-only svg rect over text does NOT fire", () => {
  const f = findDecorationOverText(scene({ tag: "rect", svgShape: true, fill: "none", opacity: 0.99 }));
  assert(f.length === 0, `hollow frame flagged: ${JSON.stringify(f.map((x) => x.detail))}`);
});

check("a transparent container div does NOT fire", () => {
  const f = findDecorationOverText(scene({}));
  assert(f.length === 0, `transparent container flagged: ${JSON.stringify(f)}`);
});

check("a FILLED svg rect over text DOES fire — real coverage is still caught", () => {
  const f = findDecorationOverText(scene({ tag: "rect", svgShape: true, fill: "rgb(20, 20, 30)" }));
  assert(f.length === 1, `filled rect must fire, got ${f.length}`);
});

check("a solid-background div over text DOES fire", () => {
  const f = findDecorationOverText(scene({ bg: "rgb(255, 255, 255)" }));
  assert(f.length === 1, `solid panel must fire, got ${f.length}`);
});

check("a gradient wash (background-image) over text DOES fire", () => {
  const f = findDecorationOverText(scene({ hasBgImage: true }));
  assert(f.length === 1, `gradient decoration must fire, got ${f.length}`);
});

check("an image decoration over text DOES fire", () => {
  const f = findDecorationOverText(scene({ isImg: true }));
  assert(f.length === 1, `image must fire, got ${f.length}`);
});

check("fill with explicit alpha 0 is hollow; near-opaque fill paints", () => {
  const hollow = findDecorationOverText(scene({ tag: "path", svgShape: true, fill: "rgba(0, 0, 0, 0)" }));
  assert(hollow.length === 0, "alpha-0 fill must not fire");
  const inked = findDecorationOverText(scene({ tag: "path", svgShape: true, fill: "rgba(20, 20, 30, 0.9)" }));
  assert(inked.length === 1, "alpha-0.9 fill must fire");
});

check("PRE-CAPTURE measurements (no svgShape field): transparent stays silent, painted children answer for themselves", () => {
  // Old rects have no fill data. The transparent container is excluded by its bg;
  // a painted CHILD is its own element and still fires.
  const m = {
    scene: 3, width: 1920, height: 1080, error: undefined,
    elements: [
      el({ piece: "s3.copy", text: "Founders ship faster here", fontSize: 22, x: 1100, y: 400, w: 500, h: 60 }),
      el({ piece: "s3.throughline", decorative: true, x: 1038, y: 356, w: 691, h: 188 }), // old-style container
      el({ piece: "s3.throughline", decorative: true, x: 1038, y: 356, w: 691, h: 188, bg: "rgb(30,30,40)" }), // painted child
    ],
  } as SceneMeasurement;
  const f = findDecorationOverText(m);
  assert(f.length === 1, `painted child must still fire exactly once, got ${f.length}`);
});

check("the ORIGINAL incident still fires: a 28px-thin unpainted stroke motif over text", () => {
  // adc6cfd's specimen. Nothing measurable paints, but a thin box IS its ink —
  // this is the case the hollow-frame exemption must never silence.
  const m = {
    scene: 1, width: 1920, height: 1080, error: undefined,
    elements: [
      el({ piece: "s1.stats", text: "Accounts churned without intervention", fontSize: 15, x: 1043, y: 330, w: 420, h: 24 }),
      el({ tag: "svg", piece: "s1.gap", decorative: true, opacity: 0.85, x: 1348, y: 340, w: 28, h: 398 }),
    ],
  } as SceneMeasurement;
  const f = findDecorationOverText(m);
  assert(f.length === 1, `the incident class must still flag, got ${f.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
