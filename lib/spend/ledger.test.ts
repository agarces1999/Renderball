/**
 * The spend arithmetic — the part that has to be right.
 *
 * Run: `node scripts/run-tests.mjs lib/spend/ledger.test.ts`. No database, no
 * network, no clock: summarize() takes `now` as an argument precisely so these
 * can pin the boundaries that a real clock would make untestable.
 *
 * The failure being defended against is not "the sum is wrong by a cent". It is
 * the shape of the August 2026 miss: a number that LOOKS exact — clean total,
 * tidy breakdown — while a whole category of spend is missing from it. So the
 * boundary cases (UTC day/month edges, empty ledger, unknown model, a build
 * with no outline in front of it) are the tests, not the happy path.
 */
import {
  dayStartUtc,
  monthStartUtc,
  nextDayStartUtc,
  nextMonthStartUtc,
  percentile,
  stageFamily,
  summarize,
  toNanoUsd,
  utcDayKey,
  type LedgerRow,
} from "./ledger";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const near = (a: number, b: number, eps = 1e-9) => {
  if (Math.abs(a - b) > eps) throw new Error(`expected ${a} ≈ ${b}`);
};

/** A row with sane defaults; every test overrides only what it is about. */
const row = (over: Omit<Partial<LedgerRow>, "at"> & { at: string }): LedgerRow => ({
  at: new Date(over.at),
  stage: over.stage ?? "build",
  model: over.model ?? "glm-5.2",
  costUsd: over.costUsd ?? 1,
  inputTokens: over.inputTokens ?? 1000,
  outputTokens: over.outputTokens ?? 500,
  cachedTokens: over.cachedTokens ?? 0,
  images: over.images ?? 0,
  scriptId: over.scriptId ?? null,
  ownerId: over.ownerId ?? null,
  origin: over.origin ?? "web",
  ok: over.ok ?? true,
  tokensUnknown: over.tokensUnknown ?? false,
  latencyMs: over.latencyMs ?? null,
  source: over.source ?? "postgres",
});

// A deliberately awkward `now`: mid-month, mid-day, and in a month whose
// boundary is not also a year boundary.
const NOW = new Date("2026-08-08T14:30:00.000Z");

// ── window boundaries ────────────────────────────────────────────────────

check("dayStartUtc / monthStartUtc land on the UTC midnight of their window", () => {
  assert(dayStartUtc(NOW).toISOString() === "2026-08-08T00:00:00.000Z", "day start");
  assert(monthStartUtc(NOW).toISOString() === "2026-08-01T00:00:00.000Z", "month start");
  assert(nextDayStartUtc(NOW).toISOString() === "2026-08-09T00:00:00.000Z", "next day");
  assert(nextMonthStartUtc(NOW).toISOString() === "2026-09-01T00:00:00.000Z", "next month");
});

check("December rolls over to January of the NEXT year", () => {
  const dec = new Date("2026-12-31T23:00:00.000Z");
  assert(nextMonthStartUtc(dec).toISOString() === "2027-01-01T00:00:00.000Z", "year rollover");
  assert(nextDayStartUtc(dec).toISOString() === "2027-01-01T00:00:00.000Z", "day rollover");
});

check("the UTC day boundary is exact on both sides", () => {
  const s = summarize(
    [
      row({ at: "2026-08-07T23:59:59.999Z", costUsd: 5 }), // yesterday
      row({ at: "2026-08-08T00:00:00.000Z", costUsd: 2 }), // first instant of today
      row({ at: "2026-08-08T14:29:59.000Z", costUsd: 3 }), // today
    ],
    { now: NOW },
  );
  near(s.today.costUsd, 5);
  assert(s.today.calls === 2, `today should hold 2 calls, held ${s.today.calls}`);
  near(s.month.costUsd, 10);
});

check("'today' follows UTC, not the machine's local day", () => {
  // 02:00 UTC on the 8th is still the 7th in every timezone west of UTC. A
  // local-time implementation puts this row in "yesterday" for a US developer
  // and in "today" for the Railway container, which is two different answers
  // to the same question about the same ledger.
  const s = summarize([row({ at: "2026-08-08T02:00:00.000Z", costUsd: 4 })], { now: NOW });
  near(s.today.costUsd, 4);
  assert(s.today.calls === 1, "the 02:00 UTC row belongs to today");
});

