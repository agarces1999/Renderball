import { auth, currentUser } from "@clerk/nextjs/server";
import type { User } from "@prisma/client";
import { prisma } from "./db";

/**
 * Identity bridge: Clerk session → our Neon `User` row.
 *
 * Clerk owns authentication; our DB owns everything a user *has* (projects,
 * usage, subscription), keyed by `User.id`. We lazily upsert the row the first
 * time we see a Clerk subject — no webhook required for creation. The fast path
 * (user already exists) is a single indexed read on `clerkId`; only first sight
 * does the network call to Clerk for the email.
 */
export async function getCurrentUser(): Promise<User | null> {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const existing = await prisma.user.findUnique({ where: { clerkId } });
  if (existing) return existing;

  // First sight — pull the verified email from Clerk and create the row.
  const cu = await currentUser();
  const email =
    cu?.primaryEmailAddress?.emailAddress ??
    cu?.emailAddresses?.[0]?.emailAddress ??
    `${clerkId}@clerk.local`;

  // upsert (not create) so two concurrent first-requests can't collide;
  // refresh email on the update branch so a races-in first-sight can't pin a
  // stale address.
  return prisma.user.upsert({
    where: { clerkId },
    update: { email },
    create: { clerkId, email },
  });
}

/**
 * Throw when there's no signed-in user. Use in server actions / route handlers
 * where the caller converts the throw into a 401 / error result.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("UNAUTHENTICATED");
    this.name = "UnauthenticatedError";
  }
}

/**
 * Owner id used by the dev-only routes (app/api/dev/*), which run without a
 * Clerk session and are 404'd in production. Keeps their data partitioned from
 * real users in the shared store.
 */
export const DEV_OWNER_ID = "dev-local";
