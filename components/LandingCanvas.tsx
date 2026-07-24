"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * The landing hero IS a Renderball canvas performing (DESIGN.md "Landing —
 * the canvas performs"). v2 layout (founder review 2026-07-24): the hero text
 * is CENTERED in the upper region and the performance runs in a dedicated
 * canvas band BELOW it — text and generations never overlap. The generated
 * artifacts are real designed elements (KPI tile with delta chip + sparkline,
 * bar chart with axis + value labels, a typographic title block), because
 * they are the proof of taste, not set dressing.
 *
 * All motion is a pure function of scroll progress (scrubs both ways). Demo
 * generations carry a mono `sandbox` label; the timeline stamps are the real
 * 4:37 flarebit build. Mobile + reduced-motion get the static composed story
 * (CSS-gated).
 */

const seg = (p: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (p - a) / (b - a)));

const typed = (text: string, t: number): string =>
  text.slice(0, Math.round(Math.max(0, Math.min(1, t)) * text.length));

const T = {
  funeral: [0.0, 0.12],
  draw: [0.12, 0.34],
  brand: [0.34, 0.52],
  real: [0.52, 0.68],
  deck: [0.68, 0.85],
  door: [0.85, 1.0],
} as const;

const CAPTIONS = [
  { n: "00", text: "The category ships a text box. We don't.", from: 0.0, to: 0.12 },
  { n: "01", text: "Draw a box. Say what lives in it. It exists.", from: 0.12, to: 0.34 },
  { n: "02", text: "Paste a URL. It reads the brand like a designer.", from: 0.34, to: 0.52 },
  { n: "03", text: "Real elements. Not a screenshot of a design.", from: 0.52, to: 0.68 },
  { n: "04", text: "A full deck from one URL. Watched, not promised.", from: 0.68, to: 0.85 },
  { n: "05", text: "Editing is free. You only pay when it creates.", from: 0.85, to: 1.0 },
] as const;

/** The performance band's top edge (px from stage top) — hero text lives
 *  above this line, generations below it. The no-overlap contract. */
const BAND = 500;

export function LandingCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);
  const [clock, setClock] = useState(0);
  const started = useRef(false);

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
        style={{ height: "560vh" }}
        aria-hidden
      >
        <div className="sticky top-0 h-screen overflow-hidden">
          <DotGrid />
          <div className="relative mx-auto h-full max-w-[1180px] px-6">
            <HeroBlock doorT={seg(p, T.door[0], 0.95)} />
            <Stage p={p} />
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

/* ─── scenery ────────────────────────────────────────────────────────── */

function DotGrid() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-[0.5]"
      style={{
        backgroundImage:
          "radial-gradient(circle, rgba(18,26,43,0.10) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
      aria-hidden
    />
  );
}

