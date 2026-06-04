import { promises as fs } from "fs";
import path from "path";
import type { UploadedFileRef } from "../app/new/schema";

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

  const dir = path.join(UPLOAD_ROOT, briefId);
  await fs.mkdir(dir, { recursive: true });

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
    await fs.writeFile(path.join(dir, name), buffer);

    refs.push({
      name: file.name, // preserve original for display
      url: `/uploads/${briefId}/${name}`,
      mime: file.type || "application/octet-stream",
      size: file.size,
    });
  }

  return refs;
};
