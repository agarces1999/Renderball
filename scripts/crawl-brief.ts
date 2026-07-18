/**
 * REUSABLE crawl → brief helper (P3 overnight loop, cycle 1).
 *
 * Turns a bare URL into a stored brief the full-pipeline runner can build:
 *   extractBrand(url)  — DOM-primary; z.ai vision steps are OPTIONAL and
 *                        degrade cleanly to CSS/pixel/DOM if z.ai is down or
 *                        out-of-balance (the crawl never throws on vision).
 *   preflightBrandTruth — flags a DEGRADED crawl (missing logo / neutral accent
 *                        / no photos) so we build with eyes open, never blind.
 *   saveBrief          — persists a StoredBrief + Project row (owner DEV_OWNER_ID,
 *                        a fresh ulid) via the store's default backend.
 *
 * Later cycles just pass a URL:
 *   set -a && source .env.local && set +a && \
 *     RB_CRAWL_URL=deel.com node scripts/crawl-brief.mjs
 *   # → prints  BRIEF_ID=<ulid>  on the last line; feed it to fullpipe-render:
 *   RB_FA_BRIEF=<ulid> RB_FP_OUT=$PWD/.data/dogfood/p3-cycleN-deel \
 *     node scripts/fullpipe-render.mjs
 *
 * Optional env overrides: RB_BRIEF_PURPOSE, RB_BRIEF_CTA, RB_BRIEF_DURATION,
 * RB_BRIEF_MOMENTS (JSON array). Never echoes secrets.
 */
import { extractBrand, type CrawlUsageCollector } from "../lib/crawl/extract-brand";
import { preflightBrandTruth } from "../lib/crawl/brand-truth";
import { brandShortName } from "../lib/crawl/brand-identity";
import { saveBrief, DEV_OWNER_ID, type StoredBrief, type StoredMoment } from "../lib/store";
import { withDbRetry } from "../lib/db";
import { ulid } from "../lib/ulid";

const RAW_URL = process.env.RB_CRAWL_URL ?? process.argv[2];
const DURATION = Number(process.env.RB_BRIEF_DURATION ?? 30);

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

/** A brand-agnostic 5-beat arc: hook → tension → turn → proof → CTA. The script
 *  generator fills each beat from the crawled brand_extract — no per-brand
 *  hand-authoring, so the helper is reusable for any URL. */
const genericMoments = (brand: string): StoredMoment[] => [
  {
    title: "The Tension",
    description: `Open on the tension the audience feels BEFORE ${brand} — the friction, the pause, the status-quo pain — with the brand name held back. Set up the problem the product will break next.`,
    creativity: "balanced",
  },
  {
    title: "The Cost of the Status Quo",
    description: `Deepen the tension — dramatize the real cost of the old way (the wasted time, the tangle, the doubt) — before the turn arrives in the next beat.`,
    creativity: "balanced",
  },
  {
    title: "The Turn",
    description: `Deliver the turn — ${brand}'s product surface appears and the tension breaks into flow. Show the actual product doing the thing, concretely.`,
    creativity: "balanced",
  },
  {
    title: "The Proof",
    description: `Prove it's real and it scales — concrete outcomes, numbers, or breadth — building confidence that hands off to the closing invitation.`,
    creativity: "balanced",
  },
  {
    title: "The Invitation",
    description: `Resolve with a confident invitation to start — the product, now familiar, anchors the call to action.`,
    creativity: "balanced",
  },
];

