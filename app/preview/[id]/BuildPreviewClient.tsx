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

/** Client-side marker for "the user stopped it" — not a real HTTP status. */
const CANCELLED_STATUS = 499;

/** A real phase boundary the server-side build crossed. */
export type ProgressEvent = { phase: string; at: number };

async function pollUntilSettled(
  scriptId: string,
  onProgress?: (events: ProgressEvent[]) => void,
): Promise<Response> {
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
      progress?: ProgressEvent[];
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
    if (data.status === "cancelled") {
      return new Response("{}", { status: CANCELLED_STATUS });
    }
    // "unknown" means this container never saw the job — most likely it
    // restarted mid-build. Reload: if the document exists the page mounts the
    // editor, otherwise the build ceremony starts cleanly again.
    if (data.status === "unknown") {
      window.location.reload();
      return new Response("{}", { status: 202 });
    }
    // "running" — hand the ceremony the REAL phase boundaries and keep waiting.
    if (Array.isArray(data.progress)) onProgress?.(data.progress);
  }
}

type Phase =
  | { kind: "building" }
  | { kind: "stopped" }
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
  outlineHref = "/documents",
}: {
  scriptId: string;
  kind?: "deck" | "video";
  sceneLabels: string[];
  /** The approved outline's review page — the exit and the stop both land here. */
  outlineHref?: string;
}) {
  const isDeck = kind === "deck";
  const steps = useMemo(() => {
    const s = [isDeck ? "Reading the approved outline" : "Reading the approved story"];
    // Its own row because it is the single biggest serial step of the build —
    // measured 48.7s on a 3-page build, and the founder watched 1:20 of it
    // labeled "Reading the approved outline" (2026-08-14). The read is
    // instant; THIS is the foundation call: palette, type system, chrome,
    // the section skeleton.
    s.push("Laying the foundation — colors, type, chrome");
    sceneLabels.forEach((label, i) =>
      s.push(
        `Designing ${isDeck ? "page" : "scene"} ${i + 1}${label ? ` — ${label}` : ""}`,
      ),
    );
    s.push(isDeck ? "Composing the layout" : "Choreographing the motion");
    // The step that used to not exist — and therefore lived inside "Opening
    // the editor" for minutes: the measurement gates and the repair ladder.
    // A measured Klarna build spent TEN minutes here (two repair rounds, a
    // full rebuild, two more rounds) while the ceremony claimed everything
    // was done but the editor.
    s.push("Checking every page against the layout gates");
    s.push(isDeck ? "Opening the editor" : "Compiling your live preview");
    return s;
  }, [sceneLabels, isDeck]);

  // REAL phase boundaries from the server (BuildTimeline → build-jobs → the
  // poll). Empty on old containers — everything below falls back to pacing.
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const phases = useMemo(() => progress.map((p) => p.phase), [progress]);
  const seen = (prefix: string) => phases.some((ph) => ph.startsWith(prefix));
  const repairRounds = phases.filter((ph) => ph.startsWith("repair:")).length;

  /**
   * Map the ceremony's rows onto the real signals. Per-page rows tick when
   * THAT page's fill lands (fills are parallel, so out of order is normal);
   * everything else keys on its phase boundary. Returns null when no real
   * signal has arrived yet — the paced fallback then drives the row.
   */
  const realStatus = (i: number): Status | null => {
    if (progress.length === 0) return null;
    const pageCount = sceneLabels.length;
    const fillsDone = seen("design:fills:done") || seen("gates:structural");
    if (i === 0) {
      // The read really is instant — the first server signal proves it over.
      return "done";
    }
    if (i === 1) {
      // The foundation call (design:scaffold) — the big serial step.
      return seen("design:scaffold:done") || fillsDone ? "done" : "active";
    }
    if (i >= 2 && i <= pageCount + 1) {
      const scene = i - 2;
      if (seen(`design:fill:scene:${scene}:done`) || fillsDone) return "done";
      return seen("design:scaffold:done") ? "active" : "pending";
    }
    if (i === pageCount + 2) {
      // Composing: the structural-gate + motion block.
      if (seen("pipeline:done")) return "done";
      return fillsDone ? "active" : "pending";
    }
    if (i === pageCount + 3) {
      // Checking: render-truth measurement + the repair ladder.
      if (seen("gate:render-truth:passed") || seen("gate:vision")) return "done";
      return seen("pipeline:done") ? "active" : "pending";
    }
    // Opening the editor — the LAST row; the reload effect owns its finish.
    return seen("gate:render-truth:passed") || seen("gate:vision") ? "active" : "pending";
  };

  const [phase, setPhase] = useState<Phase>({ kind: "building" });
  const [current, setCurrent] = useState(0);

  // ── stage state: which landed page fills the stage ────────────────────────
  // Follow the newest landing until the user picks one by hand.
  const [pickedScene, setPickedScene] = useState<number | null>(null);
  const landed = useMemo(
    () => sceneLabels.map((_, i) => i).filter((i) => seen(`design:fill:scene:${i}:done`)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phases, sceneLabels],
  );
  const stageScene: number | null =
    pickedScene !== null && landed.includes(pickedScene)
      ? pickedScene
      : landed.length > 0
        ? landed[landed.length - 1]
        : null;

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
          res = await pollUntilSettled(scriptId, setProgress);
        }

        if (res.status === CANCELLED_STATUS) {
          setPhase({ kind: "stopped" });
          return;
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
          // The layout-gate hard fail carries structure — name the pages in
          // the user's own terms instead of leaking "render-truth gate:
          // ladder-exhausted" (measured leak: a founder screenshot).
          const rt = (body as { render_truth?: { blocking?: { scene: number }[] } } | null)
            ?.render_truth;
          if (rt) {
            const pages = [...new Set((rt.blocking ?? []).map((b) => b.scene + 1))].sort(
              (a, b) => a - b,
            );
            const which =
              pages.length > 0
                ? `${isDeck ? "Page" : "Scene"}${pages.length > 1 ? "s" : ""} ${pages.join(", ")}`
                : "Some pages";
            setPhase({
              kind: "error",
              message:
                `${which} kept failing our layout check even after automatic repairs, ` +
                `so we didn't ship a deck we knew was broken. Your approved outline is safe — ` +
                `simplifying ${pages.length === 1 ? "that page's" : "those pages'"} content on the outline, ` +
                `or just building again, usually gets it through.`,
            });
            return;
          }
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
    setProgress([]);
    setBuildKey((k) => k + 1);
  };

  // ── stop (founder ask 2026-08-12: a build needs an exit) ──────────────────
  const [stopping, setStopping] = useState(false);
  const stopBuild = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await fetch(`/api/preview/build?scriptId=${encodeURIComponent(scriptId)}`, {
        method: "DELETE",
      });
      // The poll notices the cancelled job and flips the phase; nothing else
      // to do here. Cooperative stop: the call in flight finishes first.
    } catch {
      setStopping(false);
    }
  };

  if (phase.kind === "limit") {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-[560px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="orb mx-auto mb-6 h-14 w-14" aria-hidden />
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
          Free tier
        </div>
        {/* The sentence below (server-composed) says WHICH limit: since
            2026-08-13 a 402 here is normally the advertised token allowance,
            not the old builds count — the heading must not contradict it. */}
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-ink">
          You&apos;ve reached the free limit
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

  if (phase.kind === "stopped") {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-[560px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="orb mx-auto mb-6 h-14 w-14" aria-hidden />
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
          Build stopped
        </div>
        <h1 className="font-display text-[24px] font-semibold tracking-tight text-ink">
          You stopped this build
        </h1>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-muted">
          Nothing is broken. Your approved {isDeck ? "outline" : "story"} is
          saved exactly as it was; the work already done was set aside, and the
          tokens it used were spent.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <a
            href={outlineHref}
            className="rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Back to your {isDeck ? "outline" : "story"}
          </a>
          <button
            type="button"
            onClick={retry}
            className="rounded-md border border-hairline-strong bg-surface px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-surface-2"
          >
            Build again
          </button>
        </div>
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
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={retry}
            className="rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Try the build again
          </button>
          <a
            href={outlineHref}
            className="rounded-md border border-hairline-strong bg-surface px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-surface-2"
          >
            Back to your {isDeck ? "outline" : "story"}
          </a>
        </div>
      </main>
    );
  }

  // The bar summarizes the SAME statuses the rows show — done steps over
  // total, with in-flight rows worth a quarter step. The old bar ran on the
  // paced counter the rows no longer use, so it sat at ~90% while six pages
  // were still designing ("seems like we are almost done and we are not even
  // half way" — founder, reading it exactly right). It may now sit at 20%
  // for a while, because that is where the build is.
  const statuses = steps.map(
    (_, i) => realStatus(i) ?? (i < current ? "done" : i === current ? "active" : "pending"),
  );
  const doneCount = statuses.filter((st) => st === "done").length;
  const activeCount = statuses.filter((st) => st === "active").length;
  const pct = Math.min(100, ((doneCount + activeCount * 0.25) / steps.length) * 100);

  return (
    <main className="flex min-h-[calc(100vh-80px)] flex-col gap-6 px-6 py-6 lg:flex-row">
      {/* THE RAIL (founder, 2026-08-14): the waiting panel moves LEFT and the
          pages take the stage. Everything the old centered column carried
          lives here — orb, honest bar, measured clock, steps, exits. */}
      <aside className="flex w-full shrink-0 flex-col rounded-xl border border-hairline bg-surface p-6 lg:max-h-[calc(100vh-104px)] lg:w-[400px] lg:overflow-y-auto">
        <div className="mb-4 flex items-center gap-3">
          <div className="orb orb-spin h-10 w-10 shrink-0" aria-hidden />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-text">
              Building
            </div>
            <h1 className="font-display text-[20px] font-semibold tracking-tight text-ink">
              {isDeck ? "Building your deck" : "Building your video"}
            </h1>
          </div>
        </div>
        <p className="mb-5 text-[12.5px] leading-relaxed text-muted">
          {isDeck
            ? "Every page appears on the right the moment it's designed. The outline's already approved, so this is the last wait."
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
        <div className="mb-5 flex w-full items-baseline justify-between gap-3">
          <span className="font-mono text-[11.5px] tabular-nums text-muted">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
          <span className="text-[11px] leading-relaxed text-faint">
            {elapsed > 600
              ? "Taking longer than usual — still working."
              : "You can close this tab; it finishes on its own."}
          </span>
        </div>

        <ul className="w-full space-y-2">
          {steps.map((label, i) => {
            // Real signals first; the paced counter only drives rows the server
            // has not spoken for (old container, or the seconds before the
            // first poll lands).
            const status: Status =
              realStatus(i) ?? (i < current ? "done" : i === current ? "active" : "pending");
            const checking = i === steps.length - 2;
            return (
              <StepRow
                key={i}
                label={
                  checking && repairRounds > 0
                    ? `${label} — fixing what failed (round ${repairRounds})`
                    : label
                }
                status={status}
              />
            );
          })}
        </ul>

        {/* The exits (founder ask 2026-08-12). Leaving keeps the build running —
            the busy screen reattaches on return. Stopping is cooperative: the
            call in flight finishes, then the build ends at the next phase edge. */}
        <div className="mt-auto flex w-full flex-col gap-3 pt-6">
          <button
            type="button"
            onClick={() => void stopBuild()}
            disabled={stopping}
            className="w-full rounded-md border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-red-500/40 hover:text-ink disabled:opacity-60"
          >
            {stopping ? "Stopping — letting the current step finish…" : "Stop this build"}
          </button>
          <a
            href={outlineHref}
            className="text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
          >
            ← Back to your {isDeck ? "outline" : "story"} — the build keeps going
          </a>
        </div>
      </aside>

      {/* THE STAGE: the latest landed page, FULL SCALE — the real page, not a
          tile (founder, 2026-08-14: "everything gets generated on the editor
          like on full scale not the little boxes"). Every landed page's
          iframe mounts ONCE and stays mounted (stable src, no reload churn);
          switching pages only flips which one is visible. Follows the newest
          landing until the user picks a page by hand. */}
      <section className="flex min-h-[420px] min-w-0 flex-1 flex-col" data-rb-build-stage>
        <div className="mb-3 flex min-h-[28px] items-center justify-between gap-3">
          <span className="truncate text-[13px] font-medium text-ink">
            {stageScene !== null
              ? `Page ${stageScene + 1}${sceneLabels[stageScene] ? ` — ${sceneLabels[stageScene]}` : ""}`
              : "The first page appears here as it lands"}
          </span>
          {landed.length > 0 && (
            <div className="flex shrink-0 items-center gap-1">
              {sceneLabels.map((lab, i) =>
                landed.includes(i) ? (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setPickedScene(i)}
                    title={lab}
                    className={cn(
                      "h-6 min-w-6 rounded px-1 font-mono text-[10px] tabular-nums transition-colors",
                      stageScene === i
                        ? "bg-accent text-accent-ink"
                        : "bg-surface-2 text-muted hover:text-ink",
                    )}
                  >
                    {i + 1}
                  </button>
                ) : (
                  <span
                    key={i}
                    title={lab}
                    className="h-6 min-w-6 rounded border border-dashed border-hairline px-1 text-center font-mono text-[10px] leading-6 text-faint"
                  >
                    {i + 1}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
        <div
          className="relative w-full flex-1 overflow-hidden rounded-lg border border-hairline bg-[#0b0d12]"
          style={{ aspectRatio: "16/9", maxHeight: "calc(100vh - 180px)" }}
        >
          {landed.map((i) => (
            <iframe
              key={i}
              src={`/api/preview/${scriptId}/iframe?scene=${i}&settle=1&v=live`}
              title={`Page ${i + 1}${sceneLabels[i] ? ` — ${sceneLabels[i]}` : ""}`}
              className="pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-500"
              style={{ border: 0, opacity: stageScene === i ? 1 : 0 }}
            />
          ))}
          {landed.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
              <div className="orb orb-spin h-12 w-12 opacity-60" aria-hidden />
              <p className="max-w-[36ch] text-[13px] leading-relaxed text-white/50">
                Laying the foundation — your first page appears here the moment
                it&apos;s designed.
              </p>
            </div>
          )}
        </div>
      </section>
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
