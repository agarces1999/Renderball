/**
 * Build jobs — keeps a multi-minute build off the HTTP request.
 *
 * The build route used to `await runPreviewBuild(...)` and return one response
 * at the end. Builds take minutes (a measured audit build: 329s; docs/LAUNCH.md
 * records ~37min for an instrumented one), and the origin sits behind
 * Cloudflare, whose origin-response timeout is 100 seconds. So in production
 * the browser ALWAYS got a 524 while the build kept running invisibly on the
 * server — the client fires a single fetch with no polling, so the happy path
 * was unreachable through the UI for every build.
 *
 * Design notes:
 *
 * - Fast rejections stay synchronous. Entitlement and token gates live INSIDE
 *   the build lock on purpose (they close a TOCTOU where parallel requests
 *   would all pass the quota check). Rather than hoist them out, the caller
 *   races the locked promise against a short grace window: if it settles
 *   inside the window — a 402 limit, a 409 owner-busy, an immediate failure —
 *   the user gets that status directly. If the window wins, the build is
 *   genuinely running and the caller gets 202 + polling.
 *
 * - State is in-process, like the build lock it complements. A container
 *   restart loses it, which reports `unknown` rather than lying; the client
 *   then reloads and the page decides from whether the document exists. Making
 *   this durable means a job row in Neon and is the natural next step, but
 *   in-process already converts "impossible through the UI" into "works".
 */

export type BuildJob =
  | { state: "running"; startedAt: number }
  | { state: "done"; finishedAt: number; status: number; body: unknown }
  | { state: "error"; finishedAt: number; message: string };

/** scriptId → latest known job. */
const jobs = new Map<string, BuildJob>();

/** How long a finished job stays queryable, so a slow poll still sees it. */
const RETAIN_MS = 15 * 60_000;

const sweep = (): void => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state !== "running" && now - job.finishedAt > RETAIN_MS) jobs.delete(id);
  }
};

/**
 * Grace window: long enough for the in-lock gates (DB reads) to reject, short
 * enough to stay far under any proxy timeout. Env-tunable so tests can run it
 * down to milliseconds instead of sleeping through the real value.
 */
export const GATE_GRACE_MS = (() => {
  const v = Number(process.env.RB_BUILD_GRACE_MS);
  return Number.isFinite(v) && v > 0 ? v : 4_000;
})();

export type StartOutcome =
  /** Settled inside the grace window — hand this straight back to the client. */
  | { kind: "settled"; status: number; body: unknown }
  /** Still running — the client should poll. */
  | { kind: "running" };

/**
 * Run `work` under the caller's lock, but only wait GATE_GRACE_MS for it.
 * Whatever happens after that is recorded for `buildStatus` to report.
 */
export const startBuild = async (
  scriptId: string,
  work: () => Promise<{ status: number; body: unknown }>,
): Promise<StartOutcome> => {
  sweep();
  const existing = jobs.get(scriptId);
  if (existing?.state === "running") return { kind: "running" };

  jobs.set(scriptId, { state: "running", startedAt: Date.now() });

  const run = work()
    .then((result) => {
      jobs.set(scriptId, {
        state: "done",
        finishedAt: Date.now(),
        status: result.status,
        body: result.body,
      });
      return result;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      jobs.set(scriptId, { state: "error", finishedAt: Date.now(), message });
      // Swallowed deliberately: nothing awaits this after the grace window, and
      // an unhandled rejection would take the process down mid-build.
      console.error(`[build-jobs] ${scriptId} failed:`, message);
      return null;
    });

  const raced = await Promise.race([
    run,
    new Promise<"pending">((res) => setTimeout(() => res("pending"), GATE_GRACE_MS)),
  ]);

  if (raced === "pending" || raced === null) {
    // null = it threw; the catch above already recorded the error, and the
    // client will read it on its first poll rather than as a 500 here.
    return raced === "pending" ? { kind: "running" } : { kind: "running" };
  }
  return { kind: "settled", status: raced.status, body: raced.body };
};

/** Current state for polling. `unknown` = never seen here (or restarted). */
export const buildStatus = (scriptId: string): BuildJob | { state: "unknown" } => {
  sweep();
  return jobs.get(scriptId) ?? { state: "unknown" };
};

/** Test seam. */
export const __resetBuildJobs = (): void => jobs.clear();
