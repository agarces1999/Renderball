import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId } from "../../../../lib/store";
import { brandKitStatus } from "../../../../lib/brand-kit";
import { checkEntitlement } from "../../../../lib/entitlement";
import { checkTokenAllowance } from "../../../../lib/metering";
import { runPreviewBuild } from "../../../../lib/render/run-preview-build";
import { runBuildLocked } from "../../../../lib/render/build-lock";
import { buildStatus, startBuild } from "../../../../lib/render/build-jobs";

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
  const started = await startBuild(scriptId, async () => {
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
    // Token allowance (pivot pricing, RB_METERING): a build is the biggest
    // single token spend, so it MUST clear the 1M-free / billing-active gate.
    const gate = await checkTokenAllowance(user.id);
    if (!gate.allowed) {
      return {
        status: 402,
        body: {
          error: gate.reason ?? "token allowance exhausted",
          usedTokens: gate.usedTokens,
          freeTokens: gate.freeTokens,
          billingActive: gate.billingActive,
        },
      } as const;
    }
      return runPreviewBuild(scriptId, user.id);
    });
    if (locked.kind === "owner-busy") {
      return {
        status: 409,
        body: {
          error:
            "You already have a build running — it will finish in a few minutes. One build runs at a time per account.",
        },
      };
    }
    return locked.result;
  });

  // Settled inside the grace window: a gate rejection (402), owner-busy (409),
  // or a build that failed immediately. Hand it straight back.
  if (started.kind === "settled") {
    return NextResponse.json(started.body, { status: started.status });
  }

  // Still running. Builds take minutes and the origin sits behind Cloudflare's
  // 100s timeout, so holding the request open guarantees a 524 for every
  // build. Return now and let the client poll GET below.
  return NextResponse.json({ status: "running", scriptId }, { status: 202 });
}

/**
 * Poll a build's state. Returns 200 with {status} throughout; the build's own
 * result body (including a 402/409 recorded after the grace window) rides
 * along on completion so the client can surface it exactly as before.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  // Ownership: never report another account's build state.
  const owned = await loadBriefByScriptId(scriptId, user.id);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = buildStatus(scriptId);
  if (job.state === "done") {
    return NextResponse.json({ status: "done", result: job.body, resultStatus: job.status });
  }
  if (job.state === "error") {
    return NextResponse.json({ status: "error", error: job.message });
  }
  // "unknown" after a container restart is not a failure — the client reloads
  // and the page decides from whether the document actually exists.
  return NextResponse.json({ status: job.state });
}
