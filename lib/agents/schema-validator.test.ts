/**
 * Regression tests for headlineProblem (QA S4) — hero headlines must be one
 * punchy clause, not a crammed headline+subhead. Run: `npm test`.
 */
import {
  headlineProblem,
  findUngroundedClaims,
  findUngroundedStageLabels,
} from "./schema-validator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`); }
};
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

check("clean punchy headline → null", () => {
  assert(headlineProblem("Murder Your Thirst") === null, "LD headline should pass");
  assert(headlineProblem("Payments for the internet") === null, "Stripe headline should pass");
});

check("single long-ish clause (47c) → null", () => {
  assert(headlineProblem("Configure each workspace to match your workflow") === null, "single clause OK");
});

check("Fuse two-sentence cram (50c) → flagged", () => {
  const p = headlineProblem("Building takes years. Buying means losing control.");
  assert(p !== null && /two sentences/.test(p), `expected two-sentence flag, got ${p}`);
});

check("Fuse two-sentence cram (59c) → flagged", () => {
  const p = headlineProblem("Open loans & accounts like a Fintech. Without becoming one.");
  assert(p !== null && /two sentences/.test(p), `expected two-sentence flag, got ${p}`);
});

check("short stylistic two-beat (24c) → allowed", () => {
  assert(headlineProblem("Move fast. Break things.") === null, "short two-beat should pass");
});

check("paragraph (>72c) → flagged for length", () => {
  const long = "This is an extremely long headline that reads like a full paragraph and keeps going well past any reasonable hero limit";
  const p = headlineProblem(long);
  assert(p !== null && /cap at 72/.test(p), `expected length flag, got ${p}`);
});

// ── S5: ungrounded numeric claims ────────────────────────────────────
check("flags a stat not in the source", () => {
  const u = findUngroundedClaims("We process $840M every year. 99.97% uptime.", "Fuse helps banks move money.");
  assert(u.includes("$840M") && u.some((t) => t.includes("99.97")), `expected both flagged, got ${JSON.stringify(u)}`);
});
check("grounded stat (digits present in source) → not flagged", () => {
  const u = findUngroundedClaims("$840M processed annually", "We process $840M in volume across 2.4 million accounts.");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("digit-core match grounds a variant", () => {
  const u = findUngroundedClaims("$2.4M in fees", "serving 2.4 million customers");
  assert(u.length === 0, `2.4 present in source → grounded, got ${JSON.stringify(u)}`);
});
check("bare integers / years / qualitative copy are NOT flagged", () => {
  const u = findUngroundedClaims("5 sourcing principles, 3 weeks, founded 2024, Millions joined", "");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("multiplier + percent are stat-shaped and checked", () => {
  const u = findUngroundedClaims("10x faster", "");
  assert(u.includes("10x"), `expected 10x flagged, got ${JSON.stringify(u)}`);
});

// ── G5: ungrounded funding-stage labels ──────────────────────────────────
check("flags an invented 'Series C' (corgi: brief only says funding round)", () => {
  const u = findUngroundedStageLabels(
    "Corgi just raised $250M. Series C.",
    "Announce Corgi's $250M funding round and introduce the product.",
  );
  assert(u.length === 1 && /series c/i.test(u[0]), `expected Series C, got ${JSON.stringify(u)}`);
});
check("a grounded stage (stated in source) → not flagged", () => {
  const u = findUngroundedStageLabels("Our Series B is closed", "We just closed our Series B round.");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("pre-seed grounded across hyphen/space normalization", () => {
  const u = findUngroundedStageLabels("Built at pre-seed", "raised at preseed stage");
  assert(u.length === 0, `expected none (normalized match), got ${JSON.stringify(u)}`);
});
check("ordinary copy with 'series of' / 'a series' is NOT flagged", () => {
  const u = findUngroundedStageLabels("a series of breakthroughs, Series Capital partners", "");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("flags growth/bridge round when unsupported; dedupes", () => {
  const u = findUngroundedStageLabels("Closed a growth round. The growth round scales us.", "");
  assert(u.length === 1 && /growth round/i.test(u[0]), `expected one growth round, got ${JSON.stringify(u)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
