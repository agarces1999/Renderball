import { Prisma } from "@prisma/client";
import { prisma, withDbRetry } from "./db";
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
  /**
   * Ceremony answer (2026-08-11): the user confirmed the brand IS black &
   * white. Wins over `accent` when both are somehow present. This is the human
   * answer to the question the crawler measurably cannot answer from bytes
   * (docs/BRAND_ACCURACY.md — achromatic detection killed by data, 0/9).
   */
  monochrome?: boolean;
}

/** User-locked identity choices persisted alongside the extract. */
export interface BrandKitOverrides {
  palette_roles?: PaletteRoles;
  logo_source?: LogoSource;
}

/** Full saved kit — what selection in the picker hydrates the form with. */
export interface SavedBrandKit {
  id: string;
  /** What the user called it in the ceremony ("Fuse"). Absent = never named. */
  name?: string;
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
  /** The user's name for it. The ceremony picker only shows NAMED kits. */
  name?: string;
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
const ROLE_KEYS = ["primary", "accent", "light", "dark"] as const satisfies ReadonlyArray<keyof PaletteRoles>;

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
  // Strict `=== true`, same discipline as requestedTier: this flag deletes a
  // colour, and a truthy string must not be able to do that by accident.
  if ((roles as Record<string, unknown>).monochrome === true) out.monochrome = true;
  return Object.keys(out).length > 0 ? out : undefined;
};

const asLogoSource = (v: unknown): LogoSource | undefined =>
  v === "upload" || v === "crawl_confirmed" ? v : undefined;

/**
 * A kit name is user prose shown back inside the picker — trimmed, capped,
 * control characters out. Undefined (not "") when nothing usable remains, so
 * the upsert's "only write a name that was actually given" rule stays simple.
 */
export const sanitizeKitName = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  return clean.length > 0 ? clean : undefined;
};

/**
 * The default name offered in the ceremony's "Name this brand" field: the
 * site's own title when it reads like a name, else the host without its TLD,
 * capitalized ("fusefinance.com" → "Fusefinance"). Pure, so the panel and the
 * server agree on the suggestion.
 */
export const suggestKitName = (host: string, title?: string): string => {
  const t = (title ?? "").trim();
  // A usable title is short and not a sentence — "Fuse", "Duolingo", not
  // "Fuse | The AI-native loan origination system for credit unions".
  const head = t.split(/[|\u2013\u2014·:-]/)[0]?.trim() ?? "";
  if (head.length >= 2 && head.length <= 24 && !/[.!?]$/.test(head)) return head;
  const stem = host.split(".")[0] ?? host;
  return stem.length > 0 ? stem[0].toUpperCase() + stem.slice(1) : host;
};

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
  /** The user's name for the kit. Same preservation rule as overrides: only a
   *  ceremony that actually collected a name writes one — a crawl-path upsert
   *  (name undefined) must never blank a name the user already gave. */
  name?: string,
): Prisma.BrandKitUpsertArgs => {
  const extractJson = extract as unknown as Prisma.InputJsonValue;
  const roles = sanitizePaletteRoles(overrides?.palette_roles);
  const rolesJson = roles as Prisma.InputJsonValue | undefined;
  const logoSource = asLogoSource(overrides?.logo_source);
  const cleanName = sanitizeKitName(name);
  return {
    where: { ownerId_url: { ownerId, url: host } },
    create: {
      ownerId,
      url: host,
      name: cleanName,
      extract: extractJson,
      paletteRoles: rolesJson,
      logoSource,
    },
    update: {
      extract: extractJson,
      ...(cleanName ? { name: cleanName } : {}),
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
  name?: string | null;
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
    ...(row.name ? { name: row.name } : {}),
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
    ...(row.name ? { name: row.name } : {}),
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
  /** Ceremony path only — the name the user typed. */
  name?: string;
}): Promise<string | null> => {
  if (usingFileStore()) return null;
  if (!input.extract?.ok) return null;
  const host = normalizeBrandHost(input.extract.url);
  if (!host) return null;
  try {
    if (input.ownerId === DEV_OWNER_ID) await ensureDevKitUser();
    const row = await withDbRetry(() =>
      prisma.brandKit.upsert(
        kitUpsertArgs(input.ownerId, host, input.extract, input.overrides, input.name),
      ),
    );
    return row.id;
  } catch (err) {
    console.warn(`[brand-kits] upsert for ${host} failed — continuing without saving the kit:`, err);
    return null;
  }
};

/** The account's saved kits for the picker, most recently refreshed first.
 *  `namedOnly` is the ceremony's view: a kit nobody named is a crawl cache,
 *  not a brand the user recognises, and offering it back as one reads as the
 *  product guessing. */
export const listBrandKitSummaries = async (
  ownerId: string,
  opts: { namedOnly?: boolean } = {},
): Promise<BrandKitSummary[]> => {
  if (usingFileStore()) return [];
  try {
    const rows = await withDbRetry(() =>
      prisma.brandKit.findMany({
        where: { ownerId, ...(opts.namedOnly ? { name: { not: null } } : {}) }, // strict — kits are never listed across the dev partition
        orderBy: { updatedAt: "desc" },
        take: 12,
      }),
    );
    return rows.map(toBrandKitSummary).filter((k): k is BrandKitSummary => k !== null);
  } catch (err) {
    console.warn(`[brand-kits] list for ${ownerId} failed — picker degrades to empty:`, err);
    return [];
  }
};

/**
 * Full kit by HOST, ownership-checked — what the ceremony's confirm reads to
 * PRESERVE a previously locked answer. A user who confirmed "black & white"
 * last month and just clicks through the ceremony today has not changed their
 * mind; only an actual new answer may overwrite the stored one.
 */
export const getBrandKitByHost = async (
  ownerId: string,
  host: string,
): Promise<SavedBrandKit | null> => {
  if (usingFileStore()) return null;
  try {
    const row = await withDbRetry(() =>
      prisma.brandKit.findUnique({ where: { ownerId_url: { ownerId, url: host } } }),
    );
    return row ? toSavedBrandKit(row) : null;
  } catch (err) {
    console.warn(`[brand-kits] byHost ${host} failed:`, err);
    return null;
  }
};

/** Delete a kit, ownership-checked. True = a row was actually removed. */
export const deleteBrandKit = async (ownerId: string, id: string): Promise<boolean> => {
  if (usingFileStore()) return false;
  try {
    const res = await withDbRetry(() => prisma.brandKit.deleteMany({ where: { id, ownerId } }));
    return res.count > 0;
  } catch (err) {
    console.warn(`[brand-kits] delete ${id} failed:`, err);
    return false;
  }
};

/** Full kit by id, ownership-checked. Null = not found / not yours / unusable. */
export const getBrandKit = async (ownerId: string, id: string): Promise<SavedBrandKit | null> => {
  if (usingFileStore()) return null;
  try {
    const row = await withDbRetry(() => prisma.brandKit.findFirst({ where: { id, ownerId } }));
    return row ? toSavedBrandKit(row) : null;
  } catch (err) {
    console.warn(`[brand-kits] get ${id} failed — selection degrades to a fresh crawl:`, err);
    return null;
  }
};
