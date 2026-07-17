/**
 * Cycle-8 PRODUCT-PATH validation harness (task #205).
 *
 * Drives the REAL production build path end-to-end for one brief:
 *   1. load the cached brief,
 *   2. generate + persist a Script via the production script generator,
 *   3. link the brief → script (script_id) so loadBriefByScriptId resolves,
 *   4. call runPreviewBuild(scriptId, DEV_OWNER_ID) — the SAME function
 *      /api/preview/build and /api/dev/build call — with RB_BUILD_MODE=cast,
 *      so the cast → assemble → runQualityLoop path (the shared gate battery)
 *      runs exactly as it would for a signed-in user.
 *   5. copy the shipped composition + frames + a summary into
 *      .data/dogfood/cycle8-<tag>/.
 *
 * This exercises the product path HONESTLY: the only thing "stubbed" is the
 * Clerk session (DEV_OWNER_ID stands in — metering no-ops for it, exactly as
 * /api/dev/build does; NOTED in the report).
 *
 * Run:
 *   set -a && source .env.local && set +a && \
 *     RB_BUILD_MODE=cast RB_CAST_MODEL=accounts/fireworks/routers/glm-5p2-fast \
 *     RB_DOGFOOD_BRIEF=01KT6WXWCNRB7GEDCXHJTEZ4CH RB_DOGFOOD_TAG=tonys \
 *     node scripts/cycle8-product-path.mjs
 */
import { promises as fs } from "fs";
import path from "path";
import { loadBrief, saveBrief, saveScript, DEV_OWNER_ID, type StoredBrief } from "../lib/store";
import { withDbRetry } from "../lib/db";
import {
  generateScript,
  type AgentBrief,
  type AgentBrandExtract,
  type PreallocatedAsset,
} from "../lib/agents/script-generator";
import { runPreviewBuild } from "../lib/render/run-preview-build";

const BRIEF_ID = process.env.RB_DOGFOOD_BRIEF ?? "01KT6WXWCNRB7GEDCXHJTEZ4CH";
const TAG = (process.env.RB_DOGFOOD_TAG ?? "tonys").replace(/[^a-z0-9_-]/gi, "");
const OUT_DIR = path.join(process.cwd(), ".data", "dogfood", `cycle9-${TAG}`);

const buildPreallocatedFromCrawl = (be: AgentBrandExtract | undefined): PreallocatedAsset[] => {
  const out: PreallocatedAsset[] = [];
  if (!be?.ok) return out;
  if (be.logo_hd) {
    out.push({ id: "site_logo", url: be.logo_hd, mime: be.logo_hd.endsWith(".svg") ? "image/svg+xml" : "image/png", source: "crawl", label: "site logo (HD — preferred over favicon for opening/closing)" });
  } else if (be.apple_touch_icon) {
    out.push({ id: "site_logo", url: be.apple_touch_icon, mime: "image/png", source: "crawl", label: "site apple-touch-icon (medium-res brand mark)" });
  } else if (be.favicon) {
    out.push({ id: "site_logo", url: be.favicon, mime: "image/x-icon", source: "crawl", label: "site favicon (low-res; only logo available)" });
  }
  if (be.og_image) out.push({ id: "site_og_image", url: be.og_image, mime: "image/png", source: "crawl", label: "site OG image (hero / share image)" });
  (be.page_images ?? []).slice(0, 6).forEach((img, i) => {
    const ext = img.src.match(/\.(svg|png|jpe?g|webp|gif|avif)(\?|$)/i)?.[1]?.toLowerCase() ?? "";
    const mime =
      ext === "svg" ? "image/svg+xml"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : ext === "avif" ? "image/avif"
      : "image/png";
    out.push({ id: `site_img_${i}`, url: img.src, mime, source: "crawl", label: img.alt ? `site image: ${img.alt}` : `site image #${i + 1}` });
  });
  return out;
};

const copyDir = async (src: string, dst: string): Promise<void> => {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d).catch(() => {});
  }
};

