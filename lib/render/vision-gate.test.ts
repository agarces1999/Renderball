/**
 * Tests for the vision gate. The judge is injected, so the aggregation logic +
 * tolerant verdict parsing are verified without any real vision-model spend.
 */
import {
  runVisionGate,
  parseVerdict,
  buildRubric,
  type VisionJudge,
  type VisionVerdict,
} from "./vision-gate";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("vision-gate");

await check("parseVerdict: clean verdict → ok, no issues", () => {
  const v = parseVerdict('{"ok": true, "issues": []}');
  assert(v.ok && v.issues.length === 0, JSON.stringify(v));
});

await check("parseVerdict: issues present → not ok, issues carried", () => {
  const v = parseVerdict('{"ok": false, "issues": ["logos washed out", "wall of type"]}');
  assert(!v.ok && v.issues.length === 2 && v.issues[0] === "logos washed out", JSON.stringify(v));
});

await check("parseVerdict: ok:true with issues is treated as not-ok (consistency)", () => {
  const v = parseVerdict('{"ok": true, "issues": ["text clipped"]}');
  assert(!v.ok && v.issues.length === 1, JSON.stringify(v));
});

await check("parseVerdict: tolerates prose around the JSON", () => {
  const v = parseVerdict('Here is my assessment:\n{"ok": false, "issues": ["bg is black not burgundy"]}\nDone.');
  assert(!v.ok && v.issues[0] === "bg is black not burgundy", JSON.stringify(v));
});

await check("parseVerdict: garbage → ok (advisory, never block on parse failure)", () => {
  const v = parseVerdict("the model rambled with no json");
  assert(v.ok && v.issues.length === 0, JSON.stringify(v));
});

await check("runVisionGate: aggregates issues across scenes, skips clean ones", async () => {
  const verdicts: Record<number, VisionVerdict> = {
    0: { ok: true, issues: [] },
    1: { ok: false, issues: ["logos unreadable", "near-black canvas"] },
    2: { ok: false, issues: ["wall of type"] },
  };
  const judge: VisionJudge = async (_p, scene) => verdicts[scene];
  const findings = await runVisionGate(
    [{ scene: 0, screenshotPath: "a.png" }, { scene: 1, screenshotPath: "b.png" }, { scene: 2, screenshotPath: "c.png" }],
    { name: "Fuse", backgroundColor: "#440b12" },
    judge,
  );
  assert(findings.length === 3, `got ${findings.length}`);
  assert(findings.filter((f) => f.scene === 1).length === 2, "scene 1 → 2 issues");
  assert(findings.some((f) => f.scene === 2 && /wall of type/.test(f.issue)), "scene 2 wall-of-type");
});

await check("runVisionGate: scenes without a screenshot are skipped", async () => {
  const judge: VisionJudge = async () => ({ ok: false, issues: ["x"] });
  const findings = await runVisionGate([{ scene: 0, screenshotPath: undefined }], { }, judge);
  assert(findings.length === 0, "no screenshot → no judge call");
});

await check("runVisionGate: a judge error on one scene is skipped (advisory)", async () => {
  const judge: VisionJudge = async (_p, scene) => {
    if (scene === 0) throw new Error("vision timeout");
    return { ok: false, issues: ["real issue"] };
  };
  const findings = await runVisionGate(
    [{ scene: 0, screenshotPath: "a.png" }, { scene: 1, screenshotPath: "b.png" }],
    {},
    judge,
  );
  assert(findings.length === 1 && findings[0].scene === 1, `got ${JSON.stringify(findings)}`);
});

await check("buildRubric: names the brand background color when provided", () => {
  const r = buildRubric({ backgroundColor: "#440b12", fonts: ["Merriweather"] });
  assert(r.includes("#440b12") && /Merriweather/.test(r), "rubric should cite brand truth");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
