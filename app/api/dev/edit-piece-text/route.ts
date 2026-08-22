import { NextResponse } from "next/server";
import path from "path";
import { editPieceText, freetextSwatches, parseLiteralTarget } from "../../../../lib/edit/edit-piece-text";

/**
 * Dev-only free-text edit route — headless counterpart to
 * /api/preview/edit-piece-text (no Clerk session). NODE_ENV-gated (404 in prod).
 *
 * GET  ?scriptId=…  → { swatches }
 * POST { scriptId, sceneIndex, pieceId, value?, format? }
 */
const devOnly = (): NextResponse | null =>
  process.env.NODE_ENV === "production" ? NextResponse.json({ error: "dev-only" }, { status: 404 }) : null;

const genDirOf = (scriptId: string): string => path.join(process.cwd(), "src", "generated", scriptId);

export async function GET(request: Request) {
  const gate = devOnly();
  if (gate) return gate;

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  try {
    return NextResponse.json({ swatches: await freetextSwatches(genDirOf(scriptId)) });
  } catch {
    return NextResponse.json({ swatches: [] });
  }
}

export async function POST(request: Request) {
  const gate = devOnly();
  if (gate) return gate;

  let body: { scriptId?: string; sceneIndex?: number; pieceId?: string; value?: string; format?: unknown; literal?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, value, format, literal } = body;
  // A hardcoded-literal edit targets a text run in the piece source rather than a
  // free-text span; malformed input falls through as a normal edit and is rejected
  // with the existing message instead of patching anything.
  const literalTarget = parseLiteralTarget(literal);
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }
  if (value !== undefined && typeof value !== "string") {
    return NextResponse.json({ error: "value must be a string" }, { status: 400 });
  }
  if (value === undefined && (!format || typeof format !== "object")) {
    return NextResponse.json({ error: "value or format required" }, { status: 400 });
  }

  const result = await editPieceText({
    genDir: genDirOf(scriptId),
    sceneIndex,
    pieceId,
    ...(value !== undefined ? { value } : {}),
    ...(format && typeof format === "object" ? { format: format as Record<string, never> } : {}),

    ...(literalTarget ? { literal: literalTarget } : {}),
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
