/**
 * Build concurrency control (launch audit P0) — three guards in one wrapper:
 *
 *  1. PER-SCRIPT DEDUP — the preview page auto-fires the build on load, so a
 *     refresh during the 20-30 min wait used to launch a SECOND full pipeline
 *     into the same genDir (double spend + interleaved writes). Now a second
 *     request for the same script ATTACHES to the in-flight build's promise
 *     and receives the same result.
 *  2. PER-OWNER IN-FLIGHT GUARD — checkEntitlement counts committed usage
 *     rows, which land only AFTER a build finishes, so N parallel requests
 *     for different scripts all passed the quota gate (TOCTOU): a free user
 *     with "1 build/month" could run several at once. One build per owner at
 *     a time closes the race without schema churn.
 *  3. GLOBAL SEMAPHORE — every build runs esbuild + headless Chromium +
 *     multi-minute LLM streams on one container; unbounded concurrent builds
 *     OOM everyone. Excess builds queue FIFO (they are already async,
 *     20-30 min affairs — a queued start beats a crashed container).
 *
 * In-process state: correct for the single-container deploy of record
 * (Dockerfile/Railway). A multi-instance future moves this to a DB/Redis
 * lock — the wrapper is the seam.
 */

const MAX_CONCURRENT_BUILDS = Math.max(
  1,
  Number(process.env.RB_MAX_CONCURRENT_BUILDS) || 2,
);

const inFlightByScript = new Map<string, Promise<unknown>>();
const inFlightOwners = new Set<string>();
let running = 0;
const queue: Array<() => void> = [];

const acquireSlot = async (): Promise<void> => {
  while (running >= MAX_CONCURRENT_BUILDS) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  running += 1;
};

const releaseSlot = (): void => {
  running = Math.max(0, running - 1);
  const next = queue.shift();
  if (next) next();
};

export type LockedResult<T> =
  | { kind: "ran"; result: T }
  | { kind: "attached"; result: T }
  | { kind: "owner-busy" };

/**
 * Run `fn` (the full entitlement-check + build) under the three guards.
 * - Same script already building → attaches, resolves with that build's result.
 * - Owner already has a different build running → { kind: "owner-busy" }
 *   (caller maps to 409 with a friendly message).
 * - Otherwise runs, queueing behind the global semaphore when at capacity.
 */
export const runBuildLocked = async <T>(
  scriptId: string,
  ownerId: string,
  fn: () => Promise<T>,
): Promise<LockedResult<T>> => {
  const existing = inFlightByScript.get(scriptId) as Promise<T> | undefined;
  if (existing) {
    return { kind: "attached", result: await existing };
  }
  if (inFlightOwners.has(ownerId)) {
    return { kind: "owner-busy" };
  }

  inFlightOwners.add(ownerId);
  const run = (async () => {
    await acquireSlot();
    try {
      return await fn();
    } finally {
      releaseSlot();
      inFlightByScript.delete(scriptId);
      inFlightOwners.delete(ownerId);
    }
  })();
  inFlightByScript.set(scriptId, run);

  // A rejected build must still clear its locks (the finally above does) and
  // propagate to BOTH the runner and any attached callers.
  return { kind: "ran", result: await run };
};

/** Introspection for status surfaces / tests. */
export const buildLockState = (): { running: number; queued: number; owners: number } => ({
  running,
  queued: queue.length,
  owners: inFlightOwners.size,
});
