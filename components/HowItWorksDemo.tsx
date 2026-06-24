"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

/**
 * Animated product demo for the landing's "how it works" section.
 *
 * A looping, six-stage performance of the real Renderball flow, each stage a
 * realistic mini-UI: the user's brief typed in → brand auto-extracted → the
 * second-by-second script → the render → frame-by-frame QA → the finished
 * video playing. A persistent pipeline rail shows where we are. Built in
 * CSS/React (Renderball is a motion product, so its explainer is animated); a
 * recorded MP4 can drop in later. Honors prefers-reduced-motion (holds on the
 * finished video). Stages remount each cycle so entrance animations replay.
 */
const STEPS = [
  { key: "brief", label: "Brief", ms: 5400 },
  { key: "brand", label: "Brand", ms: 3800 },
  { key: "script", label: "Script", ms: 5800 },
  { key: "render", label: "Render", ms: 4800 },
  { key: "qa", label: "QA", ms: 3000 },
  { key: "ready", label: "Ready", ms: 4600 },
] as const;

export function HowItWorksDemo() {
  const [step, setStep] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (m.matches) {
      setReduced(true);
      setStep(STEPS.length - 1);
    }
  }, []);

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(
      () => setStep((s) => (s + 1) % STEPS.length),
      STEPS[step].ms,
    );
    return () => clearTimeout(t);
  }, [step, reduced]);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline-strong bg-surface shadow-[0_40px_100px_-50px_rgba(18,26,43,0.6)]">
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 border-b border-hairline bg-surface-2 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
        <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
        <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
        <div className="ml-3 flex flex-1 items-center justify-center">
          <span className="rounded-md bg-surface px-3 py-0.5 font-mono text-[11px] text-faint">
            renderball.com/new
          </span>
        </div>
      </div>

      <PipelineRail step={step} />

      {/* Stage — fixed height so the content stages fill the frame instead of
          floating in dead space (the Ready stage flexes to fill regardless). */}
      <div className="relative h-[400px] bg-canvas sm:h-[440px]">
        <div
          key={step}
          data-rb-anim
          className="absolute inset-0"
          style={{ animation: "rb-fade 0.45s ease-out both" }}
        >
          <Stage stepKey={STEPS[step].key} reduced={reduced} />
        </div>
      </div>
    </div>
  );
}

