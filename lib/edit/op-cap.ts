/**
 * Per-owner sliding-window cap on the editor's LLM operations (scene regen,
 * element regen, marquee generate, suggest).
 *
 * These routes check auth but not entitlement, so without a cap a hostile — or
 * merely runaway-scripted — account can loop regens for unbounded model spend
 * (launch audit P0). Generous enough that no real editing session touches it,
 * strict enough to bound the damage.
 *
 * IT LIVES IN POSTGRES, and the previous version's home is why. An in-process
 * Map reset on every deploy, and this project ships several times a day: the
 * brake was mostly not applied, and anyone who noticed could simply wait for
 * the next deploy. A second container would also have kept its own copy and
 * doubled the effective limit. Neither failure produces an error — they produce
 * a bill.
 *
 * The in-process window survives as the FALLBACK. If the database is
 * unreachable the brake degrades to exactly what it used to be, which is worse
 * than Postgres and much better than nothing: a Neon cold-wake must not be able
 * to remove the only limit on model spend, and it must not block editing
 * either.
 */
import { prisma, withDbRetry } from "../db";

const WINDOW_MS = 60 * 60 * 1000;
const CAP = Math.max(1, Number(process.env.RB_REGEN_HOURLY_CAP) || 30);
const OP = "regen";

/**
 * Fallback window, used only when the database is unavailable.
 *
 * Pruned on every use. The old version never pruned, so one entry per owner
 * accumulated for the life of the process — slow, but a leak.
 */
const windows = new Map<string, number[]>();

export type OpCapResult = { allowed: true } | { allowed: false; retryAfterMin: number };

/** PURE: the decision, given the timestamps already inside the window. */
export const decideOpCap = (stampsMs: number[], now: number, cap = CAP): OpCapResult => {
  const inWindow = stampsMs.filter((t) => t > now - WINDOW_MS).sort((a, b) => a - b);
  if (inWindow.length < cap) return { allowed: true };
  const oldest = inWindow[0];
  return { allowed: false, retryAfterMin: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 60000)) };
};

/** The in-process brake this used to be, kept for when Postgres is unreachable. */
const takeInProcess = (ownerId: string): OpCapResult => {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  for (const [key, stamps] of windows) {
    const live = stamps.filter((t) => t > cutoff);
    if (live.length === 0) windows.delete(key);
    else windows.set(key, live);
  }
  const stamps = windows.get(ownerId) ?? [];
  const verdict = decideOpCap(stamps, now);
  if (verdict.allowed) windows.set(ownerId, [...stamps, now]);
  return verdict;
};

/**
 * How often to sweep aged-out rows, per process.
 *
 * Not every call: the prune is a range delete across all owners and there is no
 * reason to run it on a hot path more than once in a while. Rows outside the
 * window are already excluded from every count, so they are only wasted space.
 */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let lastPrune = 0;

/**
 * Record + check one LLM-spending editor op for `ownerId`.
 *
 * Async now — it was synchronous when the state was a Map. Callers await it.
 *
 * Known race, accepted: two simultaneous requests can both read a count of
 * CAP-1 and both insert, so the cap can be exceeded by the in-flight
 * concurrency. Closing it needs a transaction or an advisory lock on a path
 * that runs before every regen, which is a real cost for a brake whose job is
 * bounding a runaway loop rather than enforcing an exact quota — and the
 * concurrency it could leak by is itself capped upstream.
 */
export const takeRegenSlot = async (ownerId: string): Promise<OpCapResult> => {
  const now = Date.now();
  try {
    const since = new Date(now - WINDOW_MS);
    const rows = await withDbRetry(() =>
      prisma.opWindow.findMany({
        where: { ownerId, op: OP, at: { gt: since } },
        select: { at: true },
        orderBy: { at: "asc" },
        take: CAP, // enough to decide; the oldest is all the retry hint needs
      }),
    );

    const verdict = decideOpCap(rows.map((r) => r.at.getTime()), now);
    if (verdict.allowed) {
      await prisma.opWindow.create({ data: { ownerId, op: OP } });
    }

    if (now - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now;
      // Fire and forget: a full sweep must never sit in front of a user's edit.
      void prisma.opWindow
        .deleteMany({ where: { at: { lt: new Date(now - WINDOW_MS) } } })
        .catch(() => {});
    }
    return verdict;
  } catch (err) {
    console.warn(
      `[op-cap] database unavailable — falling back to the in-process window: ${err instanceof Error ? err.message : err}`,
    );
    return takeInProcess(ownerId);
  }
};

/** Test-only reset of the in-process fallback. */
export const resetOpCapForTests = (): void => {
  windows.clear();
  lastPrune = 0;
};
