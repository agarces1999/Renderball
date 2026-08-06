"use client";

import { useEffect, useState } from "react";
import {
  clearSandboxState,
  composeBriefFromSandbox,
  describeSandbox,
  loadSandboxState,
  type LandingSandboxState,
} from "../lib/landing-sandbox";

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
 */
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
  const [error, setError] = useState<string | null>(null);

  // ─── Continue what you started (landing-canvas sandbox) ────────────
  // The landing stage serializes the visitor's drawn boxes + chosen
  // intents to localStorage. The old /new front door read it back after
  // sign-in; now that / goes straight to /documents, this panel — the
  // first surface of a fresh document — is where that promise is kept.
  // Honest smallest version: the intents become words in the generate
  // prompt the user can read and edit — no forged document. "start
  // clean" is the escape hatch; both paths clear the stored canvas.
  const [landingSeed, setLandingSeed] = useState<LandingSandboxState | null>(
    null,
  );
  useEffect(() => {
    const s = loadSandboxState();
    if (s && s.elements.length > 0) setLandingSeed(s);
  }, []);
  const continueFromLanding = () => {
    if (!landingSeed) return;
    setPrompt(composeBriefFromSandbox(landingSeed));
    clearSandboxState();
    setLandingSeed(null);
    setOpen(true);
  };
  const startClean = () => {
    clearSandboxState();
    setLandingSeed(null);
  };

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

            {landingSeed && (
              /* Quiet on purpose: an accent fill here put a SECOND green card
                 on the panel, competing with "Build it yourself" for primacy
                 while actually belonging to the generate option below it. This
                 is a helper for that option, not a third choice. */
              <div className="mt-4 rounded-lg border border-hairline bg-surface-2 px-4 py-3">
                <p className="text-[12.5px] leading-relaxed text-ink-soft">
                  On the home page you sketched {describeSandbox(landingSeed)}.{" "}
                  Renderball can write that up as the starting description for
                  the deck below.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={continueFromLanding}
                    className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface"
                  >
                    Use it as my brief →
                  </button>
                  <span className="text-[11.5px] text-muted">
                    writes it out for you to edit — nothing is spent until you generate
                  </span>
                  <button
                    type="button"
                    onClick={startClean}
                    className="text-[11.5px] text-muted underline underline-offset-2 transition-colors hover:text-ink"
                  >
                    forget it
                  </button>
                </div>
              </div>
            )}

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

            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy}
              className="mt-4 w-full rounded-md bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Starting…" : "Generate the document"}
            </button>
            <p className="mt-2 text-center font-mono text-[10.5px] text-faint">
              You approve the outline before anything is designed.
            </p>
            {error && (
              <p className="mt-2 text-center font-mono text-[11px] text-red-500">{error}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
