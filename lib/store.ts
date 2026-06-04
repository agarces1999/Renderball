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

export const saveBrief = async (brief: StoredBrief): Promise<void> => {
  await ensureDir(BRIEFS_DIR);
  await fs.writeFile(
    path.join(BRIEFS_DIR, `${brief.id}.json`),
    JSON.stringify(brief, null, 2),
    "utf-8",
  );
};

export const loadBrief = async (id: string): Promise<StoredBrief | null> => {
  try {
    const raw = await fs.readFile(
      path.join(BRIEFS_DIR, `${id}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as StoredBrief;
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

export const listBriefs = async (): Promise<StoredBrief[]> => {
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
): Promise<StoredBrief | null> => {
  const all = await listBriefs();
  return all.find((b) => b.script_id === scriptId) ?? null;
};

export const loadScript = async (id: string): Promise<Script | null> => {
  try {
    const raw = await fs.readFile(
      path.join(SCRIPTS_DIR, `${id}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as Script;
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
