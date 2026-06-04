/**
 * Download a chosen asset to a local file (sha-named, deduped) and return a
 * manifest entry. Baking a LOCAL path into the composition is what keeps
 * "preview IS the MP4" true even though the agent chose the asset via a live
 * tool-call: the choice happens at build time, the bytes are frozen on disk.
 *
 * Dead-URL safe: any fetch/IO failure returns null so the caller falls back
 * to the CSS/illustration path instead of baking a broken <img>.
 *
 * `destDir` is caller-chosen (the integration step decides whether that's the
 * genDir or a browser-served public dir + the URL mapping); `fetchImpl` is
 * injectable for unit tests.
 */

import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { AssetCandidate, CachedAssetEntry } from "./types";

const EXT_BY_TYPE: Record<AssetCandidate["type"], string> = {
  photo: ".jpg",
  video: ".mp4",
  lottie: ".json",
};

/** Prefer a real file extension from the URL; fall back to the type default. */
const extFor = (url: string, type: AssetCandidate["type"]): string => {
  const m = url.split(/[?#]/)[0].match(/\.(jpe?g|png|webp|gif|avif|mp4|webm|json)$/i);
  return m ? `.${m[1].toLowerCase()}` : EXT_BY_TYPE[type];
};

export const cacheAsset = async (
  destDir: string,
  candidate: AssetCandidate,
  query: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CachedAssetEntry | null> => {
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(candidate.fullUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;

    const sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const ext = extFor(candidate.fullUrl, candidate.type);
    const fileName = `${sha}${ext}`;
    const abs = path.join(destDir, fileName);
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(abs, buf); // sha-named → re-writing the same asset is idempotent

    return {
      query,
      type: candidate.type,
      source: candidate.source,
      srcUrl: candidate.fullUrl,
      localPath: fileName,
      sha,
      width: candidate.width,
      height: candidate.height,
      durationS: candidate.durationS,
      license: candidate.license,
      attribution: candidate.attribution,
    };
  } catch {
    return null; // dead URL / network / IO → caller falls back, never a broken img
  }
};
