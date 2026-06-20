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
