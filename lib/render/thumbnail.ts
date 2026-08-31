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
import crypto from "crypto";
import path from "path";
import type { Script } from "../../src/schema";
import { documentDir, genDirOf } from "./gen-store";
import { exportPagePng } from "./export-static";
import { readDecomposed } from "../agents/lego-store";
import { getObjectBytes, isStorageConfigured, putObject } from "../storage/r2";

export type ThumbnailResult =
  | { ok: true; data: Buffer; etag: string }
  | { ok: false; status: number; message: string };

/** Scene 0 keeps the historical un-suffixed name — the gallery card, the OG
 *  image, and every R2 object already in the bucket stay valid. Scenes 1+
 *  (the editor rail, 2026-08-29) get a suffix. */
const sceneSuffix = (scene: number): string => (scene > 0 ? `-s${scene}` : "");

const thumbPath = (scriptId: string, scene = 0): string =>
  path.join(process.cwd(), ".data", "thumbs", `${scriptId}${sceneSuffix(scene)}.png`);

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

/**
 * Cache-version for a gallery URL: the local PNG's mtime, which changes
 * exactly when the picture changes (edits invalidate → recapture → new
 * mtime). Null when this dyno has no copy yet — the caller falls back to a
 * stable key and the immutable cache serves the same bytes either way.
 */
export const thumbnailVersion = async (scriptId: string): Promise<number | null> => {
  const st = await fs.stat(thumbPath(scriptId)).catch(() => null);
  return st ? Math.round(st.mtimeMs) : null;
};

/** The thumbnail's durable home. Local disk dies with every deploy; R2 does not. */
export const thumbKey = (scriptId: string, scene = 0): string =>
  `thumbs/${scriptId}${sceneSuffix(scene)}.png`;

const refreshThumb = (scriptId: string, script: Script, scene = 0): Promise<{ ok: boolean; message?: string }> => {
  const flightKey = `${scriptId}:${scene}`;
  const running = inflight.get(flightKey);
  if (running) return running;
  const job = (async () => {
    const result = await exportPagePng(scriptId, script, scene);
    if (!result.ok) return { ok: false, message: result.message };
    const file = thumbPath(scriptId, scene);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, result.data);
    // WRITE-THROUGH: every fresh capture also lands in R2, fire-and-forget —
    // a failed upload costs nothing now and one extra capture after the next
    // deploy. Without this, deploys wiped the only copy (12 deploys today =
    // 12 stampedes of full re-captures on first gallery view).
    if (isStorageConfigured()) {
      void putObject(thumbKey(scriptId, scene), result.data, "image/png").catch(() => {});
    }
    return { ok: true };
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, job);
  return job;
};

/**
 * The document's page-1 PNG, captured if stale, served from disk if not.
 *
 * A capture failure falls back to a stale cache when one exists: a slightly old
 * thumbnail beats a broken card, and beats a link preview that silently
 * disappears from a chat message someone already sent.
 */
