/**
 * `npm run spend` — what we are paying Fireworks, to the cent.
 *
 * THE THING THIS REPLACES: on 2026-08-08 the provider dashboard said $37.69
 * for August, our records covered $6.52, and the rest was ESTIMATED — badly,
 * ~50% low. Fireworks exposes no usage or billing API to reconcile against
 * (/v1/accounts/{id}/usage, /billing and /invoices all 404 on this account),
 * so our ledger has to be the exact number and something has to print it.
 *
 * Read at 2am, on a phone-sized terminal, by someone who wants one number and
 * then the reason for it. So: totals first, breakdowns second, and anything
 * that makes the totals untrustworthy printed LOUDLY at the bottom rather than
 * left for the reader to infer.
 *
 * It shares lib/spend/ledger.ts with GET /api/admin/spend — one aggregation
 * implementation, so the CLI and the API cannot disagree about what a day cost.
 */
import {
  groupBy,
  summarize,
  utcDayKey,
  type GroupRow,
  type GroupWindow,
  type LedgerRow,
  type SpendSummary,
} from "../lib/spend/ledger";
import { loadSpendRows } from "../lib/spend/source";
import { checkSpendThresholds, spendThresholds } from "../lib/spend/cap";

// ── formatting ───────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string): string => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const green = (s: string) => paint("32", s);

/** Money, 4dp: the ledger prices to the microdollar and rounding here would
 *  make small stages read as $0.00 — which is how "free" bugs get believed. */
const usd = (n: number, width = 10): string => `$${n.toFixed(4)}`.padStart(width);
/** The eyeball number: what the provider dashboard shows. */
const cents = (n: number): string => `$${n.toFixed(2)}`;
// Millions matter: a month of builds is tens of millions of tokens, and
// "1398.0k" is a number the reader has to do arithmetic on at 2am.
const tok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const pct = (f: number): string => `${(f * 100).toFixed(0)}%`.padStart(4);

const table = (title: string, rows: GroupRow[], limit = 12): void => {
  if (rows.length === 0) return;
  console.log(`\n${bold(title)}`);
  const width = Math.min(46, Math.max(...rows.slice(0, limit).map((r) => r.key.length)));
  for (const r of rows.slice(0, limit)) {
    console.log(
      `  ${r.key.padEnd(width)}  ${usd(r.costUsd)}  ${dim(pct(r.share))}  ${dim(`${r.calls} calls`)}`,
    );
  }
  if (rows.length > limit) console.log(dim(`  … and ${rows.length - limit} more`));
};

// ── args ─────────────────────────────────────────────────────────────────

interface Args {
  since?: Date;
  until?: Date;
  window: GroupWindow;
  by?: "stage" | "model" | "day" | "owner" | "origin";
  deck?: string;
  includeJsonl: boolean;
  json: boolean;
  check: boolean;
}

const parseArgs = (argv: string[]): Args | string => {
  const a: Args = { window: "month", includeJsonl: false, json: false, check: false };
  for (const raw of argv) {
    const [k, v] = raw.startsWith("--") ? raw.slice(2).split("=") : [raw, undefined];
    switch (k) {
      case "help":
      case "h":
        return HELP;
      case "since":
      case "until": {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) return `--${k} needs a date, got "${v}"`;
        if (k === "since") a.since = d;
        else a.until = d;
        break;
      }
      case "window":
        if (v !== "today" && v !== "month" && v !== "all") return `--window must be today|month|all`;
        a.window = v;
        break;
      case "by":
        if (v !== "stage" && v !== "model" && v !== "day" && v !== "owner" && v !== "origin") {
          return "--by must be stage|model|day|owner|origin";
        }
        a.by = v;
        break;
      case "deck":
        if (!v) return "--deck needs a scriptId";
        a.deck = v;
        break;
      case "include-jsonl":
        a.includeJsonl = true;
        break;
      case "json":
        a.json = true;
        break;
      case "check":
        a.check = true;
        break;
      default:
        return `unknown option "${raw}"`;
    }
  }
  return a;
};

const HELP = `
npm run spend — exact AI spend from our own ledger (all times UTC)

  npm run spend                          today + month-to-date, by stage and model
  npm run spend -- --window=today        breakdowns for today only
  npm run spend -- --since=2026-08-01 --until=2026-08-09
  npm run spend -- --by=day              one line per UTC day
  npm run spend -- --by=owner            spend per user
  npm run spend -- --deck=<scriptId>     every call of one deck, in order
  npm run spend -- --include-jsonl       merge legacy .data/usage.jsonl (may double count)
  npm run spend -- --check               evaluate the alert/cap thresholds now
  npm run spend -- --json                machine-readable
`.trim();

// ── the report ───────────────────────────────────────────────────────────

