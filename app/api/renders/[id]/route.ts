import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript, isValidId } from "../../../../lib/store";
import {
  getSignedDownloadUrl,
  isStorageConfigured,
  objectExists,
  renderKey,
} from "../../../../lib/storage/r2";

/**
 * Owner-gated MP4 delivery.
 *
 * Renders live in `.data/renders/<scriptId>.mp4` — a PRIVATE directory, not
 * `public/` — so the only way to fetch one is through this route, which
 * verifies the signed-in user owns the script first. This closes the IDOR where
 * `/renders/<ulid>.mp4` was served straight off the static handler and could be
 * downloaded by anyone enumerating the (time-sortable, guessable) ULIDs.
 *
 * GET /api/renders/<scriptId>
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const scriptId = params.id;
  if (!isValidId(scriptId)) {
    return new NextResponse("not found", { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  // Ownership: loadScript only resolves a script the user owns (via its
  // linking brief). A non-owner gets null → 404, indistinguishable from
  // "doesn't exist", so we don't leak which ids are real.
  const script = await loadScript(scriptId, user.id);
  if (!script) return new NextResponse("not found", { status: 404 });

  // PREFER R2 when configured (the production path): Cloudflare R2 serves the
  // signed URL with native HTTP Range support, which Safari/iOS REQUIRE for
  // <video> (they probe with `Range: bytes=0-1` and abort on a 200). Redirecting
  // also avoids buffering a tens-of-MB MP4 through this process per viewer.
  if (isStorageConfigured() && (await objectExists(renderKey(scriptId)))) {
    const url = await getSignedDownloadUrl(renderKey(scriptId), 600);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  // Local-disk fallback (storage unconfigured, e.g. local dev). Honor Range
  // here too so Safari can play — a 200-to-a-ranged-request makes WebKit abort.
  const filePath = path.join(process.cwd(), ".data", "renders", `${scriptId}.mp4`);
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return new NextResponse("not found", { status: 404 });
  }

  const common = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${scriptId}.mp4"`,
  };

  const range = request.headers.get("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      return new NextResponse("range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      });
    }
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      return new NextResponse(new Uint8Array(buf), {
        status: 206,
        headers: {
          ...common,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(buf.length),
        },
      });
    } finally {
      await fh.close();
    }
  }

  const file = await fs.readFile(filePath);
  return new NextResponse(new Uint8Array(file), {
    headers: { ...common, "Content-Length": String(size) },
  });
}