check("month-to-date starts at the 1st and excludes the previous month", () => {
  const s = summarize(
    [
      row({ at: "2026-07-31T23:59:59.000Z", costUsd: 9 }),
      row({ at: "2026-08-01T00:00:00.000Z", costUsd: 1 }),
      row({ at: "2026-08-08T00:00:00.000Z", costUsd: 2 }),
    ],
    { now: NOW },
  );
  near(s.month.costUsd, 3);
  near(s.all.costUsd, 12); // `all` is every row handed in, whatever the window
});

// ── money ────────────────────────────────────────────────────────────────

check("the total keeps all 8 decimals the ledger column stores", () => {
  // SpendRecord.costUsd is Decimal(14,8). Summing at any coarser scale reports
  // a number that disagrees with the database in exactly the digits the schema
  // went out of its way to keep — and rounds the cheapest calls to nothing.
  // These values are chosen so a micro-dollar (1e6) implementation returns
  // $0.12345700 against the true $0.12345684, and so five 1e-8 rows vanish.
  const costs = [0.00000001, 0.00000001, 0.00000001, 0.00000001, 0.12345678, 0.00000004];
  const rows = costs.map((c, i) => row({ at: `2026-08-08T0${i}:00:00.000Z`, costUsd: c }));
  const total = summarize(rows, { now: NOW }).today.costUsd;
  const expected = costs.reduce((s, c) => s + Math.round(c * 1e8), 0) / 1e8;
  assert(
    total.toFixed(8) === expected.toFixed(8),
    `total ${total.toFixed(8)} != exact ${expected.toFixed(8)} — the sum is losing stored precision`,
  );
  assert(toNanoUsd(0.00000001) === 1, "one 1e-8 dollar is one unit, not zero");
});

check("sub-cent rows do not round away to nothing", () => {
  // 40,000 calls at $0.0000005 is $0.02 of real money. At micro-dollar scale
  // each one rounds to zero and the whole lot disappears from the report.
  const rows = Array.from({ length: 40 }, (_, i) =>
    row({ at: "2026-08-08T05:00:00.000Z", costUsd: 0.0000005 }),
  );
  const total = summarize(rows, { now: NOW }).today.costUsd;
  assert(total > 0, "40 sub-microdollar calls must not total $0.00");
  near(total, 0.00002, 1e-12);
});

check("the total does not depend on row order", () => {
  const costs = [0.000001, 0.1, 0.0000005, 12.345678, 0.07, 3.3333333];
  const rows = costs.map((c, i) => row({ at: `2026-08-08T0${i}:00:00.000Z`, costUsd: c }));
  const forward = summarize(rows, { now: NOW }).today.costUsd;
  const backward = summarize([...rows].reverse(), { now: NOW }).today.costUsd;
  assert(forward === backward, `order changed the total: ${forward} vs ${backward}`);
});

check("failed calls are inside the total AND separately visible", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", costUsd: 2, ok: true }),
      row({ at: "2026-08-08T02:00:00.000Z", costUsd: 3, ok: false }),
    ],
    { now: NOW },
  );
  // A build we paid for and threw away is money that left the account.
  near(s.today.costUsd, 5);
  assert(s.today.failedCalls === 1, "one failed call");
  near(s.today.failedCostUsd, 3);
});

// ── empty ledger ─────────────────────────────────────────────────────────

check("an empty ledger reports zeros, never NaN, and says it is empty", () => {
  const s = summarize([], { now: NOW });
  near(s.today.costUsd, 0);
  near(s.month.costUsd, 0);
  assert(s.today.calls === 0 && s.month.calls === 0, "no calls");
  assert(s.perDeck.decks === 0, "no decks");
  near(s.perDeck.meanUsd, 0);
  near(s.perDeck.p50Usd, 0);
  near(s.perDeck.p90Usd, 0);
  assert(!Number.isNaN(s.perDeck.meanUsd), "mean of nothing must be 0, not NaN");
  assert(s.byStage.length === 0 && s.byModel.length === 0, "no groups");
  assert(
    s.integrity.warnings.some((w) => w.includes("EMPTY")),
    "an empty window must say so — $0.00 alone reads as 'we spent nothing'",
  );
  assert(s.integrity.lastRowAt === null && s.integrity.hoursSinceLastRow === null, "no last row");
});

// ── unknown model ────────────────────────────────────────────────────────

