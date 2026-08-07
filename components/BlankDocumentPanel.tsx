"use client";

import { useEffect, useState } from "react";

/**
 * The first thing a user sees in a brand-new document.
 *
 * The founder's call: "New document" should open the editor, and the editor
 * should offer the choice — generate every page, or build it up one at a time.
 * That choice is the whole product thesis in one card, so it is stated plainly
 * rather than buried in a menu.
 *
 * The two paths are deliberately asymmetric, because their costs are:
 *   - Building it yourself is FREE and instant. It is the default, and it is
 *     what the landing sells ("draw a box, say what belongs inside it").
 *   - Generating every page is the expensive action — a model writes the
 *     outline, then every page is designed. So it asks for a brief, states
 *     that it costs tokens, and is the secondary button, not the loud one.
 *
 * This panel only exists while the document is untouched (isBlankScript).
 * The moment there is real content it disappears for good — it is an empty
 * state, not a mode.
 *
 * TWO choices, never three. A third option briefly lived here: continuing the
 * sketch a visitor drew on the home page. Founder call (2026-08-06) — remove
 * it. The landing's elements are canned demo content (a KPI reading "4.6 min
 * from one URL", a stock bar chart, a quote attributed to "the model"), so
 * carrying them into somebody's real deck imports OUR marketing filler into
 * THEIR document. It also could not do what its label promised, which is how
 * it was noticed. Do not reintroduce it without a real answer to "why would
 * anyone want this in their deck".
 */

/**
 * The steps shown while an outline is being written.
 *
 * PACED, NOT MEASURED — and the design is built around admitting that.
 * lib/llm/cast-provider.ts is deliberately non-streaming, so there is no
 * progress signal to read; inventing a percentage would be a lie told with a
 * progress bar. What IS true:
 *
 *   - every line names something the user actually asked for (their page
 *     count, their site), so each is a true statement about the work;
 *   - the elapsed clock beside them is real, and is the only number claimed;
 *   - the LAST step never completes. It keeps breathing until the response
 *     lands. A ceremony whose steps all tick green while the user waits is
 *     precisely the moment it becomes dishonest — the same discipline
 *     BuildPreviewClient uses when it holds its final step.
 */
const generatingSteps = (pages: number, url: string): string[] => {
  const site = url.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return [
    "Reading your brief",
    ...(site ? [`Looking at ${site}`] : []),
    "Finding the story",
    `Naming your ${pages} page${pages === 1 ? "" : "s"}`,
    "Putting them in order",
  ];
};

