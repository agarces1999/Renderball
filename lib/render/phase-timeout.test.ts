process.env.RB_BUILD_GRACE_MS = "50";

import { strict as assert } from "assert";
import { __resetBuildJobs, buildStatus, startBuild } from "./build-jobs";
import { PhaseTimeoutError, withPhaseTimeout } from "./phase-timeout";

/**
 * The property that matters: an await inside the outline job that neither
 * resolves nor throws must still settle the JOB, as an error the client can
 * show, at the phase deadline — not at build-jobs' 45-minute sweep. The live
 * failure this guards against (2026-08-12): a saveBrief upsert executed on
 * Neon but its response was lost in flight, the await parked forever, and
 * the outline spun "running" with no error and no further spend.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = new Promise<never>(() => {});
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("a phase that finishes in time passes its value through untouched", async () => {
  const v = await withPhaseTimeout("Writing the outline", 1_000, Promise.resolve(42));
  assert.equal(v, 42);
});

test("a phase that never settles rejects at the deadline, naming the phase", async () => {
  const t0 = Date.now();
  await assert.rejects(
    withPhaseTimeout("Saving the outline", 80, never),
    (err: unknown) => {
      assert.ok(err instanceof PhaseTimeoutError);
      assert.match(err.message, /^Saving the outline stalled/);
      assert.match(err.message, /Try again\./);
      return true;
    },
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 70 && elapsed < 500, `rejected at ~deadline, not ${elapsed}ms`);
});

test("a phase that fails on its own rejects with ITS error, not a timeout", async () => {
  await assert.rejects(
    withPhaseTimeout("Writing the outline", 1_000, Promise.reject(new Error("provider exploded"))),
    /provider exploded/,
  );
});

test("REGRESSION: a hung save settles the job as an error, not eternal running", async () => {
  __resetBuildJobs();
  // The outline route's exact shape: generate succeeds, then a phase-bounded
  // save whose underlying await never settles. Without the phase bound this
  // job stays "running" until build-jobs' 45-minute sweep — the 2026-08-12
  // eternal spinner. (No asserts on the intermediate "running" state: whether
  // startBuild reports it depends on the grace window, which ESM import
  // hoisting keeps at its default here.)
  await startBuild("outline:hung-save", async () => {
    await sleep(10); // the (successful) model calls
    await withPhaseTimeout("Saving the outline", 120, never);
    return { status: 200, body: { ok: true } };
  });

  await sleep(300); // past the phase deadline, nowhere near MAX_RUN_MS
  const s = buildStatus("outline:hung-save");
  assert.equal(
    s.state,
    "error",
    `a hung await must settle the job as error, got "${s.state}" — the eternal-spinner bug`,
  );
  if (s.state === "error") assert.match(s.message, /Saving the outline stalled/);
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
