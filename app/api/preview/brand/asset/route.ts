import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "../../../../../lib/auth";
import { loadScript } from "../../../../../lib/store";
import { persistGenDir, documentDir } from "../../../../../lib/render/gen-store";
import {
  readDocumentBrand,
  writeDocumentBrand,
  type BrandAsset,
} from "../../../../../lib/brand/document-brand";
import { kindForMime, saveBrandAsset } from "../../../../../lib/brand/brand-assets";

/**
 * Upload brand material (logo, wordmark, icon, illustration, JSON, webfont)
 * into a document's brand library.
 *
 * Deterministic — magic-byte typing, SVG sanitisation, document-asset storage.
 * No LLM, no spend, so auth + ownership only (same posture as upload-image).
 *
 * POST multipart/form-data: file, scriptId, kind?, note?, setAsLogo?
 * Returns: { ok, asset, brand }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }

  const scriptId = String(form.get("scriptId") ?? "");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  const genDir = await documentDir(scriptId);

  let saved;
  try {
    saved = await saveBrandAsset(
      genDir,
      Buffer.from(await file.arrayBuffer()),
      file.name,
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not store file" },
      { status: 400 },
    );
  }

  const requestedKind = String(form.get("kind") ?? "");
  const asset: BrandAsset = {
    ref: saved.ref,
    name: saved.name,
    mime: saved.mime,
    kind: (["logo", "logomark", "icon", "image", "illustration", "data", "font", "other"].includes(
      requestedKind,
    )
      ? requestedKind
      : kindForMime(saved.mime)) as BrandAsset["kind"],
    note: String(form.get("note") ?? "").slice(0, 500) || undefined,
  };

  const brand = await readDocumentBrand(genDir);
  brand.assets = [...brand.assets.filter((a) => a.ref !== asset.ref), asset];
  if (form.get("setAsLogo") === "true" || asset.kind === "logo") {
    brand.logo = asset.ref;
    asset.kind = "logo";
  }
  await writeDocumentBrand(genDir, brand);
  // Publish immediately: the bytes live only on this container's disk until
  // the document is republished, and a deploy between upload and the next
  // edit would lose the material the user just added.
  await persistGenDir(scriptId);

  return NextResponse.json({ ok: true, asset, brand });
}

/** Remove a material from the library. The bytes stay on disk (cheap, and a
 *  piece may still reference them); only the library entry goes. */
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  const ref = url.searchParams.get("ref");
  if (!scriptId || !ref) {
    return NextResponse.json({ error: "scriptId and ref required" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  const genDir = await documentDir(scriptId);
  const brand = await readDocumentBrand(genDir);
  brand.assets = brand.assets.filter((a) => a.ref !== ref);
  if (brand.logo === ref) brand.logo = undefined;
  await writeDocumentBrand(genDir, brand);
  await persistGenDir(scriptId);

  return NextResponse.json({ ok: true, brand });
}
