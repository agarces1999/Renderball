"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * M4 — the visual element editor overlay. Sits over the scene iframe (same
 * `relative` container, so absolute coords align with the iframe viewport). The
 * iframe's Composition wraps each piece in a `data-piece` element (display:contents,
 * zero layout cost), so a click inside the iframe resolves to its piece via
 * closest('[data-piece]'). We then draw a highlight + a toolbar and wire the
 * selected piece to the LEGO edit endpoints:
 *   - Regenerate → /api/preview/regenerate-element   (M2, one LLM call)
 *   - Delete     → /api/preview/edit-layout op:delete (M3, no LLM)
 *   - Drag       → /api/preview/edit-layout op:move   (M3, no LLM)
 * On success we bump the parent's reloadKey (onChanged) so the iframe re-renders the
 * new Composition.
 *
 * The base overlay is pointer-events:none so the selecting click reaches the iframe
 * (its own capture-phase listener does the resolution); only the toolbar + drag
 * handle opt back into pointer events.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Selected {
  pieceId: string;
  kind: string;
  rect: Rect;
}
interface Props {
  iframeRef: React.RefObject<HTMLIFrameElement>;
  scriptId: string;
  sceneIndex: number;
  reloadKey: number;
  /** canvas (composition) pixel dimensions — to convert a screen drag to canvas px */
  canvasWidth: number;
  /** called after a successful edit so the parent can reload the iframe */
  onChanged: () => void;
  /** endpoint base — "/api/preview" (auth) in the product, "/api/dev" in the harness */
  apiBase?: string;
}

