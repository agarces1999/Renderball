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
import { getStripe } from "./stripe";
import { reportLemonUsage } from "./lemonsqueezy";
import { billingProvider } from "./billing-provider";
import { DEV_OWNER_ID } from "./store";
import type { Usage } from "./usage";

export type MeteringMode = "off" | "count" | "on";

/** PURE: parse the RB_METERING env value (case/synonym tolerant).
 *
 * DEFAULT IS "count" (the shadow period) since 2026-08-13 — the founder,
 * launch-testing, opened /billing and watched a token meter read 0/1M while
 * the ops ledger held every one of his builds' tokens: "off" was shipped as
 * a safe rollout default and then nobody flipped it, which made the
 * user-facing meter a lie by omission. Counting writes one row per op and
 * contacts no processor; enforcement (the 402 gate + usage reporting) still
 * requires the explicit "on". "off" remains available for offline work.
 */
export const meteringModeOf = (raw: string | undefined | null): MeteringMode => {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "on" || v === "enforce" || v === "1" || v === "true") return "on";
  if (v === "off" || v === "0" || v === "false" || v === "none") return "off";
  return "count";
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
 * How many tokens make up ONE billable unit.
 *
 * The product prices per token, but a processor bills integer quantities of
 * whatever unit its price is denominated in — and at a ~3x markup a token is
 * worth $0.00001, which most billing forms will not accept (two to four decimal
 * places is typical). Setting this to 1000 lets the price be per-1,000-tokens
 * (a workable $0.01) while nothing else in the system changes: the counter, the
 * allowance and the watermark all still speak tokens.
 *
 * Default 1 — report raw tokens — so this is inert unless the processor forced
 * the issue. Getting it wrong is a 1000x invoice, so it is read once, here, and
 * anything unusable falls back to 1 rather than to a guess.
 */
export const meterUnitTokens = (): number => {
  const raw = Number(process.env.RB_METER_UNIT_TOKENS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
};

/**
 * PURE: convert tokens to whole billable units, keeping the change.
 *
 * `remainder` is the owner's leftover from previous reports. Returns the units
 * to send now and the leftover to store — so a stream of small operations
 * eventually bills for all of them instead of rounding each one to zero.
 *
 * Total is conserved by construction: units * unit + newRemainder always equals
 * remainder + tokens.
 */
export const toBillableUnits = (args: {
  tokens: number;
  remainder: number;
  unit: number;
}): { units: number; newRemainder: number } => {
  const unit = Math.max(1, Math.floor(args.unit));
  const pending = Math.max(0, Math.floor(args.tokens)) + Math.max(0, Math.floor(args.remainder));
  return { units: Math.floor(pending / unit), newRemainder: pending % unit };
};

/**
 * Flush pending outbox rows to whichever processor is live.
 *
 * The outbox itself is provider-agnostic — a row is "this owner owes for N
 * overage tokens" — and only the delivery differs:
 *
 *   Stripe: a Billing Meter event keyed by the customer id, with
 *     `identifier = row.id` so Stripe dedupes replays for us.
 *   Lemon Squeezy: a usage record against the subscription ITEM id, which has
 *     no idempotency key. Safety there comes from the watermark being claimed
 *     in the database BEFORE the row is written (see recordTokenUsage): a retry
 *     re-sends a row that was never marked sent, and a row marked sent is never
 *     considered again.
 *
 * Rows for owners we cannot yet address — no customer id, no subscription item
 * — stay pending rather than failing permanently; the webhook fills those in at
 * checkout and the next flush picks them up. Never throws.
 */
export const flushMeterOutbox = async (limit = 25): Promise<{ sent: number; failed: number }> => {
  const provider = billingProvider();
  if (meteringMode() !== "on" || provider === "none") return { sent: 0, failed: 0 };
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
    const [users, subs, usage] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: owners } },
        select: { id: true, stripeCustomerId: true },
      }),
      provider === "lemonsqueezy"
        ? prisma.subscription.findMany({
            where: { userId: { in: owners } },
            select: { userId: true, lemonItemId: true },
          })
        : Promise.resolve([] as { userId: string; lemonItemId: string | null }[]),
      prisma.tokenUsage.findMany({
        where: { ownerId: { in: owners } },
        select: { ownerId: true, remainderTokens: true },
      }),
    ]);
    const customerOf = new Map(users.map((u) => [u.id, u.stripeCustomerId]));
    const itemOf = new Map(subs.map((s) => [s.userId, s.lemonItemId]));
    // Carried across rows within this batch: several rows for one owner must
    // accumulate towards a unit rather than each rounding to zero on its own.
    const remainderOf = new Map(usage.map((u) => [u.ownerId, u.remainderTokens]));

    const eventName = tokenMeterEventName();
    const unit = meterUnitTokens();
    for (const row of pending) {
      try {
        const { units, newRemainder } = toBillableUnits({
          tokens: row.tokens,
          remainder: remainderOf.get(row.ownerId) ?? 0,
          unit,
        });

        // Below one whole unit: nothing to report yet, but the row is done —
        // its tokens live on in the remainder and bill with the next one.
        if (units > 0) {
          if (provider === "lemonsqueezy") {
            const itemId = itemOf.get(row.ownerId);
            if (!itemId) throw new Error("owner has no Lemon Squeezy subscription item yet");
            await reportLemonUsage(itemId, units);
          } else {
            const customerId = customerOf.get(row.ownerId);
            if (!customerId) throw new Error("owner has no stripeCustomerId yet");
            await getStripe().billing.meterEvents.create({
              event_name: eventName,
              identifier: row.id, // Stripe-side idempotency
              payload: {
                stripe_customer_id: customerId,
                value: String(units),
              },
            });
          }
        }

        // Only after a successful report. A failure above leaves the row
        // pending AND the remainder untouched, so the retry is exact.
        await prisma.meterEventOutbox.update({
          where: { id: row.id },
          data: { status: "sent", sentAt: new Date() },
        });
        if (unit > 1) {
          await prisma.tokenUsage
            .update({ where: { ownerId: row.ownerId }, data: { remainderTokens: newRemainder } })
            .catch((e) => {
              // Losing the remainder undercharges by less than one unit; losing
              // the whole flush would be worse, so this is logged, not thrown.
              console.warn(`[metering] remainder not persisted for ${row.ownerId}:`, e);
            });
        }
        remainderOf.set(row.ownerId, newRemainder);
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
