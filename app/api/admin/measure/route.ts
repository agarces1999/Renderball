import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { isAdminConfigured, isAdminUser } from "../../../../lib/admin";
import { loadScript } from "../../../../lib/store";
import { prisma } from "../../../../lib/db";
import { hydrateGenDir, documentDir } from "../../../../lib/render/gen-store";
import { measureScenes } from "../../../../lib/render/measure-scene";
import { findRenderTruthFailures, measureOutDir } from "../../../../lib/render/render-truth-gates";

export const maxDuration = 300;

/**
 * THE DIAGNOSTIC EYE (2026-08-14). Runs the REAL measurement battery on the
 * REAL production container for one stored document and reports exactly what
 * this environment sees — because a deck the prod ladder exhausted on
 * measures clean on every machine we can reach (macOS + the exact playwright
 * Linux image, fonts on/off), and the backward evidence (container-local
 * timeline, .render-truth artifacts) died with the ephemeral filesystem.
 * Founder: "it's unacceptable that you just don't know why it mis-measures,
 * we must find out." This route is how we find out: same bytes, prod's own
 * chromium, prod's own network, prod's own answer — comparable line by line
 * with a local run of the same script.
 *
 * Admin-gated (same allowlist as /api/admin/spend), read-only with respect to
 * the document (measurement writes only its own .render-truth scratch), zero
 * model calls.
 *
 * GET /api/admin/measure?scriptId=… →
 *   { env, scenes: [{ scene, elements, fit, fontFailures, fitSettled,
 *      maxRight, maxBottom, error }], findings, blocking }
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdminUser(user)) {
    return NextResponse.json(
      { error: "not an admin", allowlistConfigured: isAdminConfigured() },
      { status: 403 },
    );
  }

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  // Admin diagnostics may inspect any document — the allowlist is the
  // boundary. loadScript is owner-scoped, so resolve the owner first.
  const project = await prisma.project.findFirst({
    where: { scriptId },
    select: { ownerId: true },
  });
  if (!project) return NextResponse.json({ error: "script not found" }, { status: 404 });
  const script = await loadScript(scriptId, project.ownerId);
  if (!script) return NextResponse.json({ error: "script not found" }, { status: 404 });

  await hydrateGenDir(scriptId);
  const genDir = await documentDir(scriptId);

  const t0 = Date.now();
  const measurements = await measureScenes(genDir, script, measureOutDir(genDir));
  const gate = await findRenderTruthFailures(measurements, {});

  return NextResponse.json({
    env: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      chromium: measurements.find((m) => m.browserVersion)?.browserVersion ?? "unknown",
      measureMs: Date.now() - t0,
    },
    scenes: measurements.map((m) => ({
      scene: m.scene,
      elements: m.elements.length,
      fit: m.fit ?? null,
      fontFailures: m.fontFailures ?? [],
      fitSettled: m.fitSettled ?? null,
      // The overflow signature without shipping every rect: how far the
      // farthest element reaches. A local run of the same deck prints the
      // same two numbers; divergence localizes the mechanism.
      maxRight: Math.max(0, ...m.elements.map((e) => e.x + e.w)),
      maxBottom: Math.max(0, ...m.elements.map((e) => e.y + e.h)),
      error: m.error ?? null,
    })),
    findings: gate.findings.map((f) => ({ scene: f.scene, kind: f.kind, detail: f.detail.slice(0, 160) })),
    blocking: gate.blocking.map((f) => ({ scene: f.scene, kind: f.kind })),
  });
}
