import { NextResponse } from "next/server";
import { DEV_OWNER_ID } from "../../../../../lib/auth";
import { loadScript } from "../../../../../lib/store";
import path from "path";
import {
  readDocumentBrand,
  writeDocumentBrand,
  type BrandAsset,
} from "../../../../../lib/brand/document-brand";
import { kindForMime, saveBrandAsset } from "../../../../../lib/brand/brand-assets";

/**
 * Dev-harness mirror of /api/preview/brand/asset (NODE_ENV-gated, no Clerk).
 *
 * This route did not exist, which made the dev editor's brand-materials
 * section a silent 404 — the panel offered uploads the harness could not
 * accept, so neither /dev/edit nor the QA suite could ever exercise them.
 * Same behaviour as the production route minus persistGenDir: dev documents
 * are local working copies, not published artifacts.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

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

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  // Local documents only — the dev harness must never pull from durable
  // storage (same posture as the sibling /api/dev/brand route).
  const genDir = path.join(process.cwd(), "src", "generated", scriptId);

  let saved;
  try {
    saved = await saveBrandAsset(genDir, Buffer.from(await file.arrayBuffer()), file.name);
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

  return NextResponse.json({ ok: true, asset, brand });
}

/** Remove a material from the library — dev mirror of the production DELETE. */
export async function DELETE(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  const ref = url.searchParams.get("ref");
  if (!scriptId || !ref) {
    return NextResponse.json({ error: "scriptId and ref required" }, { status: 400 });
  }

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  const brand = await readDocumentBrand(genDir);
  brand.assets = brand.assets.filter((a) => a.ref !== ref);
  if (brand.logo === ref) brand.logo = undefined;
  await writeDocumentBrand(genDir, brand);

  return NextResponse.json({ ok: true, brand });
}
