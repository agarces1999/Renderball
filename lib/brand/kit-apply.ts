/**
 * Turning a saved BrandKit — or a ceremony confirmation — into what a document
 * wears.
 *
 * One function owns the override semantics so the two callers (applying a
 * saved kit to a new document, and confirming the ceremony on this one) can
 * never drift: start from the crawl's own read (`documentBrandFromExtract`,
 * the same judgement the automatic path uses), then apply what the USER
 * locked, which always wins:
 *
 *   - `monochrome` deletes the accent. This is the ceremony's answer to the
 *     one question the crawler measurably cannot answer (docs/BRAND_ACCURACY.md:
 *     achromatic detection 0/9, three detectors killed by data). A human said
 *     "my brand is black & white" — no colour statistic overrules a human.
 *   - `accent` replaces the signature. Validated hex only; it is substituted
 *     into composition source later, so the injection guard is not optional.
 *
 * What deliberately does NOT transfer from a kit to a new document: uploaded
 * logo FILES. An upload lands in the source document's own assets/ dir
 * (lib/brand/document-brand.ts BrandAsset), and cross-document asset copying
 * is real machinery we have not built. The kit remembers `logo_source:
 * "upload"` so the UI can say "you replaced the crawled logo on Fuse", and the
 * crawled `logo_hd` — a URL, portable by nature — still flows through the
 * extract. Copying the bytes is future work, not silently faked here.
 */
import type { BrandExtract } from "../../app/new/schema";
import type { PaletteRoles, SavedBrandKit } from "../brand-kits";
import { documentBrandFromExtract } from "../documents/brand-crawl";
import { isHex, mergeBrandIdentity, type DocumentBrand } from "./document-brand";

const EMPTY: DocumentBrand = { v: 1, palette: {}, fonts: {}, assets: [] };

/** Extract + user-locked roles → the brand a document should wear.
 *
 * When roles somehow carry BOTH an accent and the monochrome flag — the
 * ceremony never sends both, but the legacy /new wizard can layer a fresh
 * accent pick onto a kit that stored monochrome — the EXPLICIT COLOUR wins:
 * picking a hex is a positive claim that the brand has one, made while
 * looking at swatches, and it must not be silently discarded by a flag the
 * wizard gives no way to see or clear. */
export const brandFromExtractWithRoles = (
  extract: BrandExtract,
  roles?: PaletteRoles,
): DocumentBrand => {
  const base = documentBrandFromExtract(extract) ?? { ...EMPTY, palette: {}, fonts: {} };
  if (isHex(roles?.accent)) {
    base.palette.accent = roles.accent;
  } else if (roles?.monochrome === true) {
    delete base.palette.accent;
  }
  return base;
};

export const kitToDocumentBrand = (kit: SavedBrandKit): DocumentBrand =>
  brandFromExtractWithRoles(kit.brand_extract, kit.palette_roles);

/**
 * Merge a ceremony/kit brand ONTO a document's existing brand file.
 *
 * The ceremony can upload a logo BEFORE confirming (the upload route writes
 * `brand.json` immediately), so a plain write here would clobber the logo the
 * user just gave us with the crawl's idea of the brand. Identity fields
 * (palette, fonts) come from the confirmation; material fields (logo, assets,
 * guidelines) keep whatever the document already holds.
 */
export const mergeOntoDocumentBrand = mergeBrandIdentity;
