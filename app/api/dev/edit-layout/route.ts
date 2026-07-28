import { NextResponse } from "next/server";
import path from "path";
import {
  moveElement,
  deleteElement,
  resizeElement,
  reorderElement,
} from "../../../../lib/edit/edit-layout";

/**
 * Dev-only layout-edit route — headless counterpart to /api/preview/edit-layout for
 * the M3 validation loop (no Clerk session). NODE_ENV-gated (404 in prod).
 *
 * POST body: { scriptId, sceneIndex, pieceId, op: "move"|"resize"|"delete", … }
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    pieceId?: string;
    op?: "move" | "resize" | "delete";
    dx?: number;
    dy?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, op, dx, dy, x, y, w, h } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }
  if (op !== "move" && op !== "resize" && op !== "delete" && op !== "front" && op !== "back") {
    return NextResponse.json(
      { error: 'op must be "move", "resize", "delete", "front" or "back"' },
      { status: 400 },
    );
  }
  if (op === "resize" && ![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return NextResponse.json({ error: "resize requires numeric x, y, w and h" }, { status: 400 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result =
    op === "move"
      ? await moveElement({ genDir, sceneIndex, pieceId, dx: Number(dx), dy: Number(dy) })
      : op === "resize"
        ? await resizeElement({ genDir, sceneIndex, pieceId, x: Number(x), y: Number(y), w: Number(w), h: Number(h) })
        : await deleteElement({ genDir, sceneIndex, pieceId });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
