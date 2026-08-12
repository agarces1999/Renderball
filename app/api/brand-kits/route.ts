import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../lib/auth";
import { loadBriefByScriptId, saveBrief } from "../../../lib/store";
import {
  deleteBrandKit,
  getBrandKit,
  getBrandKitByHost,
  listBrandKitSummaries,
  normalizeBrandHost,
  sanitizeKitName,
  sanitizePaletteRoles,
  upsertBrandKit,
  type BrandKitOverrides,
} from "../../../lib/brand-kits";
import {
  brandFromExtractWithRoles,
  kitToDocumentBrand,
  mergeOntoDocumentBrand,
} from "../../../lib/brand/kit-apply";
import {
  readDocumentBrand,
  writeDocumentBrand,
} from "../../../lib/brand/document-brand";
import { applyBrandToDocument } from "../../../lib/brand/apply-brand";
import { documentDir } from "../../../lib/render/gen-store";
import { isBlankComposition } from "../../../lib/documents/blank-document";
import type { BrandExtract } from "../../../app/new/schema";

/**
 * Named brand kits — the brand ceremony's server half (founder call
 * 2026-08-11: every new document opens with the ceremony; saved brands are
 * NAMED and selectable).
 *
 * GET  → the account's NAMED kits, newest first. Unnamed rows (legacy brief-
 *        flow upserts) are crawl caches, not brands anyone recognises — the
 *        picker never offers them.
 *
 * POST, two shapes, both 0 tokens by construction (no model call anywhere on
 * this route — the crawl already happened, or the kit already exists):
 *
 *   { scriptId, kitId }
 *     Apply a saved kit to this document. Rebuilds the wearable brand from the
 *     kit's extract + the user's locked overrides, merges onto the document's
 *     brand file (uploads survive), re-skins only a BLANK composition — the
 *     same protect-their-work rule the crawl obeys — and persists the extract
 *     onto the brief so generation sees the brand.
 *
 *   { scriptId, name, accent? | monochrome? }
 *     Ceremony confirmation. The extract to confirm is the one the crawl
 *     already persisted onto the brief — the client never sends brand bytes,
 *     so a hostile client cannot inject a "crawl result" we never performed.
 *     Saves/updates the named kit and dresses the document in the confirmed
 *     identity.
 *
 * Both answers carry `applied` honestly: false means the document had content
 * and was left alone (the Brand panel applies it in one click), never that
 * something failed silently.
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const kits = await listBrandKitSummaries(user.id, { namedOnly: true });
  return NextResponse.json({ kits });
}

interface ConfirmBody {
  scriptId?: string;
  kitId?: string;
  name?: string;
  accent?: string;
  monochrome?: unknown;
  /** "upload" when the user replaced the crawled logo during the ceremony. */
  logoSource?: string;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const scriptId = typeof body.scriptId === "string" ? body.scriptId : "";
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  // Ownership first — everything below writes into this document's directory.
  const brief = await loadBriefByScriptId(scriptId, user.id);
  if (!brief) return NextResponse.json({ error: "document not found" }, { status: 404 });

  // ── shape 1: apply a saved kit ─────────────────────────────────────────────
  if (typeof body.kitId === "string" && body.kitId) {
    const kit = await getBrandKit(user.id, body.kitId);
    if (!kit) return NextResponse.json({ error: "brand not found" }, { status: 404 });

    const incoming = kitToDocumentBrand(kit);
    const applied = await dressDocument(scriptId, incoming);

    // The brief carries the brand into generateScript — without this, a kit
    // pick would style the canvas but the OUTLINE would never see the brand.
    //
    // palette_roles are REPLACED wholesale, never merge-preserved: they are
    // answers about a specific brand, and a conditional spread here let a
    // monochrome answer for site A survive into a colourful kit B — the
    // canvas wore B's accent while generation was told "THE USER CONFIRMED
    // THIS BRAND IS DELIBERATELY BLACK & WHITE". Caught in review.
    try {
      const next = {
        ...brief,
        brand_kit_url: kit.brand_extract.url,
        brand_extract: kit.brand_extract,
        palette_roles: kit.palette_roles,
      };
      if (!kit.palette_roles) delete next.palette_roles;
      await saveBrief(next);
    } catch (err) {
      console.error(`[brand-kits] ${scriptId}: could not persist kit extract onto brief:`, err);
    }

    return NextResponse.json({
      ok: true,
      kitId: kit.id,
      name: kit.name ?? kit.host,
      applied,
      accent: incoming.palette.accent,
      display_font: incoming.fonts.display,
    });
  }

  // ── shape 2: ceremony confirmation ─────────────────────────────────────────
  const name = sanitizeKitName(body.name);
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const extract = brief.brand_extract as BrandExtract | undefined;
  if (!extract?.ok) {
    return NextResponse.json(
      { error: "no site has been read for this document yet" },
      { status: 409 },
    );
  }

  const answered = sanitizePaletteRoles({
    accent: body.accent,
    monochrome: body.monochrome,
  });
  // SILENCE PRESERVES, AN ANSWER REPLACES. A user who confirmed "black &
  // white" for this host last month and clicks straight through the ceremony
  // today has not changed their mind — but the confirm always carries
  // overrides (logo_source), whose all-or-nothing mirror semantics would
  // null the stored roles. So the roles written are: what they answered NOW,
  // else what this host's kit already holds. Caught in review.
  const host = normalizeBrandHost(extract.url);
  const previous = !answered && host ? await getBrandKitByHost(user.id, host) : null;
  const roles = answered ?? previous?.palette_roles;

  const overrides: BrandKitOverrides = {
    ...(roles ? { palette_roles: roles } : {}),
    ...(body.logoSource === "upload"
      ? { logo_source: "upload" as const }
      : { logo_source: "crawl_confirmed" as const }),
  };

  const kitId = await upsertBrandKit({ ownerId: user.id, extract, overrides, name });

  const incoming = brandFromExtractWithRoles(extract, roles);
  const applied = await dressDocument(scriptId, incoming);

  // The brief always MIRRORS the confirmed state — set or cleared. Leaving a
  // stale lock on the brief is how a monochrome answer haunted the next
  // brand's generation.
  try {
    const next = { ...brief, palette_roles: roles };
    if (!roles) delete next.palette_roles;
    await saveBrief(next);
  } catch (err) {
    console.error(`[brand-kits] ${scriptId}: could not persist roles onto brief:`, err);
  }

  return NextResponse.json({
    ok: true,
    kitId,
    // The kit write is best-effort by design; the DOCUMENT is dressed either
    // way. But the name field promised "saved to your account", so the client
    // is told the truth about whether that actually happened.
    saved: kitId !== null,
    name,
    applied,
    accent: incoming.palette.accent,
    display_font: incoming.fonts.display,
  });
}

