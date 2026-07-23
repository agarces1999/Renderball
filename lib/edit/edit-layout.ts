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
  captureUndo,
  commitUndo,
  type PieceOffset,
} from "../agents/lego-store";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";
import { findChildInScene, removeChildBlock } from "./nested-piece";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The shared reassemble → finalize → compile-check → write barrier (lib/edit/commit.ts). */
const commit = (genDir: string) => commitGenDir(genDir, "layout edit");

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
    const undo = await captureUndo(genDir);
    try {
      await setPieceOffset(genDir, sceneIndex, pieceId, offset);
      const res = await commit(genDir);
      if (!res.ok) {
        await writeManifest(genDir, snapshot); // roll back the offset
        return { ok: false, error: res.error };
      }
      await commitUndo(genDir, undo, "move");
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
    const undo = await captureUndo(genDir);
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
        await commitUndo(genDir, undo, "delete");
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
      await commitUndo(genDir, undo, "delete");
      return { ok: true, code: res.code, remaining: nested.siblings.length };
    } catch (e) {
      await writePieceBody(genDir, nested.parent.id, originalBody).catch(() => {});
      return { ok: false, error: `delete failed: ${msg(e)}` };
    }
  });
};

// ── resize ──────────────────────────────────────────────────────────────────
// A piece's box lives as literal `left/top/width/height` on the outermost
// positioned wrapper its body opens with — the shape BOTH the inserted primitives
// (lib/edit/insert-element.ts) and the cast assembler (assemble.ts emitPiece)
// emit. Resizing rewrites those literals in place. Bodies that don't open with
// such a wrapper (freeform design-agent markup) are rejected with a clear reason
// rather than silently resizing some inner decorative div.

/** Match the body's FIRST element when it is a positioned wrapper: captures its
 *  flat style object so we only ever rewrite the piece's own box. */
const WRAPPER_RX = /^(\s*<div[^>]*?style=\{\{)([^{}]*position:\s*"absolute"[^{}]*)(\}\})/;

const setStyleNum = (style: string, key: string, value: number): string =>
  new RegExp(`(\\b${key}:\\s*)(-?[0-9.]+)`).test(style)
    ? style.replace(new RegExp(`(\\b${key}:\\s*)(-?[0-9.]+)`), `$1${value}`)
    : style;

export interface ResizeElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** The new box in absolute canvas px (what the user dragged the handles to). */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ResizeElementResult {
  ok: boolean;
  code?: string;
  error?: string;
}

export const resizeElement = async (input: ResizeElementInput): Promise<ResizeElementResult> => {
  const { genDir, sceneIndex, pieceId, x, y, w, h } = input;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return { ok: false, error: "resize needs finite bounds with positive width and height" };
  }

  return withGenDirLock(genDir, async () => {
    const d = await readDecomposed(genDir);
    const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
    const piece = scene?.pieces.find((p) => p.id === pieceId);
    if (!piece) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };

    const m = piece.body.match(WRAPPER_RX);
    if (!m) {
      return {
        ok: false,
        error: "this element isn't a positioned box, so it can't be resized yet — try Regenerate and say what size you want",
      };
    }

    // The rendered position already includes any persisted move offset, and the
    // caller sends absolute bounds — so bake the new origin into the body and clear
    // the offset, otherwise the two would stack and the piece would jump.
    const manifest = await readManifest(genDir);
    const meta = manifest.scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces.find((p) => p.id === pieceId);
    const hadOffset = !!meta?.offset;

    let style = m[2];
    style = setStyleNum(style, "left", Math.round(x));
    style = setStyleNum(style, "top", Math.round(y));
    style = setStyleNum(style, "width", Math.round(w));
    style = setStyleNum(style, "maxWidth", Math.round(w)); // text wrappers flow-size on maxWidth
    style = setStyleNum(style, "height", Math.round(h));
    const newBody = piece.body.replace(WRAPPER_RX, (_full, open: string, _s: string, close: string) => open + style + close);

    const snapshot = await readManifest(genDir);
    const undo = await captureUndo(genDir);
    try {
      await writePieceBody(genDir, pieceId, newBody);
      if (hadOffset && meta) {
        delete meta.offset;
        await writeManifest(genDir, manifest);
      }
      const res = await commit(genDir);
      if (!res.ok) {
        await writePieceBody(genDir, pieceId, piece.body);
        if (hadOffset) await writeManifest(genDir, snapshot);
        return { ok: false, error: res.error };
      }
      await commitUndo(genDir, undo, "resize");
      return { ok: true, code: res.code };
    } catch (e) {
      await writePieceBody(genDir, pieceId, piece.body).catch(() => {});
      if (hadOffset) await writeManifest(genDir, snapshot).catch(() => {});
      return { ok: false, error: `resize failed: ${msg(e)}` };
    }
  });
};
