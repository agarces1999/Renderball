/**
 * What did we spend, exactly.
 *
 * THE FAILURE THIS EXISTS FOR (2026-08-08): Fireworks' dashboard said $37.69
 * for August. Our own records covered $6.52 of it. The rest had to be
 * ESTIMATED, and the estimate was ~50% low. Fireworks has no usage or billing
 * API to reconcile against — /v1/accounts/{id}/usage, /billing and /invoices
 * all 404 on this account, only /v1/accounts and the account itself answer —
 * so OUR ledger has to BE the exact number. Every completion response already
 * carries prompt_tokens / completion_tokens; nothing was missing except a
 * place to put them and something that reads them back.
 *
 * This module is the READ side, and it is deliberately PURE: no database, no
 * filesystem, no clock of its own. It takes rows and a `now` and returns the
 * numbers. That is what makes the arithmetic — UTC day boundaries, month to
 * date, cost per deck — testable without a Postgres, which is the only reason
 * anyone will trust it at 2am.
 *
 * The write side (recordSpend / SpendRecord) is lib/spend/record.ts; the row
 * loader that bridges Postgres and the legacy JSONL is lib/spend/source.ts.
 */
import { isPricedModel } from "../usage";

/**
 * One billed call, normalized for READING.
 *
 * Named LedgerRow, not SpendRow, because lib/spend/record.ts already exports a
 * `SpendRow` — the WRITE shape, which carries provider/rateVersion/runId and
 * nothing about where it was read from. Two same-named types with different
 * fields in one feature is a trap for whoever next has to trace a number, so
 * they are named for their sides.
 *
 * Postgres SpendRecord rows, the `.data/spend.jsonl` fallback file, and the
 * legacy `.data/usage.jsonl` all land in this shape (lib/spend/source.ts) so
 * the arithmetic below never has to know where a row came from.
 */
export interface LedgerRow {
  /** When the call was billed. Always UTC — see `dayStartUtc`. */
  at: Date;
  /** "crawl" | "outline" | "build.fill" | "gate.vision" | … | "unattributed" */
  stage: string;
  /** The WIRE model id, because that is what the provider bills. */
  model: string;
  /** USD, priced at write time by lib/usage.ts costUsd(). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  images: number;
  /** The deck this call belongs to, when the caller knew. */
  scriptId: string | null;
  ownerId: string | null;
  /** "web" | "script" | "test" | "legacy-jsonl" — offline spend is still ours. */
  origin: string;
  /** false = we paid and got nothing usable. Real money either way. */
  ok: boolean;
  /** The provider billed but reported no token count. The total is a FLOOR. */
  tokensUnknown: boolean;
  /** How long the call ran. For a tokensUnknown row this is the only bound we have. */
  latencyMs: number | null;
  /** Which loader produced this row, for the integrity report. */
  source: "postgres" | "spend-jsonl" | "usage-jsonl";
}

// ── MONEY ────────────────────────────────────────────────────────────────
//
// Sums run in integer units of 1e-8 USD, matching SpendRecord.costUsd's
// Decimal(14,8) EXACTLY.
//
// The scale is the whole point, and it was picked by measurement rather than
// by feel. An earlier version of this summed in micro-dollars (1e6) on the
// theory that a float sum is order-dependent. That theory is WRONG at this
// magnitude — measured: forward and reversed sums of realistic per-call costs
// are bit-identical, because after scaling they are integers well inside
// double precision. What micro-dollars actually did was quietly TRUNCATE the
// column: a ledger of [0.00000001, 0.00000001, 0.12345678, 0.00000004] sums to
// $0.12345684 exactly and to $0.12345700 in micro-dollars — the report
// disagreeing with the database in the digits the schema deliberately kept.
//
// So: 1e8, the column's own precision. Our total is then the same number
// Postgres SUM(numeric) would return, to the last stored digit, and it cannot
// drift with read order or pagination. Headroom is $90,071,992 before
// Number.MAX_SAFE_INTEGER is a concern — several orders of magnitude past any
// plausible provider bill.

