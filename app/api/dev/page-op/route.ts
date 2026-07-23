import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { loadScript, saveScript, DEV_OWNER_ID } from "../../../../lib/store";
import { applyPageOp, normalizePageOp } from "../../../../lib/edit/page-ops";

/**
 * Dev-only page operations — headless counterpart to /api/preview/page-op
 * (no Clerk session). NODE_ENV-gated (404 in prod). Same body contract.
 */
const devOnly = (): NextResponse | null =>
  process.env.NODE_ENV === "production" ? NextResponse.json({ error: "dev-only" }, { status: 404 }) : null;

export async function POST(request: Request) {
  const gate = devOnly();
  if (gate) return gate;

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

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: `script not found: ${scriptId}` }, { status: 404 });
  if (script.config.kind !== "deck") {
    return NextResponse.json({ error: "page operations are deck-only" }, { status: 400 });
  }

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const result = await applyPageOp(genDir, script, op);
  if (!result.ok || !result.script) {
    return NextResponse.json({ error: result.error ?? "page operation failed" }, { status: 400 });
  }

  await saveScript(result.script, DEV_OWNER_ID);
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
