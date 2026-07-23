import { NextResponse } from "next/server";
import { loadScript } from "../../../../../lib/store";
import { getCurrentUser } from "../../../../../lib/auth";
import { exportDeckPdf, exportPagePng } from "../../../../../lib/render/export-static";

/**
 * Static export of a generated document (canvas pivot, docs/PIVOT.md).
 * Deterministic — zero LLM calls, zero spend, so no entitlement gate; auth +
 * ownership only (same pattern as the iframe route).
 *
 * GET /api/preview/<scriptId>/export?format=pdf          → whole document as PDF
 * GET /api/preview/<scriptId>/export?format=png&scene=N  → one page as PNG
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  const scriptId = params.id;
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "pdf";

  const script = await loadScript(scriptId, user.id);
  if (!script) return new NextResponse(`script not found: ${scriptId}`, { status: 404 });

  const result =
    format === "png"
      ? await exportPagePng(scriptId, script, parseInt(url.searchParams.get("scene") ?? "0", 10))
      : format === "pdf"
        ? await exportDeckPdf(scriptId, script)
        : null;
  if (result === null) {
    return new NextResponse(`unknown format "${format}" — use pdf or png`, { status: 400 });
  }
  if (!result.ok) return new NextResponse(result.message, { status: result.status });

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
