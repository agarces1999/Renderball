/**
 * z.ai balance circuit breaker — the launch audit's "before taking money" item,
 * and the failure mode that has actually taken all builds down TWICE
 * (2026-07-08 and 2026-07-09): the prepaid account runs dry and every call
 * returns `429 [1113] Insufficient balance`. Without a breaker, each customer
 * build then burns its full retry ladder against a hard account state and
 * fails slowly and expensively; with it, the FIRST 1113 trips the circuit and
 * every subsequent build/generate/regen fails fast with a friendly message
 * BEFORE any spend is attempted.
 *
 * Semantics (classic circuit breaker):
 *   - CLOSED  → normal operation. noteZaiError() watches for 1113.
 *   - OPEN    → assertZaiAvailable() throws ZaiUnavailableError immediately.
 *   - After COOLDOWN_MS the breaker half-opens: the next caller is allowed
 *     through as the probe. If the account is still dry, its 1113 re-trips the
 *     circuit; if it succeeds, noteZaiSuccess() closes it.
 *
 * Note [1113] can also mean an endpoint/key mismatch (Coding-Plan key against
 * the PAYG endpoint) — either way it is an ACCOUNT state, not load, so the
 * right move is identical: stop spending retries, surface it loudly.
 *
 * Alerting: until Resend/Sentry are wired, tripping writes a loud structured
 * console.error and a marker file (.data/zai-balance-tripped.json) so it is
 * visible on the box and greppable — replace the TODO hook with a real
 * channel when credentials land.
 */
import { promises as fs } from "fs";
import path from "path";
import { sendAlert } from "./alert";

const COOLDOWN_MS = 10 * 60 * 1000; // re-probe every 10 minutes while dry

export class ZaiUnavailableError extends Error {
  // Annotated `string` rather than inferred, so SpendCapExceededError below can
  // override it with its own copy.
  readonly friendly: string =
    "Generation is temporarily unavailable — our AI provider account needs attention. Nothing was charged to you; please try again in a few minutes.";
  constructor(message = "z.ai account unavailable ([1113] insufficient balance) — circuit open") {
    super(message);
    this.name = "ZaiUnavailableError";
  }
}

/**
 * The OTHER reason to stop spending: we hit our own dollar cap.
 *
 * A SUBCLASS on purpose. Six entrypoints already do
 * `if (err instanceof ZaiUnavailableError) return 503 err.friendly`, and the
 * correct handling for "stop generating right now" is identical in all of
 * them. Extending means every one of those routes handles the spend cap
 * correctly the day it ships, with no edit and nothing to forget — and the
 * user still gets a message that is true rather than one blaming the provider.
 */
export class SpendCapExceededError extends ZaiUnavailableError {
  readonly friendly: string =
    "Generation is paused — we've hit today's safety limit on AI spend. Nothing was charged to you; it lifts automatically, and we've been notified.";
  constructor(reason: string, untilIso: string) {
    super(`spend cap reached (${reason}) — generation paused until ${untilIso}`);
    this.name = "SpendCapExceededError";
  }
}

interface BreakerState {
  openedAt: number | null;
  trips: number;
  probing: boolean;
}

const state: BreakerState = { openedAt: null, trips: 0, probing: false };

/**
 * The provider-account-is-dry error. Deliberately narrow: overloads and
 * network faults are handled by the retry ladder + adaptive gate, not here.
 *
 * Two provider vocabularies, because this breaker predates the move to
 * Fireworks (CLAUDE.md, 2026-07-23) and was still matching only z.ai's
 * strings — `[1113]`, "Insufficient balance", "no resource package". Nothing
 * Fireworks emits looks like that, so the breaker had become unable to trip
 * on the provider actually in use, while five call sites still consulted it.
 *
 * Fireworks signals exhaustion as HTTP 402, or 429 whose body names a quota
 * or billing problem. A bare 429 is NOT a balance error — that is ordinary
 * rate limiting, and treating it as "account dry" would take the whole
 * product down on a traffic spike. Hence the 429 branch requires an explicit
 * quota/billing/credit word.
 */
