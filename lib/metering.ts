/**
 * Usage-based token metering — the canvas pivot's pricing pipeline
 * (docs/PIVOT.md locked decision #4, mechanics in docs/METERING.md).
 *
 * The unit of account is the LLM token (input + output) per owner, lifetime.
 * Users get RB_FREE_TOKENS (default 1M) free; past that, LLM-spending ops
 * require an active subscription and every op's overage is reported to a
 * Stripe Billing Meter. Deterministic edits (move/resize/text/delete/undo)
 * never touch this module — "editing is free, generating is metered."
 *
 * Design invariants:
 *  - The free allowance is enforced HERE, app-side, against TokenUsage.
 *    Stripe only ever sees overage tokens on a flat per-unit metered price —
 *    see docs/METERING.md for why that beats a $0 first tier / credit grants.
 *  - Counting and outbox writes are best-effort and NEVER throw into an op;
 *    the gate is FAIL-CLOSED (an outage must not mean free unlimited spend),
 *    matching lib/entitlement.ts posture, with withDbRetry absorbing Neon
 *    cold wakes.
 *  - Everything is env-gated behind RB_METERING (off by default) so current
 *    flows are byte-identical until launch flips the flag.
 *
 * RB_METERING modes:
 *  - "off"  (default): no DB writes, gate always allows. Zero behavior change.
 *  - "count": tokens are counted per owner (shadow data pre-launch), gate
 *    still always allows, Stripe never contacted.
 *  - "on":   counted + allowance enforced (402 past 1M without billing) +
 *    overage reported to the Stripe meter for billing-active users.
 */
import { prisma, withDbRetry } from "./db";
import { getStripe, isStripeConfigured } from "./stripe";
import { DEV_OWNER_ID } from "./store";
import type { Usage } from "./usage";

export type MeteringMode = "off" | "count" | "on";

/** PURE: parse the RB_METERING env value (case/synonym tolerant). */
export const meteringModeOf = (raw: string | undefined | null): MeteringMode => {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "on" || v === "enforce" || v === "1" || v === "true") return "on";
  if (v === "count" || v === "shadow") return "count";
  return "off";
};

export const meteringMode = (): MeteringMode => meteringModeOf(process.env.RB_METERING);

