import { promises as fs } from "fs";
import path from "path";
import type { Script } from "../src/schema";
import type { BrandExtract } from "../app/new/schema";

/**
 * Persistence layer — V0 minimum.
 *
 * SQLite was the plan, but for the first agentless cycle a plain JSON
 * file in `.data/` does the job and keeps the surface area zero. We can
 * swap to better-sqlite3 once we have concurrent writes (read: once the
 * agents come online and start writing renders in parallel).
 *
 * Schema:
 *   .data/briefs/<id>.json      Stage 0 input + status
 *   .data/scripts/<id>.json     Stage 1+ generated/edited script
 *   .data/renders/<id>.json     Stage 9 render metadata
 */
const DATA_DIR = path.join(process.cwd(), ".data");
const BRIEFS_DIR = path.join(DATA_DIR, "briefs");
const SCRIPTS_DIR = path.join(DATA_DIR, "scripts");

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

export const saveBrief = async (brief: StoredBrief): Promise<void> => {
  await ensureDir(BRIEFS_DIR);
  await fs.writeFile(
    path.join(BRIEFS_DIR, `${brief.id}.json`),
    JSON.stringify(brief, null, 2),
    "utf-8",
  );
};

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

export const loadBrief = async (
  id: string,
  ownerId: string,
): Promise<StoredBrief | null> => {
  if (!isValidId(id)) return null;
  try {
    const raw = await fs.readFile(
      path.join(BRIEFS_DIR, `${id}.json`),
      "utf-8",
    );
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
const listAllBriefs = async (): Promise<StoredBrief[]> => {
  try {
    await ensureDir(BRIEFS_DIR);
    const files = await fs.readdir(BRIEFS_DIR);
    const briefs = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) =>
          JSON.parse(
            await fs.readFile(path.join(BRIEFS_DIR, f), "utf-8"),
          ) as StoredBrief,
        ),
    );
    return briefs.sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  } catch {
    return [];
  }
};

/** Briefs owned by `ownerId`, newest first. The only public list path. */
export const listBriefsByOwner = async (
  ownerId: string,
): Promise<StoredBrief[]> => {
  const all = await listAllBriefs();
  return all.filter((b) => b.owner_id === ownerId);
};

export const saveScript = async (script: Script): Promise<void> => {
  await ensureDir(SCRIPTS_DIR);
  await fs.writeFile(
    path.join(SCRIPTS_DIR, `${script.id}.json`),
    JSON.stringify(script, null, 2),
    "utf-8",
  );
};

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
  const all = await listAllBriefs();
  return (
    all.find((b) => b.script_id === scriptId && ownerMatches(b.owner_id, ownerId)) ?? null
  );
};

export const loadScript = async (
  id: string,
  ownerId: string,
): Promise<Script | null> => {
  if (!isValidId(id)) return null;
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
    // resolve-or-null contract that every caller assumes. The build route maps
    // null → a clean 404, rather than letting a SyntaxError escape uncaught and
    // 500 the endpoint on a corrupt-input edge case.
    console.warn(`[store] loadScript(${id}): corrupt JSON on disk — treating as missing`);
    return null;
  }
};
