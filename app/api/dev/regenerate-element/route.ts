import { NextResponse } from "next/server";
import path from "path";
import { regenerateElement } from "../../../../lib/edit/regenerate-element";

/**
 * Dev-only element-regenerate route — the headless counterpart to
 * /api/preview/regenerate-element, for the M2 validation loop (no Clerk session).
 * NODE_ENV-gated (404 in prod); under /api/dev/* which the auth middleware excludes.
 *
 * POST body: { scriptId, sceneIndex, pieceId, instruction? }
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    pieceId?: string;
    instruction?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, instruction } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result = await regenerateElement({ genDir, sceneIndex, pieceId, instruction });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
