/**
 * Tests for the z.ai balance circuit breaker — the twice-proven [1113] outage
 * (2026-07-08, 2026-07-09). Proves: narrow classification, trip → fast-fail,
 * half-open single probe after cooldown, success closes, and that overloads /
 * network faults never trip it (those belong to the retry ladder + adaptive gate).
 */
import {
  isBalanceError,
  noteZaiError,
  noteZaiSuccess,
  assertZaiAvailable,
  zaiBreakerState,
  resetZaiBreakerForTests,
  ZaiUnavailableError,
} from "./zai-breaker";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
  resetZaiBreakerForTests();
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const THE_REAL_1113 =
  '429 {"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"[1113][Insufficient balance or no resource package. Please recharge.][20260710063202126b3efb95d74885]"}}';

console.log("zai-breaker");

check("isBalanceError: the real 1113 string yes; overload/network/1302 no", () => {
  assert(isBalanceError(new Error(THE_REAL_1113)), "verbatim production 1113");
  assert(!isBalanceError(new Error('{"type":"overloaded_error","code":"500"}')), "overload is not balance");
  assert(!isBalanceError(new Error("[1302] Rate limit reached for requests")), "account throttle is not balance");
  assert(!isBalanceError(new Error("read ETIMEDOUT")), "network is not balance");
});

// The stack moved to Fireworks (CLAUDE.md 2026-07-23) while this matcher
// still recognised only z.ai's vocabulary, so the breaker could no longer
// trip on the provider actually in use — five call sites consulted a circuit
// that nothing could open.
check("isBalanceError: HTTP 402 (by status, not substring) trips it", () => {
  const e = Object.assign(new Error("cast HTTP 402: payment required"), { status: 402 });
  assert(isBalanceError(e), "402 status");
});

// The dangerous direction. This breaker stops ALL generation for a cooldown,
// so a false positive is a self-inflicted outage. An earlier keyword
// heuristic (money noun + exhaustion verb) tripped on every 429 vocabulary
// providers actually emit for ordinary throttling — measured against real
// body shapes. Rate limiting is the retry ladder's job, not the breaker's.
check("isBalanceError: real 429 throttling bodies NEVER trip it", () => {
  for (const msg of [
    'cast HTTP 429: {"error":{"message":"Quota exceeded for requests per minute. Please retry."}}',
    'cast HTTP 429: {"error":{"message":"Rate limit reached for model; your account limit is 600 RPM"}}',
    'cast HTTP 429: {"error":{"message":"Too many concurrent requests. See billing docs; upgrade required"}}',
  ]) {
    const e = Object.assign(new Error(msg), { status: 429 });
    assert(!isBalanceError(e), msg.slice(0, 60));
  }
});

// "402" appears inside unrelated provider text; only the STATUS counts.
check("isBalanceError: a 402 substring in other errors does not trip it", () => {
  for (const [msg, status] of [
    ["cast HTTP 503: error code 402 upstream connect error", 503],
    ["cast HTTP 400: invalid max_tokens: 402 exceeds limit", 400],
  ] as const) {
    const e = Object.assign(new Error(msg), { status });
    assert(!isBalanceError(e), msg);
  }
});

// The dangerous direction: a false positive takes ALL generation down until
// the cooldown probe. Ordinary throttling and faults must never trip it.
check("isBalanceError: ordinary failures never trip the breaker", () => {
  for (const msg of [
    "cast HTTP 429: rate limit exceeded, please retry",
    "cast HTTP 503: model overloaded",
    "cast transport error: ECONNRESET",
    "cast HTTP 400: invalid messages",
    "cast HTTP 500: internal error",
    "cast HTTP 400: maximum context length exceeded",
  ]) {
    assert(!isBalanceError(new Error(msg)), msg);
  }
});

check("closed by default: assertZaiAvailable is a no-op", () => {
  assertZaiAvailable(); // must not throw
  assert(!zaiBreakerState().open, "starts closed");
});

check("noteZaiError on 1113 trips; subsequent asserts fail fast with the friendly error", () => {
  assert(noteZaiError(new Error(THE_REAL_1113)) === true, "reports the trip");
  assert(zaiBreakerState().open, "circuit open");
  let threw: unknown = null;
  try { assertZaiAvailable(); } catch (e) { threw = e; }
  assert(threw instanceof ZaiUnavailableError, "fails fast");
  assert(/temporarily unavailable/.test((threw as ZaiUnavailableError).friendly), "friendly message present");
});

check("non-balance errors never trip", () => {
  assert(noteZaiError(new Error("overloaded_error")) === false, "overload ignored");
  assert(noteZaiError(new Error("getaddrinfo ENOTFOUND api.z.ai")) === false, "DNS ignored");
  assert(!zaiBreakerState().open, "still closed");
});

check("half-open after cooldown: exactly ONE probe passes, others still fail", () => {
  noteZaiError(new Error(THE_REAL_1113));
  const realNow = Date.now;
  try {
    (Date as unknown as { now: () => number }).now = () => realNow() + 11 * 60 * 1000;
    assertZaiAvailable(); // the probe — must NOT throw
    let threw = false;
    try { assertZaiAvailable(); } catch { threw = true; }
    assert(threw, "second caller during the probe still fails fast");
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }
});

check("success closes a tripped breaker", () => {
  noteZaiError(new Error(THE_REAL_1113));
  noteZaiSuccess();
  assert(!zaiBreakerState().open, "closed after success");
  assertZaiAvailable(); // no throw
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
