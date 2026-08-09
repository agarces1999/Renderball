/**
 * The brand step: always runs, never blocks, never spends without a click.
 *
 * These four properties are the whole founder decision, and every one of them
 * is a thing that was ACTUALLY WRONG in this repo rather than a hypothetical:
 *
 *   1. the read fires at document creation — since the 2026-07-23 pivot moved
 *      the front door to /api/documents/new it fired nowhere at all (last
 *      successful extract in the database: 2026-07-24, none in August);
 *   2. creation stays instant — build-jobs' `startBuild` races the work
 *      against a 4s grace window so a fast rejection can be returned
 *      synchronously, and the free read finishes INSIDE that window, so an
 *      `await` here would silently put the whole crawl back on the request
 *      that the blank-document decision exists to keep empty;
 *   3. a failed or thin read still leaves a working editor and an honest
 *      sentence — 41% of `ok` extracts carry neither colour nor font, and all
 *      of them used to print "brand loaded from {url}" with an accent dot;
 *   4. nothing paid happens without a literal `vision: true`.
 *
 * Every effect is injected so these assert behaviour, not mocks of behaviour:
 * a test that had to reach Postgres to prove "the extract lands on the brief"
 * would be skipped in CI and prove nothing.
 */
import {
  brandJobKey,
  describeCrawl,
  documentBrandFromExtract,
  requestedTier,
  runBrandCrawl,
  startBrandCrawl,
  tierSpends,
  TIER_COST,
  type BrandCrawlDeps,
} from "./brand-crawl";
import { readSiteBrand, normalizeSiteUrl, siteHost } from "./site-brand";
import { looksLikeSite } from "../../components/BlankDocumentPanel";
import { brandExtractYield } from "../crawl/brand-identity";
import { buildStatus, __resetBuildJobs } from "../render/build-jobs";
import type { BrandExtract } from "../../app/new/schema";
import type { StoredBrief } from "../store";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const NOW = new Date().toISOString();

/** A site that gave us its colour AND a loadable face. */
const RICH: BrandExtract = {
  url: "https://stripe.com/",
  fetched_at: NOW,
  ok: true,
  title: "Stripe",
  palette: ["#635bff", "#0a2540"],
  fonts: [{ family: "Sohne", src: "https://stripe.com/sohne.woff2", format: "woff2" }],
  font_roles: { display: "Sohne", body: "Sohne" },
};

/** Reached, parsed, and carrying nothing usable. The 41% case. */
const THIN: BrandExtract = {
  url: "https://example.com/",
  fetched_at: NOW,
  ok: true,
  title: "Example",
  palette: [],
  fonts: [],
  font_roles: {},
};

/** Never reached at all. */
const FAILED: BrandExtract = {
  url: "https://nope.example/",
  fetched_at: NOW,
  ok: false,
  error: "Fetch failed: getaddrinfo ENOTFOUND",
};

/** A stylesheet is a third party's file, and its strings end up in ours. */
const HOSTILE: BrandExtract = {
  url: "https://evil.example/",
  fetched_at: NOW,
  ok: true,
  palette: ["#ff0055"],
  fonts: [
    { family: 'Nasty";} body{display:none}@font-face{font-family:"x', src: "https://evil.example/x.woff2" },
  ],
  font_roles: { display: 'Nasty";} body{display:none}@font-face{font-family:"x' },
};

const brief = (): StoredBrief => ({
  id: "B1",
  owner_id: "owner-1",
  purpose: "Untitled document",
  kind: "deck",
  distribution_format: "landscape",
  duration_seconds: 5,
  moments: [],
  cta: "",
  created_at: NOW,
  status: "awaiting_agent_1",
  script_id: "S1",
});

/**
 * Every effect stubbed. `readWithVision` THROWS: any test that does not
 * explicitly ask for the paid tier fails loudly if it is reached, which is how
 * "nothing paid without a click" is actually held rather than assumed.
 */
const deps = (over: Partial<BrandCrawlDeps> = {}): Partial<BrandCrawlDeps> => ({
  read: async () => THIN,
  readWithVision: async () => {
    throw new Error("PAID READ CALLED WITHOUT A CLICK");
  },
  resolveDir: async () => "/dev/null/gen",
  isBlank: async () => true,
  writeBrand: async () => {},
  applyBrand: async () => ({ ok: true }),
  loadBrief: async () => null,
  saveBrief: async () => {},
  ...over,
});

