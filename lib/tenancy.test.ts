/**
 * Tenant isolation — the check that has to exist before anyone else logs in.
 *
 * Every route resolves a document as `loadScript(id, user.id)` or
 * `loadBriefByScriptId(id, user.id)`, so the ONLY thing standing between two
 * customers' decks is whether those functions honour the owner argument. Nothing
 * verified that they do. A regression there is not a bug report, it is a breach:
 * one user editing, exporting or deleting another's work, with the id being the
 * only thing they'd need to guess.
 *
 * These tests create two real users, give one a document, and assert the other
 * cannot reach it by any store path. They run against the real database because
 * that is where the predicate lives — an in-memory stub would prove nothing.
 *
 * Everything created is removed at the end, including on failure.
 */
import { prisma } from "./db";
import {
  loadBrief,
  loadBriefByScriptId,
  loadScript,
  listBriefsByOwner,
  saveBrief,
  saveScript,
} from "./store";
import { blankBrief, blankScript } from "./documents/blank-document";
import { ulid } from "./ulid";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const stamp = ulid();
const mk = (tag: string) => ({
  clerkId: `TENANCY_${tag}_${stamp}`,
  email: `tenancy-${tag}-${stamp}@invalid.test`,
});

const run = async () => {
  console.log("tenant isolation");

  let ownerId = "";
  let intruderId = "";
  const briefId = ulid();
  const scriptId = ulid();

  try {
    const owner = await prisma.user.create({ data: mk("owner") });
    const intruder = await prisma.user.create({ data: mk("intruder") });
    ownerId = owner.id;
    intruderId = intruder.id;

    await saveScript(blankScript(scriptId, 1), ownerId);
    await saveBrief(blankBrief(briefId, ownerId, scriptId));

    await check("the owner can read their own document", async () => {
      assert(!!(await loadScript(scriptId, ownerId)), "the owner should be able to load their script");
      assert(!!(await loadBrief(briefId, ownerId)), "the owner should be able to load their brief");
      assert(
        !!(await loadBriefByScriptId(scriptId, ownerId)),
        "the owner should be able to resolve their brief by script id",
      );
    });

    await check("another user CANNOT load the script, even knowing its id", async () => {
      const stolen = await loadScript(scriptId, intruderId);
      assert(stolen === null, "loadScript must refuse a script the caller does not own");
    });

    await check("another user CANNOT load the brief", async () => {
      const stolen = await loadBrief(briefId, intruderId);
      assert(stolen === null, "loadBrief must refuse a brief the caller does not own");
    });

    await check("another user CANNOT resolve the brief by script id", async () => {
      const stolen = await loadBriefByScriptId(scriptId, intruderId);
      assert(stolen === null, "loadBriefByScriptId must refuse a document the caller does not own");
    });

    await check("the gallery shows a user only their OWN documents", async () => {
      const theirs = await listBriefsByOwner(ownerId);
      const others = await listBriefsByOwner(intruderId);
      assert(theirs.some((b) => b.id === briefId), "the owner's gallery should include their document");
      assert(
        !others.some((b) => b.id === briefId),
        "another user's gallery must not include someone else's document",
      );
    });

    await check("an empty owner id does not act as a wildcard", async () => {
      // A missing session must never read as "match anything" — the classic
      // shape of this bug.
      assert((await loadScript(scriptId, "")) === null, "an empty owner must not match");
      assert((await loadBriefByScriptId(scriptId, "")) === null, "an empty owner must not match");
      assert((await listBriefsByOwner("")).length === 0, "an empty owner must list nothing");
    });

    await check("a malformed id is refused rather than probed", async () => {
      // Path-traversal shapes and non-ULIDs are rejected before touching storage.
      for (const bad of ["../../etc/passwd", ".env.local", "'; DROP TABLE users;--", ""]) {
        assert((await loadScript(bad, ownerId)) === null, `malformed id "${bad}" must not resolve`);
        assert((await loadBrief(bad, ownerId)) === null, `malformed id "${bad}" must not resolve`);
      }
    });

    await check("a script cannot be written on behalf of a user who does not exist", async () => {
      // pgSaveScript refuses when the owner is gone — the GDPR guard. It must
      // not throw, so an in-flight build cannot crash on a deleted account.
      const orphanScriptId = ulid();
      await saveScript(blankScript(orphanScriptId, 1), "user-that-does-not-exist");
      const doc = await prisma.scriptDoc.findUnique({ where: { id: orphanScriptId } });
      assert(doc === null, "a script for a nonexistent owner must not be persisted");
    });
  } finally {
    // Cleanup — cascades remove the project; the script doc has no FK.
    for (const id of [ownerId, intruderId]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.scriptDoc.deleteMany({ where: { id: scriptId } }).catch(() => {});
    const leftOwner = ownerId ? await prisma.user.findUnique({ where: { id: ownerId } }).catch(() => null) : null;
    const leftDoc = await prisma.scriptDoc.findUnique({ where: { id: scriptId } }).catch(() => null);
    console.log(`  · cleanup — users:${leftOwner ? "LEFT" : "gone"} scriptdoc:${leftDoc ? "LEFT" : "gone"}`);
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
