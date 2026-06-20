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

## Locked decisions (2026-06-17)

- **Auth:** Clerk (Google + email + more). Supersedes the spec's email-magic-link.
- **Payments:** Stripe **subscription ($29.99/mo) + free tier** first; PAYG/credits as a fast-follow.
- **Render:** Remotion **Lambda** (AWS).

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
   - Residuals: Clerk→DB **user-sync webhook** (email updates/deletes) still TODO;
     `loadScript` is O(n) over briefs until 3b; legacy `public/renders/*.mp4` (dev test
     data) should be purged before go-live.
3b. **Store → Postgres.** Swap `lib/store.ts` internals to the Prisma `Project` table
   (no call-site changes). Migrate or archive the legacy `.data` briefs.
4. **Metering gate.** A fail-closed entitlement check *before* any Opus/render spend:
   resolve user → plan → remaining entitlement; reject anonymous/over-quota. Persist
   usage per `ownerId` (extend [lib/usage.ts](../lib/usage.ts)).
5. **Object storage (R2/S3).** Move renders + uploads + generated code off local disk;
   serve MP4s from the CDN base.
6. **Payments (Stripe).** Checkout for the subscription, Billing Portal, and the webhook
   handler (`checkout.session.completed`, `subscription.updated/deleted`,
   `invoice.payment_failed`, `charge.dispute.created`) → flips `User.plan`.
7. **Render infra (Remotion Lambda).** Deploy the Lambda + serve-url; swap the in-request
   `renderMedia` for a Lambda dispatch + progress polling.
8. **Legal + email + observability + rate limiting** (can parallelize with 5–7): ToS,
   Privacy, DMCA agent + `abuse@`; Resend for receipts; Sentry + PostHog; Upstash rate
   limits on expensive routes.

## What I need from you (accesses)

Fill in [.env.example](../.env.example) → `.env.local`. Create these accounts; I wire them:

- [x] **Clerk** app — Google + Email enabled; publishable + secret keys wired (`@clerk/nextjs@6`, middleware + ClerkProvider + header controls). Webhook signing secret still TODO (for the Clerk→DB user-sync, built in the scoping step).
- [x] **Postgres** — Neon connected; Prisma schema migrated (6 tables live), client singleton in `lib/db.ts`.
- [ ] **Stripe** (test mode) — secret + publishable + webhook secret; one $29.99/mo Product → price id.
- [ ] **AWS** — IAM user for Remotion Lambda (lambda + s3 + cloudwatch); region.
- [ ] **Cloudflare R2** (or S3) — bucket + API token + public/CDN base URL.
- [ ] **Resend** — API key + verified sending domain.
- [ ] **Upstash Redis** — REST url + token.
- [ ] **Sentry + PostHog** — DSN + project key.
- [ ] **Domain** — confirm `renderball.com` + where the app hosts (Vercel assumed).

Plus three product confirmations: refund policy text, free-tier risk model
(no-watermark + full anti-abuse vs. card-on-file), and the US-only geo-block vs.
real GDPR deletion call.

## Residual risks to close before taking money (from the completeness audit)

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
