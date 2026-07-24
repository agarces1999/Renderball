"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CaptureRegion,
  Handles,
  SandboxHint,
  SandboxLayer,
  useSandbox,
} from "./LandingSandbox";
import { DEMO_DECKS, type DemoSlide } from "./demo-decks";

/**
 * The landing IS the editor (founder call 2026-07-24, round 4).
 *
 * Structure borrows the one thing faces.app does better than us — the
 * product's OUTPUT is the hero, at full size, with visible range — and keeps
 * the thing they don't do at all: the editor itself, live. The page is an
 * editor window; the canvas holds REAL slides the pipeline generated (see
 * demo-decks.ts, snapshotted from built decks, not screenshots); and the
 * marquee-to-generate demo happens ON a real slide instead of a blank grid.
 *
 * The left rail is a slide rail: it navigates the page AND performs "this
 * product thinks in slides". Scroll advances the canvas through the deck,
 * exactly like flipping through a document in the real editor.
 *
 * Mobile / reduced-motion get the same shell without the scroll choreography
 * (the canvas simply stacks its slides).
 */

const seg = (p: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (p - a) / (b - a)));

const typed = (text: string, t: number): string =>
  text.slice(0, Math.round(Math.max(0, Math.min(1, t)) * text.length));

/** Sections of the page, each anchored to a slide in the canvas. The rail
 *  renders one thumbnail per entry. */
type Section = {
  id: string;
  /** rail label */
  label: string;
  /** the claim that appears beside the canvas while this section is active */
  headline: string;
  body: string;
  /** which demo deck + slide the canvas shows */
  deck: number;
  slide: number;
};

const SECTIONS: Section[] = [
  {
    id: "draw",
    label: "Draw",
    headline: "Draw a box. Say what belongs inside it.",
    body: "Marquee any area of a slide and describe what goes there. A real element is generated inside exactly those bounds — the model writes the element, it never moves your box.",
    deck: 0,
    slide: 0,
  },
  {
    id: "real",
    label: "Real",
    headline: "Every element is real. None of it is a picture.",
    body: "Drag it, resize it, retype it, delete it, export it to PDF at any scale. What the model made is the same material you edit — there is no flattened image step.",
    deck: 0,
    slide: 1,
  },
  {
    id: "brand",
    label: "On brand",
    headline: "One URL in. Your brand, on every slide.",
    body: "Renderball reads the site — logo, palette, type, and the way the brand actually composes — then designs inside it. You confirm the kit before anything generates.",
    deck: 0,
    slide: 2,
  },
  {
    id: "range",
    label: "Range",
    headline: "Not one template wearing different colors.",
    body: "The same engine composes an editorial opener and a dense analysis page. Register, density, and type change with the argument being made.",
    deck: 1,
    slide: 0,
  },
  {
    id: "meter",
    label: "Pricing",
    headline: "Editing is free. You only pay when it creates.",
    body: "Drag, resize, retype, reorder, undo — unmetered, forever. Generation is pay as you go, priced per token, and your first million are on us.",
    deck: 1,
    slide: 1,
  },
];

