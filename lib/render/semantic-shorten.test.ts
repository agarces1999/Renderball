/**
 * Layer-3 plumbing: measured budgets at generation + floor-triggered semantic
 * shorten at build. All pure logic — the paid halves are exercised by the
 * witness build and live telemetry.
 */
import { COPY_BUDGETS, findBudgetViolations, applyShortenedValue } from "../agents/copy-budgets";
import { findFlooredCopy, applyShortened, shortenPrompt } from "./semantic-shorten";
import type { SceneMeasurement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("copy budgets + semantic shorten");

check("budgets: violations found at exact addresses, within-budget copy passes", () => {
  const scenes = [
    { content: { headline: "x".repeat(COPY_BUDGETS.headline + 10), lede: "fine", bullets: ["ok", "y".repeat(COPY_BUDGETS.bullet + 1)] } },
    { content: { headline: "short" } },
  ];
  const v = findBudgetViolations(scenes);
  assert(v.length === 2, `2 violations, got ${v.length}: ${JSON.stringify(v.map((x) => x.field))}`);
  assert(v[0].field === "headline" && v[0].sceneIndex === 0, "headline addressed");
  assert(v[1].field === "bullets[1]", `bullet addressed: ${v[1].field}`);
  assert(applyShortenedValue(scenes, v[1], "trimmed"), "bullet write lands");
  assert(scenes[0].content.bullets![1] === "trimmed", "value in place");
});

const M = (scene: number, els: Partial<SceneMeasurement["elements"][number]>[]): SceneMeasurement =>
  ({ scene, width: 1920, height: 1080, elements: els } as unknown as SceneMeasurement);

check("floored copy: dot paths map (bullets.N, cta.primary), targets computed from fullness", () => {
  const scenes = [
    { content: { headline: "H".repeat(60), bullets: ["b".repeat(100), "c".repeat(100)], cta: { primary: "Click the extremely long call to action" } } },
  ];
  const measured = [
    M(0, [
      { contentPath: "headline", fitFloor: 1.5, text: "" },
      { contentPath: "bullets.1", fitFloor: 1.25, text: "" },
      { contentPath: "cta.primary", fitFloor: 2.0, text: "" },
      { contentPath: "lede", fitFloor: undefined, text: "" }, // not floored → ignored
    ]),
  ];
  const f = findFlooredCopy(measured, scenes);
  assert(f.length === 3, `3 floored, got ${f.length}`);
  const h = f.find((x) => x.path === "headline")!;
  // 60/1.5*0.95 = 38 — the fullness bound, under the 48 budget
  assert(h.target === 38, `headline target 38, got ${h.target}`);
  const b = f.find((x) => x.path === "bullets.1")!;
  assert(b.target === 76, `bullet fullness bound 76, got ${b.target}`);
  const cta = f.find((x) => x.path === "cta.primary")!;
  assert(cta.target === Math.max(8, Math.floor((cta.current.length / 2) * 0.95)), "cta target driven by fullness alone");
});

check("floored copy: budget caps the target when tighter than fullness", () => {
  const scenes = [{ content: { headline: "H".repeat(200) } }];
  const measured = [M(0, [{ contentPath: "headline", fitFloor: 1.1, text: "" }])];
  const f = findFlooredCopy(measured, scenes);
  // 200/1.1*0.95 = 172 → capped by the measured headline budget (48)
  assert(f[0].target === COPY_BUDGETS.headline, `capped at ${COPY_BUDGETS.headline}, got ${f[0].target}`);
});

check("floored copy: worst fullness wins per field; short strings skipped", () => {
  const scenes = [{ content: { headline: "H".repeat(60), eyebrow: "tiny" } }];
  const measured = [
    M(0, [
      { contentPath: "headline", fitFloor: 1.2, text: "" },
      { contentPath: "headline", fitFloor: 1.8, text: "" },
      { contentPath: "eyebrow", fitFloor: 3.0, text: "" }, // <12 chars → skip
    ]),
  ];
  const f = findFlooredCopy(measured, scenes);
  assert(f.length === 1 && f[0].fullness === 1.8, `worst wins: ${JSON.stringify(f)}`);
});

check("applyShortened: within-grace adopted, over-grace and non-strings refused", () => {
  const scenes = [{ content: { headline: "H".repeat(60) } }];
  const f = [{ scene: 0, path: "headline", fullness: 1.5, current: "H".repeat(60), target: 38 }];
  assert(applyShortened(f, ["G".repeat(40)], scenes) === 1, "40 ≤ 38+8 adopted");
  assert((scenes[0].content.headline as string).length === 40, "written");
  assert(applyShortened(f, ["G".repeat(60)], scenes) === 0, "over grace refused");
  assert(applyShortened(f, [42 as unknown as string], scenes) === 0, "non-string refused");
});

check("prompt: numbered, carries max + current lengths", () => {
  const p = shortenPrompt([{ scene: 1, path: "lede", fullness: 1.4, current: "some long lede here", target: 14 }]);
  assert(p.includes("0. (max 14 chars, currently 19)"), p.slice(0, 200));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
