"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CaptureRegion,
  DotGrid,
  Handles,
  SandboxHint,
  SandboxLayer,
  SandboxPanel,
  useSandbox,
} from "./LandingSandbox";

/**
 * The landing hero IS a Renderball canvas performing (DESIGN.md "Landing —
 * the canvas performs"). v3 (founder review 2026-07-24, round 2):
 *
 * THE EDITOR IS THE MAIN CHARACTER. A glass-orb cursor authors the whole
 * page: it selects and deletes the category's prompt box, then for each
 * generation it DRAGS the marquee open (the rectangle follows the cursor),
 * TYPES the intent inside the drawn area — the real marquee-to-generate
 * flow — and the element assembles in stages: the KPI number counts up, the
 * sparkline draws itself, chart bars rise with their values, the title
 * lockup reveals word by word. No URL chip, no URL instructions — the brand
 * story lives in the receipt stamps and the FAQ, not the hero.
 *
 * All motion is a pure function of scroll progress (scrubs both ways). Demo
 * generations carry a mono `sandbox` label; the receipt stamps are the real
 * 4:37 build. Mobile + reduced-motion get the static composed story.
 */

const seg = (p: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (p - a) / (b - a)));

const typed = (text: string, t: number): string =>
  text.slice(0, Math.round(Math.max(0, Math.min(1, t)) * text.length));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shared ease-in-out — the cursor's travel AND the marquee growth use the
 *  same curve, so the rectangle's corner stays glued to the orb mid-drag. */
const ease = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/** Beat windows (5 beats — the URL/brand beat was cut by founder call). */
const T = {
  funeral: [0.0, 0.1],
  draw: [0.1, 0.46],
  real: [0.46, 0.64],
  deck: [0.64, 0.83],
  door: [0.83, 1.0],
} as const;

const CAPTIONS = [
  { n: "00", text: "The category ships a text box. We don't.", from: 0.0, to: 0.1 },
  { n: "01", text: "Draw a box. Type what lives in it. It exists.", from: 0.1, to: 0.46 },
  { n: "02", text: "Real elements. Not a screenshot of a design.", from: 0.46, to: 0.64 },
  { n: "03", text: "A full deck, watched — not promised.", from: 0.64, to: 0.83 },
  { n: "04", text: "Editing is free. You only pay when it creates.", from: 0.83, to: 1.0 },
] as const;

/** Hero text lives above this line; the performance below. Hard contract. */
const BAND = 500;

/** The stage accepts visitor marquees from the first landed artifact until
 *  the deck beat clears the canvas for the finale. */
const SANDBOX_ARM = [0.26, 0.64] as const;

/** The three marquee slots (bigger, per founder review). */
const SLOTS = {
  kpi: { x: 56, y: BAND + 8, w: 384, h: 248 },
  title: { x: 486, y: BAND + 26, w: 300, h: 212 },
  chart: { x: 832, y: BAND + 2, w: 300, h: 266 },
} as const;

/** Per-artifact windows on the master progress: cursor drags the marquee
 *  open, the intent types INSIDE the box, then the element assembles. */
const W = {
  kpi: { drag: [0.105, 0.145], type: [0.15, 0.19], build: [0.195, 0.26] },
  title: { drag: [0.225, 0.26], type: [0.265, 0.3], build: [0.305, 0.36] },
  chart: { drag: [0.325, 0.36], type: [0.365, 0.4], build: [0.405, 0.455] },
} as const;

