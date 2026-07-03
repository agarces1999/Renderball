//
// Resolve + apply one inline text edit to a scene's content. Shared by the auth'd
// /api/preview/edit-element and the dev /api/dev/edit-element routes. Pure (no IO) —
// the caller loads/saves the script.
//
// Resolution: prefer an explicit `path` (data-content-path, precise); fall back to
// `matchText` (the text the user clicked) via findPathByValue, so inline text editing
// works on videos built before the design agent tagged content paths.
//
import {
  getField,
  setField,
  deleteField,
  findPathByValue,
  type SceneContent,
} from "./scene-content";

export interface TextEditInput {
  path?: string;
  matchText?: string;
  op: "edit" | "delete";
  value?: string;
}
export interface TextEditResult {
  ok: boolean;
  path?: string;
  content?: SceneContent;
  error?: string;
}

/**
 * Apply a BATCH of edits to one scene's content in a single pass — the editor's
 * multi-field save sends every changed field at once (one script load/save cycle
 * instead of N sequential round-trips). Edits apply in order against the evolving
 * content; per-edit results report each field's outcome so a partial failure is
 * visible (nothing silently swallowed).
 */
export const applyTextEdits = (
  content: SceneContent,
  edits: TextEditInput[],
): { content: SceneContent; results: TextEditResult[]; okCount: number } => {
  let current = content;
  const results: TextEditResult[] = [];
  let okCount = 0;
  for (const e of edits) {
    const r = applyTextEdit(current, e);
    results.push(r);
    if (r.ok && r.content) {
      current = r.content;
      okCount++;
    }
  }
  return { content: current, results, okCount };
};

export const applyTextEdit = (content: SceneContent, input: TextEditInput): TextEditResult => {
  let path = input.path && input.path.length > 0 ? input.path : undefined;

  // Resolve by matched text when there's no usable path.
  if ((!path || getField(content, path) === undefined) && input.matchText) {
    const found = findPathByValue(content, input.matchText);
    if (found) path = found;
  }

  if (!path || getField(content, path) === undefined) {
    return {
      ok: false,
      error: `no editable text found (path="${input.path ?? ""}", match="${(input.matchText ?? "").slice(0, 40)}")`,
    };
  }
  if (input.op === "edit" && typeof input.value !== "string") {
    return { ok: false, error: "value required for edit" };
  }

  const content2 =
    input.op === "edit" ? setField(content, path, input.value as string) : deleteField(content, path);
  return { ok: true, path, content: content2 };
};
