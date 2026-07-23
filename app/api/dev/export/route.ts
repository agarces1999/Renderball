import { NextResponse } from "next/server";
import { loadScript, DEV_OWNER_ID } from "../../../../lib/store";
import { exportDeckPdf, exportPagePng } from "../../../../lib/render/export-static";

/**
 * Dev-only static export — headless counterpart to /api/preview/[id]/export
 * (no Clerk session). NODE_ENV-gated (404 in prod). Used by the offline
 * validation loop to prove PDF/PNG export against stored builds at $0.
 *
 * GET ?scriptId=…&format=pdf          → whole document as PDF
 * GET ?scriptId=…&format=png&scene=N  → one page as PNG
 */
const devOnly = (): NextResponse | null =>
  process.env.NODE_ENV === "production" ? NextResponse.json({ error: "dev-only" }, { status: 404 }) : null;

export async function GET(request: Request) {
  const gate = devOnly();
  if (gate) return gate;

  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  const format = url.searchParams.get("format") ?? "pdf";

  const script = await loadScript(scriptId, DEV_OWNER_ID);
  if (!script) return NextResponse.json({ error: `script not found: ${scriptId}` }, { status: 404 });

  const result =
    format === "png"
      ? await exportPagePng(scriptId, script, parseInt(url.searchParams.get("scene") ?? "0", 10))
      : format === "pdf"
        ? await exportDeckPdf(scriptId, script)
        : null;
  if (result === null) {
    return NextResponse.json({ error: `unknown format "${format}" — use pdf or png` }, { status: 400 });
  }
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status });

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
