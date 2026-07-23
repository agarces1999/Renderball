import { NextResponse } from "next/server";
import path from "path";
import { insertElement, parseInsertBody, type InsertMode } from "../../../../lib/edit/insert-element";

/**
 * Dev-only insert-element route — headless counterpart to /api/preview/insert-element
 * (no Clerk session, no z.ai breaker / per-owner cap). NODE_ENV-gated (404 in prod).
 *
 * POST body: see parseInsertBody in lib/edit/insert-element.ts.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = parseInsertBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { scriptId, sceneIndex, bounds, spec } = parsed;

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result = await insertElement({ genDir, scriptId, sceneIndex, bounds, spec: spec as InsertMode });
  const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
  return NextResponse.json(
    result.ok
      ? { ok: true, sceneIndex, pieceId: result.pieceId, usage: result.usage }
      : { ok: false, error: result.error },
    { status },
  );
}
