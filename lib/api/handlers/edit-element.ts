/**
 * Inline text edit — ONE implementation, both lanes (the signed-in editor and
 * the headless QA harness). No-LLM: updates script.scenes[K].content by path
 * (or by matched text) and re-saves; the preview iframe and the MP4 both read
 * the script, so the change shows in both.
 *
 * Extracted 2026-08-14 from the byte-identical `app/api/preview/edit-element`
 * and `app/api/dev/edit-element` pair, which had already drifted: the preview
 * copy grew "(script has N scenes)" on its out-of-range error and the dev copy
 * did not. Callers pass an ownerId; this module never learns which lane it is
 * serving, so the two cannot diverge again.
 */
import path from "path";
import { promises as fs } from "fs";
import { loadScript, saveScript } from "../../store";
import { editableFields, type SceneContent } from "../../edit/scene-content";
import { applyTextEdit, applyTextEdits, type TextEditInput } from "../../edit/apply-text-edit";
import type { HandlerResult } from "../route-owner";

/** Best-effort: keep the MP4-reuse contract by refreshing the built script.json.
 *  A missing genDir just means the next render rebuilds with the new content
 *  (still correct, just not reusing the cached composition). */
const refreshBuiltScript = async (scriptId: string, script: unknown): Promise<void> => {
  try {
    const genScript = path.join(process.cwd(), "src", "generated", scriptId, "script.json");
    await fs.writeFile(genScript, JSON.stringify(script, null, 2));
  } catch {
    /* genDir not built yet — fine */
  }
};

/**
 * List the editable copy fields for one scene, so the editor can decide
 * (client-side) whether a clicked text element maps to bound content and
 * resolve its exact path.
 */
export const listEditableFields = async (
  url: URL,
  ownerId: string,
): Promise<HandlerResult> => {
  const scriptId = url.searchParams.get("scriptId");
  const sceneIndexRaw = url.searchParams.get("sceneIndex");
  const sceneIndex = Number(sceneIndexRaw);
  if (!scriptId) return { status: 400, body: { error: "scriptId required" } };
  // Number(null) === 0 — an absent param must be a 400, not silently scene 0.
  if (sceneIndexRaw === null || !Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return { status: 400, body: { error: "sceneIndex must be a non-negative integer" } };
  }
  const script = await loadScript(scriptId, ownerId);
  if (!script) return { status: 404, body: { error: "script not found" } };
  if (sceneIndex >= script.scenes.length) {
    return {
      status: 400,
      body: { error: `sceneIndex ${sceneIndex} out of range (script has ${script.scenes.length} scenes)` },
    };
  }
  const content = ((script.scenes[sceneIndex] as { content?: unknown }).content ?? {}) as SceneContent;
  return { status: 200, body: { ok: true, sceneIndex, fields: editableFields(content) } };
};

export interface EditElementBody {
  scriptId?: string;
  sceneIndex?: number;
  path?: string;
  matchText?: string;
  op?: "edit" | "delete";
  value?: string;
  /** Batch shape — the editor's multi-field save: every changed field in ONE request. */
  edits?: TextEditInput[];
}

export const applyElementTextEdit = async (
  body: EditElementBody,
  ownerId: string,
): Promise<HandlerResult> => {
  const { scriptId, sceneIndex, path: fieldPath, matchText, op, value, edits } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return { status: 400, body: { error: "scriptId required" } };
  }
  if (typeof sceneIndex !== "number" || !Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return { status: 400, body: { error: "sceneIndex must be a non-negative integer" } };
  }
  const batch: TextEditInput[] | null = Array.isArray(edits) && edits.length > 0 ? edits : null;
  if (!batch) {
    if (!fieldPath && !matchText) {
      return { status: 400, body: { error: "path or matchText required" } };
    }
    if (op !== "edit" && op !== "delete") {
      return { status: 400, body: { error: 'op must be "edit" or "delete"' } };
    }
  } else {
    for (const e of batch) {
      if ((!e.path && !e.matchText) || (e.op !== "edit" && e.op !== "delete")) {
        return { status: 400, body: { error: "each edit needs path or matchText, and a valid op" } };
      }
    }
  }

  const script = await loadScript(scriptId, ownerId);
  if (!script) return { status: 404, body: { error: "script not found" } };
  if (sceneIndex >= script.scenes.length) {
    return {
      status: 400,
      body: { error: `sceneIndex ${sceneIndex} out of range (script has ${script.scenes.length} scenes)` },
    };
  }

  const scene = script.scenes[sceneIndex] as { content?: unknown };
  const content = (scene.content ?? {}) as SceneContent;

  if (batch) {
    const applied = applyTextEdits(content, batch);
    if (applied.okCount === 0) {
      return {
        status: 400,
        body: {
          error: `no edit applied: ${applied.results.map((r) => r.error).filter(Boolean).join("; ")}`,
        },
      };
    }
    scene.content = applied.content;
    await saveScript(script, ownerId);
    await refreshBuiltScript(scriptId, script);
    // Per-edit outcomes so a partial failure is visible to the editor, never silent.
    return {
      status: 200,
      body: {
        ok: true,
        sceneIndex,
        applied: applied.okCount,
        results: applied.results.map((r) => ({ ok: r.ok, path: r.path, error: r.error })),
        content: applied.content,
      },
    };
  }

  // op was validated above for the single-edit shape (unreached when batch).
  const result = applyTextEdit(content, {
    path: fieldPath,
    matchText,
    op: op as "edit" | "delete",
    value,
  });
  if (!result.ok) return { status: 400, body: { error: result.error } };
  scene.content = result.content;
  await saveScript(script, ownerId);
  await refreshBuiltScript(scriptId, script);

  return { status: 200, body: { ok: true, sceneIndex, path: result.path, content: result.content } };
};
