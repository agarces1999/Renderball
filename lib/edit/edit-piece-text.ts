//
// Edit an INSERTED free-text box — its copy and/or its formatting. Deterministic, NO LLM.
//
// Such a text box's copy lives as a JS-string literal inside its own piece body, and
// its formatting in a `data-rb-fmt` spec on the same span (see lib/edit/freetext.ts)
// — NOT in the fixed SceneContent key set, so the normal /edit-element path can't
// touch it. Here we re-emit the whole span from (text, format) via the shared
// emitter, then reassemble → finalize → compile-check → write, rolling the body back
// on failure. Only the one piece file changes; every sibling stays byte-identical.
//
import {
  readManifest,
  readDecomposed,
  writePieceBody,
  captureUndo,
  commitUndo,
} from "../agents/lego-store";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";
import { patchFreetextSpan, readFreetext, themeSwatches, type FreetextFormat } from "./freetext";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface EditPieceTextInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** New copy. Omit to leave the text unchanged (a format-only edit). */
  value?: string;
  /** Formatting patch (size / weight / italic / underline / color / align). */
  format?: Partial<FreetextFormat>;
}
export interface EditPieceTextResult {
  ok: boolean;
  code?: string;
  format?: FreetextFormat;
  error?: string;
}

export const editPieceText = async (input: EditPieceTextInput): Promise<EditPieceTextResult> => {
  const { genDir, sceneIndex, pieceId, value, format } = input;
  if (value === undefined && !format) return { ok: false, error: "nothing to change" };
  if (value !== undefined && typeof value !== "string") return { ok: false, error: "value must be a string" };

  return withGenDirLock(genDir, async () => {
    const d = await readDecomposed(genDir);
    const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
    const piece = scene?.pieces.find((p) => p.id === pieceId);
    if (!piece) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };

    const oldBody = piece.body;
    const newBody = patchFreetextSpan(oldBody, {
      ...(value !== undefined ? { text: value } : {}),
      ...(format ? { format } : {}),
    });
    if (!newBody) {
      return { ok: false, error: "this element has no editable free-text — only inserted text boxes can be edited this way" };
    }

    const undo = await captureUndo(genDir);
    try {
      await writePieceBody(genDir, pieceId, newBody);
      const res = await commitGenDir(genDir, "text edit");
      if (!res.ok) {
        await writePieceBody(genDir, pieceId, oldBody); // roll back
        return { ok: false, error: res.error };
      }
      await commitUndo(genDir, undo, format ? "format" : "text");
      return { ok: true, code: res.code, format: readFreetext(newBody)?.format };
    } catch (e) {
      await writePieceBody(genDir, pieceId, oldBody).catch(() => {});
      return { ok: false, error: `text edit failed: ${msg(e)}` };
    }
  });
};

/** The video's own palette, for the text toolbar's colour swatches. Read from the
 *  frozen design system so every choice stays on-brand. */
export const freetextSwatches = async (genDir: string): Promise<string[]> => {
  const manifest = await readManifest(genDir);
  return themeSwatches(manifest.preamble);
};
