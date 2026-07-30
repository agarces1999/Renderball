# Renderball — Launch Readiness & Critical Path

> Working doc started 2026-06-17. Companion to PRODUCT.md (spec) and PROGRESS.md
> (build log). This is the honest gap between "the engine works" and "we can take
> a paying customer," plus the ordered path to close it.

## Reality check

What's **built** is the creative engine — and it's the hard part: brief wizard →
brand crawl → script/design/choreography agents → local Remotion render to 1080p
MP4. What does **not** exist is the entire commercialization layer. A verified
9-agent audit (see the session transcript) found these blockers:

| Layer | State today | Blocker |
|---|---|---|
| Auth / accounts | none — every page & API route is public | anyone can read any project by ID |
| Database | JSON files in `.data/` | breaks on serverless; no user scoping |
| Multi-tenancy | no `ownerId` on anything; `listBriefs()` returns ALL | cross-customer data exposure |
| Payments | none | no Stripe at all |
| Quota / entitlement | cost recorded *after* spend | a logged-out request triggers ~$3–5 of Opus + render spend |
| Object storage | local disk (`public/renders`, `public/uploads`) | renders vanish on serverless restart |
| Prod render | synchronous, in-request | can't run in a Vercel function (timeout/memory) |
| Legal | no ToS / Privacy / DMCA | Stripe won't activate; IP exposure from re-hosting crawled logos |
| Email | none | can't send receipts / verification |
| Observability | none | payment-webhook & render failures are invisible |

**Bottom line:** "launch now" is not a single session. This is the build sprint
PRODUCT.md/GTM.md scoped for Days 15–34. The path below is real and ordered.

## Locked decisions (2026-06-17, amended 2026-07-10)

- **Auth:** Clerk (Google + email + more). Supersedes the spec's email-magic-link.
- **Payments:** Stripe **subscription + free tier** first; PAYG/credits as a fast-follow.
  - **Price: $49.99/mo** (founder decision, 2026-07-12). The app UI (`/billing`,
    landing, refunds) already reflects this. The Stripe Price object
    (`STRIPE_PRICE_SUBSCRIPTION`) must be created at $49.99 — the actual charge
    comes from that Price, not from any hardcoded number. NOTE: `docs/PRODUCT.md`
    still carries the old $29.99 unit-economics model; its margin/scenario math
    needs recomputing at $49.99 before it's cited as current.
- **Render:** ~~Remotion Lambda (AWS)~~ → **in-container `renderMedia`** for
  launch (amended 2026-07-10). The deploy is a long-running Docker container,
  not a serverless function, so the original "can't render in-request" blocker
  doesn't apply; concurrency is bounded by the build/render locks
  (`RB_MAX_CONCURRENT_BUILDS`) and renders persist to R2. Lambda remains the
  scale-out path when a single container's CPU becomes the bottleneck.

## Shipped this session (no credentials required)

Hardening that protects you regardless of launch timing. Type-check clean, full
test suite green.

- **SSRF guard** — [lib/crawl/ssrf-guard.ts](../lib/crawl/ssrf-guard.ts) + test. Every
  user-influenced crawl fetch ([extract-brand](../lib/crawl/extract-brand.ts),
  [find-logo-agent](../lib/crawl/find-logo-agent.ts), [vision-brand](../lib/crawl/vision-brand.ts))
  now resolves the host and refuses loopback / private / link-local / cloud-metadata
  (`169.254.169.254`) addresses, re-validating every redirect hop. Closes the
  "paste an internal URL" credential-exfiltration vector.
- **Path-traversal guard** — [lib/store.ts](../lib/store.ts) `loadBrief`/`loadScript`
  reject any id that isn't a 26-char ULID before it reaches `path.join`.
- **Upload content validation** — [lib/uploads.ts](../lib/uploads.ts) sniffs real
  magic bytes (PNG/JPEG/GIF/WebP/PDF/SVG) instead of trusting the client `file.type`,
  + `X-Content-Type-Options: nosniff` on `/uploads/*` ([next.config.js](../next.config.js)).

