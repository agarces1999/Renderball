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
  /** Start with the piece x-ray on (the dev dashboard defaults to visible). */
  defaultShowAll?: boolean;
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
  defaultShowAll = false,
}: Props) {
  const [selected, setSelected] = useState<PieceRef | null>(null);
  const [hovered, setHovered] = useState<PieceRef | null>(null);
  const [showAll, setShowAll] = useState(defaultShowAll);
  const [allPieces, setAllPieces] = useState<PieceRef[]>([]);
  const [busy, setBusyState] = useState<null | "regenerate" | "delete" | "move" | "text">(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Instructed regen (DESIGN.md flow step 6: "say what to change, it regenerates").
  // The Regenerate button opens this ask; the API rejects blind rerolls.
  const [regenAsk, setRegenAsk] = useState(false);
  const [regenText, setRegenText] = useState("");
  // Bumped when the iframe's document (re)loads — recomputes x-ray rects + restores
  // selection against the NEW document (contentDocument is stale at src-change time).
  const [docTick, setDocTick] = useState(0);

  const editingRef = useRef(false);
  // busy mirrored in a ref: the iframe handlers are attached once per effect and
  // would otherwise close over a stale `busy` — clicking piece B during piece A's
  // in-flight regen would show B's toolbar reading "Regenerating…".
  const busyRef = useRef<typeof busy>(null);
  const setBusy = (b: typeof busy) => {
    busyRef.current = b;
    setBusyState(b);
  };
  // Piece to re-select after the post-edit reload (move/regenerate keep selection).
  const reselectIdRef = useRef<string | null>(null);
  const textTargetRef = useRef<TextTarget | null>(null);
  // Active multi-field edit session's finisher (Done button / unmount call it).
  const finishSessionRef = useRef<((save: boolean) => void) | null>(null);
  // The scene's editable copy fields (path+value), fetched so we can tell whether a
  // clicked text element is bound content and resolve its exact path — the affordance
  // for "Edit text" appears only on text that actually maps to a field.
  const fieldsRef = useRef<{ path: string; value: string }[]>([]);
  const dragRef = useRef<{ startX: number; startY: number; scale: number } | null>(null);
  const dragHandlersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);

  // A piece's wrapper is display:contents (no box), so its own rect is all-zero.
  // Measure its extent as the union of its rendered descendants' non-zero rects —
  // but EXCLUDE full-bleed decorative layers (a background wash / glow / gradient a
  // diegetic piece may contain). Those would inflate the box to the whole canvas, so
  // the selection covers everything and the toolbar lands far from the real element
  // (the Arc CTA "can't select the right mock" bug). Fall back to including them only
  // when a piece is nothing BUT full-bleed (a pure atmosphere layer) so it still boxes.
  const rectOf = (el: Element): Rect | null => {
    const doc = el.ownerDocument;
    const vw = doc?.documentElement?.clientWidth || iframeRef.current?.clientWidth || 0;
    const vh = doc?.documentElement?.clientHeight || iframeRef.current?.clientHeight || 0;
    const isFullBleed = (r: DOMRect): boolean =>
      vw > 0 && vh > 0 && r.width >= vw * 0.92 && r.height >= vh * 0.92;
    const collect = (dropFullBleed: boolean): DOMRect[] => {
      const rects: DOMRect[] = [];
      const own = el.getBoundingClientRect();
      if (own.width > 0 && own.height > 0 && !(dropFullBleed && isFullBleed(own))) rects.push(own);
      el.querySelectorAll("*").forEach((c) => {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !(dropFullBleed && isFullBleed(r))) rects.push(r);
      });
      return rects;
    };
    let rects = collect(true);
    if (rects.length === 0) rects = collect(false); // pure full-bleed (atmosphere) → keep its box
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  };

  const postJson = useCallback(
    async (url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> => {
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
          return { ok: false, json: json as Record<string, unknown> };
        }
        return { ok: true, json: json as Record<string, unknown> };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return { ok: false, json: {} };
      }
    },
    [],
  );
  const post = useCallback(
    async (url: string, body: unknown): Promise<boolean> => (await postJson(url, body)).ok,
    [postJson],
  );

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

  // ---- inline text edit (multi-field session) -----------------------------
  // "Edit text" opens EVERY editable copy field in the piece at once (headline,
  // eyebrow, lede, bullets, cta, meta…), each outlined — not just the one clicked.
  // Click any to edit; Done / click-away saves all changed; Esc cancels; Enter
  // hops to the next field. Editable = maps to a scene-content field (a
  // data-content-path tag, or a text-match), so decorative diegetic copy stays put.
  // Matches BLOCK_TEXT (incl. div/label): the untagged pass only accepts elements
  // whose text EXACTLY matches a scene-content field, so layout divs stay excluded —
  // without div/label here, div-rendered copy showed "Edit text" but the session
  // opened zero fields (a silent no-op).
  const BLOCK_FIELD_SEL = "h1,h2,h3,h4,h5,h6,p,li,div,label,figcaption,blockquote,dd,dt,td,th";
  const collectEditableFields = (piece: Element): { el: HTMLElement; path?: string; oldText: string }[] => {
    const out: { el: HTMLElement; path?: string; oldText: string }[] = [];
    const seenPaths = new Set<string>();
    const add = (el: HTMLElement, path: string | undefined, oldText: string) => {
      if (!oldText) return;
      if (path && seenPaths.has(path)) return; // one element per content field
      if (out.some((f) => f.el.contains(el) || el.contains(f.el))) return; // no nested editables
      out.push({ el, path, oldText });
      if (path) seenPaths.add(path);
    };
    // Tagged fields first (precise), then text-matched block elements (untagged builds).
    piece.querySelectorAll<HTMLElement>("[data-content-path]").forEach((el) =>
      add(el, el.getAttribute("data-content-path") ?? undefined, (el.textContent ?? "").trim()),
    );
    piece.querySelectorAll<HTMLElement>(BLOCK_FIELD_SEL).forEach((el) => {
      const t = (el.textContent ?? "").trim();
      const path = matchFieldPath(fieldsRef.current, t) ?? undefined;
      if (path) add(el, path, t);
    });
    return out;
  };

  const focusField = (el: HTMLElement, doc: Document) => {
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const startTextFields = (piece: Element, focus?: HTMLElement | null): boolean => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return false;
    // Defensive: never stack sessions (a second start would orphan the first
    // session's doc listeners and clobber finishSessionRef).
    finishSessionRef.current?.(false);
    const found = collectEditableFields(piece);
    if (found.length === 0) return false;
    const fields = found.map((f) => ({ ...f, savedHTML: f.el.innerHTML }));
    for (const f of fields) {
      f.el.textContent = f.oldText; // flatten accents for clean editing
      f.el.setAttribute("contenteditable", "true");
      f.el.setAttribute("spellcheck", "false");
      f.el.style.outline = "2px solid #378add";
      f.el.style.outlineOffset = "2px";
      f.el.style.borderRadius = "3px";
      f.el.style.cursor = "text";
    }
    editingRef.current = true;
    setEditing(true);
    setSelected(null);
    setHovered(null);
    focusField(focus && fields.some((f) => f.el === focus) ? focus : fields[0].el, doc);

    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mousedown", onDown, true);
      finishSessionRef.current = null;
      editingRef.current = false;
      setEditing(false);
      const changed: { path?: string; oldText: string; newText: string }[] = [];
      for (const f of fields) {
        f.el.removeAttribute("contenteditable");
        f.el.style.outline = "";
        f.el.style.outlineOffset = "";
        f.el.style.borderRadius = "";
        f.el.style.cursor = "";
        const newText = (f.el.textContent ?? "").trim();
        if (save && newText.length > 0 && newText !== f.oldText) {
          changed.push({ path: f.path, oldText: f.oldText, newText });
        } else {
          f.el.innerHTML = f.savedHTML; // revert flatten (unchanged / cancelled)
        }
      }
      if (changed.length === 0) return;
      setBusy("text");
      // ONE batched request (one script load/save server-side) instead of N
      // sequential round-trips; per-edit results surface partial failures.
      const { ok, json } = await postJson(`${apiBase}/edit-element`, {
        scriptId,
        sceneIndex,
        edits: changed.map((c) => ({
          op: "edit" as const,
          ...(c.path ? { path: c.path } : {}),
          matchText: c.oldText,
          value: c.newText,
        })),
      });
      setBusy(null);
      const results = (json.results ?? []) as { ok: boolean; error?: string }[];
      const failedCount = results.filter((r) => !r.ok).length;
      if (ok && failedCount > 0) {
        setError(`${failedCount} of ${changed.length} edits could not be applied — the rest were saved.`);
      }
      if (ok) onChanged(); // one reload re-SSRs all edited copy + re-applies accents
    };
    finishSessionRef.current = finish;

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const active = doc.activeElement as HTMLElement | null;
        const idx = fields.findIndex((f) => f.el === active);
        if (idx >= 0 && idx < fields.length - 1) focusField(fields[idx + 1].el, doc);
        else finish(true);
      }
    };
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null;
      if (t && fields.some((f) => f.el === t || f.el.contains(t))) return; // within a field → keep editing
      finish(true); // clicked elsewhere in the scene → commit
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("mousedown", onDown, true);
    return true;
  };

  const editTextFromToolbar = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !selected) return;
    const piece = doc.querySelector(`[data-piece="${selected.pieceId}"]`);
    if (!piece) return;
    const clicked = textTargetRef.current?.el;
    const opened = startTextFields(piece, clicked && piece.contains(clicked) ? clicked : null);
    // Never a silent no-op: if no field resolved (fields fetch failed / still in
    // flight on an untagged build), say so and refetch instead of doing nothing.
    if (!opened) {
      setError("No editable text found in this piece — retrying field lookup…");
      void fetchFields();
    }
  };

  // ---- attach resolver + hover to the iframe document ---------------------
  useEffect(() => {
    finishSessionRef.current?.(false); // cancel any edit session from the prior scene
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
      if (editingRef.current || busyRef.current) return;
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
      // Inside an active session, double-click must fall through to native word
      // selection — starting a second session would orphan the first's listeners.
      if (editingRef.current || busyRef.current) return;
      const target = e.target as Element | null;
      const piece = target?.closest?.("[data-piece]") as Element | null;
      if (!piece || !target) return;
      // Double-click opens the whole piece's text fields, focused on the one clicked.
      if (collectEditableFields(piece).length > 0) {
        e.preventDefault();
        e.stopPropagation();
        startTextFields(piece, target as HTMLElement);
      }
    };

    const onOver = (e: Event) => {
      if (editingRef.current || busyRef.current) return;
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
    // Escape clears the selection (a text session's own Escape handler runs first
    // and stops the session; this only fires when no session is active).
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !editingRef.current) setSelected(null);
    };

    const attach = () => {
      try {
        doc = iframe.contentDocument;
        if (!doc) return;
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("dblclick", onDbl, true);
        doc.addEventListener("mouseover", onOver, true);
        doc.addEventListener("mouseleave", onLeave, true);
        doc.addEventListener("keydown", onEsc);
        // Affordance: everything inside a piece is selectable — show a pointer
        // cursor so regeneratable elements read as clickable (edit surface only;
        // an active text session overrides with cursor:text inline).
        if (!doc.getElementById("rb-editor-affordance")) {
          const style = doc.createElement("style");
          style.id = "rb-editor-affordance";
          style.textContent = "[data-piece] *:hover { cursor: pointer; }";
          doc.head?.appendChild(style);
        }
        // The NEW document is live now — recompute anything measured against the
        // old one (x-ray rects) and restore the selection a move/regen preserved.
        setDocTick((t) => t + 1);
        const reselect = reselectIdRef.current;
        if (reselect) {
          reselectIdRef.current = null;
          // settle-mode renders land in final layout; a beat for paint, then re-measure.
          setTimeout(() => {
            try {
              const piece = iframe.contentDocument?.querySelector(`[data-piece="${reselect}"]`);
              const rect = piece ? rectOf(piece) : null;
              if (piece && rect) {
                setSelected({ pieceId: reselect, kind: piece.getAttribute("data-kind") ?? "", rect });
              }
            } catch {
              /* ignore — reselect is best-effort */
            }
          }, 60);
        }
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
        doc?.removeEventListener("keydown", onEsc);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeRef, reloadKey, sceneIndex]);

  // Fetch this scene's editable copy fields so text affordances are precise (offer
  // "Edit text" only on bound content, and resolve its exact path). Refreshes on scene
  // change and after any edit (reloadKey); a transient failure retries once so text
  // editing isn't silently dead for the scene.
  const fetchFields = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${apiBase}/edit-element?scriptId=${encodeURIComponent(scriptId)}&sceneIndex=${sceneIndex}`);
      const json = (await res.json().catch(() => ({}))) as { fields?: { path: string; value: string }[] };
      if (!res.ok || !Array.isArray(json.fields)) return false;
      fieldsRef.current = json.fields;
      return true;
    } catch {
      return false;
    }
  }, [apiBase, scriptId, sceneIndex]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await fetchFields();
      if (!ok && !cancelled) {
        await new Promise((r) => setTimeout(r, 700));
        if (!cancelled) await fetchFields(); // one retry — then tagged builds still work
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchFields, reloadKey]);

  // Compute every piece's rect for the "show all" x-ray. docTick ties this to the
  // LIVE document: at src-change time contentDocument is still the outgoing doc, so
  // without it the outlines showed the previous scene's boxes until toggled twice.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll, reloadKey, sceneIndex, docTick, iframeRef]);

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
      if (!d || !selected) {
        setDragDelta(null);
        return;
      }
      const scale = d.scale || 1;
      const dx = Math.round((ev.clientX - d.startX) / scale);
      const dy = Math.round((ev.clientY - d.startY) / scale);
      if (dx === 0 && dy === 0) {
        setDragDelta(null);
        return;
      }
      // Keep the box at the DRAGGED position while the move persists — clearing
      // dragDelta before the await snapped the outline back to the old spot for
      // the whole POST. On success the reload shows the piece at its new place
      // and the selection is restored (reselectIdRef) so nudging can continue.
      setBusy("move");
      const ok = await post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId: selected.pieceId, op: "move", dx, dy });
      setBusy(null);
      setDragDelta(null);
      if (ok) {
        reselectIdRef.current = selected.pieceId;
        setSelected(null);
        onChanged();
      }
    };
    dragHandlersRef.current = { move, up };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  useEffect(() => detachDrag, []);
  // Cancel an in-progress text-edit session if the editor unmounts.
  useEffect(() => () => finishSessionRef.current?.(false), []);
  // A fresh selection gets a fresh ask — a typed instruction is about ONE piece.
  useEffect(() => {
    setRegenAsk(false);
    setRegenText("");
  }, [selected?.pieceId]);

  const regenerate = async () => {
    const instruction = regenText.trim();
    if (!selected || !instruction) return;
    setBusy("regenerate");
    const ok = await post(`${apiBase}/regenerate-element`, { scriptId, sceneIndex, pieceId: selected.pieceId, instruction });
    setBusy(null);
    if (ok) {
      setRegenAsk(false);
      setRegenText("");
      reselectIdRef.current = selected.pieceId; // keep it selected across the reload
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
      {/* drag shield: while dragging, catch every mouse event before the iframe can
          swallow it (iframe docs don't forward mousemove to the parent window, so a
          fast drag that escaped the handle used to stall mid-gesture) */}
      {dragDelta && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, cursor: "move", pointerEvents: "auto" }} />
      )}
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
          Outlined pieces are editable · click to select · double-click text to edit
        </div>
      )}
      {editing && (
        <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2" style={{ pointerEvents: "auto" }}>
          <span className="rounded-full bg-black/70 px-3 py-1 text-[11px] font-medium text-white">
            Editing text — click any field · enter for next · esc to cancel
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => finishSessionRef.current?.(true)}
            className="rounded-full bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-400"
          >
            Done
          </button>
        </div>
      )}

      {/* x-ray: outline every piece */}
      {showAll &&
        allPieces.map((p) => (
          <div key={p.pieceId} style={{ position: "absolute", left: p.rect.left, top: p.rect.top, width: p.rect.width, height: p.rect.height, border: "1px dashed rgba(127,119,221,0.55)", borderRadius: 5, pointerEvents: "none" }}>
            <span className="absolute -top-[9px] left-1 rounded-sm bg-indigo-500 px-1 text-[9px] leading-[1.4] text-white">{p.kind}</span>
          </div>
        ))}

      {/* hover reveal (only when not selected) — labeled so what you'd select is explicit */}
      {hovered && !selected && !editing && (
        <div style={{ position: "absolute", left: hovered.rect.left, top: hovered.rect.top, width: hovered.rect.width, height: hovered.rect.height, border: "1.5px solid rgba(99,102,241,0.7)", borderRadius: 6, pointerEvents: "none" }}>
          <span className="absolute -top-[10px] left-1 rounded-sm bg-indigo-500/90 px-1.5 text-[9px] font-medium leading-[1.5] text-white">
            {hovered.kind} · click to edit
          </span>
        </div>
      )}

      {box && selected && (
        <>
          <div
            style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, border: "2px solid #6366f1", borderRadius: 6, boxShadow: "0 0 0 9999px rgba(10,12,20,0.28)", pointerEvents: "none", transition: dragDelta ? "none" : "left 60ms, top 60ms" }}
          />
          <div onMouseDown={onDragStart} title="Drag to move" style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, cursor: busy ? "wait" : "move", pointerEvents: "auto" }} />
          <div
            style={{ position: "absolute", left: Math.max(4, box.left), top: Math.max(4, box.top - (regenAsk ? 74 : 42)), pointerEvents: "auto" }}
            className="flex flex-col gap-1 rounded-lg border border-white/10 bg-[#11141b] px-1.5 py-1 shadow-xl"
          >
            <div className="flex items-center gap-1">
              <span className="px-1.5 font-mono text-[10px] text-white/45">
                {selected.pieceId}
                <span className="ml-1 text-white/25">{selected.kind}</span>
              </span>
              {canEditText && (
                <button type="button" onClick={editTextFromToolbar} disabled={!!busy} className="rounded-md bg-sky-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                  Edit text
                </button>
              )}
              <button
                type="button"
                onClick={() => setRegenAsk((a) => !a)}
                disabled={!!busy}
                className={
                  "rounded-md px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50 " +
                  (regenAsk ? "bg-indigo-500" : "bg-indigo-500/90 hover:bg-indigo-500")
                }
              >
                {busy === "regenerate" ? "Regenerating…" : "Regenerate"}
              </button>
              <button type="button" onClick={remove} disabled={!!busy} className="rounded-md bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/80 hover:bg-red-500/80 hover:text-white disabled:opacity-50">
                {busy === "delete" ? "Deleting…" : "Delete"}
              </button>
            </div>
            {regenAsk && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void regenerate();
                }}
                className="flex items-center gap-1"
              >
                <input
                  autoFocus
                  value={regenText}
                  onChange={(e) => setRegenText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRegenAsk(false);
                  }}
                  disabled={!!busy}
                  placeholder="What should change? e.g. make it a bar chart"
                  className="w-64 rounded-md bg-white/10 px-2 py-1 text-[11px] text-white placeholder-white/35 outline-none focus:bg-white/15 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!!busy || !regenText.trim()}
                  className="rounded-md bg-indigo-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Go
                </button>
              </form>
            )}
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