export function LandingCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  const [clock, setClock] = useState(0);
  const started = useRef(false);
  // The visitor's turn — additive over the scripted beats (see LandingSandbox).
  const armed = p >= SANDBOX_ARM[0] && p < SANDBOX_ARM[1];
  const sb = useSandbox({
    hostRef: stageRef,
    surface: "stage",
    armed,
    interactive: p < SANDBOX_ARM[1],
    regionTop: BAND,
    // The scripted tile is already showing kpi[0] and the scripted chart
    // chart[0] — start the visitor a variant along so their first draw
    // reads as a new element, not a copy.
    startVariants: { kpi: 1, chart: 1 },
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

  return (
    <>
      <div
        ref={wrapRef}
        className="relative hidden lg:motion-safe:block"
        style={{ height: "620vh" }}
      >
        <div className="sticky top-0 h-screen overflow-hidden">
          <DotGrid />
          <div
            ref={stageRef}
            className={`relative mx-auto h-full max-w-[1180px] px-6 ${
              sb.drawing ? "select-none" : ""
            }`}
            style={{ touchAction: sb.drawing ? "none" : undefined }}
            onPointerDown={sb.onPointerDown}
            onPointerMove={sb.onPointerMove}
            onPointerUp={sb.onPointerUp}
            onPointerCancel={sb.onPointerCancel}
          >
            <CaptureRegion top={BAND} armed={armed && !sb.pending} />
            <HeroBlock doorT={seg(p, T.door[0], 0.87)} />
            <Stage p={p} />
            <SandboxLayer sb={sb} interactive={p < SANDBOX_ARM[1]} tabbable={armed}>
              <SandboxHint
                show={armed && sb.elements.length === 0 && !sb.marquee && !sb.pending}
                style={{ left: 486, top: BAND + 268, width: 300, height: 74 }}
              />
            </SandboxLayer>
            <Cursor p={p} />
            <CaptionRail p={p} />
            <div className="absolute bottom-5 right-6 font-mono text-[11px] tabular-nums text-faint">
              {String(Math.floor(clock / 60)).padStart(2, "0")}:
              {String(clock % 60).padStart(2, "0")} — document open
            </div>
          </div>
        </div>
      </div>

      <div className="relative lg:motion-safe:hidden">
        <DotGrid />
        <StaticStory />
      </div>
    </>
  );
}

/* ─── scenery ─────────────────────────────────────────────────────────── */

/** Centered hero. Editor-first copy — no URL instructions (founder call). */
function HeroBlock({ doorT }: { doorT: number }) {
  return (
    <div
      className="absolute left-1/2 top-[60px] w-full max-w-[820px] -translate-x-1/2 text-center transition-opacity duration-300"
      style={{ opacity: 1 - doorT, pointerEvents: doorT > 0.3 ? "none" : "auto" }}
    >
      <span className="orb mx-auto mb-5 block h-8 w-8" aria-hidden />
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        The first AI-native design editor
      </p>
      <h1 className="font-display text-[clamp(38px,4.2vw,58px)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
        Design should not be prompted.
        <br />
        <span className="relative mt-1.5 inline-block">
          <span className="relative z-10 px-2">It should be drawn.</span>
          <span
            className="absolute inset-0 rounded-[2px] border border-accent-line"
            aria-hidden
          />
          <Handles />
          <span className="absolute -bottom-5 right-0 font-mono text-[10px] tracking-[0.08em] text-accent-text">
            412 × 74 · generated
          </span>
        </span>
      </h1>
      <p className="mx-auto mt-7 max-w-[54ch] text-[15px] leading-relaxed text-ink-soft">
        An editor where you draw a box, type what belongs inside it, and a
        real element appears — on your brand, editable to the last pixel,
        never an image.
      </p>
      <div className="mt-5 flex items-center justify-center gap-4">
        <Link
          href="/new"
          className="rounded-md bg-accent px-6 py-3 text-[14.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Open the editor
        </Link>
        <span className="font-mono text-[11px] text-faint">
          first 1M tokens free · no card
        </span>
      </div>
    </div>
  );
}

/* ─── the authoring cursor ───────────────────────────────────────────── */

/** Waypoints: [progress, x, y]. The orb-cursor authors the whole page —
 *  it deletes the prompt box, drags every marquee open (the rectangles
 *  follow it), sits at the typing spot, drags the KPI card, sweeps the
 *  deck rail, and draws the final door marquee. */
const PATH: [number, number, number][] = [
  [0.015, 566, BAND + 160],
  [0.035, 700, BAND + 78],
  [0.075, 700, BAND + 78],
  [0.105, SLOTS.kpi.x, SLOTS.kpi.y],
  [0.145, SLOTS.kpi.x + SLOTS.kpi.w, SLOTS.kpi.y + SLOTS.kpi.h],
  [0.155, SLOTS.kpi.x + 18, SLOTS.kpi.y + 66],
  [0.19, SLOTS.kpi.x + 18, SLOTS.kpi.y + 66],
  [0.225, SLOTS.title.x, SLOTS.title.y],
  [0.26, SLOTS.title.x + SLOTS.title.w, SLOTS.title.y + SLOTS.title.h],
  [0.27, SLOTS.title.x + 18, SLOTS.title.y + 70],
  [0.3, SLOTS.title.x + 18, SLOTS.title.y + 70],
  [0.325, SLOTS.chart.x, SLOTS.chart.y],
  [0.36, SLOTS.chart.x + SLOTS.chart.w, SLOTS.chart.y + SLOTS.chart.h],
  [0.37, SLOTS.chart.x + 18, SLOTS.chart.y + 66],
  [0.4, SLOTS.chart.x + 18, SLOTS.chart.y + 66],
  [0.48, SLOTS.kpi.x + 190, SLOTS.kpi.y + 120],
  [0.5, SLOTS.kpi.x + 190, SLOTS.kpi.y + 120],
  [0.56, SLOTS.kpi.x + 234, SLOTS.kpi.y + 120],
  [0.6, SLOTS.kpi.x + 130, SLOTS.kpi.y + 172],
  [0.66, 220, BAND + 60],
  [0.8, 950, BAND + 60],
  [0.86, 566, 330],
  [0.9, 400, 372],
  [0.94, 780, 500],
];

function Cursor({ p }: { p: number }) {
  if (p < 0.015 || p > 0.955) return null;
  let x = PATH[0][1];
  let y = PATH[0][2];
  for (let i = 0; i < PATH.length - 1; i++) {
    const [pa, xa, ya] = PATH[i];
    const [pb, xb, yb] = PATH[i + 1];
    if (p >= pa && p <= pb) {
      const t = seg(p, pa, pb);
      // ease-in-out per leg so travel reads as intent, not interpolation
      const e = ease(t);
      x = lerp(xa, xb, e);
      y = lerp(ya, yb, e);
      break;
    }
    if (p > pb) {
      x = xb;
      y = yb;
    }
  }
  const fade = p > 0.94 ? 1 - seg(p, 0.94, 0.955) : 1;
  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{ left: x - 9, top: y - 9, opacity: fade }}
      aria-hidden
    >
      <span className="orb block h-[18px] w-[18px]" />
      <span className="absolute -inset-1.5 rounded-full border border-accent-line opacity-40" />
    </div>
  );
}