## Adversarial infra audit — 2026-07-12 (24 findings fixed, commit e806ad1)

A 7-dimension multi-agent audit of the launch infra, every finding verified by
an independent skeptic panel before the fix landed. Highlights:

- **Stripe** — resubscribe-after-cancel no longer strands a paying customer on
  `free` (webhook upserts the Subscription by `userId`, not the changing
  `stripeSubscriptionId`; permanent constraint errors ack so Stripe stops
  retrying); checkout blocks a second live subscription; account deletion
  cancels the live subscription first.
- **GDPR** — an in-flight build/render can no longer resurrect a deleted user's
  script JSON or MP4 (owner-existence guards in `saveScript` + `render-brief`);
  R2 failures no longer abort the observable DB deletion.
- **Security** — SVG uploads on the production `/api/assets` path now carry a
  locked-down CSP + attachment disposition (the `next.config` sandbox only
  covered `/uploads`).
- **Resilience** — `withDbRetry` absorbs Neon scale-to-zero cold-wakes (the
  first request after idle was 500ing); `getCurrentUser` + `submitBrief`
  fail friendly instead of crashing/losing spend. **Set
  `connect_timeout=15` on `DATABASE_URL`.**
- **Delivery** — `/videos` shows finished MP4s on a fresh container (keyed on
  the `Render` row); `/api/renders` supports HTTP Range so Safari/iOS video
  plays.
- **Deploy** — the Dockerfile now hard-verifies Playwright Chromium (the
  blocking render gate needs it) and pre-fetches Remotion's browser via the
  real node API.

## Build performance (measured 2026-07-12, launch config)

Instrumented 5-scene HubSpot build: generate ~2 min · scaffold ~6 min ·
parallel fills ~16 min (**0 z.ai overloads** — concurrency machinery validated)
· structural gates + scoped LLM retries ~15 min · render-truth + vision ~1 min.
**Total ~37 min.** Every build now writes `build-timeline.json` for phase
attribution. The optimization lever is the gate-retry phase, not the fills.

## Data model of record

[prisma/schema.prisma](../prisma/schema.prisma) — `User / Subscription / Project /
Render / UsageRecord / FreeTierSignup`, every owned row keyed by `ownerId`. Designed,
not yet migrated (needs `DATABASE_URL`).

## Critical path (ordered — each phase unblocks the next)

1. ✅ **Database + Prisma.** Neon migrated (6 tables); `lib/db.ts` singleton. Brief/script
   bytes still file-backed for now — the store API is owner-aware so the file→Postgres
   swap (3b) is a pure internal change. *Done 2026-06-19.*
2. ✅ **Auth (Clerk).** `@clerk/nextjs@6`, `middleware.ts`, `<ClerkProvider>`, header
   controls, `lib/auth.ts` identity bridge (lazy Clerk→Neon user upsert). *Done.*
3. ✅ **Multi-tenant scoping.** `listBriefsByOwner()`; required-`ownerId` reads; auth on
   every page/action/preview route. Adversarially reviewed — fixed a real IDOR (renders
   moved out of `public/` to a gated `/api/renders/<id>` route). *Done.*
   - Residuals: ✅ Clerk→DB **user-sync webhook** built 2026-07-10
     (`/api/webhooks/clerk`: user.updated email refresh; user.deleted runs the
     same deletion core as the GDPR CLI — needs `CLERK_WEBHOOK_SIGNING_SECRET`
     to activate); `loadScript` O(n) fixed in 3b; legacy `public/renders/*.mp4`
     purged in the deploy-correctness pass.
3b. ✅ **Store → Postgres.** `lib/store.ts` is a dual backend (`RB_STORE_BACKEND=pg|file`,
   default **pg** since 2026-07-08) over Prisma `Project` + `ScriptDoc` — no call-site
   changes; `loadScript` O(n) fixed via `scriptId @unique`. Legacy `.data` imported by
   the idempotent `scripts/migrate-store-to-pg.ts` (297 briefs / 292 scripts; re-run
   against the production `DATABASE_URL` at deploy time). *Done 2026-07-08.*
