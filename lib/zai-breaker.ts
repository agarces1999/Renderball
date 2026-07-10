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

const COOLDOWN_MS = 10 * 60 * 1000; // re-probe every 10 minutes while dry

export class ZaiUnavailableError extends Error {
  readonly friendly =
    "Video generation is temporarily unavailable — our AI provider account needs attention. Your quota was NOT used; please try again in a few minutes.";
  constructor() {
    super("z.ai account unavailable ([1113] insufficient balance) — circuit open");
    this.name = "ZaiUnavailableError";
  }
}

interface BreakerState {
  openedAt: number | null;
  trips: number;
  probing: boolean;
}

const state: BreakerState = { openedAt: null, trips: 0, probing: false };

/** 429 [1113] — the balance/account error. Deliberately narrow: overloads and
 *  network faults are handled by the retry ladder + adaptive gate, not here. */
export const isBalanceError = (err: unknown): boolean => {
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as Error & { cause?: unknown }).cause ?? "")}`
      : String(err);
  return /\[1113\]|Insufficient balance|no resource package/i.test(msg);
};

const markerPath = () => path.join(process.cwd(), ".data", "zai-balance-tripped.json");

const trip = (): void => {
  state.openedAt = Date.now();
  state.trips += 1;
  state.probing = false;
  // ── ALERT SURFACE ──────────────────────────────────────────────────────
  // Loud, structured, greppable. TODO(launch): page a real channel here the
  // moment Resend/Sentry credentials exist — this is the production SPOF.
  console.error(
    `[ZAI-BALANCE-CIRCUIT] TRIPPED (count ${state.trips}) at ${new Date().toISOString()} — ` +
      `all generation is failing fast until the z.ai account is recharged. ` +
      `Recharge at z.ai, then the breaker self-probes every ${COOLDOWN_MS / 60000} min.`,
  );
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
  }
};

/**
 * Gate every spend entrypoint (build / generate / regen) with this BEFORE
 * doing any work. Throws ZaiUnavailableError while the circuit is open;
 * after the cooldown it lets exactly ONE caller through as the probe.
 */
export const assertZaiAvailable = (): void => {
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
