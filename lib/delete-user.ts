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

export type DeletionSummary = {
  userId: string;
  email: string;
  projectCount: number;
  scriptCount: number;
  r2Deleted: number | null; // null = storage not configured, skipped
  scriptDocsDeleted: number;
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

  // 1. R2 objects
  let r2Deleted: number | null = null;
  if (isStorageConfigured()) {
    r2Deleted = 0;
    for (const p of user.projects) r2Deleted += await deletePrefix(`uploads/${p.id}/`);
    for (const sid of scriptIds) r2Deleted += await deletePrefix(`renders/${sid}`);
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
  };
}
