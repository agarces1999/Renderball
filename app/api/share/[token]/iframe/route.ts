import { NextResponse } from "next/server";
import { compositionDocHeaders } from "../../../../../lib/render/iframe-csp";
import { loadSharedDocument } from "../../../../../lib/share";
import { renderSceneDoc } from "../../../../../lib/render/scene-iframe";

/**
 * One page of a SHARED deck, rendered for a visitor with no account.
 *
 * The public twin of /api/preview/[id]/iframe. Deliberately a separate route
 * rather than a "public" flag on that one, for two reasons:
 *
 *   1. /api/preview/* is inside the Clerk middleware matcher. A public path had
 *      to live outside it, and making an exception inside a protected prefix is
 *      exactly the kind of thing that gets accidentally widened later.
 *   2. This route takes a TOKEN, never a scriptId. There is no argument a
 *      visitor can supply that names a document directly, so the id space is
 *      not walkable — the only way in is a link the owner issued.
 *
 * Read-only by construction: it renders and returns HTML. Nothing here writes,
 * and the editor overlay is not part of the composition — the interactive chrome
 * lives in the parent page, which the public viewer simply does not include.
 *
 * GET /api/share/<token>/iframe?scene=<index>
 */
export async function GET(request: Request, { params }: { params: { token: string } }) {
  const shared = await loadSharedDocument(params.token);
  // Unknown, revoked, and not-yet-built all answer the same way, so the response
  // cannot be used to learn which documents exist.
  if (!shared) return new NextResponse("not found", { status: 404 });

  const url = new URL(request.url);
  const requested = parseInt(url.searchParams.get("scene") ?? "0", 10);
  const sceneIndex = Number.isFinite(requested) ? requested : 0;
  if (sceneIndex < 0 || sceneIndex >= shared.script.scenes.length) {
    return new NextResponse("not found", { status: 404 });
  }

  // Always settled: a viewer is reading a document, not watching it assemble.
  const result = await renderSceneDoc(shared.scriptId, sceneIndex, shared.script, { settle: true });
  if (!result.ok) return new NextResponse("not found", { status: 404 });

  return new NextResponse(result.html, { headers: compositionDocHeaders() });
}
