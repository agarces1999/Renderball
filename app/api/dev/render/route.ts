import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { loadBrief } from "../../../../lib/store";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import type { Script } from "../../../../src/schema";
import { renderBriefToMp4 } from "../../../../lib/render/render-brief";

/**
 * Dev-only route: run Agent 2 + bundle + render for an existing
 * brief's script. Same pipeline as the Stage 2 "Render" button
 * (app/review/[id]/actions.ts) — both delegate to renderBriefToMp4.
 *
 * Useful for prompt iteration loops via curl without going through
 * the wizard.
 *
 * GET /api/dev/render?briefId=<id>
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  const url = new URL(request.url);
  const briefId = url.searchParams.get("briefId");
  if (!briefId) {
    return NextResponse.json(
      { error: "briefId query param required" },
      { status: 400 },
    );
  }

  const brief = await loadBrief(briefId, DEV_OWNER_ID);
  if (!brief?.script_id) {
    return NextResponse.json(
      { error: "no script attached to brief" },
      { status: 404 },
    );
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

  // disallowRebuild, matching the production export route. Without it this lane
  // silently re-runs the full Agent-2 pipeline on a reuse miss — an unmetered
  // ~$1-2 LLM spend path, and one that renders something OTHER than the
  // composition the preview showed. A stale preview must say so (409), not
  // quietly regenerate.
  const result = await renderBriefToMp4(brief, script, { disallowRebuild: true });
  if (!result.ok) {
    return NextResponse.json(
      { error: `${result.stage ?? "render"}: ${result.error}` },
      { status: result.stage === "stale-preview" ? 409 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    url: result.url,
    script_id: brief.script_id,
    composition_path: `src/generated/${brief.script_id}/Composition.tsx`,
    warnings: result.warnings,
  });
}
