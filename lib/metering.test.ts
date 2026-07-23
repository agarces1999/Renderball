/**
 * Tests for the token-metering policy (docs/METERING.md). All the money-math
 * is pure — mode parsing, token counting, the allowance gate, and the
 * billable-overage watermark — so the Prisma/Stripe IO wrappers stay thin.
 */
import {
  meteringModeOf,
  countedTokens,
  freeTokenAllowance,
  decideTokenGate,
  computeBillableDelta,
  formatTokens,
} from "./metering";
import { EMPTY_USAGE } from "./usage";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("metering");

// ── mode parsing ──────────────────────────────────────────────────────────

check("RB_METERING defaults off; unset/garbage never enable", () => {
  assert(meteringModeOf(undefined) === "off", "undefined");
  assert(meteringModeOf("") === "off", "empty");
  assert(meteringModeOf("yes-please") === "off", "garbage");
  assert(meteringModeOf("OFF") === "off", "OFF");
});

check("on/enforce/1/true → on; count/shadow → count (case-insensitive)", () => {
  for (const v of ["on", "ON", "enforce", "1", "true"]) assert(meteringModeOf(v) === "on", v);
  for (const v of ["count", "COUNT", "shadow"]) assert(meteringModeOf(v) === "count", v);
});

// ── token counting ────────────────────────────────────────────────────────

check("countedTokens = input + output; cache fields excluded by design", () => {
  const n = countedTokens({
    input_tokens: 1000,
    output_tokens: 250,
    cache_creation_input_tokens: 9999,
    cache_read_input_tokens: 8888,
  });
  assert(n === 1250, `got ${n}`);
  assert(countedTokens(EMPTY_USAGE) === 0, "empty usage counts 0");
});

check("free allowance defaults to 1M; env overrides; bad env falls back", () => {
  const prev = process.env.RB_FREE_TOKENS;
  try {
    delete process.env.RB_FREE_TOKENS;
    assert(freeTokenAllowance() === 1_000_000, "default");
    process.env.RB_FREE_TOKENS = "2000000";
    assert(freeTokenAllowance() === 2_000_000, "override");
    process.env.RB_FREE_TOKENS = "not-a-number";
    assert(freeTokenAllowance() === 1_000_000, "bad env → default");
    process.env.RB_FREE_TOKENS = "-5";
    assert(freeTokenAllowance() === 1_000_000, "negative → default");
  } finally {
    if (prev === undefined) delete process.env.RB_FREE_TOKENS;
    else process.env.RB_FREE_TOKENS = prev;
  }
});

// ── the allowance gate ────────────────────────────────────────────────────

const FREE = 1_000_000;

check("modes off/count always allow, even far past the allowance", () => {
  for (const mode of ["off", "count"] as const) {
    const g = decideTokenGate({ mode, usedTokens: 50 * FREE, freeTokens: FREE, billingActive: false });
    assert(g.allowed && !g.reason, `${mode} must allow`);
  }
});

check("on: under the allowance → allowed with remaining attached", () => {
  const g = decideTokenGate({ mode: "on", usedTokens: 400_000, freeTokens: FREE, billingActive: false });
  assert(g.allowed && g.freeRemaining === 600_000, JSON.stringify(g));
});

check("on: AT the allowance without billing → denied (boundary is closed)", () => {
  const g = decideTokenGate({ mode: "on", usedTokens: FREE, freeTokens: FREE, billingActive: false });
  assert(!g.allowed, "must deny at exactly the allowance");
  assert(/free tokens/i.test(g.reason ?? ""), `reason mentions free tokens: ${g.reason}`);
  assert(/billing/i.test(g.reason ?? ""), `reason points at billing: ${g.reason}`);
  assert(/editing/i.test(g.reason ?? ""), `reason keeps the editing-is-free story: ${g.reason}`);
});

