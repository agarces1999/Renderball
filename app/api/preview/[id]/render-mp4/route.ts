import { NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import {
  loadScript,
  loadBriefByScriptId,
} from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import type { Script } from "../../../../../src/schema";
import { renderBriefToMp4 } from "../../../../../lib/render/render-brief";

/**
 * Preview-page "Render to MP4 →" action. The preview page only has a
 * scriptId in the URL — we look up the brief via loadBriefByScriptId
 * and delegate to the shared render path.
 *
 * POST /api/preview/<scriptId>/render-mp4
 * Returns: { ok: true, url: "/renders/<scriptId>.mp4" } on success.
 *
 * The brief lookup is required (not just the script) because Agent 2
 * needs brand context (palette, fonts, og_image, verified_claims).
 * Without a brief the agents fall back to Renderball defaults.
 */
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const scriptId = params.id;
  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  const brief = await loadBriefByScriptId(scriptId, user.id);
  if (!brief?.script_id) {
    return NextResponse.json(
      { error: "no brief found that points at this script" },
      { status: 404 },
    );
  }

  // If a Composition.tsx already exists from the preview build flow,
  // re-load the latest script.json from disk so we render whatever
  // the user has been iterating on.
  const compPath = path.join(
    process.cwd(),
    "src",
    "generated",
    scriptId,
    "script.json",
  );
  let renderScript: Script = script;
  try {
    const onDisk = JSON.parse(
      await fs.readFile(compPath, "utf-8"),
    ) as Script;
    renderScript = onDisk;
  } catch {
    // No on-disk copy — use the stored script (renderBriefToMp4 will
    // re-run the agents and write a fresh one as part of its pass).
  }

  const result = await renderBriefToMp4(brief, renderScript);
  if (!result.ok) {
    return NextResponse.json(
      { error: `${result.stage ?? "render"}: ${result.error}` },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    url: result.url,
    warnings: result.warnings,
  });
}