/** USD → integer units of 1e-8 USD (SpendRecord.costUsd's stored precision). */
export const toNanoUsd = (usd: number): number => Math.round(usd * 1e8);
export const fromNanoUsd = (nano: number): number => nano / 1e8;

// ── UTC WINDOWS ──────────────────────────────────────────────────────────
//
// Everything is UTC, and every surface says so.
//
// The ledger's timestamps are UTC, Railway containers run UTC, and the
// provider dashboard we reconcile against is not going to adopt anyone's
// local timezone. A "today" that follows the reader's laptop would make the
// founder in CEST and the container in UTC disagree about the same ledger for
// two hours every night — and disagree hardest right at midnight, when a
// runaway build is most likely to be running unattended.

export const dayStartUtc = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const nextDayStartUtc = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

export const monthStartUtc = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export const nextMonthStartUtc = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** "2026-08-08" — the UTC day key used for alert dedupe and grouping. */
export const utcDayKey = (d: Date): string => d.toISOString().slice(0, 10);
/** "2026-08" — the UTC month key. */
export const utcMonthKey = (d: Date): string => d.toISOString().slice(0, 7);

// ── AGGREGATION ──────────────────────────────────────────────────────────

export interface Bucket {
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  images: number;
  /** Calls that spent money and produced nothing usable. Counted in costUsd. */
  failedCalls: number;
  failedCostUsd: number;
}

export interface GroupRow {
  key: string;
  costUsd: number;
  calls: number;
  /** Share of the window's total cost, 0-1. Zero when the window cost is 0. */
  share: number;
}

export interface DeckRow {
  scriptId: string;
  costUsd: number;
  calls: number;
  stages: string[];
  firstAt: Date;
  lastAt: Date;
}

export interface PerDeck {
  decks: number;
  meanUsd: number;
  p50Usd: number;
  p90Usd: number;
}

export interface IntegrityReport {
  rows: number;
  fromPostgres: number;
  /** Rows that never reached Postgres and landed in `.data/spend.jsonl`. */
  fromFallbackFile: number;
  /** Rows from the pre-SpendRecord `.data/usage.jsonl` (opt-in). */
  fromLegacyFile: number;
  /** Billed calls whose token count the provider never reported. */
  tokensUnknownCalls: number;
  /**
   * Seconds those calls ran before dying, total and worst.
   *
   * The ONLY honest thing that can be said about a call whose response we
   * never read: no dollar figure is attached, ever. But the count plus the
   * elapsed time bounds the error and doubles as a bug signal — a call that
   * ran 300s produced generation we were billed for. Investigate, do not
   * estimate. (Same discipline as lib/agents/pipeline.ts:485, which records a
   * zero-usage marker rather than a fabricated one.)
   */
  tokensUnknownSeconds: number;
  tokensUnknownWorstSeconds: number;
  /** Calls priced by a FALLBACK rate because the model is not in the table. */
  fallbackPricedCalls: number;
  fallbackPricedCostUsd: number;
  fallbackModels: string[];
  /** Rows that burned tokens and recorded $0 — the app/new/actions.ts:374 shape. */
  zeroCostWithTokens: number;
  /** Calls recorded with no stage attribution. Counted, never dropped. */
  unattributedCalls: number;
  /** Stage families that MUST accompany a build and are absent. THE August bug. */
  missingStages: string[];
  lastRowAt: Date | null;
  hoursSinceLastRow: number | null;
  /** Ready-to-print sentences. Empty means nothing looks structurally wrong. */
  warnings: string[];
}

export interface SpendSummary {
  now: Date;
  dayStart: Date;
  monthStart: Date;
  today: Bucket;
  month: Bucket;
  /** Every row handed in, whatever window it falls in. */
  all: Bucket;
  /** Which window the groupings below cover. */
  groupWindow: GroupWindow;
  byStage: GroupRow[];
  byModel: GroupRow[];
  byOrigin: GroupRow[];
  /** Decks in the group window, most expensive first. */
  decks: DeckRow[];
  perDeck: PerDeck;
  integrity: IntegrityReport;
}

export type GroupWindow = "today" | "month" | "all";