check("on: over the allowance WITH active billing → allowed (metered instead)", () => {
  const g = decideTokenGate({ mode: "on", usedTokens: 3 * FREE, freeTokens: FREE, billingActive: true });
  assert(g.allowed && g.billingActive, JSON.stringify(g));
});

check("freeRemaining clamps at 0 past the allowance", () => {
  const g = decideTokenGate({ mode: "on", usedTokens: 2 * FREE, freeTokens: FREE, billingActive: true });
  assert(g.freeRemaining === 0, `got ${g.freeRemaining}`);
});

check("a zero allowance denies free users immediately (kill-switch semantics)", () => {
  const g = decideTokenGate({ mode: "on", usedTokens: 0, freeTokens: 0, billingActive: false });
  assert(!g.allowed, "0-allowance must deny");
});

// ── billable-overage watermark ────────────────────────────────────────────

check("fully inside the allowance → nothing billable, watermark untouched", () => {
  const d = computeBillableDelta({ totalTokens: 900_000, opTokens: 100_000, billedTokens: 0, freeTokens: FREE });
  assert(d.emit === 0 && d.newBilled === 0, JSON.stringify(d));
});

check("op straddling the boundary bills only the over-the-line share", () => {
  // 950k → 1.05M: 50k of this 100k op is overage.
  const d = computeBillableDelta({ totalTokens: 1_050_000, opTokens: 100_000, billedTokens: 0, freeTokens: FREE });
  assert(d.emit === 50_000, `emit ${d.emit}`);
  assert(d.newBilled === 50_000, `watermark ${d.newBilled}`);
});

check("fully past the allowance → the whole op is billable", () => {
  const d = computeBillableDelta({ totalTokens: 1_550_000, opTokens: 100_000, billedTokens: 450_000, freeTokens: FREE });
  assert(d.emit === 100_000 && d.newBilled === 550_000, JSON.stringify(d));
});

check("pre-subscription overage is FORGIVEN, never back-billed", () => {
  // 500k of overage accrued while unbilled (count mode / free tail); the first
  // billed op emits at most ITS OWN tokens and reconciles the rest silently.
  const d = computeBillableDelta({ totalTokens: 1_500_000, opTokens: 10_000, billedTokens: 0, freeTokens: FREE });
  assert(d.emit === 10_000, `emit ${d.emit} (must clamp to the op)`);
  assert(d.newBilled === 500_000, `watermark ${d.newBilled} (history reconciled)`);
});

check("raising the allowance later never produces negative deltas", () => {
  // Watermark sits at 500k; allowance is then raised so overage math goes negative.
  const d = computeBillableDelta({ totalTokens: 1_500_000, opTokens: 10_000, billedTokens: 500_000, freeTokens: 2_000_000 });
  assert(d.emit === 0, `emit ${d.emit}`);
  assert(d.newBilled === 500_000, `watermark must stay monotone, got ${d.newBilled}`);
});

check("successive ops emit exactly their overage (no gaps, no double-bill)", () => {
  let total = 990_000;
  let billed = 0;
  let emitted = 0;
  for (const op of [20_000, 30_000, 50_000]) {
    total += op;
    const d = computeBillableDelta({ totalTokens: total, opTokens: op, billedTokens: billed, freeTokens: FREE });
    billed = d.newBilled;
    emitted += d.emit;
  }
  // 990k + 100k = 1.09M → 90k total overage, all attributed.
  assert(emitted === 90_000, `emitted ${emitted}`);
  assert(billed === 90_000, `watermark ${billed}`);
});

// ── copy helpers ──────────────────────────────────────────────────────────

check("formatTokens: friendly figures for allowance copy", () => {
  assert(formatTokens(1_000_000) === "1M", formatTokens(1_000_000));
  assert(formatTokens(2_500_000) === "2.5M", formatTokens(2_500_000));
  assert(formatTokens(500_000) === "500k", formatTokens(500_000));
  assert(formatTokens(1_234) === "1234", formatTokens(1_234));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
