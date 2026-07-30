/**
 * Which payment processor is live.
 *
 * The app supports two and runs one. Lemon Squeezy wins when configured,
 * because it is the one available to this company — Stripe does not operate in
 * Colombia and the Stripe path exists for a future in which an entity abroad
 * does. Keeping both compiled and only one configured means switching is an
 * environment change, not a migration.
 *
 * Everything else in the codebase asks THIS module rather than testing env vars
 * itself, so there is exactly one place where "who takes the money" is decided.
 */
import { isLemonConfigured } from "./lemonsqueezy";
import { isStripeConfigured, isTokenBillingConfigured } from "./stripe";

export type BillingProvider = "lemonsqueezy" | "stripe" | "none";

export const billingProvider = (): BillingProvider => {
  if (isLemonConfigured()) return "lemonsqueezy";
  if (isStripeConfigured() || isTokenBillingConfigured()) return "stripe";
  return "none";
};

/** Can a user start paying us right now? */
export const isBillingLive = (): boolean => billingProvider() !== "none";

/**
 * The copy shown when nobody can pay yet.
 *
 * Honest on purpose: a checkout button that fails silently is worse than one
 * that says why, and this string has been the difference between "the product
 * is broken" and "the product is not finished".
 */
export const BILLING_NOT_LIVE = "Checkout isn't live yet — payments are being wired up.";