/** Centered hero (founder call: text centered, generations never touch it). */
function HeroBlock({ doorT }: { doorT: number }) {
  return (
    <div
      className="absolute left-1/2 top-[60px] w-full max-w-[820px] -translate-x-1/2 text-center transition-opacity duration-300"
      style={{ opacity: 1 - doorT * 0.92 }}
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
      <p className="mx-auto mt-7 max-w-[52ch] text-[15px] leading-relaxed text-ink-soft">
        Paste a URL and a sentence; get a fully editable, on-brand deck in
        about five minutes. Then draw a box anywhere and say what belongs
        inside it. It appears. Real elements — never images.
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

function Handles() {
  const pos = [
    "-left-1 -top-1",
    "left-1/2 -top-1 -translate-x-1/2",
    "-right-1 -top-1",
    "-left-1 top-1/2 -translate-y-1/2",
    "-right-1 top-1/2 -translate-y-1/2",
    "-left-1 -bottom-1",
    "left-1/2 -bottom-1 -translate-x-1/2",
    "-right-1 -bottom-1",
  ];
  return (
    <>
      {pos.map((c) => (
        <span
          key={c}
          className={`absolute ${c} z-20 h-2 w-2 rounded-[2px] border border-accent bg-surface`}
          aria-hidden
        />
      ))}
    </>
  );
}

/* ─── beats ──────────────────────────────────────────────────────────── */

function Stage({ p }: { p: number }) {
  return (
    <div className="absolute inset-0">
      <Funeral p={p} />
      <DrawBeat p={p} />
      <BrandBeat p={p} />
      <DeckBeat p={p} />
      <DoorBeat p={p} />
    </div>
  );
}

/** Beat 00 — the prompt-box funeral, centered in the performance band. */
function Funeral({ p }: { p: number }) {
  const t = seg(p, T.funeral[0], T.funeral[1]);
  if (p > T.funeral[1] + 0.04) return null;
  const selected = t > 0.35;
  const dissolving = t > 0.7;
  return (
    <div
      className="absolute left-1/2 w-[440px] -translate-x-1/2 transition-all duration-500"
      style={{
        top: BAND + 60,
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

function Marquee({
  x,
  y,
  w,
  h,
  drawT,
  children,
  contentT,
  label,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  drawT: number;
  contentT: number;
  label?: string;
  children: React.ReactNode;
}) {
  if (drawT <= 0) return null;
  return (
    <div className="absolute" style={{ left: x, top: y, width: w, height: h }}>
      <div
        className="absolute left-0 top-0 rounded-[3px] border border-dashed border-accent-line transition-opacity duration-300"
        style={{
          width: Math.max(18, drawT * w),
          height: Math.max(18, drawT * h),
          opacity: contentT >= 1 ? 0 : 1,
        }}
        aria-hidden
      />
      {label && contentT < 1 && drawT >= 1 && (
        <p className="absolute -top-6 left-0 whitespace-nowrap font-mono text-[11px] text-accent-text">
          {label}
        </p>
      )}
      <div
        className="absolute inset-0 transition-all duration-500 ease-out"
        style={{
          opacity: contentT > 0.15 ? 1 : 0,
          transform: contentT > 0.15 ? "translateY(0)" : "translateY(8px)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The three generated artifacts — designed to be worth generating. */

function KpiTile({ demo, wide, caret }: { demo: string; wide: number; caret: string | null }) {
  const spark = [12, 16, 14, 20, 24, 22, 30, 34];
  const max = Math.max(...spark);
  const pts = spark
    .map((v, i) => `${(i / (spark.length - 1)) * 96 + 2},${34 - (v / max) * 30}`)
    .join(" ");
  return (
    <div
      className="relative h-full rounded-lg border border-hairline bg-surface p-5 shadow-[0_16px_40px_-24px_rgba(18,26,43,0.35)] transition-all duration-500"
      style={{ width: 320 + wide }}
    >
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          Pipeline
        </p>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px]"
          style={{ color: demo, backgroundColor: "rgba(18,26,43,0.05)" }}
        >
          +18% QoQ
        </span>
      </div>
      <p
        className="mt-2 font-display text-[52px] font-bold leading-none tracking-tight transition-colors duration-500"
        style={{ color: demo }}
      >
        3.2×
      </p>
      <p className="mt-1.5 text-[13px] text-ink-soft">
        {caret !== null ? caret : "faster close"}
        {caret !== null && caret.length < 20 && (
          <span className="ml-0.5 inline-block h-[13px] w-[1.5px] animate-pulse bg-ink align-middle" />
        )}
      </p>
      <svg viewBox="0 0 100 36" className="mt-3 h-9 w-full" aria-hidden>
        <polyline
          points={pts}
          fill="none"
          stroke={demo}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function BarChart({ demo, lift }: { demo: string; lift: boolean }) {
  const data = [
    ["Q1", 42],
    ["Q2", 58],
    ["Q3", 49],
    ["Q4", 66],
    ["Q5", 78],
    ["Q6", 94],
  ] as const;
  return (
    <div className="flex h-full flex-col rounded-lg border border-hairline bg-surface p-4 shadow-[0_16px_40px_-24px_rgba(18,26,43,0.35)]">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        Closed-won · six quarters
      </p>
      <div className="mt-3 flex flex-1 items-end gap-2.5 border-b border-hairline pb-0.5">
        {data.map(([q, v], i) => {
          const last = i === data.length - 1;
          const h = lift && last ? Math.min(100, v * 1.1) : v;
          return (
            <div key={q} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <span
                className="font-mono text-[9px] tabular-nums"
                style={{ color: last ? demo : "var(--muted, #69707E)" }}
              >
                {Math.round(h)}
              </span>
              <div
                className="w-full rounded-[3px] transition-all duration-700"
                style={{
                  height: `${h * 0.72}%`,
                  backgroundColor: last ? demo : "#E1E5EB",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-2.5">
        {data.map(([q]) => (
          <span key={q} className="flex-1 text-center font-mono text-[9px] text-faint">
            {q}
          </span>
        ))}
      </div>
    </div>
  );
}

function TitleBlock({ demo }: { demo: string }) {
  return (
    <div className="flex h-full flex-col justify-center rounded-lg border border-hairline bg-surface p-5 shadow-[0_16px_40px_-24px_rgba(18,26,43,0.35)]">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        Q3 review
      </p>
      <p className="mt-2 font-display text-[24px] font-bold leading-[1.1] tracking-tight text-ink">
        Revenue, up and
        <br />
        to the right.
      </p>
      <div className="mt-3 h-[3px] w-12 rounded-full transition-colors duration-500" style={{ backgroundColor: demo }} />
      <p className="mt-3 font-mono text-[10px] text-faint">12 slides · exported to PDF</p>
    </div>
  );
}

/** Beats 01–03 — three staggered generations, then brand retint, then the
 *  real-elements manipulation. All inside the performance band. */
function DrawBeat({ p }: { p: number }) {
  const draw = seg(p, T.draw[0], T.draw[1]);
  const brand = seg(p, T.brand[0], T.brand[1]);
  const real = seg(p, T.real[0], T.real[1]);
  const deck = seg(p, T.deck[0], T.deck[1]);
  if (p >= T.deck[0] + 0.06) return null;

  const demo = brand > 0.55 ? "#8A5A33" : "#047857";
  const dx = real > 0.25 ? 40 : 0;
  const grow = real > 0.5 ? 36 : 0;
  const caret =
    real > 0.6 ? typed("Pipeline velocity, Q3", seg(real, 0.6, 0.9)) : null;

  return (
    <div
      className="transition-all duration-700 ease-in-out"
      style={{
        opacity: deck > 0 ? 0 : 1,
        transform: deck > 0 ? "scale(0.9)" : "scale(1)",
      }}
    >
      {/* 1 — KPI tile, left slot */}
      <Marquee
        x={92}
        y={BAND + 24}
        w={320}
        h={210}
        drawT={seg(draw, 0.02, 0.24)}
        contentT={seg(draw, 0.26, 0.4)}
        label={typed("a KPI tile — 3.2× faster close", seg(draw, 0.2, 0.28))}
      >
        <div
          className="relative h-full transition-transform duration-500"
          style={{ transform: `translateX(${dx}px)` }}
        >
          {real > 0.1 && (
            <div className="absolute -inset-px z-10 rounded-lg border border-accent-line" aria-hidden>
              <Handles />
            </div>
          )}
          <KpiTile demo={demo} wide={grow} caret={caret} />
          {real > 0.2 && (
            <p className="absolute -bottom-6 left-0 font-mono text-[10px] tabular-nums text-faint">
              x {92 + dx} · y {BAND + 24} · w {320 + grow}
            </p>
          )}
        </div>
      </Marquee>

      {/* 2 — title block, center slot */}
      <Marquee
        x={470}
        y={BAND + 44}
        w={250}
        h={180}
        drawT={seg(draw, 0.34, 0.52)}
        contentT={seg(draw, 0.54, 0.66)}
        label={typed("a title block — Q3 review", seg(draw, 0.48, 0.56))}
      >
        <TitleBlock demo={demo} />
      </Marquee>

      {/* 3 — bar chart, right slot */}
      <Marquee
        x={778}
        y={BAND + 12}
        w={310}
        h={240}
        drawT={seg(draw, 0.6, 0.8)}
        contentT={seg(draw, 0.82, 0.95)}
        label={typed("a bar chart — six quarters", seg(draw, 0.74, 0.82))}
      >
        <BarChart demo={demo} lift={real > 0.35} />
      </Marquee>
      <p
        className="absolute font-mono text-[10px] tracking-[0.1em] text-faint transition-opacity duration-300"
        style={{ left: 778, top: BAND + 262, opacity: draw >= 1 ? 1 : 0 }}
      >
        sandbox
      </p>
    </div>
  );
}

/** Beat 02 — the URL chip + extraction, centered above the band. */
function BrandBeat({ p }: { p: number }) {
  const t = seg(p, T.brand[0], T.brand[1]);
  if (t <= 0 || p >= T.deck[0] + 0.02) return null;
  const swatches = ["#8A5A33", "#E8D9C3", "#2A1E14"];
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 transition-all duration-500"
      style={{
        top: BAND + 272,
        opacity: t > 0.05 && p < T.real[1] ? 1 : 0,
        transform: `translateX(-50%) translateY(${t > 0.05 ? 0 : -10}px)`,
      }}
    >
      <div className="flex items-center gap-2.5">
        <span className="rounded-full border border-hairline-strong bg-surface px-3.5 py-1.5 font-mono text-[12px] text-ink">
          loop.coffee
        </span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-opacity duration-300"
          style={{ opacity: t > 0.3 ? 1 : 0 }}
        >
          brand extracted →
        </span>
        {swatches.map((c, i) => (
          <span
            key={c}
            className="inline-block h-5 w-5 rounded-[4px] border border-hairline transition-all duration-500"
            style={{
              background: c,
              opacity: t > 0.35 + i * 0.08 ? 1 : 0,
              transform: t > 0.35 + i * 0.08 ? "translateX(0)" : "translateX(-8px)",
            }}
          />
        ))}
        <span
          className="rounded-[4px] border border-hairline bg-surface px-2 py-0.5 font-mono text-[10px] text-ink-soft transition-opacity duration-500"
          style={{ opacity: t > 0.62 ? 1 : 0 }}
        >
          Fraunces · 700
        </span>
      </div>
    </div>
  );
}

/** Beat 04 — the deck rail + the real 4:37 receipt, centered in the band. */
function DeckBeat({ p }: { p: number }) {
  const t = seg(p, T.deck[0], T.deck[1]);
  if (t <= 0 || p > T.door[0] + 0.05) return null;
  const stamps = [
    "0:00 url pasted",
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
      className="absolute left-1/2 w-[760px] -translate-x-1/2 transition-opacity duration-500"
      style={{ top: BAND + 20, opacity: p > T.door[0] ? 0 : 1 }}
    >
      <div className="flex gap-3.5">
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
        real session — flarebit.ai, 5 slides, 2026-07-23
      </p>
    </div>
  );
}

/** Beat 05 — the meter ledger + the final marquee that generates the CTA. */
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
  const shown = Math.round(seg(t, 0.05, 0.42) * rows.length);
  return (
    <div className="absolute left-1/2 top-[10vh] w-[520px] -translate-x-1/2">
      <div className="rounded-lg border border-hairline bg-surface/90 p-5 shadow-sm backdrop-blur-sm">
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
          className="absolute left-0 top-0 rounded-[3px] border border-dashed border-accent-line"
          style={{
            width: `${Math.max(6, seg(t, 0.45, 0.64) * 100)}%`,
            height: `${Math.max(14, seg(t, 0.45, 0.64) * 100)}%`,
            opacity: seg(t, 0.45, 0.64) >= 1 ? 0.55 : 1,
          }}
          aria-hidden
        />
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 transition-all duration-500"
          style={{
            opacity: t > 0.66 ? 1 : 0,
            transform: t > 0.66 ? "translateY(0)" : "translateY(10px)",
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
        Paste a URL and a sentence; get a fully editable, on-brand deck in
        about five minutes. Then draw a box anywhere and say what belongs
        inside it. It appears. Real elements — never images.
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

      <div className="relative mx-auto mt-14 max-w-[380px] overflow-hidden rounded-lg border border-hairline bg-canvas p-5 text-left">
        <div className="relative rounded-md border border-dashed border-accent-line p-3">
          <KpiTile demo="#047857" wide={0} caret={null} />
          <p className="absolute -top-2.5 left-3 bg-canvas px-1.5 font-mono text-[10px] text-accent-text">
            a KPI tile — 3.2× faster close
          </p>
        </div>
        <p className="mt-3 font-mono text-[10px] tracking-[0.1em] text-faint">
          drawn as a box · generated as a real element · sandbox
        </p>
      </div>

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
