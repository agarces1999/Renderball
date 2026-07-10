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