(async () => {
  if (!RAW_URL) {
    console.error("usage: RB_CRAWL_URL=<url> node scripts/crawl-brief.mjs   (or pass the url as argv[2])");
    process.exit(2);
  }

  // Track which models actually ran, so we can HONESTLY report whether the
  // crawl degraded to DOM-only (zero vision usage = z.ai never answered).
  const modelsUsed = new Set<string>();
  const onUsage: CrawlUsageCollector = (model) => modelsUsed.add(model);

  log(`crawling ${RAW_URL} …`);
  const extract = await extractBrand(RAW_URL, { onUsage });
  if (!extract.ok) {
    console.error(`\nCRAWL HARD-FAIL — ${extract.error}`);
    console.error("The site was unreachable or returned no HTML. No brief was saved.");
    console.error("Fallback: pass a reachable URL, or build the richest UNSEEN existing store brief instead.");
    process.exit(3);
  }

  // Audit-1 P0 #1: the ONE brand-name source of truth — was the raw <title>, so
  // Faire's CTA shipped "Get started with Your" and the wordmark the whole
  // tagline. brandShortName host-matches + tagline-guards → "Faire".
  const brand = brandShortName(extract);
  const palette = extract.palette ?? [];
  const visionRan = [...modelsUsed].some((m) => /glm-?4?\.?5?v|vision|haiku|sonnet|opus|claude/i.test(m));
  log(`crawl OK — brand "${brand}"`);
  log(`  models that answered: ${modelsUsed.size ? [...modelsUsed].join(", ") : "(none — DOM/CSS only)"}`);
  log(`  palette(${palette.length}): ${palette.slice(0, 6).join(", ") || "(none)"} · logo_hd ${extract.logo_hd ? "yes" : "NO"} · fonts ${JSON.stringify(extract.font_roles ?? {})}`);
  log(`  background_color ${extract.background_color ?? "(none)"} · theme_color ${extract.theme_color ?? "(none)"} · headlines ${extract.headlines?.length ?? 0} · body_excerpts ${extract.body_excerpts?.length ?? 0}`);

  // Brand-truth preflight (the build-entry gate): flags a DEGRADED crawl.
  const truth = await withDbRetry(() => preflightBrandTruth(extract)).catch(() => preflightBrandTruth(extract));
  if (truth.hardFail) {
    log(`  ⚠ BRAND-TRUTH HARD-FAIL — ${truth.degraded.join(" | ")}`);
    log(`  (this looks like an outage/failover page — the build would ship off a false brand truth)`);
  } else if (!truth.ok) {
    log(`  ⚠ BRAND-TRUTH DEGRADED — ${truth.degraded.join(" | ")}`);
    log(`  (build proceeds, but expect thinner brand fidelity; note it in the eyeball)`);
  } else {
    log(`  brand-truth OK (logo/accent/photos all resolved)`);
  }
  if (!visionRan) {
    log(`  NOTE: z.ai vision did not run — crawl is DOM/CSS-DEGRADED (palette from CSS frequency, colors not vision-selected). This is the expected fallback when z.ai is unfunded; the build still proceeds.`);
  }

  const purpose =
    process.env.RB_BRIEF_PURPOSE ||
    `Product launch for ${brand}${extract.description ? ` — ${extract.description.slice(0, 180)}` : ""}`;
  // `brand` is already the clean short name (SSOT) — no ad-hoc split needed.
  const cta = process.env.RB_BRIEF_CTA || `Get started with ${brand}`;
  const moments: StoredMoment[] = process.env.RB_BRIEF_MOMENTS
    ? (JSON.parse(process.env.RB_BRIEF_MOMENTS) as StoredMoment[])
    : genericMoments(brand);

  const brief: StoredBrief = {
    id: ulid(),
    owner_id: DEV_OWNER_ID,
    purpose,
    duration_seconds: Number.isFinite(DURATION) ? DURATION : 30,
    distribution_format: "landscape",
    moments,
    cta,
    brand_kit_url: extract.url,
    brand_extract: extract,
    created_at: new Date().toISOString(),
    status: "awaiting_agent_1",
  };

  await withDbRetry(() => saveBrief(brief));
  log(`brief saved — purpose: ${purpose.slice(0, 120)}`);
  log(`degraded=${!truth.ok} hardFail=${truth.hardFail} visionRan=${visionRan}`);
  // Machine-readable last line for the pipeline: `BRIEF_ID=<ulid>`.
  console.log(`BRIEF_ID=${brief.id}`);
  process.exit(0);
})().catch((e) => {
  console.error("CRAWL-BRIEF FAILED:", e);
  process.exit(1);
});
