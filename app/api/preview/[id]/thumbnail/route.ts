import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import { cachedThumbnail } from "../../../../../lib/render/thumbnail";

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

  if (request.headers.get("if-none-match") === thumb.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: thumb.etag } });
  }
  return new NextResponse(new Uint8Array(thumb.data), {
    headers: {
      "Content-Type": "image/png",
      // Revalidate every view (cheap stat + 304); the disk cache does the
      // heavy lifting, the ETag spares the bytes.
      "Cache-Control": "private, no-cache",
      ETag: thumb.etag,
    },
  });
}
