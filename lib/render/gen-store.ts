/**
 * Durability for built documents.
 *
 * A built deck lived ONLY in `src/generated/<scriptId>/` on the container
 * filesystem. Railway's filesystem is ephemeral and `.dockerignore` excludes
 * that directory from the image, so every deploy destroyed every user's work:
 * the Project/ScriptDoc rows survive in Neon, so `/documents` still lists the
 * document, but the card stops linking to an editor, thumbnails 500, export
 * returns "Composition.tsx not found", and opening /preview/<id> silently
 * fires a brand-new full-price build that produces a DIFFERENT design.
 *
 * The video path already solved this — MP4s go to R2 with a durable Render
 * row — and r2.ts even describes itself as being for "artifacts that can't
 * live on an ephemeral container disk". The deck path, i.e. the entire
 * post-pivot product, never got it. This module is that missing half.
 *
 * Shape: one gzipped JSON bundle per document rather than per-file objects.
 * A document is ~30 small text files that must be consistent with each other
 * (Composition.tsx must match lego/manifest.json and the piece bodies), so a
 * single object makes publish atomic — a half-uploaded document can never be
 * hydrated. Contents are base64 so an uploaded image in the directory
 * round-trips as faithfully as the source files.
 */
import { promises as fs } from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { getObjectBytes, isStorageConfigured, putObject } from "../storage/r2";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const genDirOf = (scriptId: string): string =>
  path.join(process.cwd(), "src", "generated", scriptId);

/**
 * The document's directory, restored from durable storage first if this
 * container has never seen it.
 *
 * Prefer this over `genDirOf` in any route that READS or MUTATES a document.
 * The path construction was duplicated across 26 files, and most editor
 * mutation routes built it without hydrating — so an editor tab left open
 * across a deploy would fail every subsequent edit until the user happened to
 * reload. One helper removes both the duplication and that whole bug class.
 *
 * Ownership is still the caller's job: hydration is not authorisation, and
 * every caller resolves the script through an owner-scoped load first.
 */
export const documentDir = async (scriptId: string): Promise<string> => {
  await hydrateGenDir(scriptId);
  return genDirOf(scriptId);
};

export const docKey = (scriptId: string): string => `docs/${scriptId}.json.gz`;

/**
 * Diagnostic output, deliberately not persisted: `.render-truth/` alone is
 * ~4MB of measurement PNGs per document and is never read to render or edit.
 * Excluding it keeps a bundle in the low hundreds of KB.
 */
const SKIP_DIRS = new Set([".render-truth"]);
const SKIP_FILES = new Set(["build-timeline.json"]);

/** The S3 client is constructed without a request timeout, so every call here
 *  carries its own deadline — these run on the build and render paths. */
const PERSIST_TIMEOUT_MS = 30_000;
const HYDRATE_TIMEOUT_MS = 20_000;

const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Every file that must survive, relative to genDir. */
const collect = async (dir: string, base = ""): Promise<string[]> => {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await collect(path.join(dir, e.name), rel)));
    } else if (!SKIP_FILES.has(e.name)) {
      out.push(rel);
    }
  }
  return out;
};

/**
 * Publish the built document to durable storage. Best-effort by design: a
 * storage outage must not fail a build the user already paid for — they keep
 * the working local copy, and the next edit republishes. Returns false when
 * nothing was stored so callers can log honestly.
 */
export const persistGenDir = async (scriptId: string): Promise<boolean> => {
  if (!isStorageConfigured()) return false;
  const dir = genDirOf(scriptId);
  try {
    const files = await collect(dir);
    if (files.length === 0) return false;
    const bundle: Record<string, string> = {};
    for (const rel of files) {
      bundle[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
    }
    const gz = await gzip(Buffer.from(JSON.stringify({ v: 1, files: bundle }), "utf8"));
    // Bounded: this runs inside writeGeneratedFiles, so an unresponsive
    // storage endpoint would otherwise hang a finished build indefinitely.
    // Losing durability is bad; losing the build the user just paid for is
    // worse, so the upload gets a deadline and the build proceeds either way.
    await withTimeout(
      putObject(docKey(scriptId), gz, "application/gzip"),
      PERSIST_TIMEOUT_MS,
      "persist",
    );
    return true;
  } catch (err) {
    console.error(
      `[gen-store] persist failed for ${scriptId} — document is live but NOT redeploy-safe:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
};

/**
 * Restore a document to local disk if it is not already there. Called on the
 * read paths so a container that has never seen this document (i.e. any
 * container after a deploy) can still render, edit and export it.
 *
 * Returns true when the directory is usable afterwards. The local copy always
 * wins: an in-flight edit on this container must never be clobbered by an
 * older bundle.
 */
export const hydrateGenDir = async (scriptId: string): Promise<boolean> => {
  const dir = genDirOf(scriptId);
  try {
    await fs.access(path.join(dir, "Composition.tsx"));
    return true; // already local — nothing to do
  } catch {
    /* fall through to restore */
  }
  if (!isStorageConfigured()) return false;
  try {
    const gz = await withTimeout(
      getObjectBytes(docKey(scriptId)),
      HYDRATE_TIMEOUT_MS,
      "hydrate",
    );
    if (!gz) return false;
    const parsed = JSON.parse((await gunzip(gz)).toString("utf8")) as {
      v: number;
      files: Record<string, string>;
    };
    if (!parsed?.files) return false;
    for (const [rel, b64] of Object.entries(parsed.files)) {
      // Defensive: a bundle is ours, but never let a crafted key escape genDir.
      const dest = path.join(dir, rel);
      if (!dest.startsWith(dir + path.sep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from(b64, "base64"));
    }
    console.log(`[gen-store] hydrated ${scriptId} from durable storage`);
    return true;
  } catch (err) {
    console.error(
      `[gen-store] hydrate failed for ${scriptId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
};
