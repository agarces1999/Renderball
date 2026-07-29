/**
 * Account deletion — the GDPR path, and the one place where "it silently did
 * nothing" is a legal problem rather than a bug.
 *
 * Two callers share this function: the CLI and the Clerk `user.deleted` webhook.
 * Nothing verified that it deletes what it claims to. A deletion that reports
 * success while leaving the user's decks, brand copy or usage behind is worse
 * than one that fails loudly — the failure is invisible and the obligation is
 * already breached.
 *
 * The webhook's own signature verification is covered by the QA suite (an
 * unsigned payload must be refused); constructing a valid svix signature needs a
 * library this project does not carry, so the handler's BODY is tested here
 * directly, through the same function it calls.
 *
 * Real rows, real cascade, cleaned up afterwards.
 */
import { prisma } from "./db";
import { deleteUserData } from "./delete-user";
import { saveBrief, saveScript } from "./store";
import { blankBrief, blankScript } from "./documents/blank-document";
import { ulid } from "./ulid";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const run = async () => {
  console.log("account deletion (GDPR)");

  const stamp = ulid();
  let victimId = "";
  let bystanderId = "";
  const victimBrief = ulid();
  const victimScript = ulid();
  const bystanderBrief = ulid();
  const bystanderScript = ulid();

  try {
    const victim = await prisma.user.create({
      data: { clerkId: `DEL_VICTIM_${stamp}`, email: `del-victim-${stamp}@invalid.test` },
    });
    const bystander = await prisma.user.create({
      data: { clerkId: `DEL_BYSTANDER_${stamp}`, email: `del-bystander-${stamp}@invalid.test` },
    });
    victimId = victim.id;
    bystanderId = bystander.id;

    // Both users own a document, so the test can prove the blast radius is
    // exactly one account.
    await saveScript(blankScript(victimScript, 1), victimId);
    await saveBrief(blankBrief(victimBrief, victimId, victimScript));
    await saveScript(blankScript(bystanderScript, 1), bystanderId);
    await saveBrief(blankBrief(bystanderBrief, bystanderId, bystanderScript));

    await check("deleting an unknown user throws rather than reporting success", async () => {
      // A silent success here is how a deletion request gets marked done
      // without anything happening.
      let threw = false;
      try {
        await deleteUserData("user-that-never-existed");
      } catch {
        threw = true;
      }
      assert(threw, "deleteUserData must refuse an id it cannot find");
    });

    await check("deletion removes the user row", async () => {
      const summary = await deleteUserData(victimId);
      assert(!!summary, "a summary should be returned");
      const still = await prisma.user.findUnique({ where: { id: victimId } });
      assert(still === null, "the user row must be gone");
    });

    await check("deletion removes their projects", async () => {
      const projects = await prisma.project.findMany({ where: { ownerId: victimId } });
      assert(projects.length === 0, `${projects.length} project(s) survived the deletion`);
    });

    await check("deletion removes their script documents", async () => {
      // ScriptDoc has no foreign key to Project, so the cascade does NOT reach
      // it — the function has to delete these explicitly. This is exactly the
      // orphan that would keep holding a deleted user's brand copy.
      const doc = await prisma.scriptDoc.findUnique({ where: { id: victimScript } });
      assert(doc === null, "the script document must be deleted explicitly, not left orphaned");
    });

    await check("deletion removes their renders and usage", async () => {
      const renders = await prisma.render.findMany({ where: { ownerId: victimId } });
      assert(renders.length === 0, `${renders.length} render(s) survived`);
      const subs = await prisma.subscription.findMany({ where: { userId: victimId } });
      assert(subs.length === 0, `${subs.length} subscription(s) survived`);
    });

    await check("deletion touches NOBODY else's data", async () => {
      const other = await prisma.user.findUnique({ where: { id: bystanderId } });
      assert(!!other, "the other user must still exist");
      const theirProjects = await prisma.project.findMany({ where: { ownerId: bystanderId } });
      assert(theirProjects.length === 1, `the other user should still own 1 project, has ${theirProjects.length}`);
      const theirDoc = await prisma.scriptDoc.findUnique({ where: { id: bystanderScript } });
      assert(!!theirDoc, "the other user's script document must survive");
    });

    await check("deleting the same user twice does not crash the second time", async () => {
      // The webhook can be re-delivered. The second attempt must refuse
      // cleanly, not throw something the handler turns into a 500 retry loop.
      let message = "";
      try {
        await deleteUserData(victimId);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      assert(/no user with id/.test(message), `expected a clear not-found, got: ${message}`);
    });
  } finally {
    for (const id of [victimId, bystanderId]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.scriptDoc
      .deleteMany({ where: { id: { in: [victimScript, bystanderScript] } } })
      .catch(() => {});
    const left = await prisma.user
      .findMany({ where: { clerkId: { in: [`DEL_VICTIM_${stamp}`, `DEL_BYSTANDER_${stamp}`] } } })
      .catch(() => []);
    console.log(`  · cleanup — users left: ${left.length}`);
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