/* ─── beats ──────────────────────────────────────────────────────────── */

function Stage({ p }: { p: number }) {
  // Pointer-inert: the visitor's marquee must be able to start on any empty
  // canvas the scripted beats aren't using. Interactive bits (the door CTA)
  // re-enable pointers for themselves.
  return (
    <div className="pointer-events-none absolute inset-0">
      <Funeral p={p} />
      <DrawBeat p={p} />
      <DeckBeat p={p} />
      <DoorBeat p={p} />
    </div>
  );
}

/** Beat 00 — the prompt-box funeral. The cursor arrives, selects, deletes. */
function Funeral({ p }: { p: number }) {
  const t = seg(p, T.funeral[0], T.funeral[1]);
  if (p > T.funeral[1] + 0.04) return null;
  const selected = t > 0.35;
  const dissolving = t > 0.75;
  return (
    <div
      className="absolute left-1/2 w-[440px] -translate-x-1/2 transition-all duration-500"
      style={{
        top: BAND + 52,
        opacity: dissolving ? 0 : 1,
        transform: `translateX(-50%) scale(${dissolving ? 0.92 : 1})`,
        filter: dissolving ? "blur(6px)" : "none",
      }}
    >
      <div
        className={`relative rounded-lg border bg-surface px-5 py-4 shadow-sm ${
          selected ? "border-accent-line" : "border-hairline-strong"
        }`}
      >
        {selected && <Handles />}
        <p className="text-[15px] text-faint">Describe your deck…</p>
        <span className="absolute bottom-3 right-3 inline-block h-7 w-7 rounded-md bg-surface-3" />
      </div>
      <p
        className="mt-3 text-center font-mono text-[11px] tracking-[0.08em] text-muted transition-opacity duration-300"
        style={{ opacity: selected ? 1 : 0 }}
      >
        prompt — legacy input · {dissolving ? "deleted" : "selected"}
      </p>
    </div>
  );
}

