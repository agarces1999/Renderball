import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { UploadedFileRef } from "../app/new/schema";
import { isStorageConfigured, putObject } from "./storage/r2";

/**
 * File upload handling for the brief intake wizard.
 *
 * Files land in `public/uploads/<brief_id>/<filename>` so Next.js can
 * serve them at `/uploads/<brief_id>/<filename>`. The agent receives
 * these URLs in the script generator's user message and can reference
 * them in the Script JSON's `assets` manifest.
 *
 * Path traversal defense: we re-slug the filename to a safe form
 * before writing. No `..` segments survive.
 */

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB per brief

const sanitizeName = (name: string): string => {
  // Keep alphanumerics, dots, dashes, underscores. Strip everything else.
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Collapse runs of underscores so "weird   name" -> "weird_name".
  return base.replace(/_{2,}/g, "_").slice(0, 120);
};

/**
 * Server-side content sniffing. `file.type` is client-supplied and trivially
 * spoofed — an attacker can label a `.html`/`.svg`/script payload as
 * `image/png` and, since uploads are served straight out of `public/uploads/`,
 * get the browser to execute it. We inspect the real bytes and only accept a
 * whitelist of brand-asset formats. Returns the canonical mime, or null to
 * reject. SVG and PDF are text/structured formats with no fixed magic number,
 * so they're matched by a leading-content heuristic.
 *
 * Note: SVGs can carry inline script. They're allowed here because brand logos
 * are commonly SVG, but they must be served with `X-Content-Type-Options:
 * nosniff` and ultimately moved off the app origin to object storage with a
 * download disposition (tracked in the storage migration).
 */
export const detectUploadMime = (buf: Buffer): string | null => {
  const startsWith = (...bytes: number[]) =>
    bytes.every((b, i) => buf[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif"; // GIF8
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  )
    return "image/webp";
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return "application/pdf"; // %PDF
  // Webfonts (brand-kit font upload): fixed magic numbers, no script risk.
  if (startsWith(0x77, 0x4f, 0x46, 0x32)) return "font/woff2"; // wOF2
  if (startsWith(0x77, 0x4f, 0x46, 0x46)) return "font/woff"; // wOFF
  if (startsWith(0x00, 0x01, 0x00, 0x00)) return "font/ttf"; // TrueType sfnt
  if (startsWith(0x4f, 0x54, 0x54, 0x4f)) return "font/otf"; // OTTO
  // Text formats: sniff the first non-whitespace characters.
  const head = buf.slice(0, 512).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
};

export const saveBriefFiles = async (
  briefId: string,
  files: File[],
): Promise<UploadedFileRef[]> => {
  if (files.length === 0) return [];

  let totalBytes = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      throw new Error(
        `${f.name} exceeds per-file size limit (10MB).`,
      );
    }
    totalBytes += f.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`Total upload size exceeds 50MB.`);
  }

  // When R2 is configured, uploads go to the private bucket and are served via
  // /api/assets. A per-batch unguessable token makes each URL a capability —
  // the renderer (headless Chromium, no session) and the owner's browser can
  // load it, but it can't be enumerated. Without R2 (quick local runs) we fall
  // back to writing under public/uploads.
  const useR2 = isStorageConfigured();
  const token = randomBytes(9).toString("base64url");
  const dir = path.join(UPLOAD_ROOT, briefId, token);
  if (!useR2) await fs.mkdir(dir, { recursive: true });

  const refs: UploadedFileRef[] = [];
  // Deduplicate slugged filenames so two "logo.png" uploads don't collide.
  const used = new Set<string>();

  for (const file of files) {
    let name = sanitizeName(file.name);
    if (used.has(name)) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let n = 1;
      while (used.has(`${stem}_${n}${ext}`)) n++;
      name = `${stem}_${n}${ext}`;
    }
    used.add(name);

    const buffer = Buffer.from(await file.arrayBuffer());
    const detectedMime = detectUploadMime(buffer);
    if (!detectedMime) {
      throw new Error(
        `${file.name} is not an accepted file type. Upload a PNG, JPEG, GIF, WebP, SVG, or PDF.`,
      );
    }

    if (useR2) {
      await putObject(`uploads/${briefId}/${token}/${name}`, buffer, detectedMime);
    } else {
      await fs.writeFile(path.join(dir, name), buffer);
    }

    refs.push({
      name: file.name, // preserve original for display
      url: useR2
        ? `/api/assets/${briefId}/${token}/${name}`
        : `/uploads/${briefId}/${token}/${name}`,
      mime: detectedMime, // trust sniffed bytes, never the client-supplied type
      size: file.size,
    });
  }

  return refs;
};
