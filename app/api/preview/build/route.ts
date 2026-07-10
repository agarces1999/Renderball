import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId } from "../../../../lib/store";
import { brandKitStatus } from "../../../../lib/brand-kit";
import { checkEntitlement } from "../../../../lib/entitlement";
import { runPreviewBuild } from "../../../../lib/render/run-preview-build";
import { runBuildLocked } from "../../../../lib/render/build-lock";

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

  // Build lock (launch audit P0): dedup same-script requests (a page refresh
  // ATTACHES to the in-flight build instead of double-building), one build per
  // owner (closes the entitlement TOCTOU — usage rows land only at build end),
  // and a global per-container semaphore. The entitlement check runs INSIDE
  // the lock so parallel requests can't all pass the quota gate first.
  const locked = await runBuildLocked(scriptId, user.id, async () => {
    // Metering gate (LAUNCH.md #4) — fail-closed entitlement check BEFORE the
    // ~$1-2 of build spend. 402 carries a user-facing reason.
    const ent = await checkEntitlement(user.id, "build");
    if (!ent.allowed) {
      return {
        status: 402,
        body: { error: ent.reason ?? "plan limit reached", plan: ent.plan, used: ent.used, limit: ent.limit },
      } as const;
    }
    return runPreviewBuild(scriptId, user.id);
  });
  if (locked.kind === "owner-busy") {
    return NextResponse.json(
      { error: "You already have a build running — it will finish in a few minutes. One build runs at a time per account." },
      { status: 409 },
    );
  }
  const result = locked.result;
  return NextResponse.json(result.body, { status: result.status });
}