export const cachedThumbnail = async (scriptId: string, script: Script, scene = 0): Promise<ThumbnailResult> => {
  const file = thumbPath(scriptId, scene);

  /**
   * ORDER IS THE FIX (measured 2026-08-18). The old shape called
   * documentDir() FIRST — which HYDRATES the full deck from R2 — before even
   * looking for a cached PNG. On a fresh dyno every gallery card therefore
   * downloaded its whole document and then ran a Playwright capture
   * (minutes, ×N cards, one chromium). New order:
   *   1. local PNG + LOCAL genDir mtime — zero network, the steady state;
   *   2. R2 PNG — one small GET, the post-deploy state; warms the disk;
   *   3. hydrate + capture — only when no picture exists anywhere.
   */
  const localDir = genDirOf(scriptId);
  const localMtime = await newestMtimeMs(localDir);
  const cached = await fs.stat(file).catch(() => null);

  if (cached && (localMtime === null || cached.mtimeMs > localMtime)) {
    // Fresh relative to everything this dyno knows. (localMtime null = the
    // deck isn't hydrated here; the local PNG can only have come from a
    // capture or R2, both authoritative at write time.)
    const data = await fs.readFile(file);
    return { ok: true, data, etag: `"${Math.round(cached.mtimeMs)}-${cached.size}"` };
  }

  if (!cached && isStorageConfigured()) {
    const remote = await getObjectBytes(thumbKey(scriptId, scene)).catch(() => null);
    if (remote && remote.length > 0) {
      await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      await fs.writeFile(file, remote).catch(() => {});
      const st = await fs.stat(file).catch(() => null);
      return { ok: true, data: remote, etag: st ? `"${Math.round(st.mtimeMs)}-${st.size}"` : `"r2-${remote.length}"` };
    }
  }

  // Nothing usable anywhere (or the local deck is NEWER than the PNG — an
  // edit happened here). Hydrate if needed and capture; stale beats broken.
  const sourceMtime = await newestMtimeMs(await documentDir(scriptId));
  if (sourceMtime === null) return { ok: false, status: 404, message: "document not built yet" };
  if (!cached || cached.mtimeMs <= sourceMtime) {
    const refreshed = await refreshThumb(scriptId, script, scene);
    if (!refreshed.ok && !cached) {
      return { ok: false, status: 503, message: `thumbnail capture failed: ${refreshed.message}` };
    }
  }

  const st = await fs.stat(file).catch(() => null);
  if (!st) return { ok: false, status: 503, message: "thumbnail unavailable" };
  const data = await fs.readFile(file);
  return { ok: true, data, etag: `"${Math.round(st.mtimeMs)}-${st.size}"` };
};

/**
 * CONTENT-ADDRESSED per-scene thumbnails (founder, 2026-08-29: reordering
 * pages made every rail mini churn for seconds — index-addressed caches
 * recaptured pages whose CONTENT never changed).
 *
 * The cache key is a hash of what actually renders: the module preamble (so a
 * brand re-skin invalidates every page, correctly) plus the scene's own piece
 * sources. A reorder maps old scene j to new scene i with the SAME signature,
 * so the "new" thumbnail is a cache hit — served in milliseconds, no
 * Playwright. Local + R2, both under the sig key; immutable by construction.
 *
 * Falls back to the legacy mtime path when a document has no lego store
 * (video-era docs, mid-build states) — stale-beats-broken still applies.
 */
