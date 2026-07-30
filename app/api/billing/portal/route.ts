import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/db";
import { getCurrentUser } from "../../../../lib/auth";
import { billingProvider } from "../../../../lib/billing-provider";
import { lemonPortalUrl } from "../../../../lib/lemonsqueezy";
import { getStripe, appOrigin } from "../../../../lib/stripe";

/**
 * POST /api/billing/portal — where a subscriber manages payment method,
 * invoices and cancellation.
 *
 * Stripe mints a portal session; Lemon Squeezy puts a signed, expiring portal
 * URL on the subscription itself, so that one is read fresh rather than stored.
 * Either way the caller gets `{ url }` and does not care which.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const provider = billingProvider();
  if (provider === "none") {
    return NextResponse.json(
      { error: "Billing portal isn't live yet — payments are being wired up." },
      { status: 503 },
    );
  }

  if (provider === "lemonsqueezy") {
    const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
    if (!sub?.lemonSubscriptionId) {
      return NextResponse.json({ error: "No billing profile yet — subscribe first." }, { status: 400 });
    }
    try {
      return NextResponse.json({ url: await lemonPortalUrl(sub.lemonSubscriptionId) });
    } catch (err) {
      console.error("[lemonsqueezy] portal lookup failed:", err);
      return NextResponse.json(
        { error: "Could not open the billing portal — please try again." },
        { status: 500 },
      );
    }
  }

  if (!user.stripeCustomerId) {
    return NextResponse.json({ error: "No billing profile yet — subscribe first." }, { status: 400 });
  }
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${appOrigin()}/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe] portal session failed:", err);
    return NextResponse.json(
      { error: "Could not open the billing portal — please try again." },
      { status: 500 },
    );
  }
}
