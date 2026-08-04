"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The deletable wrapper around a gallery card. Owns the card's grid slot
 * (`mb-3 break-inside-avoid`) so a confirmed delete can return null and the
 * card actually collapses out of the masonry — an overlay on a still-mounted
 * card just papers a caption over a dead slot until the full gallery refetch
 * lands, which on a cold container is slow enough to look broken.
 *
 * THE CONFIRM IS OURS, not the browser's. window.confirm was quick to write and
 * wrong on every axis a user notices: it says "renderball.com says", it lands in
 * the middle of the screen far from the card it is about to destroy, its buttons
 * are Chrome's and cannot say what they do, and it blocks the whole page. The
 * confirmation happens ON the card, in the app's own voice, next to the
 * thing being deleted.
 *
 * The row is gone from the database by the time the DELETE responds, so there
 * is nothing to wait for: unmount the card, then router.refresh() in the
 * background purely to reconcile the document count and the server tree.
 */
export function DeletableDocumentCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<"idle" | "confirming" | "deleting" | "gone">("idle");
  // The × renders only once hydrated: a pre-hydration click on the
  // server-rendered button was silently lost (same class as the start panel).
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
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
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
      // Stay on the confirm — it is the branch that renders the error, and it
      // leaves Cancel and a retry in reach. Dropping to "idle" dismissed the
      // overlay and the failure with it, which read as "the button is broken".
      setState("confirming");
    }
  };

  // Deleted: take the whole card out of layout immediately.
  if (state === "gone") return null;

  return (
    // The delete control is a SIBLING of the card link, not a child: a
    // <button> inside an <a> is invalid markup, and the click would navigate
    // anyway.
    <div className="group relative mb-3 break-inside-avoid">
      {children}
      {state === "confirming" || state === "deleting" ? (
        <ConfirmOverlay
          id={id}
          busy={state === "deleting"}
          error={error}
          onCancel={() => setState("idle")}
          onConfirm={() => void remove()}
        />
      ) : !live ? null : (
        <button
          type="button"
          // Clear any leftover failure from a previous attempt — the error
          // belongs to the moment it happened, not to the next confirm.
          onClick={() => {
            setError(null);
            setState("confirming");
          }}
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
      )}
    </div>
  );
}

function ConfirmOverlay({
  id,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  id: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-md border border-hairline-strong bg-surface/95 p-4 backdrop-blur-sm">
      <p className="text-center text-[13px] leading-snug text-ink">Delete this document?</p>
      <p className="text-center font-mono text-[10.5px] leading-relaxed text-faint">
        This can&rsquo;t be undone.
      </p>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
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
