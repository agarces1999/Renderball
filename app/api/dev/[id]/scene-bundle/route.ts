import { NextResponse } from "next/server";
import { DEV_OWNER_ID } from "../../../../../lib/auth";
import { loadScript } from "../../../../../lib/store";
import { compileClientBundle } from "../../../../../lib/render/client-bundle";

/**
 * Dev-only client-preview bundle (docs/CLIENT_PREVIEW_SPIKE.md Phase 1):
 * the deck's Composition.tsx compiled for the BROWSER, served to the
 * sandboxed preview iframe so it can execute the same artifact the server
 * SSRs. Ownership check mirrors the dev iframe route.
 *
 * GET /api/dev/<scriptId>/scene-bundle
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (process.env.NODE_ENV === "production") return new NextResponse("dev-only", { status: 404 });

  const scriptId = params.id;
  const script = await loadScript(scriptId, DEV_OWNER_ID);
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
