/**
 * The spend number, shouting before the money is gone.
 *
 * lib/zai-breaker.ts already stops generation when FIREWORKS says the account
 * is dry. That is a discovery, not a control — it fires after the balance is
 * spent, and it has fired for real twice. This module is the missing half:
 * our OWN thresholds, evaluated against our OWN ledger, alerting on the way up
 * and stopping generation at the ceiling.
 *
 * Split deliberately in two:
 *   · evaluateSpend() is PURE — numbers in, verdict out. It is the part that
 *     has to be right, so it is the part that is unit-tested without a
 *     database, a clock, or an alert channel.
 *   · checkSpendThresholds() does the impure work: read the ledger, apply the
 *     verdict, alert, trip. It never throws — a monitoring path that can break
 *     the thing it monitors is worse than no monitoring.
 *
 * WHERE IT IS DRIVEN FROM (three, on purpose, because any one of them can be
 * absent):
 *   · lib/spend/record.ts should call noteSpendRecorded() after each write —
 *     write-driven, so a runaway loop is caught by its own spending.
 *   · GET /api/health calls it too. Health is the one endpoint production is
 *     guaranteed to poll, which makes it the cheapest available heartbeat;
 *     the call is throttled to once a minute, so a flood costs one query.
 *   · `npm run spend --check` runs it by hand.
 */
import { sendAlert, type AlertLevel } from "../alert";
import { clearSpendCap, spendCapState, tripSpendCap } from "../zai-breaker";
import { loadSpendRows } from "./source";
import {
  monthStartUtc,
  nextDayStartUtc,
  nextMonthStartUtc,
  summarize,
  utcDayKey,
  utcMonthKey,
  type SpendSummary,
} from "./ledger";

export interface SpendThresholds {
  /** Warn once when today's spend crosses this. 0 disables. */
  dailyAlertUsd: number;
  /** Stop generating when today's spend crosses this. 0 disables. */
  dailyCapUsd: number;
  /** Warn once when month-to-date crosses this. 0 disables. */
  monthlyAlertUsd: number;
  /** Stop generating when month-to-date crosses this. 0 disables — see below. */
  monthlyCapUsd: number;
}

/**
 * DEFAULTS, and why these numbers.
 *
 * Grounded in the measured ledger (665 rows, 2026-06-09 → 2026-08-05,
 * $118.93 lifetime), not in a round number that felt safe:
 *   · recorded daily spend: p50 $2.79, p90 $8.79, busiest day $15.97
 *   · full recorded months: June $58.94, July $53.47
 *   · August's REAL rate (the provider dashboard, which the ledger missed):
 *     $37.69 across 8 days ≈ $4.71/day ≈ $145 for a full month
 *
 * DAILY ALERT $25 — comfortably above the busiest day ever recorded, so an
 * ordinary heavy day of dogfooding does not page anyone (an alert that fires
 * on normal days is an alert that gets muted, and lib/alert.ts already learned
 * that lesson the expensive way). At the measured $1.56 mean per deck, $25 is
 * ~16 decks in a day: with zero external users that can only be us, and after
 * launch it is a day worth looking at the same day.
 *
 * DAILY CAP $100 — 4x the alert, ~6x the busiest recorded day, ~64 decks. Real
 * launch traffic stays under it; a retry loop reaches it in minutes and stops.
 * It self-lifts at UTC midnight, so the worst case it can cost is one day of
 * paused generation, and it is the difference between a $100 surprise and a
 * $3,000 one.
 *
 * MONTHLY ALERT $250 — ~1.7x any month ever recorded and ~1.7x August's real
 * rate. It fires when the month is running at nearly double anything seen
 * before, which is news, rather than every month, which is noise.
 *
 * MONTHLY CAP 0 (OFF) — the one default that is deliberately not set, and the
 * asymmetry is the reason. A daily cap costs at most a day. A monthly cap that
 * trips on the 20th kills the product for eleven days, and it would trip
 * precisely when the product is working. That is a business decision, not a
 * safety one, so it is available (RB_SPEND_MONTHLY_CAP_USD) and off until
 * someone chooses it.
 */
export const DEFAULT_DAILY_ALERT_USD = 25;
export const DEFAULT_DAILY_CAP_USD = 100;
export const DEFAULT_MONTHLY_ALERT_USD = 250;
export const DEFAULT_MONTHLY_CAP_USD = 0;

/**
 * Fraction of the hard cap at which we warn that it is coming.
 * "Alert BEFORE the money is gone" — at 80% of a $100 cap there is still $20
 * of runway and time to raise it or kill the loop before generation stops.
 */
export const CAP_APPROACH_FRACTION = 0.8;

