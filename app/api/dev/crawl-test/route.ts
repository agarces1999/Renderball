import { NextResponse } from "next/server";
import { extractBrand } from "../../../../lib/crawl/extract-brand";

/**
 * Dev-only: time the crawl + return the fields the new extractor pulls.
 * GET /api/dev/crawl-test?url=stripe.com
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }
  const url = new URL(request.url).searchParams.get("url");
  if (!url) {
    return NextResponse.json(
      { error: "url query param required" },
      { status: 400 },
    );
  }

  const t0 = performance.now();
  const extract = await extractBrand(url);
  const elapsed_ms = Math.round(performance.now() - t0);

  return NextResponse.json({
    elapsed_ms,
    ok: extract.ok,
    error: extract.error,
    fields: {
      title: extract.title,
      theme_color: extract.theme_color,
      palette_count: extract.palette?.length ?? 0,
      palette: extract.palette,
      background_color: extract.background_color,
      font_count: extract.fonts?.length ?? 0,
      font_families: extract.fonts?.map((f) => f.family),
      font_urls: extract.fonts?.map((f) => f.src),
      motion_signal: extract.motion_signal,
      headline_count: extract.headlines?.length ?? 0,
      logo_hd: extract.logo_hd?.slice(0, 90),
      logo_hd_len: extract.logo_hd?.length,
      logo_source: extract.logo_source,
      logo_confidence: extract.logo_confidence,
    },
  });
}
