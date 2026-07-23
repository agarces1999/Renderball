//
// Undo the last editor mutation. Restores the newest store snapshot (manifest +
// every piece body) and recommits — so it reverses insert / move / resize / delete
// / regenerate / text / format uniformly, with no per-op inverse logic.
//
// If the restored store somehow fails to compile, the restore is itself rolled
// back, leaving the user exactly where they were.
//
import { captureUndo, undoLast, undoDepth, writeManifest } from "../agents/lego-store";
import { promises as fs } from "fs";
import path from "path";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";

export interface UndoResult {
  ok: boolean;
  label?: string;
  /** Entries left after this undo — the client hides the control at 0. */
  remaining?: number;
  code?: string;
  error?: string;
}

export const undoEdit = async (genDir: string): Promise<UndoResult> =>
  withGenDirLock(genDir, async () => {
    // Snapshot the CURRENT state first so a failed restore can be put back.
    const before = await captureUndo(genDir);
    const restored = await undoLast(genDir);
    if (!restored.ok) return { ok: false, error: restored.error };

    const res = await commitGenDir(genDir, "undo");
    if (!res.ok) {
      if (before) {
        const piecesDir = path.join(genDir, "lego", "pieces");
        await fs.rm(piecesDir, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(piecesDir, { recursive: true }).catch(() => {});
        for (const [name, body] of Object.entries(before.pieces)) {
          await fs.writeFile(path.join(piecesDir, name), body, "utf8").catch(() => {});
        }
        await writeManifest(genDir, before.manifest).catch(() => {});
      }
      return { ok: false, error: res.error };
    }
    return { ok: true, label: restored.label, remaining: restored.remaining, code: res.code };
  });

/** How many undo steps are available (for enabling the control on load). */
export const undoAvailable = async (genDir: string): Promise<number> => undoDepth(genDir).catch(() => 0);
