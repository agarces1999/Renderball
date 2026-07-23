import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript, saveScript } from "../../../../lib/store";
import { applyPageOp, normalizePageOp } from "../../../../lib/edit/page-ops";

/**
 * Page operations on a deck document (canvas pivot P1) — duplicate / remove /
 * move / add-blank. Deterministic, 0 LLM, no spend, so no entitlement gate;
 * auth + ownership only.
 *
 * POST { scriptId, op: "duplicate"|"remove", page }
 *      { scriptId, op: "move", page, to }
 *      { scriptId, op: "add", after }
 * → { ok, pages, focus, script }
 *
 * Deck-only: structural page edits retile the inert 5s/slide timings; video
 * timelines are not supported (400).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const scriptId = typeof body.scriptId === "string" ? body.scriptId : null;
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const op = normalizePageOp(body);
  if (!op) return NextResponse.json({ error: "invalid page op" }, { status: 400 });

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: `script not found: ${scriptId}` }, { status: 404 });
  if (script.config.kind !== "deck") {
    return NextResponse.json({ error: "page operations are deck-only" }, { status: 400 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result = await applyPageOp(genDir, script, op);
  if (!result.ok || !result.script) {
    return NextResponse.json({ error: result.error ?? "page operation failed" }, { status: 400 });
  }

  await saveScript(result.script, user.id);
  // Best-effort: keep the render-reuse contract by refreshing the built
  // script.json mirror (same convention as edit-element).
  try {
    await fs.writeFile(
      path.join(genDir, "script.json"),
      JSON.stringify(result.script, null, 2),
      "utf8",
    );
  } catch {
    /* mirror is best-effort */
  }
  return NextResponse.json({
    ok: true,
    pages: result.pages,
    focus: result.focus,
    script: result.script,
  });
}
