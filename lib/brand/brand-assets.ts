/**
 * Brand material storage — the logo, wordmarks, icons, illustrations, and the
 * JSON the user wants their deck to be able to draw on.
 *
 * Stored beside the document in `<genDir>/assets/` exactly like editor-inserted
 * images (lib/edit/image-assets.ts), so they travel in gen-store's R2 bundle,
 * survive a redeploy, and are covered by the same owner-scoped path.
 *
 * Separate from image-assets.ts because a brand library accepts more than a
 * canvas image does — webfonts and JSON (Lottie, chart data) — and because the
 * naming prefix distinguishes brand material from a one-off inserted picture.
 *
 * SECURITY: the type is decided by MAGIC BYTES, never by the client's
 * Content-Type. That matters most for SVG, which is XML and can carry inline
 * script: an uploaded SVG served from our origin would be stored XSS. Uploaded
 * SVG is sanitised here rather than trusted, and /uploads and /api/assets are
 * already served with a locked-down CSP and nosniff.
 */
import { promises as fs } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import type { BrandAsset } from "./document-brand";

/** ext → mime, for everything a brand library may hold. */
const BRAND_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

export const MAX_BRAND_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Identify a file by its first bytes. The client's declared mime is advisory
 * only — a .png that is really an HTML document must not be stored as one.
 */
export const sniffBrandAsset = (bytes: Buffer): { ext: string; mime: string } | null => {
  const b = bytes;
  const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

  if (starts([0x89, 0x50, 0x4e, 0x47])) return { ext: "png", mime: BRAND_MIME.png };
  if (starts([0xff, 0xd8, 0xff])) return { ext: "jpg", mime: BRAND_MIME.jpg };
  if (starts([0x47, 0x49, 0x46, 0x38])) return { ext: "gif", mime: BRAND_MIME.gif };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return { ext: "webp", mime: BRAND_MIME.webp };
  }
  if (starts([0x77, 0x4f, 0x46, 0x32])) return { ext: "woff2", mime: BRAND_MIME.woff2 };
  if (starts([0x77, 0x4f, 0x46, 0x46])) return { ext: "woff", mime: BRAND_MIME.woff };
  if (starts([0x00, 0x01, 0x00, 0x00])) return { ext: "ttf", mime: BRAND_MIME.ttf };
  if (starts([0x4f, 0x54, 0x54, 0x4f])) return { ext: "otf", mime: BRAND_MIME.otf };

  // Text formats: sniff the leading non-whitespace content.
  const head = b.subarray(0, 512).toString("utf8").trimStart();
  if (/^<(\?xml|svg)\b/i.test(head)) return { ext: "svg", mime: BRAND_MIME.svg };
  if (/^[[{]/.test(head)) {
    try {
      JSON.parse(b.toString("utf8"));
      return { ext: "json", mime: BRAND_MIME.json };
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Strip script from an uploaded SVG.
 *
 * SVG is the format brands most want to upload (crisp logos) and the only
 * image format that executes. Removing <script>, event handlers and
 * javascript:/data: URLs keeps the vector without the payload. Conservative by
 * construction: anything it cannot make safe it removes.
 */
export const sanitizeSvg = (svg: string): string =>
  svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("|')\s*(javascript:|data:text\/html)[^"']*\2/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "");

export interface SavedBrandAsset {
  ref: string;
  name: string;
  mime: string;
  bytes: number;
}

/**
 * Persist brand material. Filenames are generated here (never client-supplied)
 * so nothing user-controlled reaches the filesystem.
 */
export const saveBrandAsset = async (
  genDir: string,
  bytes: Buffer,
  originalName: string,
): Promise<SavedBrandAsset> => {
  if (bytes.length === 0) throw new Error("empty file");
  if (bytes.length > MAX_BRAND_ASSET_BYTES) {
    throw new Error(`file is larger than ${MAX_BRAND_ASSET_BYTES / 1024 / 1024}MB`);
  }
  const sniffed = sniffBrandAsset(bytes);
  if (!sniffed) {
    throw new Error("unsupported file type — use PNG, JPG, SVG, WEBP, GIF, JSON or a webfont");
  }

  let out = bytes;
  if (sniffed.ext === "svg") {
    out = Buffer.from(sanitizeSvg(bytes.toString("utf8")), "utf8");
  }

  const name = `brand-${randomBytes(6).toString("hex")}.${sniffed.ext}`;
  const dir = path.join(genDir, "assets");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), out);

  return {
    ref: `assets/${name}`,
    name: originalName.slice(0, 120) || name,
    mime: sniffed.mime,
    bytes: out.length,
  };
};

/** Sensible default classification, so the UI can preselect. */
export const kindForMime = (mime: string): BrandAsset["kind"] => {
  if (mime.startsWith("font/")) return "font";
  if (mime === "application/json") return "data";
  if (mime === "image/svg+xml") return "logomark";
  return "image";
};
