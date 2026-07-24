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

/** Shared ease-in-out: the cursor's travel and the marquee's growth use the
 *  same curve, so the rectangle's corner stays glued to the cursor. */
const ease = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

const typed = (text: string, t: number): string =>
  text.slice(0, Math.round(Math.max(0, Math.min(1, t)) * text.length));

/**
 * Scroll distance per section, in viewport heights.
 *
 * Each section plays a five-beat choreography (settle → travel → drag →
 * type → assemble), so this is effectively the playback speed: at 100 the
 * whole cycle flew past in a single screen-height and read as a blur.
 * 220 gives each beat room to be seen without the page feeling endless.
 */
const SECTION_VH = 220;

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
  /**
   * The cursor's work on THIS slide. `box` is in canvas %, chosen to sit in
   * that slide's genuinely empty region — generated things never cover the
   * slide's own content. `dark` matches the card to the slide it lands on.
   */
  demo: {
    box: { left: string; top: string; width: string; height: string };
    intent: string;
    eyebrow: string;
    value: string;
    note: string;
    dark?: boolean;
    swatches?: string[];
  };
};

const SECTIONS: Section[] = [
  {
    id: "problem",
    label: "The box",
    headline: "Design should not be prompted. It should be drawn.",
    body: "The category ships a text box: you type a paragraph, you get a flattened picture, and you start over every time. Renderball gives you a canvas instead.",
    deck: 0,
    slide: 0,
    demo: {
      box: { left: "7%", top: "44%", width: "23%", height: "24%" },
      intent: "a stat tile — 3 of 5 regions live",
      eyebrow: "rollout",
      value: "3 of 5",
      note: "regions live",
    },
  },
  {
    id: "draw",
    label: "Draw",
    headline: "Draw a box. Say what belongs inside it.",
    body: "Marquee any area of a slide and describe what goes there. A real element is generated inside exactly those bounds — the model writes the element, it never moves your box.",
    deck: 0,
    slide: 2,
    demo: {
      box: { left: "7%", top: "61%", width: "26%", height: "20%" },
      intent: "a KPI tile — 4.6 min to first draft",
      eyebrow: "first draft",
      value: "4.6 min",
      note: "from one URL",
    },
  },
  {
    id: "real",
    label: "Real",
    headline: "Every element is real. None of it is a picture.",
    body: "Drag it, resize it, retype it, delete it, export it to PDF at any scale. What the model made is the same material you edit — there is no flattened image step.",
    deck: 0,
    slide: 3,
    demo: {
      box: { left: "60%", top: "74%", width: "27%", height: "17%" },
      intent: "the extracted brand — swatches",
      eyebrow: "brand kit",
      value: "4 colors",
      note: "read from your site",
      swatches: ["#00c28a", "#121a2b", "#e5e7eb", "#047857"],
    },
  },
  {
    id: "free",
    label: "Free to edit",
    headline: "Editing is free. You only pay when it creates.",
    body: "Drag, resize, retype, reorder, undo — unmetered, forever. Generation is pay as you go, priced per token, and your first million are on us.",
    deck: 0,
    slide: 4,
    demo: {
      box: { left: "6%", top: "56%", width: "23%", height: "20%" },
      intent: "a ledger chip — this session",
      eyebrow: "this session",
      value: "0 tokens",
      note: "editing is free",
    },
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
        style={{ height: `${SECTIONS.length * SECTION_VH}vh` }}
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
              <Canvas section={section} local={local} first={idx === 0} />
              <SandboxLayer sb={sb} interactive={idx === 0} tabbable={armed}>
                <SandboxHint
                  show={armed && sb.elements.length === 0 && !sb.marquee && !sb.pending}
                  style={{ right: 28, bottom: 28, width: 190, height: 84 }}
                />
              </SandboxLayer>
            </div>

            <ClaimBar section={section} local={local} first={idx === 0} />
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
  first,
}: {
  section: Section;
  local: number;
  first: boolean;
}) {
  const deck = DEMO_DECKS[section.deck];
  const slide = deck?.slides[section.slide];
  if (!slide) return null;
  const d = section.demo;

  // One repeatable choreography, run on EVERY slide: settle → the cursor
  // travels in → drags the marquee open → types the intent inside it →
  // the element assembles and stays selected.
  // The fade-in exists to hide the slide SWAP between sections. The first
  // section is entered from nothing, so fading it would just serve a blank
  // canvas as the hero — the one frame every visitor is guaranteed to see.
  const enter = first ? 1 : seg(local, 0.02, 0.14);
  const travel = seg(local, 0.14, 0.24);
  const drag = seg(local, 0.24, 0.38);
  const type = seg(local, 0.4, 0.54);
  const made = seg(local, 0.56, 0.74);

  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{ opacity: enter }}
      >
        <SlideFrame slide={slide} />
      </div>

      {travel > 0 && (
        <div className="absolute" style={d.box}>
          {/* the marquee, growing with the cursor's drag */}
          <div
            className="absolute left-0 top-0 rounded-[4px] border-[1.5px] border-dashed"
            style={{
              width: `${Math.max(10, ease(drag) * 100)}%`,
              height: `${Math.max(12, ease(drag) * 100)}%`,
              borderColor: d.dark ? "rgba(52,211,153,0.75)" : "var(--accent-line)",
              background: d.dark ? "rgba(52,211,153,0.10)" : "rgba(0,194,138,0.10)",
              opacity: drag <= 0 ? 0 : made > 0.3 ? 0 : 1,
            }}
            aria-hidden
          />

          {/* the intent, typed INSIDE the drawn box */}
          {drag >= 1 && made < 0.12 && (
            <p
              className="absolute left-3 top-3 font-mono text-[12px]"
              style={{ color: d.dark ? "#6ee7b7" : "var(--accent-text)" }}
            >
              {typed(d.intent, type)}
              {type < 1 ? (
                <span
                  className="ml-0.5 inline-block h-[13px] w-[1.5px] animate-pulse align-middle"
                  style={{ background: d.dark ? "#6ee7b7" : "var(--accent-text)" }}
                />
              ) : (
                <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                  ⏎
                </span>
              )}
            </p>
          )}

          <GeneratedCard demo={d} t={made} />
        </div>
      )}

      <Cursor demo={d} travel={travel} drag={drag} type={type} made={made} />
    </div>
  );
}

