"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

/**
 * The "Open the editor" CTA with an explicit mobile story (founder-endorsed,
 * 2026-08-29: "even 'desktop-only, here's a link to yourself' is better than
 * a canvas that half-works"). On viewports under 768px the first tap opens a
 * small honest card — Renderball is a desktop canvas — offering a
 * mail-yourself link and a continue-anyway escape. Desktop taps navigate
 * immediately; nothing changes there.
 */
export function EditorCta({
  className,
  children,
  centerCard,
}: {
  className: string;
  children: ReactNode;
  /** Center the gate card (for centered sections like the footer CTA). */
  centerCard?: boolean;
}) {
  const [gate, setGate] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Link
        href="/api/documents/new"
        prefetch={false}
        className={className}
        onClick={(e) => {
          if (window.innerWidth < 768 && !gate) {
            e.preventDefault();
            setGate(true);
          }
        }}
      >
        {children}
      </Link>
      {gate && (
        <div
          className={
            "mt-3 w-full max-w-[420px] rounded-xl border border-hairline bg-surface p-4 text-left shadow-sm" +
            (centerCard ? " mx-auto" : "")
          }
        >
          <p className="text-[13.5px] leading-relaxed text-ink-soft">
            Renderball is a desktop canvas — drawing boxes and editing elements
            want a mouse and a big screen.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Clipboard first (reliability pass, 2026-08-31): mailto: is
                flaky inside mobile in-app browsers; copying never is. The
                mailto stays as the second door. */}
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText("https://renderball.com")
                  .then(() => setCopied(true))
                  .catch(() => {});
              }}
              className="rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-ink"
            >
              {copied ? "Copied ✓" : "Copy the link"}
            </button>
            <a
              href="mailto:?subject=Renderball&body=Open%20Renderball%20on%20your%20computer%3A%20https%3A%2F%2Frenderball.com"
              className="rounded-full border border-hairline px-4 py-2 text-[12.5px] text-muted transition-colors hover:text-ink"
            >
              Email it to me
            </a>
            <Link
              href="/api/documents/new"
              prefetch={false}
              className="rounded-full border border-hairline px-4 py-2 text-[12.5px] text-muted transition-colors hover:text-ink"
            >
              Continue anyway
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
