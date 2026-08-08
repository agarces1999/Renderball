/**
 * The spend cap — thresholds, alerting, and the gate that actually stops money.
 *
 * Run: `node scripts/run-tests.mjs lib/spend/cap.test.ts`. No database, no
 * network: evaluateSpend() is pure, and the alert channel is inert in tests
 * (scripts/run-tests.mjs strips every credential, deliberately, after a suite
 * once emailed the founder "Generation is DOWN" a dozen times in one evening).
 *
 * The two failures worth testing for are opposite and both fatal. Too quiet:
 * the cap never fires and the point of the whole exercise is lost. Too loud:
 * an alert per check for the rest of the day, and the channel gets muted —
 * which looks exactly like too quiet, a week later.
 */
import {
  CAP_APPROACH_FRACTION,
  DEFAULT_DAILY_ALERT_USD,
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_MONTHLY_ALERT_USD,
  DEFAULT_MONTHLY_CAP_USD,
  applyVerdict,
  evaluateSpend,
  parseThreshold,
  resetSpendCheckForTests,
  spendThresholds,
  type SpendThresholds,
} from "./cap";
import {
  SpendCapExceededError,
  ZaiUnavailableError,
  assertZaiAvailable,
  resetSpendCapForTests,
  resetZaiBreakerForTests,
  spendCapState,
} from "../zai-breaker";

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

const NOW = new Date("2026-08-08T14:30:00.000Z");
const T = (over: Partial<SpendThresholds> = {}): SpendThresholds => ({
  dailyAlertUsd: 25,
  dailyCapUsd: 100,
  monthlyAlertUsd: 250,
  monthlyCapUsd: 0,
  ...over,
});

// ── env parsing ──────────────────────────────────────────────────────────

check("an unset or blank threshold takes the default, not zero", () => {
  // 0 means DISABLED here, so a typo that reads as 0 would silently switch off
  // the spend cap — the worst possible reading of a typo.
  assert(parseThreshold(undefined, 25) === 25, "undefined → default");
  assert(parseThreshold("", 25) === 25, "empty → default");
  assert(parseThreshold("   ", 25) === 25, "whitespace → default");
  assert(parseThreshold("not-a-number", 25) === 25, "garbage → default");
  assert(parseThreshold("-5", 25) === 25, "negative → default");
});

check("an explicit 0 disables, because that is a decision", () => {
  assert(parseThreshold("0", 25) === 0, "explicit zero is honoured");
  const t = spendThresholds({ RB_SPEND_DAILY_CAP_USD: "0" } as unknown as NodeJS.ProcessEnv);
  assert(t.dailyCapUsd === 0, "cap disabled by explicit 0");
  const v = evaluateSpend({ todayUsd: 10_000, monthUsd: 10_000, now: NOW, thresholds: t });
  assert(v.trip === null, "a disabled cap must never trip, at any amount");
});

check("the defaults are the measured ones, and the monthly cap is off", () => {
  const t = spendThresholds({} as unknown as NodeJS.ProcessEnv);
  assert(t.dailyAlertUsd === DEFAULT_DAILY_ALERT_USD && t.dailyAlertUsd === 25, "daily alert 25");
  assert(t.dailyCapUsd === DEFAULT_DAILY_CAP_USD && t.dailyCapUsd === 100, "daily cap 100");
  assert(t.monthlyAlertUsd === DEFAULT_MONTHLY_ALERT_USD && t.monthlyAlertUsd === 250, "monthly alert 250");
  // Deliberate: a daily cap costs at most a day. A monthly cap that trips on
  // the 20th kills the product for eleven days, and would trip precisely when
  // the product is working. That is a business call, not a safety one.
  assert(t.monthlyCapUsd === DEFAULT_MONTHLY_CAP_USD && t.monthlyCapUsd === 0, "monthly cap OFF by default");
});

check("env overrides win over the defaults", () => {
  const t = spendThresholds({
    RB_SPEND_DAILY_ALERT_USD: "5",
    RB_SPEND_DAILY_CAP_USD: "12.5",
    RB_SPEND_MONTHLY_ALERT_USD: "60",
    RB_SPEND_MONTHLY_CAP_USD: "300",
  } as unknown as NodeJS.ProcessEnv);
  assert(t.dailyAlertUsd === 5 && t.dailyCapUsd === 12.5, "daily overrides");
  assert(t.monthlyAlertUsd === 60 && t.monthlyCapUsd === 300, "monthly overrides");
});

