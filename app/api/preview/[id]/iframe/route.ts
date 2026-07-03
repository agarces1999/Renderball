import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import { renderSceneDoc } from "../../../../../lib/render/scene-iframe";

/**
 * Self-contained iframe-served preview of one Section{N}. Auth + script load here;
 * the SSR/compile/scale core is shared with the dev editor via renderSceneDoc.
 *
 * GET /api/preview/<scriptId>/iframe?scene=<index>&settle=1
 * settle=1 renders the scene pre-settled (entry animations at end state) — used by the
 * editor on post-edit reloads so results appear instantly.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const scriptId = params.id;
  const url = new URL(request.url);
  const sceneIndex = parseInt(url.searchParams.get("scene") ?? "0", 10);
  const settle = url.searchParams.get("settle") === "1";

  const script = await loadScript(scriptId, user.id);
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
