import { NextResponse } from "next/server";
import path from "path";
import { regenerateElement } from "../../../../lib/edit/regenerate-element";

/**
 * Dev-only element-animate route — the headless counterpart to
 * /api/preview/animate-element (no Clerk session), for probes and the QA
 * journeys. NODE_ENV-gated (404 in prod); under /api/dev/* which the auth
 * middleware excludes.
 *
 * POST body: { scriptId, sceneIndex, pieceId, instruction }
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
  // Same rule as production: motion needs an instruction.
  if (typeof instruction !== "string" || !instruction.trim()) {
    return NextResponse.json(
      { error: "Say how it should move — animating needs an instruction." },
      { status: 400 },
    );
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result = await regenerateElement({ genDir, sceneIndex, pieceId, instruction, mode: "animate" });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
