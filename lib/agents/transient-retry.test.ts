/**
 * Tests for the transient-retry helper used by the script-gen (Agent 1) stream
 * call. Verifies: transient drops retry (bounded), non-transient errors fail
 * fast, and success short-circuits. `sleep` is injected so there's no real delay.
 */
import { isTransientNetErr, withTransientRetry } from "./transient-retry";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const noSleep = async () => {};

console.log("transient-retry");

await check("isTransientNetErr: connection drops → true", () => {
  assert(isTransientNetErr(new Error("terminated")), "terminated");
  assert(isTransientNetErr(new Error("read ECONNRESET")), "ECONNRESET");
  assert(isTransientNetErr(new Error("socket hang up")), "socket hang up");
  assert(isTransientNetErr({ message: "x", cause: { code: "ETIMEDOUT" } }), "nested cause code");
  assert(isTransientNetErr(new Error('overloaded_error 500')), "z.ai overload");
});

await check("isTransientNetErr: real API errors → false (fail fast)", () => {
  assert(!isTransientNetErr(new Error("400 messages: roles must alternate")), "400");
  assert(!isTransientNetErr(new Error("401 authentication_error")), "auth");
  assert(!isTransientNetErr(new Error("Output was not valid JSON")), "validation");
});

await check("withTransientRetry: success on first try → 1 call, returns value", async () => {
  let n = 0;
  const r = await withTransientRetry("t", async () => { n++; return "ok"; }, 3, noSleep);
  assert(r === "ok" && n === 1, `r=${r} n=${n}`);
});

await check("withTransientRetry: transient then success → retries, returns", async () => {
  let n = 0;
  const r = await withTransientRetry("t", async () => {
    n++; if (n < 3) throw new Error("terminated"); return "ok";
  }, 3, noSleep);
  assert(r === "ok" && n === 3, `r=${r} n=${n}`);
});

await check("withTransientRetry: transient every time → throws after `attempts` tries", async () => {
  let n = 0;
  let threw = false;
  try {
    await withTransientRetry("t", async () => { n++; throw new Error("terminated"); }, 3, noSleep);
  } catch { threw = true; }
  assert(threw && n === 3, `threw=${threw} n=${n} (should stop at 3, not loop forever)`);
});

await check("withTransientRetry: non-transient → fails FAST (1 call, no retry)", async () => {
  let n = 0;
  let threw = false;
  try {
    await withTransientRetry("t", async () => { n++; throw new Error("400 bad request"); }, 3, noSleep);
  } catch { threw = true; }
  assert(threw && n === 1, `threw=${threw} n=${n} (must NOT retry a 400)`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
