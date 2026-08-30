import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { DEV_OWNER_ID } from "../../../../../lib/auth";
import { cachedThumbnail, webpVariant } from "../../../../../lib/render/thumbnail";

/**
 * Dev-harness mirror of /api/preview/<id>/thumbnail (NODE_ENV-gated, no
 * Clerk) — the /dev/edit rail shows the same per-page previews the production
 * editor does, so the rail can be exercised + verified in a browser.
 *
 * GET /api/dev/<scriptId>/thumbnail?scene=N → image/png|webp
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("not found", { status: 404 });
  }

  const scriptId = params.id;
  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return new NextResponse(`script not found: ${scriptId}`, { status: 404 });

  const rawScene = new URL(request.url).searchParams.get("scene");
  const parsed = rawScene === null ? 0 : Number.parseInt(rawScene, 10);
  const sceneCount = script.scenes?.length ?? 0;
  const scene = Number.isInteger(parsed) && parsed >= 0 && parsed < Math.max(1, sceneCount) ? parsed : 0;

  const thumb = await cachedThumbnail(scriptId, script, scene);
  if (!thumb.ok) return new NextResponse(thumb.message, { status: thumb.status });

  const wantsWebp = (request.headers.get("accept") ?? "").includes("image/webp");
  const webp = wantsWebp ? await webpVariant(scriptId, thumb, scene) : null;
  const body = webp ?? thumb;

  if (request.headers.get("if-none-match") === body.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: body.etag, Vary: "Accept" } });
  }
  const versioned = new URL(request.url).searchParams.has("v");
  return new NextResponse(new Uint8Array(body.data), {
    headers: {
      "Content-Type": webp ? "image/webp" : "image/png",
      Vary: "Accept",
      "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache",
      ETag: body.etag,
    },
  });
}