/**
 * PURE: parse one threshold. A blank/garbage value takes the default rather
 * than silently becoming 0, because 0 means DISABLED here and a typo that
 * disables the spend cap is the worst possible reading of a typo. An explicit
 * "0" still disables — that is a decision, not a typo.
 */
export const parseThreshold = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[spend] ignoring unparsable threshold "${raw}" — using ${fallback}`);
    return fallback;
  }
  return n;
};

export const spendThresholds = (env: NodeJS.ProcessEnv = process.env): SpendThresholds => ({
  dailyAlertUsd: parseThreshold(env.RB_SPEND_DAILY_ALERT_USD, DEFAULT_DAILY_ALERT_USD),
  dailyCapUsd: parseThreshold(env.RB_SPEND_DAILY_CAP_USD, DEFAULT_DAILY_CAP_USD),
  monthlyAlertUsd: parseThreshold(env.RB_SPEND_MONTHLY_ALERT_USD, DEFAULT_MONTHLY_ALERT_USD),
  monthlyCapUsd: parseThreshold(env.RB_SPEND_MONTHLY_CAP_USD, DEFAULT_MONTHLY_CAP_USD),
});

export interface SpendAlert {
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
}

export interface SpendVerdict {
  level: "ok" | "warn" | "critical";
  alerts: SpendAlert[];
  /** Set when generation must stop. `untilMs` is when the window rolls over. */
  trip: { reason: string; untilMs: number } | null;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * PURE: today's and this month's spend against the thresholds.
 *
 * Dedupe keys carry the DAY or MONTH they refer to ("spend-daily-cap:
 * 2026-08-08") so the same condition on a new day is a new alert. lib/alert.ts
 * suppresses a repeat key for ten minutes; the once-per-window latch in
 * applyVerdict() below is what keeps a breached daily threshold from sending
 * 144 emails before midnight.
 */
export const evaluateSpend = (input: {
  todayUsd: number;
  monthUsd: number;
  now: Date;
  thresholds: SpendThresholds;
}): SpendVerdict => {
  const { todayUsd, monthUsd, now, thresholds: t } = input;
  const day = utcDayKey(now);
  const month = utcMonthKey(now);
  const alerts: SpendAlert[] = [];
  let trip: SpendVerdict["trip"] = null;

  // Most severe first, and only ONE trip: the caller stops generating either
  // way, and two "generation is stopped" alerts about the same stop is how an
  // alert channel earns a mute rule.
  if (t.monthlyCapUsd > 0 && monthUsd >= t.monthlyCapUsd) {
    trip = {
      reason: `month-to-date ${usd(monthUsd)} reached the monthly cap ${usd(t.monthlyCapUsd)}`,
      untilMs: nextMonthStartUtc(now).getTime(),
    };
    alerts.push({
      key: `spend-monthly-cap:${month}`,
      level: "critical",
      title: `Generation STOPPED — monthly spend cap reached (${usd(monthUsd)})`,
      detail:
        `Month-to-date AI spend is ${usd(monthUsd)}, at or over the ${usd(t.monthlyCapUsd)} cap ` +
        `(RB_SPEND_MONTHLY_CAP_USD). Every build, generate and regenerate is failing fast until ` +
        `${nextMonthStartUtc(now).toISOString().slice(0, 10)}. Raise the cap or investigate: \`npm run spend\`.`,
    });
  } else if (t.dailyCapUsd > 0 && todayUsd >= t.dailyCapUsd) {
    trip = {
      reason: `today ${usd(todayUsd)} reached the daily cap ${usd(t.dailyCapUsd)}`,
      untilMs: nextDayStartUtc(now).getTime(),
    };
    alerts.push({
      key: `spend-daily-cap:${day}`,
      level: "critical",
      title: `Generation STOPPED — daily spend cap reached (${usd(todayUsd)} today)`,
      detail:
        `AI spend today (UTC) is ${usd(todayUsd)}, at or over the ${usd(t.dailyCapUsd)} cap ` +
        `(RB_SPEND_DAILY_CAP_USD). Generation is paused and lifts on its own at 00:00 UTC — ` +
        `no deploy needed. See where it went: \`npm run spend\`.`,
    });
  } else if (t.dailyCapUsd > 0 && todayUsd >= t.dailyCapUsd * CAP_APPROACH_FRACTION) {
    alerts.push({
      key: `spend-daily-approach:${day}`,
      level: "warn",
      title: `AI spend today is ${usd(todayUsd)} — ${Math.round(CAP_APPROACH_FRACTION * 100)}% of the ${usd(t.dailyCapUsd)} cap`,
      detail:
        `${usd(t.dailyCapUsd - todayUsd)} left before generation stops for the rest of the UTC day. ` +
        `Check it now: \`npm run spend\`.`,
    });
  }

  // The plain daily alert is independent of the cap ladder: it is the "look at
  // this today" line, and it should still fire on a day that never gets near
  // the ceiling. Suppressed only when the cap alerts above already said more.
  if (
    t.dailyAlertUsd > 0 &&
    todayUsd >= t.dailyAlertUsd &&
    !alerts.some((a) => a.key.startsWith("spend-daily-"))
  ) {
    alerts.push({
      key: `spend-daily-alert:${day}`,
      level: "warn",
      title: `AI spend today is ${usd(todayUsd)}`,
      detail:
        `Past the ${usd(t.dailyAlertUsd)} daily notice threshold (RB_SPEND_DAILY_ALERT_USD). ` +
        `Nothing is blocked. Breakdown: \`npm run spend\`.`,
    });
  }

  if (t.monthlyAlertUsd > 0 && monthUsd >= t.monthlyAlertUsd && !alerts.some((a) => a.key.startsWith("spend-monthly-"))) {
    alerts.push({
      key: `spend-monthly-alert:${month}`,
      level: "warn",
      title: `AI spend this month is ${usd(monthUsd)}`,
      detail:
        `Past the ${usd(t.monthlyAlertUsd)} monthly notice threshold (RB_SPEND_MONTHLY_ALERT_USD). ` +
        `Nothing is blocked. Breakdown: \`npm run spend\`.`,
    });
  }

  const level: SpendVerdict["level"] = trip
    ? "critical"
    : alerts.length > 0
      ? "warn"
      : "ok";
  return { level, alerts, trip };
};