const main = async (): Promise<void> => {
  console.log(`\n▶ cycle-9 PRODUCT-PATH build — brief ${BRIEF_ID} (${TAG})`);
  console.log(`  RB_BUILD_MODE=${process.env.RB_BUILD_MODE ?? "(unset — will run MONOLITHIC!)"} · RB_CAST_MODEL=${process.env.RB_CAST_MODEL ?? "(default gpt-oss-120b @ Cerebras)"}`);

  const brief = await withDbRetry(() => loadBrief(BRIEF_ID, DEV_OWNER_ID));
  if (!brief) throw new Error(`no brief ${BRIEF_ID} for owner ${DEV_OWNER_ID}`);
  const be = brief.brand_extract as unknown as AgentBrandExtract | undefined;
  if (!be?.ok) throw new Error("brief has no cached brand_extract — crawl the brand first");
  const brand = be.title?.trim() || TAG;
  console.log(`  brief ${brief.id} — ${brief.brand_kit_url} — brand "${brand}" — extract.ok=${be.ok}`);

  // ── 1+2. generate a script from the brief (production script generator) ──
  const freeform = [
    brief.purpose,
    ...(brief.moments ?? []).filter((m) => m?.description).map((m, i) => `${i + 1}. ${m.title ? `${m.title}: ` : ""}${m.description}`),
  ].filter((s): s is string => !!s && s.trim().length > 0).join("\n");
  const agentBrief: AgentBrief = {
    duration_seconds: brief.duration_seconds ?? 30,
    distribution_format: brief.distribution_format ?? "landscape",
    moment_count: 5,
    brand_kit_url: brief.brand_kit_url,
    verified_claims: brief.verified_claims,
    brand_extract: be,
    preallocated_assets: buildPreallocatedFromCrawl(be),
    freeform_prompt: freeform || `Launch video for ${brand}.`,
  };
  console.log(`  generating script (production generateScript, ${agentBrief.preallocated_assets?.length ?? 0} preallocated assets)…`);
  const gen = await generateScript(agentBrief, brief.id);
  if (!gen.ok) throw new Error(`script generation failed: ${gen.error}`);
  const scriptId = gen.script.id;
  console.log(`  script ${scriptId} — ${gen.script.scenes.length} scenes, aspect ${gen.script.config.aspect_ratio}`);

  await saveScript(gen.script, DEV_OWNER_ID);
  await saveBrief({
    ...brief,
    status: "script_generated",
    script_id: scriptId,
    purpose: gen.script.brief.purpose,
    cta: gen.script.brief.cta,
    moments: gen.script.scenes.map((s) => ({ title: s.label, description: s.description ?? s.label, creativity: "balanced" as const })),
  } as StoredBrief);

  // ── 3+4. THE PRODUCT PATH — the exact function the API routes call. ──
  console.log(`\n▶ runPreviewBuild(${scriptId}, DEV_OWNER_ID) — the PRODUCT path (RB_BUILD_MODE=${process.env.RB_BUILD_MODE})`);
  const t0 = Date.now();
  const result = await runPreviewBuild(scriptId, DEV_OWNER_ID);
  const wallS = Math.round((Date.now() - t0) / 100) / 10;

  console.log(`\n◀ product-path build DONE in ${wallS}s — HTTP ${result.status}`);
  console.log(JSON.stringify(result.body, null, 2).slice(0, 4000));

  // ── 5. copy the shipped artifacts to the cycle output dir. ──
  const genDir = path.join(process.cwd(), "src", "generated", scriptId);
  await fs.mkdir(OUT_DIR, { recursive: true });
  await copyDir(genDir, path.join(OUT_DIR, "gen")).catch(() => {});
  await fs.writeFile(
    path.join(OUT_DIR, "product-path-result.json"),
    JSON.stringify({ briefId: BRIEF_ID, tag: TAG, scriptId, buildMode: process.env.RB_BUILD_MODE ?? null, castModel: process.env.RB_CAST_MODEL ?? null, wallSeconds: wallS, status: result.status, body: result.body, generatedAt: new Date().toISOString(), note: "Clerk session stubbed as DEV_OWNER_ID (metering no-ops for it — same as /api/dev/build)." }, null, 2),
    "utf8",
  );
  console.log(`\n  artifacts → ${OUT_DIR}`);
  if (result.status !== 200) process.exitCode = 1;
};

main().catch((e) => {
  console.error("\n▲▲▲ product-path harness FAILED:", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