// ── the ladder ───────────────────────────────────────────────────────────

check("an ordinary day crosses nothing", () => {
  const v = evaluateSpend({ todayUsd: 4.71, monthUsd: 37.69, now: NOW, thresholds: T() });
  // The real August numbers: $4.71/day, $37.69 month-to-date. If the defaults
  // fired on THIS, they would be muted before launch week ended.
  assert(v.level === "ok", `expected ok, got ${v.level}`);
  assert(v.alerts.length === 0 && v.trip === null, "silent");
});

check("crossing the daily notice threshold warns and blocks nothing", () => {
  const v = evaluateSpend({ todayUsd: 25, monthUsd: 40, now: NOW, thresholds: T() });
  assert(v.level === "warn", `expected warn, got ${v.level}`);
  assert(v.trip === null, "a notice must not stop generation");
  assert(v.alerts.length === 1 && v.alerts[0].key === "spend-daily-alert:2026-08-08", "keyed by UTC day");
  assert(v.alerts[0].level === "warn", "warn, not critical");
});

check("the alert fires BEFORE the money is gone, at 80% of the cap", () => {
  const t = T();
  const approach = t.dailyCapUsd * CAP_APPROACH_FRACTION;
  const v = evaluateSpend({ todayUsd: approach, monthUsd: 90, now: NOW, thresholds: t });
  assert(v.trip === null, "80% is a warning, not a stop");
  assert(
    v.alerts.some((a) => a.key === "spend-daily-approach:2026-08-08"),
    "the approach warning is the one that leaves time to act",
  );
  assert(
    v.alerts.some((a) => a.detail.includes("$20.00")),
    "it must say how much runway is left, not just that a limit exists",
  );
  // Only ONE daily alert: the approach warning supersedes the plain notice.
  assert(v.alerts.filter((a) => a.key.startsWith("spend-daily-")).length === 1, "no doubled daily alert");
});

check("reaching the daily cap trips, criticals, and stops at UTC midnight", () => {
  const v = evaluateSpend({ todayUsd: 100, monthUsd: 120, now: NOW, thresholds: T() });
  assert(v.level === "critical", `expected critical, got ${v.level}`);
  assert(v.trip !== null, "must trip");
  assert(
    new Date(v.trip!.untilMs).toISOString() === "2026-08-09T00:00:00.000Z",
    `must lift at the next UTC midnight, got ${new Date(v.trip!.untilMs).toISOString()}`,
  );
  assert(v.alerts[0].level === "critical", "critical alert");
  assert(v.alerts.length === 1, "one stop, one alert");
});

check("the monthly cap outranks the daily one and holds until month end", () => {
  const v = evaluateSpend({
    todayUsd: 100,
    monthUsd: 500,
    now: NOW,
    thresholds: T({ monthlyCapUsd: 400 }),
  });
  assert(v.trip !== null, "must trip");
  assert(
    new Date(v.trip!.untilMs).toISOString() === "2026-09-01T00:00:00.000Z",
    "a monthly cap lifts at the start of next month, not tomorrow",
  );
  assert(
    v.alerts.filter((a) => a.level === "critical").length === 1,
    "one critical, not one per breached threshold — two 'generation is stopped' alerts earn a mute rule",
  );
});

check("a monthly notice can fire alongside a daily one", () => {
  const v = evaluateSpend({ todayUsd: 30, monthUsd: 260, now: NOW, thresholds: T() });
  assert(v.alerts.some((a) => a.key === "spend-daily-alert:2026-08-08"), "daily");
  assert(v.alerts.some((a) => a.key === "spend-monthly-alert:2026-08"), "monthly, keyed by month");
});

check("dedupe keys carry their window, so tomorrow is a new alert", () => {
  const today = evaluateSpend({ todayUsd: 30, monthUsd: 30, now: NOW, thresholds: T() });
  const tomorrow = evaluateSpend({
    todayUsd: 30,
    monthUsd: 60,
    now: new Date("2026-08-09T09:00:00.000Z"),
    thresholds: T(),
  });
  assert(today.alerts[0].key !== tomorrow.alerts[0].key, "a new day must be able to alert again");
  assert(tomorrow.alerts[0].key.endsWith("2026-08-09"), "keyed by the new day");
});

