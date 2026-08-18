//
// Duplicate an element — the editor's ⌘D. Deterministic, NO LLM, free.
//
// A clone is just an insert whose body comes from an existing piece instead of a
// template or a model: allocate a fresh id, rewrite every id-bearing attribute in
// the copied body so the two pieces stay independently addressable, offset it a
// little so it reads as a new object rather than a redraw, then hand it to
// lego-store.insertPiece and commit through the shared barrier. On any failure the
// manifest and the orphan body file are rolled back, exactly like insert-element.
//
// The clone lands directly ON TOP of its source: insertPiece splices the new slot
// after the existing content slots (before chrome), and the body keeps the source's
// zIndex, so equal level + later DOM order paints it above. That matches what every
// editor does — the copy is the thing you are now holding.
//
import { promises as fs } from "fs";
import path from "path";
import {
  readManifest,
  writeManifest,
  readDecomposed,
  insertPiece,
  nextPieceId,
  captureUndo,
  commitUndo,
  type PieceOffset,
} from "../agents/lego-store";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Where the copy lands relative to its source, in canvas px. Small enough to read
 *  as "the same thing, offset", big enough that the two are separately clickable. */
export const DUPLICATE_OFFSET = 24;

/**
 * Rewrite every id-bearing attribute in a copied body so the clone collides with
 * nothing. Three kinds of attribute matter:
 *
 *   data-piece="…"  the editor's hit-test / selection key. Two nodes answering to
 *                   the same id would give the x-ray a duplicate key and make a
 *                   click ambiguous.
 *   id="…"          nested <Piece> children (composite pieces). By convention a
 *                   child id extends its parent's ("s2.panel" → "s2.panel.card1"),
 *                   so re-prefixing keeps the whole subtree consistent in one pass.
 *   data-throughline the cross-scene motif marker. DROPPED on purpose: the
 *                   throughline is a single narrative object tracked across scenes,
 *                   and a second copy of it inside one scene is not a second
 *                   throughline — it is decoration. The presence/drift gates count
 *                   these, so cloning the marker would corrupt their reading.
 *
 * Any id that does NOT follow the parent-prefix convention still has to become
 * unique, so it gets a deterministic suffix rather than being left to collide.
 */
export const cloneBody = (body: string, oldId: string, newId: string): string => {
  let out = body.replace(
    /(\sdata-piece=")([^"]*)(")/g,
    (_m, pre: string, id: string, post: string) => `${pre}${id === oldId ? newId : id}${post}`,
  );
  let n = 0;
  out = out.replace(/(\sid=")([^"]*)(")/g, (_m, pre: string, id: string, post: string) => {
    if (id === oldId) return `${pre}${newId}${post}`;
    if (id.startsWith(`${oldId}.`)) return `${pre}${newId}${id.slice(oldId.length)}${post}`;
    return `${pre}${newId}.c${++n}${post}`; // off-convention id — make it unique anyway
  });
  // Strip the throughline marker (attribute and, when it is the only attribute
  // content, nothing else changes — the element itself stays).
  out = out.replace(/\sdata-throughline="[^"]*"/g, "");
  return out;
};

/** The clone's `<Piece>` marker: the source's, with the id swapped and the
 *  throughline attribute dropped (see cloneBody). */
export const cloneOpenTag = (openTag: string, oldId: string, newId: string): string =>
  openTag
    .replace(new RegExp(`(\\sid=")${oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`), `$1${newId}$2`)
    .replace(/\sthroughline="[^"]*"/g, "");

export interface DuplicateElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** Offset of the copy from its source, in canvas px. Defaults to DUPLICATE_OFFSET. */
  dx?: number;
  dy?: number;
}
export interface DuplicateElementResult {
  ok: boolean;
  pieceId?: string;
  code?: string;
  error?: string;
}

export const duplicateElement = async (
  input: DuplicateElementInput,
): Promise<DuplicateElementResult> => {
  const { genDir, sceneIndex, pieceId } = input;
  const dx = input.dx ?? DUPLICATE_OFFSET;
  const dy = input.dy ?? DUPLICATE_OFFSET;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { ok: false, error: "duplicate offset must be finite" };
  }

  return withGenDirLock(genDir, async () => {
    const snapshot = await readManifest(genDir);
    const scene = snapshot.scenes.find((s) => s.sceneIndex === sceneIndex);
    if (!scene) return { ok: false, error: `scene ${sceneIndex} not found` };
    const meta = scene.pieces.find((p) => p.id === pieceId);
    if (!meta) {
      // Nested children live inside a parent's body, not the manifest — duplicating
      // one would mean splicing a sibling block into the parent, which is a
      // different (and not yet supported) edit than cloning a top-level piece.
      return {
        ok: false,
        error: `piece "${pieceId}" not found in scene ${sceneIndex} — nested elements can't be duplicated yet, duplicate the group instead`,
      };
    }

    const d = await readDecomposed(genDir);
    const src = d.scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces.find((p) => p.id === pieceId);
    if (!src) return { ok: false, error: `piece "${pieceId}" has no body on disk` };

    const id = await nextPieceId(genDir, sceneIndex);
    const body = cloneBody(src.body, pieceId, id);
    const openTag = cloneOpenTag(meta.openTag, pieceId, id);
    // The copy inherits the source's persisted move and adds the nudge, so it lands
    // beside where the source actually RENDERS, not beside its pre-move origin.
    const base: PieceOffset = meta.offset ?? { dx: 0, dy: 0 };
    const offset: PieceOffset = { dx: base.dx + dx, dy: base.dy + dy };

    const undo = await captureUndo(genDir);
    try {
      const inserted = await insertPiece(genDir, {
        sceneIndex,
        id,
        kind: meta.kind,
        openTag,
        body,
        offset,
      });
      if (!inserted) return { ok: false, error: "duplicate failed — scene missing or id collision" };

      const res = await commitGenDir(genDir, "duplicated element");
      // The slot must have landed in the template, else reassemble silently dropped
      // the clone. Assert the marker is present; roll back if not.
      if (!res.ok || !res.code || !res.code.includes(openTag)) {
        await writeManifest(genDir, snapshot);
        await fs.rm(path.join(genDir, "lego", "pieces", `${id}.tsx`), { force: true });
        return { ok: false, error: res.error || "the duplicate did not materialize in the composition" };
      }
      await commitUndo(genDir, undo, "duplicate");
      return { ok: true, pieceId: id, code: res.code };
    } catch (e) {
      await writeManifest(genDir, snapshot).catch(() => {});
      await fs.rm(path.join(genDir, "lego", "pieces", `${id}.tsx`), { force: true }).catch(() => {});
      return { ok: false, error: `duplicate failed: ${msg(e)}` };
    }
  });
};
