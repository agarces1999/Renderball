import type { Metadata } from "next";
import Link from "next/link";

/**
 * Every dead URL lands here — including share links whose token was revoked or
 * replaced, since /s/[token] answers those with notFound(). The copy serves
 * "never existed" and "turned off" without distinguishing them: lib/share.ts
 * promises a revoked link looks exactly like one that never was, and this page
 * keeps that promise while still telling a link-holder what to do next.
 */

export const metadata: Metadata = {
  title: "Not found — Renderball",
};

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <span className="orb h-12 w-12" aria-hidden />
      <h1 className="mt-6 font-display text-[22px] font-bold tracking-tight text-ink">
        This page isn&rsquo;t available
      </h1>
      <p className="mt-2 max-w-[400px] text-[13px] leading-relaxed text-muted">
        If someone sent you this link, it may have been turned off or replaced
        with a new one — ask them for a fresh link.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-full bg-accent px-4 py-2 text-[12px] font-semibold text-accent-ink transition-all hover:brightness-110"
      >
        Make a deck with Renderball
      </Link>
    </main>
  );
}
