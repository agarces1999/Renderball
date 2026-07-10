import Link from "next/link";
import { AppShellServer } from "../../components/AppShellServer";
import { getCurrentUser } from "../../lib/auth";
import { getUsageSummary } from "../../lib/entitlement";

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
 * with the payment-processor integration); this honestly shows that and points
 * to the $49.99/mo subscription. Becomes the manage-subscription surface once
 * payments are live.
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
              <MeterRow label="Stories generated" used={usage.generate.used} limit={usage.generate.limit} />
              <MeterRow label="Videos built" used={usage.build.used} limit={usage.build.limit} />
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-muted">
              Sign in to see your usage.
            </p>
          )}
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
