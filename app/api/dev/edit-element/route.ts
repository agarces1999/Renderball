import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { loadScript, saveScript } from "../../../../lib/store";
import { editableFields, type SceneContent } from "../../../../lib/edit/scene-content";
import { applyTextEdit, applyTextEdits, type TextEditInput } from "../../../../lib/edit/apply-text-edit";

/**
 * GET — list the editable copy fields for one scene, so the editor can decide (client-side)
 * whether a clicked text element maps to bound content and resolve its exact path. Dev-only.
 * Query: ?scriptId=..&sceneIndex=..  →  { ok, sceneIndex, fields: [{ path, label, value }] }
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }
  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  const sceneIndexRaw = url.searchParams.get("sceneIndex");
  const sceneIndex = Number(sceneIndexRaw);
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  // Number(null) === 0 — an absent param must be a 400, not silently scene 0.
  if (sceneIndexRaw === null || !Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative integer" }, { status: 400 });
  }
  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json({ error: `sceneIndex ${sceneIndex} out of range` }, { status: 400 });
  }
  const content = ((script.scenes[sceneIndex] as { content?: unknown }).content ?? {}) as SceneContent;
  return NextResponse.json({ ok: true, sceneIndex, fields: editableFields(content) });
}

/**
 * Dev-only inline text edit — headless counterpart to /api/preview/edit-element for
 * the editor harness (no Clerk session). NODE_ENV-gated (404 in prod). No-LLM: updates
 * script.scenes[K].content by path (or by matched text) and re-saves; the preview
 * iframe + MP4 both read the script, so the change shows in both.
 *
 * POST body: { scriptId, sceneIndex, path?, matchText?, op: "edit"|"delete", value? }
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    path?: string;
    matchText?: string;
    op?: "edit" | "delete";
    value?: string;
    /** Batch shape — the editor's multi-field save: every changed field in ONE request. */
    edits?: TextEditInput[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, path: fieldPath, matchText, op, value, edits } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || !Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative integer" }, { status: 400 });
  }
  const batch: TextEditInput[] | null = Array.isArray(edits) && edits.length > 0 ? edits : null;
  if (!batch) {
    if (!fieldPath && !matchText) {
      return NextResponse.json({ error: "path or matchText required" }, { status: 400 });
    }
    if (op !== "edit" && op !== "delete") {
      return NextResponse.json({ error: 'op must be "edit" or "delete"' }, { status: 400 });
    }
  } else {
    for (const e of batch) {
      if ((!e.path && !e.matchText) || (e.op !== "edit" && e.op !== "delete")) {
        return NextResponse.json({ error: "each edit needs path or matchText, and a valid op" }, { status: 400 });
      }
    }
  }

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json({ error: `sceneIndex ${sceneIndex} out of range` }, { status: 400 });
  }

  const scene = script.scenes[sceneIndex] as { content?: unknown };
  const content = (scene.content ?? {}) as SceneContent;

  if (batch) {
    const applied = applyTextEdits(content, batch);
    if (applied.okCount === 0) {
      return NextResponse.json(
        { error: `no edit applied: ${applied.results.map((r) => r.error).filter(Boolean).join("; ")}` },
        { status: 400 },
      );
    }
    scene.content = applied.content;
    await saveScript(script);
    try {
      const genScript = path.join(process.cwd(), "src", "generated", scriptId, "script.json");
      await fs.writeFile(genScript, JSON.stringify(script, null, 2));
    } catch {
      /* genDir not built yet — fine */
    }
    // Per-edit outcomes so a partial failure is visible to the editor, never silent.
    return NextResponse.json({
      ok: true,
      sceneIndex,
      applied: applied.okCount,
      results: applied.results.map((r) => ({ ok: r.ok, path: r.path, error: r.error })),
      content: applied.content,
    });
  }

  // op was validated above for the single-edit shape (unreached when batch).
  const result = applyTextEdit(content, { path: fieldPath, matchText, op: op as "edit" | "delete", value });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  scene.content = result.content;

  await saveScript(script);

  try {
    const genScript = path.join(process.cwd(), "src", "generated", scriptId, "script.json");
    await fs.writeFile(genScript, JSON.stringify(script, null, 2));
  } catch {
    /* genDir not built yet — fine */
  }

  return NextResponse.json({ ok: true, sceneIndex, path: result.path, content: result.content });
}
