"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * The read-only deck viewer a shared link opens.
 *
 * Everything the editor puts on screen is absent here on purpose: no toolbar, no
 * selection, no grips, no panels. A visitor is reading a document someone sent
 * them, so the page is the deck plus the smallest possible amount of chrome —
 * page position, the two arrows, and a quiet Renderball mark that is the only
 * thing selling anything.
 *
 * Navigation is keyboard-first because that is how people actually read a deck:
 * arrows and space page forward, Home/End jump the ends. The iframe swallows key
 * events when it has focus, so the listener also runs INSIDE the frame — the same
 * trap that once made the editor's canvas inert. Touch swipes bind there too:
 * listeners inside the frame's document mean nothing ever sits between the mouse
 * and the slide, so text selection survives on every device, hybrids included.
 */
export function ShareViewer({
  token,
  title,
  pages,
}: {
  token: string;
  title: string;
  pages: { label: string }[];
}) {
  const [index, setIndex] = useState(0);
  // The first slide is server-rendered on demand — seconds on a cold container —
  // so it starts veiled by the same counter overlay every later page turn gets.
  const [loading, setLoading] = useState(true);
  const total = pages.length;

  const turn = useCallback(
    (to: (i: number) => number) =>
      setIndex((i) => {
        const n = to(i);
        if (n !== i) setLoading(true);
        return n;
      }),
    [],
  );
  const go = useCallback(
    (next: number) => turn(() => Math.max(0, Math.min(total - 1, next))),
    [total, turn],
  );
  const prev = useCallback(() => turn((i) => Math.max(0, i - 1)), [turn]);
  const next = useCallback(() => turn((i) => Math.min(total - 1, i + 1)), [total, turn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(total - 1);
          break;
      }
    };
    // Swipe start lives in a plain closure, not state — these are raw DOM
    // listeners on the frame's document, re-created whenever the page changes.
    let swipeStart: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      // A second finger means a pinch — that is zoom, never a page turn.
      swipeStart = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const start = swipeStart;
      swipeStart = null;
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) next();
      else prev();
    };
    window.addEventListener("keydown", onKey);
    // The slide is an iframe; once it has focus, keystrokes go to ITS document
    // and never reach the parent. Bind there too, re-binding as pages change.
    // Swipes bind the same way — inside the frame, so no layer ever sits between
    // the mouse and the slide. pan-y keeps vertical scroll native, pinch-zoom
    // keeps zoom alive (phone recipients read 1920px slides at ~18% scale), and
    // horizontal drags are left for the swipe listeners to read.
    const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
    const bind = () => {
      const doc = frame?.contentDocument;
      if (!doc) return;
      doc.addEventListener("keydown", onKey);
      doc.addEventListener("touchstart", onTouchStart);
      doc.addEventListener("touchend", onTouchEnd);
      doc.documentElement?.style.setProperty("touch-action", "pan-y pinch-zoom");
    };
    bind();
    frame?.addEventListener("load", bind);
    return () => {
      window.removeEventListener("keydown", onKey);
      frame?.contentDocument?.removeEventListener("keydown", onKey);
      frame?.contentDocument?.removeEventListener("touchstart", onTouchStart);
      frame?.contentDocument?.removeEventListener("touchend", onTouchEnd);
      frame?.removeEventListener("load", bind);
    };
  }, [next, prev, go, total, index]);

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="flex shrink-0 items-center justify-between gap-4 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="orb h-5 w-5 shrink-0" aria-hidden />
          <span className="truncate text-[14px] font-medium text-ink">{title}</span>
        </div>
        <Link
          href="/"
          className="shrink-0 font-mono text-[11px] text-muted transition-colors hover:text-ink"
        >
          Made with Renderball
        </Link>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-5 pb-3">
        <div
          className="relative w-full overflow-hidden rounded-lg border border-hairline bg-surface shadow-[0_30px_80px_-42px_rgba(18,26,43,0.5)]"
          style={{ aspectRatio: "16/9", maxWidth: "calc((100vh - 150px) * 16 / 9)" }}
        >
          <iframe
            // The key forces a fresh document per page, so a viewer never sees
            // the previous slide while the next one loads.
            key={index}
            src={`/api/share/${encodeURIComponent(token)}/iframe?scene=${index}`}
            title={`${title} — page ${index + 1} of ${total}`}
            onLoad={() => setLoading(false)}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface">
              <span className="font-mono text-[12px] text-faint">
                {index + 1} / {total}
              </span>
            </div>
          )}
        </div>
      </main>

      <footer className="flex shrink-0 items-center justify-center gap-3 pb-5">
        <button
          type="button"
          onClick={prev}
          disabled={index === 0}
          aria-label="Previous page"
          className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-35"
        >
          ←
        </button>
        <span className="font-mono text-[11.5px] tabular-nums text-muted">
          {index + 1} / {total}
        </span>
        <button
          type="button"
          onClick={next}
          disabled={index >= total - 1}
          aria-label="Next page"
          className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-35"
        >
          →
        </button>
      </footer>
    </div>
  );
}
