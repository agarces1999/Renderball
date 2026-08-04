"use client";

import { useEffect, useState } from "react";

/**
 * Self-serve account deletion — typed confirmation, in the app's own voice.
 *
 * This section did not exist: the privacy policy promised deletion, and the
 * only mechanism was a Clerk webhook that is env-gated off until its secret
 * is configured. Deleting an account is the one action here that cannot be
 * undone, so it asks for the word to be typed rather than clicked past.
 */
export function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Render only once hydrated — a dead destructive button is worse than a
  // momentarily absent one (same rule as the start panel and gallery ×).
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  if (!live) return null;

  const armed = phrase.trim().toLowerCase() === "delete my account";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "That didn't work — nothing was deleted. Try again.");
        setBusy(false);
        return;
      }
      // The Clerk identity is gone; a hard navigation drops the dead session.
      window.location.assign("/");
    } catch {
      setError("Network error — nothing was deleted. Try again.");
      setBusy(false);
    }
  };

  return (
    <section className="mt-10 rounded-lg border border-red-200 bg-surface p-6">
      <h2 className="text-[15px] font-semibold text-ink">Delete account</h2>
      <p className="mt-1 max-w-[60ch] text-[13.5px] leading-relaxed text-muted">
        Removes your sign-in, every document, and every stored file — the full
        deletion our privacy policy describes. There is no undo and nothing is
        kept.
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-md border border-red-300 px-3.5 py-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50"
        >
          Delete my account…
        </button>
      ) : (
        <div className="mt-4">
          <label className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
            Type <span className="select-all text-ink">delete my account</span> to confirm
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoFocus
              className="w-64 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-red-300"
            />
            <button
              type="button"
              onClick={() => void run()}
              disabled={!armed || busy}
              className="rounded-md bg-red-600 px-3.5 py-1.5 text-[13px] font-semibold text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete forever"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPhrase("");
                setError(null);
              }}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error && <p className="mt-2 text-[12.5px] text-red-600">{error}</p>}
        </div>
      )}
    </section>
  );
}
