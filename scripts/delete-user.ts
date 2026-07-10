/**
 * GDPR / account-deletion CLI — makes the privacy page's promise ("we delete
 * your account data and generated files on request") actually fulfillable.
 * Thin wrapper over lib/delete-user.ts, which the Clerk user.deleted webhook
 * also calls — one deletion path, no drift.
 *
 * Run: npx tsx scripts/delete-user.ts <email-or-userId> [--dry-run]
 */
import { prisma } from "../lib/db";
import { deleteUserData } from "../lib/delete-user";

const arg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!arg) {
  console.error("usage: npx tsx scripts/delete-user.ts <email-or-userId> [--dry-run]");
  process.exit(1);
}

const run = async () => {
  const user = await prisma.user.findFirst({
    where: arg.includes("@") ? { email: arg } : { id: arg },
    include: { projects: { select: { id: true, scriptId: true } } },
  });
  if (!user) {
    console.error(`no user found for "${arg}"`);
    process.exit(1);
  }
  const scriptCount = user.projects.filter((p) => !!p.scriptId).length;
  console.log(
    `user ${user.id} <${user.email}> — ${user.projects.length} project(s), ${scriptCount} script(s)${dryRun ? " [DRY RUN]" : ""}`,
  );
  if (dryRun) {
    console.log("dry run — nothing deleted");
    process.exit(0);
  }

  const summary = await deleteUserData(user.id);
  console.log(
    summary.r2Deleted === null
      ? "r2: storage not configured — skipped"
      : `r2: ${summary.r2Deleted} object(s) deleted`,
  );
  console.log(`scriptDocs: ${summary.scriptDocsDeleted} deleted`);
  console.log("user row deleted (projects/usage/renders cascaded); local artifacts cleaned");
  console.log("DONE — reminder: also delete the user in the Clerk dashboard.");
  await prisma.$disconnect();
};

void run();
