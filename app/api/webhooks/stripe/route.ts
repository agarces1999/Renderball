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
          await syncSubscription(userId, sub);
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
        await syncSubscription(user.id, sub);
        break;
      }
      default:
        break; // acknowledge everything else
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[stripe] webhook handler failed:", err);
    // 500 → Stripe retries with backoff; correct for transient DB failures.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}

/** Upsert the Subscription row and set User.plan from the Stripe status. */
async function syncSubscription(userId: string, sub: Stripe.Subscription): Promise<void> {
  const plan = planForSubscriptionStatus(sub.status);
  const priceId = sub.items.data[0]?.price?.id ?? "";
  const periodEnd = sub.items.data[0]?.current_period_end ?? null;
  await prisma.$transaction([
    prisma.subscription.upsert({
      where: { stripeSubscriptionId: sub.id },
      update: {
        status: sub.status,
        stripePriceId: priceId,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : new Date(),
      },
      create: {
        userId,
        stripeSubscriptionId: sub.id,
        stripePriceId: priceId,
        status: sub.status,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : new Date(),
      },
    }),
    prisma.user.update({ where: { id: userId }, data: { plan } }),
  ]);
  console.log(`[stripe] user ${userId} → plan=${plan} (sub ${sub.id} ${sub.status})`);
}
