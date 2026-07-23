import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript, saveScript } from "../../../../lib/store";
import type { Script } from "../../../../src/schema";
import { undoEdit, undoAvailable } from "../../../../lib/edit/undo-edit";

/**
 * Undo the last editor mutation — deterministic, NO LLM.
 *
 * One store snapshot (manifest + every piece body) is taken before each op, so this
 * reverses insert / move / resize / delete / regenerate / text / format uniformly.
 *
 * GET  ?scriptId=…  → { depth } (how many steps are available)
 * POST { scriptId } → { ok, label, remaining } | { ok:false, error }
 */
const genDirOf = (scriptId: string): string => path.join(process.cwd(), "src", "generated", scriptId);

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  return NextResponse.json({ depth: await undoAvailable(genDirOf(scriptId)) });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  const result = await undoEdit(genDirOf(scriptId));
  // A scene-structure undo (page ops) restores the Script too — persist it so
  // the rail/scenes and the Section components stay in lockstep.
  if (result.ok && result.script) {
    await saveScript(result.script as Script, user.id);
  }
  return NextResponse.json(
    result.ok
      ? { ok: true, label: result.label, remaining: result.remaining, script: result.script }
      : { ok: false, error: result.error },
    { status: result.ok ? 200 : /nothing to undo/.test(result.error ?? "") ? 409 : 400 },
  );
}
