/**
 * Phase watchdog for the outline job (and any future short background job).
 *
 * startBuild's sweep abandons a running job after MAX_RUN_MS = 45 minutes —
 * sized for full builds, where a hung headless Chromium really can be the
 * last thing standing. An outline's whole life is a couple of model calls
 * (median 79s, p95 185s per call) plus two single-row saves, and the client
 * stops polling at 8 minutes — so on an outline, the 45-minute backstop IS
 * the eternal spinner.
 *
 * Observed live (2026-08-12, scriptId 01KZW12MN0QHWKQ9RJ9NJRR2RD, third
 * sighting of the class): both model calls succeeded, both saves EXECUTED on
 * Neon, and the job still never settled — the saveBrief upsert's response was
 * lost in flight, so its await parked forever on a dead pooled connection.
 * No error, no further spend, "running" until the sweep. The fix is not to
 * find every such await — it is to bound every awaited PHASE so the job
 * settles as an error the client can actually show, at the phase deadline.
 *
 * On expiry this REJECTS; the underlying promise cannot be cancelled (Prisma
 * has no per-query abort, and a zombie model call still records its spend) —
 * it is left to the void, which is exactly what the settled error state
 * already assumes about lost work.
 */

export class PhaseTimeoutError extends Error {
  constructor(phase: string, ms: number) {
    // Client-visible: the outline poll surfaces this string verbatim on
    // status:"error". Say what happened and what to do, not which await hung.
    super(
      `${phase} stalled — no result after ${Math.round(ms / 1000)}s — so this run was abandoned. Try again.`,
    );
    this.name = "PhaseTimeoutError";
  }
}

/**
 * Await `work`, but no longer than `ms`. `phase` is a human phrase in
 * mid-sentence case ("Writing the outline") — it opens the user-facing error.
 */
export const withPhaseTimeout = async <T>(
  phase: string,
  ms: number,
  work: Promise<T>,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PhaseTimeoutError(phase, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The generate phase must settle INSIDE the client's 8-minute polling
 * patience (pollOutline DEADLINE_MS) or the error plays to an empty room.
 * 7 minutes clears the p95 three-call shape (~185s × 2 + a repair) with
 * headroom; castCall already bounds any single attempt at 300s, so a run
 * still unfinished at 7 minutes is in a degenerate retry ladder, not working.
 */
export const OUTLINE_GENERATE_BUDGET_MS = 7 * 60_000;

/**
 * Each save is one single-row upsert through withDbRetry, whose own
 * per-attempt timeout (15s × 2 attempts + wait) gives up by ~35s — this is
 * the backstop above it, generous enough to never fire first.
 */
export const OUTLINE_SAVE_BUDGET_MS = 60_000;