/** A marquee the CURSOR drags open; then the intent types INSIDE it; then
 *  the content assembles. drawT is synced to the cursor's drag leg. */
function Marquee({
  slot,
  drawT,
  typeT,
  buildT,
  intent,
  children,
}: {
  slot: { x: number; y: number; w: number; h: number };
  drawT: number;
  typeT: number;
  buildT: number;
  intent: string;
  children: React.ReactNode;
}) {
  if (drawT <= 0) return null;
  const typing = drawT >= 1 && buildT < 0.12;
  return (
    <div
      className="absolute"
      style={{ left: slot.x, top: slot.y, width: slot.w, height: slot.h }}
    >
      <div
        className="absolute left-0 top-0 rounded-[4px] border-[1.5px] border-dashed border-accent-line bg-accent-soft/30 transition-opacity duration-300"
        style={{
          width: Math.max(20, ease(drawT) * slot.w),
          height: Math.max(20, ease(drawT) * slot.h),
          opacity: buildT >= 0.3 ? 0 : 1,
        }}
        aria-hidden
      />
      {typing && (
        <p className="absolute left-6 top-8 z-10 font-mono text-[13px] text-accent-text">
          {typed(intent, typeT)}
          {typeT < 1 && (
            <span className="ml-0.5 inline-block h-[14px] w-[1.5px] animate-pulse bg-accent-text align-middle" />
          )}
          {typeT >= 1 && (
            <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-ink">
              ⏎ generate
            </span>
          )}
        </p>
      )}
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{ opacity: buildT > 0 ? 1 : 0 }}
      >
        {children}
      </div>
    </div>
  );
}

/** The three artifacts — each ASSEMBLES in stages under buildT. */

function KpiTile({
  b,
  dx,
  grow,
  caret,
  selected,
}: {
  b: number;
  dx: number;
  grow: number;
  caret: string | null;
  selected: boolean;
}) {
  if (b <= 0) return null;
  const frame = seg(b, 0, 0.15);
  const eyebrow = typed("PIPELINE", seg(b, 0.08, 0.22));
  const num = (3.2 * seg(b, 0.2, 0.5)).toFixed(1);
  const sparkT = seg(b, 0.5, 0.85);
  const chip = seg(b, 0.85, 1);
  const spark = [12, 16, 14, 20, 24, 22, 30, 34];
  const max = Math.max(...spark);
  const pts = spark
    .map((v, i) => `${(i / (spark.length - 1)) * 96 + 2},${40 - (v / max) * 34}`)
    .join(" ");
  return (
    <div
      className="relative transition-transform duration-500"
      style={{ transform: `translateX(${dx}px)` }}
    >
      {selected && (
        <div className="absolute -inset-px z-10 rounded-lg border border-accent-line" aria-hidden>
          <Handles />
        </div>
      )}
      <div
        className="relative h-[248px] rounded-lg border border-hairline bg-surface p-6 shadow-[0_20px_50px_-28px_rgba(18,26,43,0.4)] transition-all duration-500"
        style={{
          width: 384 + grow,
          opacity: frame,
          transform: `translateY(${(1 - frame) * 10}px)`,
        }}
      >
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
            {eyebrow}
            {eyebrow.length > 0 && eyebrow.length < 8 && (
              <span className="ml-0.5 inline-block h-[11px] w-[1.5px] animate-pulse bg-muted align-middle" />
            )}
          </p>
          <span
            className="rounded-full bg-accent-soft px-2.5 py-0.5 font-mono text-[10.5px] text-accent-text transition-all duration-300"
            style={{ opacity: chip, transform: `scale(${0.8 + chip * 0.2})` }}
          >
            +18% QoQ
          </span>
        </div>
        <p className="mt-3 font-display text-[68px] font-bold leading-none tracking-tight text-accent-text tabular-nums">
          {num}×
        </p>
        <p
          className="mt-2 text-[13.5px] text-ink-soft"
          style={{ opacity: seg(b, 0.45, 0.6) }}
        >
          {caret !== null ? caret : "faster close"}
          {caret !== null && caret.length < 20 && (
            <span className="ml-0.5 inline-block h-[13px] w-[1.5px] animate-pulse bg-ink align-middle" />
          )}
        </p>
        <svg viewBox="0 0 100 42" className="mt-4 h-11 w-full overflow-visible" aria-hidden>
          <polyline
            points={pts}
            fill="none"
            stroke="#047857"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset={1 - sparkT}
          />
          {sparkT >= 1 && <circle cx="98" cy="6" r="3" fill="#047857" />}
        </svg>
      </div>
    </div>
  );
}

