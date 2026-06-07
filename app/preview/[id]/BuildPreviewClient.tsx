"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn";

/**
 * The build moment (DESIGN.md step 5: "Build it" — one loud action, honest
 * per-scene progress). Shown on /preview/[id] when no Composition.tsx exists.
 *
 * The user already approved the story and clicked "Build the video" on the
 * review screen, so the build starts on arrival — no second button. While the
 * Design + Choreography pass runs (/api/preview/build, ~1-2 min, one shot,
 * no streaming) we run a paced ceremony over the real scene list: read the
 * story, design each scene, choreograph, compile. The last step holds with a
 * spinner until the build resolves, then the page reloads into the preview.
 */
type Phase = { kind: "building" } | { kind: "error"; message: string };
type Status = "done" | "active" | "pending";

export function BuildPreviewClient({
  scriptId,
  sceneLabels,
}: {
  scriptId: string;
  sceneLabels: string[];
}) {
  const steps = useMemo(() => {
    const s = ["Reading the approved story"];
    sceneLabels.forEach((label, i) =>
      s.push(`Designing scene ${i + 1}${label ? ` — ${label}` : ""}`),
    );
    s.push("Choreographing the motion");
    s.push("Compiling your live preview");
    return s;
  }, [sceneLabels]);

  const [phase, setPhase] = useState<Phase>({ kind: "building" });
  const [current, setCurrent] = useState(0);
  const [agentDone, setAgentDone] = useState(false);
  const [buildKey, setBuildKey] = useState(0);
  const lastStarted = useRef<number | null>(null);

  // Kick off the real build once per buildKey (ref-guarded against React
  // StrictMode's double-invoke in dev, so we never fire two builds).
  useEffect(() => {
    if (lastStarted.current === buildKey) return;
    lastStarted.current = buildKey;
    (async () => {
      try {
        const res = await fetch("/api/preview/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`build failed (${res.status}): ${txt}`);
        }
        setAgentDone(true);
      } catch (e) {
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }, [buildKey, scriptId]);

  const isLast = current === steps.length - 1;

  // Advance the ceremony; hold the final step until the build resolves.
  useEffect(() => {
    if (phase.kind !== "building") return;
    if (isLast) {
      if (agentDone) {
        const t = setTimeout(() => window.location.reload(), 650);
        return () => clearTimeout(t);
      }
      return;
    }
    const stepMs = Math.min(9000, Math.max(3500, Math.round(48000 / steps.length)));
    const t = setTimeout(() => setCurrent((c) => c + 1), stepMs);
    return () => clearTimeout(t);
  }, [current, isLast, agentDone, phase.kind, steps.length]);

  const retry = () => {
    setPhase({ kind: "building" });
    setCurrent(0);
    setAgentDone(false);
    setBuildKey((k) => k + 1);
  };

  if (phase.kind === "error") {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-[560px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="orb mx-auto mb-6 h-14 w-14" aria-hidden />
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-red-500">
          Build failed
        </div>
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-ink">
          The build hit a snag
        </h1>
        <pre className="mt-4 w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-hairline bg-surface-2 p-4 text-left font-mono text-[12px] text-ink-soft">
          {phase.message}
        </pre>
        <button
          type="button"
          onClick={retry}
          className="mt-6 rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Try the build again
        </button>
      </main>
    );
  }

  const completed = current + (isLast && !agentDone ? 0 : 0);
  const pct = Math.min(
    100,
    ((completed + (isLast && !agentDone ? 0.5 : 0)) / steps.length) * 100,
  );

  return (
    <main className="mx-auto flex min-h-[72vh] max-w-[600px] flex-col items-center justify-center px-6 py-16">
      <div className="orb orb-spin mx-auto mb-7 h-16 w-16" aria-hidden />
      <div className="mb-2 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
        Building
      </div>
      <h1 className="mb-2 text-center font-display text-[clamp(24px,3.4vw,32px)] font-semibold tracking-tight text-ink">
        Building your video
      </h1>
      <p className="mb-8 max-w-[44ch] text-center text-[14px] leading-relaxed text-muted">
        Designing each scene, choreographing the motion, then compiling a live
        preview. About a minute — the story&apos;s already approved, so this is
        the last wait.
      </p>

      <div className="mb-6 h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="w-full space-y-2">
        {steps.map((label, i) => {
          const status: Status =
            i < current ? "done" : i === current ? "active" : "pending";
          return <StepRow key={i} label={label} status={status} />;
        })}
      </ul>
    </main>
  );
}

function StepRow({ label, status }: { label: string; status: Status }) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-md border px-3.5 py-2.5 transition-colors",
        status === "active"
          ? "border-accent-line bg-accent-soft"
          : status === "done"
            ? "border-hairline bg-surface-2"
            : "border-hairline bg-surface-2 opacity-50",
      )}
    >
      <StatusDot status={status} />
      <span
        className={cn(
          "text-[13.5px]",
          status === "pending" ? "text-muted" : "text-ink",
          status === "active" && "font-medium",
        )}
      >
        {label}
        {status === "active" && <span className="text-muted">…</span>}
      </span>
    </li>
  );
}

function StatusDot({ status }: { status: Status }) {
  if (status === "done") {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 6.5L5 9L9.5 3.5"
            stroke="var(--accent-ink)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <svg className="h-4 w-4 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="opacity-90"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="h-5 w-5 shrink-0 rounded-full border border-hairline-strong bg-surface" />
  );
}
