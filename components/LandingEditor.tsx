"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CaptureRegion,
  DotGrid,
  Handles,
  SandboxHint,
  SandboxLayer,
  useSandbox,
  SandboxPanel,
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
 * Each section now authors the slide's own elements one at a time and then
 * generates one extra artifact — 2 to 4 full travel → drag → type → assemble
 * cycles rather than one. This is the playback speed: at 220 (one cycle) the
 * beats were already tight, so more cycles need proportionally more room.
 */
const SECTION_VH = 320;

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
   * What the cursor types inside each marquee as it authors the slide's OWN
   * elements, in reading order. This ALSO caps how many pieces get authored,
   * so a re-snapshot that changes a slide's element count can never desync
   * the copy from the boxes — extra pieces just start visible.
   */
  intents: string[];
  /**
   * The one EXTRA element the cursor generates after the slide is composed.
   * `box` is in stage %, chosen to sit in that slide's genuinely empty
   * region. `kind` picks the artifact — a chart, a UI, or a stat tile.
   * Omitted where the slide's own last element is the better closing beat.
   */
  demo?: {
    kind: "chart" | "ui" | "stat";
    box: { left: string; top: string; width: string; height: string };
    intent: string;
    eyebrow: string;
    value: string;
    note: string;
    /** kind: "chart" — the bars, in order */
    series?: number[];
    /** kind: "ui" — the rows inside the mock window */
    rows?: string[];
    /** kind: "stat" — colour chips under the value */
    swatches?: string[];
  };
};

