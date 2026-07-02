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
