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
 * Run a DB operation, retrying ONCE on a transient connection error after a
 * short wait — the first attempt wakes a cold Neon endpoint, the retry lands.
 * Non-transient errors (constraints, logic) rethrow immediately.
 */
export const withDbRetry = async <T>(fn: () => Promise<T>, waitMs = 2500): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    console.warn(`[db] transient connection error — retrying once after ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fn();
  }
};
