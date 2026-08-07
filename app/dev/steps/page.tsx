"use client";

import { notFound } from "next/navigation";
import { BlankDocumentPanel, GeneratingSteps, generatingSteps } from "../../../components/BlankDocumentPanel";

/**
 * Dev-only harness for the outline "thinking steps" (NODE_ENV-gated, mirrors
 * /dev/new and /dev/edit). GET /dev/steps
 *
 * WHY: every state of this panel is otherwise reachable only by paying for a
 * real outline and then WAITING — the last-step hold needs ~2 minutes and the
 * "taking longer than usual" copy needs over four. That is long enough that
 * nobody checks, which is how a panel ships with a keyframe that never fires.
 * Here every state is on screen at once.
 */
export default function DevStepsPage() {
  if (process.env.NODE_ENV === "production") notFound();

  // elapsed seconds chosen to land on each distinct state for a 6-page outline
  // (estimate = 25 + 6*6 = 61s, 5 steps, ~12s per step).
  const cases: { elapsed: number; pages: number; url: string; note: string }[] = [
    { elapsed: 2, pages: 6, url: "", note: "first step active" },
    { elapsed: 30, pages: 6, url: "", note: "mid-run, two done" },
    { elapsed: 40, pages: 6, url: "fusefinance.com", note: "with a URL — extra step" },
    { elapsed: 75, pages: 6, url: "", note: "last step HOLDS past the estimate" },
    { elapsed: 200, pages: 6, url: "", note: "past 2x estimate — says so out loud" },
    { elapsed: 8, pages: 1, url: "", note: "single page — no plural" },
    { elapsed: 90, pages: 12, url: "fusefinance.com", note: "12 pages, longer estimate" },
  ];

  return (
    <main className="brand-field min-h-screen p-8">
      <h1 className="mb-6 font-display text-[22px] text-ink">Outline thinking steps — every state</h1>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {cases.map((c) => (
          <div key={c.note}>
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {c.note} · {c.elapsed}s · {c.pages}p
            </div>
            <GeneratingSteps steps={generatingSteps(c.pages, c.url)} elapsed={c.elapsed} pages={c.pages} />
          </div>
        ))}
      </div>

      {/* The real panel, so the brief box and its attach affordance can be
          seen and driven headlessly. Its network calls need a session, which
          is the point: the unauthenticated path must fail like a person can
          read, not like a stack trace. */}
      <h2 className="mb-4 mt-10 font-display text-[22px] text-ink">The brief box, live</h2>
      <div className="relative h-[560px] rounded-xl border border-hairline">
        <BlankDocumentPanel scriptId="dev-harness" onDismiss={() => {}} />
      </div>
    </main>
  );
}
