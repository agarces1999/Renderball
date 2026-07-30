/**
 * Which payment processor is live.
 *
 * The app supports two and runs one. Lemon Squeezy wins when configured: it is
 * the founder's call (2026-06-19, reaffirmed 2026-07-30), it is a merchant of
 * record so VAT worldwide is their problem, and it does not care which country
 * the seller is in — Stripe does not support Colombia directly. The Stripe path
 * stays for the case where billing runs through a US or UK entity, where its
 * fees are lower. Keeping both compiled and only one configured means switching
 * is an environment change, not a migration.
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
