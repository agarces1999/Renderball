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
 * (Lemon Squeezy, Stripe) look at — a real description of what's sold, not a
 * login wall. Voice + tokens per DESIGN.md: cool greyscale chrome, the emerald
 * signal used sparingly, Cabinet Grotesk for display, no exclamation marks.
 */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect("/videos");

  return (
    <div className="min-h-screen bg-canvas">
      <LandingHeader />
      <Hero />
      <HowItWorks />
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
            Make a video
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
          AI-native video generation
        </p>
        <h1 className="mx-auto max-w-[18ch] font-display text-[clamp(34px,6vw,60px)] font-semibold leading-[1.04] tracking-tight text-ink">
          Animation-rich video. Written by AI. Rendered to your brand.
        </h1>
        <p className="mx-auto mt-6 max-w-[56ch] text-[clamp(15px,2vw,18px)] leading-relaxed text-ink-soft">
          Describe the video you want. Approve a detailed script. Get a polished
          MP4 in minutes. Your fonts, your colors, your exact text.
        </p>
        <HeroPrompt />
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-[11px] text-faint">
          <span>$49.99/mo · 1080p · no watermark</span>
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
      title: "Tell us what the video is for",
      body: "Plain English — a launch on your landing page, a Black Friday social story, an investor update. No categories, no boxes. Describe it the way you'd describe it to a designer.",
    },
    {
      n: "02",
      title: "Approve a detailed script",
      body: "We generate a second-by-second script: text, fonts, colors, timing, animation, music cues. Edit any field, regenerate any scene, or approve as-is. Nothing renders until you say yes.",
    },
    {
      n: "03",
      title: "Get the MP4 in minutes",
      body: "We render at 1080p and verify the output against your approved script. Download it, share it, or tweak the script and re-render the changed scenes.",
    },
  ];
  return (
    <section id="how" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-2 font-display text-[clamp(24px,3.4vw,32px)] font-semibold tracking-tight text-ink">
          Three gates, no surprises
        </h2>
        <p className="mb-10 max-w-[52ch] text-[15px] leading-relaxed text-muted">
          You approve the story before any expensive compute runs, so you never
          pay for the wrong video.
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

function Pricing() {
  const points = [
    "Unlimited videos, every month",
    "1080p, no watermark, your license",
    "AI voiceover included",
    "Brand kit storage + script history",
    "Priority render queue",
    "Cancel anytime",
  ];
  return (
    <section id="pricing" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <p className="mb-4 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          Pricing
        </p>
        <h2 className="mb-3 text-center font-display text-[clamp(26px,3.6vw,36px)] font-semibold tracking-tight text-ink">
          One plan. Everything included.
        </h2>
        <p className="mx-auto mb-12 max-w-[52ch] text-center text-[15px] leading-relaxed text-muted">
          Full 1080p, no watermark, AI voiceover included. Your license, your
          assets.
        </p>
        <div className="mx-auto max-w-md">
          <div className="flex flex-col rounded-lg border border-accent-line bg-canvas p-7 shadow-[0_24px_60px_-30px_rgba(0,194,138,0.5)]">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-ink">Renderball</h3>
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text">
                Subscription
              </span>
            </div>
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="font-display text-[42px] font-semibold tracking-tight text-ink">
                $49.99
              </span>
              <span className="font-mono text-[12px] text-muted">
                per month
              </span>
            </div>
            <p className="mb-6 text-[13px] text-muted">
              Billed monthly. Cancel anytime.
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
              Start your subscription
            </Link>
            <p className="mt-3 text-center font-mono text-[11px] text-faint">
              Secure checkout via our payment processor
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
      q: "Do I need to know video software?",
      a: "No. You describe what the video is for in plain English, and Renderball does the rest — script, design, animation, and render.",
    },
    {
      q: "Will my video have a watermark?",
      a: "Never. Every video is yours, clean — no watermark, your license.",
    },
    {
      q: "Can I use my own logo, fonts, and brand colors?",
      a: "Yes. Paste your website and Renderball auto-extracts your brand, or upload your assets directly.",
    },
    {
      q: "How long does a video take?",
      a: "Minutes from brief to delivery, including the script-approval step. Script edits re-render the changed scenes quickly.",
    },
    {
      q: "What can I use it for?",
      a: "Anything animation-rich: product launches, feature reveals, customer stories, sales outreach, social posts, investor updates, explainers.",
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
          Make videos people remember
        </h2>
        <p className="mx-auto mt-5 max-w-[44ch] text-[clamp(15px,2vw,17px)] leading-relaxed text-ink-soft">
          One subscription. Unlimited videos. Your brand, every frame.
        </p>
        <Link
          href="/new"
          className="mt-10 inline-block rounded-md bg-accent px-8 py-3.5 text-[15px] font-semibold text-accent-ink shadow-[0_20px_50px_-20px_rgba(0,194,138,0.7)] transition-all hover:brightness-110"
        >
          Start for $49.99/mo →
        </Link>
        <p className="mt-5 font-mono text-[11px] text-faint">
          Billed monthly. Cancel anytime.
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