export const isBalanceError = (err: unknown): boolean => {
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as Error & { cause?: unknown }).cause ?? "")}`
      : String(err);

  // z.ai (historical) — these strings are unambiguous.
  if (/\[1113\]|Insufficient balance|no resource package/i.test(msg)) return true;

  // Fireworks: HTTP 402 is the account-dry signal, matched on the STATUS the
  // transport attached — never on the rendered text. A substring match found
  // "402" inside bodies like "error code 402 upstream connect error" and
  // "invalid max_tokens: 402 exceeds limit", either of which would have taken
  // all generation down.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status === 402) return true;

  // 412 is the OTHER Fireworks account-dry signal, and it is the one that
  // actually fired in production (2026-08-04, verbatim):
  //   "cast HTTP 412: Account alfonso-… is suspended, possibly due to
  //    reaching the monthly spending limit or failure to pay past invoices."
  // The breaker knew only 402, so a fully suspended account tripped nothing:
  // no circuit, no alert, and the build pipeline quietly shipped a deck with
  // blank stubs where two scenes should have been. Paired with a body word so
  // an unrelated precondition failure cannot take all generation down — the
  // same caution the 429 branch below is built on.
  if (
    typeof status === "number" &&
    status === 412 &&
    /suspend|spending limit|past invoice|billing|unpaid/i.test(msg)
  ) {
    return true;
  }

  // Deliberately NOTHING for 429. Every 429 vocabulary a provider actually
  // emits for ordinary throttling contains money/quota words — measured:
  // "Quota exceeded for requests per minute", "Rate limit reached for model;
  // your account limit is 600 RPM", "Too many concurrent requests. See
  // billing docs; upgrade required". An earlier quota/billing keyword
  // heuristic tripped on all three. Since this breaker stops ALL generation
  // for a cooldown, a false positive during a traffic spike is a
  // self-inflicted outage — strictly worse than the failure it guards. Rate
  // limiting is what the retry ladder and adaptive gate are for.
  return false;
};

const markerPath = () => path.join(process.cwd(), ".data", "zai-balance-tripped.json");

const trip = (): void => {
  state.openedAt = Date.now();
  state.trips += 1;
  state.probing = false;
  // ── ALERT SURFACE ──────────────────────────────────────────────────────
  // This is THE production single point of failure: an empty upstream balance
  // stops every generation in the product. It used to be a console line, which
  // in a container nobody is watching is indistinguishable from silence.
  console.error(
    `[ZAI-BALANCE-CIRCUIT] TRIPPED (count ${state.trips}) at ${new Date().toISOString()} — ` +
      `all generation is failing fast until the account is recharged. ` +
      `The breaker self-probes every ${COOLDOWN_MS / 60000} min.`,
  );
  void sendAlert({
    key: "llm-balance-breaker",
    level: "critical",
    title: "Generation is DOWN — the LLM account is out of balance",
    detail:
      `Every build, generate and regenerate is failing fast (trip #${state.trips}). ` +
      `Recharge the Fireworks account; the breaker retries on its own every ` +
      `${COOLDOWN_MS / 60000} minutes and recovers without a deploy.`,
  });
  void fs
    .writeFile(
      markerPath(),
      JSON.stringify({ trippedAt: new Date().toISOString(), trips: state.trips }, null, 2),
    )
    .catch(() => {
      /* marker is best-effort — the breaker itself is in-memory */
    });
};

/** Call from every LLM error path. Returns true when the error tripped
 *  (or re-tripped) the breaker, so callers can stop their retry ladders. */
export const noteZaiError = (err: unknown): boolean => {
  if (!isBalanceError(err)) return false;
  trip();
  return true;
};

/** Call after any successful z.ai response — closes a half-open breaker. */
export const noteZaiSuccess = (): void => {
  if (state.openedAt !== null) {
    console.warn("[ZAI-BALANCE-CIRCUIT] probe succeeded — circuit CLOSED, generation resumed");
    state.openedAt = null;
    state.probing = false;
    void fs.rm(markerPath(), { force: true }).catch(() => {});
    // The all-clear matters as much as the alarm: without it the only way to
    // know the outage ended is to go and try the product.
    void sendAlert({
      key: "llm-balance-recovered",
      level: "warn",
      title: "Generation is back — the LLM account is answering again",
      detail: "The breaker closed on its own. No deploy needed.",
    });
  }
};

