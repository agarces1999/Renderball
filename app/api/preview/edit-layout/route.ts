import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { moveElement, deleteElement } from "../../../../lib/edit/edit-layout";

/**
 * M3 layout-edit endpoint — reposition or delete one element, NO LLM.
 *
 * POST body: { scriptId, sceneIndex, pieceId, op: "move"|"delete", dx?, dy? }
 *   move   → dx/dy pixel delta added to the piece's current offset
 *   delete → removes the piece (siblings never reflow — pieces self-position)
 * Both rewrite Composition.tsx, which the preview iframe + MP4 both consume.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    pieceId?: string;
    op?: "move" | "delete";
    dx?: number;
    dy?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, op, dx, dy } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }
  if (op !== "move" && op !== "delete") {
    return NextResponse.json({ error: 'op must be "move" or "delete"' }, { status: 400 });
  }
  if (op === "move" && (typeof dx !== "number" || typeof dy !== "number")) {
    return NextResponse.json({ error: "move requires numeric dx and dy" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result =
    op === "move"
      ? await moveElement({ genDir, sceneIndex, pieceId, dx: dx as number, dy: dy as number })
      : await deleteElement({ genDir, sceneIndex, pieceId });

  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }
  const payload =
    op === "move"
      ? { ok: true, sceneIndex, pieceId, op, offset: (result as { offset?: unknown }).offset }
      : { ok: true, sceneIndex, pieceId, op, remaining: (result as { remaining?: number }).remaining };
  return NextResponse.json(payload, { status });
}