/** Free lifetime token allowance (env-tunable; 1M per docs/PIVOT.md). */
export const freeTokenAllowance = (): number => {
  const v = Number(process.env.RB_FREE_TOKENS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 1_000_000;
};

/**
 * PURE: tokens an operation counts against the meter — input + output.
 * Cache reads/writes are deliberately EXCLUDED for now: on the live Fireworks
 * transport cache fields are zero (castCall doesn't surface them), and the
 * user-facing pricing story is simplest as "tokens in + tokens out". If cached
 * tokens start flowing, weighting them is a one-line change HERE (the open
 * markup/per-model-rate discussion in PIVOT.md owns that call).
 */
export const countedTokens = (u: Usage): number =>
  Math.max(0, (u.input_tokens ?? 0) + (u.output_tokens ?? 0));

export interface TokenGate {
  allowed: boolean;
  usedTokens: number;
  freeTokens: number;
  freeRemaining: number;
  billingActive: boolean;
  /** Present iff denied — safe to show the user verbatim. */
  reason?: string;
}

/** "1M" / "500k" / "1234" — allowance figures for user-facing copy. */
export const formatTokens = (n: number): string => {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${(n / 1_000_000).toString().replace(/\.0$/, "")}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
};

/**
 * PURE: the allowance decision. Over the free allowance without active
 * billing → denied with a friendly upgrade message; billing-active users are
 * never blocked (their overage is metered instead).
 */
export const decideTokenGate = (args: {
  mode: MeteringMode;
  usedTokens: number;
  freeTokens: number;
  billingActive: boolean;
}): TokenGate => {
  const { mode, usedTokens, freeTokens, billingActive } = args;
  const freeRemaining = Math.max(0, freeTokens - usedTokens);
  const base = { usedTokens, freeTokens, freeRemaining, billingActive };
  if (mode !== "on") return { allowed: true, ...base };
  if (billingActive || usedTokens < freeTokens) return { allowed: true, ...base };
  return {
    allowed: false,
    ...base,
    reason:
      `You've used your ${formatTokens(freeTokens)} free tokens. ` +
      "Add billing to keep generating — you only pay for what you generate, " +
      "and editing what you've already made stays free.",
  };
};

/**
 * PURE: how much of an op's spend is billable overage, and the new
 * billed-tokens watermark.
 *
 * shouldBeBilled = lifetime tokens beyond the free allowance. We emit at most
 * THIS op's tokens (never back-bill history: tokens burned pre-subscription,
 * in count-mode, or in the free tail of the op that crossed the line are
 * forgiven by advancing the watermark without emitting). The watermark is
 * monotone via max(), so a raised RB_FREE_TOKENS later can't produce negative
 * deltas.
 */
export const computeBillableDelta = (args: {
  /** Lifetime total AFTER this op's increment. */
  totalTokens: number;
  /** This op's counted tokens. */
  opTokens: number;
  /** Watermark of tokens already handed to the outbox. */
  billedTokens: number;
  freeTokens: number;
}): { emit: number; newBilled: number } => {
  const shouldBeBilled = Math.max(0, args.totalTokens - args.freeTokens);
  const emit = Math.min(Math.max(0, shouldBeBilled - args.billedTokens), Math.max(0, args.opTokens));
  return { emit, newBilled: Math.max(args.billedTokens, shouldBeBilled) };
};

/**
 * Count one op's tokens against the owner and, in "on" mode for
 * billing-active owners, enqueue the billable overage for Stripe.
 *
 * Best-effort by contract: called AFTER real LLM spend, so a metering failure
 * must never fail the op — errors are logged loudly (an undercount here is
 * revenue leak, not user harm). No-ops for the dev owner, zero-token bundles,
 * and mode "off".
 */
export const recordTokenUsage = async (entry: {
  ownerId: string;
  usage: Usage;
  /** Ledger label for logs only ("build" | "generate" | "regen-element" | ...). */
  op: string;
}): Promise<void> => {
  const mode = meteringMode();
  if (mode === "off") return;
  if (!entry.ownerId || entry.ownerId === DEV_OWNER_ID) return;
  const tokens = countedTokens(entry.usage);
  if (tokens <= 0) return;
  try {
    // Atomic DB-side increment; upsert compiles to INSERT..ON CONFLICT here
    // (unique where, no nested writes) so concurrent first-ops can't collide.
    const row = await withDbRetry(() =>
      prisma.tokenUsage.upsert({
        where: { ownerId: entry.ownerId },
        create: { ownerId: entry.ownerId, totalTokens: BigInt(tokens) },
        update: { totalTokens: { increment: tokens } },
      }),
    );

    if (mode !== "on") return;

    const user = await prisma.user.findUnique({
      where: { id: entry.ownerId },
      select: { plan: true },
    });
    if (user?.plan !== "subscription") return; // free-tier spend is never billed

    const totalTokens = Number(row.totalTokens);
    const billedTokens = Number(row.billedTokens);
    const { emit, newBilled } = computeBillableDelta({
      totalTokens,
      opTokens: tokens,
      billedTokens,
      freeTokens: freeTokenAllowance(),
    });
    if (newBilled === billedTokens) return;

    // Optimistic watermark claim: if a concurrent op moved the watermark
    // first, ITS delta already accounts for these totals — skip ours. Worst
    // case is an undercount of one op's overage in a same-owner race (rare:
    // the build lock + regen cap serialize owners), never a double-bill.
    const claimed = await prisma.tokenUsage.updateMany({
      where: { ownerId: entry.ownerId, billedTokens: BigInt(billedTokens) },
      data: { billedTokens: BigInt(newBilled) },
    });
    if (claimed.count === 1 && emit > 0) {
      await prisma.meterEventOutbox.create({
        data: { ownerId: entry.ownerId, tokens: emit },
      });
      // Fire-and-forget: the op's latency never includes Stripe.
      void flushMeterOutbox().catch(() => {});
    }
  } catch (err) {
    console.error(
      `[metering] token count FAILED for op=${entry.op} owner=${entry.ownerId} (undercount risk):`,
      err,
    );
  }
};

/**
 * The allowance gate — call BEFORE any LLM-spending op (build, generate,
 * marquee-generate, element/scene regen). FAIL-CLOSED in "on" mode: a
 * metering outage must never mean free unlimited spend. Modes off/count
 * always allow without touching the DB.
 */
export const checkTokenAllowance = async (ownerId: string): Promise<TokenGate> => {
  const mode = meteringMode();
  const freeTokens = freeTokenAllowance();
  if (mode !== "on" || ownerId === DEV_OWNER_ID) {
    return decideTokenGate({ mode: "off", usedTokens: 0, freeTokens, billingActive: false });
  }
  try {
    const [user, row] = await withDbRetry(() =>
      Promise.all([
        prisma.user.findUnique({ where: { id: ownerId }, select: { plan: true } }),
        prisma.tokenUsage.findUnique({ where: { ownerId } }),
      ]),
    );
    return decideTokenGate({
      mode,
      usedTokens: row ? Number(row.totalTokens) : 0,
      freeTokens,
      billingActive: user?.plan === "subscription",
    });
  } catch (err) {
    console.error("[metering] allowance check failed — denying (fail-closed):", err);
    return {
      allowed: false,
      usedTokens: 0,
      freeTokens,
      freeRemaining: 0,
      billingActive: false,
      reason: "We couldn't check your token balance just now — please try again in a moment.",
    };
  }
};

/**
 * Read-only summary for the account page / GET /api/usage — the same numbers
 * the gate enforces. Returns zeros in "off" mode (the UI hides the meter),
 * null on DB failure (callers hide rather than block).
 */
export const getTokenUsageSummary = async (
  ownerId: string,
): Promise<{ usedTokens: number; freeTokens: number; freeRemaining: number; billingActive: boolean } | null> => {
  const mode = meteringMode();
  const freeTokens = freeTokenAllowance();
  if (mode === "off") {
    return { usedTokens: 0, freeTokens, freeRemaining: freeTokens, billingActive: false };
  }
  try {
    const [user, row] = await withDbRetry(() =>
      Promise.all([
        prisma.user.findUnique({ where: { id: ownerId }, select: { plan: true } }),
        prisma.tokenUsage.findUnique({ where: { ownerId } }),
      ]),
    );
    const usedTokens = row ? Number(row.totalTokens) : 0;
    return {
      usedTokens,
      freeTokens,
      freeRemaining: Math.max(0, freeTokens - usedTokens),
      billingActive: user?.plan === "subscription",
    };
  } catch (err) {
    console.warn("[metering] usage summary failed:", err);
    return null;
  }
};

/** Stripe meter event_name — must match the meter created by scripts/stripe-setup-meter.mjs. */
export const tokenMeterEventName = (): string =>
  process.env.STRIPE_TOKEN_METER_EVENT || "renderball_tokens";

/**
 * Flush pending outbox rows to the Stripe Billing Meter. At-least-once:
 * `identifier = row.id` lets Stripe dedupe replays, so concurrent flushes and
 * retries after a crash are harmless. Rows for owners without a
 * stripeCustomerId yet stay pending (the webhook stores the id at checkout;
 * the next flush picks them up). Never throws; returns counts for logging.
 */
export const flushMeterOutbox = async (limit = 25): Promise<{ sent: number; failed: number }> => {
  if (meteringMode() !== "on" || !isStripeConfigured()) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  try {
    const pending = await prisma.meterEventOutbox.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    if (pending.length === 0) return { sent, failed };

    const owners = [...new Set(pending.map((p) => p.ownerId))];
    const users = await prisma.user.findMany({
      where: { id: { in: owners } },
      select: { id: true, stripeCustomerId: true },
    });
    const customerOf = new Map(users.map((u) => [u.id, u.stripeCustomerId]));

    const stripe = getStripe();
    const eventName = tokenMeterEventName();
    for (const row of pending) {
      const customerId = customerOf.get(row.ownerId);
      try {
        if (!customerId) throw new Error("owner has no stripeCustomerId yet");
        await stripe.billing.meterEvents.create({
          event_name: eventName,
          identifier: row.id, // Stripe-side idempotency
          payload: {
            stripe_customer_id: customerId,
            value: String(row.tokens),
          },
        });
        await prisma.meterEventOutbox.update({
          where: { id: row.id },
          data: { status: "sent", sentAt: new Date() },
        });
        sent++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        await prisma.meterEventOutbox
          .update({
            where: { id: row.id },
            data: { attempts: { increment: 1 }, lastError: message.slice(0, 500) },
          })
          .catch(() => {});
        console.warn(`[metering] meter event ${row.id} not sent (attempt logged): ${message}`);
      }
    }
  } catch (err) {
    console.warn("[metering] outbox flush failed:", err);
  }
  return { sent, failed };
};
