/**
 * Tests for the build concurrency guards: per-script dedup (refresh attaches,
 * never double-builds), per-owner in-flight guard (entitlement TOCTOU closed),
 * global semaphore (container protection), and lock cleanup on success AND
 * failure. Uses unique script/owner ids per case — the lock state is
 * module-level, mirroring production.
 */
import { runBuildLocked, buildLockState } from "./build-lock";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("build-lock");

await check("dedup: a second request for the SAME script attaches — fn runs once", async () => {
  let calls = 0;
  const fn = async () => { calls++; await sleep(20); return "built"; };
  const [a, b] = await Promise.all([
    runBuildLocked("script-dedup", "owner-a", fn),
    (async () => { await sleep(5); return runBuildLocked("script-dedup", "owner-a", fn); })(),
  ]);
  assert(calls === 1, `fn ran ${calls}x — the refresh double-build`);
  assert(a.kind === "ran" && b.kind === "attached", `kinds: ${a.kind}/${b.kind}`);
  assert(a.kind === "ran" && a.result === "built" && b.kind === "attached" && b.result === "built", "both callers got the one result");
});

await check("owner guard: a DIFFERENT script for the same owner is rejected while one runs", async () => {
  const slow = runBuildLocked("script-x1", "owner-b", async () => { await sleep(30); return 1; });
  await sleep(5);
  const second = await runBuildLocked("script-x2", "owner-b", async () => 2);
  assert(second.kind === "owner-busy", `expected owner-busy, got ${second.kind}`);
  await slow;
  const after = await runBuildLocked("script-x3", "owner-b", async () => 3);
  assert(after.kind === "ran" && after.result === 3, "owner freed after completion");
});

await check("semaphore: at most RB_MAX_CONCURRENT_BUILDS (2) run; extras queue and finish", async () => {
  let inFlight = 0;
  let peak = 0;
  const mk = (s: string, o: string) =>
    runBuildLocked(s, o, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight--;
      return s;
    });
  const results = await Promise.all([mk("s-q1", "o-q1"), mk("s-q2", "o-q2"), mk("s-q3", "o-q3"), mk("s-q4", "o-q4")]);
  assert(peak <= 2, `peak concurrent builds ${peak} exceeded cap 2`);
  assert(results.every((r) => r.kind === "ran"), "queued builds all completed");
});

await check("a FAILING build clears its locks (owner + script + slot)", async () => {
  let threw = false;
  try {
    await runBuildLocked("script-fail", "owner-f", async () => { throw new Error("build died"); });
  } catch { threw = true; }
  assert(threw, "the failure propagates to the caller");
  const retry = await runBuildLocked("script-fail", "owner-f", async () => "recovered");
  assert(retry.kind === "ran" && retry.result === "recovered", "same script+owner can retry after a failure");
  const s = buildLockState();
  assert(s.owners === 0 && s.running === 0 && s.queued === 0, `state leaked: ${JSON.stringify(s)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
