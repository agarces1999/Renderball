"use client";

import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

/**
 * Animated "how it works" demo. A looping, four-phase performance of the
 * Renderball flow — brief typed in, script materializing, render progressing,
 * the finished video playing — built in CSS/React (Renderball is a motion
 * product, so the explainer is itself animated). A real recorded MP4 can
 * replace this later. Honors prefers-reduced-motion by holding on the output.
 */
const BRIEF = "Launch video for our analytics product — upbeat, ends on a sign-up CTA.";
const SCENES = [
  { t: "0:00", label: "Opening title" },
  { t: "0:03", label: "The problem, in 3 cards" },
  { t: "0:09", label: "Product reveal" },
  { t: "0:14", label: "Sign-up CTA" },
];
const PHASES = ["Brief", "Script", "Render", "Output"] as const;
const DURATIONS = [4000, 3400, 3400, 3800];
const TOTAL_FRAMES = 1350;

export function HowItWorksDemo() {
  const [phase, setPhase] = useState(0);
  const [typed, setTyped] = useState(0);
  const [frame, setFrame] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    if (m.matches) setPhase(3);
  }, []);

  // Master phase loop.
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setPhase((p) => (p + 1) % 4), DURATIONS[phase]);
    return () => clearTimeout(t);
  }, [phase, reduced]);

  // Typewriter during Brief.
  useEffect(() => {
    if (reduced || phase !== 0) return;
    setTyped(0);
    const id = setInterval(
      () => setTyped((n) => (n >= BRIEF.length ? n : n + 1)),
      38,
    );
    return () => clearInterval(id);
  }, [phase, reduced]);

  // Frame counter during Render.
  useEffect(() => {
    if (reduced || phase !== 2) return;
    setFrame(0);
    const id = setInterval(
      () => setFrame((f) => (f >= TOTAL_FRAMES ? f : Math.min(f + 42, TOTAL_FRAMES))),
      80,
    );
    return () => clearInterval(id);
  }, [phase, reduced]);

  const pct = Math.round((frame / TOTAL_FRAMES) * 100);

  return (
    <div className="w-full">
      {/* Phase indicator */}
      <div className="mb-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
        {PHASES.map((p, i) => (
          <span key={p} className="flex items-center gap-2">
            <span
              className={cn(
                "transition-colors",
                i === phase ? "text-accent-text" : "text-faint",
              )}
            >
              {p}
            </span>
            {i < PHASES.length - 1 && <span className="text-faint">·</span>}
          </span>
        ))}
      </div>

      {/* Device frame */}
      <div className="overflow-hidden rounded-lg border border-hairline-strong bg-surface-2 shadow-[0_30px_80px_-40px_rgba(18,26,43,0.5)]">
        <div className="flex items-center gap-1.5 border-b border-hairline bg-surface px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
          <span className="ml-3 font-mono text-[11px] text-faint">renderball.com</span>
        </div>

        {/* Stage — phase layers crossfade */}
        <div className="relative aspect-[16/10] bg-surface">
          {/* Brief */}
          <Layer active={phase === 0}>
            <div className="flex h-full flex-col justify-center px-8">
              <Eyebrow>Your brief</Eyebrow>
              <div className="rounded-md border border-hairline-strong bg-surface-2 px-4 py-3.5">
                <span className="text-[15px] leading-relaxed text-ink">
                  {reduced ? BRIEF : BRIEF.slice(0, typed)}
                  {!reduced && phase === 0 && (
                    <span className="ml-0.5 inline-block h-[1.1em] w-[2px] -translate-y-[2px] animate-pulse bg-accent align-middle" />
                  )}
                </span>
              </div>
            </div>
          </Layer>

          {/* Script */}
          <Layer active={phase === 1}>
            <div className="flex h-full flex-col justify-center px-8">
              <Eyebrow>Script — approve before any render</Eyebrow>
              <div className="space-y-2">
                {SCENES.map((s, i) => (
                  <div
                    key={s.t}
                    className={cn(
                      "flex items-center gap-3 rounded-md border border-hairline bg-surface-2 px-3.5 py-2.5 transition-all duration-500",
                      phase === 1
                        ? "translate-y-0 opacity-100"
                        : "translate-y-2 opacity-0",
                    )}
                    style={{ transitionDelay: phase === 1 ? `${i * 160}ms` : "0ms" }}
                  >
                    <span className="font-mono text-[11px] text-accent-text">{s.t}</span>
                    <span className="text-[13.5px] text-ink-soft">{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </Layer>

          {/* Render */}
          <Layer active={phase === 2}>
            <div className="flex h-full flex-col justify-center px-8">
              <Eyebrow>Rendering · 1080p</Eyebrow>
              <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-100 ease-linear"
                  style={{ width: `${reduced ? 100 : pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between font-mono text-[12px] text-muted">
                <span>frame {reduced ? TOTAL_FRAMES : frame} / {TOTAL_FRAMES}</span>
                <span>{reduced ? 100 : pct}%</span>
              </div>
            </div>
          </Layer>

          {/* Output */}
          <Layer active={phase === 3}>
            <div className="relative flex h-full items-center justify-center overflow-hidden bg-[#0a0f0d]">
              <div
                className="pointer-events-none absolute inset-0 opacity-90"
                style={{
                  background:
                    "radial-gradient(60% 80% at 30% 20%, rgba(0,194,138,0.32), transparent 60%), radial-gradient(70% 90% at 85% 95%, rgba(0,224,160,0.22), transparent 60%)",
                }}
              />
              <div
                className={cn(
                  "relative text-center transition-all duration-700",
                  phase === 3 ? "scale-100 opacity-100" : "scale-95 opacity-0",
                )}
              >
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.3em] text-[#7fe9c4]">
                  Introducing
                </div>
                <div className="font-display text-[clamp(28px,5vw,46px)] font-bold tracking-tight text-white">
                  Pulse Analytics
                </div>
                <div className="mt-3 inline-block rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-ink">
                  Start free →
                </div>
              </div>
              <span className="absolute bottom-3 right-4 font-mono text-[10px] text-white/40">
                your video · 1080p · no watermark
              </span>
            </div>
          </Layer>
        </div>
      </div>
    </div>
  );
}

function Layer({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "absolute inset-0 transition-opacity duration-500",
        active ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
      {children}
    </div>
  );
}
