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

  // Same dedup lock as the product route: a harness whose HTTP client died
  // (the undici 300s headersTimeout incident) can re-POST and ATTACH to the
  // in-flight build instead of silently starting a second, double-spending one.
  const locked = await runBuildLocked(scriptId, DEV_OWNER_ID, () =>
    runPreviewBuild(scriptId, DEV_OWNER_ID),
  );
  if (locked.kind === "owner-busy") {
    return NextResponse.json(
      { error: "another dev build is already running for a different script" },
      { status: 409 },
    );
  }
  const result = locked.result;
  return NextResponse.json(result.body, { status: result.status });
}