check("a row on an unpriced model is flagged, with the amount that is a guess", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", model: "glm-5.2", costUsd: 1 }),
      row({ at: "2026-08-08T02:00:00.000Z", model: "accounts/fireworks/models/brand-new-thing", costUsd: 4 }),
    ],
    { now: NOW },
  );
  near(s.today.costUsd, 5); // still counted — unknown price, not unknown spend
  assert(s.integrity.fallbackPricedCalls === 1, "one fallback-priced call");
  near(s.integrity.fallbackPricedCostUsd, 4);
  assert(
    s.integrity.fallbackModels.includes("accounts/fireworks/models/brand-new-thing"),
    "the model must be named so it can be added to RATES",
  );
  assert(
    s.integrity.warnings.some((w) => w.includes("FALLBACK")),
    "an unpriced model must be called out, not silently billed at the Sonnet rate",
  );
});

check("known Fireworks wire ids are NOT flagged as fallback-priced", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", model: "accounts/fireworks/routers/glm-5p2-fast" }),
      row({ at: "2026-08-08T02:00:00.000Z", model: "accounts/fireworks/models/kimi-k2p6" }),
    ],
    { now: NOW },
  );
  assert(
    s.integrity.fallbackPricedCalls === 0,
    "the live text and vision models are in RATES; flagging them would cry wolf every run",
  );
});

// ── the August defect, as a check ────────────────────────────────────────

check("builds with ZERO outline and crawl rows are reported as structurally incomplete", () => {
  // This is exactly what .data/usage.jsonl held for August: 6 builds, zero
  // "generate" rows, zero "crawl" rows, and a total that looked fine.
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", stage: "build" }),
      row({ at: "2026-08-08T02:00:00.000Z", stage: "build.fill" }),
    ],
    { now: NOW },
  );
  assert(
    s.integrity.missingStages.includes("outline") && s.integrity.missingStages.includes("crawl"),
    `expected outline+crawl missing, got ${JSON.stringify(s.integrity.missingStages)}`,
  );
  assert(s.integrity.warnings.some((w) => w.includes("LOW")), "the total must be called a floor");
});

check("a complete window reports no missing stages", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", stage: "crawl" }),
      row({ at: "2026-08-08T02:00:00.000Z", stage: "outline" }),
      row({ at: "2026-08-08T03:00:00.000Z", stage: "build.fill" }),
      row({ at: "2026-08-08T04:00:00.000Z", stage: "vision" }),
    ],
    { now: NOW },
  );
  assert(
    s.integrity.missingStages.length === 0,
    `nothing should be missing, got ${JSON.stringify(s.integrity.missingStages)}`,
  );
});

check("with no build rows at all, nothing is declared missing", () => {
  // A window of pure editor spend is not incomplete — it is a different day.
  const s = summarize([row({ at: "2026-08-08T01:00:00.000Z", stage: "edit.insert" })], { now: NOW });
  assert(s.integrity.missingStages.length === 0, "editing alone implies no outline");
});

check("stageFamily collapses a dotted stage to its family", () => {
  assert(stageFamily("build.fill") === "build", "build.fill");
  assert(stageFamily("outline") === "outline", "outline");
  assert(stageFamily("edit.regen") === "edit", "edit.regen");
});

// ── the honest floor ─────────────────────────────────────────────────────

check("calls that died before reporting usage are counted, priced at zero, and named", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", costUsd: 2 }),
      row({
        at: "2026-08-08T02:00:00.000Z",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensUnknown: true,
        latencyMs: 310_000,
      }),
      row({
        at: "2026-08-08T03:00:00.000Z",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensUnknown: true,
        latencyMs: 20_000,
      }),
    ],
    { now: NOW },
  );
  near(s.today.costUsd, 2); // never a fabricated estimate for the dead calls
  assert(s.integrity.tokensUnknownCalls === 2, "two uncounted calls");
  assert(s.integrity.tokensUnknownSeconds === 330, `total seconds, got ${s.integrity.tokensUnknownSeconds}`);
  assert(s.integrity.tokensUnknownWorstSeconds === 310, "worst call's seconds");
  assert(
    s.integrity.warnings.some((w) => w.includes("FLOOR")),
    "the total must be described as a floor when calls are uncounted",
  );
});

check("a row that burned tokens and priced at $0 is flagged", () => {
  // The app/new/actions.ts:374 shape: `costUsd: 0` written next to a real
  // usage object. A cost column that is zero half the time is worse than none.
  const s = summarize(
    [row({ at: "2026-08-08T01:00:00.000Z", costUsd: 0, inputTokens: 8000, outputTokens: 4000 })],
    { now: NOW },
  );
  assert(s.integrity.zeroCostWithTokens === 1, "one zero-cost-with-tokens row");
  assert(s.integrity.warnings.some((w) => w.includes("$0.00")), "must be called out");
});

