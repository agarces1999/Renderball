import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId } from "../../../../lib/store";
import { checkEntitlement } from "../../../../lib/entitlement";
import { checkTokenAllowance } from "../../../../lib/metering";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { buildStatus } from "../../../../lib/render/build-jobs";
import {
  brandJobKey,
  requestedTier,
  startBrandCrawl,
  tierSpends,
  TIER_COST,
} from "../../../../lib/documents/brand-crawl";
import { normalizeSiteUrl } from "../../../../lib/documents/site-brand";

/**
 * Read a document's brand off the user's website — always available, never a
 * gate, and free unless they ask for the paid read.
 *
 * WHY THIS ROUTE EXISTS. Since the 2026-07-23 pivot the crawl had no live call
 * site at all: the front door moved to /api/documents/new and `extractBrand`
 * did not come with it (last successful extract in the database: 2026-07-24).
 * The URL field survived only inside "generate every page", so the whole
 * "build it myself" half of the product could never say what its brand was.
 *
 * TWO TIERS, ONE OF THEM FREE.
 *   free   — lib/documents/site-brand.ts. No model call; measured median 1.4s
 *            (max 4.6s) over ten live sites. This is what runs by itself,
 *            including from document creation.
 *   vision — the full lib/crawl/extract-brand crawl: ~$0.0043, 10-25s, three
 *            model calls. Reachable ONLY with a literal `vision: true` in the
 *            body, which is a button the user pressed, and only after the same
 *            breaker/entitlement/allowance gates that guard generation.
 * The gates below are on `tierSpends(tier)`, not on a hard-coded tier name, so
 * a future tier cannot be added into the free lane by accident.
 *
 * OFF THE REQUEST, like the outline. The read runs under build-jobs so a slow
 * site can never hold the response open (the origin sits behind Cloudflare,
 * whose origin-response timeout is 100s) and, more importantly, so document
 * creation stays instant.
 *
 * POST { scriptId, url, vision? } → 202 { status: "running" }
 * GET  ?scriptId=…                → { status, result, resultStatus }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { scriptId?: string; url?: string; vision?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const scriptId = body.scriptId;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? normalizeSiteUrl(body.url) : null;
  if (!url) {
    return NextResponse.json(
      { error: "That doesn't look like a website address." },
      { status: 400 },
    );
  }

  // Ownership: the document must exist and be theirs. 404 rather than 403 —
  // "you may not touch this" confirms the id exists.
  const brief = await loadBriefByScriptId(scriptId, user.id);
  if (!brief) return NextResponse.json({ error: "document not found" }, { status: 404 });

  const tier = requestedTier(body.vision);

  if (tierSpends(tier)) {
    // Everything from here to startBrandCrawl exists because this tier costs
    // money. The free tier passes none of it, which is the point.
    try {
      assertZaiAvailable();
    } catch (err) {
      if (err instanceof ZaiUnavailableError) {
        return NextResponse.json({ error: err.friendly }, { status: 503 });
      }
      throw err;
    }
    const ent = await checkEntitlement(user.id, "generate");
    if (!ent.allowed) {
      return NextResponse.json({ error: ent.reason ?? "plan limit reached" }, { status: 402 });
    }
    const gate = await checkTokenAllowance(user.id);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: gate.reason ?? "token allowance exhausted" },
        { status: 402 },
      );
    }
  }

  startBrandCrawl({ scriptId, ownerId: user.id, url, tier });

  // 202 always, even for the free read. It finishes in ~1.4s, which is inside
  // build-jobs' grace window — waiting for it would put the crawl back on the
  // request, and this route is called the moment a URL is typed.
  return NextResponse.json(
    { status: "running", scriptId, tier, cost: TIER_COST[tier] },
    { status: 202 },
  );
}

/**
 * Poll a brand read. Same contract as the outline poll
 * (app/api/documents/generate/route.ts) so the client machinery matches.
 *
 * `unknown` is not a failure: build-jobs state is in-process, so a container
 * restart loses it. The panel treats unknown as "nothing to say" and the
 * document is unaffected either way.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const owned = await loadBriefByScriptId(scriptId, user.id);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = buildStatus(brandJobKey(scriptId));
  if (job.state === "done") {
    return NextResponse.json({ status: "done", result: job.body, resultStatus: job.status });
  }
  if (job.state === "error") {
    return NextResponse.json({ status: "error", error: job.message });
  }
  return NextResponse.json({ status: job.state });
}
