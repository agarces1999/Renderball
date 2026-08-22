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
  storeErrorMessage,
} from "../agents/lego-store";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";
import { patchFreetextSpan, readFreetext, themeSwatches, type FreetextFormat } from "./freetext";
import { patchLiteral } from "./piece-literal";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Which run of hardcoded text to rewrite, when the piece has no free-text span and no
 * SceneContent binding. See lib/edit/piece-literal.ts for why `occurrence` and `total`
 * are both required: they are what tells a genuinely repeated literal apart from one
 * literal rendered many times by a `.map()`, where a patch would rewrite every copy.
 */
export interface LiteralTarget {
  /** The rendered string the user clicked (DOM textContent, ASCII-trimmed). */
  oldText: string;
  /** 0-based index among same-text elements in the piece's DOM. */
  occurrence: number;
  /** How many same-text elements the DOM shows. */
  total: number;
}

/**
 * Validate an untrusted `literal` field off the wire. Shared by the auth'd and dev
 * routes so the shape is checked once, not twice slightly differently. Returns null
 * for "absent or malformed" — the caller then treats the request as a free-text edit,
 * which fails with its own clear message rather than patching something unintended.
 */
export const parseLiteralTarget = (raw: unknown): LiteralTarget | null => {
  if (!raw || typeof raw !== "object") return null;
  const { oldText, occurrence, total } = raw as Record<string, unknown>;
  if (typeof oldText !== "string" || !oldText.trim()) return null;
  if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) return null;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 1) return null;
  if (occurrence >= total) return null;
  return { oldText, occurrence, total };
};

export interface EditPieceTextInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** New copy. Omit to leave the text unchanged (a format-only edit). */
  value?: string;
  /** Formatting patch (size / weight / italic / underline / color / align). */
  format?: Partial<FreetextFormat>;
  /**
   * Rewrite a hardcoded JSX literal instead of a free-text span. Mutually exclusive
   * with `format` — a literal has no format spec to patch.
   */
  literal?: LiteralTarget;
}
export interface EditPieceTextResult {
  ok: boolean;
  code?: string;
  format?: FreetextFormat;
  error?: string;
}

export const editPieceText = async (input: EditPieceTextInput): Promise<EditPieceTextResult> => {
  const { genDir, sceneIndex, pieceId, value, format, literal } = input;
  if (value === undefined && !format) return { ok: false, error: "nothing to change" };
  if (value !== undefined && typeof value !== "string") return { ok: false, error: "value must be a string" };
  if (literal && format) return { ok: false, error: "a hardcoded literal has no format spec to change" };
  if (literal && value === undefined) return { ok: false, error: "a literal edit needs a new value" };

  return withGenDirLock(genDir, async () => {
    const d = await readDecomposed(genDir);
    const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
    const piece = scene?.pieces.find((p) => p.id === pieceId);
    if (!piece) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };

    const oldBody = piece.body;
    let newBody: string | null;
    if (literal) {
      const r = patchLiteral(oldBody, { ...literal, newText: value as string });
      if (!r.ok) {
        // Each reason is a different sentence to the user, because each has a
        // different remedy — and "ambiguous" is a deliberate refusal, not a failure.
        return {
          ok: false,
          error:
            r.reason === "ambiguous"
              ? "this text is repeated from a single source line, so editing one copy would change them all — regenerate the element instead"
              : r.reason === "empty"
                ? "text cannot be empty"
                : "could not locate that text in this element — it may have changed since the page loaded",
        };
      }
      newBody = r.body;
    } else {
      newBody = patchFreetextSpan(oldBody, {
        ...(value !== undefined ? { text: value } : {}),
        ...(format ? { format } : {}),
      });
    }
    if (!newBody) {
      return { ok: false, error: "this element has no editable free-text — only inserted text boxes can be edited this way" };
    }

    const undo = await captureUndo(genDir);
    try {
      await writePieceBody(genDir, pieceId, newBody);
      const res = await commitGenDir(genDir, "text edit", { checkRender: true });
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
    // readDecomposed above the inner try throws too — uncaught, it escaped the
    // route as a non-JSON 500 instead of the store's own sentence.
  }).catch((e) => ({ ok: false, error: storeErrorMessage(e) }));
};

/** The video's own palette, for the text toolbar's colour swatches. Read from the
 *  frozen design system so every choice stays on-brand. */
export const freetextSwatches = async (genDir: string): Promise<string[]> => {
  const manifest = await readManifest(genDir);
  return themeSwatches(manifest.preamble);
};