4. ✅ **Metering gate.** [lib/entitlement.ts](../lib/entitlement.ts): fail-closed
   entitlement check BEFORE any spend — submitBrief gates "generate", the build
   route gates "build" (402 with a user-facing reason); counts come from Prisma
   UsageRecord per ownerId per UTC month; limits are env-tunable
   (FREE_GENERATES_PER_MONTH=3 / FREE_BUILDS_PER_MONTH=1 / SUB_*=60/30); any
   metering error DENIES; DEV_OWNER_ID exempt. Successful + failed builds write
   UsageRecord rows (failed excluded from counts). *Done 2026-07-07.*
   Also done same day: **brand-kit gate** (required logo, confirm-from-scan
   colors, optional licensed font — lib/brand-kit.ts, three-layer enforcement).
5. ✅ **Object storage (R2/S3).** Code-complete, env-gated on `STORAGE_*`:
   renders upload to R2 on completion (local disk = warm cache), uploads go to
   the bucket, `/api/renders/<id>` 302s to a short-lived signed URL when the
   local copy is gone (no full-file proxying), `/videos` checks R2 so a fresh
   container still shows every finished MP4, completed renders write a
   `Render` row. *Needs: the R2 bucket + keys.*
6. ✅ **Payments (Stripe).** Code-complete 2026-07-10, env-gated on the three
   `STRIPE_*` keys: Checkout session route, Billing Portal route, webhook
   (`checkout.session.completed`, `customer.subscription.updated/deleted`) as
   the ONLY writer of `User.plan`, `/billing` swaps its honest "not live"
   copy for real Subscribe/Manage buttons the moment the keys exist.
   *Needs: the Stripe account, one Product/Price, the three keys.*
   (`invoice.payment_failed` is covered via `past_due` status mapping;
   `charge.dispute.created` alerting is post-launch.)
7. ~~Render infra (Remotion Lambda)~~ — superseded by the container decision
   (see Locked decisions): in-container `renderMedia` + locks + R2 persistence
   for launch; Lambda is the scale-out path.
8. **Legal + email + observability + rate limiting** (can parallelize with 5–7): ToS,
   Privacy live on renderball.com (2026-07-23). Email Routing live on Cloudflare:
   `support@`, `legal@` (takedown contact), and `alfonso@` (founder contact) all
   forward to the founder's inbox; send-as wiring comes with Resend. **DMCA
   agent REGISTRATION: still deferred** (the last open sliver — ~$6 + 10 min at
   dmca.copyright.gov, list `legal@renderball.com` as the agent contact; do
   before real traffic to activate the safe harbor). Resend for receipts;
   Sentry + PostHog; Upstash rate limits on expensive routes.

## What I need from you (accesses)

Fill in [.env.example](../.env.example) → `.env.local`. Create these accounts; I wire them:

- [x] **Clerk** app — DONE INCLUDING PRODUCTION (2026-07-23): prod instance on renderball.com (5 CNAMEs verified, certs issued), custom Google OAuth credentials, user.* webhook live with signing secret in Railway; first production user signed up 2026-07-24T00:06Z through the full chain.
- [x] **Postgres** — Neon connected; Prisma schema migrated (6 tables live), client singleton in `lib/db.ts`.
- [ ] **Lemon Squeezy** — THE payment processor (2026-07-30). Stripe does not
      operate in Colombia; getting a Stripe account means incorporating in the UK
      or US first. Lemon Squeezy is a merchant of record, handles VAT worldwide,
      and supports metered usage-based subscriptions — which is exactly the
      1M-free-then-metered model in PIVOT.md. Create a store, then a Subscription
      product with **"Usage is metered" ON**, and set four vars:
      `LEMONSQUEEZY_API_KEY` / `LEMONSQUEEZY_WEBHOOK_SECRET` /
      `LEMONSQUEEZY_STORE_ID` / `LEMONSQUEEZY_VARIANT_TOKENS` (the VARIANT id,
      not the product id). Webhook → `<APP_URL>/api/webhooks/lemonsqueezy`, all
      `subscription_*` events. All code is live-on-config: checkout, portal,
      webhook and usage reporting activate with zero code changes.