const SECTIONS: Section[] = [
  {
    // Opens on the PRODUCT, not a competitor: what Renderball is and the one
    // gesture the whole thing is built on.
    id: "draw",
    label: "Draw",
    headline: "You draw. Renderball designs.",
    body: "Renderball makes AI decks you can edit. Draw an area on the canvas, say what belongs there, and a real, editable element appears — on your brand. Presentation decks first.",
    deck: 0,
    slide: 2,
    intents: ["the method, in three steps", "a canvas mockup — draw, then real"],
    demo: {
      kind: "ui",
      box: { left: "5.5%", top: "58%", width: "27%", height: "27%" },
      intent: "a plan picker — three tiers",
      eyebrow: "choose a plan",
      value: "3 tiers",
      note: "free · pro · team",
      rows: ["Free — 1M tokens", "Pro — pay as you go", "Team — shared brand kit"],
    },
  },
  {
    id: "real",
    label: "Real",
    headline: "Everything it makes is real.",
    body: "Every element is a real object — drag it, resize it, retype it, export it to PDF. Never a flattened image. On your brand, pulled from a single URL.",
    deck: 0,
    slide: 3,
    intents: [
      "the proof, stated plainly",
      "a layers panel with four elements",
      "the pricing line",
    ],
    demo: {
      kind: "stat",
      box: { left: "60%", top: "73%", width: "27%", height: "19%" },
      intent: "the extracted brand — swatches",
      eyebrow: "brand kit",
      value: "4 colors",
      note: "read from your site",
      swatches: ["#00c28a", "#121a2b", "#e5e7eb", "#047857"],
    },
  },
  {
    // The competitor contrast — now that the visitor knows what Renderball is,
    // "everyone else ships a text box" lands instead of confusing.
    id: "problem",
    label: "Old way",
    headline: "The old way is prompt-and-pray.",
    body: "Type a paragraph, get a flat picture, start over every time. Renderball gives you a canvas you draw on instead — with elements you can actually edit.",
    deck: 0,
    slide: 0,
    intents: ["the headline", "a prompt box, greyed out"],
    demo: {
      kind: "chart",
      box: { left: "5.5%", top: "40%", width: "26%", height: "30%" },
      intent: "a chart — weekly active, 8 weeks",
      eyebrow: "weekly active",
      value: "+38%",
      note: "last 8 weeks",
      series: [32, 38, 34, 47, 52, 48, 63, 74],
    },
  },
  {
    id: "free",
    label: "Free",
    headline: "Your first million tokens are free.",
    body: "Editing is always free — you only pay when Renderball generates, priced per token. Your first million (about three decks) are on us.",
    deck: 0,
    slide: 4,
    // No extra artifact here: the last thing the cursor draws on the page is
    // the call to action itself, which is a better closing beat than a tile.
    intents: ["the closing line", "the call to action"],
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
              // Plain pan-y: touch-action is latched at gesture start, so a
              // state-driven flip to "none" could never protect a drag
              // already in flight (vertical finger-drawn marquees were being
              // claimed for page scroll). Draw-wins lives on the armed
              // CaptureRegion instead — none at the touch target itself —
              // while pieces and the unarmed stage keep scrolling the page.
              style={{ touchAction: "pan-y" }}
              onPointerDown={sb.onPointerDown}
              onPointerMove={sb.onPointerMove}
              onPointerUp={sb.onPointerUp}
              onPointerCancel={sb.onPointerCancel}
            >
              <CaptureRegion top={0} armed={armed && !sb.pending} drawWins />
              <Canvas section={section} local={local} first={idx === 0} />
              <SandboxLayer sb={sb} interactive={idx === 0} tabbable={armed}>
                <SandboxHint
                  show={armed && sb.elements.length === 0 && !sb.marquee && !sb.pending}
                  style={{ right: 28, bottom: 28, width: 190, height: 84 }}
                />
              </SandboxLayer>
              <ColdOpen progress={p} />
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

/* ─── cold open: the branded SEED beat (DESIGN.md "Scroll narrative" beat 1) ─
 *
 * The first frame used to be a frozen mid-draw on an empty canvas, which read
 * as "nothing here". This fills it with the motif instead: the crystal orb
 * floating (its rim rotating, a gentle bob), the wordmark, and a scroll arrow
 * — then it lifts and fades as the visitor scrolls, revealing the editor
 * choreography underneath.
 *
 * Not part of the scroll choreography, but its opacity and lift ARE driven by
 * scroll, so it clears by ~7.5% and never sits over the beats. Covers the
 * canvas only: the rail, toolbar and claim bar stay framed around it, so the
 * seed reads as "inside the editor", not a splash screen over it. */
function ColdOpen({ progress }: { progress: number }) {
  const out = seg(progress, 0.02, 0.075);
  if (out >= 1) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-surface"
      style={{ opacity: 1 - out, transform: `translateY(${-out * 46}px)` }}
      aria-hidden
    >
      <DotGrid />
      <div className="relative flex flex-col items-center">
        <span
          className="orb orb-spin block h-24 w-24"
          style={{ animation: "rb-orb-float 4.5s ease-in-out infinite" }}
        />
        <h1
          className="mt-8 font-display text-[clamp(38px,5.5vw,64px)] font-bold tracking-[-0.02em] text-ink"
          style={{ animation: "rb-fade-up 640ms ease-out both", animationDelay: "120ms" }}
        >
          Renderball
        </h1>
        <p
          className="mt-2.5 font-mono text-[12px] uppercase tracking-[0.24em] text-muted"
          style={{ animation: "rb-fade-up 640ms ease-out both", animationDelay: "240ms" }}
        >
          AI decks you can edit
        </p>
        <div
          className="mt-11 flex flex-col items-center gap-1.5"
          style={{ animation: "rb-fade 640ms ease-out both", animationDelay: "560ms" }}
        >
          <span className="font-mono text-[10.5px] tracking-[0.18em] text-faint">
            SCROLL TO BEGIN
          </span>
          <span
            className="text-[17px] text-accent-text"
            style={{ animation: "rb-scroll-nudge 1.4s ease-in-out infinite" }}
          >
            ↓
          </span>
        </div>
      </div>
    </div>
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
          href="/api/documents/new" prefetch={false}
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

/* ─── canvas: a REAL generated slide, AUTHORED element by element ────── */

/** A rectangle in stage percentages — what a person would drag around a
 *  thing on the canvas. */
type PieceBox = { left: number; top: number; width: number; height: number };

/**
 * The union of a piece's INK: the rects of descendants that actually draw
 * something (text, media, a filled or bordered box), not the piece's layout
 * wrapper. Slides are composed of absolutely-positioned pieces, and several
 * of those wrappers are full-bleed flex centerers — measuring the wrapper
 * would put a marquee around the whole canvas when the thing a person sees
 * is a headline in the middle of it.
 */
function inkBox(piece: Element, root: DOMRect): PieceBox | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;

  const walk = (el: Element) => {
    const cs = getComputedStyle(el);
    // Deliberately does NOT skip opacity:0 — that is how this component hides
    // unauthored pieces, so honouring it here would make any re-measure find
    // nothing, drop the piece from the mask, and flash the whole slide.
    if (cs.visibility === "hidden" || cs.display === "none") return;
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
    );
    const painted =
      /^(IMG|SVG|CANVAS|VIDEO)$/.test(el.tagName) ||
      (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") ||
      cs.backgroundImage !== "none" ||
      parseFloat(cs.borderTopWidth) > 0 ||
      parseFloat(cs.borderRightWidth) > 0 ||
      parseFloat(cs.borderBottomWidth) > 0 ||
      parseFloat(cs.borderLeftWidth) > 0;
    if (hasText || painted) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        l = Math.min(l, rect.left);
        t = Math.min(t, rect.top);
        r = Math.max(r, rect.right);
        b = Math.max(b, rect.bottom);
      }
    }
    Array.from(el.children).forEach(walk);
  };
  // Deliberately skip the piece's own root: it is the positioning wrapper.
  Array.from(piece.children).forEach(walk);

  if (l === Infinity || root.width === 0 || root.height === 0) return null;
  return {
    left: ((l - root.left) / root.width) * 100,
    top: ((t - root.top) / root.height) * 100,
    width: ((r - l) / root.width) * 100,
    height: ((b - t) / root.height) * 100,
  };
}