// ── groupings and per-deck ───────────────────────────────────────────────

check("stages and models group with shares that sum to the window total", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", stage: "crawl", model: "glm-5.2", costUsd: 1 }),
      row({ at: "2026-08-08T02:00:00.000Z", stage: "build.fill", model: "glm-5.2", costUsd: 3 }),
      row({
        at: "2026-08-08T03:00:00.000Z",
        stage: "vision",
        model: "accounts/fireworks/models/kimi-k2p6",
        costUsd: 1,
      }),
    ],
    { now: NOW },
  );
  assert(s.byStage[0].key === "build.fill", "most expensive stage sorts first");
  near(s.byStage[0].share, 0.6);
  near(
    s.byStage.reduce((t, g) => t + g.costUsd, 0),
    5,
  );
  assert(s.byModel.length === 2, "two models");
});

check("cost per deck sums every stage of a deck, including its failed attempts", () => {
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", scriptId: "deckA", stage: "crawl", costUsd: 0.2 }),
      row({ at: "2026-08-08T02:00:00.000Z", scriptId: "deckA", stage: "build", costUsd: 1.0, ok: false }),
      row({ at: "2026-08-08T03:00:00.000Z", scriptId: "deckA", stage: "build", costUsd: 1.3 }),
      row({ at: "2026-08-08T04:00:00.000Z", scriptId: "deckB", stage: "build", costUsd: 0.5 }),
      row({ at: "2026-08-08T05:00:00.000Z", scriptId: null, stage: "crawl", costUsd: 9 }),
    ],
    { now: NOW },
  );
  assert(s.decks.length === 2, `two decks, got ${s.decks.length}`);
  assert(s.decks[0].scriptId === "deckA", "most expensive deck first");
  // 0.2 + 1.0 (the attempt we threw away) + 1.3 — the deck cost us all three.
  near(s.decks[0].costUsd, 2.5);
  assert(s.decks[0].calls === 3, "three calls on deck A");
  assert(s.decks[0].stages.join(",") === "build,crawl", "stages listed, sorted");
  near(s.perDeck.meanUsd, 1.5);
});

check("percentiles use nearest-rank and never index out of bounds", () => {
  near(percentile([], 0.5), 0);
  near(percentile([1], 0.9), 1);
  near(percentile([1, 2, 3, 4], 0.5), 2);
  near(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  near(percentile([1, 2, 3], 1), 3);
  near(percentile([1, 2, 3], 0), 1);
});

// ── provenance ───────────────────────────────────────────────────────────

check("mixing Postgres with the LEGACY file warns about double counting", () => {
  // recordUsage and recordSpend both run today, so the same money is in both.
  const s = summarize(
    [
      row({ at: "2026-08-08T01:00:00.000Z", source: "postgres" }),
      row({ at: "2026-08-08T02:00:00.000Z", source: "usage-jsonl" }),
    ],
    { now: NOW },
  );
  assert(s.integrity.fromPostgres === 1 && s.integrity.fromLegacyFile === 1, "counts by source");
  assert(
    s.integrity.warnings.some((w) => w.includes("DOUBLE COUNTS")),
    "a merged read must warn",
  );
});

check("file-only rows warn that production spend is not in the number", () => {
  const s = summarize([row({ at: "2026-08-08T01:00:00.000Z", source: "spend-jsonl" })], { now: NOW });
  assert(s.integrity.fromFallbackFile === 1, "counted as fallback-file");
  assert(
    s.integrity.warnings.some((w) => w.includes("PRODUCTION")),
    "reading local files only must say production is missing",
  );
  assert(
    s.integrity.warnings.some((w) => w.includes("ephemeral")),
    "and that the file does not survive a deploy",
  );
});

check("a stale ledger is reported as stale", () => {
  const s = summarize([row({ at: "2026-08-06T01:00:00.000Z", costUsd: 1 })], { now: NOW });
  assert(s.integrity.hoursSinceLastRow !== null && s.integrity.hoursSinceLastRow > 24, "stale");
  assert(
    s.integrity.warnings.some((w) => w.includes("recording broke")),
    "silence has two explanations and the report must name both",
  );
});

check("utcDayKey is the ISO date, used as the alert dedupe key", () => {
  assert(utcDayKey(new Date("2026-08-08T23:59:59Z")) === "2026-08-08", "same day at 23:59Z");
  assert(utcDayKey(new Date("2026-08-09T00:00:00Z")) === "2026-08-09", "next day at 00:00Z");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
