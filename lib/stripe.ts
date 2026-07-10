/**
 * Stripe wiring (LAUNCH.md #6 — subscription-first, decided 2026-06-17).
 *
 * Everything is ENV-GATED so this code ships before the Stripe account
 * exists: when the four STRIPE_* keys land in the environment, checkout,
 * the billing portal, and the webhook activate with zero code changes.
 * Until then isStripeConfigured() is false and /billing keeps its honest
 * "checkout is not live yet" copy.
 *
 * The money flow:
 *   /billing → POST /api/billing/checkout → Stripe Checkout (hosted) →
 *   webhook checkout.session.completed → User.plan = subscription +
 *   Subscription row → the metering gate's plan lookup flips instantly.
 *   customer.subscription.updated/deleted keep plan + row in sync;
 *   POST /api/billing/portal manages/cancels.
 */
import Stripe from "stripe";

export const isStripeConfigured = (): boolean =>
  Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_WEBHOOK_SECRET &&
      process.env.STRIPE_PRICE_SUBSCRIPTION,
  );

let _stripe: Stripe | null = null;
export const getStripe = (): Stripe => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing).");
  if (!_stripe) _stripe = new Stripe(key);
  return _stripe;
};

/**
 * Map a Stripe subscription status to our plan. PURE — unit-tested.
 * active/trialing pay (or are in a granted trial) → subscription.
 * past_due keeps access while Stripe retries the card (its dunning window);
 * everything terminal (canceled, unpaid, incomplete_expired, paused) → free.
 */
export const planForSubscriptionStatus = (
  status: string | null | undefined,
): "free" | "subscription" => {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
      return "subscription";
    default:
      return "free";
  }
};

/** The app origin for checkout redirect URLs. */
export const appOrigin = (): string =>
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
