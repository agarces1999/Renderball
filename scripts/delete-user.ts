/**
 * GDPR / account-deletion tool — makes the privacy page's promise ("we delete
 * your account data and generated files on request") actually fulfillable.
 * Until the Clerk user.deleted webhook lands this is run manually; the webhook
 * will call the same steps.
 *
 * Deletes, in order:
 *   1. R2 objects: uploads/<briefId>/* per project + renders/<scriptId>* per
 *      script (best-effort; skipped when STORAGE_* unset).
 *   2. ScriptDoc rows — NO foreign key to Project (saveScript runs before the
 *      brief learns its script_id), so Prisma's cascade misses them; deleted
 *      explicitly via each project's scriptId.
 *   3. The User row — cascades Projects, UsageRecords, Renders, Subscription.
 *   4. Local artifacts: src/generated/<scriptId>/, .data/renders/<scriptId>.mp4,
 *      .data file-store JSON (legacy) — best-effort.
 *
 * Run: npx tsx scripts/delete-user.ts <email-or-userId> [--dry-run]
 */
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../lib/db";
import { deletePrefix, isStorageConfigured } from "../lib/storage/r2";

const arg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!arg) {
  console.error("usage: npx tsx scripts/delete-user.ts <email-or-userId> [--dry-run]");
  process.exit(1);
}

const rmrf = async (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => {});

const run = async () => {
  const user = await prisma.user.findFirst({
    where: arg.includes("@") ? { email: arg } : { id: arg },
    include: { projects: { select: { id: true, scriptId: true } } },
  });
  if (!user) {
    console.error(`no user found for "${arg}"`);
    process.exit(1);
  }
  const scriptIds = user.projects.map((p) => p.scriptId).filter((s): s is string => !!s);
  console.log(
    `user ${user.id} <${user.email}> — ${user.projects.length} project(s), ${scriptIds.length} script(s)${dryRun ? " [DRY RUN]" : ""}`,
  );
  if (dryRun) {
    console.log("dry run — nothing deleted");
    process.exit(0);
  }

  // 1. R2 objects
  if (isStorageConfigured()) {
    let n = 0;
    for (const p of user.projects) n += await deletePrefix(`uploads/${p.id}/`);
    for (const sid of scriptIds) n += await deletePrefix(`renders/${sid}`);
    console.log(`r2: ${n} object(s) deleted`);
  } else {
    console.log("r2: storage not configured — skipped");
  }

  // 2. ScriptDocs (no FK — cascade misses them)
  if (scriptIds.length > 0) {
    const r = await prisma.scriptDoc.deleteMany({ where: { id: { in: scriptIds } } });
    console.log(`scriptDocs: ${r.count} deleted`);
  }

  // 3. The user row (cascades projects/usage/renders/subscription)
  await prisma.user.delete({ where: { id: user.id } });
  console.log("user row deleted (projects/usage/renders cascaded)");

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
  console.log("local artifacts cleaned");
  console.log("DONE — reminder: also delete the user in the Clerk dashboard.");
  await prisma.$disconnect();
};

void run();
