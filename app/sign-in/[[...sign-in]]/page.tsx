import Link from "next/link";
import { SignIn } from "@clerk/nextjs";

/**
 * In-app sign-in (Clerk renders inside our chrome, themed via the
 * ClerkProvider appearance in app/layout.tsx). The catch-all segment lets
 * Clerk handle its sub-routes (SSO callback, verification, etc.).
 */
export default function SignInPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 py-12">
      <Link href="/" className="mb-8 flex items-center gap-2.5">
        <span className="orb h-7 w-7 shrink-0" aria-hidden />
        <span className="font-display text-[19px] font-semibold tracking-tight text-ink">
          Renderball
        </span>
      </Link>
      <SignIn />
      {/* The door recruits (UX pass, 2026-08-31): a first-timer who lands
          here by link or guess gets the pitch, not a dead end. Clerk's own
          card already carries the Sign up link; this line is the WHY. */}
      <p className="mt-6 max-w-[36ch] text-center font-mono text-[11px] leading-relaxed text-muted">
        New here? The canvas is free — first million tokens on us, no card.
      </p>
    </div>
  );
}
