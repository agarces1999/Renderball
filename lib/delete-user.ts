/**
 * Account-data deletion core — shared by the GDPR CLI (scripts/delete-user.ts)
 * and the Clerk user.deleted webhook, so both paths delete EXACTLY the same
 * things and can't drift.
 *
 * Deletes, in order:
 *   1. R2 objects: uploads/<briefId>/* per project + renders/<scriptId>* per
 *      script (best-effort; skipped when STORAGE_* unset).
 *   2. ScriptDoc rows — NO foreign key to Project (saveScript runs before the
 *      brief learns its script_id), so Prisma's cascade misses them; deleted
 *      explicitly via each project's scriptId.
 *   3. The User row — cascades Projects, UsageRecords, Renders, Subscription.
 *   4. Local artifacts: src/generated/<scriptId>/, .data/renders/<scriptId>.mp4,
 *      .data file-store JSON (legacy), public/uploads/<briefId>/ — best-effort.
 */
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "./db";
import { deletePrefix, isStorageConfigured } from "./storage/r2";
import { isStripeConfigured, getStripe } from "./stripe";

export type DeletionSummary = {
  userId: string;
  email: string;
  projectCount: number;
  scriptCount: number;
  r2Deleted: number | null; // null = storage not configured, skipped
  scriptDocsDeleted: number;
  /** R2 prefixes whose delete threw — NOT removed; swept later. Empty = clean. */
  r2Failures: string[];
  /** Stripe subscription cancellation: "canceled" | "none" | "error" | "skipped". */
  stripeCancel: string;
};

const rmrf = async (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => {});

/**
 * Delete a user's account data end to end. The user row must still exist —
 * pass our User.id (callers resolve email / clerkId themselves).
 * Throws if the user is not found.
 */
export async function deleteUserData(userId: string): Promise<DeletionSummary> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { projects: { select: { id: true, scriptId: true } } },
  });
  if (!user) throw new Error(`deleteUserData: no user with id "${userId}"`);
  const scriptIds = user.projects.map((p) => p.scriptId).filter((s): s is string => !!s);

  // 0. Cancel the live Stripe subscription FIRST — deleting the User row erases
  //    stripeCustomerId, so a deleted account would otherwise keep getting
  //    charged with no way for us to map the webhook back. Best-effort: a Stripe
  //    hiccup must not block the data deletion the user asked for.
  let stripeCancel = "skipped";
  if (isStripeConfigured()) {
    stripeCancel = "none";
    try {
      const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
      if (sub && sub.status !== "canceled") {
        await getStripe().subscriptions.cancel(sub.stripeSubscriptionId);
        stripeCancel = "canceled";
      }
    } catch (err) {
      console.error(`[delete-user] Stripe cancel failed for ${user.id} — CANCEL MANUALLY:`, err);
      stripeCancel = "error";
    }
  }

  // 1. R2 objects. Best-effort PER PREFIX: a storage error (rotated creds, R2
  //    outage) must NOT abort the DB deletion the user can actually observe —
  //    the pg cascade is the part that matters. Failed prefixes are recorded so
  //    they can be swept once storage recovers, instead of silently orphaned.
  let r2Deleted: number | null = null;
  const r2Failures: string[] = [];
  if (isStorageConfigured()) {
    r2Deleted = 0;
    const prefixes = [
      ...user.projects.map((p) => `uploads/${p.id}/`),
      ...scriptIds.map((sid) => `renders/${sid}`),
    ];
    for (const prefix of prefixes) {
      try {
        r2Deleted += await deletePrefix(prefix);
      } catch (err) {
        r2Failures.push(prefix);
        console.error(`[delete-user] R2 deletePrefix("${prefix}") failed — SWEEP LATER:`, err);
      }
    }
  }

  // 2. ScriptDocs (no FK — cascade misses them)
  let scriptDocsDeleted = 0;
  if (scriptIds.length > 0) {
    const r = await prisma.scriptDoc.deleteMany({ where: { id: { in: scriptIds } } });
    scriptDocsDeleted = r.count;
  }

  // 3. The user row (cascades projects/usage/renders/subscription)
  await prisma.user.delete({ where: { id: user.id } });

  // 4. Local artifacts — best-effort
  for (const sid of scriptIds) {
    await rmrf(path.join(process.cwd(), "src", "generated", sid));
    await rmrf(path.join(process.cwd(), ".data", "renders", `${sid}.mp4`));
    await rmrf(path.join(process.cwd(), ".data", "scripts", `${sid}.json`));
  }
  for (const p of user.projects) {
    await rmrf(path.join(process.cwd(), ".data", "briefs", `${p.id}.json`));
    await rmrf(path.join(process.cwd(), "public", "uploads", p.id));
  }

  return {
    userId: user.id,
    email: user.email,
    projectCount: user.projects.length,
    scriptCount: scriptIds.length,
    r2Deleted,
    scriptDocsDeleted,
    r2Failures,
    stripeCancel,
  };
}
