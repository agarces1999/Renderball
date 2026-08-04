import { DeleteAccountSection } from "./DeleteAccountSection";
import { UserProfile } from "@clerk/nextjs";
import { AppShellServer } from "../../components/AppShellServer";
import { getCurrentUser } from "../../lib/auth";
import { getTokenUsageSummary, meteringMode, formatTokens } from "../../lib/metering";

/**
 * Account management — Clerk's UserProfile (email, password, connected
 * accounts, active sessions, security) rendered inside our app shell and themed
 * by the ClerkProvider appearance. Hash routing keeps it on a single page.
 * Above it: the token meter (docs/METERING.md), shown only once RB_METERING is
 * live so the pre-launch page is unchanged.
 */
export const dynamic = "force-dynamic";

/** The same numbers the allowance gate enforces, as a quiet meter. */
function TokenMeter({
  usedTokens,
  freeTokens,
  billingActive,
}: {
  usedTokens: number;
  freeTokens: number;
  billingActive: boolean;
}) {
  const pct = freeTokens > 0 ? Math.min(100, Math.round((usedTokens / freeTokens) * 100)) : 100;
  const exhausted = usedTokens >= freeTokens;
  return (
    <div className="mb-7 rounded-lg border border-hairline bg-surface p-6">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          Generation tokens
        </span>
        <span className="font-mono text-[12px] text-muted">
          {usedTokens.toLocaleString("en-US")} / {formatTokens(freeTokens)} free
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={
            exhausted && !billingActive
              ? "h-full rounded-full bg-red-400"
              : "h-full rounded-full bg-accent"
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[13px] text-muted">
        {billingActive
          ? "Usage billing is active — tokens beyond your free allowance are billed per token. Editing is always free."
          : exhausted
            ? "You've used your free tokens. Add billing to keep generating — editing is always free."
            : "Editing is always free — only generating spends tokens."}
      </p>
    </div>
  );
}

export default async function AccountPage() {
  const user = meteringMode() === "off" ? null : await getCurrentUser();
  const usage = user ? await getTokenUsageSummary(user.id) : null;
  return (
    <AppShellServer>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-7 font-display text-[clamp(24px,3vw,30px)] font-semibold tracking-tight text-ink">
          Account
        </h1>
        {usage ? (
          <TokenMeter
            usedTokens={usage.usedTokens}
            freeTokens={usage.freeTokens}
            billingActive={usage.billingActive}
          />
        ) : null}
        <UserProfile routing="hash" />
        <DeleteAccountSection />
      </div>
    </AppShellServer>
  );
}
