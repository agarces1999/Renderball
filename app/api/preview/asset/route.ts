import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { hydrateGenDir } from "../../../../lib/render/gen-store";

/**
 * Serve one of a document's own assets, owner-scoped.
 *
 * The brand panel needs to show what the user uploaded. Assets live inside the
 * document directory rather than a public folder, so they need a gated reader.
 *
 * `ref` is matched against the exact names our writers generate
 * (`assets/img-…` from the editor, `assets/brand-…` from the brand library) —
 * a strict charset, not a sanitised user string, so nothing user-controlled
 * ever reaches the filesystem lookup.
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
  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  const ref = url.searchParams.get("ref");
  if (!scriptId || !ref) return new NextResponse("scriptId and ref required", { status: 400 });
  if (!REF_RE.test(ref)) return new NextResponse("bad ref", { status: 400 });

  const script = await loadScript(scriptId, user.id);
  if (!script) return new NextResponse("not found", { status: 404 });

  await hydrateGenDir(scriptId);
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
      // SVG is XML and can carry script. It is sanitised on upload, but serve
      // it defensively too: no sniffing, a policy that permits nothing, and
      // never as an inline document on our origin.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      ...(ext === "svg" ? { "Content-Disposition": "inline; filename=asset.svg" } : {}),
      "Cache-Control": "private, max-age=300",
    },
  });
}
