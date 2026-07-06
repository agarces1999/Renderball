/**
 * Tests for gate fire-rate telemetry (the deletion criterion in
 * docs/QUALITY-ARCHITECTURE.md). tallyGateFires is pure.
 */
import { tallyGateFires } from "./gate-telemetry";
import type { RenderTruthFinding } from "./render-truth-gates";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("gate-telemetry");

const f = (kind: RenderTruthFinding["kind"], scene = 0): RenderTruthFinding => ({ scene, kind, detail: "d" });

check("tallies render-truth finding kinds", () => {
  const fires = tallyGateFires({ findings: [f("overflow"), f("overflow", 1), f("barbell", 2)] });
  assert(fires.overflow === 2 && fires.barbell === 1, JSON.stringify(fires));
});

check("tallies static warnings by array length / count, skipping empties", () => {
  const fires = tallyGateFires({
    findings: [],
    warnings: {
      undwelled_text: [{ section: 0 }, { section: 3 }],
      duplicate_eyebrow: [],
      duplicate_logo: 3,
      missing_charts: null,
    },
  });
  assert(fires["warn:undwelled_text"] === 2, JSON.stringify(fires));
  assert(fires["warn:duplicate_logo"] === 3, "scalar count");
  assert(!("warn:duplicate_eyebrow" in fires) && !("warn:missing_charts" in fires), "empties skipped");
});

check("tallies vision findings under one key", () => {
  const fires = tallyGateFires({ findings: [], visionFindings: [{ scene: 0, issue: "a" }, { scene: 2, issue: "b" }] });
  assert(fires.vision === 2, JSON.stringify(fires));
});

check("a fully clean build tallies to an empty map", () => {
  const fires = tallyGateFires({ findings: [], warnings: { undwelled_text: [] }, visionFindings: [] });
  assert(Object.keys(fires).length === 0, JSON.stringify(fires));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