export function ElementEditor({
  iframeRef,
  scriptId,
  sceneIndex,
  reloadKey,
  canvasWidth,
  onChanged,
  apiBase = "/api/preview",
}: Props) {
  const [selected, setSelected] = useState<Selected | null>(null);
  const [busy, setBusy] = useState<null | "regenerate" | "delete" | "move">(null);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; scale: number } | null>(null);
  const dragHandlersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);

  // A piece's wrapper is a display:contents node — it generates NO layout box, so
  // its own getBoundingClientRect() is all-zero. Measure the piece's VISIBLE extent
  // as the union of its rendered descendants' rects (a piece can have several
  // absolutely-positioned children). Returns null if the piece paints nothing.
  const rectOf = (el: Element): Rect | null => {
    const rects: DOMRect[] = [];
    const own = el.getBoundingClientRect();
    if (own.width > 0 && own.height > 0) rects.push(own);
    el.querySelectorAll("*").forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push(r);
    });
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  };

  // Reset selection whenever the scene or reload changes, and (re)attach the
  // click resolver to the fresh iframe document.
  useEffect(() => {
    setSelected(null);
    setError(null);
    const iframe = iframeRef.current;
    if (!iframe) return;
    let doc: Document | null = null;

    const onClick = (e: Event) => {
      const target = e.target as Element | null;
      const el = target?.closest?.("[data-piece]") as Element | null;
      if (!el || !el.getAttribute("data-piece")) {
        setSelected(null);
        return;
      }
      const rect = rectOf(el);
      if (!rect) {
        setSelected(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setSelected({
        pieceId: el.getAttribute("data-piece")!,
        kind: el.getAttribute("data-kind") ?? "",
        rect,
      });
    };

    const attach = () => {
      try {
        doc = iframe.contentDocument;
        doc?.addEventListener("click", onClick, true);
      } catch {
        /* cross-origin — should not happen (SAMEORIGIN) */
      }
    };

    if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") attach();
    iframe.addEventListener("load", attach);
    return () => {
      iframe.removeEventListener("load", attach);
      try {
        doc?.removeEventListener("click", onClick, true);
      } catch {
        /* ignore */
      }
    };
  }, [iframeRef, reloadKey, sceneIndex]);

  const post = useCallback(
    async (url: string, body: unknown): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setError(json.error || `request failed (${res.status})`);
          return false;
        }
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [],
  );

  const regenerate = async () => {
    if (!selected) return;
    setBusy("regenerate");
    const ok = await post(`${apiBase}/regenerate-element`, {
      scriptId,
      sceneIndex,
      pieceId: selected.pieceId,
    });
    setBusy(null);
    if (ok) {
      setSelected(null);
      onChanged();
    }
  };

  const remove = async () => {
    if (!selected) return;
    setBusy("delete");
    const ok = await post(`${apiBase}/edit-layout`, {
      scriptId,
      sceneIndex,
      pieceId: selected.pieceId,
      op: "delete",
    });
    setBusy(null);
    if (ok) {
      setSelected(null);
      onChanged();
    }
  };

  // ---- drag to move -------------------------------------------------------
  const canvasScale = (): number => {
    const canvas = iframeRef.current?.contentDocument?.querySelector(".renderball-canvas");
    if (!canvas || canvasWidth <= 0) return 1;
    const w = (canvas as HTMLElement).getBoundingClientRect().width;
    return w > 0 ? w / canvasWidth : 1;
  };

  const detachDrag = () => {
    const h = dragHandlersRef.current;
    if (h) {
      window.removeEventListener("mousemove", h.move);
      window.removeEventListener("mouseup", h.up);
      dragHandlersRef.current = null;
    }
  };

  const onDragStart = (e: React.MouseEvent) => {
    if (!selected || busy) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, scale: canvasScale() };
    setDragDelta({ dx: 0, dy: 0 });

    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setDragDelta({ dx: ev.clientX - d.startX, dy: ev.clientY - d.startY });
    };
    const up = async (ev: MouseEvent) => {
      detachDrag();
      const d = dragRef.current;
      dragRef.current = null;
      setDragDelta(null);
      if (!d || !selected) return;
      const scale = d.scale || 1;
      const dx = Math.round((ev.clientX - d.startX) / scale);
      const dy = Math.round((ev.clientY - d.startY) / scale);
      if (dx === 0 && dy === 0) return;
      setBusy("move");
      const ok = await post(`${apiBase}/edit-layout`, {
        scriptId,
        sceneIndex,
        pieceId: selected.pieceId,
        op: "move",
        dx,
        dy,
      });
      setBusy(null);
      if (ok) {
        setSelected(null);
        onChanged();
      }
    };

    dragHandlersRef.current = { move, up };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Remove any live drag listeners if the overlay unmounts mid-drag (e.g. editing
  // toggled off while the mouse is held), so a stray mouseup can't fire a stale move.
  useEffect(() => detachDrag, []);

  const box = selected
    ? {
        left: selected.rect.left + (dragDelta?.dx ?? 0),
        top: selected.rect.top + (dragDelta?.dy ?? 0),
        width: selected.rect.width,
        height: selected.rect.height,
      }
    : null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {/* hint when nothing selected */}
      {!selected && (
        <div
          style={{ pointerEvents: "none" }}
          className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium text-white/90"
        >
          Click an element to edit it
        </div>
      )}

      {box && selected && (
        <>
          {/* highlight */}
          <div
            style={{
              position: "absolute",
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              border: "2px solid #6366f1",
              borderRadius: 6,
              boxShadow: "0 0 0 9999px rgba(10,12,20,0.28)",
              pointerEvents: "none",
              transition: dragDelta ? "none" : "left 60ms, top 60ms",
            }}
          />
          {/* drag handle (fills the box, opts into pointer events) */}
          <div
            onMouseDown={onDragStart}
            title="Drag to move"
            style={{
              position: "absolute",
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              cursor: busy ? "wait" : "move",
              pointerEvents: "auto",
            }}
          />
          {/* toolbar */}
          <div
            style={{
              position: "absolute",
              left: Math.max(4, box.left),
              top: Math.max(4, box.top - 42),
              pointerEvents: "auto",
            }}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#11141b] px-1.5 py-1 shadow-xl"
          >
            <span className="px-1.5 font-mono text-[10px] text-white/45">
              {selected.pieceId}
              <span className="ml-1 text-white/25">{selected.kind}</span>
            </span>
            <button
              type="button"
              onClick={regenerate}
              disabled={!!busy}
              className="rounded-md bg-indigo-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy === "regenerate" ? "Regenerating…" : "Regenerate"}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={!!busy}
              className="rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/80 hover:bg-red-500/80 hover:text-white disabled:opacity-50"
            >
              {busy === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        </>
      )}

      {error && (
        <div
          style={{ pointerEvents: "auto" }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-red-600/90 px-3 py-1.5 text-[11px] text-white"
        >
          {error}
        </div>
      )}
    </div>
  );
}
