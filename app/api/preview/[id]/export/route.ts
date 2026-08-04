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
    return NextResponse.json({ error: `unknown format "${format}" — use pdf or png` }, { status: 400 });
  }
  if (!result.ok) {
    // The renderer's message is wire truth ("Playwright timed out …") — log it
    // here, say something a person can act on in the response.
    console.error(`[export] ${format} failed for ${scriptId}: ${result.message}`);
    return NextResponse.json(
      { error: "The export didn't finish — try again in a moment. If it keeps failing, email support@renderball.com." },
      { status: result.status },
    );
  }

  // Files are named after the DECK, not its database id — "q3-investor-update.pdf"
  // is a file someone can find again; a 26-character ULID is not.
  const ext = result.filename.split(".").pop() ?? (format === "png" ? "png" : "pdf");
  const slug = (script.brief?.purpose ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  const filename = `${slug || "renderball-deck"}.${ext}`;

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
