import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript, isValidId } from "../../../../lib/store";
import { getObjectBytes, renderKey } from "../../../../lib/storage/r2";

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
  _request: Request,
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

  // Local disk first (warm cache on the instance that rendered it), then R2
  // (the durable source of truth, e.g. on a fresh container).
  const filePath = path.join(
    process.cwd(),
    ".data",
    "renders",
    `${scriptId}.mp4`,
  );
  let file: Buffer | null = null;
  try {
    file = await fs.readFile(filePath);
  } catch {
    file = await getObjectBytes(renderKey(scriptId));
  }
  if (!file) {
    return new NextResponse("not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(file.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${scriptId}.mp4"`,
    },
  });
}