/** The element the cursor makes — assembled in stages, dressed for the slide
 *  it lands on (a light card on a dark slide would read as a sticker). */
function GeneratedCard({
  demo: d,
  t,
}: {
  demo: Section["demo"];
  t: number;
}) {
  if (t <= 0) return null;
  const frame = seg(t, 0, 0.2);
  const head = seg(t, 0.15, 0.4);
  const val = seg(t, 0.35, 0.7);
  const rest = seg(t, 0.7, 1);
  return (
    <div
      className="absolute inset-0 rounded-lg border p-4 transition-all duration-500"
      style={{
        opacity: frame,
        transform: `translateY(${(1 - frame) * 8}px)`,
        background: d.dark ? "rgba(10,16,22,0.92)" : "var(--surface)",
        borderColor: d.dark ? "rgba(148,163,184,0.25)" : "var(--hairline)",
        boxShadow: d.dark
          ? "0 18px 44px -26px rgba(0,0,0,0.8)"
          : "0 18px 44px -26px rgba(18,26,43,0.45)",
      }}
    >
      <p
        className="font-mono text-[10px] uppercase tracking-[0.16em]"
        style={{ opacity: head, color: d.dark ? "#94a3b8" : "var(--muted)" }}
      >
        {d.eyebrow}
      </p>
      <p
        className="mt-1.5 font-display text-[30px] font-bold leading-none tracking-tight tabular-nums"
        style={{
          opacity: val,
          color: d.dark ? "#6ee7b7" : "var(--accent-text)",
        }}
      >
        {d.value}
      </p>
      <p
        className="mt-1.5 text-[12.5px]"
        style={{ opacity: rest, color: d.dark ? "#cbd5e1" : "var(--ink-soft)" }}
      >
        {d.note}
      </p>
      {d.swatches && (
        <div className="mt-2.5 flex gap-1.5" style={{ opacity: rest }}>
          {d.swatches.map((c, i) => (
            <span
              key={c}
              className="h-4 w-4 rounded-[3px] border border-hairline transition-all duration-300"
              style={{
                background: c,
                opacity: rest > i * 0.22 ? 1 : 0,
              }}
            />
          ))}
        </div>
      )}
      {t >= 1 && <Handles />}
    </div>
  );
}