const sceneSig = async (genDir: string, scene: number): Promise<string | null> => {
  try {
    const d = await readDecomposed(genDir);
    const s = d.scenes.find((x) => x.sceneIndex === scene);
    if (!s) return null;
    const h = crypto.createHash("sha1");
    h.update(d.preamble);
    h.update(" ");
    for (const p of s.pieces) {
      h.update(p.openTag);
      h.update(p.body);
      h.update(" ");
    }
    h.update(s.template ?? "");
    return h.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
};

const sigPath = (scriptId: string, sig: string): string =>
  path.join(process.cwd(), ".data", "thumbs", `${scriptId}-h${sig}.png`);
const sigKey = (scriptId: string, sig: string): string => `thumbs/${scriptId}-h${sig}.png`;

/** Sig-addressed PNGs accumulate as pages are edited — keep the newest per
 *  document bounded so .data/thumbs and hydrates stay lean. */
const pruneSigThumbs = async (scriptId: string, keep: number): Promise<void> => {
  try {
    const dir = path.join(process.cwd(), ".data", "thumbs");
    const mine = (await fs.readdir(dir)).filter(
      (f) => f.startsWith(`${scriptId}-h`) && (f.endsWith(".png") || f.endsWith(".webp")),
    );
    if (mine.length <= keep) return;
    const stats = await Promise.all(
      mine.map(async (f) => ({ f, m: (await fs.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    stats.sort((a, b) => b.m - a.m);
    for (const { f } of stats.slice(keep)) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
    }
  } catch {
    /* pruning is best-effort */
  }
};

export const cachedSceneThumbnail = async (
  scriptId: string,
  script: Script,
  scene: number,
): Promise<ThumbnailResult> => {
  // documentDir hydrates when this dyno has never seen the doc — the sig
  // needs the piece sources. One download post-deploy, then every reorder
  // is served from the sig cache.
  const dir = await documentDir(scriptId);
  const sig = await sceneSig(dir, scene);
  if (!sig) return cachedThumbnail(scriptId, script, scene);

  const file = sigPath(scriptId, sig);
  const cached = await fs.stat(file).catch(() => null);
  if (cached) {
    const data = await fs.readFile(file);
    return { ok: true, data, etag: `"h${sig}"` };
  }

  if (isStorageConfigured()) {
    const remote = await getObjectBytes(sigKey(scriptId, sig)).catch(() => null);
    if (remote && remote.length > 0) {
      await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      await fs.writeFile(file, remote).catch(() => {});
      return { ok: true, data: remote, etag: `"h${sig}"` };
    }
  }

  const flightKey = `${scriptId}:h${sig}`;
  const running = inflight.get(flightKey);
  const job =
    running ??
    (async () => {
      const result = await exportPagePng(scriptId, script, scene);
      if (!result.ok) return { ok: false, message: result.message };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, result.data);
      if (isStorageConfigured()) {
        void putObject(sigKey(scriptId, sig), result.data, "image/png").catch(() => {});
      }
      const sceneCount = script.scenes?.length ?? 1;
      void pruneSigThumbs(scriptId, Math.max(8, sceneCount * 3));
      return { ok: true };
    })().finally(() => inflight.delete(flightKey));
  if (!running) inflight.set(flightKey, job);
  const done = await job;
  if (!done.ok) return { ok: false, status: 503, message: `thumbnail capture failed: ${done.message}` };

  const data = await fs.readFile(file).catch(() => null);
  if (!data) return { ok: false, status: 503, message: "thumbnail unavailable" };
  return { ok: true, data, etag: `"h${sig}"` };
};

/**
 * Fire-and-forget warm of every scene's content-addressed thumbnail — called
 * when a build lands (founder, 2026-08-29: fresh decks must never show the
 * capture wait; old decks stay lazy). Sequential on purpose: one Playwright
 * page at a time on a container that just finished a build, and the inflight
 * map dedups against any rail request that races it. Errors are swallowed —
 * a failed warm just means that page captures on first view, the old path.
 */
export const warmSceneThumbs = (scriptId: string, script: Script): void => {
  const n = script.scenes?.length ?? 0;
  if (!n) return;
  void (async () => {
    for (let i = 0; i < n; i++) {
      await cachedSceneThumbnail(scriptId, script, i).catch(() => {});
    }
  })();
};

/**
 * WebP variant of the page-1 thumbnail, derived from the canonical PNG and
 * cached beside it. R2 keeps ONLY the PNG (one canonical object); the webp
 * regenerates locally in ~15ms per dyno on first Accept: image/webp request.
 * Fail-open: any sharp/write hiccup serves the PNG unchanged.
 */
export const webpVariant = async (
  scriptId: string,
  png: { data: Buffer; etag: string },
  scene = 0,
): Promise<{ data: Buffer; etag: string } | null> => {
  try {
    const file = path.join(process.cwd(), ".data", "thumbs", `${scriptId}${sceneSuffix(scene)}.webp`);
    const pngFile = thumbPath(scriptId, scene);
    const [wStat, pStat] = await Promise.all([
      fs.stat(file).catch(() => null),
      fs.stat(pngFile).catch(() => null),
    ]);
    if (wStat && pStat && wStat.mtimeMs >= pStat.mtimeMs) {
      return { data: await fs.readFile(file), etag: `${png.etag.slice(0, -1)}-w"` };
    }
    const sharp = (await import("sharp")).default;
    const out = await sharp(png.data).webp({ quality: 82 }).toBuffer();
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await fs.writeFile(file, out).catch(() => {});
    return { data: out, etag: `${png.etag.slice(0, -1)}-w"` };
  } catch {
    return null;
  }
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