/**
 * Write the identity onto the document's brand file and re-skin ONLY a blank
 * composition. Same fail-closed direction as the crawl: if blankness cannot be
 * determined, the sources are not touched — the brand is saved and the Brand
 * panel applies it in one deterministic click.
 */
const dressDocument = async (
  scriptId: string,
  incoming: Awaited<ReturnType<typeof kitToDocumentBrand>>,
): Promise<boolean> => {
  try {
    const genDir = await documentDir(scriptId);
    const existing = await readDocumentBrand(genDir);
    const merged = mergeOntoDocumentBrand(existing, incoming);
    await writeDocumentBrand(genDir, merged);
    if (await isBlankComposition(genDir, "not-blank")) {
      const res = await applyBrandToDocument(genDir, merged);
      return res.ok;
    }
  } catch (err) {
    console.error(`[brand-kits] ${scriptId}: could not dress document:`, err);
  }
  return false;
};

/**
 * DELETE { kitId } — remove a saved brand. Documents already wearing it keep
 * their own brand.json untouched; a kit is a template, not a live link.
 */
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { kitId?: string };
  try {
    body = (await request.json()) as { kitId?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.kitId || typeof body.kitId !== "string") {
    return NextResponse.json({ error: "kitId required" }, { status: 400 });
  }
  const removed = await deleteBrandKit(user.id, body.kitId);
  if (!removed) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
