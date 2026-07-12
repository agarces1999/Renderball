"use server";

import { saveScript, loadBriefByScriptId } from "../../../lib/store";
import { getCurrentUser } from "../../../lib/auth";
import type { Script } from "../../../src/schema";

/**
 * Stage 2 server actions — edit persistence.
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
    await saveScript(script, user.id);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
