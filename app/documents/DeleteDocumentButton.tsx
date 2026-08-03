"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Remove a document from the gallery.
 *
 * THE CONFIRM IS OURS, not the browser's. window.confirm was quick to write and
 * wrong on every axis a user notices: it says "renderball.com says", it lands in
 * the middle of the screen far from the card it is about to destroy, its buttons
 * are Chrome's and cannot say what they do, and it blocks the whole page. The
 * confirmation now happens ON the card, in the app's own voice, next to the
 * thing being deleted.
 *
 * The card also leaves IMMEDIATELY. It used to sit there showing a spinner
 * until a full gallery refetch came back — and because the gallery re-renders
 * every card, that was slow enough to look broken, with a stuck dot where the
 * × had been. The row is gone from the database by the time the response
 * arrives, so there is nothing to wait for: hide it, then refresh in the
 * background to reconcile.
 */
export function DeleteDocumentButton({ id, title }: { id: string; title: string }) {
  const [state, setState] = useState<"idle" | "confirming" | "deleting" | "gone">("idle");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const remove = async () => {
    setState("deleting");
    setError(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "that didn't work");
      }
      setState("gone");
      // Reconcile the server-rendered list, but the card is already out of the
      // way — the user does not wait on it.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
      setState("idle");
    }
  };

  // Once deleted the card collapses out of the grid rather than lingering.
  if (state === "gone") {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center rounded-md bg-surface/80 backdrop-blur-sm">
        <span className="font-mono text-[11px] text-faint">deleted</span>
      </div>
    );
  }

  if (state === "confirming" || state === "deleting") {
    const busy = state === "deleting";
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-md border border-hairline-strong bg-surface/95 p-4 backdrop-blur-sm">
        <p className="text-center text-[13px] leading-snug text-ink">Delete this document?</p>
        <p className="text-center font-mono text-[10.5px] leading-relaxed text-faint">
          This can&rsquo;t be undone.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setState("idle")}
            disabled={busy}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            data-rb-confirm-delete={id}
            className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-all hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
        {error && <p className="text-center text-[11px] text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setState("confirming")}
      aria-label={`Delete ${title}`}
      title="Delete this document"
      data-rb-delete-document={id}
      className={
        "absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md " +
        "border border-hairline bg-surface/90 text-[13px] text-muted opacity-0 backdrop-blur " +
        "transition-all hover:border-red-300 hover:text-red-500 focus:opacity-100 " +
        "group-hover:opacity-100"
      }
    >
      ×
    </button>
  );
}