export function LandingEditor() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  const [clock, setClock] = useState(0);
  const started = useRef(false);

  // Which section the scroll is inside.
  const idx = Math.min(SECTIONS.length - 1, Math.floor(p * SECTIONS.length));
  const section = SECTIONS[idx];
  // Progress WITHIN the active section (drives the per-section choreography).
  const local = p * SECTIONS.length - idx;

  // The visitor's own marquee is armed on the first section only — that's
  // where the page is teaching the gesture.
  const armed = idx === 0 && local > 0.45;
  const sb = useSandbox({
    hostRef: stageRef,
    surface: "stage",
    armed,
    interactive: idx === 0,
  });

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = wrapRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const total = el.offsetHeight - window.innerHeight;
        const done = Math.max(0, Math.min(total, -rect.top));
        setP(total > 0 ? done / total : 0);
        if (!started.current && done > 4) started.current = true;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (started.current) setClock((c) => c + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const jumpTo = (i: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const total = el.offsetHeight - window.innerHeight;
    window.scrollTo({
      top: el.offsetTop + total * ((i + 0.35) / SECTIONS.length),
      behavior: "smooth",
    });
  };

  return (
    <>
      {/* ── the editor (desktop + motion-safe) ───────────────────────── */}
      <div
        ref={wrapRef}
        className="relative hidden lg:motion-safe:block"
        style={{ height: `${SECTIONS.length * 120}vh` }}
      >
        <div className="sticky top-0 flex h-screen gap-4 overflow-hidden p-4">
          <SlideRail active={idx} onJump={jumpTo} />

          <main className="flex min-w-0 flex-1 flex-col gap-3">
            <Toolbar armed={armed} clock={clock} />

            <div
              ref={stageRef}
              className={`relative flex-1 overflow-hidden rounded-xl border border-hairline bg-surface shadow-[0_30px_80px_-40px_rgba(18,26,43,0.45)] ${
                sb.drawing ? "select-none" : ""
              }`}
              style={{ touchAction: sb.drawing ? "none" : undefined }}
              onPointerDown={sb.onPointerDown}
              onPointerMove={sb.onPointerMove}
              onPointerUp={sb.onPointerUp}
              onPointerCancel={sb.onPointerCancel}
            >
              <CaptureRegion top={0} armed={armed && !sb.pending} />
              <Canvas section={section} local={local} idx={idx} />
              <SandboxLayer sb={sb} interactive={idx === 0} tabbable={armed}>
                <SandboxHint
                  show={armed && sb.elements.length === 0 && !sb.marquee && !sb.pending}
                  style={{ right: 28, bottom: 28, width: 190, height: 84 }}
                />
              </SandboxLayer>
            </div>

            <ClaimBar section={section} local={local} />
          </main>
        </div>
      </div>

      {/* ── static shell (mobile + reduced motion) ────────────────────── */}
      <div className="lg:motion-safe:hidden">
        <StaticEditor />
      </div>
    </>
  );
}

/* ─── left rail: navigation that performs "this thinks in slides" ────── */

function SlideRail({ active, onJump }: { active: number; onJump: (i: number) => void }) {
  return (
    <aside className="flex w-[188px] shrink-0 flex-col gap-3">
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <span className="orb h-6 w-6 shrink-0" aria-hidden />
        <span className="font-display text-[16px] font-semibold tracking-tight text-ink">
          Renderball
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Link
          href="/sign-in"
          className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-center text-[12.5px] text-ink transition-colors hover:bg-surface-2"
        >
          Log in
        </Link>
        <Link
          href="/new"
          className="rounded-md bg-accent px-3 py-1.5 text-center text-[12.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Open the editor
        </Link>
      </div>

      <div className="mt-1 flex flex-1 flex-col gap-1.5 overflow-hidden">
        <p className="px-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
          Document
        </p>
        {SECTIONS.map((s, i) => {
          const on = i === active;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onJump(i)}
              className={`group flex items-center gap-2 rounded-md border p-1.5 text-left transition-all ${
                on
                  ? "border-accent-line bg-accent-soft"
                  : "border-hairline bg-surface hover:border-hairline-strong"
              }`}
            >
              <span className="font-mono text-[9px] tabular-nums text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <RailThumb section={s} on={on} />
              <span
                className={`flex-1 truncate text-[11.5px] ${on ? "text-ink" : "text-muted"}`}
              >
                {s.label}
              </span>
            </button>
          );
        })}
      </div>

      <nav className="flex flex-col gap-1 px-1 pb-1 font-mono text-[11px] text-muted">
        <a href="#pricing" className="transition-colors hover:text-ink">
          Pricing
        </a>
        <a href="mailto:support@renderball.com" className="transition-colors hover:text-ink">
          Contact
        </a>
      </nav>
    </aside>
  );
}

/** A 16:9 chip that previews the section's slide — the rail reads as a real
 *  slide rail rather than a nav list. */
