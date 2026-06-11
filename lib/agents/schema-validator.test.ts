/**
 * Regression tests for headlineProblem (QA S4) — hero headlines must be one
 * punchy clause, not a crammed headline+subhead. Run: `npm test`.
 */
import {
  headlineProblem,
  findUngroundedClaims,
  findUngroundedStageLabels,
  extractStatClaims,
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

// ── S5 tightened (the fabricated-38ms fix): full-token grounding ─────────
// Raycast's crawl says "Fast. Think in milliseconds." and "99.8% crash-free
// rate" — it contains NO latency number. Sonnet invented "38ms" / "38ms p50"
// at script time and the old digit-core matching let lookalike digits launder
// such fabrications. These pin the full-token behavior.
const RAYCAST_CRAWL =
  "Fast. Think in milliseconds. Ergonomic. Keyboard First. Native. Pure performance. Reliable. 99.8% crash-free rate.";

check("38ms-style fabricated latency → flagged (crawl has no latency number)", () => {
  const u = findUngroundedClaims("38ms Raycast executes in 38ms p50", RAYCAST_CRAWL);
  assert(u.includes("38ms"), `expected 38ms flagged, got ${JSON.stringify(u)}`);
  assert(u.includes("p50"), `expected p50 flagged, got ${JSON.stringify(u)}`);
});

check("99.8% crawl-grounded → accepted", () => {
  const u = findUngroundedClaims("99.8% crash-free", RAYCAST_CRAWL);
  assert(u.length === 0, `99.8% is in the crawl → grounded, got ${JSON.stringify(u)}`);
});

check("prompt-grounded duration ('30-second') → accepted", () => {
  const u = findUngroundedClaims(
    "Your story in 30 seconds. A 30-second launch.",
    "A 30-second video for Raycast — a blazing-fast launcher.",
  );
  assert(u.length === 0, `30s duration is in the prompt → grounded, got ${JSON.stringify(u)}`);
});

check("digit-core lookalikes do NOT cross-ground", () => {
  // "3x" must not ground on the "3" inside "30-second".
  const a = findUngroundedClaims("3x faster", "A 30-second video for Raycast.");
  assert(a.includes("3x"), `expected 3x flagged, got ${JSON.stringify(a)}`);
  // "38ms" must not ground on a unitless "38".
  const b = findUngroundedClaims("38ms", "Browse all 38 extensions in the store.");
  assert(b.includes("38ms"), `expected 38ms flagged, got ${JSON.stringify(b)}`);
  // "10x" must not ground on the "10" inside "2010" (old digit-core bug).
  const c = findUngroundedClaims("10x faster", "Trusted since 2010.");
  assert(c.includes("10x"), `expected 10x flagged, got ${JSON.stringify(c)}`);
  // "99.8%" must not ground on a bare "99.8" with a different unit.
  const d = findUngroundedClaims("99.8% uptime", "scored 99.8 in the benchmark");
  assert(d.some((t) => t.includes("99.8")), `expected 99.8% flagged, got ${JSON.stringify(d)}`);
});

check("full token grounds across unit spellings", () => {
  assert(
    findUngroundedClaims("38ms response", "executes in 38 ms flat").length === 0,
    "38ms should ground on '38 ms'",
  );
  assert(
    findUngroundedClaims("responds in 200 milliseconds", "200ms cold start").length === 0,
    "'200 milliseconds' should ground on '200ms'",
  );
  assert(
    findUngroundedClaims("10x faster", "10 times faster than stock").length === 0,
    "10x should ground on '10 times'",
  );
  assert(
    findUngroundedClaims("p99 latency under control", "our p99 stays flat").length === 0,
    "p99 should ground on a literal p99",
  );
});

check("extractStatClaims pulls full stat tokens, skips safe forms", () => {
  const t = extractStatClaims(
    "38ms p50, 99.8% crash-free, $2.4M raised, 10x faster, founded 2024, 3 weeks, 5 principles",
  );
  assert(t.includes("38ms"), `expected 38ms, got ${JSON.stringify(t)}`);
  assert(t.includes("p50"), `expected p50, got ${JSON.stringify(t)}`);
  assert(t.includes("99.8%"), `expected 99.8%, got ${JSON.stringify(t)}`);
  assert(t.includes("$2.4M"), `expected $2.4M, got ${JSON.stringify(t)}`);
  assert(t.includes("10x"), `expected 10x, got ${JSON.stringify(t)}`);
  assert(
    !t.some((x) => /2024|weeks|principles/.test(x)),
    `years/durations/ordinals must be out of scope, got ${JSON.stringify(t)}`,
  );
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
