/**
 * Tests for the self-repair ladder. All I/O is mocked, so the escalation
 * decisions (L1→L2→L3→L4), the cost ceiling, and the pass/repair/exhausted
 * outcomes are verified without any real build or render spend.
 */
import { repairRenderTruth, type GateResult, type RepairStepResult } from "./render-truth-repair";
import type { RenderTruthFinding } from "./render-truth-gates";
import type { Usage } from "../usage";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const blocking = (scene: number): RenderTruthFinding => ({ scene, kind: "overflow", detail: `scene ${scene} clipped` });
const gate = (block: number[]): GateResult => ({
  findings: block.map(blocking),
  blocking: block.map(blocking),
});
const U = (out: number): Usage => ({ input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

// Build a callbacks object that returns measure() results from a queue and
// records regen/rewrite calls. costOf is identity-on-output for easy math.
const mk = (measureQueue: GateResult[], stepResult: RepairStepResult = { ok: true, usage: U(0) }) => {
  const calls = { regen: [] as number[], rewrite: [] as number[][], measures: 0 };
  let i = 0;
  return {
    calls,
    cb: {
      measure: async () => { calls.measures++; return measureQueue[Math.min(i++, measureQueue.length - 1)]; },
      regenScene: async (s: number) => { calls.regen.push(s); return stepResult; },
      rewriteScript: async (s: number[]) => { calls.rewrite.push(s); return stepResult; },
      costOf: (u: Usage) => u.output_tokens, // 1 token = $1 for test math
    },
  };
};

console.log("render-truth-repair");

await check("clean build passes immediately, no repairs", async () => {
  const { cb, calls } = mk([gate([])]);
  const r = await repairRenderTruth(cb);
  assert(r.ok && r.reason === "passed", `got ${r.reason}`);
  assert(calls.regen.length === 0 && calls.rewrite.length === 0, "should not repair");
});

await check("L1 design retry fixes it → repaired", async () => {
  const { cb, calls } = mk([gate([2]), gate([])], { ok: true, usage: U(1) });
  const r = await repairRenderTruth(cb);
  assert(r.ok && r.reason === "repaired", `got ${r.reason}`);
  assert(calls.regen.length === 1 && calls.regen[0] === 2, `regen=${JSON.stringify(calls.regen)}`);
  assert(calls.rewrite.length === 0, "should not reach L3");
});

await check("L1+L2 fail, L3 script rewrite fixes it → repaired", async () => {
  const { cb, calls } = mk([gate([1]), gate([1]), gate([1]), gate([])], { ok: true, usage: U(1) });
  const r = await repairRenderTruth(cb);
  assert(r.ok && r.reason === "repaired", `got ${r.reason}`);
  assert(calls.regen.length === 2, `expected 2 design retries, got ${calls.regen.length}`);
  assert(calls.rewrite.length === 1 && calls.rewrite[0][0] === 1, `rewrite=${JSON.stringify(calls.rewrite)}`);
});

await check("nothing fixes it → ladder-exhausted, ok:false", async () => {
  const { cb } = mk([gate([3]), gate([3]), gate([3]), gate([3])], { ok: true, usage: U(1) });
  const r = await repairRenderTruth(cb);
  assert(!r.ok && r.reason === "ladder-exhausted", `got ${r.reason}`);
  assert(r.blocking.length === 1 && r.blocking[0].scene === 3, "final blocking carried");
});

await check("a pure measure-error short-circuits — no paid repair, reason measure-error", async () => {
  const me: RenderTruthFinding = { scene: 0, kind: "measure-error", detail: "playwright chromium not installed" };
  const { cb, calls } = mk([{ findings: [me], blocking: [me] }]);
  const r = await repairRenderTruth(cb);
  assert(!r.ok && r.reason === "measure-error", `got ${r.reason}`);
  assert(calls.regen.length === 0 && calls.rewrite.length === 0, "must not spend Opus on an unfixable measure-error");
  assert(calls.measures === 1, `should measure once and stop, got ${calls.measures}`);
});

await check("a mix of measure-error + overflow still runs the ladder (overflow may be fixable)", async () => {
  const me: RenderTruthFinding = { scene: 0, kind: "measure-error", detail: "x" };
  const ov: RenderTruthFinding = { scene: 1, kind: "overflow", detail: "clipped" };
  const { cb, calls } = mk([{ findings: [me, ov], blocking: [me, ov] }, gate([])], { ok: true, usage: U(1) });
  const r = await repairRenderTruth(cb);
  assert(r.ok && r.reason === "repaired", `got ${r.reason}`);
  assert(calls.regen.length === 2, `both failing scenes regenerated, got ${calls.regen.length}`);
});

await check("cost ceiling stops before the first paid retry", async () => {
  const { cb, calls } = mk([gate([0])], { ok: true, usage: U(1) });
  const r = await repairRenderTruth(cb, { spentSoFarUsd: 10, ceilingUsd: 10 });
  assert(!r.ok && r.reason === "cost-ceiling", `got ${r.reason}`);
  assert(calls.regen.length === 0, "must not spend past the ceiling");
});

await check("cost ceiling stops mid-ladder once spend accrues", async () => {
  // ceiling 5; each design retry on one scene spends $3. L1 → $3, still blocking;
  // before L2, $3 < $5 so L2 runs → $6; before L3, $6 >= $5 → stop.
  const { cb, calls } = mk([gate([1]), gate([1]), gate([1])], { ok: true, usage: U(3) });
  const r = await repairRenderTruth(cb, { ceilingUsd: 5 });
  assert(!r.ok && r.reason === "cost-ceiling", `got ${r.reason}`);
  assert(calls.regen.length === 2 && calls.rewrite.length === 0, `regen=${calls.regen.length} rewrite=${calls.rewrite.length}`);
  assert(r.spentUsd === 6, `spent=${r.spentUsd}`);
});

await check("multiple failing scenes are each regenerated in L1", async () => {
  const { cb, calls } = mk([gate([1, 3]), gate([])], { ok: true, usage: U(1) });
  const r = await repairRenderTruth(cb);
  assert(r.ok && r.reason === "repaired", `got ${r.reason}`);
  assert(calls.regen.length === 2 && calls.regen.includes(1) && calls.regen.includes(3), `regen=${JSON.stringify(calls.regen)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
