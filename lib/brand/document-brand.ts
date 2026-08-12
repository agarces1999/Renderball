/**
 * Document-level brand context — the brand a PRESENTATION is wearing, as
 * opposed to the brand the brief was created with.
 *
 * Why this exists: brand was captured once at /new (crawl + uploads + palette
 * roles), baked into the composition at build time, and then frozen. There was
 * no surface anywhere to change a deck's colors, fonts, logo or brand
 * materials after it existed, and no place at all to say "here is how our
 * brand is supposed to look and sound" in words. That makes the product a
 * one-shot generator rather than an editor you keep working in.
 *
 * Where it lives: `<genDir>/brand.json`, colocated with the document exactly
 * like `assets/` (lib/edit/image-assets.ts). That means it travels with the
 * document through gen-store's R2 bundle for free, survives a redeploy, and is
 * covered by the same owner-scoped path every editor route already resolves.
 * Deliberately NOT a new DB table: the composition is the source of truth for
 * a document's rendered state, and brand belongs beside it.
 *
 * Relationship to BrandKit (prisma/schema.prisma): BrandKit is the REUSABLE
 * account-level brand, consumed at create time. This is the per-document
 * override. A document starts with whatever the build baked in and diverges
 * from there; changing one deck must never silently restyle another.
 */
import { promises as fs } from "fs";
import path from "path";

/** A colour role the rest of the system reasons about. */
export type PaletteRole =
  | "accent"
  | "canvas"
  | "ink"
  | "muted"
  | "surface"
  | "line";

export interface BrandFontFace {
  /** family name as referenced in CSS, e.g. "Inter" */
  family: string;
  /** woff2/woff/ttf/otf URL, or an `assets/…` document-asset ref */
  src: string;
  weight?: string;
  style?: string;
}

/** An uploaded brand material. Images use the same `assets/<name>` token the
 *  editor's inserted images use, so rendering/inlining is already handled. */
export interface BrandAsset {
  /** `assets/<name>` ref, or an absolute URL for crawl-discovered material */
  ref: string;
  /** original filename, shown in the UI */
  name: string;
  mime: string;
  /** what this material IS, so regeneration can reference it meaningfully */
  kind: "logo" | "logomark" | "icon" | "image" | "illustration" | "data" | "font" | "other";
  /** freeform note: "use this on dark backgrounds only" */
  note?: string;
}

export interface DocumentBrand {
  /** schema version — bumped if the shape ever changes */
  v: 1;
  /** role → hex. Only roles the user has actually set. */
  palette: Partial<Record<PaletteRole, string>>;
  fonts: {
    display?: string;
    body?: string;
    mono?: string;
    /** @font-face sources to emit so the families above actually load */
    faces?: BrandFontFace[];
  };
  /** the mark used in chrome/lockups — an `assets/…` ref or URL */
  logo?: string;
  /** every uploaded/known brand material, including the logo */
  assets: BrandAsset[];
  /**
   * Freeform brand guidance in the user's own words — voice, do/don't,
   * "never put the logo on the accent colour", "we always use sentence case".
   * Fed verbatim into regeneration prompts. This is the piece the system had
   * no representation for at all.
   */
  guidelines?: string;
  updatedAt?: string;
}

export const EMPTY_BRAND: DocumentBrand = { v: 1, palette: {}, fonts: {}, assets: [] };

const brandPath = (genDir: string): string => path.join(genDir, "brand.json");

/** Read the document's brand overrides. Missing file = nothing overridden. */
export const readDocumentBrand = async (genDir: string): Promise<DocumentBrand> => {
  try {
    const raw = await fs.readFile(brandPath(genDir), "utf8");
    const parsed = JSON.parse(raw) as DocumentBrand;
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_BRAND };
    return {
      v: 1,
      palette: parsed.palette ?? {},
      fonts: parsed.fonts ?? {},
      logo: parsed.logo,
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
      guidelines: parsed.guidelines,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { ...EMPTY_BRAND };
  }
};

/**
 * Merge an IDENTITY (palette + fonts) onto a document's existing brand,
 * keeping its MATERIALS (logo, assets, guidelines). Every writer that derives
 * identity from a crawl or a kit must use this rather than a plain write:
 * the ceremony's logo upload lands in brand.json immediately, and a plain
 * overwrite (crawl re-read, "look harder") was measured to erase it.
 */
