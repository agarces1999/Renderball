import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
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

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  return NextResponse.json({ depth: await undoAvailable(await documentDir(scriptId)) });
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

  // Anything below can throw — filesystem, storage hydration, persisting the
  // restored script. Uncaught, that reached the user as a bare
  // "request failed (500)" with no server-side trace (the same gap
  // insert-element closed).
  try {
    const result = await undoEdit(await documentDir(scriptId));
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
  } catch (err) {
    console.error(
      `[undo] failed for owner=${user.id} script=${scriptId}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    // A throw after the restore (persisting the script) can leave the page
    // ahead of what this tab shows — say "reload", not "nothing changed".
    return NextResponse.json(
      { ok: false, error: "the undo didn't finish — reload the page to see where things stand, then try again." },
      { status: 500 },
    );
  }
}
