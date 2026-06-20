import { NextResponse } from "next/server";
import { loadBrief, saveBrief, saveScript } from "../../../../lib/store";
import { DEV_OWNER_ID } from "../../../../lib/auth";
import {
  generateScript,
  type AgentBrief,
} from "../../../../lib/agents/script-generator";
import { extractBrand } from "../../../../lib/crawl/extract-brand";

/**
 * Dev-only route: re-run Agent 1 against an existing brief using the
 * CURRENT system prompt. Updates the brief's script_id to point at
 * the new script. Used to verify prompt changes against past briefs.
 *
 * GET /api/dev/regenerate?briefId=<id>
 *
 * Returns the new script id and a summary of visual_concepts so we
 * can eyeball the output without paging through full JSON.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  const url = new URL(request.url);
  const briefId = url.searchParams.get("briefId");
  if (!briefId) {
    return NextResponse.json(
      { error: "briefId query param required" },
      { status: 400 },
    );
  }

  const brief = await loadBrief(briefId, DEV_OWNER_ID);
  if (!brief) {
    return NextResponse.json({ error: "brief not found" }, { status: 404 });
  }

  let brand_extract;
  if (brief.brand_kit_url) {
    try {
      brand_extract = await extractBrand(brief.brand_kit_url);
    } catch {
      brand_extract = undefined;
    }
  }

  // Cache the fresh crawl on the brief so subsequent Agent 2 invocations see it.
  if (brand_extract?.ok) {
    brief.brand_extract = brand_extract;
  }

  const preallocated_assets = brand_extract?.ok
    ? buildPreallocatedAssets(brand_extract)
    : [];

  const agentBrief: AgentBrief = {
    duration_seconds: brief.duration_seconds,
    moment_count: brief.moments.length,
    brand_kit_url: brief.brand_kit_url,
    brand_files: brief.brand_files?.map((f) => ({
      name: f.name,
      url: f.url,
      mime: f.mime,
    })),
    verified_claims: brief.verified_claims,
    brand_extract,
    preallocated_assets,
    purpose: brief.purpose,
    cta: brief.cta,
    moments: brief.moments.map((m) => ({
      title: m.title,
      description: m.description,
      creativity: m.creativity,
    })),
  };

  const result = await generateScript(agentBrief, brief.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  await saveScript(result.script);
  brief.script_id = result.script.id;
  brief.status = "script_generated";
  await saveBrief(brief);

  return NextResponse.json({
    ok: true,
    brief_id: brief.id,
    script_id: result.script.id,
    usage: result.usage,
    scenes: result.script.scenes.map((s) => ({
      label: s.label,
      description: s.description,
      visual_concept: s.visual_concept,
      texts: s.content?.texts ?? [],
      asset_ids: s.content?.asset_ids ?? [],
      has_legacy_elements: Array.isArray(
        (s as unknown as { elements?: unknown[] }).elements,
      ),
    })),
  });
}

function buildPreallocatedAssets(brand_extract: {
  favicon?: string;
  apple_touch_icon?: string;
  og_image?: string;
  logo_hd?: string;
  page_images?: { src: string; alt?: string }[];
}) {
  const assets: Array<{
    id: string;
    url: string;
    mime: string;
    source: "crawl";
    label: string;
  }> = [];
  // Prefer HD logo. Falls back to apple-touch-icon, then favicon.
  if (brand_extract.logo_hd) {
    assets.push({
      id: "site_logo",
      url: brand_extract.logo_hd,
      mime: brand_extract.logo_hd.endsWith(".svg") ? "image/svg+xml" : "image/png",
      source: "crawl",
      label: "Site logo (HD)",
    });
  } else if (brand_extract.apple_touch_icon) {
    assets.push({
      id: "site_logo",
      url: brand_extract.apple_touch_icon,
      mime: "image/png",
      source: "crawl",
      label: "Site apple-touch-icon (medium-res brand mark)",
    });
  } else if (brand_extract.favicon) {
    assets.push({
      id: "site_logo",
      url: brand_extract.favicon,
      mime: brand_extract.favicon.endsWith(".svg") ? "image/svg+xml" : "image/x-icon",
      source: "crawl",
      label: "Site favicon (low-res)",
    });
  }
  if (brand_extract.og_image) {
    assets.push({
      id: "site_og_image",
      url: brand_extract.og_image,
      mime: "image/jpeg",
      source: "crawl",
      label: "Site og:image (hero)",
    });
  }
  if (brand_extract.page_images) {
    brand_extract.page_images.slice(0, 6).forEach((img, i) => {
      const ext = img.src.match(/\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i)?.[1]?.toLowerCase() ?? "";
      const mime = ext === "svg" ? "image/svg+xml"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "gif" ? "image/gif"
        : ext === "avif" ? "image/avif"
        : "image/png";
      assets.push({
        id: `site_img_${i}`,
        url: img.src,
        mime,
        source: "crawl",
        label: img.alt ? `Site image: ${img.alt}` : `Site image #${i + 1}`,
      });
    });
  }
  return assets;
}