function RailThumb({ section, on }: { section: Section; on: boolean }) {
  const slide = DEMO_DECKS[section.deck]?.slides[section.slide];
  return (
    <span
      className={`block aspect-video w-9 shrink-0 overflow-hidden rounded-[3px] border ${
        on ? "border-accent-line" : "border-hairline"
      }`}
      style={{ background: slide?.bg ?? "var(--surface-2)" }}
      aria-hidden
    >
      <span
        className="block h-[3px] w-2/3 rounded-full"
        style={{ margin: "4px 0 0 3px", background: slide?.ink ?? "var(--muted)", opacity: 0.9 }}
      />
      <span
        className="block h-[1.5px] w-1/2 rounded-full"
        style={{ margin: "2px 0 0 3px", background: slide?.ink ?? "var(--faint)", opacity: 0.35 }}
      />
      <span
        className="block h-[1.5px] w-2/5 rounded-full"
        style={{ margin: "1.5px 0 0 3px", background: slide?.ink ?? "var(--faint)", opacity: 0.35 }}
      />
      <span
        className="block h-[4px] w-1/4 rounded-[1px]"
        style={{ margin: "3px 0 0 3px", background: slide?.accent ?? "var(--accent)" }}
      />
    </span>
  );
}

/* ─── toolbar: the editor's own chrome, honest about what's live ─────── */