const deckDetail = (rows: LedgerRow[], scriptId: string): void => {
  const mine = rows.filter((r) => r.scriptId === scriptId).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (mine.length === 0) {
    console.log(red(`\nNo recorded calls for deck ${scriptId}.`));
    console.log(dim("If this deck was built, its spend was not recorded — see INTEGRITY below."));
    return;
  }
  const total = mine.reduce((s, r) => s + r.costUsd, 0);
  console.log(`\n${bold(`DECK ${scriptId}`)}  ${mine.length} calls  ${bold(usd(total, 0))}`);
  const stageW = Math.max(...mine.map((r) => r.stage.length));
  for (const r of mine) {
    const flags = [r.ok ? "" : red("FAILED"), r.tokensUnknown ? yellow("NO-TOKENS") : ""]
      .filter(Boolean)
      .join(" ");
    console.log(
      `  ${dim(r.at.toISOString().slice(11, 19))}  ${r.stage.padEnd(stageW)}  ${usd(r.costUsd)}  ` +
        `${dim(`${tok(r.inputTokens)}in ${tok(r.outputTokens)}out`)} ${flags}`,
    );
  }
};

const printReport = (s: SpendSummary, rows: LedgerRow[], args: Args, source: string, notes: string[]): void => {
  const t = spendThresholds();
  const offsetMin = -new Date().getTimezoneOffset();
  const tzNote =
    offsetMin === 0
      ? ""
      : dim(` (your clock is UTC${offsetMin >= 0 ? "+" : ""}${(offsetMin / 60).toFixed(offsetMin % 60 ? 1 : 0)} — these windows are NOT your local day)`);

  console.log(`\n${bold("RENDERBALL SPEND")}  ${dim(`· ledger: ${source} · all times UTC`)}${tzNote}`);

  // Padded to the same width so the two dollar figures line up in a column —
  // the whole point of this block is a two-second comparison.
  const labelW = 18;
  const dayLabel = utcDayKey(s.dayStart).padEnd(labelW);
  const monthLabel = `${utcDayKey(s.monthStart)} → now`.padEnd(labelW);
  const overDaily = t.dailyAlertUsd > 0 && s.today.costUsd >= t.dailyAlertUsd;
  const overMonthly = t.monthlyAlertUsd > 0 && s.month.costUsd >= t.monthlyAlertUsd;

  console.log(
    `\n  ${bold("TODAY")}  ${dayLabel}${(overDaily ? red : green)(usd(s.today.costUsd))}  ` +
      `${dim(`${s.today.calls} calls`)}  ${dim(`alert ${cents(t.dailyAlertUsd)} · cap ${t.dailyCapUsd > 0 ? cents(t.dailyCapUsd) : "off"}`)}`,
  );
  console.log(
    `  ${bold("MONTH")}  ${monthLabel}${(overMonthly ? red : green)(usd(s.month.costUsd))}  ` +
      `${dim(`${s.month.calls} calls`)}  ${dim(`alert ${cents(t.monthlyAlertUsd)} · cap ${t.monthlyCapUsd > 0 ? cents(t.monthlyCapUsd) : "off"}`)}`,
  );
  if (s.month.failedCalls > 0) {
    console.log(
      dim(
        `         of which ${s.month.failedCalls} call(s) bought nothing usable: ${usd(s.month.failedCostUsd, 0)}`,
      ),
    );
  }
  console.log(
    dim(
      `         tokens this month: ${tok(s.month.inputTokens)} in · ${tok(s.month.outputTokens)} out · ` +
        `${tok(s.month.cachedTokens)} cached${s.month.images > 0 ? ` · ${s.month.images} images` : ""}`,
    ),
  );

  if (args.by === "day") {
    table("BY DAY (UTC)", groupBy(rows, (r) => utcDayKey(r.at)).sort((a, b) => a.key.localeCompare(b.key)), 40);
  } else if (args.by === "owner") {
    table("BY OWNER", groupBy(rows, (r) => r.ownerId ?? "(none — dev loop / offline script)"));
  } else if (args.by === "origin") {
    table(`BY ORIGIN (${s.groupWindow})`, s.byOrigin);
  } else if (args.by === "model") {
    table(`BY MODEL (${s.groupWindow})`, s.byModel);
  } else if (args.by === "stage") {
    table(`BY STAGE (${s.groupWindow})`, s.byStage);
  } else {
    table(`BY STAGE (${s.groupWindow})`, s.byStage);
    table(`BY MODEL (${s.groupWindow})`, s.byModel);
    if (s.byOrigin.length > 1) table(`BY ORIGIN (${s.groupWindow})`, s.byOrigin);
  }

  if (s.perDeck.decks > 0) {
    console.log(
      `\n${bold(`COST PER DECK (${s.groupWindow}, ${s.perDeck.decks} decks)`)} ${dim("— includes failed attempts, because that is what the deck cost us")}`,
    );
    console.log(
      `  mean ${usd(s.perDeck.meanUsd, 0)}   p50 ${usd(s.perDeck.p50Usd, 0)}   p90 ${usd(s.perDeck.p90Usd, 0)}`,
    );
    console.log(`\n${bold("MOST EXPENSIVE DECKS")}`);
    for (const d of s.decks.slice(0, 5)) {
      console.log(
        `  ${d.scriptId}  ${usd(d.costUsd)}  ${dim(`${d.calls} calls · ${d.stages.join(",")}`)}`,
      );
    }
    console.log(dim(`  drill in: npm run spend -- --deck=${s.decks[0].scriptId}`));
  }

  // ── RECONCILIATION ─────────────────────────────────────────────────────
  // The provider dashboard is the only external authority there is, so this
  // block exists to make the comparison a five-second eyeball rather than a
  // reconstruction.
  console.log(`\n${bold("RECONCILE AGAINST FIREWORKS")}`);
  console.log(
    dim("  No usage/billing API exists (probed: /v1/accounts/{id}/usage, /billing, /invoices → 404),"),
  );
  console.log(dim("  so the dashboard stays the authority. app.fireworks.ai → Billing → Usage, month to date."));
  console.log(`  Our month-to-date (${utcDayKey(s.monthStart)} → ${utcDayKey(s.now)} UTC): ${bold(cents(s.month.costUsd))}`);
  console.log(dim("  Dashboard HIGHER → spend is happening that we do not record. See INTEGRITY."));
  console.log(dim("  Dashboard LOWER  → we are double counting, or a rate in lib/usage.ts overstates."));

  for (const n of notes) console.log(yellow(`  note: ${n}`));

  // THE HONEST FLOOR, printed as its own line and never folded into the total.
  // A call whose response we never read consumed tokens that are unknowable
  // from our side, forever. What IS knowable is how many there were and how
  // long they ran — that bounds the error and doubles as a bug signal.
  const i = s.integrity;
  if (i.tokensUnknownCalls > 0) {
    console.log(
      `\n${bold("UNCOUNTED")}  ${yellow(`${i.tokensUnknownCalls} call(s) died before we could read usage`)} ` +
        dim(`(${i.tokensUnknownSeconds}s total, worst ${i.tokensUnknownWorstSeconds}s)`),
    );
    console.log(dim("  No dollar figure is attached on purpose — the count is the bound, not a guess."));
    console.log(dim("  Anything past ~300s is real generation we paid for. Investigate it, do not estimate it."));
  }

  console.log(
    `\n${bold("INTEGRITY")}  ${dim(`${i.rows} rows · ${i.fromPostgres} pg · ${i.fromFallbackFile} spend.jsonl · ${i.fromLegacyFile} usage.jsonl`)}`,
  );
  if (s.integrity.warnings.length === 0) {
    console.log(green("  Nothing looks structurally missing."));
  }
  for (const w of i.warnings.filter((w) => !(i.tokensUnknownCalls > 0 && w.includes("died before we could read")))) {
    // Wrapped by hand rather than left as one long line: an 80-column terminal
    // truncates the end of the sentence, which is where the instruction is.
    const words = w.split(" ");
    let line = "  ! ";
    for (const word of words) {
      if (line.length + word.length > 96) {
        console.log(red(line));
        line = "    ";
      }
      line += word + " ";
    }
    console.log(red(line.trimEnd()));
  }
  if (i.unattributedCalls > 0) {
    console.log(
      dim(
        `  ${i.unattributedCalls} call(s) carry no stage label — grouped as "unattributed" above. ` +
          `Each is an entrypoint that still needs a withSpend() wrap; the money is counted either way.`,
      ),
    );
  }
  console.log("");
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.log(parsed === HELP ? HELP : red(parsed) + "\n\n" + HELP);
    process.exitCode = parsed === HELP ? 0 : 2;
    return;
  }
  const args = parsed;
  const now = new Date();

  // Default read covers the whole current month so today AND month-to-date are
  // both exact; --window=all or an explicit --since widens it.
  const since =
    args.since ??
    (args.window === "all" || args.deck
      ? undefined
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

  const loaded = await loadSpendRows({
    since,
    until: args.until,
    includeJsonl: args.includeJsonl,
  });
  const summary = summarize(loaded.rows, { now, groupWindow: args.window });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: now.toISOString(),
          source: loaded.source,
          notes: loaded.notes,
          today: summary.today,
          month: summary.month,
          all: summary.all,
          byStage: summary.byStage,
          byModel: summary.byModel,
          byOrigin: summary.byOrigin,
          perDeck: summary.perDeck,
          decks: summary.decks.slice(0, 20),
          integrity: summary.integrity,
          thresholds: spendThresholds(),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.deck) {
    deckDetail(loaded.rows, args.deck);
  }
  printReport(summary, loaded.rows, args, loaded.source, loaded.notes);

  if (args.check) {
    const res = await checkSpendThresholds(now);
    if (!res) {
      console.log(red("threshold check FAILED to read the ledger — see the warning above.\n"));
      return;
    }
    console.log(`${bold("THRESHOLD CHECK")}  → ${res.verdict.level.toUpperCase()}`);
    if (res.verdict.alerts.length === 0) console.log(green("  no thresholds crossed."));
    for (const a of res.verdict.alerts) {
      console.log(`  ${a.level === "critical" ? red("CRITICAL") : yellow("WARN")}  ${a.title}`);
      console.log(dim(`          ${a.detail}`));
    }
    if (res.verdict.trip) {
      console.log(
        red(`  GENERATION PAUSED until ${new Date(res.verdict.trip.untilMs).toISOString()}`),
      );
    }
    console.log("");
  }
};

await main();
