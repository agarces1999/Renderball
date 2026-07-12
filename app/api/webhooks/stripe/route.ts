import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "../../../../lib/db";
import { getStripe, isStripeConfigured, planForSubscriptionStatus } from "../../../../lib/stripe";

/**
 * Stripe webhook — the ONLY writer of User.plan. Signature-verified against
 * STRIPE_WEBHOOK_SECRET (raw body, constructEvent). Env-gated: 503 until the
 * keys exist, so registering the endpoint later "just works".
 *
 * Events handled:
 *   checkout.session.completed          → store stripeCustomerId (mapped via
 *                                         client_reference_id = OUR user id),
 *                                         upsert the Subscription row, flip plan
 *   customer.subscription.updated       → sync status/period → plan
 *   customer.subscription.deleted       → plan = free, row status = canceled
 *
 * This route must stay excluded from Clerk middleware protection (it is —
 * /api/webhooks is not in the protected matcher): Stripe calls it unauthenticated.
 */
export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "stripe not configured" }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string,
    );
  } catch (err) {
    console.warn("[stripe] webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        const customerId = typeof session.customer === "string" ? session.customer : null;
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : null;
        if (!userId) break; // not one of our checkouts — ack and ignore
        if (customerId) {
          await prisma.user.update({
            where: { id: userId },
            data: { stripeCustomerId: customerId },
          });
        }
        if (subscriptionId) {
          const sub = await getStripe().subscriptions.retrieve(subscriptionId);
          await syncSubscription(userId, sub, { isDelete: false });
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : null;
        if (!customerId) break;
        const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
        if (!user) {
          // A subscription for a customer we've never mapped — log, don't 500
          // (Stripe retries 500s forever).
          console.warn(`[stripe] subscription event for unknown customer ${customerId}`);
          break;
        }
        await syncSubscription(user.id, sub, { isDelete: event.type === "customer.subscription.deleted" });
        break;
      }
      default:
        break; // acknowledge everything else
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    // P2002 and other deterministic constraint errors are PERMANENT — Stripe
    // must not retry them for days (a poison event can get the whole endpoint
    // disabled). Ack them 200 after logging; only transient failures 500.
    if (err && typeof err === "object" && "code" in err && String((err as { code?: string }).code).startsWith("P2")) {
      console.error("[stripe] permanent DB constraint error — acking to stop retries:", err);
      return NextResponse.json({ received: true, warning: "constraint error logged" });
    }
    console.error("[stripe] webhook handler failed:", err);
    // 500 → Stripe retries with backoff; correct for transient DB failures.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}

/**
 * Sync the Subscription row + User.plan from a Stripe subscription.
 *
 * Keyed on userId (the schema's real 1:1 — `Subscription.userId @unique`), NOT
 * stripeSubscriptionId: after a cancel the old row survives (status=canceled),
 * so a resubscribe brings a NEW sub id whose create branch would collide on
 * userId → P2002 → the customer stays on `free` despite paying. Upserting by
 * userId overwrites the stale row with the new subscription instead.
 *
 * Ordering guards (Stripe does not guarantee event order):
 *  - a `.deleted` for a sub that is NOT the user's current one (a superseded,
 *    already-replaced subscription) does not downgrade an active plan;
 *  - a late `.updated` for a subscription we already recorded as canceled is
 *    ignored (a canceled subscription is terminal in Stripe — it can't reactivate;
 *    only a brand-new sub id does, which is a different row/create path).
 */
async function syncSubscription(
  userId: string,
  sub: Stripe.Subscription,
  opts: { isDelete: boolean },
): Promise<void> {
  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (opts.isDelete && existing && existing.stripeSubscriptionId !== sub.id) {
    console.log(`[stripe] ignoring delete of superseded sub ${sub.id} (current: ${existing.stripeSubscriptionId})`);
    return;
  }
  if (
    !opts.isDelete &&
    existing &&
    existing.stripeSubscriptionId === sub.id &&
    existing.status === "canceled"
  ) {
    console.log(`[stripe] ignoring stale update for already-canceled sub ${sub.id}`);
    return;
  }

  const plan = planForSubscriptionStatus(sub.status);
  const priceId = sub.items.data[0]?.price?.id ?? "";
  const periodEnd = sub.items.data[0]?.current_period_end ?? null;
  const currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : new Date();
  await prisma.$transaction([
    prisma.subscription.upsert({
      where: { userId },
      update: { stripeSubscriptionId: sub.id, status: sub.status, stripePriceId: priceId, currentPeriodEnd },
      create: { userId, stripeSubscriptionId: sub.id, status: sub.status, stripePriceId: priceId, currentPeriodEnd },
    }),
    prisma.user.update({ where: { id: userId }, data: { plan } }),
  ]);
  console.log(`[stripe] user ${userId} → plan=${plan} (sub ${sub.id} ${sub.status})`);
}
