/**
 * Tests for usage accounting + cache-aware pricing.
 *
 * Run: `npm test`. The subtle part is prompt-cache pricing — cache READS bill
 * at 10% of the input rate and cache WRITES at 125% — so these lock that math
 * down. No API key, no network.
 */
import { usageOf, addUsage, costUsd, EMPTY_USAGE, type Usage } from "./usage";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const near = (a: number, b: number, eps = 1e-9) =>
  Math.abs(a - b) <= eps || `expected ${a} ≈ ${b}`;
const ok = (v: true | string) => {
  if (v !== true) throw new Error(v);
};

const U = (
  i: number,
  o: number,
  cc = 0,
  cr = 0,
): Usage => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr,
});

console.log("usage");

check("usageOf coerces null/undefined cache fields to 0", () => {
  const u = usageOf({ input_tokens: 10, output_tokens: 5 });
  assert(u.cache_creation_input_tokens === 0, "cache_creation should default 0");
  assert(u.cache_read_input_tokens === 0, "cache_read should default 0");
  assert(u.input_tokens === 10 && u.output_tokens === 5, "in/out preserved");
});

check("usageOf reads cache fields when present", () => {
  const u = usageOf({
    input_tokens: 1,
    output_tokens: 2,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 4,
  });
  assert(u.cache_creation_input_tokens === 3 && u.cache_read_input_tokens === 4, "cache fields read");
});

check("usageOf(null) → all zeros", () => {
  const u = usageOf(null);
  assert(
    u.input_tokens === 0 &&
      u.output_tokens === 0 &&
      u.cache_creation_input_tokens === 0 &&
      u.cache_read_input_tokens === 0,
    "null → EMPTY",
  );
});

check("addUsage sums all four fields", () => {
  const s = addUsage(U(1, 2, 3, 4), U(10, 20, 30, 40));
  assert(s.input_tokens === 11, "input");
  assert(s.output_tokens === 22, "output");
  assert(s.cache_creation_input_tokens === 33, "cache_creation");
  assert(s.cache_read_input_tokens === 44, "cache_read");
});

check("EMPTY_USAGE is the additive identity", () => {
  const s = addUsage(EMPTY_USAGE, U(5, 6, 7, 8));
  assert(
    s.input_tokens === 5 && s.output_tokens === 6 && s.cache_creation_input_tokens === 7 && s.cache_read_input_tokens === 8,
    "identity",
  );
});

check("Fable base rate: 1M in = $10, 1M out = $50", () => {
  ok(near(costUsd("claude-fable-5", U(1_000_000, 0)), 10));
  ok(near(costUsd("claude-fable-5", U(0, 1_000_000)), 50));
});

check("Opus base rate: 1M in = $5, 1M out = $25", () => {
  ok(near(costUsd("claude-opus-4-8", U(1_000_000, 0)), 5));
  ok(near(costUsd("claude-opus-4-8", U(0, 1_000_000)), 25));
});

check("Sonnet base rate: 1M in = $3, 1M out = $15", () => {
  ok(near(costUsd("claude-sonnet-4-5", U(1_000_000, 0)), 3));
  ok(near(costUsd("claude-sonnet-4-5", U(0, 1_000_000)), 15));
});

check("Haiku base rate: 1M in = $1, 1M out = $5", () => {
  ok(near(costUsd("claude-haiku-4-5", U(1_000_000, 0)), 1));
  ok(near(costUsd("claude-haiku-4-5", U(0, 1_000_000)), 5));
});

check("cache READ bills at 10% of input rate (Opus)", () => {
  // 1M cache-read tokens on Opus = 0.10 × $5 = $0.50
  ok(near(costUsd("claude-opus-4-8", U(0, 0, 0, 1_000_000)), 0.5));
});

check("cache WRITE bills at 125% of input rate (Opus)", () => {
  // 1M cache-creation tokens on Opus = 1.25 × $5 = $6.25
  ok(near(costUsd("claude-opus-4-8", U(0, 0, 1_000_000, 0)), 6.25));
});

check("caching makes a cached-heavy build far cheaper than naive input pricing", () => {
  // Realistic Opus build: 5k fresh input, 10k output, 110k cache read (the
  // big cached system prompt), 0 cache write.
  const u = U(5_000, 10_000, 0, 110_000);
  const real = costUsd("claude-opus-4-8", u);
  // Naive (treat ALL input — fresh + cache — at full $5/M):
  const naive = (115_000 * 5 + 10_000 * 25) / 1e6;
  assert(real < naive, "cache-aware cost must be below naive full-rate cost");
  // Exact: (5000*5 + 10000*25 + 110000*5*0.1)/1e6 = (25000+250000+55000)/1e6
  ok(near(real, 0.33));
});

check("unknown model falls back to Sonnet pricing (no NaN)", () => {
  const c = costUsd("some-future-model", U(1_000_000, 0));
  ok(near(c, 3));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
