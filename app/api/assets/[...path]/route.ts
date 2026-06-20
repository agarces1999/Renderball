import { NextResponse } from "next/server";
import { getObjectBytes } from "../../../../lib/storage/r2";

/**
 * Capability-URL asset delivery for user uploads.
 *
 * The path is `<briefId>/<token>/<name>`, where `token` is a 72-bit random
 * value minted at upload time. That token IS the access control: these URLs are
 * only ever shown to the owner, and they're unguessable, so we DON'T gate this
 * route behind a session — which is what lets the renderer's headless Chromium
 * (no cookies) load brand images during a render. Bytes come from the private
 * R2 bucket; nothing is publicly listable.
 *
 * GET /api/assets/<briefId>/<token>/<name>
 */
export async function GET(
  _req: Request,
  { params }: { params: { path?: string[] } },
) {
  const parts = params.path;
  // Require the full <briefId>/<token>/<name> shape and reject any traversal.
  if (
    !Array.isArray(parts) ||
    parts.length < 3 ||
    parts.some((p) => !p || p === "." || p === ".." || p.includes("/") || p.includes("\\"))
  ) {
    return new NextResponse("not found", { status: 404 });
  }

  const bytes = await getObjectBytes(`uploads/${parts.join("/")}`);
  if (!bytes) return new NextResponse("not found", { status: 404 });

  const name = parts[parts.length - 1].toLowerCase();
  const contentType = name.endsWith(".png")
    ? "image/png"
    : name.endsWith(".jpg") || name.endsWith(".jpeg")
      ? "image/jpeg"
      : name.endsWith(".gif")
        ? "image/gif"
        : name.endsWith(".webp")
          ? "image/webp"
          : name.endsWith(".svg")
            ? "image/svg+xml"
            : name.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream";

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