// ── THE IMPURE HALF ──────────────────────────────────────────────────────

/**
 * Alert keys already fired, so a breached DAILY threshold sends one message
 * and not one per check.
 *
 * lib/alert.ts's own dedupe is a ten-minute window, which is right for an
 * outage that might recover and wrong for a threshold that stays crossed for
 * the rest of the day: it would have sent ~144 emails between a lunchtime
 * breach and midnight. Keys carry their day/month, so this latch empties
 * itself as the calendar moves.
 *
 * In-memory, so a deploy can produce one repeat alert. That is the right
 * trade against a database write on a monitoring path: a duplicate is
 * annoying, a missed one is the whole failure.
 */
const fired = new Set<string>();

let lastCheckAt = 0;
/** One ledger read a minute, at most, however hard the trigger is hit. */
const CHECK_THROTTLE_MS = 60_000;

export const resetSpendCheckForTests = (): void => {
  fired.clear();
  lastCheckAt = 0;
};

/**
 * Apply a verdict: fire the alerts that have not fired for this window, and
 * trip or lift the cap. Separated from the ledger read so a test can drive it
 * with numbers instead of a database.
 */
export const applyVerdict = (verdict: SpendVerdict): void => {
  for (const a of verdict.alerts) {
    if (fired.has(a.key)) continue;
    fired.add(a.key);
    // Fire-and-forget by contract (lib/alert.ts): an alert that can throw into
    // the caller turns a spend notice into an outage.
    void sendAlert({ key: a.key, level: a.level, title: a.title, detail: a.detail });
  }
  if (verdict.trip) {
    tripSpendCap(verdict.trip);
  } else if (spendCapState().tripped) {
    // Spend fell back under the threshold — which in practice only happens when
    // the UTC window rolled over, since a paused product cannot spend less.
    clearSpendCap("spend is back under the cap");
  }
};

export interface SpendCheckResult {
  summary: SpendSummary;
  verdict: SpendVerdict;
  thresholds: SpendThresholds;
}

/**
 * Read the ledger, evaluate, act. Never throws.
 *
 * Reads only the current UTC month — the cap and both alerts are month-to-date
 * or narrower, so a wider read would cost more and answer nothing.
 */
export const checkSpendThresholds = async (
  now: Date = new Date(),
): Promise<SpendCheckResult | null> => {
  try {
    const { rows } = await loadSpendRows({ since: monthStartUtc(now) });
    const summary = summarize(rows, { now, groupWindow: "month" });
    const thresholds = spendThresholds();
    const verdict = evaluateSpend({
      todayUsd: summary.today.costUsd,
      monthUsd: summary.month.costUsd,
      now,
      thresholds,
    });
    applyVerdict(verdict);
    return { summary, verdict, thresholds };
  } catch (err) {
    console.warn(
      `[spend] threshold check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
};

/**
 * The hook for spend-producing code paths — call it and walk away.
 *
 * THE CONTRACT lib/spend/record.ts should honour: `void noteSpendRecorded()`
 * at the end of recordSpend(). Never awaited, never on the critical path, and
 * throttled here rather than at the call site so a 45-call build costs one
 * ledger read, not 45.
 */
export const noteSpendRecorded = (): void => {
  const now = Date.now();
  if (now - lastCheckAt < CHECK_THROTTLE_MS) return;
  lastCheckAt = now;
  void checkSpendThresholds();
};
