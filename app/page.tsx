import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { LandingEditor } from "../components/LandingEditor";
import { EditorCta } from "../components/EditorCta";

/**
 * Public landing (the only fully public surface) — per DESIGN.md
 * "Landing — the canvas performs" (2026-07-24).
 *
 * The page IS the editor: slide rail, toolbar, and a canvas holding REAL
 * slides the pipeline generated (components/demo-decks.ts — snapshotted DOM,
 * not screenshots). On every slide an authoring cursor draws a marquee,
 * types the intent inside it, and an element assembles. Visitors can draw
 * their own on the first slide. NO prompt box exists on this page — the
 * category's convention is the thing being refused.
 *
 * The previous scroll-performance landing (components/LandingCanvas.tsx) is
 * kept for one cycle as the rollback; it is no longer mounted.
 *
 * Below the fold stays quiet and server-rendered: claims, usage-based
 * pricing (editing free · generation metered · first 1M tokens free — never
 * a flat $/mo figure), a deck-era FAQ, and the legal/contact links that
 * payment-processor reviews require.
 *
 * Signed-in visitors go straight to the editor entry (/new), not a gallery —
 * editor companies drop you in the tool.
 */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const { userId } = await auth();
  // The documents list, not /new: the brief-form front door was superseded by
  // blank-document + generate-from-the-editor, and sending returning users
  // there gave the product two contradictory entrances.
  if (userId) redirect("/documents");

  return (
    <div className="min-h-screen bg-canvas">
      <LandingHeader />
      <LandingEditor />
      <Pricing />
      <Faq />
      <FooterCta />
      <SiteFooter />
    </div>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-20 w-full border-b border-hairline chrome-veil backdrop-blur-md lg:motion-safe:hidden">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="orb h-6 w-6 shrink-0" aria-hidden />
          <span className="font-display text-[17px] font-semibold tracking-tight text-ink">
            Renderball
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <a
            href="#pricing"
            className="hidden rounded-md px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-ink sm:inline-block"
          >
            Pricing
          </a>
          <Link
            href="/sign-in"
            className="rounded-md px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/api/documents/new" prefetch={false}
            className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Open the editor
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <p className="mb-4 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          Pricing
        </p>
        <h2 className="mb-3 text-center font-display text-[clamp(26px,3.6vw,36px)] font-semibold tracking-tight text-ink">
          Editing is free. Generation is metered.
        </h2>
        <p className="mx-auto mb-12 max-w-[56ch] text-center text-[15px] leading-relaxed text-muted">
          Dragging, resizing, retyping, reordering — free, forever, unmetered.
          You pay only for the tokens the model spends creating, at a price you
          can read like a receipt.
        </p>
        <div className="mx-auto max-w-md">
          <div className="flex flex-col rounded-lg border border-accent-line bg-canvas p-7 shadow-[0_24px_60px_-30px_rgba(0,194,138,0.5)]">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-ink">Usage-based</h3>
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text">
                Metered
              </span>
            </div>
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="font-display text-[42px] font-semibold tracking-tight text-ink">
                1M tokens
              </span>
              <span className="font-mono text-[12px] text-muted">free</span>
            </div>
            <p className="mb-6 text-[13px] text-muted">
              About three full decks. No card required.
            </p>
            <ul className="mb-7 flex-1 space-y-2.5">
              {[
                "Every edit free: drag, resize, retype, reorder, undo",
                "Pay as you go — priced per token, billed for generation only",
                "A full deck runs about $3 of generation",
                "On-brand from your URL, editable to the last element",
                "Export to PDF and per-slide PNG",
                "No subscription, no seats, no watermark",
              ].map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-[14px] text-ink-soft">
                  <span
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    aria-hidden
                  />
                  {p}
                </li>
              ))}
            </ul>
            <Link
              href="/api/documents/new" prefetch={false}
              className="rounded-full bg-accent px-4 py-3 text-center text-[14.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
            >
              Open the editor
            </Link>
            <p className="mt-3 text-center font-mono text-[11px] text-faint">
              Metered billing · usage always visible on your account
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const qa = [
    {
      q: "Is the output actually editable?",
      a: "Yes — that's the whole point. Every slide is made of real positioned elements. Drag them, resize them, retype them inline, delete them, or draw a box and generate a new one. Nothing is a flattened image.",
    },
    {
      q: "How does it stay on my brand?",
      a: "Paste your website. Renderball extracts your logo, palette, and fonts, reads your design language, and sets every generated slide in it. You approve the outline before anything is designed — and every element stays editable after.",
    },
    {
      q: "How long does a deck take?",
      a: "About five minutes from brief to exported deck for a typical five-page deck — and single elements regenerate in seconds while you edit.",
    },
    {
      q: "What does it cost?",
      a: "Editing is free and unmetered. Generation is pay as you go, priced per token: your first 1,000,000 tokens are free (about three decks), and a typical deck runs about $3 of generation.",
    },
    {
      q: "What about video?",
      a: "The same engine renders motion. Video returns as a premium export — your deck, animated — after decks. It's shelved, not gone.",
    },
  ];
  return (
    <section className="border-t border-hairline">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <h2 className="mb-10 font-display text-[clamp(24px,3.4vw,32px)] font-semibold tracking-tight text-ink">
          Questions
        </h2>
        <div className="divide-y divide-hairline">
          {qa.map((item) => (
            <div key={item.q} className="py-5">
              <h3 className="mb-1.5 text-[15px] font-semibold text-ink">{item.q}</h3>
              <p className="text-[14.5px] leading-relaxed text-ink-soft">{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FooterCta() {
  return (
    <section className="brand-field relative overflow-hidden border-t border-hairline">
      <div className="mx-auto max-w-6xl px-6 py-28 text-center">
        <span className="orb orb-spin mx-auto mb-9 block h-[120px] w-[120px]" aria-hidden />
        <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(30px,4.6vw,48px)] font-semibold leading-[1.04] tracking-tight text-ink">
          The canvas is waiting.
        </h2>
        <p className="mx-auto mt-5 max-w-[46ch] text-[clamp(15px,2vw,17px)] leading-relaxed text-ink-soft">
          Sign-in drops you onto a canvas, not a dashboard. First million
          tokens on us.
        </p>
        <EditorCta
          centerCard
          className="mt-10 inline-block rounded-full bg-accent px-8 py-3.5 text-[15px] font-semibold text-accent-ink shadow-[0_20px_50px_-20px_rgba(0,194,138,0.7)] transition-all hover:brightness-110"
        >
          Open the editor →
        </EditorCta>
        <p className="mt-5 font-mono text-[11px] text-faint">
          no card · editing always free
        </p>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <span className="orb h-5 w-5 shrink-0" aria-hidden />
          <span className="font-display text-[14px] font-semibold tracking-tight text-ink">
            Renderball
          </span>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[12px] text-muted">
          <a href="#pricing" className="transition-colors hover:text-ink">
            Pricing
          </a>
          <Link href="/terms" className="transition-colors hover:text-ink">
            Terms
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-ink">
            Privacy
          </Link>
          <Link href="/refunds" className="transition-colors hover:text-ink">
            Refunds
          </Link>
          <Link href="/acceptable-use" className="transition-colors hover:text-ink">
            Acceptable use
          </Link>
          <Link href="/contact" className="transition-colors hover:text-ink">
            Contact
          </Link>
          <a href="mailto:support@renderball.com" className="transition-colors hover:text-ink">
            support@renderball.com
          </a>
        </nav>
        <p className="font-mono text-[11px] text-faint">© 2026 Renderball</p>
      </div>
    </footer>
  );
}
