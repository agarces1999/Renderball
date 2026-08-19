import { NextResponse } from "next/server";
import { compositionDocHeaders } from "../../../../../lib/render/iframe-csp";
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

  const t0 = Date.now();
  const result = await renderSceneDoc(scriptId, sceneIndex, script, { settle });
  if (!result.ok) return new NextResponse(result.message, { status: result.status });

  // ETag from the content hash: a reload of an UNCHANGED scene revalidates to
  // 304 and the browser keeps its parsed document. Server-Timing decomposes
  // the server half of the edit re-render (the playbook's span request —
  // measured compile+SSR is ~7ms, so this header is how we catch anything
  // else creeping in) and reports cache hit/miss per response.
  const etag = result.cacheKey ? `"${result.cacheKey}"` : undefined;
  const timing = `render;dur=${Date.now() - t0};desc=${result.cacheHit ? "hit" : "miss"}`;
  if (etag && request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Server-Timing": timing } });
  }
  return new NextResponse(result.html, {
    headers: {
      ...compositionDocHeaders(),
      ...(etag ? { ETag: etag, "Cache-Control": "private, no-cache" } : {}),
      "Server-Timing": timing,
    },
  });
}
