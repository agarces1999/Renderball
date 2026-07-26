import { promises as fs } from "fs";
import { documentDir } from "../../../../../lib/render/gen-store";
import path from "path";
import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import { exportPagePng } from "../../../../../lib/render/export-static";

/**
 * Cached page-1 thumbnail of a built document (the gallery's deck cards).
 *
 * GET /api/preview/<scriptId>/thumbnail → image/png
 *
 * The export route screenshots via Playwright on EVERY call — fine for a
 * user-initiated download, ruinous for a gallery that renders on each page
 * view. This route wraps the same capture in a disk cache:
 *
 *   .data/thumbs/<scriptId>.png, stale when any file under
 *   src/generated/<scriptId>/ is newer than it. Every visual change lands in
 *   that directory (piece edits, regens, page ops refresh built artifacts),
 *   so mtime comparison self-invalidates without a version column. Concurrent
 *   requests for the same id share one in-flight capture, and a capture
 *   failure falls back to the stale cache when one exists (a slightly old
 *   thumbnail beats a broken card).
 *
 * Deterministic, zero LLM calls; auth + ownership only, same as export.
 */

const thumbPath = (scriptId: string): string =>
  path.join(process.cwd(), ".data", "thumbs", `${scriptId}.png`);

/** The document's directory, restored from durable storage on a cold
 *  container (documentDir hydrates before returning the path). */
const generatedDir = (scriptId: string): Promise<string> => documentDir(scriptId);

/** Newest mtime (ms) of any file under dir, or null if the dir is unreadable. */
const newestMtimeMs = async (dir: string): Promise<number | null> => {
  let newest: number | null = null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await newestMtimeMs(p);
      if (sub !== null && (newest === null || sub > newest)) newest = sub;
    } else {
      try {
        const st = await fs.stat(p);
        if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return newest;
};

/** One in-flight capture per scriptId so N gallery cards can't stampede
 *  N Playwright launches for the same document. */
const inflight = new Map<string, Promise<{ ok: boolean; message?: string }>>();

const refreshThumb = (
  scriptId: string,
  script: Parameters<typeof exportPagePng>[1],
): Promise<{ ok: boolean; message?: string }> => {
  const running = inflight.get(scriptId);
  if (running) return running;
  const job = (async () => {
    const result = await exportPagePng(scriptId, script, 0);
    if (!result.ok) return { ok: false, message: result.message };
    const file = thumbPath(scriptId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, result.data);
    return { ok: true };
  })().finally(() => inflight.delete(scriptId));
  inflight.set(scriptId, job);
  return job;
};

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const scriptId = params.id;
  const script = await loadScript(scriptId, user.id);
  if (!script) return new NextResponse(`script not found: ${scriptId}`, { status: 404 });

  const sourceMtime = await newestMtimeMs(await generatedDir(scriptId));
  if (sourceMtime === null) {
    return new NextResponse("document not built yet", { status: 404 });
  }

  const file = thumbPath(scriptId);
  const cached = await fs.stat(file).catch(() => null);
  if (!cached || cached.mtimeMs <= sourceMtime) {
    const refreshed = await refreshThumb(scriptId, script);
    if (!refreshed.ok && !cached) {
      return new NextResponse(`thumbnail capture failed: ${refreshed.message}`, { status: 503 });
    }
  }

  const st = await fs.stat(file).catch(() => null);
  if (!st) return new NextResponse("thumbnail unavailable", { status: 503 });
  const etag = `"${Math.round(st.mtimeMs)}-${st.size}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }
  const data = await fs.readFile(file);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "image/png",
      // Revalidate every view (cheap stat + 304); the disk cache does the
      // heavy lifting, the ETag spares the bytes.
      "Cache-Control": "private, no-cache",
      ETag: etag,
    },
  });
}