function TitleBlock({ b }: { b: number }) {
  if (b <= 0) return null;
  const frame = seg(b, 0, 0.15);
  const words = ["Revenue,", "up", "and", "to", "the", "right."];
  const shown = Math.round(seg(b, 0.15, 0.6) * words.length);
  const rule = seg(b, 0.6, 0.8);
  const meta = seg(b, 0.8, 1);
  return (
    <div
      className="flex h-[212px] flex-col justify-center rounded-lg border border-hairline bg-surface p-6 shadow-[0_20px_50px_-28px_rgba(18,26,43,0.4)] transition-all duration-500"
      style={{ opacity: frame, transform: `translateY(${(1 - frame) * 10}px)` }}
    >
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
        {typed("Q3 REVIEW", seg(b, 0.05, 0.18))}
      </p>
      <p className="mt-2.5 min-h-[68px] font-display text-[27px] font-bold leading-[1.12] tracking-tight text-ink">
        {words.slice(0, shown).map((w, i) => (
          <span key={i} className="mr-[7px] inline-block">
            {w}
          </span>
        ))}
      </p>
      <div
        className="mt-3 h-[3px] rounded-full bg-accent"
        style={{ width: `${rule * 56}px`, opacity: rule > 0 ? 1 : 0 }}
      />
      <p className="mt-3 font-mono text-[10.5px] text-faint" style={{ opacity: meta }}>
        12 slides · exported to PDF
      </p>
    </div>
  );
}

