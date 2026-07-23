import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { DEV_OWNER_ID } from "./store";
import type { BrandExtract } from "../app/new/schema";

/**
 * Account-level saved brand kits (canvas pivot, docs/PIVOT.md NEW #5).
 *
 * Until now the crawl's BrandExtract was cached per-brief
 * (StoredBrief.brand_extract) and welded to that one document — a second deck
 * for the same brand re-crawled from scratch. This module promotes it to a
 * first-class BrandKit row keyed by (ownerId, normalized host): the brief flow
 * upserts after every successful crawl, and the front door offers the
 * account's saved kits so picking one skips the crawl entirely.
 *
 * Semantics:
 *   - Upsert by (ownerId, host). A crawl-only upsert refreshes `extract` but
 *     NEVER clobbers the user's overrides (palette roles / logo source) —
 *     those change only when `overrides` is explicitly passed (the submit
 *     path, where the user actually re-locked them), and then they mirror it
 *     exactly (absent role picks clear the stored ones).
 *   - Best-effort IO: a kit write must never fail the crawl or the brief flow
 *     (upsertBrandKit swallows + warns); reads degrade to [] / null.
 *   - pg-only: under RB_STORE_BACKEND=file (offline work) every call no-ops,
 *     mirroring lib/store.ts backend selection.
 *   - The BrandExtract JSON is stored byte-identical to what the crawl
 *     produced — downstream (generateScript/build) consumes the same shape it
 *     always has. No engine changes.
 *
 * Distinct from lib/brand-kit.ts (singular), which is the pre-build identity
 * GATE (logo locked / colors confirmed); this module is the persistence of
 * what the user locked.
 */

export type LogoSource = "upload" | "crawl_confirmed";

export interface PaletteRoles {
  primary?: string;
  accent?: string;
  light?: string;
  dark?: string;
}

/** User-locked identity choices persisted alongside the extract. */
export interface BrandKitOverrides {
  palette_roles?: PaletteRoles;
  logo_source?: LogoSource;
}

/** Full saved kit — what selection in the picker hydrates the form with. */
export interface SavedBrandKit {
  id: string;
  /** Normalized host, e.g. "acme.com". */
  host: string;
  brand_extract: BrandExtract;
  palette_roles?: PaletteRoles;
  logo_source?: LogoSource;
  updated_at: string;
}

/**
 * Light row for the front-door picker. Extracts run 10-60KB each (headlines,
 * body excerpts, brand-truth report); the picker only needs identity chrome,
 * so the full extract is fetched on selection, not listed.
 */
export interface BrandKitSummary {
  id: string;
  host: string;
  title?: string;
  logo_hd?: string;
  /** First few palette hexes, for the pill's swatch dots. */
  palette: string[];
  logo_source?: LogoSource;
  updated_at: string;
}

/**
 * URL/host → the kit's identity key: lowercase hostname, scheme optional,
 * `www.` and trailing dot stripped, path/query/port ignored. Subdomains are
 * preserved on purpose — app.acme.com and acme.com are distinct design
 * systems. Returns null for anything that can't yield a hostname.
 */
export const normalizeBrandHost = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
};

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const ROLE_KEYS: Array<keyof PaletteRoles> = ["primary", "accent", "light", "dark"];

/**
 * Keep only known role keys carrying hex values. Roles arrive from client
 * FormData — same trust boundary as the brief, but a kit outlives its brief,
 * so junk is filtered before it can haunt every future document.
 */
