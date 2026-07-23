import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { cn } from "../lib/cn";

/**
 * The app shell header — quiet on purpose (DESIGN.md). A small crystal-ball
 * mark + "Renderball" wordmark (Cabinet Grotesk) on the left, "Your documents"
 * and the one loud "New document" action on the right.
 *
 * Two tones:
 *   - "default" — greyscale chrome for the work surfaces (documents, review,
 *     preview). Sticky, hairline underline, faint canvas wash so it recedes
 *     behind the user's content.
 *   - "light"   — sits on the emerald front-door field; white text, no fill,
 *     a light-glass primary button.
 */
export function AppHeader({
  tone = "default",
}: {
  tone?: "default" | "light";
}) {
  const light = tone === "light";
  return (
    <header
      className={cn(
        "z-20 w-full",
        light
          ? "relative"
          : "sticky top-0 border-b border-hairline bg-canvas/80 backdrop-blur-md",
      )}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3.5">
        <Link href="/documents" className="flex items-center gap-2.5">
          <span className="orb h-6 w-6 shrink-0" aria-hidden />
          <span
            className={cn(
              "font-display text-[17px] font-semibold tracking-tight",
              light ? "text-white" : "text-ink",
            )}
          >
            Renderball
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <Link
            href="/documents"
            className={cn(
              "rounded-md px-3 py-1.5 text-[13px] transition-colors",
              light
                ? "text-white/85 hover:text-white"
                : "text-muted hover:text-ink",
            )}
          >
            Your documents
          </Link>
          <Link
            href="/new"
            className={cn(
              "rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition-all hover:brightness-110",
              light
                ? "bg-white/90 text-[#053d30] shadow-[0_8px_24px_-10px_rgba(3,40,30,0.55)]"
                : "bg-accent text-accent-ink",
            )}
          >
            New document
          </Link>
          <SignedOut>
            <SignInButton mode="modal">
              <button
                type="button"
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] transition-colors",
                  light
                    ? "text-white/85 hover:text-white"
                    : "text-muted hover:text-ink",
                )}
              >
                Sign in
              </button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <div className="ml-1.5 flex items-center">
              <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
            </div>
          </SignedIn>
        </nav>
      </div>
    </header>
  );
}
