"use server";

import { ulid } from "../../lib/ulid";
import { getCurrentUser } from "../../lib/auth";
import { saveBrief, saveScript, type StoredBrief } from "../../lib/store";
import { generateScript, DECK_SECONDS_PER_SLIDE } from "../../lib/agents/script-generator";
import { saveBriefFiles } from "../../lib/uploads";
import { brandKitStatus } from "../../lib/brand-kit";
import { checkEntitlement, recordMeteredUsage } from "../../lib/entitlement";
import { assertZaiAvailable, ZaiUnavailableError } from "../../lib/zai-breaker";
import { extractBrand } from "../../lib/crawl/extract-brand";
import { withDbRetry } from "../../lib/db";
import { recordUsage, addUsage, EMPTY_USAGE, type Usage } from "../../lib/usage";

/** "NeueMontreal-Medium.woff2" → "Neue Montreal Medium" — a readable family
 *  name when the user didn't type one. */
const fontFamilyFromFilename = (name: string): string =>
  name
    .replace(/\.(woff2?|ttf|otf)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Brand Font";
import type {
  BrandExtract,
  BriefInput,
  CreativityLevel,
  UploadedFileRef,
} from "./schema";
import {
  maxMomentsForDuration,
  SECONDS_PER_MOMENT_FLOOR,
} from "./schema";

export type {
  BrandExtract,
  BriefInput,
  MomentInput,
  CreativityLevel,
  UploadedFileRef,
} from "./schema";

/**
 * Fire a website crawl. Returns a BrandExtract — never throws.
 * Used by the wizard to fetch brand context in the background while
 * the user fills the rest of the form.
 */
export async function crawlWebsite(url: string): Promise<BrandExtract> {
  // Crawling spends z.ai tokens (palette vision + design-language + logo agent)
  // — never let an unauthenticated caller trigger it.
  const user = await getCurrentUser();
  if (!user) {
    return {
      url,
      fetched_at: new Date().toISOString(),
      ok: false,
      error: "Please sign in to analyze a website.",
    };
  }
  // Soft abuse-bound: a free user who exhausted their generate quota can
  // otherwise trigger unbounded crawls by re-editing the URL field. Deny the
  // crawl when the generate quota is spent (no new schema/service needed).
  const ent = await checkEntitlement(user.id, "generate").catch(() => ({ allowed: true }));
  if (!ent.allowed) {
    return { url, fetched_at: new Date().toISOString(), ok: false, error: "Monthly limit reached — upgrade to analyze more sites." };
  }
  // Meter the crawl's model calls (previously unrecorded for real users — the
  // onUsage collector was wired only into the dev route, so this z.ai spend was
  // invisible to the ledger and the spend caps).
  const crawlUsage = new Map<string, Usage>();
  const extract = await extractBrand(url, {
    onUsage: (model, usage) => crawlUsage.set(model, addUsage(crawlUsage.get(model) ?? EMPTY_USAGE, usage)),
  });
  for (const [model, usage] of crawlUsage) {
    await recordUsage({ op: "crawl", model, url, usage });
  }
  return extract;
}

export type BriefSubmitResult =
  | { ok: true; brief_id: string }
  | { ok: false; error: string };

const CREATIVITY: CreativityLevel[] = ["literal", "balanced", "bold"];

/**
 * Submit the brief and run Agent 1 in a SINGLE pass.
 *
 * Two modes, dispatched by which fields are present in the brief:
 *   - manual:  `moments` is populated (user filled per-moment in wizard).
 *              CTA + purpose are required.
 *   - auto:    `freeform_prompt` + `moment_count` are populated. The
 *              agent infers purpose + per-moment content + CTA itself.
 *
 * Either way the result is a fully-formed Script JSON. No intermediate
 * setup agent, no separate brief-edit step.
 */
export async function submitBrief(
  formData: FormData,
): Promise<BriefSubmitResult> {
  const briefRaw = formData.get("brief");
  if (typeof briefRaw !== "string") {
    return { ok: false, error: "Missing brief payload." };
  }

  let briefParsed: BriefInput;
  try {
    briefParsed = JSON.parse(briefRaw) as BriefInput;
  } catch {
    return { ok: false, error: "Brief payload was not valid JSON." };
  }

  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: "Please sign in to create a video." };
  }

  // Balance circuit breaker — while the z.ai account is dry, fail fast and
  // friendly BEFORE consuming the user's generate slot or starting the crawl.
  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) return { ok: false, error: err.friendly };
    throw err;
  }

  // Metering gate (LAUNCH.md #4) — fail-closed BEFORE the crawl/script spend.
  const ent = await checkEntitlement(user.id, "generate");
  if (!ent.allowed) {
    return { ok: false, error: ent.reason ?? "Plan limit reached." };
  }

  const validation = validateBrief(briefParsed);
  if (validation) return { ok: false, error: validation };

  // Three upload tracks:
  //   - file_0..N: generic brand files (logos, color refs, screenshots)
  //   - file_logo: the user-uploaded brand logo (brand-kit gate — required
  //     unless the crawled logo was explicitly confirmed). Tagged is_logo so
  //     the pipeline uses it as logo_hd.
  //   - file_font: the optional user-uploaded brand webfont. Tagged is_font +
  //     font_family + font_licensed; overrides crawled font roles downstream.
  const files: File[] = [];
  let logoIndex = -1;
  let fontIndex = -1;
  for (const [key, value] of formData.entries()) {
    if (value instanceof File && value.size > 0) {
      if (key === "file_logo") {
        logoIndex = files.length;
        files.push(value);
      } else if (key === "file_font") {
        fontIndex = files.length;
        files.push(value);
      } else if (key.startsWith("file_")) {
        files.push(value);
      }
    }
  }

  const brief_id = ulid();

  const fontFamilyRaw = formData.get("font_family");
  const fontLicensed = formData.get("font_licensed") === "1";
  const logoSourceRaw = formData.get("logo_source");
  const logoSource =
    logoSourceRaw === "upload" || logoSourceRaw === "crawl_confirmed"
      ? logoSourceRaw
      : undefined;
  const colorsConfirmed = formData.get("colors_confirmed") === "1";

  let savedFiles: UploadedFileRef[] = [];
  try {
    savedFiles = await saveBriefFiles(brief_id, files);
    if (logoIndex >= 0 && savedFiles[logoIndex]) {
      savedFiles[logoIndex] = { ...savedFiles[logoIndex], is_logo: true };
    }
    if (fontIndex >= 0 && savedFiles[fontIndex]) {
      savedFiles[fontIndex] = {
        ...savedFiles[fontIndex],
        is_font: true,
        font_family:
          typeof fontFamilyRaw === "string" && fontFamilyRaw.trim()
            ? fontFamilyRaw.trim().slice(0, 80)
            : fontFamilyFromFilename(savedFiles[fontIndex].name),
        font_licensed: fontLicensed,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const brandExtractRaw = formData.get("brand_extract");
  let brandExtract: BrandExtract | undefined;
  if (typeof brandExtractRaw === "string" && brandExtractRaw) {
    try {
      brandExtract = JSON.parse(brandExtractRaw) as BrandExtract;
    } catch {
      // ignore
    }
  }

  // Brand-kit gate (approved DESIGN.md deviation, 2026-07-07): the identity
  // must be USER-LOCKED before we spend on generation. The form disables
  // submit on the same predicate; this is the server truth.
  const kit = brandKitStatus({
    brand_files: savedFiles,
    logo_source: logoSource,
    colors_confirmed: colorsConfirmed,
    brand_extract: brandExtract?.ok
      ? { ok: true, logo_hd: brandExtract.logo_hd, palette: brandExtract.palette }
      : undefined,
  });
  if (!kit.ready) {
    return { ok: false, error: `Brand kit incomplete — missing: ${kit.missing.join("; ")}.` };
  }

  const preallocated = buildPreallocatedAssets(savedFiles, brandExtract);

  const isAuto =
    typeof briefParsed.freeform_prompt === "string" &&
    briefParsed.freeform_prompt.trim().length > 0;

  const momentCount = isAuto
    ? (briefParsed.moment_count ?? 0)
    : (briefParsed.moments ?? []).length;

  // Persist the brief with placeholder moments in auto mode — the
  // moments will be populated from Agent 1's output after the agent runs.
  // Canvas pivot: normalize the document kind (never trust arbitrary client
  // strings) and make deck durations inert 5s-per-slide metadata.
  const briefKind = briefParsed.kind === "deck" ? ("deck" as const) : undefined;

  const baseBrief: StoredBrief = {
    id: brief_id,
    owner_id: user.id,
    purpose: briefParsed.purpose?.trim() ?? "",
    duration_seconds: briefKind
      ? Math.max(1, momentCount) * DECK_SECONDS_PER_SLIDE
      : briefParsed.duration_seconds,
    distribution_format: briefParsed.distribution_format,
    kind: briefKind,
    moments: isAuto
      ? []
      : (briefParsed.moments ?? []).map((m) => ({
          title: m.title.trim(),
          description: m.description.trim(),
          creativity: m.creativity,
        })),
    cta: briefParsed.cta?.trim() ?? "",
    brand_kit_url: briefParsed.brand_kit_url?.trim() || undefined,
    brand_files: savedFiles.length > 0 ? savedFiles : undefined,
    verified_claims: briefParsed.verified_claims?.trim() || undefined,
    palette_roles: briefParsed.palette_roles && Object.keys(briefParsed.palette_roles).length > 0
      ? briefParsed.palette_roles
      : undefined,
    brand_extract: brandExtract?.ok ? brandExtract : undefined,
    logo_source: logoSource,
    colors_confirmed: colorsConfirmed || undefined,
    created_at: new Date().toISOString(),
    status: "awaiting_agent_1",
  };
  await saveBrief(baseBrief);

  const result = await generateScript(
    {
      duration_seconds: baseBrief.duration_seconds,
      distribution_format: baseBrief.distribution_format,
      kind: baseBrief.kind,
      moment_count: momentCount,
      brand_kit_url: baseBrief.brand_kit_url,
      brand_files: baseBrief.brand_files,
      verified_claims: baseBrief.verified_claims,
      brand_extract: brandExtract?.ok ? brandExtract : undefined,
      preallocated_assets: preallocated,
      ...(isAuto
        ? { freeform_prompt: briefParsed.freeform_prompt!.trim() }
        : {
            purpose: baseBrief.purpose,
            moments: baseBrief.moments,
            cta: baseBrief.cta,
          }),
    },
    brief_id,
  );

  if (!result.ok) {
    await saveBrief({
      ...baseBrief,
      status: "failed",
      error: result.error,
    });
    return { ok: true, brief_id };
  }

  // The script exists and the GLM spend is already sunk. A transient DB blip
  // during these writes must NOT throw a raw error that loses the script and
  // leaves the brief stuck in awaiting_agent_1 — retry the writes, and on hard
  // failure tell the user honestly so their retry doesn't double-spend.
  try {
    // In auto mode, hydrate the stored brief with what the agent produced so
    // the gallery / future agents see a populated brief.
    const updatedBrief: StoredBrief = {
      ...baseBrief,
      status: "script_generated",
      script_id: result.script.id,
    };
    if (isAuto) {
      updatedBrief.purpose = result.script.brief.purpose;
      updatedBrief.cta = result.script.brief.cta;
      updatedBrief.moments = result.script.scenes.map((s) => ({
        title: s.label,
        // The agent's 1-sentence intent describes what the scene is FOR.
        description: s.description ?? s.label,
        creativity: "balanced",
      }));
    }

    await withDbRetry(() => saveScript(result.script, user.id));
    await withDbRetry(() =>
      recordMeteredUsage({
        ownerId: user.id,
        operation: "generate",
        model: "glm-5.2",
        costUsd: 0,
        projectId: brief_id,
      }),
    );
    await withDbRetry(() => saveBrief(updatedBrief));
  } catch (err) {
    console.error(`[submitBrief] post-generate persistence failed for ${brief_id} (script ${result.script.id}):`, err);
    return {
      ok: false,
      error:
        "We generated your story but hit a temporary storage error saving it. You weren't charged — please try again in a moment.",
    };
  }

  return { ok: true, brief_id };
}

const validateBrief = (b: BriefInput): string | null => {
  if (
    typeof b.duration_seconds !== "number" ||
    b.duration_seconds < 5 ||
    b.duration_seconds > 60
  ) {
    return "Duration must be between 5 and 60 seconds.";
  }

  const isAuto =
    typeof b.freeform_prompt === "string" && b.freeform_prompt.trim() !== "";

  if (isAuto) {
    if (
      typeof b.moment_count !== "number" ||
      b.moment_count < 1
    ) {
      return "Auto mode requires a moment_count.";
    }
    const cap = maxMomentsForDuration(b.duration_seconds);
    if (b.moment_count > cap) {
      return `At ${b.duration_seconds}s, the most you can have is ${cap} moments (${SECONDS_PER_MOMENT_FLOOR}s/moment floor).`;
    }
    return null;
  }

  // Manual mode: moments, CTA required.
  if (!b.cta?.trim()) return "CTA is required.";
  if (!Array.isArray(b.moments) || b.moments.length === 0) {
    return "At least one moment is required.";
  }
  const momentCap = maxMomentsForDuration(b.duration_seconds);
  if (b.moments.length > momentCap) {
    return `At ${b.duration_seconds}s, the most you can have is ${momentCap} moments (${SECONDS_PER_MOMENT_FLOOR}s/moment floor).`;
  }
  for (const [i, m] of b.moments.entries()) {
    if (!m.description?.trim()) {
      return `Moment ${i + 1} needs a description.`;
    }
    if (!CREATIVITY.includes(m.creativity)) {
      return `Moment ${i + 1} has invalid creativity level.`;
    }
  }
  return null;
};

const buildPreallocatedAssets = (
  uploads: UploadedFileRef[],
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

  uploads
    .filter((f) => f.mime.startsWith("image/"))
    .forEach((f, i) => {
      out.push({
        id: `upload_${i}`,
        url: f.url,
        mime: f.mime,
        source: "upload",
        label: `uploaded ${f.name}`,
      });
    });

  if (brandExtract?.ok) {
    // Prefer the HD logo over favicon when available — favicon is 16×16/32×32
    // and renders blurry. HD logo comes from <img>/static-path probe/Clearbit.
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
    // Page <img> tags — real product imagery, illustrations, screenshots
    if (brandExtract.page_images) {
      brandExtract.page_images.slice(0, 6).forEach((img, i) => {
        const ext = img.src.match(/\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i)?.[1]?.toLowerCase() ?? "";
        const mime = ext === "svg" ? "image/svg+xml"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
          : ext === "avif" ? "image/avif"
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
  }

  return out;
};
