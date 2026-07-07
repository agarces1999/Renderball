import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId } from "../../../../lib/store";
import { brandKitStatus } from "../../../../lib/brand-kit";
import { runPreviewBuild } from "../../../../lib/render/run-preview-build";

/**
 * Preview-only build endpoint. Runs the Design + Choreography agents and the
 * full gated pipeline (SSR → render-truth → advisory vision), writing the
 * generated React/CSS to `src/generated/<scriptId>/` — the preview IS the MP4,
 * so the "Render to MP4 →" path reuses this exact composition.
 *
 * The pipeline body lives in lib/render/run-preview-build.ts, shared with the
 * dev-only /api/dev/build (the headless validation loop). This route owns auth;
 * that one owns the dev gate. Both run identical, gated builds — no drift.
 *
 * POST body: { scriptId: string } → { ok: true, scriptId, usage, ... }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { scriptId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }

  // Brand-kit gate (defense in depth — submitBrief enforces this at creation;
  // this re-check covers legacy briefs and any future path that skips /new).
  // Legacy briefs (created before the gate: no logo_source, no colors flag,
  // no is_logo file) are exempt so existing projects keep building.
  const brief = await loadBriefByScriptId(scriptId, user.id);
  const isLegacyBrief =
    !!brief &&
    brief.logo_source === undefined &&
    brief.colors_confirmed === undefined &&
    !(brief.brand_files ?? []).some((f) => f.is_logo);
  if (brief && !isLegacyBrief) {
    const kit = brandKitStatus(brief);
    if (!kit.ready) {
      return NextResponse.json(
        { error: `brand kit incomplete — missing: ${kit.missing.join("; ")}` },
        { status: 422 },
      );
    }
  }

  const result = await runPreviewBuild(scriptId, user.id);
  return NextResponse.json(result.body, { status: result.status });
}
