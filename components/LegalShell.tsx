import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome for the public policy pages (terms / privacy / refunds).
 * Quiet greyscale, generous reading measure, the same header/footer as the
 * landing page so the legal surfaces feel part of the product.
 */
export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3.5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="orb h-6 w-6 shrink-0" aria-hidden />
            <span className="font-display text-[17px] font-semibold tracking-tight text-ink">
              Renderball
            </span>
          </Link>
          <Link
            href="/"
            className="rounded-md px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-ink"
          >
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="font-display text-[clamp(28px,4vw,38px)] font-semibold tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-2 font-mono text-[12px] text-muted">
          Last updated {updated}
        </p>
        <div className="legal-prose mt-10">{children}</div>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-5 gap-y-2 px-6 py-8 font-mono text-[12px] text-muted">
          <Link href="/terms" className="transition-colors hover:text-ink">
            Terms
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-ink">
            Privacy
          </Link>
          <Link href="/refunds" className="transition-colors hover:text-ink">
            Refunds
          </Link>
          <a
            href="mailto:support@renderball.com"
            className="transition-colors hover:text-ink"
          >
            support@renderball.com
          </a>
        </div>
      </footer>
    </div>
  );
}

/** A titled section of policy text. */
export function Clause({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-2.5 text-[17px] font-semibold text-ink">{heading}</h2>
      <div className="space-y-3 text-[14.5px] leading-relaxed text-ink-soft">
        {children}
      </div>
    </section>
  );
}
