import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

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
      <WhyAnimationRich />
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
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 pb-20 pt-20 text-center sm:pt-28">
        <span className="orb orb-spin mx-auto mb-9 block h-16 w-16" aria-hidden />
        <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          AI-native video generation
        </p>
        <h1 className="mx-auto max-w-[18ch] font-display text-[clamp(34px,6vw,60px)] font-semibold leading-[1.04] tracking-tight text-ink">
          Animation-rich video. Written by AI. Rendered to your brand.
        </h1>
        <p className="mx-auto mt-6 max-w-[56ch] text-[clamp(15px,2vw,18px)] leading-relaxed text-ink-soft">
          Describe the video you want. Approve a detailed script. Get a polished
          MP4 in minutes — your fonts, your colors, your exact text. No
          watermark, no card to start.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/new"
            className="rounded-md bg-accent px-6 py-3 text-[15px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Make a free minute
          </Link>
          <a
            href="#how"
            className="rounded-md border border-hairline-strong bg-surface px-6 py-3 text-[15px] font-medium text-ink transition-colors hover:border-ink/30"
          >
            See how it works
          </a>
        </div>
        <p className="mt-5 font-mono text-[11px] text-faint">
          Free first minute · 1080p · no watermark
        </p>
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
        <p className="mb-12 max-w-[52ch] text-[15px] leading-relaxed text-muted">
          You approve the story before any expensive compute runs, so you never
          pay for the wrong video.
        </p>
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

function WhyAnimationRich() {
  const rows = [
    {
      cat: "Talking-head avatars",
      gets: "An AI avatar reading your script",
      wrong: "Wrong format for anything that isn't a person talking",
    },
    {
      cat: "Stitched stock",
      gets: "Stock clips, captions, and music",
      wrong: "Every video looks the same — cheap and obvious",
    },
    {
      cat: "Generative AI video",
      gets: "Cinematic AI-imagined footage",
      wrong: "Uncontrollable — wrong logos, wrong text, off-brand color",
    },
  ];
  return (
    <section className="border-t border-hairline">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-2 font-display text-[clamp(24px,3.4vw,32px)] font-semibold tracking-tight text-ink">
          Most AI video falls into one of three traps
        </h2>
        <p className="mb-10 max-w-[56ch] text-[15px] leading-relaxed text-muted">
          Renderball is different. We render animation from code, written by AI,
          controlled by you — your fonts, your colors, your exact text, every
          frame deterministic. The output looks like motion graphics from a top
          agency, delivered in minutes instead of weeks.
        </p>
        <div className="overflow-hidden rounded-lg border border-hairline">
          {rows.map((r, i) => (
            <div
              key={r.cat}
              className={`grid grid-cols-1 gap-1 px-5 py-4 sm:grid-cols-[1fr_1.2fr_1.4fr] sm:gap-6 ${
                i > 0 ? "border-t border-hairline" : ""
              }`}
            >
              <div className="text-[14px] font-semibold text-ink">{r.cat}</div>
              <div className="text-[14px] text-ink-soft">{r.gets}</div>
              <div className="text-[14px] text-muted">{r.wrong}</div>
            </div>
          ))}
          <div className="grid grid-cols-1 gap-1 border-t border-accent-line bg-accent-soft px-5 py-4 sm:grid-cols-[1fr_1.2fr_1.4fr] sm:gap-6">
            <div className="text-[14px] font-semibold text-accent-text">
              Renderball
            </div>
            <div className="text-[14px] text-ink">
              Animation rendered from code, on-brand
            </div>
            <div className="text-[14px] text-ink-soft">
              Your fonts and colors, exact text, agency-grade — in minutes
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  const tiers = [
    {
      name: "Free",
      price: "$0",
      unit: "first minute",
      points: [
        "1 minute of 1080p video",
        "No watermark, ever",
        "Email or Google sign-in",
      ],
      cta: "Start free",
      featured: false,
    },
    {
      name: "Pay as you go",
      price: "$9.99",
      unit: "per minute",
      points: [
        "Full 1080p, frame-checked",
        "Unlimited script revisions",
        "First minute counts as a credit",
      ],
      cta: "Get started",
      featured: false,
    },
    {
      name: "Subscription",
      price: "$29.99",
      unit: "per month",
      points: [
        "5 minutes of video each month",
        "Priority render queue",
        "Brand kit storage + script history",
      ],
      cta: "Get started",
      featured: true,
    },
  ];
  return (
    <section id="pricing" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-2 font-display text-[clamp(24px,3.4vw,32px)] font-semibold tracking-tight text-ink">
          Pricing
        </h2>
        <p className="mb-12 max-w-[52ch] text-[15px] leading-relaxed text-muted">
          Every tier: full 1080p, AI voiceover included, no watermark. Your
          license, your assets.
        </p>
        <div className="grid gap-5 md:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`flex flex-col rounded-lg border bg-canvas p-6 ${
                t.featured
                  ? "border-accent-line shadow-[0_18px_40px_-24px_rgba(0,194,138,0.4)]"
                  : "border-hairline"
              }`}
            >
              <div className="mb-1 flex items-center gap-2">
                <h3 className="text-[15px] font-semibold text-ink">{t.name}</h3>
                {t.featured && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-text">
                    Popular
                  </span>
                )}
              </div>
              <div className="mb-5 flex items-baseline gap-1.5">
                <span className="font-display text-[34px] font-semibold tracking-tight text-ink">
                  {t.price}
                </span>
                <span className="font-mono text-[12px] text-muted">
                  {t.unit}
                </span>
              </div>
              <ul className="mb-7 flex-1 space-y-2.5">
                {t.points.map((p) => (
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
                className={`rounded-md px-4 py-2.5 text-center text-[14px] font-semibold transition-all hover:brightness-110 ${
                  t.featured
                    ? "bg-accent text-accent-ink"
                    : "border border-hairline-strong bg-surface text-ink hover:border-ink/30"
                }`}
              >
                {t.cta}
              </Link>
            </div>
          ))}
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
      a: "Never. Free, paid, or subscription — every video is yours, clean.",
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
    <section className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-6xl px-6 py-20 text-center">
        <span className="orb mx-auto mb-7 block h-12 w-12" aria-hidden />
        <h2 className="mx-auto max-w-[20ch] font-display text-[clamp(26px,4vw,40px)] font-semibold leading-[1.06] tracking-tight text-ink">
          Make your first minute
        </h2>
        <p className="mx-auto mt-4 max-w-[40ch] text-[15px] leading-relaxed text-muted">
          Free. No card. Premium output. Your brand.
        </p>
        <Link
          href="/new"
          className="mt-8 inline-block rounded-md bg-accent px-7 py-3 text-[15px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Make a free minute
        </Link>
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
