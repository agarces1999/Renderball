import { NextResponse } from "next/server";
import path from "path";
import { undoEdit, undoAvailable } from "../../../../lib/edit/undo-edit";
import { saveScript, DEV_OWNER_ID } from "../../../../lib/store";
import type { Script } from "../../../../src/schema";

/**
 * Dev-only undo route — headless counterpart to /api/preview/undo (no Clerk
 * session). NODE_ENV-gated (404 in prod).
 *
 * GET  ?scriptId=…  → { depth }
 * POST { scriptId } → { ok, label, remaining }
 */
const devOnly = (): NextResponse | null =>
  process.env.NODE_ENV === "production" ? NextResponse.json({ error: "dev-only" }, { status: 404 }) : null;

const genDirOf = (scriptId: string): string => path.join(process.cwd(), "src", "generated", scriptId);

export async function GET(request: Request) {
  const gate = devOnly();
  if (gate) return gate;
  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  return NextResponse.json({ depth: await undoAvailable(genDirOf(scriptId)) });
}

export async function POST(request: Request) {
  const gate = devOnly();
  if (gate) return gate;

  let body: { scriptId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { scriptId } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }

  const result = await undoEdit(genDirOf(scriptId));
  if (result.ok && result.script) {
    await saveScript(result.script as Script, DEV_OWNER_ID);
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
