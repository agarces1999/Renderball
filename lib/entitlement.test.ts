/**
 * Tests for the metering gate's pure decision logic (LAUNCH.md #4).
 * The Prisma IO wrapper is thin; the policy lives in decideEntitlement.
 */
import { decideEntitlement, planLimit } from "./entitlement";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("entitlement");

// The free build limit must not undercut what the landing sells — "your
// first 1,000,000 tokens are free (about three decks)". At 1, users hit a
// wall at a third of the advertised allowance.
check("free plan backstop defaults: 100 generates, 25 builds", () => {
  assert(planLimit("free", "generate") === 100, "generate " + planLimit("free", "generate"));
  assert(planLimit("free", "build") === 25, "build " + planLimit("free", "build"));
});

check("subscription backstop defaults: 200 generates, 100 builds", () => {
  assert(planLimit("subscription", "generate") === 200, "generates");
  assert(planLimit("subscription", "build") === 100, "builds");
});

check("under the limit → allowed with counts attached", () => {
  const r = decideEntitlement("free", "build", 24);
  assert(r.allowed && r.used === 24 && r.limit === 25, JSON.stringify(r));
});

check("at the backstop → denied in SAFETY-CAP language, never as the offer", () => {
  // The count caps stopped being the product on 2026-08-13 — the advertised
  // free tier is tokens. A user this deep is an anomaly; the copy must say
  // "safety limit" and route to a human, and must NOT present the number as
  // the plan ("this month's free allowance" was the old subscription-era
  // framing the founder caught contradicting the landing page).
  const r = decideEntitlement("free", "build", 25);
  assert(!r.allowed, "denied at the backstop");
  assert(/safety/i.test(r.reason ?? ""), `must name itself a safety limit: ${r.reason}`);
  assert(/support@renderball\.com/.test(r.reason ?? ""), "routes to a human");
  assert(!/free allowance/i.test(r.reason ?? ""), "must not claim to be the offer");
});

check("subscription backstop uses the same safety-cap language", () => {
  const r = decideEntitlement("subscription", "build", 100);
  assert(!r.allowed && /safety/i.test(r.reason ?? ""), JSON.stringify(r));
});

check("env override changes the limit", () => {
  const prev = process.env.FREE_BUILDS_PER_MONTH;
  process.env.FREE_BUILDS_PER_MONTH = "5";
  try {
    assert(planLimit("free", "build") === 5, "override");
    assert(decideEntitlement("free", "build", 4).allowed, "4/5 allowed");
    assert(!decideEntitlement("free", "build", 5).allowed, "5/5 denied");
  } finally {
    if (prev === undefined) delete process.env.FREE_BUILDS_PER_MONTH;
    else process.env.FREE_BUILDS_PER_MONTH = prev;
  }
});

check("a zero limit denies immediately (kill-switch semantics)", () => {
  const prev = process.env.FREE_GENERATES_PER_MONTH;
  process.env.FREE_GENERATES_PER_MONTH = "0";
  try {
    assert(!decideEntitlement("free", "generate", 0).allowed, "0-limit must deny");
  } finally {
    if (prev === undefined) delete process.env.FREE_GENERATES_PER_MONTH;
    else process.env.FREE_GENERATES_PER_MONTH = prev;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
