import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript, saveScript } from "../../../../lib/store";
import {
  getField,
  setField,
  deleteField,
  type SceneContent,
} from "../../../../lib/edit/scene-content";

/**
 * M1 element-edit endpoint — apply a click-to-edit text change or a delete to a
 * single scene's content, with NO LLM call.
 *
 * Text in generated compositions is bound to script.scenes[K].content, so an
 * edit = update that content field + re-save the script. The preview iframe and
 * the MP4 render both read the script, so the change shows in both. We also
 * refresh the on-disk genDir/script.json so the MP4 path REUSES the previewed
 * composition (which renders {c.*} from the script) rather than rebuilding.
 *
 * POST body: { scriptId, sceneIndex, path, op: "edit"|"delete", value? }
 *   path is a scene-content path: "headline" | "bullets.0" | "cta.primary" | …
 * Returns: { ok: true, sceneIndex, path, content } — the updated scene content.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    path?: string;
    op?: "edit" | "delete";
    value?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, path: fieldPath, op, value } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!fieldPath || typeof fieldPath !== "string") {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }
  if (op !== "edit" && op !== "delete") {
    return NextResponse.json({ error: 'op must be "edit" or "delete"' }, { status: 400 });
  }
  if (op === "edit" && typeof value !== "string") {
    return NextResponse.json({ error: "value required for edit" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json(
      { error: `sceneIndex ${sceneIndex} out of range (script has ${script.scenes.length} scenes)` },
      { status: 400 },
    );
  }

  const scene = script.scenes[sceneIndex] as { content?: unknown };
  const content = (scene.content ?? {}) as SceneContent;

  // Only allow editing a path that currently holds text — prevents writing
  // arbitrary fields and rejects a stale click on an element that's already gone.
  if (getField(content, fieldPath) === undefined) {
    return NextResponse.json(
      { error: `no editable text at path "${fieldPath}" in scene ${sceneIndex}` },
      { status: 400 },
    );
  }

  const nextContent =
    op === "edit"
      ? setField(content, fieldPath, value as string)
      : deleteField(content, fieldPath);
  scene.content = nextContent;

  await saveScript(script);

  // Best-effort: keep the MP4-reuse contract by refreshing the built script.json.
  // A missing genDir just means the next render rebuilds with the new content
  // (still correct, just not reusing the cached composition).
  try {
    const genScript = path.join(process.cwd(), "src", "generated", scriptId, "script.json");
    await fs.writeFile(genScript, JSON.stringify(script, null, 2));
  } catch {
    /* genDir not built yet — fine */
  }

  return NextResponse.json({ ok: true, sceneIndex, path: fieldPath, content: nextContent });
}
