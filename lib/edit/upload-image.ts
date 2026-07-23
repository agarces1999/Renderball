//
// Upload an image onto the canvas — the insert-image toolbar's real path
// (replaces the placeholder-only flow). Shared core of the preview + dev
// routes: multipart form → magic-byte validation (never the client-supplied
// type) → document asset (lib/edit/image-assets.ts) → primitive-image insert
// at the given bounds. Deterministic, no LLM, no spend.
//
import { detectUploadMime } from "../uploads";
import { extForMime, saveImageAsset } from "./image-assets";
import { insertElement, type Bounds, type InsertElementResult } from "./insert-element";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // match the brief-intake per-file cap

/** Canvas images only — a PDF or webfont upload is valid brand collateral but
 *  not something an <Img> can show. */
const CANVAS_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export type ParsedUploadForm =
  | { ok: true; file: File; scriptId: string; sceneIndex: number; bounds: Bounds }
  | { ok: false; error: string };

/** Validate the multipart fields (file + scriptId + sceneIndex + bounds JSON). */
export const parseUploadForm = (form: FormData): ParsedUploadForm => {
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "file is required" };
  if (file.size === 0) return { ok: false, error: "file is empty" };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "Image exceeds the 10MB limit." };

  const scriptId = form.get("scriptId");
  if (typeof scriptId !== "string" || !scriptId) return { ok: false, error: "scriptId required" };

  const sceneIndex = Number(form.get("sceneIndex"));
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return { ok: false, error: "sceneIndex must be a non-negative integer" };
  }

  let rb: Record<string, unknown>;
  try {
    rb = JSON.parse(String(form.get("bounds") ?? "")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "bounds must be JSON with numeric x, y, w, h" };
  }
  const nums = [rb.x, rb.y, rb.w, rb.h];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { ok: false, error: "bounds must have finite numeric x, y, w, h" };
  }
  const bounds: Bounds = { x: rb.x as number, y: rb.y as number, w: rb.w as number, h: rb.h as number };
  if (bounds.w <= 0 || bounds.h <= 0) return { ok: false, error: "bounds width and height must be positive" };
  if (bounds.w > 20000 || bounds.h > 20000) return { ok: false, error: "bounds are out of range" };

  return { ok: true, file, scriptId, sceneIndex, bounds };
};

/** Store the (validated) bytes as a document asset and insert the <Img> piece. */
export const uploadImageElement = async (
  genDir: string,
  parsed: Extract<ParsedUploadForm, { ok: true }>,
): Promise<InsertElementResult> => {
  const bytes = Buffer.from(await parsed.file.arrayBuffer());
  const mime = detectUploadMime(bytes);
  if (!mime || !CANVAS_IMAGE_MIMES.has(mime)) {
    return { ok: false, error: "That file isn't an image we can place. Upload a PNG, JPEG, GIF, WebP, or SVG." };
  }
  const ext = extForMime(mime);
  if (!ext) return { ok: false, error: `unsupported image type ${mime}` };
  const ref = await saveImageAsset(genDir, bytes, ext);
  return insertElement({
    genDir,
    scriptId: parsed.scriptId,
    sceneIndex: parsed.sceneIndex,
    bounds: parsed.bounds,
    spec: { mode: "primitive", primitive: "image", src: ref },
  });
};
