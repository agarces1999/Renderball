import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import { compileClientBundle, clientPreviewEnabled } from "../../../../../lib/render/client-bundle";

/**
 * Client-preview bundle, production lane (docs/CLIENT_PREVIEW_SPIKE.md
 * Phase 1). Inert until RB_CLIENT_PREVIEW=on — the whole feature is
 * flag-gated behind corpus-wide parity. Auth mirrors the preview iframe
 * route: session owner only.
 *
 * GET /api/preview/<scriptId>/scene-bundle
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!clientPreviewEnabled()) return new NextResponse("disabled", { status: 404 });
  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const scriptId = params.id;
  const script = await loadScript(scriptId, user.id);
  if (!script) return new NextResponse(`script not found: ${scriptId}`, { status: 404 });

  const t0 = Date.now();
  const result = await compileClientBundle(scriptId);
  if (!result.ok) return new NextResponse(result.message, { status: result.status });

  const etag = `"${result.hash}"`;
  const timing = `bundle;dur=${Date.now() - t0};desc=${result.cacheHit ? "hit" : "miss"}`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Server-Timing": timing } });
  }
  return new NextResponse(result.js, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      ETag: etag,
      "Cache-Control": "private, no-cache",
      "Server-Timing": timing,
    },
  });
}
