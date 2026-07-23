//
// Editor image assets — generated (image-provider) and uploaded canvas images.
//
// Storage: `<genDir>/assets/<name>` — colocated with the document so the piece
// source, the manifest, and the bytes live and travel together (same lifecycle
// as the lego store; survives undo, which snapshots pieces but never deletes
// assets). Piece bodies reference them as `src="assets/<name>"` — a token, not
// a URL: the browser never resolves it. At SSR time renderSceneDoc inlines the
// bytes as a data URI, which is what makes the ONE composition source work on
// every surface — the editor iframe (app origin), static export + QA capture
// (Playwright `page.setContent`, origin-less, no network), and any future
// deploy — with zero serving routes and zero origin coupling.
//
import { promises as fs } from "fs";
import { randomBytes } from "crypto";
import path from "path";

/** Raster/vector types an editor canvas image may be. Keys are extensions. */
const ASSET_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export const extForMime = (mime: string): string | null => {
  for (const [ext, m] of Object.entries(ASSET_MIME)) {
    if (m === mime && ext !== "jpeg") return ext;
  }
  return null;
};

/**
 * Save image bytes as a document asset. Returns the `assets/<name>` ref the
 * piece body embeds. Names are generated here (never caller-supplied), so the
 * inline pass can trust a tight charset.
 */
export const saveImageAsset = async (
  genDir: string,
  bytes: Buffer,
  ext: string,
): Promise<string> => {
  if (!ASSET_MIME[ext]) throw new Error(`unsupported asset extension "${ext}"`);
  const name = `img-${randomBytes(6).toString("hex")}.${ext}`;
  const dir = path.join(genDir, "assets");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
  return `assets/${name}`;
};

// Matches only names saveImageAsset can produce — nothing user-controlled ever
// reaches the filesystem lookup.
const ASSET_SRC_RE = /src="(assets\/img-[0-9a-f]{12}\.(?:png|jpg|gif|webp|svg))"/g;

/**
 * Inline every `src="assets/…"` ref in rendered scene HTML as a data URI.
 * Missing files degrade to a visibly-broken img (src left as-is) rather than
 * failing the whole scene render.
 */
export const inlineAssetSrcs = async (html: string, genDir: string): Promise<string> => {
  const refs = new Set<string>();
  for (const m of html.matchAll(ASSET_SRC_RE)) refs.add(m[1]);
  if (refs.size === 0) return html;

  const dataUris = new Map<string, string>();
  for (const ref of refs) {
    try {
      const bytes = await fs.readFile(path.join(genDir, ref));
      const ext = ref.slice(ref.lastIndexOf(".") + 1);
      dataUris.set(ref, `data:${ASSET_MIME[ext]};base64,${bytes.toString("base64")}`);
    } catch {
      /* asset missing — leave the token; the img shows broken instead of a 500 */
    }
  }
  if (dataUris.size === 0) return html;
  return html.replace(ASSET_SRC_RE, (full, ref: string) => {
    const uri = dataUris.get(ref);
    return uri ? `src="${uri}"` : full;
  });
};