function BarChart({ b, lift }: { b: number; lift: boolean }) {
  if (b <= 0) return null;
  const frame = seg(b, 0, 0.12);
  const data = [
    ["Q1", 42],
    ["Q2", 58],
    ["Q3", 49],
    ["Q4", 66],
    ["Q5", 78],
    ["Q6", 94],
  ] as const;
  return (
    <div
      className="flex h-[266px] flex-col rounded-lg border border-hairline bg-surface p-5 shadow-[0_20px_50px_-28px_rgba(18,26,43,0.4)] transition-all duration-500"
      style={{ opacity: frame, transform: `translateY(${(1 - frame) * 10}px)` }}
    >
      <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
        {typed("CLOSED-WON · SIX QUARTERS", seg(b, 0.05, 0.2))}
      </p>
      <div className="mt-3 flex flex-1 items-end gap-3 border-b border-hairline pb-0.5">
        {data.map(([q, v], i) => {
          const barT = seg(b, 0.18 + i * 0.11, 0.32 + i * 0.11);
          const last = i === data.length - 1;
          const target = lift && last ? Math.min(100, v * 1.1) : v;
          const h = target * barT;
          return (
            <div key={q} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              <span
                className="font-mono text-[10px] tabular-nums transition-opacity"
                style={{
                  color: last ? "#047857" : "#69707E",
                  opacity: barT > 0.6 ? 1 : 0,
                }}
              >
                {Math.round(target * Math.min(1, barT * 1.2))}
              </span>
              <div
                className="w-full rounded-[3px]"
                style={{
                  height: `${h * 0.66}%`,
                  backgroundColor: last ? "#047857" : "#E1E5EB",
                  boxShadow:
                    last && barT >= 1 ? "0 8px 24px -8px rgba(4,120,87,0.5)" : "none",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-3">
        {data.map(([q]) => (
          <span key={q} className="flex-1 text-center font-mono text-[9.5px] text-faint">
            {q}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Beats 01 + 02 — three cursor-drawn generations, then real manipulation. */
function DrawBeat({ p }: { p: number }) {
  const deck = seg(p, T.deck[0], T.deck[1]);
  const real = seg(p, T.real[0], T.real[1]);
  if (p >= T.deck[0] + 0.06) return null;

  const dx = real > 0.3 ? 44 : 0;
  const grow = real > 0.55 ? 40 : 0;
  const caret =
    real > 0.72 ? typed("Pipeline velocity, Q3", seg(real, 0.72, 0.95)) : null;

  return (
    <div
      className="transition-all duration-700 ease-in-out"
      style={{
        opacity: deck > 0 ? 0 : 1,
        transform: deck > 0 ? "scale(0.92)" : "scale(1)",
      }}
    >
      <Marquee
        slot={SLOTS.kpi}
        drawT={seg(p, W.kpi.drag[0], W.kpi.drag[1])}
        typeT={seg(p, W.kpi.type[0], W.kpi.type[1])}
        buildT={seg(p, W.kpi.build[0], W.kpi.build[1])}
        intent="a KPI tile — 3.2× faster close"
      >
        <KpiTile
          b={seg(p, W.kpi.build[0], W.kpi.build[1])}
          dx={dx}
          grow={grow}
          caret={caret}
          selected={real > 0.12}
        />
        {real > 0.25 && (
          <p className="absolute -bottom-6 left-0 font-mono text-[10px] tabular-nums text-faint">
            x {SLOTS.kpi.x + dx} · y {SLOTS.kpi.y} · w {SLOTS.kpi.w + grow}
          </p>
        )}
      </Marquee>

      <Marquee
        slot={SLOTS.title}
        drawT={seg(p, W.title.drag[0], W.title.drag[1])}
        typeT={seg(p, W.title.type[0], W.title.type[1])}
        buildT={seg(p, W.title.build[0], W.title.build[1])}
        intent="a title block — Q3 review"
      >
        <TitleBlock b={seg(p, W.title.build[0], W.title.build[1])} />
      </Marquee>

      <Marquee
        slot={SLOTS.chart}
        drawT={seg(p, W.chart.drag[0], W.chart.drag[1])}
        typeT={seg(p, W.chart.type[0], W.chart.type[1])}
        buildT={seg(p, W.chart.build[0], W.chart.build[1])}
        intent="a bar chart — six quarters"
      >
        <BarChart b={seg(p, W.chart.build[0], W.chart.build[1])} lift={real > 0.4} />
      </Marquee>
      <p
        className="absolute font-mono text-[10px] tracking-[0.1em] text-faint transition-opacity duration-300"
        style={{
          left: SLOTS.chart.x,
          top: SLOTS.chart.y + SLOTS.chart.h + 10,
          opacity: p > W.chart.build[1] ? 1 : 0,
        }}
      >
        sandbox
      </p>
    </div>
  );
}

/** Beat 03 — the deck rail + the real 4:37 receipt. */
function DeckBeat({ p }: { p: number }) {
  const t = seg(p, T.deck[0], T.deck[1]);
  if (t <= 0 || p > T.door[0] + 0.05) return null;
  const stamps = [
    "0:00 session start",
    "0:41 brand extracted",
    "1:58 outline approved",
    "4:37 deck exported",
  ];
  const full = stamps.join("  ·  ");
  const line = typed(full, seg(t, 0.15, 0.9));
  const mini = (i: number) => {
    if (i === 0)
      return (
        <>
          <div className="h-2 w-3/4 rounded-sm bg-ink/80" />
          <div className="mt-1 h-1 w-1/2 rounded-sm bg-ink/25" />
          <div className="mt-3 h-[3px] w-6 rounded-full bg-accent/70" />
        </>
      );
    if (i === 2)
      return (
        <>
          <div className="h-1.5 w-2/3 rounded-sm bg-ink/70" />
          <div className="mt-2 flex h-8 items-end gap-1 border-b border-hairline pb-0.5">
            {[40, 70, 55, 90].map((v, j) => (
              <div
                key={j}
                className="flex-1 rounded-[2px]"
                style={{
                  height: `${v}%`,
                  backgroundColor: j === 3 ? "rgba(4,120,87,0.65)" : "#E1E5EB",
                }}
              />
            ))}
          </div>
        </>
      );
    if (i === 4)
      return (
        <>
          <div className="mx-auto mt-2 h-2 w-2/3 rounded-sm bg-ink/75" />
          <div className="mx-auto mt-2 h-4 w-1/2 rounded-md bg-accent/80" />
        </>
      );
    return (
      <>
        <div className="h-1.5 w-3/4 rounded-sm bg-ink/70" />
        <div className="mt-1.5 h-1 w-full rounded-sm bg-ink/15" />
        <div className="mt-1 h-1 w-5/6 rounded-sm bg-ink/15" />
        <div className="mt-1 h-1 w-4/6 rounded-sm bg-ink/15" />
      </>
    );
  };
  return (
    <div
      className="absolute left-1/2 w-[820px] -translate-x-1/2 transition-opacity duration-500"
      style={{ top: BAND + 16, opacity: p > T.door[0] ? 0 : 1 }}
    >
      <div className="flex gap-4">
        {[0, 1, 2, 3, 4].map((i) => {
          const on = t > 0.12 + i * 0.14;
          return (
            <div
              key={i}
              className={`aspect-video flex-1 rounded-md border p-2.5 transition-all duration-500 ${
                on
                  ? "border-hairline bg-surface shadow-[0_12px_30px_-18px_rgba(18,26,43,0.4)]"
                  : "border-hairline bg-surface-2"
              }`}
              style={{ opacity: on ? 1 : 0.45 }}
            >
              {on ? mini(i) : <div className="h-full w-full" />}
            </div>
          );
        })}
      </div>
      <p className="mt-5 text-center font-mono text-[11px] tabular-nums text-ink-soft">
        {line}
        {line.length > 0 && line.length < full.length && (
          <span className="ml-0.5 inline-block h-[12px] w-[1.5px] animate-pulse bg-ink align-middle" />
        )}
      </p>
      <p
        className="mt-1 text-center font-mono text-[10px] tracking-[0.1em] text-faint transition-opacity"
        style={{ opacity: t > 0.9 ? 1 : 0 }}
      >
        real session — 5 slides, 2026-07-23
      </p>
    </div>
  );
}

/** Beat 04 — the meter receipt, then the cursor draws the door. */
function DoorBeat({ p }: { p: number }) {
  const t = seg(p, T.door[0], T.door[1]);
  if (t <= 0) return null;
  const rows: [string, string, boolean][] = [
    ["drag headline", "0", false],
    ["resize chart", "0", false],
    ["retype title", "0", false],
    ["edits ×214", "0 tokens", false],
    ["generate KPI tile", "1,214 tokens", false],
    ["new slide", "8,930 tokens", false],
    ["first 1,000,000 tokens", "free", true],
  ];
  const shown = Math.round(seg(t, 0.3, 0.55) * rows.length);
  const doorDraw = seg(t, 0.42, 0.66);
  return (
    <div className="absolute left-1/2 top-[10vh] w-[520px] -translate-x-1/2">
      <div className="rounded-lg border border-hairline bg-surface p-5 shadow-[0_16px_40px_-24px_rgba(18,26,43,0.35)]">
        {rows.slice(0, shown).map(([k, v, hot]) => (
          <div
            key={k}
            className="flex items-baseline justify-between border-b border-hairline py-1.5 font-mono text-[12px] last:border-0"
          >
            <span className={hot ? "text-accent-text" : "text-ink-soft"}>{k}</span>
            <span className={`tabular-nums ${hot ? "text-accent-text" : "text-muted"}`}>
              {v}
            </span>
          </div>
        ))}
      </div>

      <div className="relative mx-auto mt-10 h-[128px] w-[380px]">
        <div
          className="absolute left-0 top-0 rounded-[3px] border-[1.5px] border-dashed border-accent-line"
          style={{
            width: `${Math.max(6, doorDraw * 100)}%`,
            height: `${Math.max(14, doorDraw * 100)}%`,
            opacity: doorDraw <= 0 ? 0 : doorDraw >= 1 ? 0.55 : 1,
          }}
          aria-hidden
        />
        <div
          className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-3 transition-all duration-500"
          style={{
            opacity: t > 0.78 ? 1 : 0,
            transform: t > 0.78 ? "translateY(0)" : "translateY(10px)",
          }}
        >
          <Link
            href="/new"
            className="rounded-md bg-accent px-8 py-3.5 text-[15px] font-semibold text-accent-ink shadow-[0_20px_50px_-20px_rgba(0,194,138,0.7)] transition-all hover:brightness-110"
          >
            Open the editor
          </Link>
          <p className="font-mono text-[11px] text-muted">
            sign-in drops you onto a canvas, not a dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─── caption rail ───────────────────────────────────────────────────── */

function CaptionRail({ p }: { p: number }) {
  return (
    <div className="absolute bottom-8 left-6 h-12 w-[440px]">
      {CAPTIONS.map((c) => {
        const active = p >= c.from && p < c.to;
        return (
          <p
            key={c.n}
            className="absolute bottom-0 left-0 w-[440px] transition-all duration-300"
            style={{
              opacity: active ? 1 : 0,
              transform: active ? "translateY(0)" : "translateY(6px)",
            }}
          >
            <span className="mr-3 font-mono text-[11px] text-accent-text">{c.n}</span>
            <span className="text-[15px] font-medium text-ink">{c.text}</span>
          </p>
        );
      })}
    </div>
  );
}

/* ─── static composed story (mobile + reduced motion) ────────────────── */

function StaticStory() {
  return (
    <div className="relative mx-auto max-w-[680px] px-6 pb-16 pt-14 text-center">
      <span className="orb mx-auto mb-7 block h-10 w-10" aria-hidden />
      <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        The first AI-native design editor
      </p>
      <h1 className="font-display text-[clamp(34px,9vw,52px)] font-bold leading-[1.04] tracking-[-0.02em] text-ink">
        Design should not be prompted.{" "}
        <span className="relative inline-block">
          <span className="relative z-10 px-1.5">It should be drawn.</span>
          <span className="absolute inset-0 rounded-[2px] border border-accent-line" aria-hidden />
        </span>
      </h1>
      <p className="mx-auto mt-6 max-w-[48ch] text-[15.5px] leading-relaxed text-ink-soft">
        An editor where you draw a box, type what belongs inside it, and a
        real element appears — on your brand, editable to the last pixel,
        never an image.
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/new"
          className="rounded-md bg-accent px-6 py-3 text-[14.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Open the editor
        </Link>
        <span className="font-mono text-[11px] text-faint">
          first 1M tokens free · no card
        </span>
      </div>

      <SandboxPanel
        still={
          <>
            <p className="mb-2 font-mono text-[11px] text-accent-text">
              a KPI tile — 3.2× faster close
            </p>
            <div className="rounded-md border-[1.5px] border-dashed border-accent-line p-3">
              <KpiTile b={1} dx={0} grow={-64} caret={null} selected={false} />
            </div>
          </>
        }
      />

      <div className="mx-auto mt-8 max-w-[420px] space-y-3 text-left">
        {CAPTIONS.slice(1).map((c) => (
          <p key={c.n} className="flex items-baseline gap-3">
            <span className="font-mono text-[11px] text-accent-text">{c.n}</span>
            <span className="text-[14.5px] font-medium text-ink">{c.text}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
