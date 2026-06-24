import Link from "next/link";
import { AppShellServer } from "../../components/AppShellServer";

/**
 * Billing — current plan + subscription state. Checkout is not wired yet (lands
 * with the payment-processor integration); this honestly shows that and points
 * to the $49.99/mo subscription. Becomes the manage-subscription surface once
 * payments are live.
 */
export const dynamic = "force-dynamic";

export default function BillingPage() {
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
              No subscription
            </span>
          </div>
          <p className="mt-2 text-[13px] text-muted">
            Subscribe to start creating videos.
          </p>
        </div>

        <div className="mt-5 rounded-lg border border-accent-line bg-surface p-6">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-ink">Renderball</h2>
            <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text">
              Subscription
            </span>
          </div>
          <div className="mb-1 flex items-baseline gap-1.5">
            <span className="font-display text-[34px] font-semibold tracking-tight text-ink">
              $49.99
            </span>
            <span className="font-mono text-[12px] text-muted">per month</span>
          </div>
          <p className="mb-4 text-[13px] text-muted">
            Unlimited videos. 1080p. No watermark. Cancel anytime.
          </p>
          <p className="mb-4 text-[13.5px] leading-relaxed text-ink-soft">
            Checkout opens shortly through our payment processor. You will be
            able to manage your subscription from this page once it&rsquo;s
            live.
          </p>
          <Link
            href="/#pricing"
            className="inline-block rounded-md bg-accent px-4 py-2 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            See plan details
          </Link>
        </div>
      </div>
    </AppShellServer>
  );
}
