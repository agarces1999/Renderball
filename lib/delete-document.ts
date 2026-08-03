//
// Deleting ONE document.
//
// This did not exist. A user could create decks and never remove them — no
// button, no route, nothing — which is a strange gap for a product whose whole
// promise is "make a lot of these quickly", and an uncomfortable one next to a
// privacy policy that talks about deleting your data.
//
// Modelled on lib/delete-user.ts and its ordering, for the same reasons:
//
//   1. Storage first, because the DB row is what we need to FIND the objects.
//      Best-effort per prefix — an R2 outage must not block the deletion the
//      user can actually observe.
//   2. The ScriptDoc, which has no foreign key and is missed by any cascade.
//   3. The Project row. This is the one that makes the document disappear.
//   4. Local artifacts, best-effort. On a container these are a cache; on a
//      developer's machine they are the working copy.
//
// Owner-scoped by construction: the lookup is filtered by ownerId, so a caller
// who knows an id they do not own gets "not found" and nothing happens.
//
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "./db";
import { deletePrefix, isStorageConfigured } from "./storage/r2";

export interface DocumentDeletion {
  projectId: string;
  scriptId: string | null;
  storageDeleted: number | null;
  storageFailures: string[];
}

const rmrf = async (p: string): Promise<void> => {
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
};

/**
 * Delete a document the given user owns.
 *
 * Returns null when there is no such document FOR THAT USER — the caller turns
 * that into a 404, so a stranger cannot tell "not yours" from "does not exist".
 *
 * Accepts either the project id or the scriptId, because both appear in URLs:
 * the document list links by project, the editor by script.
 */
export const deleteDocument = async (
  idOrScriptId: string,
  ownerId: string,
): Promise<DocumentDeletion | null> => {
  const project = await prisma.project.findFirst({
    where: {
      ownerId,
      OR: [{ id: idOrScriptId }, { scriptId: idOrScriptId }],
    },
    select: { id: true, scriptId: true },
  });
  if (!project) return null;

  const { id: projectId, scriptId } = project;

  // THE ROWS FIRST. Deleting the database rows is what makes the document
  // disappear for the user; everything else is housekeeping they cannot see.
  //
  // Storage used to be cleaned FIRST, and awaited: listing and deleting R2
  // objects is several network round trips to Cloudflare, and the user watched
  // a spinner through all of them before the card went away. Nothing about that
  // ordering was load-bearing — a storage failure was already caught and logged
  // rather than blocking the delete.
  //
  // No FK from Project to ScriptDoc, so nothing cascades to it.
  if (scriptId) {
    await prisma.scriptDoc.deleteMany({ where: { id: scriptId } }).catch((err) => {
      console.error(`[delete-document] scriptDoc ${scriptId} not deleted:`, err);
    });
  }
  await prisma.project.delete({ where: { id: projectId } });

  // Everything below is invisible to the user, so it happens after we answer.
  // Orphaned objects are a sweep job; a slow delete is a bad product.
  // Local disk is milliseconds and the caller can observe it, so it stays
  // awaited. Only the NETWORK goes to the background.
  if (scriptId) {
    await rmrf(path.join(process.cwd(), "src", "generated", scriptId));
    await rmrf(path.join(process.cwd(), ".data", "renders", `${scriptId}.mp4`));
    await rmrf(path.join(process.cwd(), ".data", "scripts", `${scriptId}.json`));
    await rmrf(path.join(process.cwd(), ".data", "thumbs", `${scriptId}.png`));
    await rmrf(path.join(process.cwd(), ".data", "thumbs", `${scriptId}.og.jpg`));
  }
  await rmrf(path.join(process.cwd(), ".data", "briefs", `${projectId}.json`));
  await rmrf(path.join(process.cwd(), "public", "uploads", projectId));

  // R2 is several round trips to Cloudflare and nothing the user can see.
  // Orphaned objects are a sweep job; a slow delete is a bad product.
  if (isStorageConfigured()) {
    void (async () => {
      for (const prefix of [`uploads/${projectId}/`, ...(scriptId ? [`renders/${scriptId}`] : [])]) {
        try {
          await deletePrefix(prefix);
        } catch (err) {
          console.error(`[delete-document] deletePrefix("${prefix}") failed — SWEEP LATER:`, err);
        }
      }
    })().catch(() => {});
  }

  return { projectId, scriptId, storageDeleted: null, storageFailures: [] };
};
