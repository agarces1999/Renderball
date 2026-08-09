/**
 * Brand as a step that ALWAYS RUNS and NEVER BLOCKS.
 *
 * THE BUG THIS CLOSES. At the 2026-07-23 pivot the front door moved from
 * `/new` to `/api/documents/new`, and the crawl did not come with it:
 * `extractBrand` is never invoked on the live path, and the database agrees —
 * the last successful extract was 2026-07-24, none in August. The URL field
 * survived only inside "generate every page", so a user who chose "build it
 * myself" had no way to say what their brand was at all.
 *
 * THE SHAPE. Creating a document must stay free, instant and blank — that is a
 * written decision (lib/documents/blank-document.ts) and the reason the front
 * door feels good. So the read runs OFF THE REQUEST under build-jobs, exactly
 * as the outline does, under a namespaced key so a brand job and a build job
 * for one document can never overwrite each other's state.
 *
 * THE COST THRESHOLD, which is the whole point of the two tiers below.
 * Founder's call on the record: free/deterministic work runs automatically,
 * anything paid waits for a click. So the tier that fires by itself is the one
 * with zero model calls, and the paid tier is unreachable without an explicit
 * `vision: true` in a request body — see `requestedTier`, which is strict on
 * purpose.
 *
 * NEVER LIES. `BrandExtract.ok` means the fetch came back, nothing more:
 * measured over 60 live sites, 41% of `ok` extracts carried neither a
 * chromatic colour nor a real font. Everything user-facing here goes through
 * `brandExtractYield` (lib/crawl/brand-identity.ts) — the ONE predicate the
 * banner, this job and the BrandKit gate share — and the message says what was
 * actually found. "We could not read much from yoursite.com" beats a
 * confidently wrong palette.
 */
import type { BrandExtract } from "../../app/new/schema";
import { loadBriefByScriptId, saveBrief, type StoredBrief } from "../store";
import { extractBrand } from "../crawl/extract-brand";
import { brandExtractYield, fontStackFor, resolveBrandIdentity, type BrandYield } from "../crawl/brand-identity";
import {
  type DocumentBrand,
  validateBrandInput,
  writeDocumentBrand,
} from "../brand/document-brand";
import { applyBrandToDocument } from "../brand/apply-brand";
import { documentDir } from "../render/gen-store";
import { isBlankComposition } from "./blank-document";
import { readSiteBrand, siteHost } from "./site-brand";
import { startBuild } from "../render/build-jobs";

/** Which read to run. The names are the cost, not the capability. */
export type BrandTier = "free" | "vision";

/**
 * The threshold, in one place, in numbers.
 *
 * `free` is `readSiteBrand`: HTML + stylesheets + two icons, no model. Measured
 * over ten live sites: median 1.4s, max 4.6s, a chromatic colour on 9/10 and a
 * real brand font on 7/10.
 *
 * `vision` is the full `lib/crawl/extract-brand` crawl: a homepage screenshot
 * read, an og:image colour-roles read and the logo-discovery agent — measured
 * ~$0.0043 and 10-25s. Anything with `modelCalls > 0` needs a click.
 */
export const TIER_COST: Record<BrandTier, { usd: number; modelCalls: number; typicalSeconds: number }> = {
  free: { usd: 0, modelCalls: 0, typicalSeconds: 1.5 },
  vision: { usd: 0.0043, modelCalls: 3, typicalSeconds: 25 },
};

/** True when running this tier spends the user's tokens. The gate reads this. */
export const tierSpends = (tier: BrandTier): boolean => TIER_COST[tier].modelCalls > 0;

/**
 * What tier a request asked for. STRICT `=== true`, deliberately: this is the
 * only thing standing between "a document was created" and "we billed a model
 * call for it", and a truthy check would let `"false"`, `1` or a stray query
 * string spend money. Anything that is not the literal boolean is free.
 */
export const requestedTier = (vision: unknown): BrandTier =>
  vision === true ? "vision" : "free";

/**
 * Brand jobs share build-jobs' machinery (sweep, retention, lost-job age) under
 * a NAMESPACED key, the same way outline jobs do — `outline:${id}` /
 * `brand:${id}` / the raw id for builds can never collide.
 */
export const brandJobKey = (scriptId: string): string => `brand:${scriptId}`;

export interface BrandCrawlResult {
  /** The read completed. NOT "we found a brand" — that is `yield.loaded`. */
  ok: boolean;
  url: string;
  host: string;
  tier: BrandTier;
  /** The honest tally. Never inferred from `ok`. */
  yield: BrandYield;
  /** One sentence for the user, in their words. */
  message: string;
  /** True when the document was actually re-skinned (blank documents only). */
  applied: boolean;
  /** What we set, so the UI can show it without a second round trip. */
  brand?: DocumentBrand;
  /** Offer the paid read? Only when the free one came back thin. */
  canGoDeeper: boolean;
}

/**
 * What to tell the user. Three outcomes, not two — "reached the site but found
 * nothing" is the 41% case that used to print "brand loaded from {url}" with
 * an accent dot beside it.
 */