function PipelineRail({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-1 border-b border-hairline bg-surface px-4 py-2.5 sm:gap-2 sm:px-5">
      {STEPS.map((s, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div key={s.key} className="flex flex-1 items-center gap-1.5 sm:gap-2">
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold transition-colors duration-300",
                active
                  ? "bg-accent text-accent-ink"
                  : done
                    ? "bg-accent-soft text-accent-text"
                    : "bg-surface-3 text-faint",
              )}
            >
              {done ? "✓" : i + 1}
            </span>
            <span
              className={cn(
                "hidden font-mono text-[10px] uppercase tracking-[0.12em] transition-colors duration-300 sm:inline",
                active ? "text-ink" : done ? "text-muted" : "text-faint",
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="h-px flex-1 bg-hairline" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stage({ stepKey, reduced }: { stepKey: string; reduced: boolean }) {
  switch (stepKey) {
    case "brief":
      return <BriefStage reduced={reduced} />;
    case "brand":
      return <BrandStage />;
    case "script":
      return <ScriptStage />;
    case "render":
      return <RenderStage reduced={reduced} />;
    case "qa":
      return <QaStage />;
    default:
      return <ReadyStage />;
  }
}

// ── Stage 1 · Brief (the user's input) ───────────────────────────────
const BRIEF_TEXT =
  "A 45-second launch video for Renderball — show how a brief becomes a finished animated video, on-brand, end on “Start your subscription.”";

function BriefStage({ reduced }: { reduced: boolean }) {
  const [typed, setTyped] = useState(reduced ? BRIEF_TEXT.length : 0);
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(
      () => setTyped((n) => (n >= BRIEF_TEXT.length ? n : n + 1)),
      30,
    );
    return () => clearInterval(id);
  }, [reduced]);

  return (
    <div className="flex h-full flex-col justify-center gap-3 px-6 py-5 sm:px-10">
      <Label>What&rsquo;s the story?</Label>
      <div className="rounded-lg border border-hairline-strong bg-surface p-4 shadow-sm">
        <p className="min-h-[3.4em] text-[14px] leading-relaxed text-ink sm:text-[15px]">
          {BRIEF_TEXT.slice(0, typed)}
          <span
            data-rb-anim
            className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent align-middle"
            style={{ animation: "rb-blink 1s step-end infinite" }}
          />
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          <span className="rounded-md bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-ink-soft">
            renderball.com
          </span>
          <Chip selected>16:9</Chip>
          <Chip>9:16</Chip>
          <Chip>1:1</Chip>
          <span className="rounded-md bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-ink-soft">
            45s
          </span>
        </div>
      </div>
      <div className="flex justify-end">
        <span
          data-rb-anim
          className="rounded-md bg-accent px-5 py-2 text-[13px] font-semibold text-accent-ink"
          style={{ animation: "rb-press 5.4s ease-in-out infinite" }}
        >
          Make a video →
        </span>
      </div>
    </div>
  );
}

// ── Stage 2 · Brand (auto-extracted) ─────────────────────────────────
const SWATCHES = ["#10141C", "#00C28A", "#047857", "#EAEDF1", "#7FE9C4"];

function BrandStage() {
  const items = [
    { label: "Logo found", v: "the orb mark" },
    { label: "Palette", v: "emerald + greyscale" },
    { label: "Fonts", v: "Cabinet Grotesk · Geist" },
    { label: "Motion", v: "restrained" },
  ];
  return (
    <div className="flex h-full flex-col justify-center gap-4 px-6 py-5 sm:px-10">
      <Label>Reading renderball.com</Label>
      <div className="relative overflow-hidden rounded-lg border border-hairline bg-surface p-4">
        <div
          data-rb-anim
          className="pointer-events-none absolute inset-x-0 top-0 h-10"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,194,138,0.22), transparent)",
            animation: "rb-scan 2.4s ease-in-out infinite",
          }}
        />
        <div className="mb-3 flex items-center gap-2">
          {SWATCHES.map((c, i) => (
            <span
              key={c}
              data-rb-anim
              className="h-8 w-8 rounded-md ring-1 ring-inset ring-black/5"
              style={{
                backgroundColor: c,
                animation: "rb-pop 0.4s ease-out both",
                animationDelay: `${0.15 + i * 0.12}s`,
              }}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {items.map((it, i) => (
            <div
              key={it.label}
              data-rb-anim
              className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2"
              style={{
                animation: "rb-fade-left 0.4s ease-out both",
                animationDelay: `${0.4 + i * 0.16}s`,
              }}
            >
              <Check />
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                  {it.label}
                </div>
                <div className="truncate text-[12.5px] text-ink-soft">{it.v}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Stage 3 · Script (the second-by-second spec) ─────────────────────
const SCENES = [
  { t: "0:00", label: "The crystal ball opens", chips: ["Cabinet 88pt", "#10141C", "typewriter"] },
  { t: "0:08", label: "Brief → script → render", chips: ["3 panels", "#00C28A", "slide-up"] },
  { t: "0:22", label: "On-brand, every frame", chips: ["device UI", "spring", "stagger"] },
  { t: "0:38", label: "Start your subscription — CTA", chips: ["CTA", "pulse", "orb out"] },
];

function ScriptStage() {
  return (
    <div className="flex h-full flex-col justify-center gap-2.5 px-6 py-4 sm:px-10">
      <div
        data-rb-anim
        style={{ animation: "rb-fade-up 0.5s ease-out both" }}
      >
        <Label>Your script — approve before any render</Label>
        <p className="font-display text-[clamp(16px,2.4vw,20px)] font-semibold leading-tight tracking-tight text-ink">
          &ldquo;Animation-rich video, written by AI.&rdquo;
        </p>
      </div>
      <div className="space-y-1.5">
        {SCENES.map((s, i) => (
          <div
            key={s.t}
            data-rb-anim
            className="flex items-center gap-3 rounded-md border border-hairline bg-surface px-3 py-2"
            style={{
              animation: "rb-fade-up 0.5s ease-out both",
              animationDelay: `${0.25 + i * 0.32}s`,
            }}
          >
            <span className="font-mono text-[11px] text-accent-text">{s.t}</span>
            <span className="w-px self-stretch bg-hairline" />
            <span className="shrink-0 text-[12.5px] font-medium text-ink">
              {s.label}
            </span>
            <span className="ml-auto hidden items-center gap-1.5 sm:flex">
              {s.chips.map((c) => (
                <span
                  key={c}
                  className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted"
                >
                  {c}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stage 4 · Render ─────────────────────────────────────────────────
const TOTAL_FRAMES = 1350;

function RenderStage({ reduced }: { reduced: boolean }) {
  const [frame, setFrame] = useState(reduced ? TOTAL_FRAMES : 0);
  const chunks = 24;
  const filled = Math.round((frame / TOTAL_FRAMES) * chunks);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(
      () => setFrame((f) => (f >= TOTAL_FRAMES ? f : Math.min(f + 38, TOTAL_FRAMES))),
      70,
    );
    raf.current = id as unknown as number;
    return () => clearInterval(id);
  }, [reduced]);
  const pct = Math.round((frame / TOTAL_FRAMES) * 100);

  return (
    <div className="flex h-full flex-col justify-center gap-3 px-6 py-5 sm:px-10">
      <Label>Rendering · 1080p · H.264</Label>
      <div className="flex items-center gap-2">
        <Pill done>Design agent</Pill>
        <span className="text-faint">→</span>
        <Pill done>Choreography</Pill>
        <span className="text-faint">→</span>
        <Pill>Capturing frames</Pill>
      </div>
      {/* Frame strip filling in */}
      <div className="grid grid-cols-12 gap-1">
        {Array.from({ length: chunks }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-5 rounded-sm transition-colors duration-150",
              i < filled ? "bg-accent" : "bg-surface-3",
            )}
          />
        ))}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-75 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between font-mono text-[12px] text-muted">
        <span>frame {frame} / {TOTAL_FRAMES}</span>
        <span className="text-accent-text">{pct}%</span>
      </div>
    </div>
  );
}

// ── Stage 5 · QA ─────────────────────────────────────────────────────
function QaStage() {
  const checks = [
    "Scene 1 — title text matches script",
    "Scene 2 — brand color within tolerance",
    "Scene 3 — all 3 cards visible",
    "Scene 4 — CTA present, logo placed",
  ];
  return (
    <div className="flex h-full flex-col justify-center gap-3 px-6 py-5 sm:px-10">
      <Label>Frame-by-frame QA against your script</Label>
      <div className="space-y-1.5">
        {checks.map((c, i) => (
          <div
            key={c}
            data-rb-anim
            className="flex items-center gap-2.5 rounded-md border border-hairline bg-surface px-3 py-2"
            style={{
              animation: "rb-fade-left 0.4s ease-out both",
              animationDelay: `${0.15 + i * 0.4}s`,
            }}
          >
            <Check />
            <span className="text-[12.5px] text-ink-soft">{c}</span>
          </div>
        ))}
      </div>
      <div
        data-rb-anim
        className="font-mono text-[11px] uppercase tracking-[0.12em] text-accent-text"
        style={{ animation: "rb-fade 0.4s ease-out both", animationDelay: "1.9s" }}
      >
        Verified · ready to deliver
      </div>
    </div>
  );
}

// ── Stage 6 · Ready (the finished video — recursive: Renderball's own) ───
function ReadyStage() {
  // Frame counter eases up to a hero number for the payoff.
  const [frames, setFrames] = useState(0);
  useEffect(() => {
    const target = 1243500;
    const dur = 1700;
    let startTs: number | null = null;
    let raf = 0;
    const tick = (ts: number) => {
      if (startTs === null) startTs = ts;
      const p = Math.min((ts - startTs) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setFrames(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#06100c]">
        {/* Layered emerald field — the brand's own color, cinematic on dark. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(56% 72% at 24% 16%, rgba(0,194,138,0.42), transparent 60%), radial-gradient(74% 94% at 88% 98%, rgba(0,224,160,0.28), transparent 62%), radial-gradient(44% 60% at 72% 28%, rgba(110,245,200,0.16), transparent 60%)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{ boxShadow: "inset 0 0 120px 20px rgba(0,0,0,0.55)" }}
        />
        <div className="relative px-6 text-center">
          <div
            data-rb-anim
            className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.34em] text-[#7fe9c4]"
            style={{ animation: "rb-fade 0.6s ease-out both" }}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#7fe9c4]" />
            Renderball
          </div>
          <div
            data-rb-anim
            className="font-display text-[clamp(24px,5vw,44px)] font-bold leading-[1.04] tracking-tight text-white"
            style={{
              animation: "rb-kinetic 0.8s cubic-bezier(0.2,0.7,0.2,1) both",
              animationDelay: "0.1s",
            }}
          >
            Animation-rich video.
          </div>
          <div
            data-rb-anim
            className="font-display text-[clamp(24px,5vw,44px)] font-bold leading-[1.04] tracking-tight text-[#5fe6bb]"
            style={{
              animation: "rb-kinetic 0.8s cubic-bezier(0.2,0.7,0.2,1) both",
              animationDelay: "0.34s",
            }}
          >
            Written by AI.
          </div>
          <div
            data-rb-anim
            className="mt-4 font-mono text-[11px] tabular-nums text-white/55"
            style={{ animation: "rb-fade 0.6s ease-out both", animationDelay: "0.75s" }}
          >
            {frames.toLocaleString()} frames rendered
          </div>
          <div
            data-rb-anim
            className="mt-3.5 inline-block rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-ink shadow-[0_8px_28px_-8px_rgba(0,194,138,0.7)]"
            style={{ animation: "rb-pop 0.5s ease-out both", animationDelay: "0.95s" }}
          >
            Start for $49.99/mo →
          </div>
        </div>
        <span className="absolute bottom-3 right-4 font-mono text-[10px] text-white/35">
          1080p · no watermark · your license
        </span>
      </div>
      {/* Playback bar */}
      <div className="flex items-center gap-3 border-t border-hairline bg-surface px-4 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[10px] text-accent-ink">
          ▶
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
          <div
            data-rb-anim
            className="h-full rounded-full bg-accent"
            style={{ animation: "rb-scrub 4.6s linear both" }}
          />
        </div>
        <span className="font-mono text-[10px] text-muted">0:45</span>
        <span className="rounded-md border border-hairline-strong px-2.5 py-1 font-mono text-[10px] text-ink-soft">
          Download MP4
        </span>
      </div>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
      {children}
    </div>
  );
}

function Chip({
  children,
  selected,
}: {
  children: React.ReactNode;
  selected?: boolean;
}) {
  return (
    <span
      className={cn(
        "rounded-md px-2.5 py-1 font-mono text-[11px]",
        selected
          ? "bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line"
          : "bg-surface-2 text-faint",
      )}
    >
      {children}
    </span>
  );
}

function Pill({
  children,
  done,
}: {
  children: React.ReactNode;
  done?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px]",
        done ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted",
      )}
    >
      {done && <Check />}
      {children}
    </span>
  );
}

function Check() {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-accent text-[8px] text-accent-ink">
      ✓
    </span>
  );
}
