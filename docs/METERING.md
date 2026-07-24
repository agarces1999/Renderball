# Token metering & usage-based billing

Operating doc for the canvas pivot's pricing pipeline (docs/PIVOT.md locked
decision #4): **1M tokens free, then per-token billing at a markup**, via
Stripe usage-based billing. Deterministic edits (move/resize/text/delete/
undo/primitive inserts) cost 0 tokens — the product story is "editing is
free, generating is metered."

Code home: `lib/metering.ts` (policy + IO), `prisma/schema.prisma`
(`TokenUsage`, `MeterEventOutbox`), `scripts/stripe-setup-meter.mjs` (Stripe
objects), `GET /api/usage` (account surface).

## The Stripe shape — and why

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
- **Outbox** — `MeterEventOutbox` rows are flushed to
  `stripe.billing.meterEvents.create` fire-and-forget with
  `identifier = row.id`; Stripe dedupes identifiers, so at-least-once
  delivery (crash between send and mark-sent, concurrent flushes) is safe.
  **No op ever blocks on Stripe availability** — unsent rows retry on later
  ops. Rows for owners whose `stripeCustomerId` hasn't landed yet (webhook
  in flight) stay pending and flush next round.
- **billingActive** — `User.plan === "subscription"`, flipped by the existing
  price-agnostic Stripe webhook (`checkout.session.completed`,
  `customer.subscription.updated/deleted`). No new webhook events needed.

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
| `RB_METERING` | `off` | `off` = everything inert (current flows byte-identical). `count` = shadow-count tokens only, no gate, no Stripe. `on` = count + 402 gate + meter events. |
| `RB_FREE_TOKENS` | `1000000` | Lifetime free allowance. |
| `STRIPE_PRICE_TOKENS` | — | The metered per-unit price id (from the setup script). Enables the `tokens` checkout. |
| `STRIPE_TOKEN_METER_EVENT` | `renderball_tokens` | Meter event name; only set to override. |

## Launch runbook

1. `node scripts/stripe-setup-meter.mjs --usd-per-million <rate>` against the
   test key. Rate math: blended COGS today is ≈ **$3.1/M counted tokens**
   (P1 deck build: 257k in + 76k out = $1.04 at Fireworks fast-router rates),
   so e.g. $10/M ≈ 3.2× markup, $15/M ≈ 4.8×. Founder call — the script
   refuses to default it.
2. Set `STRIPE_PRICE_TOKENS` (+ webhook secret etc. per docs/LAUNCH.md).
3. Set `RB_METERING=count` for the shadow period — watch `TokenUsage` fill
   against `.data/usage.jsonl` for sanity.
4. Flip `RB_METERING=on` at launch. The billing page's "add usage billing"
   checkout posts `{ "plan": "tokens" }` to `/api/billing/checkout`.
5. Repeat step 1 once against the live key before GA.

## Supersession note

This pipeline supersedes the $49.99 flat subscription plan (docs/LAUNCH.md
#6) per PIVOT.md. The old per-op entitlement caps (`lib/entitlement.ts`)
stay active as an abuse backstop underneath token metering; loosen their env
limits when token pricing is live rather than deleting the mechanism.
