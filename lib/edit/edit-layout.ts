//
// M3 layout edits — reposition + delete, NO LLM. Both are pure manifest edits
// applied deterministically:
//
//   move:   accumulate a per-piece translate offset in the manifest; the
//           reassembler wraps only that piece in a section-filling translate layer.
//   delete: drop the piece from the scene + strip its template slot + remove its
//           file; the reassembler emits nothing for it.
//
// Both then reassemble the full Composition, finalize (import/stub any undefined
// refs — a no-op here, but keeps every write path identical to build + regen), and
// write. Zero-neighbor is structural: no sibling piece file or body is touched, and
// because pieces are self-positioned there is no reflow — a moved/deleted element
// changes only itself.
//
import { promises as fs } from "fs";
import path from "path";
import {
  readManifest,
  writeManifest,
  readDecomposed,
  writePieceBody,
  setPieceOffset,
  removePieceFromManifest,
  reassembleFromDisk,
  type PieceOffset,
} from "../agents/lego-store";
import { finalizeUndefinedRefs } from "../agents/finalize-refs";
import { verifyCompilable } from "../agents/code-extraction";
import { withGenDirLock } from "./gendir-lock";
import { findChildInScene, removeChildBlock } from "./nested-piece";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Reassemble the CURRENT on-disk manifest, finalize, compile-check, and write
 * Composition.tsx ONLY if it compiles. Callers mutate the manifest first, then call
 * this; on a non-ok result they roll the manifest back, so Composition.tsx and the
 * manifest never desync (Composition is written last, only on success).
 */
const commit = async (genDir: string): Promise<{ ok: boolean; code?: string; error?: string }> => {
  const reassembled = await reassembleFromDisk(genDir);
  const { code } = await finalizeUndefinedRefs(reassembled);
  const compileError = await verifyCompilable(code);
  if (compileError) return { ok: false, error: `layout edit does not compile: ${compileError}` };
  await fs.writeFile(path.join(genDir, "Composition.tsx"), code, "utf8");
  return { ok: true, code };
};

export interface MoveElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** Pixel delta to add to the piece's current offset (a drag). */
  dx: number;
  dy: number;
}
export interface MoveElementResult {
  ok: boolean;
  code?: string;
  offset?: PieceOffset;
  error?: string;
}

export const moveElement = async (input: MoveElementInput): Promise<MoveElementResult> => {
  const { genDir, sceneIndex, pieceId, dx, dy } = input;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { ok: false, error: "dx and dy must be finite numbers" };
  }

  return withGenDirLock(genDir, async () => {
    const snapshot = await readManifest(genDir);
    const piece = snapshot.scenes
      .find((s) => s.sceneIndex === sceneIndex)
      ?.pieces.find((p) => p.id === pieceId);
    if (!piece) {
      // Nested children can be regenerated/deleted but not (yet) moved — their offset
      // would live inside the parent's coordinate space, not the manifest.
      const d = await readDecomposed(genDir);
      const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
      if (scene && findChildInScene(scene, pieceId)) {
        return { ok: false, error: "moving a nested element isn't supported yet — regenerate or delete it, or move the whole group" };
      }
      return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };
    }

    const prev = piece.offset ?? { dx: 0, dy: 0 };
    const offset: PieceOffset = { dx: prev.dx + dx, dy: prev.dy + dy };
    try {
      await setPieceOffset(genDir, sceneIndex, pieceId, offset);
      const res = await commit(genDir);
      if (!res.ok) {
        await writeManifest(genDir, snapshot); // roll back the offset
        return { ok: false, error: res.error };
      }
      return { ok: true, code: res.code, offset };
    } catch (e) {
      await writeManifest(genDir, snapshot).catch(() => {});
      return { ok: false, error: `move failed: ${msg(e)}` };
    }
  });
};

export interface DeleteElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
}
export interface DeleteElementResult {
  ok: boolean;
  code?: string;
  remaining?: number;
  error?: string;
}

export const deleteElement = async (input: DeleteElementInput): Promise<DeleteElementResult> => {
  const { genDir, sceneIndex, pieceId } = input;

  return withGenDirLock(genDir, async () => {
    const snapshot = await readManifest(genDir);
    // A top-level piece: mutate the manifest but DEFER the irreversible body-file
    // delete until commit succeeds, so a compile failure rolls back to an intact store.
    const removed = await removePieceFromManifest(genDir, sceneIndex, pieceId);
    if (removed.ok) {
      try {
        const res = await commit(genDir);
        if (!res.ok) {
          await writeManifest(genDir, snapshot); // restore the piece + slot
          return { ok: false, error: res.error };
        }
        await fs.rm(removed.file!, { force: true }); // safe now — commit succeeded
        const manifest = await readManifest(genDir);
        const remaining = manifest.scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces.length ?? 0;
        return { ok: true, code: res.code, remaining };
      } catch (e) {
        await writeManifest(genDir, snapshot).catch(() => {});
        return { ok: false, error: `delete failed: ${msg(e)}` };
      }
    }

    // Not a top-level piece — it may be a nested CHILD. Splice its <Piece> block out
    // of the parent's body; only the parent piece file changes, no sibling reflows.
    const d = await readDecomposed(genDir);
    const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
    const nested = scene ? findChildInScene(scene, pieceId) : null;
    if (!nested) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };

    const originalBody = nested.parent.body;
    try {
      await writePieceBody(genDir, nested.parent.id, removeChildBlock(originalBody, nested.child));
      const res = await commit(genDir);
      if (!res.ok) {
        await writePieceBody(genDir, nested.parent.id, originalBody); // rollback the parent body
        return { ok: false, error: res.error };
      }
      return { ok: true, code: res.code, remaining: nested.siblings.length };
    } catch (e) {
      await writePieceBody(genDir, nested.parent.id, originalBody).catch(() => {});
      return { ok: false, error: `delete failed: ${msg(e)}` };
    }
  });
};
