"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Remove a document from the gallery.
 *
 * There was no way to delete a deck at all — you could make them and never get
 * rid of them. So this is a new destructive action in a place where the user's
 * work lives, and it is built to be hard to trigger by accident and impossible
 * to trigger invisibly:
 *
 *   * Hidden until the card is hovered, so it never competes with the deck.
 *   * A real confirm naming the document, because a deck cost minutes and money
 *     to generate and there is no undo for this one.
 *   * A sibling of the card's link, not a child — a <button> inside an <a> is
 *     invalid markup and the click would navigate anyway.
 */
export function DeleteDocumentButton({ id, title }: { id: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const remove = async () => {
    const label = title.length > 60 ? `${title.slice(0, 60)}…` : title;
    if (!window.confirm(`Delete “${label}”?\n\nThis removes the document and everything in it. It can't be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "that didn't work");
      }
      // The gallery is server-rendered, so the row has to be refetched rather
      // than spliced out of local state.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        aria-label={`Delete ${title}`}
        title="Delete this document"
        data-rb-delete-document={id}
        className={
          "absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md " +
          "border border-hairline bg-surface/90 text-[13px] text-muted opacity-0 backdrop-blur " +
          "transition-all hover:border-red-300 hover:text-red-500 focus:opacity-100 " +
          "group-hover:opacity-100 disabled:opacity-60"
        }
      >
        {busy ? "·" : "×"}
      </button>
      {error && (
        <p className="absolute inset-x-2 bottom-2 z-10 rounded bg-red-600/90 px-2 py-1 text-[11px] text-white">
          {error}
        </p>
      )}
    </>
  );
}