// ── OUR OWN SPEND CAP ────────────────────────────────────────────────────
//
// The breaker above trips only when FIREWORKS says the account is dry. That
// is a DISCOVERY, not a control: by the time it fires, the money is already
// gone. A dollar cap is the control — it is the same "stop spending" state
// machine pointed at our own threshold instead of the provider's.
//
// It lives HERE, next to the balance breaker, for one structural reason: every
// spending entrypoint already calls assertZaiAvailable() before doing any
// work. Putting the cap behind that single gate means a route cannot forget
// it — which is exactly the defect that made spend invisible in the first
// place (recording was per-call-site opt-in, and the three highest-volume
// production paths forgot it).
//
// It does NOT reuse the balance breaker's state, because the balance breaker
// half-opens after 10 minutes and probes. For an empty provider account that
// is right. For a dollar cap it would be catastrophic: the probe succeeds
// (the provider is perfectly healthy), the circuit closes, and spending
// resumes past the cap the founder set. A spend cap has to hold until its
// WINDOW rolls over, so it carries its own deadline.

interface SpendCapStateShape {
  /** Epoch ms at which the cap lifts on its own. null = not tripped. */
  until: number | null;
  reason: string | null;
  trippedAt: number | null;
  trips: number;
}

const spendCap: SpendCapStateShape = { until: null, reason: null, trippedAt: null, trips: 0 };

/**
 * Stop all generation until `untilMs`. Idempotent — re-tripping while already
 * tripped only extends the deadline, so a repeating check does not re-count
 * trips or re-log. Alerting is the caller's job (lib/spend/cap.ts), because
 * the caller is the one that knows the numbers.
 */
export const tripSpendCap = (opts: { reason: string; untilMs: number }): void => {
  const already = spendCap.until !== null && Date.now() < spendCap.until;
  spendCap.until = Math.max(spendCap.until ?? 0, opts.untilMs);
  spendCap.reason = opts.reason;
  if (!already) {
    spendCap.trippedAt = Date.now();
    spendCap.trips += 1;
    console.error(
      `[SPEND-CAP] TRIPPED (count ${spendCap.trips}) — ${opts.reason}. ` +
        `All generation is paused until ${new Date(spendCap.until).toISOString()}.`,
    );
  }
};

/** Lift the cap (the window rolled over, or spend fell back under it). */
export const clearSpendCap = (why: string): void => {
  if (spendCap.until === null) return;
  console.warn(`[SPEND-CAP] lifted — ${why}. Generation resumed.`);
  spendCap.until = null;
  spendCap.reason = null;
  spendCap.trippedAt = null;
};

/** Introspection for /api/health, the admin surface and tests. */
export const spendCapState = (): {
  tripped: boolean;
  reason: string | null;
  untilIso: string | null;
  trips: number;
} => {
  // Self-expiring: nothing has to run for the cap to lift at the window
  // boundary. A cap that needed a cron to release it would be an outage that
  // outlives the condition.
  if (spendCap.until !== null && Date.now() >= spendCap.until) {
    clearSpendCap("the cap window rolled over");
  }
  return {
    tripped: spendCap.until !== null,
    reason: spendCap.reason,
    untilIso: spendCap.until === null ? null : new Date(spendCap.until).toISOString(),
    trips: spendCap.trips,
  };
};

/** Test-only reset. */
export const resetSpendCapForTests = (): void => {
  spendCap.until = null;
  spendCap.reason = null;
  spendCap.trippedAt = null;
  spendCap.trips = 0;
};

/**
 * Gate every spend entrypoint (build / generate / regen) with this BEFORE
 * doing any work. Throws ZaiUnavailableError while the circuit is open;
 * after the cooldown it lets exactly ONE caller through as the probe.
 *
 * Our own spend cap is checked FIRST: when both are true, "we stopped
 * ourselves" is the truer explanation and the one that leads to the right
 * action.
 */
export const assertZaiAvailable = (): void => {
  const cap = spendCapState();
  if (cap.tripped) {
    throw new SpendCapExceededError(cap.reason ?? "spend cap", cap.untilIso ?? "");
  }
  if (state.openedAt === null) return;
  const elapsed = Date.now() - state.openedAt;
  if (elapsed >= COOLDOWN_MS && !state.probing) {
    state.probing = true; // half-open: this caller is the probe
    console.warn("[ZAI-BALANCE-CIRCUIT] half-open — letting one probe request through");
    return;
  }
  throw new ZaiUnavailableError();
};

/** Introspection for status surfaces / tests. */
export const zaiBreakerState = (): { open: boolean; trips: number } => ({
  open: state.openedAt !== null,
  trips: state.trips,
});

/** Test-only reset. */
export const resetZaiBreakerForTests = (): void => {
  state.openedAt = null;
  state.trips = 0;
  state.probing = false;
};
