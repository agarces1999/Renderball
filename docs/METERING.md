# Token metering & usage-based billing

Operating doc for the canvas pivot's pricing pipeline (docs/PIVOT.md locked
decision #4): **1M tokens free, then per-token billing at a markup**, via
usage-based billing. Deterministic edits (move/resize/text/delete/
undo/primitive inserts) cost 0 tokens — the product story is "editing is
free, generating is metered."

Code home: `lib/metering.ts` (policy + IO), `prisma/schema.prisma`
(`TokenUsage`, `MeterEventOutbox`), `lib/billing-provider.ts` (which
processor), `GET /api/usage` (account surface).

## Processor: Lemon Squeezy (2026-07-30)

**Stripe is unavailable to this company.** It does not operate in Colombia,
and the workaround is incorporating abroad — weeks and money before any
revenue. Lemon Squeezy is a merchant of record (they are the seller of
record, they handle VAT worldwide) and supports metered usage-based
subscriptions, so the model below survives the switch unchanged.

What differs in practice:

- **Usage attaches to a subscription ITEM**, not a subscription or a
  customer. `Subscription.lemonItemId` holds it, captured from the
  `subscription_created` webhook. A subscriber whose row lacks it looks
  perfectly healthy and cannot be charged — `lib/metering.ts` therefore
  leaves such rows pending rather than marking them sent, and the webhook
  never overwrites a known item id with null.
- **No idempotency key on usage records.** Stripe dedupes replays via
  `identifier`; Lemon Squeezy has no equivalent. Safety comes from the
  watermark being claimed in the database *before* the outbox row is
  written, so a retry re-sends a row that was never marked sent and a row
  marked sent is never reconsidered.
- **A metered checkout charges $0 up front** and bills in arrears. That is
  exactly the shape argued for below — free users never touch the processor.

`scripts/stripe-setup-meter.mjs` belongs to the dormant Stripe path. On
Lemon Squeezy the equivalent is a product setting: Subscription product →
**"Usage is metered" ON** → copy the VARIANT id.

## The Stripe shape — and why (retained: the reasoning is processor-agnostic)


**Chosen: a flat per-unit metered Price; the 1M free allowance is enforced
app-side and Stripe only ever receives OVERAGE tokens.**

PIVOT.md floated two Stripe primitives for the free allowance. Both fit
badly, for the same structural reason: the allowance must exist **before any
Stripe relationship does**.

- **$0 first tier on a graduated price** — a tier lives inside a
  subscription, so every free user would need a Stripe subscription (and
  Checkout) before their first build. Worse, graduated tiers reset every
  billing period: a subscriber would get a fresh 1M free *each month*,
  which is not the product (the allowance is a one-time lifetime trial).
  And since meter events only flow once a subscription exists, a user who
  burned their 1M pre-subscription would get *another* 1M after subscribing.
- **Granted credits (`billing.creditGrants`)** — closer in spirit
  (lifetime, one-time), but credits also attach to a Stripe customer, and
  we'd have to mirror the remaining-allowance state app-side anyway to
  answer the 402 gate on every op (the gate cannot do a synchronous Stripe
  read per build — fail-closed on *our* DB is the availability posture).
  That's the same number stored twice, with drift as the failure mode.

Reporting **only overage** dissolves both problems: free users never touch
Stripe; the allowance is trivially lifetime; a user who subscribes early
pays $0 until they actually cross 1M lifetime tokens (no credit bookkeeping
— the watermark math below does it); and the Price object stays a dead-simple
flat per-unit rate whose markup is one number.

## What counts

`countedTokens = input_tokens + output_tokens` of every LLM call, lifetime,
per owner. Cache read/write tokens are deliberately excluded for now: the
Fireworks transport surfaces zeros there today, and the user-facing story is
simplest as tokens-in + tokens-out. When the open markup/per-model-rate
decision lands (PIVOT.md), weighting lives in exactly one place:
`countedTokens` in `lib/metering.ts`.

Counted ops: build (success *and* failure — failed attempts spent real
tokens; also prevents free-tier burn via deliberate failures), generate,
scene/element regenerate, marquee insert-element (generate mode), vision-QA
spend inside builds, and crawls. Gated ops (402 past the allowance without
billing): **build, generate, regenerate-element, regenerate-scene,
insert-element generate mode**. Crawls are counted but keep their existing
softer entitlement deny. Dev-owner traffic (`DEV_OWNER_ID`) is never counted
or gated.

## Mechanics

- **Counter** — `TokenUsage` (one row per owner): `totalTokens` incremented
  atomically after every counted op; `billedTokens` is the watermark of
  overage already handed to Stripe.