export const mergeBrandIdentity = (
  existing: DocumentBrand,
  incoming: DocumentBrand,
): DocumentBrand => ({
  v: 1,
  palette: incoming.palette,
  fonts: incoming.fonts,
  logo: existing.logo,
  assets: existing.assets,
  guidelines: existing.guidelines,
});

export const writeDocumentBrand = async (
  genDir: string,
  brand: DocumentBrand,
): Promise<void> => {
  const next: DocumentBrand = { ...brand, v: 1, updatedAt: new Date().toISOString() };
  await fs.writeFile(brandPath(genDir), JSON.stringify(next, null, 2), "utf8");
};

/* ── validation ─────────────────────────────────────────────────────────
 * These values are substituted into the composition source, so they are an
 * injection surface: a "hex" of `red";process.exit()//` would be written into
 * a file this process later executes. Everything is validated to a strict
 * shape before it can be stored.
 */

export const isHex = (s: unknown): s is string =>
  typeof s === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);

/** A CSS font-family list, conservatively: names, quotes, commas, spaces. */
export const isFontStack = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 200 &&
  /^[\w\s,'"-]+$/.test(s) &&
  !/[;{}()<>\\]/.test(s);

/** A document-asset token or a plain https URL — never javascript:/data:. */
export const isAssetRef = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length <= 512 &&
  (/^assets\/[A-Za-z0-9._-]+$/.test(s) || /^https:\/\/[^\s"'<>]+$/.test(s));

const ROLES: PaletteRole[] = ["accent", "canvas", "ink", "muted", "surface", "line"];
const KINDS: BrandAsset["kind"][] = [
  "logo", "logomark", "icon", "image", "illustration", "data", "font", "other",
];

export interface BrandValidation {
  ok: boolean;
  brand: DocumentBrand;
  errors: string[];
}

/** Coerce arbitrary client input into a storable DocumentBrand. */
export const validateBrandInput = (input: unknown): BrandValidation => {
  const errors: string[] = [];
  const src = (input ?? {}) as Partial<DocumentBrand>;
  const brand: DocumentBrand = { v: 1, palette: {}, fonts: {}, assets: [] };

  for (const role of ROLES) {
    const v = src.palette?.[role];
    if (v === undefined) continue;
    if (isHex(v)) brand.palette[role] = v.toLowerCase();
    else errors.push(`palette.${role} must be a hex colour`);
  }

  for (const slot of ["display", "body", "mono"] as const) {
    const v = src.fonts?.[slot];
    if (v === undefined) continue;
    if (isFontStack(v)) brand.fonts[slot] = v;
    else errors.push(`fonts.${slot} is not a valid font stack`);
  }

  if (src.fonts?.faces !== undefined) {
    if (!Array.isArray(src.fonts.faces)) errors.push("fonts.faces must be an array");
    else {
      brand.fonts.faces = [];
      for (const f of src.fonts.faces.slice(0, 24)) {
        if (!isFontStack(f?.family) || !isAssetRef(f?.src)) {
          errors.push(`invalid font face "${String(f?.family)}"`);
          continue;
        }
        brand.fonts.faces.push({
          family: f.family,
          src: f.src,
          weight: /^[\w\s]{1,20}$/.test(String(f.weight ?? "")) ? f.weight : undefined,
          style: f.style === "italic" ? "italic" : undefined,
        });
      }
    }
  }

  if (src.logo !== undefined) {
    if (isAssetRef(src.logo)) brand.logo = src.logo;
    else errors.push("logo must be a document asset ref or https URL");
  }

  if (src.assets !== undefined) {
    if (!Array.isArray(src.assets)) errors.push("assets must be an array");
    else {
      for (const a of src.assets.slice(0, 200)) {
        if (!isAssetRef(a?.ref)) {
          errors.push(`invalid asset ref "${String(a?.ref)}"`);
          continue;
        }
        brand.assets.push({
          ref: a.ref,
          name: String(a.name ?? "asset").slice(0, 120),
          mime: String(a.mime ?? "application/octet-stream").slice(0, 100),
          kind: KINDS.includes(a.kind) ? a.kind : "other",
          note: a.note ? String(a.note).slice(0, 500) : undefined,
        });
      }
    }
  }

  if (src.guidelines !== undefined) {
    if (typeof src.guidelines !== "string") errors.push("guidelines must be text");
    // Generous but bounded: this is pasted into prompts, and an unbounded
    // field is both a cost and a prompt-stuffing surface.
    else brand.guidelines = src.guidelines.slice(0, 4000);
  }

  return { ok: errors.length === 0, brand, errors };
};
