"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn";

/**
 * The build moment (DESIGN.md step 5: "Build it" — one loud action, honest
 * per-page progress). Shown on /preview/[id] when no Composition.tsx exists.
 *
 * The user already approved the outline and clicked Build on the review
 * screen, so the build starts on arrival — no second button. While the design
 * pass runs (/api/preview/build, one shot, no streaming) we run a paced
 * ceremony over the real page/scene list; decks speak outline/page language,
 * videos keep story/scene/choreography. The last step holds with a spinner
 * until the build resolves, then the page reloads into the editor/preview.
 */
/**
 * Poll the build until it settles, and re-shape the result into the same
 * Response the caller used to get from a single blocking POST — so all the
 * status handling below (402 limit, 409 busy, 503 breaker) is untouched.
 *
 * No overall deadline on purpose: builds legitimately run for many minutes,
 * and a client-side timeout would report failure for a build that is fine.
 * The user can always close the tab; the build finishes server-side and the
 * document is durable (lib/render/gen-store.ts), so nothing is lost.
 */
const POLL_MS = 4000;

// How often the busy screen quietly re-attempts the build start. Long enough
// to be a whisper against the server, short enough that "starts on its own"
// is honest — the other build runs for minutes, not seconds.
const BUSY_RETRY_MS = 15_000;