check("every alert says what to do about it", () => {
  for (const usdToday of [25, 80, 100]) {
    const v = evaluateSpend({ todayUsd: usdToday, monthUsd: usdToday, now: NOW, thresholds: T() });
    for (const a of v.alerts) {
      assert(a.detail.includes("npm run spend"), `alert at $${usdToday} must name the next action`);
      assert(a.title.length > 0 && a.title.length < 120, "the title is read on a lock screen");
    }
  }
});

// ── the gate ─────────────────────────────────────────────────────────────

check("applying a critical verdict actually stops generation", () => {
  resetSpendCapForTests();
  resetZaiBreakerForTests();
  resetSpendCheckForTests();
  assertZaiAvailable(); // baseline: nothing throws

  const v = evaluateSpend({ todayUsd: 100, monthUsd: 100, now: new Date(), thresholds: T() });
  applyVerdict(v);

  assert(spendCapState().tripped, "the cap must be tripped");
  let threw: unknown = null;
  try {
    assertZaiAvailable();
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, "the gate every spend entrypoint calls must now throw");
  assert(threw instanceof SpendCapExceededError, "with the spend-cap error");
  // The subclass is load-bearing: six routes already do
  // `if (err instanceof ZaiUnavailableError) return 503 err.friendly`, and they
  // must handle this correctly without being edited.
  assert(threw instanceof ZaiUnavailableError, "which every existing route already handles");
  const friendly = (threw as SpendCapExceededError).friendly;
  assert(friendly.includes("safety limit"), "the user-facing copy must be true, not blame the provider");
  assert(!friendly.includes("provider account needs attention"), "must not inherit the balance-breaker copy");
  resetSpendCapForTests();
});

check("the cap lifts on its own when its window rolls over", () => {
  resetSpendCapForTests();
  resetSpendCheckForTests();
  // Trip with a deadline already in the past: nothing has to run for it to lift.
  applyVerdict({
    level: "critical",
    alerts: [],
    trip: { reason: "test", untilMs: Date.now() - 1000 },
  });
  assert(!spendCapState().tripped, "an expired cap must not still be blocking");
  assertZaiAvailable(); // must not throw
  resetSpendCapForTests();
});

check("an ok verdict lifts a cap that is no longer justified", () => {
  resetSpendCapForTests();
  resetSpendCheckForTests();
  applyVerdict({
    level: "critical",
    alerts: [],
    trip: { reason: "test", untilMs: Date.now() + 60_000 },
  });
  assert(spendCapState().tripped, "tripped");
  applyVerdict({ level: "ok", alerts: [], trip: null });
  assert(!spendCapState().tripped, "an ok verdict must release the gate");
  resetSpendCapForTests();
});

check("re-tripping does not re-count trips or shorten the deadline", () => {
  resetSpendCapForTests();
  resetSpendCheckForTests();
  const far = Date.now() + 3_600_000;
  applyVerdict({ level: "critical", alerts: [], trip: { reason: "first", untilMs: far } });
  const afterFirst = spendCapState();
  applyVerdict({ level: "critical", alerts: [], trip: { reason: "second", untilMs: far - 60_000 } });
  const afterSecond = spendCapState();
  assert(afterSecond.trips === afterFirst.trips, "a repeating check is one incident, not many");
  assert(afterSecond.untilIso === afterFirst.untilIso, "the deadline must never move earlier");
  resetSpendCapForTests();
});

check("the same threshold breach alerts ONCE, not once per check", () => {
  resetSpendCapForTests();
  resetSpendCheckForTests();
  const sent: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  // lib/alert.ts always logs, even when suppressed and even with no channel
  // configured — so counting its log lines counts delivery attempts.
  console.warn = (...a: unknown[]) => {
    const s = String(a[0] ?? "");
    if (s.startsWith("[ALERT:")) sent.push(s);
  };
  console.error = (...a: unknown[]) => {
    const s = String(a[0] ?? "");
    if (s.startsWith("[ALERT:")) sent.push(s);
  };
  try {
    const v = evaluateSpend({ todayUsd: 30, monthUsd: 30, now: NOW, thresholds: T() });
    applyVerdict(v);
    applyVerdict(v);
    applyVerdict(v);
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  // Three checks in the same minute is the LEAST this will see: /api/health is
  // polled continuously and recordSpend fires per call. Without the latch a
  // lunchtime breach sends ~144 messages before midnight.
  assert(sent.length === 1, `expected 1 alert delivery, got ${sent.length}`);
  resetSpendCapForTests();
  resetSpendCheckForTests();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
