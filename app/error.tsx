"use client";

/**
 * Root error boundary — the page that renders when something server-side
 * throws. Without it, any uncaught SSR error showed Next's bare "Application
 * error: a client-side exception has occurred" — developer vocabulary on a
 * white page, with no way anywhere. Quiet chrome per DESIGN.md.
 */
export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <span className="orb h-12 w-12" aria-hidden />
      <h1 className="mt-6 font-display text-[22px] font-semibold tracking-tight text-ink">
        Something went wrong on our side
      </h1>
      <p className="mt-2 max-w-[46ch] text-[14px] leading-relaxed text-muted">
        Your documents are safe. Try again — and if this keeps happening, email{" "}
        <a href="mailto:support@renderball.com" className="text-accent-text hover:underline">
          support@renderball.com
        </a>
        .
      </p>
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-accent px-4 py-2 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Try again
        </button>
        <a
          href="/documents"
          className="rounded-md border border-hairline-strong px-4 py-2 text-[13.5px] text-ink transition-colors hover:bg-surface-2"
        >
          Your documents
        </a>
      </div>
    </div>
  );
}