function Toolbar({ armed, clock }: { armed: boolean; clock: number }) {
  const tools = [
    { k: "select", d: "M4 2 L4 15 L7.5 11.8 L10 17 L11.8 16.2 L9.4 11.2 L14 11 Z" },
    { k: "marquee", d: "" },
    { k: "text", d: "" },
    { k: "image", d: "" },
  ];
  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-1.5">
      {tools.map((t, i) => (
        <span
          key={t.k}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            (armed && t.k === "marquee") || (!armed && i === 0)
              ? "bg-accent-soft text-accent-text"
              : "text-muted"
          }`}
          title={t.k}
          aria-hidden
        >
          {t.k === "select" && (
            <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" fill="currentColor">
              <path d={t.d} />
            </svg>
          )}
          {t.k === "marquee" && (
            <span className="h-3 w-3.5 rounded-[2px] border-[1.5px] border-dashed border-current" />
          )}
          {t.k === "text" && <span className="font-display text-[12px] font-bold">T</span>}
          {t.k === "image" && (
            <span className="h-3 w-3.5 rounded-[2px] border-[1.5px] border-current" />
          )}
        </span>
      ))}
      <span className="mx-1 h-4 w-px bg-hairline" aria-hidden />
      <span className="font-mono text-[10.5px] text-muted">1920 × 1080</span>
      <span className="mx-1 h-4 w-px bg-hairline" aria-hidden />
      <span className="font-mono text-[10.5px] text-faint">100%</span>
      <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px] text-faint">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        {String(Math.floor(clock / 60)).padStart(2, "0")}:
        {String(clock % 60).padStart(2, "0")} · autosaved
      </span>
    </div>
  );
}

/* ─── canvas: a REAL generated slide, cross-faded per section ────────── */

function Canvas({
  section,
  local,
  idx,
}: {
  section: Section;
  local: number;
  idx: number;
}) {
  const deck = DEMO_DECKS[section.deck];
  const slide = deck?.slides[section.slide];
  if (!slide) return null;
  // The slide settles in, then (section 0 only) the scripted marquee runs.
  const enter = seg(local, 0.02, 0.18);
  const drag = idx === 0 ? seg(local, 0.2, 0.32) : 0;
  const type = idx === 0 ? seg(local, 0.33, 0.44) : 0;
  const made = idx === 0 ? seg(local, 0.46, 0.62) : 0;
  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{ opacity: enter }}
      >
        <SlideFrame slide={slide} />
      </div>

      {/* The teaching moment: a marquee drawn ON a real slide. */}
      {idx === 0 && drag > 0 && (
        <div
          className="absolute"
          /* The empty left-middle of this slide. Nothing generated may sit
             on top of the slide's own content — same no-overlap rule the
             rest of the page follows. */
          style={{ left: "7%", top: "44%", width: "23%", height: "24%" }}
        >
          <div
            className="absolute left-0 top-0 rounded-[4px] border-[1.5px] border-dashed border-accent-line bg-accent-soft/40"
            style={{
              width: `${Math.max(12, drag * 100)}%`,
              height: `${Math.max(14, drag * 100)}%`,
              opacity: made > 0.3 ? 0 : 1,
            }}
            aria-hidden
          />
          {drag >= 1 && made < 0.12 && (
            <p className="absolute left-3 top-3 font-mono text-[12px] text-accent-text">
              {typed("a stat tile — 3 of 5 regions live", type)}
              {type < 1 ? (
                <span className="ml-0.5 inline-block h-[13px] w-[1.5px] animate-pulse bg-accent-text align-middle" />
              ) : (
                <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                  ⏎
                </span>
              )}
            </p>
          )}
          {made > 0 && (
            <div
              className="absolute inset-0 rounded-lg border border-hairline bg-surface p-4 shadow-[0_18px_40px_-24px_rgba(18,26,43,0.45)] transition-all duration-500"
              style={{ opacity: made, transform: `translateY(${(1 - made) * 8}px)` }}
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                rollout
              </p>
              <p className="mt-1 font-display text-[34px] font-bold leading-none tracking-tight text-accent-text tabular-nums">
                {Math.round(3 * seg(made, 0.2, 0.7))} of 5
              </p>
              <p className="mt-1 text-[12px] text-ink-soft">regions live</p>
              {made >= 1 && <Handles />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One real slide, rendered as the DOM it actually is.
 *
 *  Slides are authored on a fixed 1920×1080 canvas with absolutely-positioned
 *  elements, so they can't reflow — they SCALE, exactly like the editor's own
 *  viewport and the PDF export. Measuring the host and applying a transform
 *  keeps every element's real geometry intact (no re-layout, no reflow bugs)
 *  at any container size. */
function SlideFrame({ slide }: { slide: DemoSlide }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(width / 1920, height / 1080));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      style={{ background: slide.bg }}
    >
      <div
        className="relative shrink-0"
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          // Until measured, stay invisible rather than flashing a 1920px slab.
          opacity: scale > 0 ? 1 : 0,
        }}
        dangerouslySetInnerHTML={{ __html: slide.html }}
      />
    </div>
  );
}

/* ─── claim bar under the canvas (faces puts the words after the proof) ─ */

function ClaimBar({ section, local }: { section: Section; local: number }) {
  const t = seg(local, 0.05, 0.25);
  return (
    <div className="flex items-start gap-6 px-1 pb-1">
      <div className="min-w-0 flex-1">
        <h2
          className="font-display text-[clamp(22px,2.4vw,34px)] font-bold leading-[1.1] tracking-[-0.02em] text-ink transition-all duration-500"
          style={{ opacity: t, transform: `translateY(${(1 - t) * 6}px)` }}
        >
          {section.headline}
        </h2>
        <p
          className="mt-1.5 max-w-[70ch] text-[14px] leading-relaxed text-ink-soft transition-opacity duration-500"
          style={{ opacity: t }}
        >
          {section.body}
        </p>
      </div>
      <Link
        href="/new"
        className="mt-1 shrink-0 rounded-md bg-accent px-5 py-2.5 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
      >
        Open the editor
      </Link>
    </div>
  );
}

/* ─── static shell (mobile + reduced motion) ─────────────────────────── */

function StaticEditor() {
  return (
    <div className="mx-auto max-w-[720px] px-5 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="orb h-7 w-7 shrink-0" aria-hidden />
        <span className="font-display text-[17px] font-semibold tracking-tight text-ink">
          Renderball
        </span>
      </div>
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        The first AI-native design editor
      </p>
      <h1 className="font-display text-[clamp(32px,8vw,46px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
        Design should not be prompted. It should be drawn.
      </h1>
      <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
        An editor where you draw a box, type what belongs inside it, and a real
        element appears — on your brand, editable to the last pixel, never an
        image.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href="/new"
          className="rounded-md bg-accent px-6 py-3 text-[14.5px] font-semibold text-accent-ink"
        >
          Open the editor
        </Link>
        <span className="font-mono text-[11px] text-faint">
          first 1M tokens free · no card
        </span>
      </div>

      <div className="mt-10 space-y-8">
        {SECTIONS.map((s) => {
          const slide = DEMO_DECKS[s.deck]?.slides[s.slide];
          return (
            <section key={s.id}>
              {slide && (
                <div
                  className="relative mb-3 aspect-video overflow-hidden rounded-lg border border-hairline"
                  style={{ background: slide.bg }}
                >
                  <div
                    className="absolute inset-0"
                    dangerouslySetInnerHTML={{ __html: slide.html }}
                  />
                </div>
              )}
              <h2 className="font-display text-[19px] font-bold tracking-tight text-ink">
                {s.headline}
              </h2>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">{s.body}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
