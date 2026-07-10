/**
 * Tests for the process-wide account concurrency limiter. The property that
 * matters: across CONCURRENT BUILDS, the number of in-flight fills never
 * exceeds the limiter size (z.ai's account throttle fires on the account,
 * not per build — the AdaptiveGate alone can't see across builds).
 */
import { AccountLimiter } from "./account-limiter";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const run = async () => {
  console.log("account-limiter");

  await check("never more than `size` tasks run at once, all complete", async () => {
    const limiter = new AccountLimiter(3);
    let running = 0;
    let peak = 0;
    let done = 0;
    const task = () =>
      limiter.with(async () => {
        running++;
        peak = Math.max(peak, running);
        await tick();
        await tick();
        running--;
        done++;
      });
    await Promise.all(Array.from({ length: 12 }, task));
    assert(peak === 3, `peak was ${peak}, want exactly 3 (cap reached AND respected)`);
    assert(done === 12, `only ${done}/12 completed`);
    assert(limiter.held === 0 && limiter.waiting === 0, "limiter must drain to empty");
  });

  await check("FIFO: waiters start in arrival order", async () => {
    const limiter = new AccountLimiter(1);
    const starts: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) =>
      limiter.with(async () => {
        starts.push(i);
        await tick();
      }),
    );
    await Promise.all(tasks);
    assert(starts.join(",") === "0,1,2,3", `start order was ${starts.join(",")}`);
  });

  await check("a THROWING task still releases its slot", async () => {
    const limiter = new AccountLimiter(1);
    await limiter
      .with(async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    let ran = false;
    await limiter.with(async () => {
      ran = true;
    });
    assert(ran, "slot leaked — follow-up task never ran");
    assert(limiter.held === 0, "held must return to 0");
  });

  await check("release is idempotent — double release can't mint slots", async () => {
    const limiter = new AccountLimiter(1);
    const release = await limiter.acquire();
    release();
    release(); // must be a no-op
    assert(limiter.held === 0, `held is ${limiter.held}, want 0`);
    const r2 = await limiter.acquire();
    assert(limiter.held === 1, "single acquire after double release holds exactly 1");
    r2();
  });

  await check("handoff is direct: a latecomer can't jump a waiting queue", async () => {
    const limiter = new AccountLimiter(1);
    const order: string[] = [];
    const first = await limiter.acquire();
    const waiter = limiter.with(async () => {
      order.push("waiter");
    });
    first(); // slot must transfer to `waiter`, not free up for `late`
    const late = limiter.with(async () => {
      order.push("late");
    });
    await Promise.all([waiter, late]);
    assert(order.join(",") === "waiter,late", `order was ${order.join(",")}`);
  });

  await check("with() returns the task's value", async () => {
    const limiter = new AccountLimiter(2);
    const v = await limiter.with(async () => 42);
    assert(v === 42, "return value must pass through");
  });

  await check("size < 1 is a construction error, not a silent deadlock", async () => {
    let threw = false;
    try { new AccountLimiter(0); } catch { threw = true; }
    assert(threw, "size 0 must throw");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
