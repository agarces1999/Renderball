/**
 * Tests for scene-scope — per-scene attribution of the localizable design-pass
 * gates. Run: `npm test` (no API key, no credits).
 *
 * These lock the contract the scoped-retry path depends on: a sparse / cropped /
 * baked-copy failure is tied to the RIGHT scene, a clean scene is never flagged,
 * and the spliceability guard rejects any file whose sections aren't the exact
 * contiguous 0..N-1 run (which would make positional splicing unsafe).
 */
import {
  densityFailuresByScene,
  overflowFailuresByScene,
  unboundFailuresByScene,
  groupByScene,
  sectionsAreSpliceable,
} from "./scene-scope";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// Two scenes: scene 0 asks for a lot (and the code under-delivers); scene 1
// asks for just a headline (and delivers it).
const SCENES = [
  {
    content: {
      headline: "First headline",
      lede: "A supporting lede.",
      bullets: ["one", "two"],
      illustration: "growth-chart",
    },
  },
  { content: { headline: "Second headline" } },
];

const SPARSE_S0_RICH_S1 = `import React from "react";
export const Section0 = () => (
  <div><h1>First headline</h1></div>
);
export const Section1 = () => (
  <div><h2>Second headline</h2></div>
);`;

// ── density ──────────────────────────────────────────────────────────────
check("densityFailuresByScene flags the sparse scene's missing fields", () => {
  const out = densityFailuresByScene(SPARSE_S0_RICH_S1, SCENES);
  assert(out.length === 1, `only scene 0 should fail, got ${out.length}`);
  assert(out[0].scene === 0, "the failure is scene 0");
  const m = out[0].message;
  assert(m.includes("lede"), "names the missing lede");
  assert(m.includes("bullet"), "names the missing bullets");
  assert(m.includes("svg") || m.includes("illustration"), "names the missing illustration");
  assert(!m.includes("headline (need"), "headline WAS rendered — not a deficit");
});

check("densityFailuresByScene clears a fully-rendered composition", () => {
  const full = `export const Section0 = () => (<div>
    <h1>First headline</h1><p>A supporting lede.</p>
    <ul><li>one</li><li>two</li></ul><svg viewBox="0 0 1 1" />
  </div>);
export const Section1 = () => (<div><h2>Second headline</h2></div>);`;
  assert(densityFailuresByScene(full, SCENES).length === 0, "nothing sparse");
});

check("densityFailuresByScene skips a scene whose section block is missing", () => {
  const onlyS1 = `export const Section1 = () => (<div><h2>Second headline</h2></div>);`;
  // Scene 0 has no Section0 block → not flagged here (file-level gate owns it).
  assert(densityFailuresByScene(onlyS1, SCENES).length === 0, "no Section0 → skip");
});

// ── overflow ───────────────────────────────────────────────────────────────
check("overflowFailuresByScene attributes a cropping width to its scene", () => {
  const code = `export const Section0 = () => (<div style={{ width: 800 }} />);
export const Section1 = () => (<div style={{ width: 2000, left: 0 }}>wide</div>);`;
  const out = overflowFailuresByScene(code, "16:9");
  assert(out.length === 1, `one scene overflows, got ${out.length}`);
  assert(out[0].scene === 1, "width 2000 lives in Section1");
  assert(out[0].message.includes("2000"), "names the offending width");
});

check("overflowFailuresByScene is empty when nothing crops", () => {
  const code = `export const Section0 = () => (<div style={{ width: 1200 }} />);`;
  assert(overflowFailuresByScene(code, "16:9").length === 0, "1200 < 1760 safe");
});

// ── unbound copy ─────────────────────────────────────────────────────────
check("unboundFailuresByScene flags a literal-typed headline", () => {
  // Section1 renders scene 1's headline as a literal instead of {c.headline}.
  const code = `export const Section0 = () => (<div><h1>{c.headline}</h1></div>);
export const Section1 = () => (<div><h2>Second headline</h2></div>);`;
  const out = unboundFailuresByScene(code, SCENES);
  assert(out.some((f) => f.scene === 1), "scene 1's literal headline is flagged");
  assert(!out.some((f) => f.scene === 0), "scene 0 binds {c.headline} → clean");
});

// ── grouping ──────────────────────────────────────────────────────────────
check("groupByScene merges multiple gate lists per scene, sorted", () => {
  const grouped = groupByScene(
    [{ scene: 1, message: "density" }],
    [{ scene: 1, message: "overflow" }],
    [{ scene: 0, message: "unbound" }],
  );
  assert(grouped.length === 2, "two distinct scenes");
  assert(grouped[0].scene === 0 && grouped[1].scene === 1, "ascending scene order");
  assert(grouped[1].messages.length === 2, "scene 1 bundles both its failures");
});

// ── spliceability guard ────────────────────────────────────────────────────
check("sectionsAreSpliceable: contiguous 0..N-1 → true", () => {
  assert(sectionsAreSpliceable(SPARSE_S0_RICH_S1, 2), "0,1 for 2 scenes is spliceable");
});

check("sectionsAreSpliceable: count mismatch → false", () => {
  assert(!sectionsAreSpliceable(SPARSE_S0_RICH_S1, 3), "2 sections, 3 scenes → not spliceable");
});

check("sectionsAreSpliceable: a gap in indices → false", () => {
  const gap = `export const Section0 = () => null;
export const Section2 = () => null;`;
  assert(!sectionsAreSpliceable(gap, 2), "0,2 is not the contiguous run 0,1");
});

for (const { name, fn } of checks) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
