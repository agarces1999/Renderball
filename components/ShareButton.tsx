"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The owner's control for the public link.
 *
 * Deliberately blunt about state, because "is this deck public?" is a question
 * a user should never have to guess at: the button itself says whether a link is
 * live, and the panel says in words who can open it. Sharing is off until
 * someone turns it on — no document becomes public as a side effect of anything.
 *
 * Copying is the primary action, because the reason anyone opens this panel is
 * to send the link to somebody.
 */
export function ShareButton({ scriptId }: { scriptId: string }) {
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "on" | "off" | "rotate">(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/preview/share?scriptId=${encodeURIComponent(scriptId)}`);
      const j = (await r.json()) as { shared?: boolean; url?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? "could not read the share status");
      setShared(!!j.shared);
      setUrl(j.url ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read the share status");
    }
  }, [scriptId]);

  useEffect(() => {
    if (open && shared === null) void load();
  }, [open, shared, load]);

  // Click away closes, like every other menu in the app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const absolute = url ? `${typeof window === "undefined" ? "" : window.location.origin}${url}` : "";

  const act = async (what: "on" | "off" | "rotate") => {
    setBusy(what);
    setError(null);
    try {
      const r = await fetch("/api/preview/share", {
        method: what === "off" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, rotate: what === "rotate" }),
      });
      const j = (await r.json()) as { shared?: boolean; url?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? "that didn't work");
      setShared(!!j.shared);
      setUrl(j.url ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("couldn't copy — select the link and copy it manually");
    }
  };

  return (
    <span className="relative" ref={panelRef}>
      <button
        type="button"
        data-rb-share
        onClick={() => setOpen((o) => !o)}
        className={
          "rounded-md border px-3 py-1.5 text-[12px] transition-colors " +
          (shared
            ? "border-accent-line bg-accent-soft text-accent-text"
            : "border-hairline-strong text-muted hover:text-ink")
        }
      >
        {shared ? "Shared" : "Share"}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Share this document"
          className="absolute right-0 top-full z-50 mt-2 w-[320px] rounded-lg border border-hairline bg-surface p-3 shadow-2xl"
        >
          {shared === null && <p className="text-[12px] text-muted">Checking…</p>}

          {shared === false && (
            <>
              <p className="text-[13px] font-medium text-ink">Share this deck</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                Anyone with the link can view it — no account needed. They can read
                the pages, and nothing else.
              </p>
              <button
                type="button"
                onClick={() => void act("on")}
                disabled={busy !== null}
                className="mt-3 w-full rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
              >
                {busy === "on" ? "Creating a link…" : "Create a link"}
              </button>
            </>
          )}

          {shared === true && (
            <>
              <p className="text-[13px] font-medium text-ink">Anyone with this link can view</p>
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  readOnly
                  value={absolute}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Public link"
                  className="h-[30px] min-w-0 flex-1 rounded-md bg-surface-2 px-2 font-mono text-[11px] text-ink outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-ink transition-all hover:brightness-110"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void act("off")}
                  disabled={busy !== null}
                  className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-[11.5px] text-muted transition-colors hover:text-ink disabled:opacity-50"
                >
                  {busy === "off" ? "Turning off…" : "Stop sharing"}
                </button>
                <button
                  type="button"
                  onClick={() => void act("rotate")}
                  disabled={busy !== null}
                  title="Issue a new link and break the old one"
                  className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-[11.5px] text-muted transition-colors hover:text-ink disabled:opacity-50"
                >
                  {busy === "rotate" ? "Replacing…" : "New link"}
                </button>
              </div>
              <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
                Stopping breaks the link immediately. Anyone still holding it sees
                nothing.
              </p>
            </>
          )}

          {error && <p className="mt-2 text-[11.5px] text-red-500">{error}</p>}
        </div>
      )}
    </span>
  );
}
