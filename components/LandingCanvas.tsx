"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * The landing hero IS a Renderball canvas performing (DESIGN.md "Landing —
 * the canvas performs", locked 2026-07-24).
 *
 * A tall scroll region drives a sticky stage through six beats: the
 * prompt-box funeral, marquee-draw → element, brand-from-URL retint, real
 * (not raster) manipulation, the deck rail with the real 4:37 receipt, and
 * the final marquee that generates the CTA. Everything that "generates" is
 * REAL DOM appearing with system easings — never video (the medium is the
 * proof). All motion is a pure function of scroll progress, so it scrubs
 * both directions and needs no timers except the session clock.
 *
 * Honesty rules: demo generations are labeled `sandbox`; the timeline
 * stamps are the real flarebit build (4:37); token figures are real ledger
 * magnitudes. prefers-reduced-motion and <lg viewports get the static
 * composed story (CSS-gated — no hydration flash).
 */

/** Sub-progress: 0 before `a`, 1 after `b`, linear between. */
const seg = (p: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (p - a) / (b - a)));

/** Scroll-scrubbed typing — deterministic, reversible. */
const typed = (text: string, t: number): string =>
  text.slice(0, Math.round(Math.max(0, Math.min(1, t)) * text.length));

/** Beat windows on the master progress. */
const T = {
  funeral: [0.0, 0.12],
  draw: [0.12, 0.32],
  brand: [0.32, 0.5],
  real: [0.5, 0.68],
  deck: [0.68, 0.85],
  door: [0.85, 1.0],
} as const;

