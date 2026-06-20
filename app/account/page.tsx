import { UserProfile } from "@clerk/nextjs";
import { AppShellServer } from "../../components/AppShellServer";

/**
 * Account management — Clerk's UserProfile (email, password, connected
 * accounts, active sessions, security) rendered inside our app shell and themed
 * by the ClerkProvider appearance. Hash routing keeps it on a single page.
 */
export const dynamic = "force-dynamic";

export default function AccountPage() {
  return (
    <AppShellServer>
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-7 font-display text-[clamp(24px,3vw,30px)] font-semibold tracking-tight text-ink">
          Account
        </h1>
        <UserProfile routing="hash" />
      </div>
    </AppShellServer>
  );
}