export const sanitizePaletteRoles = (roles: unknown): PaletteRoles | undefined => {
  if (!roles || typeof roles !== "object") return undefined;
  const out: PaletteRoles = {};
  for (const key of ROLE_KEYS) {
    const v = (roles as Record<string, unknown>)[key];
    if (typeof v === "string" && HEX_RE.test(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const asLogoSource = (v: unknown): LogoSource | undefined =>
  v === "upload" || v === "crawl_confirmed" ? v : undefined;

/**
 * Pure builder for the prisma upsert — the override-preservation semantics
 * live here (unit-tested without a DB):
 *   - no `overrides` (crawl path): update touches ONLY the extract.
 *   - `overrides` given (submit path): stored overrides mirror it exactly —
 *     a role set is written, an absent one clears to NULL.
 */
export const kitUpsertArgs = (
  ownerId: string,
  host: string,
  extract: BrandExtract,
  overrides?: BrandKitOverrides,
): Prisma.BrandKitUpsertArgs => {
  const extractJson = extract as unknown as Prisma.InputJsonValue;
  const roles = sanitizePaletteRoles(overrides?.palette_roles);
  const rolesJson = roles as Prisma.InputJsonValue | undefined;
  const logoSource = asLogoSource(overrides?.logo_source);
  return {
    where: { ownerId_url: { ownerId, url: host } },
    create: {
      ownerId,
      url: host,
      extract: extractJson,
      paletteRoles: rolesJson,
      logoSource,
    },
    update: {
      extract: extractJson,
      ...(overrides
        ? {
            paletteRoles: rolesJson ?? Prisma.DbNull,
            logoSource: logoSource ?? null,
          }
        : {}),
    },
  };
};

/** The row shape both mappers consume (matches the prisma model fields). */
export interface BrandKitRow {
  id: string;
  url: string;
  extract: unknown;
  paletteRoles: unknown;
  logoSource: string | null;
  updatedAt: Date;
}

const rowExtract = (row: BrandKitRow): BrandExtract | null => {
  const extract = row.extract as BrandExtract | null;
  if (!extract || typeof extract !== "object" || extract.ok !== true) return null;
  return extract;
};

/** Row → full kit. Null when the stored extract is unusable (defensive). */
export const toSavedBrandKit = (row: BrandKitRow): SavedBrandKit | null => {
  const extract = rowExtract(row);
  if (!extract) return null;
  return {
    id: row.id,
    host: row.url,
    brand_extract: extract,
    palette_roles: sanitizePaletteRoles(row.paletteRoles),
    logo_source: asLogoSource(row.logoSource),
    updated_at: row.updatedAt.toISOString(),
  };
};

/** Row → picker summary (identity chrome only — no body copy, no report). */
export const toBrandKitSummary = (row: BrandKitRow): BrandKitSummary | null => {
  const extract = rowExtract(row);
  if (!extract) return null;
  return {
    id: row.id,
    host: row.url,
    title: extract.title,
    logo_hd: extract.logo_hd,
    palette: (extract.palette ?? []).slice(0, 4),
    logo_source: asLogoSource(row.logoSource),
    updated_at: row.updatedAt.toISOString(),
  };
};

// ── IO ────────────────────────────────────────────────────────────────────────

const usingFileStore = (): boolean => process.env.RB_STORE_BACKEND === "file";

/**
 * BrandKit FKs to User; the dev partition (app/api/dev/*) has no Clerk-created
 * row, so lazily upsert the synthetic one — same pattern as lib/store.ts's
 * ensureDevUser (kept private there; duplicated rather than exported so this
 * lane's diff stays out of store.ts).
 */
let devUserEnsured = false;
const ensureDevKitUser = async (): Promise<void> => {
  if (devUserEnsured) return;
  await prisma.user.upsert({
    where: { id: DEV_OWNER_ID },
    update: {},
    create: { id: DEV_OWNER_ID, clerkId: DEV_OWNER_ID, email: "dev@renderball.local" },
  });
  devUserEnsured = true;
};

/**
 * Persist/refresh the kit for this extract's host. Fire-and-forget safe: never
 * throws, no-ops on a failed extract, an unusable host, or the file backend.
 */
export const upsertBrandKit = async (input: {
  ownerId: string;
  extract: BrandExtract;
  overrides?: BrandKitOverrides;
}): Promise<void> => {
  if (usingFileStore()) return;
  if (!input.extract?.ok) return;
  const host = normalizeBrandHost(input.extract.url);
  if (!host) return;
  try {
    if (input.ownerId === DEV_OWNER_ID) await ensureDevKitUser();
    await prisma.brandKit.upsert(kitUpsertArgs(input.ownerId, host, input.extract, input.overrides));
  } catch (err) {
    console.warn(`[brand-kits] upsert for ${host} failed — continuing without saving the kit:`, err);
  }
};

/** The account's saved kits for the picker, most recently refreshed first. */
export const listBrandKitSummaries = async (ownerId: string): Promise<BrandKitSummary[]> => {
  if (usingFileStore()) return [];
  try {
    const rows = await prisma.brandKit.findMany({
      where: { ownerId }, // strict — kits are never listed across the dev partition
      orderBy: { updatedAt: "desc" },
      take: 12,
    });
    return rows.map(toBrandKitSummary).filter((k): k is BrandKitSummary => k !== null);
  } catch (err) {
    console.warn(`[brand-kits] list for ${ownerId} failed — picker degrades to empty:`, err);
    return [];
  }
};

/** Full kit by id, ownership-checked. Null = not found / not yours / unusable. */
export const getBrandKit = async (ownerId: string, id: string): Promise<SavedBrandKit | null> => {
  if (usingFileStore()) return null;
  try {
    const row = await prisma.brandKit.findFirst({ where: { id, ownerId } });
    return row ? toSavedBrandKit(row) : null;
  } catch (err) {
    console.warn(`[brand-kits] get ${id} failed — selection degrades to a fresh crawl:`, err);
    return null;
  }
};
