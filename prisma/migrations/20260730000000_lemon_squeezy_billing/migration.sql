-- Lemon Squeezy billing.
--
-- Stripe is not available to a Colombian entity without incorporating abroad,
-- so the live processor becomes Lemon Squeezy (merchant of record, supports
-- metered usage-based subscriptions). The Stripe columns stay: the code path is
-- dormant, not deleted, and removing them would make the existing webhook,
-- tests and any historical row meaningless.
--
-- The two Stripe id columns relax from NOT NULL to nullable so a Lemon Squeezy
-- subscription can exist without inventing Stripe ids for it.

ALTER TABLE "User" ADD COLUMN "lemonCustomerId" TEXT;

ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE "Subscription" ADD COLUMN "lemonSubscriptionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "lemonItemId" TEXT;
ALTER TABLE "Subscription" ALTER COLUMN "stripeSubscriptionId" DROP NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "stripePriceId" DROP NOT NULL;

CREATE UNIQUE INDEX "User_lemonCustomerId_key" ON "User"("lemonCustomerId");
CREATE UNIQUE INDEX "Subscription_lemonSubscriptionId_key" ON "Subscription"("lemonSubscriptionId");
