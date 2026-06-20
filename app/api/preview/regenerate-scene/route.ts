import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  loadScript,
  loadBriefByScriptId,
  saveScript,
} from "../../../../lib/store";
import { getCurrentUser } from "../../../../lib/auth";
import {
  regenerateScene,
  buildAgentInputFromBrief,
} from "../../../../lib/agents/pipeline";

/**
 * Per-scene regenerate endpoint backing the /preview/[id] page's
 * "Regenerate scene N" button.
 *
 * POST body: { scriptId: string, sceneIndex: number, instruction?: string }
 *
 * Flow:
 *   1. Load the script + the brief that points at it (for brand context).
 *   2. Read the existing src/generated/<id>/Composition.tsx.
 *   3. Re-run Design + Choreography agents for one scene only.
 *   4. Overwrite Composition.tsx + Composition.design.tsx on disk.
 *   5. Mark the scene with `regenerated_at` so the next MP4 render
 *      uses the latest version.
 *
 * The Preview client reloads the page on success so webpack re-imports
 * the updated module.
 */
export async function POST(request: Request) {
  // Dev-only gate matches the existing /api/dev/* pattern.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { scriptId?: string; sceneIndex?: number; instruction?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const { scriptId, sceneIndex, instruction } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json(
      { error: "scriptId required" },
      { status: 400 },
    );
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json(
      { error: "sceneIndex must be a non-negative number" },
      { status: 400 },
    );
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json(
      {
        error: `sceneIndex ${sceneIndex} out of range (script has ${script.scenes.length} scenes)`,
      },
      { status: 400 },
    );
  }

  const brief = await loadBriefByScriptId(scriptId, user.id);
  // brief is optional — if not found we still try with empty brand context.

  const generatedDir = path.join(
    process.cwd(),
    "src",
    "generated",
    scriptId,
  );
  const compPath = path.join(generatedDir, "Composition.tsx");
  let existingCode: string;
  try {
    existingCode = await fs.readFile(compPath, "utf-8");
  } catch (err) {
    return NextResponse.json(
      {
        error: `Composition.tsx not found at ${compPath}. Run the full build pass first via the review page.`,
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 404 },
    );
  }

  const result = await regenerateScene(
    buildAgentInputFromBrief(brief, script),
    existingCode,
    sceneIndex,
    instruction,
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, stage: result.stage },
      { status: 500 },
    );
  }

  // Write the updated files back to disk.
  await fs.writeFile(compPath, result.code, "utf-8");
  await fs.writeFile(
    path.join(generatedDir, "Composition.design.tsx"),
    result.designCode,
    "utf-8",
  );

  // Mark scene as regenerated so downstream code can track freshness.
  (script.scenes[sceneIndex] as unknown as Record<string, string>).regenerated_at =
    new Date().toISOString();
  await saveScript(script);

  return NextResponse.json({
    ok: true,
    scriptId,
    sceneIndex,
    usage: result.usage,
    warnings: result.warnings,
  });
}
