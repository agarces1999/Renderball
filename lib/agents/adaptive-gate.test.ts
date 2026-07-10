/**
 * Tests for the adaptive concurrency gate: starts at max, halves on overload
 * signals, recovers additively, never stalls, never drops below 1, and the
 * gate-based map preserves order + failure isolation.
 */
import { AdaptiveGate, mapWithGate, isOverloadSignal } from "./adaptive-gate";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("adaptive-gate");

await check("starts wide open at max", () => {
  const g = new AdaptiveGate(5);
  assert(g.width === 5, `width ${g.width}`);
});

await check("overload halves; floors at min 1; success recovers +1 to max", () => {
  const g = new AdaptiveGate(8, 1, 0); // debounce 0: exercise consecutive shrinks
  g.overload();
  assert(g.width === 4, `8→4, got ${g.width}`);
  g.overload();
  assert(g.width === 2, `4→2, got ${g.width}`);
  g.overload();
  g.overload();
  g.overload();
  assert(g.width === 1, `floors at 1, got ${g.width}`);
  for (let i = 0; i < 20; i++) g.success();
  assert(g.width === 8, `recovers to max 8, got ${g.width}`);
  // Counts actual SHRINKS (8→4→2→1 = 3); signals at the floor are no-ops.
  assert(g.overloads === 3, `overload count tracks real shrinks, got ${g.overloads}`);
});

await check("mapWithGate: never exceeds the current window, adapts mid-batch", async () => {
  const g = new AdaptiveGate(4);
  let inFlight = 0;
  let peak = 0;
  let peakAfterShrink = 0;
  let shrunk = false;
  await mapWithGate(Array.from({ length: 12 }, (_, i) => i), g, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (shrunk) peakAfterShrink = Math.max(peakAfterShrink, inFlight);
    if (n === 2 && !shrunk) {
      shrunk = true;
      g.overload(); // 4 → 2 mid-batch
      g.overload(); // 2 → 1  (successes will claw back)
    }
    await sleep(8);
    inFlight--;
    return n;
  });
  assert(peak <= 4, `peak ${peak} within initial window`);
  assert(peakAfterShrink <= 4, `post-shrink respects the (recovering) window: ${peakAfterShrink}`);
});

await check("mapWithGate: order preserved, a throwing item never kills the batch", async () => {
  const g = new AdaptiveGate(3);
  const out = await mapWithGate([0, 1, 2, 3, 4], g, async (n) => {
    if (n === 3) throw new Error("boom");
    return n * 10;
  });
  assert(out.length === 5, "all slots settle");
  assert(out[3].status === "rejected", "the thrower is rejected");
  assert(
    out.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<number>).value).join(",") === "0,10,20,40",
    "order + values preserved",
  );
});

await check("mapWithGate: window of 1 still completes everything (no stall)", async () => {
  const g = new AdaptiveGate(1);
  const out = await mapWithGate([1, 2, 3, 4], g, async (n) => { await sleep(3); return n; });
  assert(out.every((r) => r.status === "fulfilled"), "all complete serially");
});

await check("isOverloadSignal: overload shapes yes; balance + network no", () => {
  assert(isOverloadSignal(new Error('429 {"type":"error","error":{"type":"overloaded_error","code":"500"}}')), "overloaded_error");
  assert(isOverloadSignal(new Error("[1305] 该模型当前访问量过大")), "capacity 1305");
  // [1302] is z.ai's ACTUAL account-concurrency throttle — the one error that
  // genuinely means "you personally are sending too much".
  assert(isOverloadSignal(new Error('429 [1302] Rate limit reached for requests')), "account throttle 1302");
  assert(!isOverloadSignal(new Error("[1113][Insufficient balance or no resource package]")), "balance is NOT load — shrinking cannot fix it");
  assert(!isOverloadSignal(new Error("read ETIMEDOUT")), "network timeout is not an overload signal");
  assert(!isOverloadSignal(new Error("getaddrinfo ENOTFOUND api.z.ai")), "DNS death is not an overload signal");
});

await check("debounce: a burst of signals from one incident causes ONE halving", () => {
  const g = new AdaptiveGate(8);
  g.overload(); // 8 → 4
  g.overload(); // same incident window — ignored
  g.overload(); // ignored
  assert(g.width === 4, `one incident = one halving, got ${g.width}`);
  assert(g.overloads === 1, `one shrink recorded, got ${g.overloads}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
