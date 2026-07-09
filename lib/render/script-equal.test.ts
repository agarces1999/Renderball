/**
 * Tests for the order-insensitive render reuse compare. The real failure
 * (2026-07-09): the pg store's Json round-trip reorders keys, raw-stringify
 * equality failed, and every MP4 render silently re-ran a full ~45-min build.
 */
import { stableStringify, scriptsEquivalent } from "./script-equal";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("script-equal");

check("key order does not matter (the pg round-trip case)", () => {
  const a = { config: { fps: 30, aspect_ratio: "16:9" }, scenes: [{ label: "A", start_seconds: 0 }] };
  const b = { scenes: [{ start_seconds: 0, label: "A" }], config: { aspect_ratio: "16:9", fps: 30 } };
  assert(scriptsEquivalent(a, b), "reordered keys must compare equal");
  assert(JSON.stringify(a) !== JSON.stringify(b), "sanity: raw stringify WOULD have failed here");
});

check("genuine content differences still detected", () => {
  assert(!scriptsEquivalent({ a: 1 }, { a: 2 }), "value change");
  assert(!scriptsEquivalent({ scenes: [1, 2] }, { scenes: [2, 1] }), "array ORDER is meaning — must differ");
  assert(!scriptsEquivalent({ a: 1 }, { a: 1, b: 2 }), "extra key");
});

check("undefined-valued keys are dropped (both sides agree with JSON semantics)", () => {
  assert(scriptsEquivalent({ a: 1, b: undefined }, { a: 1 }), "undefined key ≡ absent key");
});

check("primitives + null + nested arrays", () => {
  assert(stableStringify(null) === "null", "null");
  assert(scriptsEquivalent([{ b: 1, a: [2, { d: 3, c: 4 }] }], [{ a: [2, { c: 4, d: 3 }], b: 1 }]), "deep nesting");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
