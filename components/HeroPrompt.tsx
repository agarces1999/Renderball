"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Hero prompt — the intent-first entry on the landing page. The user starts
 * describing their deck right here; submitting carries the prompt (and
 * optional site URL) into /new via query params, where the brief form prefills
 * them. Unauthenticated users hit sign-in first and return to /new with the
 * prompt intact.
 */
const EXAMPLES = [
  "Seed pitch deck for our analytics startup",
  "Sales deck for outreach to marketing VPs",
  "All-hands deck for our Q3 update",
];

export function HeroPrompt() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");

  const go = () => {
    const params = new URLSearchParams();
    if (prompt.trim()) params.set("prompt", prompt.trim());
    if (url.trim()) params.set("url", url.trim());
    const qs = params.toString();
    router.push(`/new${qs ? `?${qs}` : ""}`);
  };

  return (
    <div className="mx-auto mt-9 w-full max-w-2xl text-left">
      <div className="rounded-lg border border-hairline-strong bg-surface p-2.5 shadow-[0_24px_60px_-30px_rgba(18,26,43,0.45)]">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              go();
            }
          }}
          rows={3}
          placeholder="Describe the deck you want — e.g. a 10-page seed pitch for our analytics startup, confident, ending on the ask."
          className="w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
        />
        <div className="flex flex-col gap-2 border-t border-hairline px-1 pt-2.5 sm:flex-row sm:items-center">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                go();
              }
            }}
            placeholder="yourwebsite.com  (optional — we pull your brand)"
            className="min-w-0 flex-1 rounded-md bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-ink outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={go}
            className="shrink-0 rounded-md bg-accent px-5 py-2 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Make a deck →
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-faint">Try:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setPrompt(ex)}
            className="rounded-full border border-hairline bg-surface px-3 py-1 text-[12.5px] text-muted transition-colors hover:border-hairline-strong hover:text-ink"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
