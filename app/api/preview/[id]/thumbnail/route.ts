import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import { cachedThumbnail, webpVariant } from "../../../../../lib/render/thumbnail";

/**
 * Cached page-1 thumbnail of a built document (the gallery's deck cards).
 *
 * GET /api/preview/<scriptId>/thumbnail → image/png
 *
 * The capture and its disk cache live in lib/render/thumbnail.ts, shared with
 * the public share-link Open Graph image. This route is the private half: auth
 * + ownership, then serve.
 *
 * Deterministic, zero LLM calls.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const scriptId = params.id;
  const script = await loadScript(scriptId, user.id);
  if (!script) return new NextResponse(`script not found: ${scriptId}`, { status: 404 });

  const thumb = await cachedThumbnail(scriptId, script);
  if (!thumb.ok) return new NextResponse(thumb.message, { status: thumb.status });

  // Content negotiation: browsers that accept webp get the smaller variant
  // (derived from the canonical PNG, fail-open). ETag differs per format so
  // 304 revalidation can never hand a webp to a png request or vice versa.
  const wantsWebp = (request.headers.get("accept") ?? "").includes("image/webp");
  const webp = wantsWebp ? await webpVariant(scriptId, thumb) : null;
  const body = webp ?? thumb;
  const contentType = webp ? "image/webp" : "image/png";

  if (request.headers.get("if-none-match") === body.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: body.etag, Vary: "Accept" } });
  }
  // A VERSIONED url (?v=<updatedAt>, stamped by the gallery) is immutable —
  // the browser never re-asks, so repeat gallery visits render from memory
  // with zero requests. An unversioned url keeps the revalidate contract.
  const versioned = new URL(request.url).searchParams.has("v");
  return new NextResponse(new Uint8Array(body.data), {
    headers: {
      "Content-Type": contentType,
      Vary: "Accept",
      "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache",
      ETag: thumb.etag,
    },
  });
}