export const describeCrawl = (
  url: string,
  extract: BrandExtract,
  y: BrandYield,
): string => {
  const host = siteHost(url);
  if (!extract.ok) {
    return `We could not read ${host} — check the address, or set your colours and type in the Brand panel.`;
  }
  if (y.color && y.font) return `Brand loaded from ${host} — your colours and your type.`;
  if (y.color) return `Read ${host} — got your colours, but no brand font. Pick type in the Brand panel.`;
  if (y.font) return `Read ${host} — got your type, but no brand colour. Pick colours in the Brand panel.`;
  return `We could not read much from ${host}. Set your colours and type in the Brand panel, or Renderball will choose.`;
};

/**
 * The crawl, as something a document can WEAR.
 *
 * Only two roles are set, and only when the yield says they were observed:
 * the signature accent and the type. `canvas` is deliberately NOT set from
 * `background_color` — a mis-read canvas turns the whole deck dark, which is
 * the loudest possible way to be wrong about a brand, and the free tier has no
 * vision pass to check it against. It stays on the extract for the Brand panel
 * to offer.
 *
 * Everything is run through `validateBrandInput` even though we produced it:
 * family names and hexes here come from an arbitrary third party's stylesheet
 * and are substituted into source this process later executes. `isFontStack`
 * rejects `;{}()<>` — that is the guard, and it should not be skipped just
 * because the caller happens to be us.
 */
export const documentBrandFromExtract = (extract: BrandExtract): DocumentBrand | null => {
  const identity = resolveBrandIdentity(extract);
  const draft: DocumentBrand = { v: 1, palette: {}, fonts: {}, assets: [] };

  if (identity.signature) draft.palette.accent = identity.signature;

  const faces: NonNullable<DocumentBrand["fonts"]["faces"]> = [];
  for (const slot of ["display", "body"] as const) {
    const font = identity.fonts[slot];
    // `fallback` means this is OUR curated stand-in, not the brand's face.
    // Writing it would claim we found something we did not.
    if (!font || font.fallback) continue;
    draft.fonts[slot] = fontStackFor(font);
    if (font.src?.startsWith("https://")) faces.push({ family: font.family, src: font.src });
  }
  if (faces.length) draft.fonts.faces = faces;

  const nothing =
    Object.keys(draft.palette).length === 0 && !draft.fonts.display && !draft.fonts.body;
  if (nothing) return null;

  const v = validateBrandInput(draft);
  // A rejected value is dropped, not fatal: a brand with a hostile font name
  // still gets its colour. `validateBrandInput` returns the cleaned brand
  // alongside the errors, so this keeps whatever survived.
  const kept = v.brand;
  const empty =
    Object.keys(kept.palette).length === 0 && !kept.fonts.display && !kept.fonts.body;
  return empty ? null : kept;
};

export interface BrandCrawlInput {
  scriptId: string;
  ownerId: string;
  url: string;
  tier: BrandTier;
}

/**
 * Everything this job touches, injectable. Not ceremony: the properties worth
 * testing here are "it never blocks", "it never throws" and "the free tier
 * never reaches a model", and all three are only assertable if the effects can
 * be observed without a database, a disk or a network.
 */
export interface BrandCrawlDeps {
  /** The FREE read. Default `readSiteBrand` — zero model calls, by construction. */
  read: (url: string) => Promise<BrandExtract>;
  /** The PAID read. Loaded lazily so the free path never even imports it. */
  readWithVision: (url: string) => Promise<BrandExtract>;
  resolveDir: (scriptId: string) => Promise<string>;
  isBlank: (genDir: string) => Promise<boolean>;
  writeBrand: (genDir: string, brand: DocumentBrand) => Promise<void>;
  applyBrand: (genDir: string, brand: DocumentBrand) => Promise<{ ok: boolean }>;
  loadBrief: (scriptId: string, ownerId: string) => Promise<StoredBrief | null>;
  saveBrief: (brief: StoredBrief) => Promise<void>;
}

/**
 * The two readers are DIFFERENT FUNCTIONS, and that is the entire cost
 * guarantee — not module isolation. Both live in the same import graph
 * (site-brand.ts reuses the crawl's pure palette/font helpers on purpose, so
 * there is one set of brand judgement rather than two), so "the paid module is
 * not loaded" would be a false claim. What IS true and what the tests assert:
 * `runBrandCrawl` calls exactly one of these, chosen by tier, and tier is
 * `requestedTier`, which only ever returns "vision" for a literal `true`.
 */
const defaultDeps = (): BrandCrawlDeps => ({
  read: readSiteBrand,
  readWithVision: (url) => extractBrand(url),
  resolveDir: documentDir,
  // "not-blank" when the manifest cannot be read, and that direction is
  // load-bearing. Applying a brand REWRITES the document's sources, and the
  // generate route learned this the expensive way: failing OPEN on an
  // unreadable manifest waved through exactly the decks the gate existed to
  // protect. If we cannot tell whether there is work here, we do not touch it
  // — the brand is still saved and the Brand panel applies it in one click.
  isBlank: (genDir) => isBlankComposition(genDir, "not-blank"),
  writeBrand: async (genDir, brand) => {
    await writeDocumentBrand(genDir, brand);
  },
  applyBrand: applyBrandToDocument,
  loadBrief: loadBriefByScriptId,
  saveBrief: async (brief) => {
    await saveBrief(brief);
  },
});

