import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import type { User } from "@prisma/client";
import { prisma, withDbRetry } from "./db";

/**
 * Identity bridge: Clerk session → our Neon `User` row.
 *
 * Clerk owns authentication; our DB owns everything a user *has* (projects,
 * usage, subscription), keyed by `User.id`. We lazily upsert the row the first
 * time we see a Clerk subject — no webhook required for creation. The fast path
 * (user already exists) is a single indexed read on `clerkId`; only first sight
 * does the network call to Clerk for the email.
 *
 * Wrapped in React `cache()` so repeat calls within ONE request are deduped — a
 * page render typically resolves the user twice (the page body + AppShellServer),
 * which without this fires the Clerk `auth()` + Prisma read twice.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  // withDbRetry: getCurrentUser runs FIRST on every authed path, so a cold Neon
  // (scale-to-zero wake) would otherwise crash the page/route before the
  // friendly entitlement copy is ever reached. One retry lets the wake settle.
  const existing = await withDbRetry(() => prisma.user.findUnique({ where: { clerkId } }));
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
  try {
    return await prisma.user.upsert({
      where: { clerkId },
      update: { email },
      create: { clerkId, email },
    });
  } catch (err) {
    // RECYCLED EMAIL (launch audit): User.email is @unique and there is no
    // Clerk-deletion webhook yet — a user who deletes their Clerk account and
    // signs up again with the SAME email arrives with a NEW clerkId, the
    // create branch hits the old row's unique email, and P2002 500s them on
    // every page forever. Clerk owns email verification, so the right move is
    // to RE-LINK the existing row (projects, usage, and — later — the Stripe
    // customer follow the person, keyed by their verified email).
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      return prisma.user.update({ where: { email }, data: { clerkId } });
    }
    throw err;
  }
});

/**
 * Owner id used by the dev-only routes (app/api/dev/*), which run without a
 * Clerk session and are 404'd in production. Defined in lib/store.ts (so store
 * consumers don't pull Clerk into their module graph); re-exported here for
 * the existing auth-side imports.
 */
export { DEV_OWNER_ID } from "./store";
