process.env.RB_BUILD_GRACE_MS = "150";

import { strict as assert } from "assert";
import {
  GATE_GRACE_MS,
  __resetBuildJobs,
  buildStatus,
  startBuild,
} from "./build-jobs";

/**
 * The property that matters: a build must not hold the HTTP request open.
 * Builds run for minutes (a measured build: 329s) and the origin sits behind
 * Cloudflare's 100s origin timeout, so the old await-the-whole-build route
 * could only ever produce a 524 in production — the happy path was
 * unreachable through the UI. These assert the new shape end to end without
 * spending a real build.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("a fast rejection still settles synchronously (402 reaches the user)", async () => {
  __resetBuildJobs();
  const t0 = Date.now();
  const r = await startBuild("fast", async () => ({
    status: 402,
    body: { error: "limit reached" },
  }));
  assert.equal(r.kind, "settled");
  if (r.kind === "settled") {
    assert.equal(r.status, 402);
    assert.deepEqual(r.body, { error: "limit reached" });
  }
  assert.ok(Date.now() - t0 < GATE_GRACE_MS + 100, "must not wait the full window");
});

test("a slow build returns immediately and finishes in the background", async () => {
  __resetBuildJobs();
  const t0 = Date.now();
  const r = await startBuild("slow", async () => {
    await sleep(GATE_GRACE_MS * 6);
    return { status: 200, body: { ok: true, scriptId: "slow" } };
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.kind, "running", "caller must be released, not blocked");
  assert.ok(
    elapsed < GATE_GRACE_MS * 3,
    `released at ~grace (${elapsed}ms), not at build end`,
  );
  assert.equal(buildStatus("slow").state, "running");

  await sleep(GATE_GRACE_MS * 7);
  const done = buildStatus("slow");
  assert.equal(done.state, "done");
  if (done.state === "done") {
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ok: true, scriptId: "slow" });
  }
});

test("a build that throws is recorded as error, never an unhandled rejection", async () => {
  __resetBuildJobs();
  const r = await startBuild("boom", async () => {
    await sleep(GATE_GRACE_MS * 3);
    throw new Error("provider exploded");
  });
  assert.equal(r.kind, "running");
  await sleep(GATE_GRACE_MS * 5);
  const s = buildStatus("boom");
  assert.equal(s.state, "error");
  if (s.state === "error") assert.match(s.message, /provider exploded/);
});

test("an unseen script reports unknown (the post-restart case)", async () => {
  __resetBuildJobs();
  assert.equal(buildStatus("never-seen").state, "unknown");
});

test("a duplicate POST attaches instead of starting a second paid build", async () => {
  __resetBuildJobs();
  let runs = 0;
  const work = async () => {
    runs++;
    await sleep(GATE_GRACE_MS * 5);
    return { status: 200, body: { ok: true } };
  };
  await startBuild("dup", work);
  const second = await startBuild("dup", work);
  assert.equal(second.kind, "running");
  assert.equal(runs, 1, "the expensive work must run exactly once");
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