const emptyBucket = (): Bucket => ({
  costUsd: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  images: 0,
  failedCalls: 0,
  failedCostUsd: 0,
});

/** Accumulator in 1e-8 USD units; converted once at the end. */
interface RawBucket {
  nano: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  images: number;
  failedCalls: number;
  failedNano: number;
}
const rawBucket = (): RawBucket => ({
  nano: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  images: 0,
  failedCalls: 0,
  failedNano: 0,
});
const addRow = (b: RawBucket, r: LedgerRow): void => {
  const m = toNanoUsd(r.costUsd);
  b.nano += m;
  b.calls += 1;
  b.inputTokens += r.inputTokens;
  b.outputTokens += r.outputTokens;
  b.cachedTokens += r.cachedTokens;
  b.images += r.images;
  if (!r.ok) {
    b.failedCalls += 1;
    b.failedNano += m;
  }
};
const seal = (b: RawBucket): Bucket => ({
  costUsd: fromNanoUsd(b.nano),
  calls: b.calls,
  inputTokens: b.inputTokens,
  outputTokens: b.outputTokens,
  cachedTokens: b.cachedTokens,
  images: b.images,
  failedCalls: b.failedCalls,
  failedCostUsd: fromNanoUsd(b.failedNano),
});

/**
 * Nearest-rank percentile over a sorted ascending array.
 * Empty → 0, so an empty ledger reports zeros rather than NaN. A NaN in a
 * money report is worse than a zero: it reads as "broken" when the honest
 * answer is "nothing recorded yet".
 */