/** The authoring cursor, present on EVERY slide: it travels to the box, drags
 *  it open (the rectangle's corner is glued to it — same easing on both),
 *  perches while the intent types, then steps aside once the element lands. */
function Cursor({
  demo: d,
  travel,
  drag,
  type,
  made,
}: {
  demo: Section["demo"];
  travel: number;
  drag: number;
  type: number;
  made: number;
}) {
  if (travel <= 0 || made >= 1) return null;
  const L = parseFloat(d.box.left);
  const T = parseFloat(d.box.top);
  const W = parseFloat(d.box.width);
  const H = parseFloat(d.box.height);

  let x: number;
  let y: number;
  if (drag <= 0) {
    // travelling in from just outside the box's corner
    const e = ease(travel);
    x = L - 9 + 9 * e;
    y = T - 7 + 7 * e;
  } else if (drag < 1) {
    const e = ease(drag);
    x = L + W * e;
    y = T + H * e;
  } else if (type < 1 || made <= 0) {
    // perched under the typing line, out of the text's way
    x = L + 2.2;
    y = T + H * 0.42;
  } else {
    // steps aside as the element assembles
    x = L + W + 2.5;
    y = T + H * 0.7;
  }
  return (
    <div
      className="absolute z-30 transition-opacity duration-300"
      style={{ left: `${x}%`, top: `${y}%`, opacity: made > 0.85 ? 0 : 1 }}
      aria-hidden
    >
      <span className="orb block h-[17px] w-[17px] -translate-x-1/2 -translate-y-1/2" />
      <span className="absolute -inset-1 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent-line opacity-40" />
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

function ClaimBar({
  section,
  local,
  first,
}: {
  section: Section;
  local: number;
  first: boolean;
}) {
  // Same reason as Canvas's fade: the rise-in covers the swap BETWEEN
  // sections. On the first one it would only hide the headline from the
  // visitor's first frame — and from anything reading the page statically.
  const t = first ? 1 : seg(local, 0.05, 0.25);
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
  const hero = SECTIONS[0];
  const heroSlide = DEMO_DECKS[hero.deck]?.slides[hero.slide];
  return (
    <div className="mx-auto max-w-[720px] px-5 py-10">
      {/* No wordmark here: this branch renders UNDER the page header, which
          already carries it. (The desktop branch hides that header and puts
          the wordmark in its own rail instead.) */}
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        The first AI-native design editor
      </p>
      <h1 className="font-display text-[clamp(32px,8vw,46px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
        {hero.headline}
      </h1>
      <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">{hero.body}</p>
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

      {heroSlide && (
        <div className="relative mt-8 aspect-video overflow-hidden rounded-lg border border-hairline">
          <SlideFrame slide={heroSlide} />
        </div>
      )}

      {/* The hero already told section 1; the rest follow it. */}
      <div className="mt-10 space-y-8">
        {SECTIONS.slice(1).map((s) => {
          const slide = DEMO_DECKS[s.deck]?.slides[s.slide];
          return (
            <section key={s.id}>
              {slide && (
                <div className="relative mb-3 aspect-video overflow-hidden rounded-lg border border-hairline">
                  <SlideFrame slide={slide} />
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
