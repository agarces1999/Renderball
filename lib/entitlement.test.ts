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

check("free plan defaults: 3 generates, 1 build per month", () => {
  assert(planLimit("free", "generate") === 3, `generate ${planLimit("free", "generate")}`);
  assert(planLimit("free", "build") === 1, `build ${planLimit("free", "build")}`);
});

check("subscription defaults: 60 generates, 30 builds", () => {
  assert(planLimit("subscription", "generate") === 60, "generates");
  assert(planLimit("subscription", "build") === 30, "builds");
});

check("under the limit → allowed with counts attached", () => {
  const e = decideEntitlement("free", "build", 0);
  assert(e.allowed && e.used === 0 && e.limit === 1 && !e.reason, JSON.stringify(e));
});

check("at the limit → denied with an upgrade-worded reason on free", () => {
  const e = decideEntitlement("free", "build", 1);
  assert(!e.allowed && /Upgrade/.test(e.reason ?? ""), JSON.stringify(e));
});

check("subscription denial words the reset, not an upgrade", () => {
  const e = decideEntitlement("subscription", "build", 30);
  assert(!e.allowed && /resets/.test(e.reason ?? "") && !/Upgrade/.test(e.reason ?? ""), JSON.stringify(e));
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
