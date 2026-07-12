import { promises as fs } from "fs";
import path from "path";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { Script } from "../src/schema";
import type { BrandExtract } from "../app/new/schema";

/**
 * Persistence layer — dual backend (LAUNCH.md critical-path 3b).
 *
 * Backends:
 *   file — the V0 JSON files under `.data/` (briefs/, scripts/). The original
 *          implementation, kept verbatim as the fallback and for offline work.
 *   pg   — Prisma against Postgres (Neon): Project rows carry the FULL
 *          StoredBrief as a Json column (plus denormalized ownerId/status/
 *          scriptId for indexed lookups); script bytes live in ScriptDoc
 *          keyed by script ULID. Ownership is resolved exclusively through
 *          Project (scriptId is @unique + indexed — the file backend's O(n)
 *          scan becomes one lookup).
 *
 * Selection: RB_STORE_BACKEND=pg|file overrides; otherwise DEFAULT_BACKEND.
 * The default is "pg" (flipped 2026-07-08 after scripts/migrate-store-to-pg.ts
 * imported the legacy .data — 297 briefs / 292 scripts). RB_STORE_BACKEND=file
 * remains as an escape hatch for offline work against the legacy .data JSON.
 * Every exported signature is IDENTICAL across backends; no call site changes.
 *
 * Scripts carry no owner of their own in either backend — a script is
 * reachable only through a brief/Project the requester owns. saveScript is
 * deliberately link-independent (upsert by script id) because the product
 * flow writes the script BEFORE the brief learns its script_id.
 */
const DATA_DIR = path.join(process.cwd(), ".data");
const BRIEFS_DIR = path.join(DATA_DIR, "briefs");
const SCRIPTS_DIR = path.join(DATA_DIR, "scripts");

const DEFAULT_BACKEND: "file" | "pg" = "pg";
const backend = (): "file" | "pg" => {
  const env = process.env.RB_STORE_BACKEND;
  if (env === "pg" || env === "file") return env;
  return DEFAULT_BACKEND;
};

export type BriefStatus =
  | "awaiting_agent_1"
  | "script_generated"
  | "script_approved"
  | "rendering"
  | "rendered"
  | "failed";

export type CreativityLevel = "literal" | "balanced" | "bold";

export interface StoredMoment {
  title: string; // may be ""
  description: string;
  creativity: CreativityLevel;
}

export interface StoredFileRef {
  name: string;
  url: string;
  mime: string;
  size: number;
  /** Set when the user uploaded this as their brand logo (logo agent NONE'd). */
  is_logo?: boolean;
  /** Set when the user uploaded this as their brand webfont (brand-kit gate). */
  is_font?: boolean;
  /** Display name for the uploaded font family (derived from filename or user input). */
  font_family?: string;
  /** User attested they hold the webfont license (required for is_font files). */
  font_licensed?: boolean;
}

export interface StoredBrief {
  id: string;
  /**
   * Owner of this brief — `User.id` for real users, `DEV_OWNER_ID` for the
   * dev-only routes. Every read is filtered by it; a brief with a non-matching
   * (or missing, i.e. legacy) owner is invisible to the requester.
   */
  owner_id: string;
  purpose: string;
  duration_seconds: number;
  /**
   * User's distribution choice from the wizard ("mobile-feed" | "square"
   * | "landscape"). Authoritative for aspect_ratio + viewing_context
   * passed to the agents. Optional on read for back-compat with briefs
   * persisted before this field existed.
   */
  distribution_format?: "mobile-feed" | "square" | "landscape";
  moments: StoredMoment[];
  cta: string;
  brand_kit_url?: string;
  brand_files?: StoredFileRef[];
  /**
   * User-supplied real numeric claims, one per line. Acts as the 3rd
   * grounding source alongside body_excerpts + brief.about for the
   * hallucination guardrail. Especially valuable for JS-rendered brand
   * sites where body_excerpts is thin.
   */
  verified_claims?: string;
  /**
   * Hex codes the user assigned to brand color roles in the wizard's
   * palette step. Overrides `brand_extract.palette`'s frequency-ranked
   * auto-pick. Each value MUST be a hex code from the crawled palette.
   */
  palette_roles?: {
    primary?: string;
    accent?: string;
    light?: string;
    dark?: string;
  };
  /** Cached output of extractBrand() — kept on the brief so Agent 2 can use it at render time without re-crawling. */
  brand_extract?: BrandExtract;
  /**
   * Brand-kit gate (approved DESIGN.md deviation, 2026-07-07): how the logo
   * was locked — user upload, or explicit confirmation of the crawled mark.
   * Absent on legacy briefs (created before the gate).
   */
  logo_source?: "upload" | "crawl_confirmed";
  /** User confirmed (or edited then confirmed) the scanned brand palette. */
  colors_confirmed?: boolean;
  created_at: string;
  status: BriefStatus;
  script_id?: string; // populated after Agent 1 runs
  error?: string;
}

const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};