export const percentile = (sortedAsc: number[], q: number): number => {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(q * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
};

/** "build.fill" → "build". The family is what the integrity check reasons about. */
export const stageFamily = (stage: string): string => stage.split(".")[0];

/**
 * Stage families that cannot legitimately be absent once a build has run.
 *
 * This is the August 2026 defect encoded as a check. Summing the JSONL for
 * ts >= 2026-08-01 gave $6.5177 over 110 rows with SIX recorded builds and
 * ZERO "generate" rows and ZERO "crawl" rows for the entire month — every
 * deck was crawled and outlined, none of it was recorded. A ledger cannot
 * know what it never saw, but it CAN know that a build with no outline in
 * front of it is impossible, and say so instead of reporting the gap as a
 * total.
 */
const REQUIRED_ALONGSIDE_BUILD = ["outline", "crawl"];

const bucketRows = (rows: LedgerRow[], from: Date, to?: Date): LedgerRow[] =>
  rows.filter((r) => r.at >= from && (to === undefined || r.at < to));

/** Exported so the CLI can group by day/owner without a second implementation. */
export const groupBy = (rows: LedgerRow[], key: (r: LedgerRow) => string): GroupRow[] => {
  const acc = new Map<string, { nano: number; calls: number }>();
  let totalNano = 0;
  for (const r of rows) {
    const k = key(r);
    const e = acc.get(k) ?? { nano: 0, calls: 0 };
    const m = toNanoUsd(r.costUsd);
    e.nano += m;
    e.calls += 1;
    totalNano += m;
    acc.set(k, e);
  }
  return [...acc.entries()]
    .map(([k, e]) => ({
      key: k,
      costUsd: fromNanoUsd(e.nano),
      calls: e.calls,
      share: totalNano === 0 ? 0 : e.nano / totalNano,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
};

/**
 * Cost per deck INCLUDES failed attempts, deliberately.
 *
 * scripts/usage-report.mjs excludes them so "avg per build" means the cost of
 * a successful video. That answers a different question from the one being
 * asked here. A deck that needed three build attempts cost us all three, and
 * unit economics that quietly drop the retries will under-price the product
 * by exactly the amount that hurts.
 */
const deckRows = (rows: LedgerRow[]): DeckRow[] => {
  const acc = new Map<string, { nano: number; calls: number; stages: Set<string>; first: Date; last: Date }>();
  for (const r of rows) {
    if (!r.scriptId) continue;
    const e =
      acc.get(r.scriptId) ??
      { nano: 0, calls: 0, stages: new Set<string>(), first: r.at, last: r.at };
    e.nano += toNanoUsd(r.costUsd);
    e.calls += 1;
    e.stages.add(r.stage);
    if (r.at < e.first) e.first = r.at;
    if (r.at > e.last) e.last = r.at;
    acc.set(r.scriptId, e);
  }
  return [...acc.entries()]
    .map(([scriptId, e]) => ({
      scriptId,
      costUsd: fromNanoUsd(e.nano),
      calls: e.calls,
      stages: [...e.stages].sort(),
      firstAt: e.first,
      lastAt: e.last,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.scriptId.localeCompare(b.scriptId));
};

const integrityOf = (rows: LedgerRow[], windowRows: LedgerRow[], now: Date): IntegrityReport => {
  let fromPostgres = 0;
  let fromFallbackFile = 0;
  let fromLegacyFile = 0;
  let tokensUnknownCalls = 0;
  let tokensUnknownMs = 0;
  let tokensUnknownWorstMs = 0;
  let fallbackPricedCalls = 0;
  let fallbackNano = 0;
  let zeroCostWithTokens = 0;
  let unattributedCalls = 0;
  const fallbackModels = new Set<string>();
  let lastRowAt: Date | null = null;

  for (const r of rows) {
    if (r.source === "postgres") fromPostgres++;
    else if (r.source === "spend-jsonl") fromFallbackFile++;
    else fromLegacyFile++;
    if (r.tokensUnknown) {
      tokensUnknownCalls++;
      tokensUnknownMs += r.latencyMs ?? 0;
      tokensUnknownWorstMs = Math.max(tokensUnknownWorstMs, r.latencyMs ?? 0);
    }
    if (!isPricedModel(r.model)) {
      fallbackPricedCalls++;
      fallbackNano += toNanoUsd(r.costUsd);
      fallbackModels.add(r.model);
    }
    if (r.costUsd === 0 && !r.tokensUnknown && r.inputTokens + r.outputTokens > 0) {
      zeroCostWithTokens++;
    }
    if (r.stage === "unattributed") unattributedCalls++;
    if (lastRowAt === null || r.at > lastRowAt) lastRowAt = r.at;
  }

  const families = new Set(windowRows.map((r) => stageFamily(r.stage)));
  const missingStages = families.has("build")
    ? REQUIRED_ALONGSIDE_BUILD.filter((f) => !families.has(f))
    : [];

  const hoursSinceLastRow =
    lastRowAt === null ? null : (now.getTime() - lastRowAt.getTime()) / 3_600_000;

  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push(
      "The ledger is EMPTY for this window. That is not the same as spending nothing — " +
        "check that recordSpend is wired and DATABASE_URL is set.",
    );
  }
  for (const f of missingStages) {
    warnings.push(
      `ZERO "${f}" calls recorded against ${windowRows.filter((r) => stageFamily(r.stage) === "build").length} build calls. ` +
        `Every deck is ${f === "outline" ? "outlined" : "crawled"} before it is built, so this spend happened and was not recorded — ` +
        `the total below is LOW by whatever ${f} cost.`,
    );
  }
  if (tokensUnknownCalls > 0) {
    warnings.push(
      `${tokensUnknownCalls} call(s) died before we could read their usage ` +
        `(${Math.round(tokensUnknownMs / 1000)}s total, worst ${Math.round(tokensUnknownWorstMs / 1000)}s). ` +
        `They are counted at $0 and NO dollar figure is attached on purpose, so the total is a FLOOR. ` +
        `A call that ran past ~300s generated something we were billed for — investigate it, do not estimate it.`,
    );
  }
  if (fallbackPricedCalls > 0) {
    warnings.push(
      `${fallbackPricedCalls} call(s) on ${[...fallbackModels].join(", ")} were priced by the FALLBACK rate ` +
        `(no row in lib/usage.ts RATES) — $${fromNanoUsd(fallbackNano).toFixed(4)} of the total is a guess, not a price.`,
    );
  }
  if (zeroCostWithTokens > 0) {
    warnings.push(
      `${zeroCostWithTokens} row(s) burned tokens and recorded $0.00. A cost column that is zero half the time ` +
        `is worse than no column — find the write site and price it.`,
    );
  }
  if (fromLegacyFile > 0 && fromPostgres > 0) {
    // recordUsage (usage.jsonl) and recordSpend (SpendRecord) are BOTH live
    // right now — run-preview-build still writes the old per-build row while
    // the transports write per-call rows. Merging them counts the same money
    // twice, which is exactly as useless as missing it.
    warnings.push(
      `Rows came from BOTH Postgres (${fromPostgres}) and the legacy .data/usage.jsonl (${fromLegacyFile}). ` +
        `recordUsage and recordSpend both run today, so this total DOUBLE COUNTS. Drop --include-jsonl.`,
    );
  }
  if (fromFallbackFile > 0) {
    warnings.push(
      `${fromFallbackFile} row(s) never reached Postgres and are being read from .data/spend.jsonl ` +
        `(no DATABASE_URL, or a failed write). They are included above, but \`.data\` is ephemeral on Railway — ` +
        `on a deploy this spend disappears from history.`,
    );
  }
  if (fromPostgres === 0 && fromLegacyFile + fromFallbackFile > 0) {
    warnings.push(
      "Reading local files only — PRODUCTION spend is NOT in this number. " +
        "`.data` is excluded from the image and never leaves the container.",
    );
  }
  if (hoursSinceLastRow !== null && hoursSinceLastRow > 24) {
    warnings.push(
      `Nothing has been recorded for ${hoursSinceLastRow.toFixed(0)}h. Either nothing ran, or recording broke.`,
    );
  }

  return {
    rows: rows.length,
    fromPostgres,
    fromFallbackFile,
    fromLegacyFile,
    tokensUnknownCalls,
    tokensUnknownSeconds: Math.round(tokensUnknownMs / 1000),
    tokensUnknownWorstSeconds: Math.round(tokensUnknownWorstMs / 1000),
    fallbackPricedCalls,
    fallbackPricedCostUsd: fromNanoUsd(fallbackNano),
    fallbackModels: [...fallbackModels].sort(),
    zeroCostWithTokens,
    unattributedCalls,
    missingStages,
    lastRowAt,
    hoursSinceLastRow,
    warnings,
  };
};

/**
 * The whole report, from rows. PURE — pass `now` in, get the same answer every
 * time. This is the function the CLI, the admin route and the spend cap all
 * call, so there is exactly one implementation of "what did we spend today".
 */
export const summarize = (
  rows: LedgerRow[],
  opts: { now: Date; groupWindow?: GroupWindow },
): SpendSummary => {
  const now = opts.now;
  const groupWindow = opts.groupWindow ?? "month";
  const dayStart = dayStartUtc(now);
  const monthStart = monthStartUtc(now);

  const todayRows = bucketRows(rows, dayStart);
  const monthRows = bucketRows(rows, monthStart);

  const today = rawBucket();
  for (const r of todayRows) addRow(today, r);
  const month = rawBucket();
  for (const r of monthRows) addRow(month, r);
  const all = rawBucket();
  for (const r of rows) addRow(all, r);

  const windowRows =
    groupWindow === "today" ? todayRows : groupWindow === "month" ? monthRows : rows;

  const decks = deckRows(windowRows);
  const deckCosts = decks.map((d) => d.costUsd).sort((a, b) => a - b);
  const deckNano = decks.reduce((s, d) => s + toNanoUsd(d.costUsd), 0);

  return {
    now,
    dayStart,
    monthStart,
    today: seal(today),
    month: seal(month),
    all: seal(all),
    groupWindow,
    byStage: groupBy(windowRows, (r) => r.stage),
    byModel: groupBy(windowRows, (r) => r.model),
    byOrigin: groupBy(windowRows, (r) => r.origin),
    decks,
    perDeck: {
      decks: decks.length,
      meanUsd: decks.length === 0 ? 0 : fromNanoUsd(deckNano / decks.length),
      p50Usd: percentile(deckCosts, 0.5),
      p90Usd: percentile(deckCosts, 0.9),
    },
    integrity: integrityOf(rows, windowRows, now),
  };
};

export { emptyBucket };
