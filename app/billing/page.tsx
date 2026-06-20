import Link from "next/link";
import { AppShellServer } from "../../components/AppShellServer";

/**
 * Billing — current plan + what's available. Paid plans are not wired yet
 * (checkout lands with the payment-processor integration), so this honestly
 * shows the free plan and links to pricing. It becomes the manage-subscription
 * surface once payments are live.
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
              Free
            </span>
            <span className="text-[13px] text-muted">
              1 free minute · no card
            </span>
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-hairline bg-surface-2 p-6">
          <h2 className="mb-1.5 text-[15px] font-semibold text-ink">
            Paid plans are coming soon
          </h2>
          <p className="mb-4 text-[14px] leading-relaxed text-ink-soft">
            Pay-as-you-go at $9.99 per minute and the $29.99/mo subscription will
            be available here shortly. You can keep creating on the free tier in
            the meantime.
          </p>
          <Link
            href="/#pricing"
            className="inline-block rounded-md border border-hairline-strong bg-surface px-4 py-2 text-[13.5px] font-medium text-ink transition-colors hover:border-ink/30"
          >
            See pricing
          </Link>
        </div>
      </div>
    </AppShellServer>
  );
}
