"use server";

import path from "path";
import { promises as fs } from "fs";
import { saveScript, loadBrief, loadBriefByScriptId } from "../../../lib/store";
import { getCurrentUser } from "../../../lib/auth";
import type { Script } from "../../../src/schema";
import { renderBriefToMp4 } from "../../../lib/render/render-brief";

/**
 * Stage 2 server actions — edit persistence + MP4 render.
 *
 * The render flow lives entirely in lib/render/render-brief.ts now;
 * this file just loads the brief + script and delegates.
 */

export async function saveScriptEdits(
  script: Script,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Please sign in." };
    // Only the owner of the brief that links this script may edit it.
    const brief = await loadBriefByScriptId(script.id, user.id);
    if (!brief) return { ok: false, error: "Script not found." };
    await saveScript(script);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Full Agent 2 → bundle → renderMedia pipeline. Loads the brief +
 * script from disk and delegates to renderBriefToMp4.
 */
export async function renderScriptToMp4(
  briefId: string,
): Promise<
  | { ok: true; url: string }
  | { ok: false; error: string; stage?: string }
> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Please sign in." };
    const brief = await loadBrief(briefId, user.id);
    if (!brief?.script_id) {
      return { ok: false, error: "No script attached to this brief." };
    }
    const scriptPath = path.join(
      process.cwd(),
      ".data",
      "scripts",
      `${brief.script_id}.json`,
    );
    const script = JSON.parse(
      await fs.readFile(scriptPath, "utf-8"),
    ) as Script;
    return await renderBriefToMp4(brief, script);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
