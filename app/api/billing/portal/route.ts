import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { getStripe, isStripeConfigured, appOrigin } from "../../../../lib/stripe";

/**
 * POST /api/billing/portal — a Stripe Billing Portal session (manage payment
 * method, cancel, invoices) for the signed-in subscriber.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Billing portal isn't live yet — payments are being wired up." },
      { status: 503 },
    );
  }
  if (!user.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing profile yet — subscribe first." },
      { status: 400 },
    );
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
