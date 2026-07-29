import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import {
  readDocumentBrand,
  validateBrandInput,
  writeDocumentBrand,
} from "../../../../lib/brand/document-brand";
import { applyBrandToDocument } from "../../../../lib/brand/apply-brand";
import { colorsInUse, parseFontConsts, resolveRoleColors } from "../../../../lib/brand/reskin";

/**
 * Dev-only brand route — headless counterpart to /api/preview/brand (no Clerk
 * session). NODE_ENV-gated: 404 in production.
 *
 * Exists so the brand panel — changing a deck's colours and fonts — can be
 * driven by the QA suite in a real browser without a session. Brand was the
 * largest part of the product with no automated coverage at all, purely because
 * it had no unauthenticated twin the way every other editor operation does.
 *
 * Reads the genDir straight from disk rather than via documentDir(): the dev
 * harness works on local documents and must not pull from durable storage.
 *
 * GET ?scriptId=… → { brand, inUse }
 * PUT { scriptId, brand, apply? } → { ok, brand, changes }
 */

const devGenDir = (scriptId: string): string =>
  path.join(process.cwd(), "src", "generated", scriptId);

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }
  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  const genDir = devGenDir(scriptId);
  const brand = await readDocumentBrand(genDir);
  const source = await fs.readFile(path.join(genDir, "Composition.tsx"), "utf8").catch(() => "");

  const roles = resolveRoleColors(source);
  const inUse = {
    palette: Object.fromEntries(Object.entries(roles).map(([role, hexes]) => [role, hexes?.[0]])),
    fonts: parseFontConsts(source),
    colors: colorsInUse(source).slice(0, 12),
  };

  return NextResponse.json({ ok: true, brand, inUse });
}

export async function PUT(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

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

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  // Same validation as production: these values are substituted into source
  // this process later executes, so the dev twin must not be the lenient one.
  const v = validateBrandInput(body.brand);
  if (!v.ok) return NextResponse.json({ error: v.errors.join("; ") }, { status: 400 });

  const genDir = devGenDir(scriptId);
  await writeDocumentBrand(genDir, v.brand);

  if (body.apply === false) {
    return NextResponse.json({ ok: true, brand: v.brand, changes: [] });
  }

  const applied = await applyBrandToDocument(genDir, v.brand);
  if (!applied.ok) {
    return NextResponse.json(
      { ok: false, brand: v.brand, error: applied.error ?? "could not apply brand" },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, brand: v.brand, changes: applied.changes });
}
