import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/db";
import {
  isLemonConfigured,
  planForLemonStatus,
  readLemonSubscription,
  verifyLemonSignature,
  type LemonWebhook,
} from "../../../../lib/lemonsqueezy";

/**
 * Lemon Squeezy webhook — the only writer of User.plan on the Lemon path.
 *
 * Anyone on the internet can POST here; that is what a webhook is. The
 * signature is the entire defence, so it is checked against the RAW body before
 * anything is parsed, and a failure is a 401 with no detail — a verbose error
 * tells an attacker how close they got.
 *
 * Events handled (subscription_* all carry the same payload shape):
 *   subscription_created   → map customer + item ids, upsert the row, flip plan
 *   subscription_updated   → sync status/period → plan
 *   subscription_cancelled → still paid until the period ends; status decides
 *   subscription_expired   → plan = free
 *   subscription_paused / _unpaused / _resumed → status decides
 *
 * The subscription ITEM id is the thing worth guarding here: metered billing
 * reports usage against it, so a row without one is a subscriber we can never
 * charge.
 *
 * Outside the Clerk matcher by construction — /api/webhooks is not protected.
 */
export async function POST(request: Request) {
  if (!isLemonConfigured()) {
    return NextResponse.json({ error: "lemonsqueezy not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-signature");
  if (!verifyLemonSignature(rawBody, signature, process.env.LEMONSQUEEZY_WEBHOOK_SECRET)) {
    console.warn("[lemonsqueezy] webhook signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: LemonWebhook;
  try {
    payload = JSON.parse(rawBody) as LemonWebhook;
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const e = readLemonSubscription(payload);
  if (!e.event.startsWith("subscription_")) {
    return NextResponse.json({ received: true }); // order_created etc — ack and ignore
  }
  // order_refunded and license events share the prefix space; only the ones
  // carrying a subscription id describe a subscription.
  if (!e.subscriptionId) return NextResponse.json({ received: true });

  try {
    // Identify the user. custom_data.user_id is authoritative on the first
    // event; later events for the same subscription are matched by the ids we
    // already stored, because Lemon Squeezy does not resend custom_data on
    // every event type.
    let userId = e.userId;
    if (!userId) {
      const existing = await prisma.subscription.findFirst({
        where: { lemonSubscriptionId: e.subscriptionId },
        select: { userId: true },
      });
      userId = existing?.userId ?? null;
    }
    if (!userId && e.customerId) {
      const byCustomer = await prisma.user.findUnique({
        where: { lemonCustomerId: e.customerId },
        select: { id: true },
      });
      userId = byCustomer?.id ?? null;
    }
    if (!userId) {
      // A subscription we cannot attribute. Log and ACK: returning 500 makes
      // Lemon Squeezy retry for days and can get the endpoint disabled.
      console.warn(
        `[lemonsqueezy] ${e.event} for subscription ${e.subscriptionId} — no user match`,
      );
      return NextResponse.json({ received: true, warning: "unattributed" });
    }

    const plan = planForLemonStatus(e.status);

    if (e.customerId) {
      await prisma.user.update({
        where: { id: userId },
        data: { lemonCustomerId: e.customerId, plan },
      });
    } else {
      await prisma.user.update({ where: { id: userId }, data: { plan } });
    }

    await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        provider: "lemonsqueezy",
        lemonSubscriptionId: e.subscriptionId,
        lemonItemId: e.itemId,
        stripePriceId: null,
        status: e.status,
        currentPeriodEnd: e.periodEnd,
      },
      update: {
        provider: "lemonsqueezy",
        lemonSubscriptionId: e.subscriptionId,
        // Never overwrite a known item id with null: a later event that omits
        // it would silently disable metered billing for that subscriber.
        ...(e.itemId ? { lemonItemId: e.itemId } : {}),
        status: e.status,
        currentPeriodEnd: e.periodEnd,
      },
    });

    console.log(
      `[lemonsqueezy] user ${userId} → plan=${plan} (${e.event}, status=${e.status}` +
        `${e.itemId ? `, item ${e.itemId}` : ", NO ITEM ID — usage cannot be billed"})`,
    );
    return NextResponse.json({ received: true });
  } catch (err) {
    // Deterministic constraint errors are PERMANENT — retrying them for days
    // achieves nothing and risks the endpoint being disabled. Ack after logging.
    if (err && typeof err === "object" && "code" in err && String((err as { code?: string }).code).startsWith("P2")) {
      console.error("[lemonsqueezy] permanent DB constraint error — acking to stop retries:", err);
      return NextResponse.json({ received: true, warning: "constraint error logged" });
    }
    console.error("[lemonsqueezy] webhook handler failed:", err);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
