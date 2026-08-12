import { strict as assert } from "assert";
import { DbAttemptTimeoutError, withDbRetry } from "./db";

/**
 * withDbRetry's contract is that a DB attempt SETTLES — a query on a dead
 * pooled connection neither resolves nor throws (Prisma sets no socket
 * timeout), and before the per-attempt budget existed such an await parked
 * forever: the 2026-08-12 outline stall, where a saveBrief upsert executed
 * on Neon but its response was lost in flight. These drive the retry logic
 * with fakes; no database is touched.
 */

const never = () => new Promise<never>(() => {});
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const transientErr = (): Error => {
  const err = new Error("can't reach database server");
  (err as unknown as { code: string }).code = "P1001";
  return err;
};

test("an attempt that never settles becomes a thrown timeout, not a hang", async () => {
  const t0 = Date.now();
  await assert.rejects(
    withDbRetry(never, 10, 40),
    (err: unknown) => err instanceof DbAttemptTimeoutError,
  );
  const elapsed = Date.now() - t0;
  // Two hung attempts (40ms each) + the 10ms wait — and crucially, it ENDS.
  assert.ok(elapsed >= 80 && elapsed < 1_000, `settled at ~2 attempts (${elapsed}ms)`);
});

test("a hung first attempt is retried, and a healthy retry wins", async () => {
  let calls = 0;
  const result = await withDbRetry(
    () => {
      calls++;
      return calls === 1 ? never() : Promise.resolve("saved");
    },
    10,
    40,
  );
  assert.equal(result, "saved");
  assert.equal(calls, 2);
});

test("transient-error retry semantics are unchanged", async () => {
  let calls = 0;
  const result = await withDbRetry(
    () => {
      calls++;
      return calls === 1 ? Promise.reject(transientErr()) : Promise.resolve("woke");
    },
    10,
  );
  assert.equal(result, "woke");
  assert.equal(calls, 2);
});

test("non-transient errors rethrow immediately, no retry, no timeout wait", async () => {
  let calls = 0;
  const t0 = Date.now();
  await assert.rejects(
    withDbRetry(
      () => {
        calls++;
        return Promise.reject(new Error("unique constraint violated"));
      },
      10,
      5_000,
    ),
    /unique constraint violated/,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 500, "must not sit out the attempt budget");
});

test("a fast success is untouched by the machinery", async () => {
  assert.equal(await withDbRetry(() => Promise.resolve(7)), 7);
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
