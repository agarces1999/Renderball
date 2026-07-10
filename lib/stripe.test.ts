/**
 * Tests for the pure plan-transition mapping — the ONLY place that decides
 * whether a Stripe subscription status grants the paid plan. The webhook
 * (app/api/webhooks/stripe) applies whatever this returns, so a wrong row
 * here means paying users locked out or churned users generating for free.
 */
import { planForSubscriptionStatus } from "./stripe";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("stripe plan mapping");

check("paying / granted-access statuses → subscription", () => {
  assert(planForSubscriptionStatus("active") === "subscription", "active");
  assert(planForSubscriptionStatus("trialing") === "subscription", "trialing");
  // past_due = Stripe is still retrying the card (dunning) — keep access.
  assert(planForSubscriptionStatus("past_due") === "subscription", "past_due");
});

check("terminal statuses → free", () => {
  for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    assert(planForSubscriptionStatus(s) === "free", s);
  }
});

check("garbage / missing input fails CLOSED to free", () => {
  assert(planForSubscriptionStatus(null) === "free", "null");
  assert(planForSubscriptionStatus(undefined) === "free", "undefined");
  assert(planForSubscriptionStatus("") === "free", "empty string");
  assert(planForSubscriptionStatus("ACTIVE") === "free", "case matters — Stripe statuses are lowercase");
  assert(planForSubscriptionStatus("some_future_status") === "free", "unknown status");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
