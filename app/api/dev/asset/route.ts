import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";

/**
 * Dev-harness mirror of GET /api/preview/asset (NODE_ENV-gated, no Clerk,
 * local documents only).
 *
 * Without this, the dev brand-asset routes let uploads SUCCEED and then every
 * thumbnail 404'd — the panel renders assets as `<img src="${apiBase}/asset…">`
 * and only the Clerk-gated preview route had a GET. Same strict ref charset
 * and the same defensive headers as production, so the two surfaces cannot
 * behave differently around the one asset type (SVG) that can carry script.
 */
const REF_RE = /^assets\/(?:img|brand)-[0-9a-f]{12}\.(?:png|jpg|jpeg|gif|webp|svg|json|woff2|woff|ttf|otf)$/;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("dev-only", { status: 404 });
  }

  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  const ref = url.searchParams.get("ref");
  if (!scriptId || !ref) return new NextResponse("scriptId and ref required", { status: 400 });
  if (!REF_RE.test(ref)) return new NextResponse("bad ref", { status: 400 });

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return new NextResponse("not found", { status: 404 });

  const file = path.join(process.cwd(), "src", "generated", scriptId, ref);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }

  const ext = ref.split(".").pop() ?? "";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      ...(ext === "svg" ? { "Content-Disposition": "inline; filename=asset.svg" } : {}),
      "Cache-Control": "private, max-age=300",
    },
  });
}
