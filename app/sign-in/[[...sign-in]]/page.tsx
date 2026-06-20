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
    </div>
  );
}
