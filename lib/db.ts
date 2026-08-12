import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton. Next.js dev hot-reloads modules, which would
 * otherwise spawn a new PrismaClient (and a new connection pool) on every
 * reload until Postgres refuses connections. Caching it on globalThis in
 * non-production keeps a single instance.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * True for a TRANSIENT connection error — the DB is unreachable/cold, not a
 * query/logic fault. Neon's scale-to-zero compute takes seconds to wake after
 * idle, and the first request loses Prisma's connect race (observed live:
 * PrismaClientInitializationError / P1001 after ~2 idle days). These self-heal
 * on retry; a P2xxx constraint error or a normal query error does NOT.
 */
export const isTransientDbError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  const code = (err as { code?: string }).code ?? "";
  return (
    name === "PrismaClientInitializationError" ||
    code === "P1001" || // can't reach database server
    code === "P1002" || // server reached but timed out
    code === "P1008" || // operations timed out
    code === "P1017" // server closed the connection
  );
};

/**
 * An attempt that exceeded its wall-clock budget. Retried like a transient
 * error, because it IS one wearing different clothes: a query on a dead
 * pooled connection does not fail — Prisma's postgres driver sets no socket
 * timeout, so an upsert whose response is lost in flight waits on TCP
 * keepalive (hours) and the catch below never runs. Observed live
 * (2026-08-12): the outline route's saveBrief EXECUTED on Neon at 22:22:36Z
 * but its await never settled, and the job spun "running" with no error and
 * no spend until the 45-minute sweep. A hang must become a throw.
 */
export class DbAttemptTimeoutError extends Error {
  constructor(ms: number) {
    super(`database operation did not settle within ${ms}ms — connection presumed dead`);
    this.name = "DbAttemptTimeoutError";
  }
}

/** Every withDbRetry call site is a single-row read/write: sub-second warm,
 *  a few seconds through a cold Neon wake. 15s is nowhere near a real query. */
const DB_ATTEMPT_TIMEOUT_MS = 15_000;

const attemptWithTimeout = async <T>(fn: () => Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DbAttemptTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run a DB operation, retrying ONCE on a transient connection error OR a
 * per-attempt timeout after a short wait — the first attempt wakes a cold
 * Neon endpoint (or abandons a dead connection), the retry lands on a
 * healthy one from the pool. Non-transient errors (constraints, logic)
 * rethrow immediately.
 *
 * Retrying a timeout can re-run a query whose first execution succeeded
 * server-side with its response lost — the same exposure the existing P1017
 * retry always had ("server closed the connection" also fires post-execute),
 * and every call site is an idempotent single-row operation.
 */
export const withDbRetry = async <T>(
  fn: () => Promise<T>,
  waitMs = 2500,
  attemptTimeoutMs = DB_ATTEMPT_TIMEOUT_MS,
): Promise<T> => {
  try {
    return await attemptWithTimeout(fn, attemptTimeoutMs);
  } catch (err) {
    const timedOut = err instanceof DbAttemptTimeoutError;
    if (!timedOut && !isTransientDbError(err)) throw err;
    console.warn(
      `[db] ${timedOut ? `attempt did not settle in ${attemptTimeoutMs}ms` : "transient connection error"} — retrying once after ${waitMs}ms`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    return attemptWithTimeout(fn, attemptTimeoutMs);
  }
};