/**
 * Path-traversal guard. Every id we read is a ULID (26-char Crockford base32,
 * see lib/ulid.ts). Anything else — `../`, `.env.local`, absolute paths — is
 * rejected before it can reach `path.join`, so a user-supplied id can never
 * escape the briefs/scripts directories. Defense-in-depth: today these ids
 * arrive via ULID-constrained route params, but the validator means a future
 * caller that forwards a raw query param can't open a hole.
 */
const VALID_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
export const isValidId = (id: string): boolean => VALID_ID.test(id);

/**
 * Owner id used by the dev-only routes (app/api/dev/*), which run without a
 * Clerk session and are 404'd in production. Keeps their data partitioned from
 * real users in the shared store. (Defined here, re-exported by lib/auth.ts,
 * so store consumers don't drag Clerk into their module graph.)
 */
export const DEV_OWNER_ID = "dev-local";

/**
 * Ownership match with a DEV-ONLY read fallback: in development, briefs owned
 * by the dev-local partition (headless harness/dogfood builds) are readable by
 * any signed-in local user — otherwise every /preview/<id> link for a harness
 * build 404s under multi-tenancy. Never applies in production, where the dev
 * routes are 404'd and no dev-local data should exist.
 */
const ownerMatches = (briefOwner: string, requester: string): boolean =>
  briefOwner === requester ||
  (process.env.NODE_ENV !== "production" && briefOwner === DEV_OWNER_ID);

/** The Prisma OR-clause form of ownerMatches, for indexed WHERE queries. */
const ownerWhere = (ownerId: string): Prisma.ProjectWhereInput =>
  process.env.NODE_ENV !== "production"
    ? { OR: [{ ownerId }, { ownerId: DEV_OWNER_ID }] }
    : { ownerId };

// ── pg backend internals ──────────────────────────────────────────────────────

/**
 * Project/UsageRecord rows FK to User; the dev partition has no Clerk-created
 * row, so the pg backend lazily upserts a synthetic one. Memoized per process.
 */
let devUserEnsured = false;
const ensureDevUser = async (): Promise<void> => {
  if (devUserEnsured) return;
  await prisma.user.upsert({
    where: { id: DEV_OWNER_ID },
    update: {},
    create: {
      id: DEV_OWNER_ID,
      clerkId: DEV_OWNER_ID,
      email: "dev@renderball.local",
    },
  });
  devUserEnsured = true;
};

const pgSaveBrief = async (brief: StoredBrief): Promise<void> => {
  if (brief.owner_id === DEV_OWNER_ID) await ensureDevUser();
  const data = {
    ownerId: brief.owner_id,
    purpose: brief.purpose,
    status: brief.status,
    brief: brief as unknown as Prisma.InputJsonValue,
    brandExtract: (brief.brand_extract ?? undefined) as Prisma.InputJsonValue | undefined,
    scriptId: brief.script_id ?? null,
    error: brief.error ?? null,
  };
  await prisma.project.upsert({
    where: { id: brief.id },
    update: data,
    create: { id: brief.id, ...data, createdAt: new Date(brief.created_at) },
  });
};

const pgLoadBrief = async (id: string, ownerId: string): Promise<StoredBrief | null> => {
  const row = await prisma.project.findUnique({ where: { id }, select: { ownerId: true, brief: true } });
  if (!row || !ownerMatches(row.ownerId, ownerId)) return null;
  return row.brief as unknown as StoredBrief;
};

const pgListBriefsByOwner = async (ownerId: string): Promise<StoredBrief[]> => {
  const rows = await prisma.project.findMany({
    where: { ownerId }, // strict — the dev fallback is a read-by-id affordance, not a listing one
    orderBy: { createdAt: "desc" },
    select: { brief: true },
  });
  return rows.map((r) => r.brief as unknown as StoredBrief);
};

const pgLoadBriefByScriptId = async (
  scriptId: string,
  ownerId: string,
): Promise<StoredBrief | null> => {
  const row = await prisma.project.findFirst({
    where: { AND: [{ scriptId }, ownerWhere(ownerId)] },
    select: { brief: true },
  });
  return row ? (row.brief as unknown as StoredBrief) : null;
};

const pgSaveScript = async (script: Script, ownerId?: string): Promise<void> => {
  // GDPR guard (audit 2026-07-12): ScriptDoc has no FK to Project, so a build /
  // regen still in flight when the user deletes their account would UPSERT the
  // script JSON back AFTER deleteUserData removed it — an orphan holding brand
  // copy that no deletion path can reach again. When the caller knows the owner
  // (every user-facing path does), refuse the write if that User is gone.
  // customer_id can't be used here — it is a static "local-dev" placeholder,
  // not the account id — so the owner must be threaded in explicitly.
  if (ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!owner) {
      console.warn(`[store] pgSaveScript: owner ${ownerId} no longer exists — skipping script ${script.id} (deleted mid-build?)`);
      return;
    }
  }
  const json = script as unknown as Prisma.InputJsonValue;
  await prisma.scriptDoc.upsert({
    where: { id: script.id },
    update: { json },
    create: { id: script.id, json },
  });
};

