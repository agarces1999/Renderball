import { NextResponse } from "next/server";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import { runPreviewBuild } from "../../../../lib/render/run-preview-build";

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

  const result = await runPreviewBuild(scriptId, DEV_OWNER_ID);
  return NextResponse.json(result.body, { status: result.status });
}
