import { NextResponse } from "next/server";
import { DEV_OWNER_ID } from "../../../../../lib/auth";
import { loadScript } from "../../../../../lib/store";
import { renderSceneDoc } from "../../../../../lib/render/scene-iframe";

/**
 * Dev-only counterpart to /api/preview/[id]/iframe — no Clerk session (loads under
 * DEV_OWNER_ID). NODE_ENV-gated (404 in prod); under /api/dev/* which the auth
 * middleware excludes. Lets the dev editor harness (/dev/edit/[id]) render scenes.
 *
 * GET /api/dev/<scriptId>/iframe?scene=<index>&settle=1
 * settle=1 renders the scene pre-settled (entry animations at their end state) — the
 * editor uses it on post-edit reloads so results appear instantly instead of replaying
 * entrance choreography.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (process.env.NODE_ENV === "production") return new NextResponse("dev-only", { status: 404 });

  const scriptId = params.id;
  const url = new URL(request.url);
  const sceneIndex = parseInt(url.searchParams.get("scene") ?? "0", 10);
  const settle = url.searchParams.get("settle") === "1";

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return new NextResponse(`script not found: ${scriptId}`, { status: 404 });

  const result = await renderSceneDoc(scriptId, sceneIndex, script, { settle });
  if (!result.ok) return new NextResponse(result.message, { status: result.status });

  return new NextResponse(result.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
