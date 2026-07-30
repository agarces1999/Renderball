import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { billingProvider, BILLING_NOT_LIVE } from "../../../../lib/billing-provider";
import { createLemonCheckout } from "../../../../lib/lemonsqueezy";
import {
  getStripe,
  isStripeConfigured,
  isTokenBillingConfigured,
  appOrigin,
} from "../../../../lib/stripe";

/**
 * POST /api/billing/checkout — start a hosted checkout, return its URL.
 *
 * Routes to whichever processor is configured (lib/billing-provider.ts). Lemon
 * Squeezy is the live one: Stripe does not operate in Colombia. Env-gated at
 * both ends, so this answers 503 with an honest message until keys exist.
 *
 * Body (optional, Stripe only): { plan: "tokens" | "subscription" }. Lemon
 * Squeezy has a single metered variant — the pivot's token pricing — so there
 * is nothing to choose there.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const provider = billingProvider();
  if (provider === "none") {
    return NextResponse.json({ error: BILLING_NOT_LIVE }, { status: 503 });
  }

  // Already-subscribed guard: without it a second checkout (double-click, stale
  // tab, back-button) creates a SECOND live subscription on the same customer —
  // the user is charged twice. Send active subscribers to the portal instead.
  if (user.plan === "subscription") {
    return NextResponse.json(
      {
        error: "You're already subscribed — manage your plan from the billing portal.",
        alreadySubscribed: true,
      },
      { status: 409 },
    );
  }

  if (provider === "lemonsqueezy") {
    try {
      const checkout = await createLemonCheckout({ id: user.id, email: user.email });
      return NextResponse.json({ url: checkout.url });
    } catch (err) {
      console.error("[lemonsqueezy] checkout failed:", err);
      return NextResponse.json(
        { error: "Could not start checkout — please try again." },
        { status: 500 },
      );
    }
  }

  let plan: "tokens" | "subscription" = "subscription";
  try {
    const body = await request.json();
    if (body && typeof body === "object" && (body as { plan?: string }).plan === "tokens") {
      plan = "tokens";
    }
  } catch {
    /* empty body → default plan; the route predates the body */
  }

  const configured = plan === "tokens" ? isTokenBillingConfigured() : isStripeConfigured();
  if (!configured) {
    return NextResponse.json({ error: BILLING_NOT_LIVE }, { status: 503 });
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items:
        plan === "tokens"
          ? [{ price: process.env.STRIPE_PRICE_TOKENS as string }]
          : [{ price: process.env.STRIPE_PRICE_SUBSCRIPTION as string, quantity: 1 }],
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
