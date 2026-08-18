/**
 * Boot hook (Next instrumentation): runs once per server process, before
 * traffic. Two jobs, both from the 2026-08-18 speed playbook:
 *
 * 1. WARM THE SANDBOX POOL — the first render after every deploy paid a
 *    measured 114.5ms cold-child price; twelve deploys a day made that a
 *    recurring first-impression tax. Spawned here instead, off the request.
 *
 * 2. DRAIN ON SIGTERM — Railway's zero-downtime cutover sends SIGTERM and
 *    allows a draining window before SIGKILL (railway.json sets it). Node's
 *    default is immediate exit, which killed in-flight builds mid-spend.
 *    The handler holds exit while build jobs are running, up to a cap
 *    safely inside the draining window, then exits cleanly.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;

  const { warmPool } = await import("./lib/render/sandbox/pool");
  try {
    warmPool();
  } catch (e) {
    console.warn(`[boot] pool warm failed (renders fall back to lazy spawn): ${e}`);
  }

  const { activeBuildCount } = await import("./lib/render/build-jobs");
  let draining = false;
  process.on("SIGTERM", () => {
    if (draining) return;
    draining = true;
    const started = Date.now();
    const CAP_MS = 25_000; // under railway.json's drainingSeconds
    const tick = () => {
      const active = activeBuildCount();
      if (active === 0 || Date.now() - started > CAP_MS) {
        console.log(
          `[drain] exiting after ${Math.round((Date.now() - started) / 1000)}s (${active} build(s) still running)`,
        );
        process.exit(0);
      }
      console.log(`[drain] SIGTERM received — waiting on ${active} build(s)`);
      setTimeout(tick, 2_000);
    };
    tick();
  });
}
