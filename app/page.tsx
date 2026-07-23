import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { HeroPrompt } from "../components/HeroPrompt";
import { HowItWorksDemo } from "../components/HowItWorksDemo";

/**
 * Public marketing landing page (the only fully public surface).
 *
 * Signed-in visitors are sent straight to their gallery; signed-out visitors
 * see the product pitch + pricing. This is also what payment/processor reviews
 * (Stripe) look at — a real description of what's sold, not a login wall.
 * Voice + tokens per DESIGN.md: cool greyscale chrome, the emerald signal used
 * sparingly, Cabinet Grotesk for display, no exclamation marks.
 *
 * Decks-first since the canvas pivot (docs/PIVOT.md): the hero sells
 * URL + brief → on-brand editable deck, marquee-to-generate is the
 * differentiator, and video is positioned as returning, not headline.
 */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect("/documents");

  return (
    <div className="min-h-screen bg-canvas">
      <LandingHeader />
      <Hero />
      <HowItWorks />
      <Marquee />
      <VideoStrip />
      <Pricing />
      <Faq />
      <FooterCta />
      <SiteFooter />
    </div>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-20 w-full border-b border-hairline bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="orb h-6 w-6 shrink-0" aria-hidden />
          <span className="font-display text-[17px] font-semibold tracking-tight text-ink">
            Renderball
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <a
            href="#how"
            className="hidden rounded-md px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-ink sm:inline-block"
          >
            How it works
          </a>
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
            href="/new"
            className="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Make a deck
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    // Emerald brand-field scoped to the hero (DESIGN.md decisions log 2026-06-06
    // already approves this treatment on /new — extending the same exception
    // here so the front door reads as a brand moment, not a doc page).
    <section className="brand-field relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 pb-24 pt-16 text-center sm:pt-24">
        <span
          className="orb orb-spin mx-auto mb-9 block h-[120px] w-[120px]"
          aria-hidden
        />
        <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          AI-native design documents
        </p>
        <h1 className="mx-auto max-w-[18ch] font-display text-[clamp(34px,6vw,60px)] font-semibold leading-[1.04] tracking-tight text-ink">
          On-brand decks, designed by AI. Editable to the pixel.
        </h1>
        <p className="mx-auto mt-6 max-w-[56ch] text-[clamp(15px,2vw,18px)] leading-relaxed text-ink-soft">
          Paste your site, describe the deck. Renderball drafts the outline,
          designs every page in your brand, and hands you a real editor — not a
          template.
        </p>
        <HeroPrompt />
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-[11px] text-faint">
          <span>Start free — 1M tokens included · editing is always free</span>
          <a href="#how" className="underline transition-colors hover:text-muted">
            See how it works
          </a>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Tell us what the deck is for",
      body: "Plain English — a seed pitch, a sales deck, a company all-hands. Add your site and Renderball pulls your logo, palette, and fonts, so page one already looks like you.",
    },
    {
      n: "02",
      title: "Approve the outline",
      body: "We draft the page-by-page narrative first: headlines, structure, what goes on each page. Edit any line, reorder, regenerate. Nothing expensive builds until you say yes.",
    },
    {
      n: "03",
      title: "Edit the real thing",
      body: "Every headline, stat, and chart is a live element — drag it, resize it, rewrite it in place. Draw a box and describe what belongs there. Then export PDF or PNG.",
    },
  ];
  return (
    <section id="how" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-2 font-display text-[clamp(24px,3.4vw,32px)] font-semibold tracking-tight text-ink">
          Outline first, no surprises
        </h2>
        <p className="mb-10 max-w-[52ch] text-[15px] leading-relaxed text-muted">
          You approve the story before any expensive compute runs, so you never
          pay for the wrong deck.
        </p>
        <div className="mb-14">
          <HowItWorksDemo />
        </div>
        <div className="grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n}>
              <div className="mb-4 font-mono text-[12px] tracking-[0.14em] text-accent-text">
                {s.n}
              </div>
              <h3 className="mb-2 text-[17px] font-semibold text-ink">
                {s.title}
              </h3>
              <p className="text-[14.5px] leading-relaxed text-ink-soft">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Marquee() {
  return (
    <section className="border-t border-hairline">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-20 md:grid-cols-2">
        <div>
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
            Marquee-to-generate
          </p>
          <h2 className="max-w-[16ch] font-display text-[clamp(26px,3.6vw,38px)] font-semibold leading-[1.08] tracking-tight text-ink">
            Draw a box. Say what goes there.
          </h2>
          <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-ink-soft">
            A Renderball page isn&apos;t one baked image — it&apos;s discrete,
            positioned elements. Select an empty area, type &ldquo;a bar chart
            of our MRR&rdquo;, and the element appears in exactly that box, in
            your brand.
          </p>
          <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-ink-soft">
            Moving, resizing, rewriting, and deleting are deterministic — they
            cost nothing and never wait on a model. Generation is the only
            thing you ever spend on.
          </p>
        </div>
        {/* Static vignette of the marquee moment — the animated version plays
            in the demo above; this one is a quiet still so the section reads
            at a glance. */}
        <div
          className="relative overflow-hidden rounded-xl border border-hairline-strong bg-[#10141C] p-6 shadow-[0_40px_100px_-50px_rgba(18,26,43,0.6)]"
          style={{ aspectRatio: "16 / 9" }}
          aria-hidden
        >
          <div className="font-display text-[clamp(16px,2.2vw,22px)] font-bold tracking-tight text-white">
            Traction
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#7fe9c4]">
            $1.2M ARR · 9 months
          </div>
          <div className="absolute bottom-5 right-6 top-[4.5rem] w-[46%] rounded-sm border-2 border-dashed border-[#00E0A0]">
            <div className="absolute inset-2 flex items-end justify-around gap-1.5">
              {[28, 42, 55, 74, 100].map((h, i) => (
                <span
                  key={i}
                  className="w-full rounded-t-sm bg-[#00E0A0]/80"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
          <div className="absolute bottom-6 left-6 rounded-md border border-white/15 bg-black/60 px-3 py-1.5 font-mono text-[11px] text-white/90 backdrop-blur-sm">
            bar chart of MRR growth
          </div>
        </div>
      </div>
    </section>
  );
}

function VideoStrip() {
  return (
    <section className="border-t border-hairline bg-surface-2">
      <div className="mx-auto flex max-w-6xl flex-col items-baseline gap-2 px-6 py-10 sm:flex-row sm:gap-6">
        <p className="shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          And then, motion
        </p>
        <p className="max-w-[72ch] text-[14px] leading-relaxed text-ink-soft">
          Renderball&apos;s engine was born rendering animated video, and it&apos;s
          coming back: the same pages that export as a deck will play as an
          animated story. Decks first — motion returns soon.
        </p>
      </div>
    </section>
  );
}

function Pricing() {
  const points = [
    "1M tokens free — roughly two to four full deck builds",
    "Editing is free: moves, resizes, rewrites, and deletes cost 0 tokens",
    "Pay per token after that — no seats, no flat subscription",
    "Brand kit from your site: logo, palette, fonts",
    "PDF and PNG export, no watermark, your license",
    "Outline approval before every build — no wasted spend",
  ];
  return (
    <section id="pricing" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <p className="mb-4 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          Pricing
        </p>
        <h2 className="mb-3 text-center font-display text-[clamp(26px,3.6vw,36px)] font-semibold tracking-tight text-ink">
          Editing is free. Generating is metered.
        </h2>
        <p className="mx-auto mb-12 max-w-[56ch] text-center text-[15px] leading-relaxed text-muted">
          You spend tokens only when AI designs something for you. Everything
          you do with your own hands in the editor costs nothing, forever.
        </p>
        <div className="mx-auto max-w-md">
          <div className="flex flex-col rounded-lg border border-accent-line bg-canvas p-7 shadow-[0_24px_60px_-30px_rgba(0,194,138,0.5)]">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-ink">Renderball</h3>
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text">
                Usage-based
              </span>
            </div>
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="font-display text-[42px] font-semibold tracking-tight text-ink">
                1M tokens
              </span>
              <span className="font-mono text-[12px] text-muted">free</span>
            </div>
            <p className="mb-6 text-[13px] text-muted">
              Then pay only for what you generate.
            </p>
            <ul className="mb-7 flex-1 space-y-2.5">
              {points.map((p) => (
                <li
                  key={p}
                  className="flex items-start gap-2.5 text-[14px] text-ink-soft"
                >
                  <span
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    aria-hidden
                  />
                  {p}
                </li>
              ))}
            </ul>
            <Link
              href="/new"
              className="rounded-md bg-accent px-4 py-3 text-center text-[14.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
            >
              Start free →
            </Link>
            <p className="mt-3 text-center font-mono text-[11px] text-faint">
              Usage-based billing via our payment processor
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
      q: "Do I need design skills?",
      a: "No. You describe what the deck is for in plain English, approve the outline, and Renderball designs every page in your brand. Anything you want different, you change directly in the editor.",
    },
    {
      q: "Will it actually match my brand?",
      a: "Paste your website and Renderball extracts your logo, palette, and fonts — and you confirm all of it before anything builds. Or upload your own assets directly.",
    },
    {
      q: "Can I edit the result?",
      a: "That's the point. Every element on every page is separately selectable: drag it, resize it, rewrite the text inline, delete it, or draw a box and describe a new element to generate in place. Edits are deterministic and free.",
    },
    {
      q: "How long does a deck take?",
      a: "The outline appears in seconds. A full deck designs itself in minutes, page by page — and you can start editing as soon as it lands.",
    },
    {
      q: "What does it cost?",
      a: "Your first 1M tokens are free — roughly two to four full deck builds. After that you pay per token for generation only. Editing never costs tokens.",
    },
    {
      q: "What about video?",
      a: "Video is where Renderball started, and the engine still speaks it fluently. Animated decks and launch videos return soon — today the focus is documents.",
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
              <h3 className="mb-1.5 text-[15px] font-semibold text-ink">
                {item.q}
              </h3>
              <p className="text-[14.5px] leading-relaxed text-ink-soft">
                {item.a}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FooterCta() {
  return (
    // Closer: same brand-field as the hero, so the landing opens and closes on
    // an emerald moment with the content in between in the quiet greyscale.
    <section className="brand-field relative overflow-hidden border-t border-hairline">
      <div className="mx-auto max-w-6xl px-6 py-28 text-center">
        <span
          className="orb orb-spin mx-auto mb-9 block h-[140px] w-[140px]"
          aria-hidden
        />
        <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(32px,5vw,52px)] font-semibold leading-[1.04] tracking-tight text-ink">
          Make decks people remember
        </h2>
        <p className="mx-auto mt-5 max-w-[44ch] text-[clamp(15px,2vw,17px)] leading-relaxed text-ink-soft">
          Your brand, every page. An outline you approve, an editor that
          listens.
        </p>
        <Link
          href="/new"
          className="mt-10 inline-block rounded-md bg-accent px-8 py-3.5 text-[15px] font-semibold text-accent-ink shadow-[0_20px_50px_-20px_rgba(0,194,138,0.7)] transition-all hover:brightness-110"
        >
          Start free — 1M tokens →
        </Link>
        <p className="mt-5 font-mono text-[11px] text-faint">
          Editing is always free. Pay only for generation.
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
          <a
            href="mailto:support@renderball.com"
            className="transition-colors hover:text-ink"
          >
            Contact
          </a>
        </nav>
        <p className="font-mono text-[11px] text-faint">
          © 2026 Renderball
        </p>
      </div>
    </footer>
  );
}
