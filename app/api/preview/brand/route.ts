import { NextResponse } from "next/server";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import { documentDir } from "../../../../lib/render/gen-store";
import {
  readDocumentBrand,
  validateBrandInput,
  writeDocumentBrand,
} from "../../../../lib/brand/document-brand";
import { applyBrandToDocument } from "../../../../lib/brand/apply-brand";
import { colorsInUse, parseFontConsts, resolveRoleColors } from "../../../../lib/brand/reskin";
import { promises as fs } from "fs";

/**
 * Document-level brand context — read and update the brand a PRESENTATION
 * wears, then apply it without regenerating.
 *
 * Brand was previously fixed at /new and frozen into the build, so a deck's
 * colours, fonts, logo and brand materials could never change afterwards.
 * This is the surface that unfreezes it.
 *
 * Deterministic and therefore FREE: applying a brand rewrites literal values
 * in the document's own sources (lib/brand/reskin.ts). No LLM call, no spend,
 * so no breaker/entitlement gate — auth + ownership only, matching
 * edit-layout and upload-image.
 *
 * GET  ?scriptId=…  → { brand, inUse }   inUse = what the document currently
 *                                        renders with, so the UI can show real
 *                                        swatches instead of empty fields.
 * PUT  { scriptId, brand, apply? }       → { ok, brand, changes }
 */

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  // documentDir restores the document first, so a container that has never
  // seen it (i.e. any container after a deploy) can still read what it
  // currently renders with.
  const genDir = await documentDir(scriptId);

  const brand = await readDocumentBrand(genDir);
  const source = await fs
    .readFile(path.join(genDir, "Composition.tsx"), "utf8")
    .catch(() => "");

  const roles = resolveRoleColors(source);
  const inUse = {
    palette: Object.fromEntries(
      Object.entries(roles).map(([role, hexes]) => [role, hexes?.[0]]),
    ),
    fonts: parseFontConsts(source),
    // Top colours regardless of role, so the picker can offer the document's
    // own palette rather than making the user invent hexes.
    colors: colorsInUse(source).slice(0, 12),
  };

  return NextResponse.json({ ok: true, brand, inUse });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { scriptId?: string; brand?: unknown; apply?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const scriptId = body.scriptId;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  // Values here are substituted into source this process later executes, so
  // they are validated to strict shapes (hex / font stack / asset ref) before
  // anything is written.
  const v = validateBrandInput(body.brand);
  if (!v.ok) {
    return NextResponse.json({ error: v.errors.join("; ") }, { status: 400 });
  }

  const genDir = await documentDir(scriptId);
  await writeDocumentBrand(genDir, v.brand);

  if (body.apply === false) {
    return NextResponse.json({ ok: true, brand: v.brand, changes: [] });
  }

  const applied = await applyBrandToDocument(genDir, v.brand);
  if (!applied.ok) {
    // The brand is saved either way; only the rewrite failed, and
    // applyBrandToDocument has already rolled the document back.
    return NextResponse.json(
      { ok: false, brand: v.brand, error: applied.error ?? "could not apply brand" },
      { status: 422 },
    );
  }

  return NextResponse.json({ ok: true, brand: v.brand, changes: applied.changes });
}
