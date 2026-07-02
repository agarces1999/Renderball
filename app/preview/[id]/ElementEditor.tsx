"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { matchFieldPath } from "../../../lib/edit/scene-content";

/**
 * The visual element editor overlay. Sits over the scene iframe (same `relative`
 * container, so absolute coords align with the iframe viewport). Each piece renders a
 * `data-piece` wrapper (display:contents), so a click/hover resolves to its piece via
 * closest('[data-piece]'). Actions are kind-aware:
 *   - any piece:  Regenerate (M2 LLM) · Delete (M3) · drag to Move (M3)
 *   - text piece: also Edit text — inline, no-LLM. The clicked copy field becomes
 *     contentEditable IN the iframe; on save we POST edit-element (by data-content-path
 *     when tagged, else by matching the old text) which updates the script and reloads.
 * Discovery: hover reveals one piece; "Show all pieces" outlines the whole skeleton.
 *
 * Base overlay is pointer-events:none so the selecting click reaches the iframe; only
 * the toolbar, drag handle, and controls opt back in.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface PieceRef {
  pieceId: string;
  kind: string;
  rect: Rect;
}
interface TextTarget {
  el: HTMLElement;
  path?: string;
  oldText: string;
}
interface Props {
  iframeRef: React.RefObject<HTMLIFrameElement>;
  scriptId: string;
  sceneIndex: number;
  reloadKey: number;
  canvasWidth: number;
  onChanged: () => void;
  apiBase?: string;
}

const BLOCK_TEXT = /^(H[1-6]|P|LI|DIV|FIGCAPTION|LABEL|BLOCKQUOTE|DD|DT|TD|TH)$/;

export function ElementEditor({
  iframeRef,
  scriptId,
  sceneIndex,
  reloadKey,
  canvasWidth,
  onChanged,
  apiBase = "/api/preview",
}: Props) {
  const [selected, setSelected] = useState<PieceRef | null>(null);
  const [hovered, setHovered] = useState<PieceRef | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [allPieces, setAllPieces] = useState<PieceRef[]>([]);
  const [busy, setBusy] = useState<null | "regenerate" | "delete" | "move" | "text">(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const editingRef = useRef(false);
  const textTargetRef = useRef<TextTarget | null>(null);
  // The scene's editable copy fields (path+value), fetched so we can tell whether a
  // clicked text element is bound content and resolve its exact path — the affordance
  // for "Edit text" appears only on text that actually maps to a field.
  const fieldsRef = useRef<{ path: string; value: string }[]>([]);
  const dragRef = useRef<{ startX: number; startY: number; scale: number } | null>(null);
  const dragHandlersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);

  // A piece's wrapper is display:contents (no box), so its own rect is all-zero.
  // Measure its extent as the union of its rendered descendants' non-zero rects.
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

  const post = useCallback(async (url: string, body: unknown): Promise<boolean> => {
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
  }, []);

  // Resolve the clicked node to the copy field it belongs to: a data-content-path
  // element (precise) or the nearest block-level text element within the piece. When
  // untagged, we match the text against the fetched field list to recover its path —
  // so a headline living inside a diegetic piece (no data-content-path) is still editable.
  const resolveTextTarget = (clicked: Element, piece: Element): TextTarget | null => {
    const tagged = clicked.closest("[data-content-path]") as HTMLElement | null;
    if (tagged && piece.contains(tagged) && (tagged.textContent ?? "").trim()) {
      return { el: tagged, path: tagged.getAttribute("data-content-path") ?? undefined, oldText: (tagged.textContent ?? "").trim() };
    }
    let el: Element | null = clicked;
    while (el && el !== piece.parentElement) {
      if (BLOCK_TEXT.test(el.tagName) && (el.textContent ?? "").trim()) {
        const oldText = (el.textContent ?? "").trim();
        return { el: el as HTMLElement, oldText, path: matchFieldPath(fieldsRef.current, oldText) ?? undefined };
      }
      el = el.parentElement;
    }
    return null;
  };

  // ---- inline text edit ---------------------------------------------------
  const startTextEdit = (tt: TextTarget) => {
    const el = tt.el;
    if (!el.isConnected) return;
    const savedHTML = el.innerHTML;
    el.textContent = tt.oldText; // flatten accent spans etc. for clean editing
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "false");
    el.style.outline = "2px solid #378add";
    el.style.outlineOffset = "2px";
    el.style.cursor = "text";
    editingRef.current = true;
    setEditing(true);
    setSelected(null);
    setHovered(null);

    el.focus();
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("keydown", onKey);
      el.removeAttribute("contenteditable");
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.style.cursor = "";
      editingRef.current = false;
      setEditing(false);
      const newText = (el.textContent ?? "").trim();
      if (!save || newText.length === 0 || newText === tt.oldText) {
        el.innerHTML = savedHTML; // restore original markup
        return;
      }
      setBusy("text");
      const ok = await post(`${apiBase}/edit-element`, {
        scriptId,
        sceneIndex,
        op: "edit",
        ...(tt.path ? { path: tt.path } : {}),
        matchText: tt.oldText,
        value: newText,
      });
      setBusy(null);
      if (ok) onChanged(); // reload re-SSRs with the new copy + re-applies accents
      else el.innerHTML = savedHTML;
    };
    const onBlur = () => finish(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        el.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
        el.blur();
      }
    };
    el.addEventListener("blur", onBlur);
    el.addEventListener("keydown", onKey);
  };

  const editTextFromToolbar = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !selected) return;
    let tt = textTargetRef.current;
    if (!tt || !tt.el.isConnected) {
      const piece = doc.querySelector(`[data-piece="${selected.pieceId}"]`);
      if (piece) {
        const cand = piece.querySelector("[data-content-path], h1, h2, h3, p, li");
        const t = (cand?.textContent ?? "").trim();
        if (cand && t)
          tt = {
            el: cand as HTMLElement,
            path: (cand as HTMLElement).getAttribute("data-content-path") ?? matchFieldPath(fieldsRef.current, t) ?? undefined,
            oldText: t,
          };
      }
    }
    if (tt) startTextEdit(tt);
  };

  // ---- attach resolver + hover to the iframe document ---------------------
  useEffect(() => {
    setSelected(null);
    setHovered(null);
    setError(null);
    editingRef.current = false;
    setEditing(false);
    textTargetRef.current = null;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let doc: Document | null = null;
    let lastHover = "";

    const onClick = (e: Event) => {
      if (editingRef.current) return;
      const target = e.target as Element | null;
      const piece = target?.closest?.("[data-piece]") as Element | null;
      if (!piece || !piece.getAttribute("data-piece")) {
        setSelected(null);
        return;
      }
      const rect = rectOf(piece);
      if (!rect) {
        setSelected(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      textTargetRef.current = target ? resolveTextTarget(target, piece) : null;
      setSelected({ pieceId: piece.getAttribute("data-piece")!, kind: piece.getAttribute("data-kind") ?? "", rect });
    };

    const onDbl = (e: Event) => {
      const target = e.target as Element | null;
      const piece = target?.closest?.("[data-piece]") as Element | null;
      if (!piece || !target) return;
      const tt = resolveTextTarget(target, piece);
      if (tt) {
        e.preventDefault();
        e.stopPropagation();
        startTextEdit(tt);
      }
    };

    const onOver = (e: Event) => {
      if (editingRef.current) return;
      const piece = (e.target as Element | null)?.closest?.("[data-piece]") as Element | null;
      const id = piece?.getAttribute("data-piece") ?? "";
      if (id === lastHover) return;
      lastHover = id;
      if (!piece || !id) {
        setHovered(null);
        return;
      }
      const rect = rectOf(piece);
      setHovered(rect ? { pieceId: id, kind: piece.getAttribute("data-kind") ?? "", rect } : null);
    };
    const onLeave = () => {
      lastHover = "";
      setHovered(null);
    };

    const attach = () => {
      try {
        doc = iframe.contentDocument;
        if (!doc) return;
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("dblclick", onDbl, true);
        doc.addEventListener("mouseover", onOver, true);
        doc.addEventListener("mouseleave", onLeave, true);
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
        doc?.removeEventListener("dblclick", onDbl, true);
        doc?.removeEventListener("mouseover", onOver, true);
        doc?.removeEventListener("mouseleave", onLeave, true);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeRef, reloadKey, sceneIndex]);

  // Fetch this scene's editable copy fields so text affordances are precise (offer
  // "Edit text" only on bound content, and resolve its exact path). Refreshes on scene
  // change and after any edit (reloadKey) so matches track the current copy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/edit-element?scriptId=${encodeURIComponent(scriptId)}&sceneIndex=${sceneIndex}`);
        const json = (await res.json().catch(() => ({}))) as { fields?: { path: string; value: string }[] };
        if (!cancelled) fieldsRef.current = Array.isArray(json.fields) ? json.fields : [];
      } catch {
        if (!cancelled) fieldsRef.current = [];
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, scriptId, sceneIndex, reloadKey]);

  // Compute every piece's rect for the "show all" x-ray.
  useEffect(() => {
    if (!showAll) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const out: PieceRef[] = [];
    doc.querySelectorAll("[data-piece]").forEach((el) => {
      const id = el.getAttribute("data-piece");
      if (!id) return;
      const rect = rectOf(el);
      if (rect) out.push({ pieceId: id, kind: el.getAttribute("data-kind") ?? "", rect });
    });
    setAllPieces(out);
  }, [showAll, reloadKey, sceneIndex, iframeRef]);

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
      const ok = await post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId: selected.pieceId, op: "move", dx, dy });
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
  useEffect(() => detachDrag, []);

  const regenerate = async () => {
    if (!selected) return;
    setBusy("regenerate");
    const ok = await post(`${apiBase}/regenerate-element`, { scriptId, sceneIndex, pieceId: selected.pieceId });
    setBusy(null);
    if (ok) {
      setSelected(null);
      onChanged();
    }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy("delete");
    const ok = await post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId: selected.pieceId, op: "delete" });
    setBusy(null);
    if (ok) {
      setSelected(null);
      onChanged();
    }
  };

  const box = selected
    ? {
        left: selected.rect.left + (dragDelta?.dx ?? 0),
        top: selected.rect.top + (dragDelta?.dy ?? 0),
        width: selected.rect.width,
        height: selected.rect.height,
      }
    : null;
  // Offer "Edit text" for pure-copy pieces (text/chrome always render bound content) and,
  // for any other kind, when the click resolved to bound copy — a data-content-path tag or
  // a text-to-field match (textTargetRef.path). So a headline inside a diegetic piece is
  // editable, while decorative diegetic labels that map to no field are not (no dead-end).
  const canEditText =
    !!selected && (selected.kind === "text" || selected.kind === "chrome" || !!textTargetRef.current?.path);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {/* show-all toggle + hint */}
      <button
        type="button"
        onClick={() => setShowAll((s) => !s)}
        style={{ pointerEvents: "auto" }}
        className={
          "absolute right-2 top-2 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium " +
          (showAll ? "bg-indigo-500 text-white" : "bg-black/55 text-white/85 hover:bg-black/70")
        }
      >
        {showAll ? "Hide outlines" : "Show all pieces"}
      </button>
      {!selected && !editing && (
        <div
          style={{ pointerEvents: "none" }}
          className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] font-medium text-white/85"
        >
          {editing ? "Editing text — press enter to save" : "Hover to explore · click an element to edit"}
        </div>
      )}
      {editing && (
        <div
          style={{ pointerEvents: "none" }}
          className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[11px] font-medium text-white"
        >
          Editing text — enter to save · esc to cancel
        </div>
      )}

      {/* x-ray: outline every piece */}
      {showAll &&
        allPieces.map((p) => (
          <div key={p.pieceId} style={{ position: "absolute", left: p.rect.left, top: p.rect.top, width: p.rect.width, height: p.rect.height, border: "1px dashed rgba(127,119,221,0.55)", borderRadius: 5, pointerEvents: "none" }}>
            <span className="absolute -top-[9px] left-1 rounded-sm bg-indigo-500 px-1 text-[9px] leading-[1.4] text-white">{p.kind}</span>
          </div>
        ))}

      {/* hover reveal (only when not selected) */}
      {hovered && !selected && !editing && (
        <div style={{ position: "absolute", left: hovered.rect.left, top: hovered.rect.top, width: hovered.rect.width, height: hovered.rect.height, border: "1.5px solid rgba(99,102,241,0.7)", borderRadius: 6, pointerEvents: "none" }} />
      )}

      {box && selected && (
        <>
          <div
            style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, border: "2px solid #6366f1", borderRadius: 6, boxShadow: "0 0 0 9999px rgba(10,12,20,0.28)", pointerEvents: "none", transition: dragDelta ? "none" : "left 60ms, top 60ms" }}
          />
          <div onMouseDown={onDragStart} title="Drag to move" style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, cursor: busy ? "wait" : "move", pointerEvents: "auto" }} />
          <div
            style={{ position: "absolute", left: Math.max(4, box.left), top: Math.max(4, box.top - 42), pointerEvents: "auto" }}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#11141b] px-1.5 py-1 shadow-xl"
          >
            <span className="px-1.5 font-mono text-[10px] text-white/45">
              {selected.pieceId}
              <span className="ml-1 text-white/25">{selected.kind}</span>
            </span>
            {canEditText && (
              <button type="button" onClick={editTextFromToolbar} disabled={!!busy} className="rounded-md bg-sky-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                Edit text
              </button>
            )}
            <button type="button" onClick={regenerate} disabled={!!busy} className="rounded-md bg-indigo-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {busy === "regenerate" ? "Regenerating…" : "Regenerate"}
            </button>
            <button type="button" onClick={remove} disabled={!!busy} className="rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/80 hover:bg-red-500/80 hover:text-white disabled:opacity-50">
              {busy === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        </>
      )}

      {error && (
        <div style={{ pointerEvents: "auto" }} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-red-600/90 px-3 py-1.5 text-[11px] text-white">
          {error}
        </div>
      )}
    </div>
  );
}
