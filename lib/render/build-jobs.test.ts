process.env.RB_BUILD_GRACE_MS = "150";

import { strict as assert } from "assert";
import {
  BUILD_CANCELLED_SENTINEL,
  BuildCancelledError,
  GATE_GRACE_MS,
  __resetBuildJobs,
  buildAbortSignal,
  buildCancelRequested,
  buildStatus,
  reportBuildProgress,
  reportBuildThinking,
  requestBuildCancel,
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

// ── live progress + stop (founder asks, 2026-08-12) ──────────────────────────

test("progress marks accumulate on the running job and ride buildStatus", async () => {
  __resetBuildJobs();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  void startBuild("prog", async () => {
    await gate;
    return { status: 200, body: {} };
  });
  reportBuildProgress("prog", "design:scaffold:done");
  reportBuildProgress("prog", "design:fill:scene:0:done");
  const job = buildStatus("prog");
  assert.equal(job.state, "running");
  assert.deepEqual(
    (job as { progress?: { phase: string }[] }).progress?.map((p) => p.phase),
    ["design:scaffold:done", "design:fill:scene:0:done"],
  );
  release();
  await sleep(20);
});

test("thinking rides the running job, latest-only, and never after settle", async () => {
  __resetBuildJobs();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  void startBuild("think", async () => {
    await gate;
    return { status: 200, body: {} };
  });
  reportBuildThinking("think", "planning the chrome rail");
  reportBuildThinking("think", "placing the meridian arcs");
  const job = buildStatus("think") as { state: string; thinking?: { text: string } };
  assert.equal(job.state, "running");
  assert.equal(job.thinking?.text, "placing the meridian arcs", "latest line wins");
  release();
  await sleep(20);
  reportBuildThinking("think", "ghost");
  const settled = buildStatus("think") as { state: string; thinking?: { text: string } };
  assert.equal(settled.state, "done");
  assert.equal((settled as { thinking?: unknown }).thinking, undefined, "no resurrection after settle");
});

test("progress after settle is dropped — a late mark must not resurrect state", async () => {
  __resetBuildJobs();
  await startBuild("late", async () => ({ status: 200, body: {} }));
  reportBuildProgress("late", "ghost");
  const job = buildStatus("late");
  assert.equal(job.state, "done", "the settled job must stay settled");
});

test("a stop lands as CANCELLED, not error — stopping is not breaking", async () => {
  __resetBuildJobs();
  let checkCancel: () => void = () => {};
  void startBuild("stopme", async () => {
    // Simulate the timeline's onMark checkpoint loop.
    await new Promise<void>((resolve, reject) => {
      checkCancel = () => {
        if (buildCancelRequested("stopme")) reject(new BuildCancelledError());
        else resolve();
      };
      setTimeout(() => checkCancel(), 50);
    });
    return { status: 200, body: {} };
  });
  assert.equal(requestBuildCancel("stopme"), true, "a running build accepts the stop");
  await sleep(120);
  assert.equal(buildStatus("stopme").state, "cancelled");
});

test("stop ABORTS the in-flight call — hard stop, not wait-for-the-step (founder, 2026-09-01)", async () => {
  __resetBuildJobs();
  void startBuild("hardstop", async () => {
    // Simulate a multi-minute model stream that only ends when its signal
    // aborts — the exact thing the cooperative flag could never interrupt.
    const signal = buildAbortSignal("hardstop");
    assert.ok(signal, "a running build registers an abort signal");
    assert.equal(signal!.aborted, false, "not aborted before the user asks");
    await new Promise<void>((_, reject) => {
      signal!.addEventListener("abort", () => reject(new BuildCancelledError()), { once: true });
    });
    return { status: 200, body: {} };
  });
  await sleep(20);
  assert.equal(requestBuildCancel("hardstop"), true);
  assert.equal(buildAbortSignal("hardstop")?.aborted, true, "stop aborts the signal immediately");
  await sleep(60);
  assert.equal(buildStatus("hardstop").state, "cancelled", "the cut stream lands as a clean cancel");
});

test("a WRAPPED cancellation still reads as cancelled (substring, not instanceof)", async () => {
  __resetBuildJobs();
  void startBuild("wrapped", async () => {
    throw new Error(`pipeline stage failed: ${BUILD_CANCELLED_SENTINEL} during fills`);
  });
  await sleep(GATE_GRACE_MS + 60);
  assert.equal(buildStatus("wrapped").state, "cancelled");
});

test("a cancel aimed at a previous build never kills the next one", async () => {
  __resetBuildJobs();
  await startBuild("reuse", async () => ({ status: 200, body: {} }));
  requestBuildCancel("reuse"); // returns false — nothing running — but even so:
  __resetBuildJobs();
  void startBuild("reuse", async () => {
    await sleep(30);
    return { status: 200, body: {} };
  });
  assert.equal(buildCancelRequested("reuse"), false, "fresh build starts unflagged");
  await sleep(80);
  assert.equal(buildStatus("reuse").state, "done");
});

test("stopping a build that is not running is refused honestly", async () => {
  __resetBuildJobs();
  assert.equal(requestBuildCancel("nothing"), false);
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
