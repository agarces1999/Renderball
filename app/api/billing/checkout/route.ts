import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { getStripe, isStripeConfigured, appOrigin } from "../../../../lib/stripe";

/**
 * POST /api/billing/checkout — create a Stripe Checkout Session for the
 * subscription and return its hosted URL. Env-gated: 503 with an honest
 * message until the STRIPE_* keys exist.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Checkout isn't live yet — payments are being wired up." },
      { status: 503 },
    );
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_SUBSCRIPTION as string, quantity: 1 }],
      // client_reference_id is how the webhook maps the session back to OUR
      // user — never trust email for identity.
      client_reference_id: user.id,
      // Reuse the Stripe customer when we have one (repeat checkout after a
      // cancel); otherwise let Checkout create it and the webhook stores it.
      ...(user.stripeCustomerId
        ? { customer: user.stripeCustomerId }
        : { customer_email: user.email }),
      allow_promotion_codes: true,
      success_url: `${appOrigin()}/billing?checkout=success`,
      cancel_url: `${appOrigin()}/billing?checkout=canceled`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe] checkout session failed:", err);
    return NextResponse.json(
      { error: "Could not start checkout — please try again." },
      { status: 500 },
    );
  }
}

