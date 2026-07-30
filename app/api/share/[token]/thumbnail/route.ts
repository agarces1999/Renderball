import { NextResponse } from "next/server";
import { loadSharedDocument } from "../../../../../lib/share";
import { cachedSocialCard } from "../../../../../lib/render/thumbnail";

/**
 * The picture a shared link shows when it is pasted somewhere.
 *
 * GET /api/share/<token>/thumbnail → image/png
 *
 * Slack, WhatsApp, iMessage, X and every other client that unfurls a link
 * fetches this with no cookies and no account — which is the whole reason it
 * exists as a public route rather than reusing /api/preview/<id>/thumbnail. A
 * link that shows a blank card is a link people stop forwarding, and forwarding
 * is the entire point of the feature.
 *
 * Token-only, like the rest of the share surface: unknown, revoked and
 * not-yet-built all answer 404, so the response cannot be used to learn which
 * documents exist. Revoking a link therefore also takes down its preview.
 */
export async function GET(request: Request, { params }: { params: { token: string } }) {
  const shared = await loadSharedDocument(params.token);
  if (!shared) return new NextResponse("not found", { status: 404 });

  const thumb = await cachedSocialCard(shared.scriptId, shared.script);
  if (!thumb.ok) return new NextResponse(thumb.message, { status: thumb.status });

  if (request.headers.get("if-none-match") === thumb.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: thumb.etag } });
  }
  return new NextResponse(new Uint8Array(thumb.data), {
    headers: {
      "Content-Type": "image/jpeg",
      // Public, but short: the deck behind a live link can change, and an
      // unfurl cache that outlives the edit shows a stale slide. The ETag makes
      // the revalidation cheap.
      "Cache-Control": "public, max-age=300, must-revalidate",
      ETag: thumb.etag,
    },
  });
}
