"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The element's own panel (founder, 2026-08-14, from the Gamma comparison):
 * click an element, see the instruction that made it, edit that instruction,
 * regenerate. The side rail's third tab, alive only while something is
 * selected.
 *
 * Provenance honesty: three different origins get three different labels —
 * a marquee ask ("You asked for"), a regen ("Last regenerated with"), a hand
 * add ("Added by hand"). Elements with no kept instruction were born with
 * their page, so the page's visual brief is shown as context instead — the
 * truthful answer, not a fabricated prompt.
 *
 * The regenerate below reuses the SAME per-element route the canvas toolbar
 * uses ({scriptId, sceneIndex, pieceId, instruction}); on success the parent
 * bumps the iframe and this panel refetches, so the prompt shown is always
 * the one that produced what the user is looking at.
 */

interface Provenance {
  origin: "marquee" | "regen" | "added";
  prompt?: string;
  at: string;
}

export function ElementPanel({
  scriptId,
  pieceId,
  kind,
  pageBrief,
  busy,
  onRegenerate,
}: {
  scriptId: string;
  pieceId: string;
  kind: string;
  /** The page's visual brief — the honest context for build-born elements. */
  pageBrief: string | null;
  /** The editor's busy line — regen state AND the race guard. */
  busy: string | null;
  /**
   * Runs the EDITOR's regenerate on the selected piece (via its handle), not
   * a direct fetch: the editor keeps the selection alive across the reload
   * (reselectIdRef), so this panel survives its own success. The first live
   * probe of the fetch version watched the tab disappear mid-regen.
   */
  onRegenerate: (instruction: string) => void;
}) {
  const [map, setMap] = useState<Record<string, Provenance>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seededFor = useRef<{ pieceId: string; value: string } | null>(null);
  const working = busy === "regenerate";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/preview/provenance?scriptId=${encodeURIComponent(scriptId)}`);
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as { provenance?: Record<string, Provenance> } | null;
        if (!cancelled && data?.provenance) setMap(data.provenance);
      } catch {
        /* the panel degrades to the page-brief fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
    // `busy` in the deps on purpose: when a regen finishes (busy → null), the
    // sidecar just gained the instruction this panel must now display.
  }, [scriptId, pieceId, busy]);

  const prov = map[pieceId];
  useEffect(() => {
    const incoming = prov?.prompt ?? "";
    if (seededFor.current?.pieceId === pieceId) {
      // Same element, but the provenance fetch landed AFTER the first seed —
      // adopt the remembered prompt only if the user hasn't typed over the
      // seed. Without this, the panel mounted before the fetch, seeded "",
      // and "Last regenerated with:" sat above an empty box (seen live,
      // 2026-08-14).
      if (incoming && incoming !== seededFor.current.value) {
        const lastSeed = seededFor.current.value;
        setDraft((d) => {
          if (d === lastSeed) {
            seededFor.current = { pieceId, value: incoming };
            return incoming;
          }
          return d;
        });
      }
      return;
    }
    seededFor.current = { pieceId, value: incoming };
    setDraft(incoming);
    setError(null);
  }, [pieceId, prov?.prompt]);

  const originLine = prov
    ? prov.origin === "marquee"
      ? "You asked for:"
      : prov.origin === "regen"
        ? "Last regenerated with:"
        : "Added by hand — no prompt."
    : "Born with this page. Its visual brief:";

  const regenerate = () => {
    const instruction = draft.trim();
    if (!instruction || busy) return;
    setError(null);
    onRegenerate(instruction);
  };

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Element</p>
        <p className="mt-1 text-[13px] font-medium capitalize text-ink">{kind || "element"}</p>
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{originLine}</p>
        {!prov && (
          <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
            {pageBrief || "No brief was recorded for this page."}
          </p>
        )}
      </div>

      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          {prov?.prompt ? "Edit the prompt" : "Tell it what this should be"}
        </span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          disabled={working}
          placeholder='e.g. "a KPI tile showing 92% automation, bolder, brand accent"'
          className="mt-1.5 w-full resize-y rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none focus:border-accent-line disabled:opacity-60"
        />
      </label>

      <button
        type="button"
        disabled={working || !!busy || !draft.trim()}
        onClick={regenerate}
        className="w-full rounded-md bg-accent px-3 py-2 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
      >
        {working ? "Regenerating…" : "Regenerate this element"}
      </button>
      <p className="text-center font-mono text-[10px] text-faint">
        uses tokens · only this element changes
      </p>
      {error && <p className="text-[12px] leading-relaxed text-ink">{error}</p>}
    </div>
  );
}
