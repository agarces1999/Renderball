import { AppShellServer } from "../../components/AppShellServer";
import { getCurrentUser } from "../../lib/auth";
import { getUsageSummary } from "../../lib/entitlement";
import { isBillingLive } from "../../lib/billing-provider";
import { SubscribeButton, ManageBillingButton } from "./CheckoutButtons";

/** One meter row: label + used/limit + a quiet progress bar. */
function MeterRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] text-ink-soft">{label}</span>
        <span className="font-mono text-[12px] text-muted">
          {used} / {limit} this month
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={pct >= 100 ? "h-full rounded-full bg-red-400" : "h-full rounded-full bg-accent"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Billing — current plan + subscription state. Checkout is not wired yet (lands
 * with the payment-processor integration); this honestly shows that and states the
 * usage-based model (1M tokens free, then per token) that the landing and the
 * refund policy describe. Becomes the manage-billing surface once payments
 * are live. It must never quote a flat monthly price again — that was the
 * pre-pivot model and contradicted both of those pages.
 */
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  // The meter reads the SAME counts the metering gate enforces — the user sees
  // exactly the numbers that gate their next generate/build (previously the
  // cap was only discoverable by slamming into it).
  const user = await getCurrentUser();
  const usage = user ? await getUsageSummary(user.id) : null;
  return (
    <AppShellServer>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="mb-2 font-display text-[clamp(24px,3vw,30px)] font-semibold tracking-tight text-ink">
          Billing
        </h1>
        <p className="mb-8 text-[14.5px] leading-relaxed text-muted">
          Manage your plan and payment method.
        </p>

        <div className="rounded-lg border border-hairline bg-surface p-6">
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            Current plan
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-[26px] font-semibold tracking-tight text-ink">
              {usage?.plan === "subscription" ? "Subscription" : "Free"}
            </span>
          </div>
          {usage ? (
            <div className="mt-5 space-y-4">
              <MeterRow label="Outlines generated" used={usage.generate.used} limit={usage.generate.limit} />
              <MeterRow label="Documents built" used={usage.build.used} limit={usage.build.limit} />
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-muted">
              Sign in to see your usage.
            </p>
          )}
        </div>

        <div className="mt-5 rounded-lg border border-accent-line bg-surface p-6">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-ink">Usage-based</h2>
            <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text">
              Metered
            </span>
          </div>
          <div className="mb-1 flex items-baseline gap-1.5">
            <span className="font-display text-[34px] font-semibold tracking-tight text-ink">
              1M tokens
            </span>
            <span className="font-mono text-[12px] text-muted">free, then per token</span>
          </div>
          <p className="mb-4 text-[13px] text-muted">
            Editing is always free — drag, resize, retype, reorder, undo. You
            only pay when Renderball generates, priced per token. No
            subscription, no seats, no watermark.
          </p>
          {isBillingLive() ? (
            usage?.plan === "subscription" ? (
              <ManageBillingButton />
            ) : (
              <SubscribeButton />
            )
          ) : (
            <p className="mb-1 text-[13.5px] leading-relaxed text-ink-soft">
              Metered billing opens shortly through our payment processor. Until
              then everything here is free, and your usage above is still
              recorded so nothing is lost.
            </p>
          )}
        </div>
      </div>
    </AppShellServer>
  );
}