const CAPTIONS = [
  { n: "00", text: "The category ships a text box. We don't.", from: 0.0, to: 0.12 },
  { n: "01", text: "Draw a box. Say what lives in it. It exists.", from: 0.12, to: 0.32 },
  { n: "02", text: "Paste a URL. It reads the brand like a designer.", from: 0.32, to: 0.5 },
  { n: "03", text: "Real elements. Not a screenshot of a design.", from: 0.5, to: 0.68 },
  { n: "04", text: "A full deck from one URL. Watched, not promised.", from: 0.68, to: 0.85 },
  { n: "05", text: "Editing is free. You only pay when it creates.", from: 0.85, to: 1.0 },
] as const;

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

  // Session clock — real time, starts on first scroll (mono, bottom-right).
  useEffect(() => {
    const t = setInterval(() => {
      if (started.current) setClock((c) => c + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      {/* ── The performance (lg + motion-safe only) ─────────────────────── */}
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

      {/* ── Static composed story (mobile + reduced-motion) ─────────────── */}
      <div className="relative lg:motion-safe:hidden">
        <DotGrid />
        <StaticStory />
      </div>
    </>
  );
}

/* ─── shared scenery ─────────────────────────────────────────────────── */

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

/** The H1 block — always composed (SSR/SEO); "drawn." wears a live selection
 *  frame + handles + a mono dimension tag, presenting as a generated element. */
function HeroBlock({ doorT }: { doorT: number }) {
  return (
    <div
      className="absolute left-6 top-[7vh] max-w-[560px] transition-opacity duration-300"
      style={{ opacity: 1 - doorT * 0.92 }}
    >
      <span className="orb mb-7 block h-10 w-10" aria-hidden />
      <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        The first AI-native design editor
      </p>
      <h1 className="font-display text-[clamp(40px,4.6vw,64px)] font-bold leading-[1.02] tracking-[-0.02em] text-ink">
        Design should not be prompted.
        <br />
        <span className="relative mt-2 inline-block">
          <span className="relative z-10 px-2">It should be drawn.</span>
          <span
            className="absolute inset-0 rounded-[2px] border border-accent-line"
            aria-hidden
          />
          <Handles />
          <span className="absolute -bottom-6 right-0 font-mono text-[10px] tracking-[0.08em] text-accent-text">
            412 × 74 · generated
          </span>
        </span>
      </h1>
      <p className="mt-9 max-w-[46ch] text-[16px] leading-relaxed text-ink-soft">
        Paste a URL and a sentence; get a fully editable, on-brand deck in
        about five minutes. Then draw a box anywhere and say what belongs
        inside it. It appears. Real elements — never images.
      </p>
      <div className="mt-7 flex items-center gap-4">
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

/* ─── the six beats ──────────────────────────────────────────────────── */

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

/** Beat 00 — the prompt-box funeral. */
function Funeral({ p }: { p: number }) {
  const t = seg(p, T.funeral[0], T.funeral[1]);
  if (p > T.funeral[1] + 0.04) return null;
  const selected = t > 0.35;
  const dissolving = t > 0.7;
  return (
    <div
      className="absolute left-[52%] top-[24vh] w-[420px] transition-all duration-500"
      style={{
        opacity: dissolving ? 0 : 1,
        transform: dissolving ? "scale(0.92)" : "scale(1)",
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
        className="mt-3 font-mono text-[11px] tracking-[0.08em] text-muted transition-opacity duration-300"
        style={{ opacity: selected ? 1 : 0 }}
      >
        prompt — legacy input · {dissolving ? "deleted" : "selected"}
      </p>
    </div>
  );
}

/** A drawn marquee: dashed accent rectangle that grows open, then hosts its
 *  generated content at exactly those bounds. */
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

/** Beats 01 + 03 share the two demo elements (the tile persists to be
 *  manipulated in REAL, then re-tinted by BRAND — order: draw → brand → real). */
function DrawBeat({ p }: { p: number }) {
  const draw = seg(p, T.draw[0], T.draw[1]);
  const brand = seg(p, T.brand[0], T.brand[1]);
  const real = seg(p, T.real[0], T.real[1]);
  const deck = seg(p, T.deck[0], T.deck[1]);
  if (p >= T.deck[0] + 0.06) return null;

  // BRAND retint: emerald-text demo content → warm demo-brand ink. Literal
  // hexes on purpose: this colors DEMO CONTENT inside the performance, never
  // chrome, and the brand-swap beat needs a non-system hue to be legible.
  const demo = brand > 0.55 ? "#8A5A33" : "#047857";
  // REAL: the tile drags right + grows; caption gets retyped.
  const dx = real > 0.25 ? 46 : 0;
  const grow = real > 0.5 ? 42 : 0;
  const caption =
    real > 0.6
      ? typed("Pipeline velocity, Q3", seg(real, 0.6, 0.9))
      : "3.2× faster close";

  const group = (
    <div
      className="transition-all duration-700 ease-in-out"
      style={{
        opacity: deck > 0 ? 0 : 1,
        transform: deck > 0 ? "scale(0.9)" : "scale(1)",
      }}
    >
      {/* KPI tile */}
      <Marquee
        x={560}
        y={140}
        w={300}
        h={170}
        drawT={seg(draw, 0.05, 0.35)}
        contentT={seg(draw, 0.4, 0.7)}
        label={typed("a KPI tile — 3.2× faster close", seg(draw, 0.32, 0.42))}
      >
        <div
          className={`relative h-full rounded-lg border bg-surface p-5 shadow-sm transition-all duration-500 ${
            real > 0.1 ? "border-accent-line" : "border-hairline"
          }`}
          style={{
            transform: `translateX(${dx}px)`,
            width: 300 + grow,
          }}
        >
          {real > 0.1 && <Handles />}
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            Pipeline
          </p>
          <p
            className="mt-2 font-display text-[54px] font-bold leading-none tracking-tight transition-colors duration-500"
            style={{ color: demo }}
          >
            3.2×
          </p>
          <p className="mt-2 text-[13px] text-ink-soft">
            {caption}
            {real > 0.6 && real < 0.95 && (
              <span className="ml-0.5 inline-block h-[14px] w-[1.5px] animate-pulse bg-ink align-middle" />
            )}
          </p>
          {real > 0.2 && (
            <p className="absolute -bottom-6 left-0 font-mono text-[10px] tabular-nums text-faint">
              x {96 + dx} · y 128 · w {300 + grow}
            </p>
          )}
        </div>
      </Marquee>

      {/* Mini bar chart */}
      <Marquee
        x={905}
        y={210}
        w={230}
        h={190}
        drawT={seg(draw, 0.5, 0.75)}
        contentT={seg(draw, 0.78, 1)}
        label={typed("bar chart — last 6 quarters", seg(draw, 0.72, 0.8))}
      >
        <div className="flex h-full items-end gap-2 rounded-lg border border-hairline bg-surface p-4 shadow-sm">
          {[34, 48, 42, 61, 74, 92].map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm transition-all duration-700"
              style={{
                height: `${real > 0.35 ? Math.min(100, v * 1.12) : v}%`,
                backgroundColor: i === 5 ? demo : "#E1E5EB",
              }}
            />
          ))}
        </div>
      </Marquee>
      <p
        className="absolute left-[905px] top-[415px] font-mono text-[10px] tracking-[0.1em] text-faint transition-opacity duration-300"
        style={{ opacity: draw >= 1 ? 1 : 0 }}
      >
        sandbox
      </p>
    </div>
  );

  return group;
}

/** Beat 02 — brand-from-URL: the chip lands, swatches extract, content retints. */
function BrandBeat({ p }: { p: number }) {
  const t = seg(p, T.brand[0], T.brand[1]);
  if (t <= 0 || p >= T.deck[0] + 0.02) return null;
  const swatches = ["#8A5A33", "#E8D9C3", "#2A1E14"];
  return (
    <div
      className="absolute left-[560px] top-[104px] transition-all duration-500"
      style={{
        opacity: t > 0.05 && p < T.real[1] ? 1 : 0,
        transform: t > 0.05 ? "translateY(0)" : "translateY(-10px)",
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
          brand extracted
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        {swatches.map((c, i) => (
          <span
            key={c}
            className="inline-block h-5 w-5 rounded-[4px] border border-hairline transition-all duration-500"
            style={{
              background: c,
              opacity: t > 0.3 + i * 0.1 ? 1 : 0,
              transform: t > 0.3 + i * 0.1 ? "translateX(0)" : "translateX(-8px)",
            }}
          />
        ))}
        <span
          className="ml-1 rounded-[4px] border border-hairline bg-surface px-2 py-0.5 font-mono text-[10px] text-ink-soft transition-opacity duration-500"
          style={{ opacity: t > 0.65 ? 1 : 0 }}
        >
          Fraunces · 700
        </span>
      </div>
    </div>
  );
}

/** Beat 04 — the deck rail + the real 4:37 receipt. */
function DeckBeat({ p }: { p: number }) {
  const t = seg(p, T.deck[0], T.deck[1]);
  if (t <= 0 || p > T.door[0] + 0.05) return null;
  const stamps = [
    "0:00 url pasted",
    "0:41 brand extracted",
    "1:58 outline approved",
    "4:37 deck exported",
  ];
  const line = typed(stamps.join("  ·  "), seg(t, 0.15, 0.9));
  return (
    <div
      className="absolute left-[500px] top-[26vh] w-[620px] transition-opacity duration-500"
      style={{ opacity: p > T.door[0] ? 0 : 1 }}
    >
      <div className="flex gap-3">
        {[0, 1, 2, 3, 4].map((i) => {
          const on = t > 0.15 + i * 0.14;
          return (
            <div
              key={i}
              className={`aspect-video flex-1 rounded-md border p-2 transition-all duration-500 ${
                on ? "border-hairline bg-surface shadow-sm" : "border-hairline bg-surface-2"
              }`}
              style={{ opacity: on ? 1 : 0.45 }}
            >
              {on ? (
                <>
                  <div className="h-1.5 w-3/4 rounded-sm bg-ink/70" />
                  <div className="mt-1 h-1 w-1/2 rounded-sm bg-ink/25" />
                  {i === 2 ? (
                    <div className="mt-2 flex h-6 items-end gap-0.5">
                      {[40, 70, 55, 90].map((v, j) => (
                        <div
                          key={j}
                          className="flex-1 rounded-[1px] bg-accent/60"
                          style={{ height: `${v}%` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 h-6 rounded-sm bg-surface-3" />
                  )}
                </>
              ) : (
                <div className="h-full w-full" />
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 font-mono text-[11px] tabular-nums text-ink-soft">
        {line}
        {line.length > 0 && line.length < stamps.join("  ·  ").length && (
          <span className="ml-0.5 inline-block h-[12px] w-[1.5px] animate-pulse bg-ink align-middle" />
        )}
      </p>
      <p
        className="mt-1 font-mono text-[10px] tracking-[0.1em] text-faint transition-opacity"
        style={{ opacity: t > 0.9 ? 1 : 0 }}
      >
        real session — flarebit.ai, 5 slides, 2026-07-23
      </p>
    </div>
  );
}

/** Beat 05 — the meter ledger + the door: a final marquee generates the CTA. */
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
  const shown = Math.round(seg(t, 0.05, 0.5) * rows.length);
  return (
    <div className="absolute left-1/2 top-[16vh] w-[520px] -translate-x-1/2">
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
            width: `${Math.max(6, seg(t, 0.45, 0.66) * 100)}%`,
            height: `${Math.max(14, seg(t, 0.45, 0.66) * 100)}%`,
            opacity: seg(t, 0.45, 0.66) >= 1 ? 0.55 : 1,
          }}
          aria-hidden
        />
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 transition-all duration-500"
          style={{
            opacity: t > 0.68 ? 1 : 0,
            transform: t > 0.68 ? "translateY(0)" : "translateY(10px)",
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
    <div className="relative mx-auto max-w-[680px] px-6 pb-16 pt-14">
      <span className="orb mb-7 block h-10 w-10" aria-hidden />
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
      <p className="mt-6 max-w-[48ch] text-[15.5px] leading-relaxed text-ink-soft">
        Paste a URL and a sentence; get a fully editable, on-brand deck in
        about five minutes. Then draw a box anywhere and say what belongs
        inside it. It appears. Real elements — never images.
      </p>
      <div className="mt-7 flex flex-wrap items-center gap-4">
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

      {/* Composed final frame of the performance, as a still. */}
      <div className="relative mt-14 overflow-hidden rounded-lg border border-hairline bg-canvas p-5">
        <div className="relative rounded-md border border-dashed border-accent-line p-3">
          <div className="rounded-lg border border-hairline bg-surface p-4 shadow-sm">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
              Pipeline
            </p>
            <p className="mt-1 font-display text-[40px] font-bold leading-none tracking-tight text-accent-text">
              3.2×
            </p>
            <p className="mt-1.5 text-[12.5px] text-ink-soft">faster close</p>
          </div>
          <p className="absolute -top-2.5 left-3 bg-canvas px-1.5 font-mono text-[10px] text-accent-text">
            a KPI tile — 3.2× faster close
          </p>
        </div>
        <p className="mt-3 font-mono text-[10px] tracking-[0.1em] text-faint">
          drawn as a box · generated as a real element · sandbox
        </p>
      </div>

      <div className="mt-8 space-y-3">
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
