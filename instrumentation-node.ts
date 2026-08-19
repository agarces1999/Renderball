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

/**
 * BOOT WARMER (speed playbook, infra track): after a deploy the dyno's disk
 * is empty, so the FIRST open of every deck paid a 1-3s R2 hydration. Warm
 * the hot set — the most recently touched documents — in the background
 * once the process is up. Delayed so the healthcheck wins first; bounded
 * concurrency so R2 and the event loop stay polite; failure-blind because
 * a warm miss just means the old lazy path. This also absorbs the DB's
 * first-query wake off any user request.
 */
setTimeout(() => {
  void (async () => {
    try {
      const { prisma } = await import("./lib/db");
      const { hydrateGenDir } = await import("./lib/render/gen-store");
      const rows: { id: string }[] = await prisma.scriptDoc.findMany({
        select: { id: true },
        orderBy: { updatedAt: "desc" },
        take: 20,
      });
      let cursor = 0;
      let warmed = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (cursor < rows.length) {
            const row = rows[cursor];
            cursor += 1;
            try {
              if (await hydrateGenDir(row.id)) warmed += 1;
            } catch {
              /* lazy path covers it */
            }
          }
        }),
      );
      console.log(`[boot] warmed ${warmed}/${rows.length} recent documents`);
    } catch (e) {
      console.warn(`[boot] document warmer skipped: ${e instanceof Error ? e.message : e}`);
    }
  })();
}, 10_000);

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