const input = { scriptId: "S1", ownerId: "owner-1", url: "https://stripe.com/", tier: "free" as const };

const run = async () => {
  console.log("brand-crawl");

  // ── 4. nothing paid happens without a click ──────────────────────────────

  await check("requestedTier: ONLY a literal true buys the paid read", () => {
    for (const v of [undefined, null, false, 0, 1, "", "true", "vision", "1", "yes", {}, []]) {
      assert(requestedTier(v) === "free", `requestedTier(${JSON.stringify(v)}) must be free`);
    }
    assert(requestedTier(true) === "vision", "an explicit true must reach the paid read");
  });

  await check("the free tier is declared as spending nothing, and the gate reads that", () => {
    assert(TIER_COST.free.modelCalls === 0, "the automatic tier must make no model calls");
    assert(TIER_COST.free.usd === 0, "the automatic tier must cost nothing");
    assert(tierSpends("free") === false, "tierSpends must let the free tier past the gates");
    assert(tierSpends("vision") === true, "tierSpends must gate the paid tier");
    assert(TIER_COST.vision.modelCalls > 0, "the paid tier must declare its model calls");
  });

  await check("tier 'free' never reaches the paid reader", async () => {
    let freeCalls = 0;
    const res = await runBrandCrawl(input, deps({ read: async () => { freeCalls++; return RICH; } }));
    // readWithVision throws; reaching it would surface as ok:false here.
    assert(freeCalls === 1, "the free reader must be the one that ran");
    assert(res.body.ok === true, "the free read must have produced the result");
    assert(res.body.tier === "free", "the result must report the tier it used");
  });

  await check("tier 'vision' reaches the paid reader — the two paths are really distinct", async () => {
    let paidCalls = 0;
    const res = await runBrandCrawl(
      { ...input, tier: "vision" },
      deps({
        read: async () => { throw new Error("free reader used for a paid request"); },
        readWithVision: async () => { paidCalls++; return RICH; },
      }),
    );
    assert(paidCalls === 1, "the paid reader must run when it was explicitly asked for");
    assert(res.body.tier === "vision", "the result must report the paid tier");
  });

  await check("the paid read is never OFFERED after a good free read", async () => {
    const good = await runBrandCrawl(input, deps({ read: async () => RICH }));
    assert(good.body.yield.color && good.body.yield.font, "fixture must yield colour and font");
    assert(good.body.canGoDeeper === false, "a complete free read must not upsell the paid one");
    const thin = await runBrandCrawl(input, deps({ read: async () => THIN }));
    assert(thin.body.canGoDeeper === true, "a thin free read should offer to look harder");
    const already = await runBrandCrawl({ ...input, tier: "vision" }, deps({ readWithVision: async () => THIN }));
    assert(already.body.canGoDeeper === false, "the paid read must never offer itself again");
  });

  // ── 1 + 2. the read fires at creation, and creation stays instant ─────────

  await check("startBrandCrawl registers the job and RETURNS — creation stays instant", async () => {
    __resetBuildJobs();
    const READ_MS = 300;
    let started = false;
    const t0 = Date.now();
    const fired = startBrandCrawl(
      input,
      deps({
        read: async () => {
          started = true;
          await new Promise((r) => setTimeout(r, READ_MS));
          return RICH;
        },
      }),
    );
    const elapsed = Date.now() - t0;
    assert(fired === true, "a URL must start a read");
    // build-jobs' grace window is 4s and the read is 300ms, so an `await` on
    // startBuild would settle INSIDE the window and block for the full 300ms.
    assert(elapsed < 50, `startBrandCrawl blocked for ${elapsed}ms — the create request is paying for the crawl`);
    assert(started, "the read must have actually begun, not merely been scheduled");
    assert(
      buildStatus(brandJobKey("S1")).state === "running",
      "the job must be pollable immediately — the client polls on the next tick",
    );
    // And it does finish.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && buildStatus(brandJobKey("S1")).state === "running") {
      await new Promise((r) => setTimeout(r, 25));
    }
    const done = buildStatus(brandJobKey("S1"));
    assert(done.state === "done", `job ended in state ${done.state}`);
    __resetBuildJobs();
  });

  await check("no website = no job, no poll, no banner", async () => {
    __resetBuildJobs();
    const fired = startBrandCrawl({ ...input, url: "" }, deps());
    assert(fired === false, "an empty URL must not start anything");
    assert(
      buildStatus(brandJobKey("S1")).state === "unknown",
      "a user with no site must leave no job behind for the client to poll",
    );
    __resetBuildJobs();
  });

  await check("the job key is namespaced away from builds and outlines", () => {
    assert(brandJobKey("S1") === "brand:S1", "brand jobs must not collide with the build job for the same id");
  });

  // ── 3. a failed or thin read still leaves a working editor ────────────────

  await check("a read that FAILED still answers 200 — brand never blocks the editor", async () => {
    const res = await runBrandCrawl(input, deps({ read: async () => FAILED }));
    assert(res.status === 200, `a failed crawl answered ${res.status}; the editor must not see an error`);
    assert(res.body.ok === false, "the body must say the read failed");
    assert(res.body.applied === false, "nothing may be applied from a failed read");
    assert(res.body.brand === undefined, "a failed read must not produce a brand");
  });

  await check("a read that THREW still answers 200 and says so", async () => {
    const res = await runBrandCrawl(
      input,
      deps({ read: async () => { throw new Error("socket hang up"); } }),
    );
    assert(res.status === 200, "an exception must not become an error the editor reacts to");
    assert(res.body.ok === false, "a thrown read yielded nothing");
    assert(res.body.yield.loaded === false, "a thrown read cannot claim a brand");
  });

  await check("a THIN read does not claim a brand — the 41% case", async () => {
    const res = await runBrandCrawl(input, deps({ read: async () => THIN }));
    assert(res.body.ok === true, "the site was reached");
    assert(res.body.yield.loaded === false, "no colour and no font is not a loaded brand");
    assert(res.body.brand === undefined, "nothing usable was found, so nothing may be written");
    assert(res.body.applied === false, "nothing may be applied");
    assert(
      /could not read much/i.test(res.body.message),
      `thin read said: "${res.body.message}"`,
    );
    assert(
      !/loaded/i.test(res.body.message),
      `a thin read must never say "loaded": "${res.body.message}"`,
    );
  });

  await check("describeCrawl distinguishes all three outcomes by yield, not by ok", () => {
    // ONE url for all three, deliberately. An earlier version of this check
    // built each sentence from its own fixture, so the strings differed by
    // HOSTNAME and the comparison passed even when the wording was identical —
    // caught by mutating describeCrawl to say "brand loaded" unconditionally
    // and watching this test stay green. Same site, different yields, so the
    // only thing that can make the sentences differ is the yield.
    const url = "https://example.com/";
    const unreachable = describeCrawl(url, { ...FAILED, url }, brandExtractYield(FAILED));
    const empty = describeCrawl(url, { ...THIN, url }, brandExtractYield(THIN));
    const good = describeCrawl(url, { ...RICH, url }, brandExtractYield(RICH));
    assert(unreachable !== empty, "unreachable and reached-but-empty must not read the same");
    assert(empty !== good, "reached-but-empty must not read like a loaded brand");
    assert(unreachable !== good, "an unreachable site must not read like a loaded brand");
    assert(empty.includes("example.com"), "the sentence must name the site the user typed");
    assert(/loaded/i.test(good), "a real brand should say so plainly");
    assert(!/loaded/i.test(empty) && !/loaded/i.test(unreachable), "only a real brand may say 'loaded'");
  });

  // ── what actually lands on the document ──────────────────────────────────

  await check("a real extract becomes an accent and a font stack", () => {
    const brand = documentBrandFromExtract(RICH);
    assert(brand !== null, "a site with colour and type must produce a brand");
    assert(brand!.palette.accent === "#635bff", `accent was ${brand!.palette.accent}`);
    const stacks = [brand!.fonts.display, brand!.fonts.body].filter(Boolean).join(" ");
    assert(/Sohne/.test(stacks), `the brand's own face must survive; got "${stacks}"`);
    assert(/sans-serif|serif|monospace/.test(stacks), "every stack must end in a CSS generic");
    assert(
      (brand!.fonts.faces ?? []).some((f) => f.src === "https://stripe.com/sohne.woff2"),
      "the @font-face src must travel with the family or it never loads",
    );
  });

  await check("the canvas colour is NOT set from the crawl", () => {
    const brand = documentBrandFromExtract({ ...RICH, background_color: "#0a0a0a" });
    assert(
      brand!.palette.canvas === undefined,
      "a mis-read canvas turns the whole deck dark — the free tier must not set it",
    );
  });

  await check("a curated FALLBACK font is never written as if it were the brand's", () => {
    // No loadable src → resolveFont falls back to our own curated face. That is
    // our choice, not the brand's, and writing it would claim a yield we do not
    // have. (This is also why `yield.font` is false here.)
    const noSrc: BrandExtract = { ...RICH, fonts: [{ family: "Sohne", src: "" }] };
    const brand = documentBrandFromExtract(noSrc);
    assert(brandExtractYield(noSrc).font === false, "a face with no src is not a recovered font");
    assert(!brand?.fonts.display && !brand?.fonts.body, "no font role may be written from a fallback");
    assert(brand?.palette.accent === "#635bff", "the colour still stands on its own");
  });

  await check("a thin extract produces no brand at all", () => {
    assert(documentBrandFromExtract(THIN) === null, "nothing observed means nothing written");
    assert(documentBrandFromExtract(FAILED) === null, "a failed read must produce nothing");
  });

  await check("a hostile font family from someone else's CSS cannot reach our source", () => {
    const brand = documentBrandFromExtract(HOSTILE);
    const stacks = [brand?.fonts.display, brand?.fonts.body, ...(brand?.fonts.faces ?? []).map((f) => f.family)]
      .filter(Boolean)
      .join(" ");
    // These values are substituted into a file this process later executes.
    assert(!/[;{}()<>\\]/.test(stacks), `CSS injection survived validation: "${stacks}"`);
    assert(brand?.palette.accent === "#ff0055", "the colour is still fine and should still be used");
  });

  // ── applying it, and only where it is safe ───────────────────────────────

  await check("a BLANK document wears the brand immediately", async () => {
    let applied = 0;
    let written = 0;
    const res = await runBrandCrawl(
      input,
      deps({
        read: async () => RICH,
        isBlank: async () => true,
        writeBrand: async () => { written++; },
        applyBrand: async () => { applied++; return { ok: true }; },
      }),
    );
    assert(written === 1, "the brand must be saved for the panel either way");
    assert(applied === 1, "a blank page has nothing to lose — re-skin it");
    assert(res.body.applied === true, "the result must report that it was applied");
  });

  await check("a document with CONTENT is never re-skinned underneath the user", async () => {
    let applied = 0;
    let written = 0;
    const res = await runBrandCrawl(
      input,
      deps({
        read: async () => RICH,
        isBlank: async () => false,
        writeBrand: async () => { written++; },
        applyBrand: async () => { applied++; return { ok: true }; },
      }),
    );
    assert(written === 1, "the brand is still saved — one click in the Brand panel applies it");
    assert(applied === 0, "work in progress must not be restyled by a background job");
    assert(res.body.applied === false, "the result must not claim it was applied");
  });

  await check("a document we cannot READ is treated as having content", async () => {
    // The default blankness check, not an injected one: on a container that
    // has never seen this document the manifest read throws, and the answer
    // has to be "leave it alone". Failing open on an unreadable manifest is
    // the exact bug the generate route was fixed for.
    let applied = 0;
    const over = deps({
      read: async () => RICH,
      applyBrand: async () => { applied++; return { ok: true }; },
      resolveDir: async () => "/nonexistent/renderball-test-gen-dir",
    });
    // OMIT the key rather than set it undefined, so this exercises the real
    // default whatever the merge does with undefined.
    delete over.isBlank;
    const res = await runBrandCrawl(input, over);
    assert(applied === 0, "an unreadable document must not be re-skinned by a background job");
    assert(res.body.applied === false, "and the result must not claim it was");
    assert(res.body.yield.loaded === true, "the read itself still stands");
  });

  await check("an explicitly-undefined override falls through to the default", async () => {
    // `{ ...defaults, ...overrides }` lets `key: undefined` REPLACE a default
    // with undefined; the resulting TypeError is swallowed by the same
    // try/catch that handles a real failure, so the call looks like it
    // declined rather than exploded. Proven here on the real disk writer.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-brand-deps-"));
    try {
      await runBrandCrawl(input, {
        ...deps({ read: async () => RICH }),
        resolveDir: async () => dir,
        isBlank: async () => false,
        writeBrand: undefined,
      });
      const raw = await fs.readFile(path.join(dir, "brand.json"), "utf8");
      assert(
        JSON.parse(raw).palette.accent === "#635bff",
        "the default writer did not run — an undefined override disabled it",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await check("a re-skin that fails does not fail the read", async () => {
    const res = await runBrandCrawl(
      input,
      deps({
        read: async () => RICH,
        applyBrand: async () => { throw new Error("compile check failed"); },
      }),
    );
    assert(res.status === 200, "the brand was still read; only the re-skin failed");
    assert(res.body.applied === false, "and it must say it was not applied");
    assert(res.body.yield.loaded === true, "the yield is about the READ, not the re-skin");
  });

  // ── the extract has to reach the outline ─────────────────────────────────

  await check("the extract lands on the brief, which is what the outline reads", async () => {
    let saved: StoredBrief | null = null;
    await runBrandCrawl(
      input,
      deps({ read: async () => RICH, loadBrief: async () => brief(), saveBrief: async (b) => { saved = b; } }),
    );
    const s = saved as StoredBrief | null;
    assert(s !== null, "nothing was persisted — the outline would never see the brand");
    assert(s!.brand_extract?.palette?.[0] === "#635bff", "brand_extract must carry the palette");
    assert(s!.brand_kit_url === input.url, "brand_kit_url must record where it came from");
    assert(s!.id === "B1" && s!.purpose === "Untitled document", "the rest of the brief must survive");
  });

  await check("a failed read writes NOTHING to the brief", async () => {
    let saves = 0;
    await runBrandCrawl(
      input,
      deps({ read: async () => FAILED, loadBrief: async () => brief(), saveBrief: async () => { saves++; } }),
    );
    assert(saves === 0, "an unreachable site must not overwrite a brief with an empty extract");
  });

  await check("a persistence blip does not fail the read", async () => {
    const res = await runBrandCrawl(
      input,
      deps({
        read: async () => RICH,
        loadBrief: async () => { throw new Error("Neon cold wake"); },
      }),
    );
    assert(res.status === 200 && res.body.yield.loaded === true, "the user's brand result must survive a DB blip");
  });

  // ── the free reader itself ───────────────────────────────────────────────

  await check("normalizeSiteUrl accepts what a person types and refuses what is not a site", () => {
    assert(normalizeSiteUrl("stripe.com") === "https://stripe.com/", "a bare host must get https");
    assert(normalizeSiteUrl("https://stripe.com/pricing") === "https://stripe.com/pricing", "a full URL survives");
    assert(normalizeSiteUrl("  stripe.com  ") === "https://stripe.com/", "whitespace is not the user's problem");
    for (const bad of ["", "   ", "localhost", "not a url", "http://"]) {
      assert(normalizeSiteUrl(bad) === null, `"${bad}" must not start a crawl`);
    }
  });

  await check("siteHost says the site back the way the user says it", () => {
    assert(siteHost("https://www.stripe.com/pricing") === "stripe.com", "no scheme, no www, no path");
  });

  await check("the free reader refuses a non-URL without touching the network", async () => {
    const out = await readSiteBrand("not a url");
    assert(out.ok === false, "a non-URL is a failed read");
    assert(/valid URL/i.test(out.error ?? ""), `error was "${out.error}"`);
  });

  // ── the panel's own trigger ──────────────────────────────────────────────

  await check("the panel does not fire a request at half-typed hostnames", () => {
    // Every accepted value is a real fetch of somebody else's homepage, fired
    // while a person is still typing. The server's normalizeSiteUrl is the
    // authority; this only decides whether to bother.
    for (const typed of ["s", "st", "stripe", "stripe.", "stripe.c", "a.b", "", "  ", "http://"]) {
      assert(!looksLikeSite(typed), `"${typed}" must not fire a crawl`);
    }
    for (const typed of ["stripe.com", "https://stripe.com", "www.stripe.com/pricing", "sub.example.co.uk"]) {
      assert(looksLikeSite(typed), `"${typed}" is a site and should be read`);
    }
  });

  await check("the panel and the server agree on what a site is", () => {
    // Two opinions about this is how a field ends up either never firing or
    // firing 400s on every keystroke. The panel may be STRICTER (it cannot
    // import the server's version — that graph reaches `fs`), never looser.
    for (const typed of ["stripe.com", "https://stripe.com/pricing", "sub.example.co.uk"]) {
      assert(
        !looksLikeSite(typed) || normalizeSiteUrl(typed) !== null,
        `the panel would fire "${typed}" at a server that rejects it`,
      );
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