export function BlankDocumentPanel({
  scriptId,
  onDismiss,
}: {
  scriptId: string;
  onDismiss: () => void;
}) {
  // Render NOTHING until hydrated. This panel arrives server-rendered on a
  // heavy editor page, so for the first seconds it was a pixel-perfect card
  // whose buttons did nothing — a first-time user's very first click on the
  // product's headline offer, silently eaten (probed and reproduced). A
  // moment of absence beats a moment of deadness; visible must mean alive.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [pages, setPages] = useState(6);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [busy]);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!prompt.trim()) {
      setError("Say what the document is about.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, prompt, url: url.trim() || undefined, pages }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not start generating.");
        setBusy(false);
        return;
      }
      // On to the outline review — the approval step this form just promised.
      // Reloading in place was a dead end: the blank composition still exists,
      // so /preview/[id] re-renders the same blank editor and the outline the
      // user just paid for is never shown.
      if (data?.reviewUrl) {
        window.location.assign(data.reviewUrl);
      } else {
        window.location.reload();
      }
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  };

  if (!live) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-[520px] rounded-xl border border-hairline bg-surface p-6 shadow-[0_30px_80px_-40px_rgba(18,26,43,0.45)]">
        {!open ? (
          <>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
              New document
            </p>
            <h2 className="mt-1.5 font-display text-[22px] font-bold tracking-tight text-ink">
              How do you want to start?
            </h2>

            {/* What you sketched on the home page.
                This used to sit ABOVE both real choices, headed "from the
                landing canvas", promising to "continue what you started" —
                and the founder could not tell what it did. Fairly: it does
                not restore anything. It describes your sketch in words and
                pre-types that into the GENERATE form, which spends tokens.
                So it now says where the sketch came from in ordinary words,
                says exactly what the button will do, and sits with the
                generate option it actually leads to rather than above
                everything as a third headline choice. */}

            <button
              type="button"
              onClick={onDismiss}
              className="mt-5 w-full rounded-lg border border-accent-line bg-accent-soft p-4 text-left transition-colors hover:bg-surface-2"
            >
              <span className="block text-[14px] font-semibold text-ink">
                Build it yourself
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-soft">
                Draw a box anywhere and say what belongs inside it. Add text and
                images. Always free — you only pay when Renderball generates.
              </span>
            </button>

            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-2.5 w-full rounded-lg border border-hairline bg-surface p-4 text-left transition-colors hover:bg-surface-2"
            >
              <span className="block text-[14px] font-semibold text-ink">
                Generate every page for me
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-soft">
                Describe the document and Renderball writes and designs the whole
                thing. Takes a few minutes and uses tokens.
              </span>
            </button>

            <p className="mt-4 font-mono text-[10.5px] text-faint">
              You can do both — generate a deck, then edit every element by hand.
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-ink"
            >
              ← back
            </button>
            <h2 className="mt-2 font-display text-[20px] font-bold tracking-tight text-ink">
              What is this document about?
            </h2>

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              autoFocus
              placeholder="A pitch deck for Northwind Coffee — office coffee subscriptions. Who it's for, the problem, the offer, and the ask."
              className="mt-3 w-full resize-y rounded-md border border-hairline bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-line"
            />

            <label className="mt-2.5 block">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Your site — so it looks like you (optional)
              </span>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="yoursite.com"
                className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-line"
              />
            </label>

            <label className="mt-2.5 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Pages
              </span>
              <input
                type="number"
                min={1}
                max={12}
                value={pages}
                onChange={(e) => setPages(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
                className="w-16 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-accent-line"
              />
            </label>

            {/* Deliberately CONSERVATIVE. At 40 chars/page this fired on a
                brief that named the audience, the problem and the ask in 165
                characters — good input, scolded. And the outline matrix shows
                a 91-character fragment producing 12 pages fine, so brevity is
                not a known cause of failure. It now speaks only for briefs
                that are tiny even by a generous reading. */}
            {prompt.trim().length > 0 && prompt.trim().length < pages * 15 && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-muted">
                That is short for {pages} page{pages === 1 ? "" : "s"} — a few
                sentences on who it is for, the problem, and what you are asking
                for gives it more to work with. You can generate anyway.
              </p>
            )}

            {busy ? (
              <GeneratingSteps steps={generatingSteps(pages, url)} elapsed={elapsed} pages={pages} />
            ) : (
              <button
                type="button"
                onClick={() => void generate()}
                className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
              >
                Generate the document
              </button>
            )}
            <p className="mt-2 text-center font-mono text-[10.5px] text-faint">
              You approve the outline before anything is designed.
            </p>
            {error && (
              <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5">
                <p className="text-[12.5px] leading-relaxed text-ink">{error}</p>
                <div className="mt-2 flex items-center gap-3">
                  {/* One click, brief intact. This failure looks intermittent —
                      it did not reproduce on a like-for-like retry — so the
                      cheapest useful thing is to make trying again cost
                      nothing but a click, rather than making someone wonder
                      whether their text survived. */}
                  <button
                    type="button"
                    onClick={() => void generate()}
                    disabled={busy}
                    className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    {busy ? "Trying…" : "Try again"}
                  </button>
                  <span className="font-mono text-[10.5px] text-faint">
                    your brief is still here · nothing was charged
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The steps, rendered. See generatingSteps above for why they are paced and
 * what is actually true on this screen.
 *
 * Pacing: a 3-page outline has measured ~29s and a 12-page one ~114s, so the
 * estimate scales with the page count. Steps advance through the estimate and
 * then STOP — the final one keeps breathing for as long as it takes, and past
 * a generous multiple of the estimate the copy says so out loud rather than
 * pretending the pace was right.
 */
function GeneratingSteps({
  steps,
  elapsed,
  pages,
}: {
  steps: string[];
  elapsed: number;
  pages: number;
}) {
  const estimate = 25 + pages * 6;
  const perStep = estimate / steps.length;
  // Never past the last index: the final step is where the wait lives.
  const active = Math.min(Math.floor(elapsed / perStep), steps.length - 1);
  const slow = elapsed > estimate * 2;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="mt-4 rounded-lg border border-hairline bg-surface-2 p-4">
      <ul className="flex flex-col gap-2">
        {steps.map((label, i) => {
          const done = i < active;
          const now = i === active;
          return (
            <li
              key={label}
              className="flex items-center gap-2.5"
              style={{ animation: `rb-fade-up 320ms ease-out both`, animationDelay: `${i * 60}ms` }}
            >
              <span
                aria-hidden
                className={`rb-step-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  done ? "bg-accent" : now ? "bg-accent" : "bg-hairline-strong"
                }`}
                style={now ? { animation: "rb-step-pulse 1.4s ease-in-out infinite" } : undefined}
              />
              <span
                className={`text-[12.5px] leading-relaxed ${
                  done ? "text-muted" : now ? "text-ink" : "text-faint"
                }`}
              >
                {label}
              </span>
              {now && (
                <span className="relative ml-1 h-px flex-1 overflow-hidden bg-hairline" aria-hidden>
                  <span
                    className="rb-step-sweep absolute inset-y-0 left-0 w-1/3 bg-accent/60"
                    style={{ animation: "rb-step-sweep 1.6s ease-in-out infinite" }}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-hairline pt-2.5">
        {/* The one number on this screen that is measured rather than paced. */}
        <span className="font-mono text-[11px] tabular-nums text-muted">{mmss}</span>
        <span className="text-[11px] leading-relaxed text-faint">
          {slow
            ? "Taking longer than usual — still working."
            : "You can close this tab; it finishes on its own."}
        </span>
      </div>
    </div>
  );
}
