import { NextResponse } from "next/server";
import { ulid } from "../../../../lib/ulid";
import { saveBrief, saveScript, type StoredBrief } from "../../../../lib/store";
import { generateScript } from "../../../../lib/agents/script-generator";
import { extractBrand } from "../../../../lib/crawl/extract-brand";
import type { BrandExtract } from "../../../new/schema";

/**
 * Dev-only route: prompt + url → brief + script (auto mode). Mirrors the
 * auto path of app/new/actions.ts `submitBrief` but driven by JSON so a
 * batch runner can create scripts without the wizard.
 *
 * POST body:
 *   { prompt, url?, distribution_format?, duration_seconds?, moment_count?, verified_claims? }
 * Returns: { ok: true, briefId, scriptId } | { ok: false, error, briefId? }
 *
 * After this, POST /api/preview/build { scriptId } builds the composition,
 * then /preview/<scriptId> is the viewable preview.
 */
export const maxDuration = 300;

type DistributionFormat = "mobile-feed" | "square" | "landscape";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  let body: {
    prompt?: string;
    url?: string;
    distribution_format?: DistributionFormat;
    duration_seconds?: number;
    moment_count?: number;
    verified_claims?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: "prompt required" }, { status: 400 });
  }

  const duration = body.duration_seconds ?? 30;
  const momentCount = body.moment_count ?? 5;
  const distribution_format = body.distribution_format ?? "landscape";

  // Best-effort crawl. Failure degrades to prompt-only (same as the wizard).
  let extract: BrandExtract | undefined;
  if (body.url?.trim()) {
    try {
      extract = await extractBrand(body.url.trim());
    } catch {
      extract = undefined;
    }
  }
  const brandExtract = extract?.ok ? extract : undefined;
  const preallocated = buildPreallocatedFromCrawl(brandExtract);

  const brief_id = ulid();
  const baseBrief: StoredBrief = {
    id: brief_id,
    purpose: "",
    duration_seconds: duration,
    distribution_format,
    moments: [],
    cta: "",
    brand_kit_url: body.url?.trim() || undefined,
    verified_claims: body.verified_claims?.trim() || undefined,
    brand_extract: brandExtract,
    created_at: new Date().toISOString(),
    status: "awaiting_agent_1",
  };
  await saveBrief(baseBrief);

  const result = await generateScript(
    {
      duration_seconds: duration,
      distribution_format,
      moment_count: momentCount,
      brand_kit_url: baseBrief.brand_kit_url,
      verified_claims: baseBrief.verified_claims,
      brand_extract: brandExtract,
      preallocated_assets: preallocated,
      freeform_prompt: prompt,
    },
    brief_id,
  );

  if (!result.ok) {
    await saveBrief({ ...baseBrief, status: "failed", error: result.error });
    return NextResponse.json(
      { ok: false, error: result.error, briefId: brief_id },
      { status: 200 },
    );
  }

  await saveScript(result.script);
  await saveBrief({
    ...baseBrief,
    status: "script_generated",
    script_id: result.script.id,
    purpose: result.script.brief.purpose,
    cta: result.script.brief.cta,
    moments: result.script.scenes.map((s) => ({
      title: s.label,
      description: s.description ?? s.label,
      creativity: "balanced" as const,
    })),
  });

  return NextResponse.json({
    ok: true,
    briefId: brief_id,
    scriptId: result.script.id,
    aspect: result.script.config.aspect_ratio,
    scenes: result.script.scenes.length,
  });
}

/**
 * Crawl-only slice of app/new/actions.ts buildPreallocatedAssets — the
 * branch that runs when there are no user uploads. Surfaces the brand's
 * logo / og image / page images to the agents as preallocated assets.
 */
const buildPreallocatedFromCrawl = (
  brandExtract: BrandExtract | undefined,
): Array<{
  id: string;
  url: string;
  mime: string;
  source: "upload" | "crawl";
  label: string;
}> => {
  const out: Array<{
    id: string;
    url: string;
    mime: string;
    source: "upload" | "crawl";
    label: string;
  }> = [];
  if (!brandExtract?.ok) return out;

  if (brandExtract.logo_hd) {
    out.push({
      id: "site_logo",
      url: brandExtract.logo_hd,
      mime: brandExtract.logo_hd.endsWith(".svg") ? "image/svg+xml" : "image/png",
      source: "crawl",
      label: "site logo (HD — preferred over favicon for opening/closing)",
    });
  } else if (brandExtract.apple_touch_icon) {
    out.push({
      id: "site_logo",
      url: brandExtract.apple_touch_icon,
      mime: "image/png",
      source: "crawl",
      label: "site apple-touch-icon (medium-res brand mark)",
    });
  } else if (brandExtract.favicon) {
    out.push({
      id: "site_logo",
      url: brandExtract.favicon,
      mime: "image/x-icon",
      source: "crawl",
      label: "site favicon (low-res; only logo available)",
    });
  }
  if (brandExtract.og_image) {
    out.push({
      id: "site_og_image",
      url: brandExtract.og_image,
      mime: "image/png",
      source: "crawl",
      label: "site OG image (hero / share image)",
    });
  }
  if (brandExtract.page_images) {
    brandExtract.page_images.slice(0, 6).forEach((img, i) => {
      const ext =
        img.src.match(/\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i)?.[1]?.toLowerCase() ?? "";
      const mime =
        ext === "svg"
          ? "image/svg+xml"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : ext === "gif"
                ? "image/gif"
                : ext === "avif"
                  ? "image/avif"
                  : "image/png";
      out.push({
        id: `site_img_${i}`,
        url: img.src,
        mime,
        source: "crawl",
        label: img.alt ? `site image: ${img.alt}` : `site image #${i + 1}`,
      });
    });
  }
  return out;
};