- [ ] ~~**Stripe**~~ — DORMANT, not deleted. Unusable without an entity in a
      supported country; the code path stays because the fees are lower if one
      ever exists. Lemon Squeezy wins whenever both are configured
      (`lib/billing-provider.ts`).
- [ ] ~~AWS (Remotion Lambda)~~ — not needed for launch (container render decision).
- [x] **Cloudflare R2** — DONE (2026-07-23): prod bucket + token, all five `STORAGE_*` vars set in Railway.
- [ ] **Alert channel** — 2 minutes, no account: create a Slack or Discord
      incoming webhook and set `RB_ALERT_WEBHOOK`. Until this is set, a total
      generation outage is announced only to the container log. Pair it with an
      uptime monitor on `GET /api/health` (UptimeRobot's free tier is enough —
      it returns 503 when the database is unreachable or generation is down).
- [ ] **Resend** — API key + verified sending domain. Needed for receipts and
      any transactional mail; nothing sends email today.
- [ ] **Upstash Redis** — REST url + token. Rate limits are in-process only, so
      they reset on every deploy and are not shared across containers.
- [ ] **Sentry + PostHog** — DSN + project key. Less urgent now that the alert
      webhook exists, but there is still no error aggregation or product
      analytics.
- [x] **Domain** — `renderball.com`, hosted on Railway (not Vercel; the
      container render decision, 2026-07-10).
- [ ] **QA account** — one throwaway Clerk dev user in `QA_TEST_EMAIL` /
      `QA_TEST_PASSWORD` turns on the seven signed-in browser flows. Costs
      nothing to run; they skip silently without it.

Plus three product confirmations: refund policy text, free-tier risk model
(no-watermark + full anti-abuse vs. card-on-file), and the US-only geo-block vs.
real GDPR deletion call.

## Residual risks to close before taking money (from the completeness audit)

- ✅ **Alerting closed 2026-07-30.** The breaker's marker file is no longer
  log-only: `lib/alert.ts` posts to `RB_ALERT_WEBHOOK` — any Slack or Discord
  webhook, no account, no SDK, no key to rotate — on trip AND on recovery, with
  a 10-minute repeat window so a flapping condition cannot get the channel
  muted. The pull-side companion is `GET /api/health`: public (a monitor cannot
  hold a session), 503 when the database is unreachable or generation is down,
  and deliberately incapable of naming anything inside those dependencies.
  Point UptimeRobot's free tier at it and the last silent-outage path is shut.

- ✅ **Upstream balance SPOF (learned 2026-07-08) — breaker shipped 2026-07-10.**
  `lib/zai-breaker.ts`: the [1113] Insufficient-balance error trips a circuit
  that fails every spend entrypoint fast with a friendly message BEFORE any
  quota burns, self-probes every 10 min, and drops an alert marker
  (`.data/zai-balance-tripped.json` + console.error). Residual: wire the
  marker to a real alert channel (email/Slack) — currently log-only.

- **Legal is a hard gate.** Stripe won't activate a live account without a public ToS
  + Privacy Policy. The crawl re-hosts third-party logos/fonts in a hosted MP4 — needs a
  brand-ownership attestation, a registered DMCA agent, and a takedown path.
- **AI-output moderation.** Hosted MP4s could be used for deceptive ads / impersonation.
  Add a moderation pass on brief input and generated copy.
- **Captions / a11y.** Output video has no caption track (ADA exposure for customers).
- **SSRF residual:** DNS-rebinding (resolve-public-then-connect-private) is not closed —
  needs connect-time IP pinning. Tracked.
- **SVG uploads** can carry inline script; `nosniff` mitigates but the real fix is serving
  uploads from object storage with a download disposition (phase 5).
