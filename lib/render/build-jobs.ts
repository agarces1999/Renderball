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

/** One real phase boundary the build crossed, for the ceremony to show. */
export interface BuildProgressEvent {
  phase: string;
  at: number;
}

export type BuildJob =
  | { state: "running"; startedAt: number; progress?: BuildProgressEvent[] }
  | { state: "done"; finishedAt: number; status: number; body: unknown }
  | { state: "error"; finishedAt: number; message: string }
  /** The user pressed stop. Distinct from error: nothing is wrong, and the
   *  client must not offer "try again" framing as if something failed. */
  | { state: "cancelled"; finishedAt: number };

/** scriptId → latest known job. */
/**
 * On globalThis, not module scope — the same move lib/db.ts makes for Prisma
 * and lib/render/outline-stream.ts makes for the ceremony sink, and it is
 * MEASURED here, not theoretical: a nonce trace (2026-08-14, .data/
 * outline-trace.log) caught one dev process answering adjacent requests
 * 267ms apart from THREE different instances of this module — the outline
 * job registered in one instance's Map while every poll read another's,
 * so the panel saw "unknown" for a job that was running the whole time.
 * Production's single compiled bundle never splits, but the stash costs
 * nothing there and makes dev tell the truth.
 */
const globalForJobs = globalThis as unknown as { __rbBuildJobs?: Map<string, BuildJob> };
const jobs: Map<string, BuildJob> = (globalForJobs.__rbBuildJobs ??= new Map());

/** Documents whose running build the user asked to stop. Checked by the
 *  build at every timeline boundary — cooperative, so an in-flight model
 *  call finishes and the stop lands at the next phase edge. */
const cancels = new Set<string>();

/** Builds currently in state "running" — the SIGTERM drain (instrumentation.ts)
 *  holds process exit while this is non-zero so a deploy can't kill a build
 *  mid-spend. */
export const activeBuildCount = (): number => {
  let n = 0;
  for (const job of jobs.values()) if (job.state === "running") n += 1;
  return n;
};

/** Thrown out of the build at a phase boundary after a stop request. The
 *  message is a sentinel because the pipeline's own catch-alls may wrap the
 *  error — DETECTION IS BY SUBSTRING, never instanceof. */
export const BUILD_CANCELLED_SENTINEL = "RB_BUILD_CANCELLED";
export class BuildCancelledError extends Error {
  constructor() {
    super(BUILD_CANCELLED_SENTINEL);
    this.name = "BuildCancelledError";
  }
}

/** How many boundary events a running job retains. The ceremony only needs
 *  the recent tail; an unbounded array on a 45-minute pathological build is
 *  a leak. */
const MAX_PROGRESS_EVENTS = 120;

/** Record a real phase boundary on the running job. No-op when the job is
 *  not running (a late mark after settle must not resurrect state). */
export const reportBuildProgress = (scriptId: string, phase: string): void => {
  const job = jobs.get(scriptId);
  if (job?.state !== "running") return;
  const progress = job.progress ?? [];
  progress.push({ phase, at: Date.now() });
  if (progress.length > MAX_PROGRESS_EVENTS) progress.shift();
  jobs.set(scriptId, { ...job, progress });
};

/** Per-build abort controllers — the HARD half of stop (founder, 2026-09-01:
 *  "it said it had to finish the current step, should not be the case"). The
 *  flag lands at phase edges; the abort cuts the in-flight model stream, so a
 *  stop takes seconds instead of waiting out a multi-minute author call. */
const aborters = new Map<string, AbortController>();
export const registerBuildAborter = (scriptId: string): void => {
  aborters.get(scriptId)?.abort();
  aborters.set(scriptId, new AbortController());
};
export const buildAbortSignal = (scriptId: string): AbortSignal | undefined =>
  aborters.get(scriptId)?.signal;

/** Ask the running build to stop. True = there was a running build to ask. */
export const requestBuildCancel = (scriptId: string): boolean => {
  if (jobs.get(scriptId)?.state !== "running") return false;
  cancels.add(scriptId);
  aborters.get(scriptId)?.abort();
  return true;
};

export const buildCancelRequested = (scriptId: string): boolean => cancels.has(scriptId);

/** How long a finished job stays queryable, so a slow poll still sees it. */
const RETAIN_MS = 15 * 60_000;

/**
 * A build that never settles (a hung headless Chromium is the classic) would
 * otherwise stay "running" forever, so startBuild would refuse every future
 * POST for that document and the client would poll indefinitely — the
 * document becomes permanently unbuildable on this container. Past this age a
 * running job is treated as lost.
 */
const MAX_RUN_MS = 45 * 60_000;

const sweep = (): void => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state === "running") {
      if (now - job.startedAt > MAX_RUN_MS) {
        cancels.delete(id);
        jobs.set(id, {
          state: "error",
          finishedAt: now,
          message: "build exceeded the maximum run time and was abandoned",
        });
      }
      continue;
    }
    if (now - job.finishedAt > RETAIN_MS) {
      jobs.delete(id);
      cancels.delete(id);
    }
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

  // A cancel aimed at a PREVIOUS build must not kill this fresh one.
  cancels.delete(scriptId);
  registerBuildAborter(scriptId);
  jobs.set(scriptId, { state: "running", startedAt: Date.now() });

  const run = work()
    .then((result) => {
      cancels.delete(scriptId);
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
      cancels.delete(scriptId);
      // Substring, not instanceof: the pipeline's catch-alls wrap errors, and
      // a wrapped cancellation reported as "build failed" would make stopping
      // look like breaking.
      if (message.includes(BUILD_CANCELLED_SENTINEL)) {
        jobs.set(scriptId, { state: "cancelled", finishedAt: Date.now() });
        console.warn(`[build-jobs] ${scriptId} stopped by the user`);
        return null;
      }
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
export const __resetBuildJobs = (): void => {
  jobs.clear();
  cancels.clear();
};