- **Gate** — `checkTokenAllowance` before each gated op: under 1M → allowed;
  over 1M with an active subscription → allowed (metered); over 1M without →
  402 with upgrade copy. FAIL-CLOSED on DB errors (an outage must never mean
  free unlimited spend), `withDbRetry` absorbs Neon cold wakes.
- **Overage watermark** — after each counted op, for billing-active owners:
  `shouldBeBilled = max(0, total − free)`; emit
  `clamp(shouldBeBilled − billedTokens, 0, thisOpTokens)` to the outbox and
  advance the watermark to `max(billedTokens, shouldBeBilled)`. The clamp
  means an op straddling the 1M line bills only its over-the-line share, and
  overage accrued while unbilled (count-mode shadow period, or the free tail)
  is **forgiven, never back-billed** — no surprise first invoice.
- **Outbox** — `MeterEventOutbox` rows are provider-agnostic ("this owner owes
  for N overage tokens") and flushed fire-and-forget. On Lemon Squeezy that is
  a usage record against `Subscription.lemonItemId`; on Stripe a meter event
  with `identifier = row.id`, which Stripe dedupes. **No op ever blocks on the
  processor's availability** — unsent rows retry on later ops. Rows for owners
  we cannot yet address (no subscription item, no customer id — webhook in
  flight) stay pending and flush next round.
- **billingActive** — `User.plan === "subscription"`, flipped by whichever
  webhook is live: `subscription_*` on Lemon Squeezy, or
  `checkout.session.completed` / `customer.subscription.updated|deleted` on
  Stripe. The gate never asks which.

Known bounded edge cases (accepted for launch, both revenue-safe):
- Two *simultaneous* ops by one owner can race the watermark; the loser
  skips its emission (≤ one op's overage under-billed, never double-billed).
  Same-owner concurrency is already rare — the build lock and hourly regen
  cap serialize owners.
- Stripe's identifier-dedupe window is ~24h; an outbox row that first
  succeeds but crashes before mark-sent AND then isn't retried for >24h
  could double-send. Flushes ride every metered op, so a >24h gap means no
  activity — and the next flush is the retry.

## Env flags

| Var | Default | Meaning |
| --- | --- | --- |
| `RB_METERING` | `off` | `off` = everything inert (current flows byte-identical). `count` = shadow-count tokens only, no gate, no processor contact. `on` = count + 402 gate + usage reporting. |
| `RB_FREE_TOKENS` | `1000000` | Lifetime free allowance. |
| `LEMONSQUEEZY_API_KEY` | — | Live processor. All four Lemon vars must be set before checkout, portal, webhook or usage reporting do anything. |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | — | Signs `/api/webhooks/lemonsqueezy`. The only defence that endpoint has. |
| `LEMONSQUEEZY_STORE_ID` | — | Numeric store id. |
| `LEMONSQUEEZY_VARIANT_TOKENS` | — | Numeric VARIANT id of the metered plan (not the product id). |
| `STRIPE_PRICE_TOKENS` | — | Dormant path: the metered per-unit price id (from the setup script). |
| `STRIPE_TOKEN_METER_EVENT` | `renderball_tokens` | Dormant path: meter event name; only set to override. |

## Launch runbook

1. In Lemon Squeezy: create a Subscription product with **"Usage is metered"
   ON**, priced per unit. Rate math: blended COGS today is ≈ **$3.1/M counted
   tokens** (P1 deck build: 257k in + 76k out = $1.04 at Fireworks fast-router
   rates), so e.g. $10/M ≈ 3.2× markup, $15/M ≈ 4.8×. Founder call. Note the
   unit is ONE TOKEN, so the per-unit price is the rate ÷ 1,000,000 — get this
   wrong by six orders of magnitude and the first invoice will say so.
2. Set the four `LEMONSQUEEZY_*` vars (per `.env.example`) and register the
   webhook at `<APP_URL>/api/webhooks/lemonsqueezy` with every
   `subscription_*` event.
3. Set `RB_METERING=count` for the shadow period — watch `TokenUsage` fill
   against `.data/usage.jsonl` for sanity.
4. Subscribe with a real card once and confirm `Subscription.lemonItemId` is
   populated. **This is the step that cannot be skipped**: a subscriber
   without an item id looks entirely healthy and can never be charged.
5. Flip `RB_METERING=on`. Generate something past the allowance on a test
   account and confirm a usage record lands in the Lemon Squeezy dashboard.

(The dormant Stripe path's equivalent step 1 is
`node scripts/stripe-setup-meter.mjs --usd-per-million <rate>`.)

## Supersession note

This pipeline supersedes the $49.99 flat subscription plan (docs/LAUNCH.md
#6) per PIVOT.md. The old per-op entitlement caps (`lib/entitlement.ts`)
stay active as an abuse backstop underneath token metering; loosen their env
limits when token pricing is live rather than deleting the mechanism.