/** Smallest ink a marquee is worth drawing around, as a share of the canvas.
 *  Below this are brand lockups and one-line footnotes: real elements, but
 *  authoring them is a beat about nothing. They start visible. */
const MIN_PIECE_AREA = 1.8;

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
  // Measurements are tagged with the section they came from: the slide swaps
  // under this component, and stale boxes would draw marquees in mid-air.
  const [measured, setMeasured] = useState<{ id: string; boxes: PieceBox[] }>({
    id: "",
    boxes: [],
  });
  const boxes = measured.id === section.id ? measured.boxes : [];
  if (!slide) return null;

  const authorable = Math.min(boxes.length, section.intents.length);
  const steps = authorable + (section.demo ? 1 : 0);

  /**
   * The hero cannot open on a dead canvas — but the answer is NOT to place an
   * element for free (that put the headline, the paragraph and three cards on
   * screen without the cursor ever drawing them). Instead the first section
   * opens part-way into its first cycle: at scroll 0 the cursor is already
   * mid-drag on an empty canvas, which is the product working rather than a
   * page waiting. The span is shortened to match, so the section still ends
   * exactly on its last beat.
   */
  const headStart = first ? 0.55 : 0;

  // Before the first measurement lands there is nothing to choreograph —
  // show the finished slide rather than a half-built one.
  const ready = steps > 0;
  const LEAD = 0.05;
  const TAIL = 0.94;
  const span = (TAIL - LEAD) / Math.max(0.5, steps - headStart);
  const raw = (local - LEAD) / span + headStart;
  const stepIdx = Math.max(0, Math.min(steps - 1, Math.floor(raw)));
  const u = ready ? Math.max(0, Math.min(1, raw - stepIdx)) : 1;

  // One cycle, identical whether the cursor is authoring a piece of the slide
  // or the extra artifact: travel → drag the box → type the intent → assemble.
  const travel = seg(u, 0.02, 0.24);
  const drag = seg(u, 0.24, 0.52);
  const type = seg(u, 0.54, 0.74);
  const made = seg(u, 0.76, 0.98);

  const onDemoStep = ready && stepIdx >= authorable && !!section.demo;
  const box: PieceBox | null = onDemoStep
    ? {
        left: parseFloat(section.demo!.box.left),
        top: parseFloat(section.demo!.box.top),
        width: parseFloat(section.demo!.box.width),
        height: parseFloat(section.demo!.box.height),
      }
    : (boxes[stepIdx] ?? null);
  const intent = onDemoStep
    ? section.demo!.intent
    : (section.intents[stepIdx] ?? "");

  // A piece lands as its own cycle assembles and stays for the rest of the
  // section — the slide accumulates rather than flickering.
  //
  // Opacity is a pure function of scroll, like every other beat on this page,
  // rather than a threshold plus a CSS transition. With a transition, a fast
  // scroll could leave the marquee's fade-out and the element's fade-in in
  // flight at the same time, so the element appeared inside its own marquee.
  const current = stepIdx;
  const reveal = Array.from({ length: authorable }, (_, i) => {
    if (!ready) return 1;
    if (i < current) return 1;
    if (i > current) return 0;
    return Number(seg(made, 0.32, 0.62).toFixed(2));
  });

  return (
    <div className="pointer-events-none absolute inset-0">
      <SlideFrame
        key={`${section.deck}-${section.slide}`}
        slide={slide}
        reveal={reveal}
        limit={section.intents.length}
        onMeasure={(b) => setMeasured({ id: section.id, boxes: b })}
      />

      {ready && box && travel > 0 && (
        <div
          className="absolute"
          style={{
            left: `${box.left}%`,
            top: `${box.top}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
          }}
        >
          {/* the marquee, growing with the cursor's drag */}
          <div
            className="absolute left-0 top-0 rounded-[4px] border-[1.5px] border-dashed border-accent-line"
            style={{
              width: `${Math.max(8, ease(drag) * 100)}%`,
              height: `${Math.max(10, ease(drag) * 100)}%`,
              background: "rgba(0,194,138,0.10)",
              // Scroll-driven, with no CSS transition, for the same reason
              // the pieces are: a time-based fade-out could still be in
              // flight when the element began revealing, so the element
              // appeared inside its own marquee and read as having been
              // there all along. Fully clear by 0.18; elements land at 0.32.
              opacity: drag <= 0 ? 0 : 1 - seg(made, 0.04, 0.18),
            }}
            aria-hidden
          />

          {/* the intent, typed INSIDE the drawn box */}
          {drag >= 1 && made < 0.15 && (
            <p className="absolute left-2.5 top-2.5 font-mono text-[11.5px] text-accent-text">
              {typed(intent, type)}
              {type < 1 ? (
                <span className="ml-0.5 inline-block h-[12px] w-[1.5px] animate-pulse bg-accent-text align-middle" />
              ) : (
                <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                  ⏎
                </span>
              )}
            </p>
          )}

          {onDemoStep && <GeneratedArtifact demo={section.demo!} t={made} />}
        </div>
      )}

      {ready && box && (
        <Cursor box={box} travel={travel} drag={drag} type={type} made={made} />
      )}
    </div>
  );
}

/* ─── the extra element the cursor makes ─────────────────────────────── */

/** Slides carry headlines, UIs and numbers, so the thing the cursor generates
 *  is one of those three — a tile that only ever says "a box appeared" is not
 *  evidence that the engine can build anything. */
function GeneratedArtifact({
  demo: d,
  t,
}: {
  demo: NonNullable<Section["demo"]>;
  t: number;
}) {
  if (t <= 0) return null;
  const frame = seg(t, 0.1, 0.3);
  const head = seg(t, 0.25, 0.45);
  const body = seg(t, 0.35, 0.75);
  const rest = seg(t, 0.7, 1);

  return (
    <div
      className="absolute inset-0 overflow-hidden rounded-lg border border-hairline bg-surface p-3.5 shadow-[0_18px_44px_-26px_rgba(18,26,43,0.45)] transition-all duration-500"
      style={{ opacity: frame, transform: `translateY(${(1 - frame) * 8}px)` }}
    >
      <div className="flex items-baseline justify-between gap-2" style={{ opacity: head }}>
        <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted">
          {d.eyebrow}
        </p>
        <p className="font-display text-[15px] font-bold leading-none tracking-tight text-accent-text tabular-nums">
          {d.value}
        </p>
      </div>

      {d.kind === "chart" && <ChartBody series={d.series ?? []} t={body} />}
      {d.kind === "ui" && <UiBody rows={d.rows ?? []} t={body} />}
      {d.kind === "stat" && <StatBody swatches={d.swatches} t={body} />}

      <p className="mt-2 text-[11.5px] text-ink-soft" style={{ opacity: rest }}>
        {d.note}
      </p>
      {t >= 1 && <Handles />}
    </div>
  );
}

/** Bars draw from the baseline up, left to right, as the element assembles —
 *  the same way the engine's chart elements enter. */
function ChartBody({ series, t }: { series: number[]; t: number }) {
  const max = Math.max(1, ...series);
  return (
    <div className="mt-2.5 flex h-[52%] items-end gap-[3px] border-b border-hairline pb-px">
      {series.map((v, i) => {
        const grown = seg(t, i / (series.length + 2), (i + 2.5) / (series.length + 2));
        const last = i === series.length - 1;
        return (
          <span
            key={i}
            className="flex-1 rounded-t-[2px]"
            style={{
              height: `${(v / max) * 100 * grown}%`,
              background: last ? "var(--accent)" : "var(--accent-soft-strong, #b6ead6)",
              transition: "height 240ms ease",
            }}
          />
        );
      })}
    </div>
  );
}

/** A miniature interface: window chrome, rows, and a real button — the kind
 *  of element people actually ask a deck for. */
function UiBody({ rows, t }: { rows: string[]; t: number }) {
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-hairline">
      <div className="flex items-center gap-1 border-b border-hairline bg-surface-2 px-2 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-faint" />
        <span className="h-1.5 w-1.5 rounded-full bg-faint" />
        <span className="h-1.5 w-1.5 rounded-full bg-faint" />
      </div>
      <div className="divide-y divide-hairline">
        {rows.map((r, i) => {
          const on = seg(t, i / (rows.length + 1), (i + 1.5) / (rows.length + 1));
          return (
            <div
              key={r}
              className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10.5px] text-ink"
              style={{ opacity: on }}
            >
              <span className="truncate">{r}</span>
              {i === rows.length - 1 && (
                <span className="shrink-0 rounded-[3px] bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-accent-ink">
                  Pick
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Colour chips, landing one at a time. */
function StatBody({ swatches, t }: { swatches?: string[]; t: number }) {
  if (!swatches?.length) return null;
  return (
    <div className="mt-3 flex gap-1.5">
      {swatches.map((c, i) => (
        <span
          key={c}
          className="h-5 w-5 rounded-[3px] border border-hairline transition-all duration-300"
          style={{ background: c, opacity: t > i * 0.22 ? 1 : 0 }}
        />
      ))}
    </div>
  );
}

/** The authoring cursor: it travels to the box, drags it open (the
 *  rectangle's corner is glued to it — same easing on both), perches while
 *  the intent types, then steps aside once the element lands. */
function Cursor({
  box,
  travel,
  drag,
  type,
  made,
}: {
  box: PieceBox;
  travel: number;
  drag: number;
  type: number;
  made: number;
}) {
  if (travel <= 0) return null;
  const { left: L, top: T, width: W, height: H } = box;

  let x: number;
  let y: number;
  if (drag <= 0) {
    const e = ease(travel);
    x = L - 9 + 9 * e;
    y = T - 7 + 7 * e;
  } else if (drag < 1) {
    const e = ease(drag);
    x = L + W * e;
    y = T + H * e;
  } else if (type < 1 || made <= 0) {
    x = L + 2.2;
    y = T + Math.min(H * 0.42, 6);
  } else {
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

/** One real slide, rendered as the DOM it actually is, and revealed piece by
 *  piece as the cursor authors it.
 *
 *  Slides are authored on a fixed 1920×1080 canvas with absolutely-positioned
 *  elements, so they can't reflow — they SCALE, exactly like the editor's own
 *  viewport and the PDF export. Measuring the host and applying a transform
 *  keeps every element's real geometry intact (no re-layout, no reflow bugs)
 *  at any container size.
 *
 *  `authored` hides the pieces the cursor has not drawn yet. Only opacity is
 *  touched: these are the engine's own nodes, and several position themselves
 *  with `transform`, which we must not clobber. */
function SlideFrame({
  slide,
  /** opacity per authorable piece, in reading order */
  reveal = [],
  // limit 0 = author nothing: the static branch just wants the finished slide.
  limit = 0,
  onMeasure = () => {},
}: {
  slide: DemoSlide;
  reveal?: number[];
  limit?: number;
  onMeasure?: (boxes: PieceBox[]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  /**
   * The authorable pieces, as CHILD INDICES in reading order (index matches
   * `onMeasure`). Indices, not element references, and hidden with a CSS rule
   * rather than inline styles: React re-creates the injected subtree on
   * re-render, which both detaches any node we held AND wipes every inline
   * style we wrote — the whole slide flashed into view on each recreation.
   * A rule in the stylesheet survives it.
   */
  const [order, setOrder] = useState<number[]>([]);
  /** true once this slide has been measured and its mask is on the page */
  const [masked, setMasked] = useState(false);
  /**
   * The slide's own call to action, if it has one. The canvas is injected
   * HTML inside a `pointer-events: none` layer (the sandbox needs the whole
   * stage to itself), so the big green "Open the editor" pill on the closing
   * slide LOOKED like the page's primary button and did nothing when clicked.
   * A real link is laid over its measured rect instead of making the whole
   * snapshot interactive. `step` is the authored piece the pill belongs to,
   * so the link goes live only once the cursor has actually drawn it.
   */
  const [cta, setCta] = useState<{ box: PieceBox; step: number } | null>(null);
  const measureRef = useRef(onMeasure);
  measureRef.current = onMeasure;
  const uid = `rbslide${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const html = useMemo(() => ({ __html: slide.html }), [slide.html]);

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

  // Measure once the slide is laid out and scaled. Percentages are taken
  // against the rendered root, so the transform cancels out.
  useEffect(() => {
    const host = innerRef.current;
    if (!host || scale <= 0) return;
    // The snapshot is ONE root element (the scene's canvas div) whose
    // children are the pieces — enumerate inside it, not around it.
    const root = host.firstElementChild ?? host;
    const rootRect = root.getBoundingClientRect();
    const found: { idx: number; box: PieceBox }[] = [];
    Array.from(root.children).forEach((piece, idx) => {
      if (piece.tagName === "STYLE") return;
      // Pure decoration (gradients, blurs) is never authored — it is the
      // canvas plan's background, not an element anyone would draw.
      const hasContent =
        (piece.textContent ?? "").trim().length > 0 || !!piece.querySelector("img,svg");
      if (!hasContent) return;
      const box = inkBox(piece, rootRect);
      if (!box) return;
      if (box.width * box.height < MIN_PIECE_AREA * 100) return;
      if (box.width > 97 && box.height > 97) return;
      found.push({ idx, box });
    });
    found.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
    const picked = found.slice(0, limit);
    setOrder(picked.map((f) => f.idx));
    setMasked(true);
    measureRef.current(picked.map((f) => f.box));

    // The deck engine emits a slide's button as a `cta.primary` piece; that
    // is the one thing on a snapshot a visitor will genuinely try to click.
    const ctaEl = root.querySelector<HTMLElement>('[data-content-path="cta.primary"]');
    if (!ctaEl) {
      setCta(null);
      return;
    }
    const r = ctaEl.getBoundingClientRect();
    setCta({
      box: {
        left: ((r.left - rootRect.left) / rootRect.width) * 100,
        top: ((r.top - rootRect.top) / rootRect.height) * 100,
        width: (r.width / rootRect.width) * 100,
        height: (r.height / rootRect.height) * 100,
      },
      // -1 when the pill is not one of the authored pieces (the static branch
      // authors nothing) — `reveal[-1]` is undefined, which reads as visible.
      step: picked.findIndex((f) => root.children[f.idx]?.contains(ctaEl)),
    });
  }, [slide, scale, limit]);

  // `!important` because several pieces carry their own entry animations, and
  // an animation beats a plain declaration. No CSS transition: the caller
  // already drives these from scroll position, and adding one would reinstate
  // the in-flight overlap it was written to remove.
  // Targets the wrapper's CHILDREN, not the wrapper. The engine emits each
  // piece as a `display: contents` wrapper, which generates no box at all —
  // so `opacity` on it is silently ignored by the renderer while
  // getComputedStyle still reports the value we set. Every mask written to
  // the wrapper read as applied and drew nothing. The children are real
  // boxes, and inkBox only ever measures children, so this is exactly the
  // set of nodes that carries the piece's ink.
  const hideCss = order
    .map(
      (childIdx, i) =>
        `#${uid}>*>:nth-child(${childIdx + 1})>*{opacity:${reveal[i] ?? 1}!important}`,
    )
    .join("");

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      style={{ background: slide.bg }}
    >
      {hideCss && <style>{hideCss}</style>}
      <div
        id={uid}
        ref={innerRef}
        className="relative shrink-0"
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          // Hidden until BOTH the fit and the mask are ready: showing it after
          // the fit alone painted the finished slide for several frames before
          // the mask could hide the unauthored pieces. `limit === 0` is the
          // static branch, which never masks and must not wait for one.
          opacity: scale > 0 && (limit === 0 || masked) ? 1 : 0,
        }}
        dangerouslySetInnerHTML={html}
      />

      {/* The pill the visitor can see, made real. Mirrors the injected root's
          geometry — same 1920×1080 box, same scale about the same centre — so
          the hit area tracks the slide at any container size. */}
      {cta && scale > 0 && (reveal[cta.step] ?? 1) > 0.6 && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2"
          style={{
            width: 1920,
            height: 1080,
            marginLeft: -960,
            marginTop: -540,
            transform: `scale(${scale})`,
            transformOrigin: "center center",
          }}
        >
          <Link
            href="/api/documents/new" prefetch={false}
            aria-label="Open the editor"
            className="pointer-events-auto absolute block rounded-full outline-offset-8 focus-visible:outline focus-visible:outline-4 focus-visible:outline-[color:var(--accent)]"
            style={{
              left: `${cta.box.left}%`,
              top: `${cta.box.top}%`,
              width: `${cta.box.width}%`,
              height: `${cta.box.height}%`,
            }}
          />
        </div>
      )}
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
        href="/api/documents/new" prefetch={false}
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
        AI decks you can edit
      </p>
      <h1 className="font-display text-[clamp(32px,8vw,46px)] font-bold leading-[1.06] tracking-[-0.02em] text-ink">
        {hero.headline}
      </h1>
      <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">{hero.body}</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href="/api/documents/new" prefetch={false}
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

      {/* The gesture itself, not just pictures of it — the bounded sandbox
          (draw → pick → materialize) that the scroll branch performs. This
          mount was lost when the previous landing was retired; phones showed
          the promise and never the product. */}
      <SandboxPanel />

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