async function pollUntilSettled(scriptId: string): Promise<Response> {
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res: Response;
    try {
      res = await fetch(
        `/api/preview/build?scriptId=${encodeURIComponent(scriptId)}`,
        { cache: "no-store" },
      );
    } catch {
      continue; // transient network blip — keep polling
    }
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as {
      status?: string;
      result?: unknown;
      resultStatus?: number;
      error?: string;
    } | null;
    if (!data) continue;

    if (data.status === "done") {
      return new Response(JSON.stringify(data.result ?? {}), {
        status: data.resultStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (data.status === "error") {
      return new Response(JSON.stringify({ error: data.error ?? "build failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    // "unknown" means this container never saw the job — most likely it
    // restarted mid-build. Reload: if the document exists the page mounts the
    // editor, otherwise the build ceremony starts cleanly again.
    if (data.status === "unknown") {
      window.location.reload();
      return new Response("{}", { status: 202 });
    }
    // "running" — keep waiting.
  }
}

type Phase =
  | { kind: "building" }
  | { kind: "error"; message: string }
  // 402 from the metering gate — a real plan limit, not a failure. Retrying
  // re-hits the same 402 forever; the way forward is /billing. (A fail-closed
  // 402 — the gate couldn't check the plan — routes to "error" instead, which
  // has the retry the situation calls for.)
  | { kind: "limit"; message: string }
  // 409 from the build lock — the account already has a build running.
  | { kind: "busy"; message: string };
type Status = "done" | "active" | "pending";

export function BuildPreviewClient({
  scriptId,
  kind = "video",
  sceneLabels,
}: {
  scriptId: string;
  kind?: "deck" | "video";
  sceneLabels: string[];
}) {
  const isDeck = kind === "deck";
  const steps = useMemo(() => {
    const s = [isDeck ? "Reading the approved outline" : "Reading the approved story"];
    sceneLabels.forEach((label, i) =>
      s.push(
        `Designing ${isDeck ? "page" : "scene"} ${i + 1}${label ? ` — ${label}` : ""}`,
      ),
    );
    s.push(isDeck ? "Composing the layout" : "Choreographing the motion");
    s.push(isDeck ? "Opening the editor" : "Compiling your live preview");
    return s;
  }, [sceneLabels, isDeck]);

  const [phase, setPhase] = useState<Phase>({ kind: "building" });
  const [current, setCurrent] = useState(0);

  /**
   * Seconds since this build started — the ONE measured number on a screen
   * whose step list is otherwise paced. Requested by the founder after
   * watching a real production build with no sense of how long it had been
   * running: the steps tick and the bar fills, but neither tells you whether
   * you have been waiting forty seconds or four minutes.
   *
   * setInterval, not requestAnimationFrame: rAF is paused entirely in a
   * background tab, and this panel explicitly invites you to leave.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase.kind !== "building") return;
    const started = Date.now();
    setElapsed(0);
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [phase.kind]);
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
        let res = await fetch("/api/preview/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId }),
        });

        // 202 = the build is running server-side. It takes minutes, and the
        // origin sits behind Cloudflare's 100s timeout, so the request cannot
        // be held open — poll instead. Anything that failed fast (402 limit,
        // 409 busy, 422 brand kit) still arrives on this first response and
        // falls through to the handling below unchanged.
        if (res.status === 202) {
          res = await pollUntilSettled(scriptId);
        }

        if (!res.ok) {
          const txt = await res.text();
          let body: { error?: string; limit?: number } | null = null;
          try {
            body = JSON.parse(txt) as { error?: string; limit?: number };
          } catch {
            /* non-JSON body — wire text; it goes to the console below */
          }
          const friendly = body?.error ?? null;
          if (res.status === 402) {
            // The entitlement gate FAILS CLOSED: when the plan lookup itself
            // errors (a DB blip), it denies with limit 0 — the only 402 shape
            // with no real allowance behind it. That is a retryable hiccup,
            // not a plan limit, so it must not wear the limit wall (which has
            // no retry and points at billing).
            if (body?.limit === 0) {
              setPhase({
                kind: "error",
                message:
                  friendly ??
                  "We couldn't check your plan just now. Try the build again in a moment.",
              });
              return;
            }
            setPhase({ kind: "limit", message: friendly ?? "Monthly build limit reached." });
            return;
          }
          if (res.status === 409) {
            setPhase({ kind: "busy", message: friendly ?? "You already have a build running." });
            return;
          }
          // 503 (provider circuit breaker) carries a human-written message —
          // surface it directly instead of the raw dump.
          if (res.status === 503 && friendly) {
            setPhase({ kind: "error", message: friendly });
            return;
          }
          // Other 4xx bodies (422 brand kit, preflight) are server-authored
          // user language — surface them as-is, no wire prefix. 5xx bodies
          // are pipeline internals: those belong in the console, the user
          // gets a sentence.
          console.error(`[build] failed (${res.status}):`, friendly ?? txt);
          setPhase({
            kind: "error",
            message:
              res.status < 500 && friendly
                ? friendly
                : `The build failed partway through. Nothing is lost — your approved ${isDeck ? "outline" : "story"} is saved. Try the build again.`,
          });
          return;
        }
        setAgentDone(true);
      } catch (e) {
        // Client-side failure (the request never settled). Exception text is
        // as much jargon as wire text — console only.
        console.error("[build] request failed:", e);
        setPhase({
          kind: "error",
          message: `We couldn't reach the server to start the build. Your approved ${isDeck ? "outline" : "story"} is saved — try again in a moment.`,
        });
      }
    })();
  }, [buildKey, scriptId, isDeck]);

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

  // The busy screen tells the user their build starts once the running one
  // finishes — keep that true without a button press: while busy, quietly
  // re-attempt the start on an interval. 409 = still busy, stay put. Anything
  // else means the POST just started (or attached to) this build server-side
  // — the per-script job in build-jobs.ts dedups the follow-up POST into a
  // 202 — so reset into the building phase and let the poll machinery run.
  useEffect(() => {
    if (phase.kind !== "busy") return;
    let cancelled = false;
    let inFlight = false;
    const attempt = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/preview/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId }),
        });
        if (cancelled || res.status === 409) return;
        // Same reset retry() performs, inlined so the effect's dependencies
        // stay honest.
        setPhase({ kind: "building" });
        setCurrent(0);
        setAgentDone(false);
        setBuildKey((k) => k + 1);
      } catch {
        /* transient network blip — the next tick tries again */
      } finally {
        inFlight = false;
      }
    };
    const t = setInterval(attempt, BUSY_RETRY_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [phase.kind, scriptId]);

  const retry = () => {
    setPhase({ kind: "building" });
    setCurrent(0);
    setAgentDone(false);
    setBuildKey((k) => k + 1);
  };

  if (phase.kind === "limit") {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-[560px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="orb mx-auto mb-6 h-14 w-14" aria-hidden />
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
          Plan limit
        </div>
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-ink">
          You&apos;ve used this month&apos;s builds
        </h1>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-muted">{phase.message}</p>
        <a
          href="/billing"
          className="mt-6 rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          View usage →
        </a>
      </main>
    );
  }

  if (phase.kind === "busy") {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-[560px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="orb orb-spin mx-auto mb-6 h-14 w-14" aria-hidden />
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
          Build in progress
        </div>
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-ink">
          Another build is already running
        </h1>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-muted">
          {phase.message} This page keeps checking — the build starts on its
          own as soon as the other one finishes.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Check now
        </button>
      </main>
    );
  }

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
        {/* Messages here are always human sentences (wire detail is in the
            console), so this is a paragraph like the other phases. */}
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-muted">
          {phase.message}
        </p>
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
        {isDeck ? "Building your deck" : "Building your video"}
      </h1>
      <p className="mb-8 max-w-[44ch] text-center text-[14px] leading-relaxed text-muted">
        {isDeck
          ? "Designing every page in your brand, then opening the editor. The outline's already approved, so this is the last wait."
          : "Designing each scene, choreographing the motion, then compiling a live preview. About a minute — the story's already approved, so this is the last wait."}
      </p>

      <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* The clock is MEASURED; the bar above it is paced. Keeping them on
          adjacent lines is deliberate — the number is what a waiting person
          actually trusts. Past ten minutes it stops implying the pace was
          right, the same discipline the outline panel uses. */}
      <div className="mb-6 flex w-full items-baseline justify-between gap-3">
        <span className="font-mono text-[11.5px] tabular-nums text-muted">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
        <span className="text-[11.5px] leading-relaxed text-faint">
          {elapsed > 600
            ? "Taking longer than usual — still working."
            : "You can close this tab; it finishes on its own."}
        </span>
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
