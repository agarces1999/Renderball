import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { isAdminConfigured, isAdminUser } from "../../../../lib/admin";
import { loadSpendRows } from "../../../../lib/spend/source";
import { monthStartUtc, summarize, type GroupWindow } from "../../../../lib/spend/ledger";
import { checkSpendThresholds, spendThresholds } from "../../../../lib/spend/cap";
import { spendCapState } from "../../../../lib/zai-breaker";

/**
 * GET /api/admin/spend — what we are paying Fireworks, in production.
 *
 * NOT ON /api/health, and that is not a judgement call: app/api/health/route.ts
 * states the rule about itself — "Public on purpose … this endpoint reveals
 * whether a dependency is reachable and NOTHING about what is in it. No counts,
 * no ids, no configuration values." Dollar spend is a count about what is in
 * it, and publishing it hands anyone who curls the site our unit economics and
 * our volume. Health keeps one boolean (`spendCap`), which is outage-shaped and
 * exposes no number; everything with a dollar sign on it lives here, behind the
 * same Clerk session the rest of the account surface uses, plus an allowlist.
 *
 * Query:
 *   ?window=today|month|all   which window the breakdowns cover (default month)
 *   ?since=ISO&until=ISO      an explicit range (overrides window bounds)
 *   ?includeJsonl=1           merge the legacy .data/usage.jsonl — see the
 *                             double-count warning in lib/spend/source.ts
 *
 * Same numbers as `npm run spend`, from the same aggregation function, so the
 * CLI and the API can never disagree about what a day cost.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminUser(user)) {
    // 403 rather than 404, and it says whether the allowlist is configured at
    // all. The caller is already authenticated, so this leaks nothing to the
    // public — and "I set the env var and it still says no" is exactly the
    // 2am failure that a bare 404 makes unsolvable.
    return NextResponse.json(
      { error: "not an admin", allowlistConfigured: isAdminConfigured() },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const now = new Date();

  const parseDate = (raw: string | null): Date | undefined => {
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const windowParam = url.searchParams.get("window");
  const groupWindow: GroupWindow =
    windowParam === "today" || windowParam === "all" ? windowParam : "month";
  const since = parseDate(url.searchParams.get("since"));
  const until = parseDate(url.searchParams.get("until"));
  const includeJsonl = url.searchParams.get("includeJsonl") === "1";

  // Default read is the current UTC month: it covers today and month-to-date,
  // which is every number on this surface. "all" reads everything.
  const loaded = await loadSpendRows({
    since: since ?? (groupWindow === "all" ? undefined : monthStartUtc(now)),
    until,
    includeJsonl,
  });
  const summary = summarize(loaded.rows, { now, groupWindow });

  // Hitting this surface also re-evaluates the thresholds (throttled inside),
  // so opening the page cannot show a breach that never alerted.
  void checkSpendThresholds(now);

  return NextResponse.json(
    {
      generatedAt: now.toISOString(),
      timezone: "UTC",
      source: loaded.source,
      notes: loaded.notes,
      window: {
        groupWindow,
        dayStart: summary.dayStart.toISOString(),
        monthStart: summary.monthStart.toISOString(),
        since: since?.toISOString() ?? null,
        until: until?.toISOString() ?? null,
      },
      today: summary.today,
      month: summary.month,
      all: summary.all,
      byStage: summary.byStage,
      byModel: summary.byModel,
      byOrigin: summary.byOrigin,
      perDeck: summary.perDeck,
      // Ids only, no brief text — this is a cost surface, not a content one.
      topDecks: summary.decks.slice(0, 10),
      integrity: {
        ...summary.integrity,
        lastRowAt: summary.integrity.lastRowAt?.toISOString() ?? null,
      },
      thresholds: spendThresholds(),
      cap: spendCapState(),
    },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