const pgLoadScript = async (id: string, ownerId: string): Promise<Script | null> => {
  // Ownership hop first (indexed unique scriptId) — a ScriptDoc is never
  // served without a Project the requester can read.
  const owning = await pgLoadBriefByScriptId(id, ownerId);
  if (!owning) return null;
  const doc = await prisma.scriptDoc.findUnique({ where: { id } });
  return doc ? (doc.json as unknown as Script) : null;
};

// ── file backend internals (the original V0 implementation, verbatim) ────────

const fileSaveBrief = async (brief: StoredBrief): Promise<void> => {
  await ensureDir(BRIEFS_DIR);
  await fs.writeFile(
    path.join(BRIEFS_DIR, `${brief.id}.json`),
    JSON.stringify(brief, null, 2),
    "utf-8",
  );
};

const fileLoadBrief = async (id: string, ownerId: string): Promise<StoredBrief | null> => {
  try {
    const raw = await fs.readFile(path.join(BRIEFS_DIR, `${id}.json`), "utf-8");
    const brief = JSON.parse(raw) as StoredBrief;
    // Ownership gate: a brief you don't own reads as "not found".
    if (!ownerMatches(brief.owner_id, ownerId)) return null;
    return brief;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
};

/**
 * Read every brief on disk. PRIVATE — never expose unscoped briefs to a
 * request. Callers must filter by owner (see listBriefsByOwner /
 * loadBriefByScriptId).
 */
const listAllBriefsFile = async (): Promise<StoredBrief[]> => {
  try {
    await ensureDir(BRIEFS_DIR);
    const files = await fs.readdir(BRIEFS_DIR);
    const briefs = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) =>
          JSON.parse(await fs.readFile(path.join(BRIEFS_DIR, f), "utf-8")) as StoredBrief,
        ),
    );
    return briefs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch {
    return [];
  }
};

const fileSaveScript = async (script: Script): Promise<void> => {
  await ensureDir(SCRIPTS_DIR);
  await fs.writeFile(
    path.join(SCRIPTS_DIR, `${script.id}.json`),
    JSON.stringify(script, null, 2),
    "utf-8",
  );
};

const fileLoadScript = async (id: string, ownerId: string): Promise<Script | null> => {
  // A script is reachable only through a brief the requester owns — scripts
  // carry no owner of their own, so we resolve ownership via the linking brief.
  const owningBrief = await loadBriefByScriptId(id, ownerId);
  if (!owningBrief) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(SCRIPTS_DIR, `${id}.json`), "utf-8");
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err; // genuine fs error (EACCES, etc.) — surface it
  }
  try {
    return JSON.parse(raw) as Script;
  } catch {
    // Corrupt/truncated on-disk script (a crash mid non-atomic write leaves a
    // partial file). Treat as unusable → null, honoring loadScript's
    // resolve-or-null contract that every caller assumes.
    console.warn(`[store] loadScript(${id}): corrupt JSON on disk — treating as missing`);
    return null;
  }
};

// ── public API (backend-dispatched; signatures unchanged) ─────────────────────

export const saveBrief = async (brief: StoredBrief): Promise<void> =>
  backend() === "pg" ? pgSaveBrief(brief) : fileSaveBrief(brief);

export const loadBrief = async (
  id: string,
  ownerId: string,
): Promise<StoredBrief | null> => {
  if (!isValidId(id)) return null;
  return backend() === "pg" ? pgLoadBrief(id, ownerId) : fileLoadBrief(id, ownerId);
};

/** Briefs owned by `ownerId`, newest first. The only public list path. */
export const listBriefsByOwner = async (ownerId: string): Promise<StoredBrief[]> => {
  if (backend() === "pg") return pgListBriefsByOwner(ownerId);
  const all = await listAllBriefsFile();
  return all.filter((b) => b.owner_id === ownerId);
};

/**
 * Persist a Script. Pass `ownerId` (the account, not the script's placeholder
 * customer_id) so the pg backend can refuse a post-deletion resurrection write
 * when the owner is gone — see pgSaveScript. Omit only where there is no owner
 * (file backend / tests).
 */
export const saveScript = async (script: Script, ownerId?: string): Promise<void> =>
  backend() === "pg" ? pgSaveScript(script, ownerId) : fileSaveScript(script);

/**
 * Find the StoredBrief whose script_id matches the given scriptId.
 * Used by the preview-page regenerate flow to recover brand context
 * (extract, files, kit URL) from a scriptId alone.
 *
 * Returns null when no brief points at this script.
 */
export const loadBriefByScriptId = async (
  scriptId: string,
  ownerId: string,
): Promise<StoredBrief | null> => {
  if (backend() === "pg") return pgLoadBriefByScriptId(scriptId, ownerId);
  const all = await listAllBriefsFile();
  return (
    all.find((b) => b.script_id === scriptId && ownerMatches(b.owner_id, ownerId)) ?? null
  );
};

export const loadScript = async (id: string, ownerId: string): Promise<Script | null> => {
  if (!isValidId(id)) return null;
  return backend() === "pg" ? pgLoadScript(id, ownerId) : fileLoadScript(id, ownerId);
};
