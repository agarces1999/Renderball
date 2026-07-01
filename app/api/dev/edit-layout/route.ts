import { NextResponse } from "next/server";
import path from "path";
import { moveElement, deleteElement } from "../../../../lib/edit/edit-layout";

/**
 * Dev-only layout-edit route — headless counterpart to /api/preview/edit-layout for
 * the M3 validation loop (no Clerk session). NODE_ENV-gated (404 in prod).
 *
 * POST body: { scriptId, sceneIndex, pieceId, op: "move"|"delete", dx?, dy? }
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
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

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result =
    op === "move"
      ? await moveElement({ genDir, sceneIndex, pieceId, dx: Number(dx), dy: Number(dy) })
      : await deleteElement({ genDir, sceneIndex, pieceId });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