/**
 * Run the read and land it on the document. Returns a build-jobs result body.
 *
 * ALWAYS 200. A site that 404s, a site that serves markdown, a site with no
 * colour — none of those are errors the editor should react to, because the
 * editor already works: the document exists, it is open, and it renders. The
 * body carries what happened and the panel says it in words. Making a thin
 * crawl a non-2xx is how "optional" quietly becomes "a gate".
 */
export const runBrandCrawl = async (
  input: BrandCrawlInput,
  overrides: Partial<BrandCrawlDeps> = {},
): Promise<{ status: number; body: BrandCrawlResult }> => {
  // Merge, skipping explicit `undefined`. A plain spread lets
  // `{ isBlank: undefined }` REPLACE the default with undefined, and the next
  // call goes through the try/catch as a TypeError — which looks exactly like
  // the correct answer from the outside. Caught by a test of the default
  // blankness check that passed while never running it.
  const deps = defaultDeps();
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (deps as unknown as Record<string, unknown>)[key] = value;
  }
  const { scriptId, ownerId, url, tier } = input;

  let extract: BrandExtract;
  try {
    extract = tier === "vision" ? await deps.readWithVision(url) : await deps.read(url);
  } catch (err) {
    // A read that THREW is a read that found nothing. The document is
    // untouched and still open; say so and stop.
    const failed: BrandExtract = {
      url,
      fetched_at: new Date().toISOString(),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    const y = brandExtractYield(failed);
    return {
      status: 200,
      body: {
        ok: false,
        url,
        host: siteHost(url),
        tier,
        yield: y,
        message: describeCrawl(url, failed, y),
        applied: false,
        canGoDeeper: tier === "free",
      },
    };
  }

  const y = brandExtractYield(extract);
  const brand = documentBrandFromExtract(extract);
  let applied = false;

  if (brand) {
    try {
      const genDir = await deps.resolveDir(scriptId);
      await deps.writeBrand(genDir, brand);
      // APPLY ONLY TO A BLANK DOCUMENT. This job lands seconds after the user
      // typed a URL, and by then they may already be drawing. Re-skinning work
      // somebody is in the middle of is not "it looks like you", it is the
      // editor changing under their hands. On a blank page there is nothing to
      // lose, so it wears the brand immediately; on a page with content the
      // brand is saved and the Brand panel applies it in one click, for 0
      // tokens, whenever they want it.
      if (await deps.isBlank(genDir)) {
        const res = await deps.applyBrand(genDir, brand);
        applied = res.ok;
      }
    } catch (err) {
      // The read succeeded; only the re-skin failed. The user still gets the
      // truth about their brand and the panel still works.
      console.error(`[brand-crawl] ${scriptId}: could not apply brand:`, err);
    }
  }

  // Persist onto the BRIEF, read-modify-write as late as possible: the outline
  // job may be writing the same row, and `brand_extract` is what carries the
  // brand into `generateScript` (app/api/documents/generate/route.ts spreads
  // the stored brief straight through, so no wiring is needed there).
  if (extract.ok) {
    try {
      const brief = await deps.loadBrief(scriptId, ownerId);
      if (brief) {
        await deps.saveBrief({ ...brief, brand_kit_url: url, brand_extract: extract });
      }
    } catch (err) {
      console.error(`[brand-crawl] ${scriptId}: could not persist the extract:`, err);
    }
  }

  return {
    status: 200,
    body: {
      ok: extract.ok,
      url,
      host: siteHost(url),
      tier,
      yield: y,
      message: describeCrawl(url, extract, y),
      applied,
      ...(brand ? { brand } : {}),
      // Only offer to spend when the free read actually came up short. Offering
      // it after a good read would be selling something nobody needs.
      canGoDeeper: tier === "free" && !(y.color && y.font),
    },
  };
};

/**
 * Kick the read off and RETURN — the caller must not wait for it.
 *
 * Deliberately not `await startBuild(...)`: that races the work against a 4s
 * grace window so a fast rejection can be handed back synchronously, which is
 * right for a build that might 402 and wrong here. The free read finishes in
 * ~1.4s, i.e. INSIDE the window, so awaiting would put the whole crawl back on
 * the create request — the exact thing the blank-document decision exists to
 * prevent. `startBuild` registers the job synchronously before its first
 * await, so a poll issued immediately after this call already sees "running".
 *
 * Returns false when there is nothing to crawl. A user with no website sails
 * through untouched: no job, no poll, no banner.
 */
export const startBrandCrawl = (
  input: BrandCrawlInput,
  overrides: Partial<BrandCrawlDeps> = {},
): boolean => {
  if (!input.url) return false;
  void startBuild(brandJobKey(input.scriptId), () => runBrandCrawl(input, overrides)).catch(
    (err: unknown) => {
      console.error(`[brand-crawl] ${input.scriptId}: job failed to start:`, err);
    },
  );
  return true;
};
