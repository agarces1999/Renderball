/**
 * Node-runtime boot work, loaded by instrumentation.ts ONLY under
 * NEXT_RUNTIME === "nodejs" (the positive-condition split Next's docs bless:
 * webpack inlines NEXT_RUNTIME per-bundle and dead-branch-eliminates this
 * import from the edge build — a runtime guard alone still gets statically
 * resolved, which is exactly how child_process broke the edge compile).
 *
 * 1. WARM THE SANDBOX POOL — first render after each deploy paid a measured
 *    114.5ms cold-child price; spawned here instead, off any request.
 * 2. SIGTERM DRAIN — hold exit while builds run (capped under railway.json's
 *    draining window) so a deploy can't kill a build mid-spend.
 */
import { warmPool } from "./lib/render/sandbox/pool";
import { activeBuildCount } from "./lib/render/build-jobs";

try {
  warmPool();
} catch (e) {
  console.warn(`[boot] pool warm failed (renders fall back to lazy spawn): ${e}`);
}

let draining = false;
process.on("SIGTERM", () => {
  if (draining) return;
  draining = true;
  const started = Date.now();
  const CAP_MS = 25_000;
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
