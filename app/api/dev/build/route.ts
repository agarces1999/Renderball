import { NextResponse } from "next/server";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { runPreviewBuild } from "../../../../lib/render/run-preview-build";
import { runBuildLocked } from "../../../../lib/render/build-lock";

/**
 * Dev-only build route — the headless counterpart to /api/preview/build.
 *
 * The validation loop (scripts/loop/*) runs without a Clerk session, so it
 * cannot reach /api/preview/* (the auth middleware blocks it with a 404 before
 * the route even runs). This route is under /api/dev/*, which the middleware
 * intentionally excludes, and it carries its own NODE_ENV gate (404 in prod).
 * It loads the script under DEV_OWNER_ID — the same owner /api/dev/generate
 * writes under — and runs the EXACT same gated pipeline as the product route,
 * so the loop validates what users actually ship.
 *
 * POST body: { scriptId: string } → { ok: true, scriptId, usage, ... }
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
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

  // Dedup lock: a harness whose HTTP client died (the undici 300s headersTimeout
  // incident) can re-POST the SAME scriptId and ATTACH to the in-flight build
  // instead of double-spending. We deliberately DO NOT pass the per-owner busy
  // guard here (unlike the product route): all dev builds share DEV_OWNER_ID, so
  // the guard would 409 every concurrent dev build — including the loop's
  // client-death retry, which regenerates a NEW scriptId and would then be
  // wrongly rejected as "owner busy". The owner guard only exists to close the
  // entitlement TOCTOU, and metering no-ops for DEV_OWNER_ID, so it protects
  // nothing in dev. Per-script attach + the global semaphore still apply.
  const locked = await runBuildLocked(scriptId, `${DEV_OWNER_ID}:${scriptId}`, () =>
    runPreviewBuild(scriptId, DEV_OWNER_ID),
  );
  if (locked.kind === "owner-busy") {
    // Unreachable with the per-script owner key above, but keep the shape.
    return NextResponse.json({ error: "build already running for this script" }, { status: 409 });
  }
  const result = locked.result;
  return NextResponse.json(result.body, { status: result.status });
}
