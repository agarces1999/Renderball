//
// Page-1 PNG of a built document, cached on disk.
//
// Extracted from the gallery's thumbnail route because a SECOND caller needed
// it: a shared link's Open Graph image. Both want the same picture and neither
// can afford to take it on every request — the export path screenshots through
// Playwright, which is fine for a user-initiated download and ruinous when a
// link is pasted into a Slack channel and forty clients fetch the preview at
// once.
//
// The cache invalidates on mtime rather than a version column: every visual
// change (piece edits, regens, page ops, a brand re-skin) rewrites a file under
// src/generated/<scriptId>/, so "is anything in there newer than the PNG?" is
// exactly the right question and needs no bookkeeping.
//
import { promises as fs } from "fs";
import path from "path";
import type { Script } from "../../src/schema";
import { documentDir } from "./gen-store";
import { exportPagePng } from "./export-static";

export type ThumbnailResult =
  | { ok: true; data: Buffer; etag: string }
  | { ok: false; status: number; message: string };

const thumbPath = (scriptId: string): string =>
  path.join(process.cwd(), ".data", "thumbs", `${scriptId}.png`);

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

/**
 * One in-flight capture per scriptId.
 *
 * Without this, N gallery cards — or N link-preview crawlers arriving together
 * when a share link is posted — each launch their own Playwright.
 */
const inflight = new Map<string, Promise<{ ok: boolean; message?: string }>>();

const refreshThumb = (scriptId: string, script: Script): Promise<{ ok: boolean; message?: string }> => {
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

/**
 * The document's page-1 PNG, captured if stale, served from disk if not.
 *
 * A capture failure falls back to a stale cache when one exists: a slightly old
 * thumbnail beats a broken card, and beats a link preview that silently
 * disappears from a chat message someone already sent.
 */
export const cachedThumbnail = async (scriptId: string, script: Script): Promise<ThumbnailResult> => {
  const sourceMtime = await newestMtimeMs(await documentDir(scriptId));
  if (sourceMtime === null) return { ok: false, status: 404, message: "document not built yet" };

  const file = thumbPath(scriptId);
  const cached = await fs.stat(file).catch(() => null);
  if (!cached || cached.mtimeMs <= sourceMtime) {
    const refreshed = await refreshThumb(scriptId, script);
    if (!refreshed.ok && !cached) {
      return { ok: false, status: 503, message: `thumbnail capture failed: ${refreshed.message}` };
    }
  }

  const st = await fs.stat(file).catch(() => null);
  if (!st) return { ok: false, status: 503, message: "thumbnail unavailable" };
  const data = await fs.readFile(file);
  return { ok: true, data, etag: `"${Math.round(st.mtimeMs)}-${st.size}"` };
};

/** Where the derived social card lives, beside the PNG it is made from. */
const cardPath = (scriptId: string): string =>
  path.join(process.cwd(), ".data", "thumbs", `${scriptId}.og.jpg`);

/**
 * The same slide, sized and compressed for a link preview.
 *
 * The full-resolution capture is 1920×1080 and about a megabyte, which is fine
 * for a gallery card served to a signed-in browser and wrong for an unfurl:
 * WhatsApp quietly declines previews over a few hundred KB, so the deck would
 * simply not appear in the place people most often paste a link. 1200×675 JPEG
 * lands around a tenth of that, comfortably inside every client's limit while
 * still being the standard 1.91:1 card at full width.
 *
 * Derived from the cached PNG rather than captured separately, so a link
 * preview never costs a second Playwright launch.
 */
export const cachedSocialCard = async (scriptId: string, script: Script): Promise<ThumbnailResult> => {
  const source = await cachedThumbnail(scriptId, script);
  if (!source.ok) return source;

  const png = path.join(process.cwd(), ".data", "thumbs", `${scriptId}.png`);
  const card = cardPath(scriptId);
  const [pngStat, cardStat] = await Promise.all([
    fs.stat(png).catch(() => null),
    fs.stat(card).catch(() => null),
  ]);

  if (!cardStat || !pngStat || cardStat.mtimeMs <= pngStat.mtimeMs) {
    // Imported lazily: sharp is a native module, and the routes that never make
    // a social card should not pay to load it.
    const sharp = (await import("sharp")).default;
    const out = await sharp(source.data)
      .resize(1200, 675, { fit: "contain", background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    await fs.writeFile(card, out);
    return { ok: true, data: out, etag: `"card-${out.length}"` };
  }

  const data = await fs.readFile(card);
  return { ok: true, data, etag: `"${Math.round(cardStat.mtimeMs)}-${cardStat.size}"` };
};
