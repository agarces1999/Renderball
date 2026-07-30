/**
 * Deleting one document.
 *
 * A new destructive operation, so the questions are the destructive ones: does
 * it remove everything the document owned, does it stop at the boundary of that
 * document, and can a stranger reach it. Real rows, real files, cleaned up.
 *
 * The ownership case is the one that would be catastrophic and is invisible
 * from reading the happy path: the lookup is filtered by ownerId, so a caller
 * holding someone else's id must get nothing and change nothing.
 */
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "./db";
import { deleteDocument } from "./delete-document";
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

const exists = (p: string) => fs.stat(p).then(() => true).catch(() => false);

const run = async () => {
  console.log("delete document");

  const stamp = ulid();
  const ids: { brief: string; script: string }[] = [];
  let ownerId = "";
  let strangerId = "";

  const makeDoc = async (owner: string) => {
    const brief = ulid();
    const script = ulid();
    await saveScript(blankScript(script, 2), owner);
    await saveBrief(blankBrief(brief, owner, script, 2));
    ids.push({ brief, script });
    return { brief, script };
  };

  try {
    const owner = await prisma.user.create({
      data: { clerkId: `DELDOC_OWNER_${stamp}`, email: `deldoc-owner-${stamp}@invalid.test` },
    });
    const stranger = await prisma.user.create({
      data: { clerkId: `DELDOC_OTHER_${stamp}`, email: `deldoc-other-${stamp}@invalid.test` },
    });
    ownerId = owner.id;
    strangerId = stranger.id;

    // ── ownership ──────────────────────────────────────────────────────────

    await check("a stranger cannot delete someone else's document", async () => {
      const doc = await makeDoc(ownerId);
      const attempt = await deleteDocument(doc.brief, strangerId);
      assert(attempt === null, "deleting must be owner-scoped");
      const still = await prisma.project.findUnique({ where: { id: doc.brief } });
      assert(!!still, "the document must survive a stranger's attempt");
      const script = await prisma.scriptDoc.findUnique({ where: { id: doc.script } });
      assert(!!script, "and so must its script");
    });

    await check("a document that does not exist reads the same as one that isn't yours", async () => {
      // Both null — so a signed-in caller cannot probe the id space to learn
      // which documents are out there.
      const invented = await deleteDocument(ulid(), ownerId);
      assert(invented === null, "an unknown id returns null");
    });

    // ── the deletion itself ────────────────────────────────────────────────

    await check("deleting removes the project AND its script", async () => {
      const doc = await makeDoc(ownerId);
      const result = await deleteDocument(doc.brief, ownerId);
      assert(result?.projectId === doc.brief, `it should report what it deleted, got ${result?.projectId}`);

      const project = await prisma.project.findUnique({ where: { id: doc.brief } });
      assert(!project, "the project row should be gone");
      // No FK from Project to ScriptDoc, so nothing cascades — this is the row
      // that gets orphaned if the deletion forgets it.
      const script = await prisma.scriptDoc.findUnique({ where: { id: doc.script } });
      assert(!script, "the script row should be gone too, since no cascade reaches it");
    });

    await check("the scriptId works as the id, because both appear in URLs", async () => {
      const doc = await makeDoc(ownerId);
      const result = await deleteDocument(doc.script, ownerId);
      assert(result?.projectId === doc.brief, "passing the scriptId should find the same document");
      assert(!(await prisma.project.findUnique({ where: { id: doc.brief } })), "and delete it");
    });

    await check("local artifacts go with it", async () => {
      const doc = await makeDoc(ownerId);
      const genDir = path.join(process.cwd(), "src", "generated", doc.script);
      const thumb = path.join(process.cwd(), ".data", "thumbs", `${doc.script}.png`);
      await fs.mkdir(genDir, { recursive: true });
      await fs.writeFile(path.join(genDir, "marker.txt"), "x");
      await fs.mkdir(path.dirname(thumb), { recursive: true });
      await fs.writeFile(thumb, "x");

      await deleteDocument(doc.brief, ownerId);
      assert(!(await exists(genDir)), "the generated sources should be removed");
      assert(!(await exists(thumb)), "the cached thumbnail should be removed");
    });

    await check("deleting one document does not touch any other", async () => {
      const keep = await makeDoc(ownerId);
      const go = await makeDoc(ownerId);
      await deleteDocument(go.brief, ownerId);
      assert(!!(await prisma.project.findUnique({ where: { id: keep.brief } })), "the sibling survives");
      assert(!!(await prisma.scriptDoc.findUnique({ where: { id: keep.script } })), "so does its script");
      await deleteDocument(keep.brief, ownerId);
    });

    await check("deleting twice is a clean no-op, not a crash", async () => {
      const doc = await makeDoc(ownerId);
      await deleteDocument(doc.brief, ownerId);
      const again = await deleteDocument(doc.brief, ownerId);
      assert(again === null, "the second delete finds nothing and says so");
    });

    await check("a deleted document takes its share link with it", async () => {
      // The share token lives on the Project row, so deleting the row must end
      // the public link — otherwise a deck outlives the document in every chat
      // it was pasted into.
      const doc = await makeDoc(ownerId);
      const { enableShare, loadSharedDocument } = await import("./share");
      const state = await enableShare(doc.script, ownerId);
      assert(!!state?.token, "precondition: the document is shared");
      assert(!!(await loadSharedDocument(state!.token!)), "precondition: the link works");

      await deleteDocument(doc.brief, ownerId);
      assert(
        (await loadSharedDocument(state!.token!)) === null,
        "a deleted document's public link must stop resolving",
      );
    });
  } finally {
    for (const { brief, script } of ids) {
      await prisma.project.deleteMany({ where: { id: brief } }).catch(() => {});
      await prisma.scriptDoc.deleteMany({ where: { id: script } }).catch(() => {});
      await fs.rm(path.join(process.cwd(), "src", "generated", script), { recursive: true, force: true }).catch(() => {});
    }
    for (const id of [ownerId, strangerId]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    console.log(`  · cleanup — ${ids.length} documents swept`);
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
