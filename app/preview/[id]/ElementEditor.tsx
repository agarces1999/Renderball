"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { matchFieldPath } from "../../../lib/edit/scene-content";
import { parseFmt, serializeFmt, type FreetextFormat } from "../../../lib/edit/freetext";

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

// One colour language for the whole overlay (DESIGN.md): neutral chrome for every
// control, the emerald ONLY for the primary action and active/selected state. The
// overlay floats over brand-coloured video, so its chrome is the dark surface.
const CHROME = "bg-[#11141b]/85 text-white/80 hover:bg-[#11141b] hover:text-white";
const ACTIVE = "bg-accent text-accent-ink hover:bg-accent";
/** Radii follow DESIGN.md's scale (sm 8 · md 12), not Tailwind's 6/8 defaults. */
const R_SM = "rounded-[8px]";
const R_MD = "rounded-[12px]";
/** ≥28px hit area on every control (icon buttons were ~17px). */
const HIT = "min-h-[28px] min-w-[28px] inline-flex items-center justify-center";

const ORB_KEYFRAMES = "@keyframes rb-orb-spin { to { transform: rotate(360deg); } }";

/**
 * The crystal ball — DESIGN.md's signature generation state ("the orb clears while
 * the story computes"). Glass body on the cool void with a slowly rotating
 * prismatic rim; the only place spectral colour is allowed.
 */
const CrystalOrb = ({ size = 14 }: { size?: number }) => (
  <span
    aria-hidden
    style={{
      position: "relative",
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: "50%",
      background:
        "radial-gradient(circle at 50% 50%, rgba(190,205,235,.10) 0%, rgba(22,28,44,.55) 68%, rgba(8,10,18,.9) 100%)",
      boxShadow: "0 0 12px -2px rgba(150,200,255,.45)",
      flex: "none",
    }}
  >
    <span
      style={{
        position: "absolute",
        inset: -1,
        borderRadius: "50%",
        background:
          "conic-gradient(from 200deg, transparent, rgba(120,220,255,.9), rgba(180,130,255,.7), rgba(255,130,205,.65), transparent)",
        WebkitMaskImage: "radial-gradient(circle, transparent 56%, #000 62%)",
        maskImage: "radial-gradient(circle, transparent 56%, #000 62%)",
        mixBlendMode: "screen",
        animation: "rb-orb-spin 7s linear infinite",
      }}
    />
  </span>
);

/** The 8 resize grips, as [corner/edge → cursor]. */
const HANDLES = [
  ["nw", "nwse-resize"],
  ["n", "ns-resize"],
  ["ne", "nesw-resize"],
  ["e", "ew-resize"],
  ["se", "nwse-resize"],
  ["s", "ns-resize"],
  ["sw", "nesw-resize"],
  ["w", "ew-resize"],
] as const;
type HandleDir = (typeof HANDLES)[number][0];

/** Four stacked rules, justified — the conventional alignment glyph. */
const AlignIcon = ({ a }: { a: "left" | "center" | "right" }) => (
  <span
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 2,
      width: 12,
      alignItems: a === "left" ? "flex-start" : a === "center" ? "center" : "flex-end",
    }}
  >
    {[12, 8, 12, 8].map((w, i) => (
      <span key={i} style={{ display: "block", height: 1.5, width: w, background: "currentColor", borderRadius: 1 }} />
    ))}
  </span>
);

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
  const [busy, setBusyState] = useState<null | "regenerate" | "delete" | "move" | "text" | "insert" | "resize" | "undo">(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // ── add / generate (net-new) ──────────────────────────────────────────────
  // `tool` armed to "generate" turns the canvas into a marquee surface: drag a box,
  // release, and a prompt input appears under it (the "draw an area, describe what
  // goes there" feature). `marquee` is the live rubber-band; `genBox` is the frozen
  // box awaiting a prompt. All three are in OVERLAY-local px (== iframe-viewport px).
  const [tool, setTool] = useState<null | "generate">(null);
  const [marquee, setMarquee] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const [genBox, setGenBox] = useState<null | { left: number; top: number; width: number; height: number }>(null);
  const [genPrompt, setGenPrompt] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  // Formatting for an INSERTED text box (null when the selection isn't one). Read
  // from the live span's data-rb-fmt, so it always reflects what's on screen.
  const [fmt, setFmt] = useState<FreetextFormat | null>(null);
  const [swatches, setSwatches] = useState<string[]>([]);
  const [colorOpen, setColorOpen] = useState(false);
  // Undo depth drives the control's visibility; every mutating op pushes a snapshot.
  const [undoDepth, setUndoDepth] = useState(0);
  // Live resize (overlay px) while dragging a grip; committed to canvas px on release.
  const [resizeBox, setResizeBox] = useState<null | { left: number; top: number; width: number; height: number }>(null);
  const resizeRef = useRef<null | { left: number; top: number; width: number; height: number }>(null);
  // A press on empty canvas that hasn't yet become a marquee (native drag-to-generate).
  const pendingMarqueeRef = useRef<null | { x: number; y: number }>(null);
  // Mirrors `tool` for the once-attached iframe handlers, so an armed marquee
  // suspends piece selection/hover without re-attaching listeners (same pattern as busyRef).
  const toolRef = useRef<typeof tool>(null);
  toolRef.current = tool;
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
  const collectEditableFields = (piece: Element): { el: HTMLElement; path?: string; oldText: string; freetext?: boolean }[] => {
    const out: { el: HTMLElement; path?: string; oldText: string; freetext?: boolean }[] = [];
    const seenPaths = new Set<string>();
    const add = (el: HTMLElement, path: string | undefined, oldText: string, freetext?: boolean) => {
      if (!oldText) return;
      if (path && seenPaths.has(path)) return; // one element per content field
      if (out.some((f) => f.el.contains(el) || el.contains(f.el))) return; // no nested editables
      out.push({ el, path, oldText, freetext });
      if (path) seenPaths.add(path);
    };
    // Inserted free-text boxes (data-rb-freetext): their copy is a literal in the
    // piece body, not a SceneContent field — saved via edit-piece-text, not edit-element.
    piece.querySelectorAll<HTMLElement>("[data-rb-freetext]").forEach((el) =>
      add(el, undefined, (el.textContent ?? "").trim(), true),
    );
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
    const sessionPieceId = piece.getAttribute("data-piece") ?? "";
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
      const changed: { path?: string; oldText: string; newText: string; freetext?: boolean }[] = [];
      for (const f of fields) {
        f.el.removeAttribute("contenteditable");
        f.el.style.outline = "";
        f.el.style.outlineOffset = "";
        f.el.style.borderRadius = "";
        f.el.style.cursor = "";
        const newText = (f.el.textContent ?? "").trim();
        if (save && newText.length > 0 && newText !== f.oldText) {
          changed.push({ path: f.path, oldText: f.oldText, newText, freetext: f.freetext });
        } else {
          f.el.innerHTML = f.savedHTML; // revert flatten (unchanged / cancelled)
        }
      }
      if (changed.length === 0) return;
      setBusy("text");
      // Split by save path: bound SceneContent copy → the batched edit-element route;
      // inserted free-text boxes → edit-piece-text (their text is a body literal, not
      // a content field). Both reassemble Composition.tsx; one onChanged() reloads.
      const contentEdits = changed.filter((c) => !c.freetext);
      const freeEdits = changed.filter((c) => c.freetext);
      let anyOk = false;
      let failedCount = 0;
      if (contentEdits.length > 0) {
        const { ok, json } = await postJson(`${apiBase}/edit-element`, {
          scriptId,
          sceneIndex,
          edits: contentEdits.map((c) => ({
            op: "edit" as const,
            ...(c.path ? { path: c.path } : {}),
            matchText: c.oldText,
            value: c.newText,
          })),
        });
        if (ok) anyOk = true;
        const results = (json.results ?? []) as { ok: boolean; error?: string }[];
        failedCount += ok ? results.filter((r) => !r.ok).length : contentEdits.length;
      }
      for (const c of freeEdits) {
        const { ok } = await postJson(`${apiBase}/edit-piece-text`, {
          scriptId,
          sceneIndex,
          pieceId: sessionPieceId,
          value: c.newText,
        });
        if (ok) anyOk = true;
        else failedCount += 1;
      }
      setBusy(null);
      if (failedCount > 0) {
        setError(`${failedCount} of ${changed.length} edits could not be applied — the rest were saved.`);
      }
      if (anyOk) onChanged(); // one reload re-SSRs all edited copy + re-applies accents
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
    setTool(null);
    setMarquee(null);
    setGenBox(null);
    setGenPrompt("");
    const iframe = iframeRef.current;
    if (!iframe) return;
    let doc: Document | null = null;
    let lastHover = "";

    const onClick = (e: Event) => {
      if (editingRef.current || busyRef.current || toolRef.current) return;
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
      if (editingRef.current || busyRef.current || toolRef.current) return;
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

    // ---- native marquee: drag on EMPTY canvas draws a generate area ---------
    // No mode to arm — a press that lands on no piece becomes a marquee once it
    // travels past a threshold; a press that never travels stays a plain click and
    // still deselects. Coordinates in the iframe doc are already overlay-local
    // (the overlay is inset:0 over the iframe), so no conversion is needed here.
    const MARQUEE_MIN = 24;
    const onDown = (e: MouseEvent) => {
      if (editingRef.current || busyRef.current || toolRef.current) return;
      const target = e.target as Element | null;
      if (target?.closest?.("[data-piece]")) return; // a piece press = select/drag, not marquee
      pendingMarqueeRef.current = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: MouseEvent) => {
      const p = pendingMarqueeRef.current;
      if (!p) return;
      if (Math.abs(e.clientX - p.x) < 6 && Math.abs(e.clientY - p.y) < 6) return; // not a drag yet
      setMarquee({ x0: p.x, y0: p.y, x1: e.clientX, y1: e.clientY });
    };
    const onUp = (e: MouseEvent) => {
      const p = pendingMarqueeRef.current;
      pendingMarqueeRef.current = null;
      if (!p) return;
      const width = Math.abs(e.clientX - p.x);
      const height = Math.abs(e.clientY - p.y);
      setMarquee(null);
      if (width < MARQUEE_MIN || height < MARQUEE_MIN) {
        // Too small to be an area — let it behave as a click (deselect).
        if (width > 6 || height > 6) setError("Draw a larger area to generate an element here.");
        return;
      }
      setSelected(null);
      setGenBox({ left: Math.min(p.x, e.clientX), top: Math.min(p.y, e.clientY), width, height });
    };

    const onOver = (e: Event) => {
      if (editingRef.current || busyRef.current || toolRef.current) return;
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
        doc.addEventListener("mousedown", onDown, true);
        doc.addEventListener("mousemove", onMove, true);
        doc.addEventListener("mouseup", onUp, true);
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
        doc?.removeEventListener("mousedown", onDown, true);
        doc?.removeEventListener("mousemove", onMove, true);
        doc?.removeEventListener("mouseup", onUp, true);
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
    const seen = new Set<string>();
    doc.querySelectorAll("[data-piece]").forEach((el) => {
      const id = el.getAttribute("data-piece");
      // A piece can expose two [data-piece] nodes (the display:contents <Piece> shim
      // AND a body div that repeats it, e.g. cast-path output) — keep the first, so
      // the x-ray keys stay unique.
      if (!id || seen.has(id)) return;
      seen.add(id);
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

  // ── insert (add primitive) + generate (marquee) ───────────────────────────
  const canvasEl = (): HTMLElement | null =>
    (iframeRef.current?.contentDocument?.querySelector(".renderball-canvas") as HTMLElement | null) ?? null;
  // Overlay-local px (== iframe-viewport px) → canvas px. The canvas is scaled to fit
  // and may be letterboxed, so subtract its rendered origin THEN divide by scale.
  const overlayToCanvas = (localX: number, localY: number): { x: number; y: number } => {
    const scale = canvasScale() || 1;
    const c = canvasEl();
    const r = c?.getBoundingClientRect();
    const ox = r ? r.left : 0;
    const oy = r ? r.top : 0;
    return { x: (localX - ox) / scale, y: (localY - oy) / scale };
  };
  // Intrinsic canvas dimensions in canvas px (width is the known prop; height is the
  // rendered height un-scaled) — used to centre a default box for add-primitive.
  const canvasIntrinsic = (): { w: number; h: number } | null => {
    const c = canvasEl();
    const r = c?.getBoundingClientRect();
    const scale = canvasScale() || 1;
    if (!r || canvasWidth <= 0) return null;
    return { w: canvasWidth, h: Math.round(r.height / scale) };
  };
  const clampBounds = (b: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } => {
    const dims = canvasIntrinsic();
    const x = Math.max(0, Math.round(b.x));
    const y = Math.max(0, Math.round(b.y));
    let w = Math.round(b.w);
    let h = Math.round(b.h);
    if (dims) {
      w = Math.min(w, dims.w - x);
      h = Math.min(h, dims.h - y);
    }
    return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  };

  const insertPrimitive = async (primitive: "text" | "image" | "icon") => {
    if (busy) return;
    const dims = canvasIntrinsic();
    if (!dims) {
      setError("Canvas not ready — try again in a moment.");
      return;
    }
    const w = Math.round(dims.w * 0.4);
    const h = Math.round(dims.h * (primitive === "text" ? 0.16 : 0.28));
    const bounds = clampBounds({ x: Math.round((dims.w - w) / 2), y: Math.round((dims.h - h) / 2), w, h });
    setBusy("insert");
    const { ok, json } = await postJson(`${apiBase}/insert-element`, { scriptId, sceneIndex, bounds, mode: "primitive", primitive });
    setBusy(null);
    if (ok) {
      const pid = json.pieceId;
      if (typeof pid === "string") reselectIdRef.current = pid;
      onChanged();
    }
  };

  const submitGenerate = async () => {
    const prompt = genPrompt.trim();
    if (!genBox || !prompt || busy) return;
    const p0 = overlayToCanvas(genBox.left, genBox.top);
    const p1 = overlayToCanvas(genBox.left + genBox.width, genBox.top + genBox.height);
    const bounds = clampBounds({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y });
    setBusy("insert");
    const { ok, json } = await postJson(`${apiBase}/insert-element`, { scriptId, sceneIndex, bounds, mode: "generate", prompt });
    setBusy(null);
    if (ok) {
      const pid = json.pieceId;
      if (typeof pid === "string") reselectIdRef.current = pid;
      setGenBox(null);
      setGenPrompt("");
      setTool(null);
      onChanged();
    }
  };

  // Marquee draw on the armed capture layer. Overlay-local coords via the overlay's
  // own rect; window listeners track a drag that leaves the layer (like the move shield).
  const onMarqueeDown = (e: React.MouseEvent) => {
    if (busy) return;
    const host = overlayRef.current?.getBoundingClientRect();
    if (!host) return;
    e.preventDefault();
    const sx = e.clientX - host.left;
    const sy = e.clientY - host.top;
    setMarquee({ x0: sx, y0: sy, x1: sx, y1: sy });
    const move = (ev: MouseEvent) => setMarquee({ x0: sx, y0: sy, x1: ev.clientX - host.left, y1: ev.clientY - host.top });
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const ex = ev.clientX - host.left;
      const ey = ev.clientY - host.top;
      const left = Math.min(sx, ex);
      const top = Math.min(sy, ey);
      const width = Math.abs(ex - sx);
      const height = Math.abs(ey - sy);
      setMarquee(null);
      if (width < 24 || height < 24) return; // sub-threshold — a stray click, ignore
      setGenBox({ left, top, width, height });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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
  // The colour popover closes on Escape or any click outside it.
  useEffect(() => {
    if (!colorOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColorOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.("[data-rb-colorpop]")) setColorOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [colorOpen]);

  // Escape disarms the marquee tool / cancels a pending generate box.
  useEffect(() => {
    if (!tool && !genBox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTool(null);
        setGenBox(null);
        setMarquee(null);
        setGenPrompt("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, genBox]);

  // ---- text formatting (inserted text boxes only) -------------------------
  /** The live free-text span inside the selected piece, if it is an inserted text box. */
  const freetextEl = useCallback((): HTMLElement | null => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !selected) return null;
    const piece = doc.querySelector(`[data-piece="${CSS.escape(selected.pieceId)}"]`);
    return (piece?.querySelector("[data-rb-freetext]") as HTMLElement | null) ?? null;
  }, [iframeRef, selected]);

  // Selection (or a reload) decides whether the format row shows, and seeds it.
  useEffect(() => {
    const el = freetextEl();
    setFmt(el ? parseFmt(el.getAttribute("data-rb-fmt") ?? undefined) : null);
    setColorOpen(false);
  }, [freetextEl, reloadKey, docTick]);

  // The video's own palette for the colour swatches — on-brand by construction.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/edit-piece-text?scriptId=${encodeURIComponent(scriptId)}`);
        const json = (await res.json().catch(() => ({}))) as { swatches?: string[] };
        if (!cancelled && Array.isArray(json.swatches)) setSwatches(json.swatches);
      } catch {
        /* swatches are a nicety — the "auto" colour always works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, scriptId]);

  /**
   * Apply a formatting change. Painted onto the live span FIRST so the control feels
   * instant (no iframe reload, no flicker, selection preserved), then persisted. The
   * server merges the patch onto the stored format and clamps every field. On failure
   * we reload to resync the canvas with the source of truth.
   */
  const applyFormat = async (patch: Partial<FreetextFormat>) => {
    if (!selected || !fmt || busy) return;
    const next: FreetextFormat = { ...fmt, ...patch };
    setFmt(next);
    const el = freetextEl();
    if (el) {
      el.style.fontSize = `${next.size}px`;
      el.style.fontWeight = String(next.weight);
      el.style.fontStyle = next.italic ? "italic" : "normal";
      el.style.textDecoration = next.underline ? "underline" : "none";
      el.style.color = next.color;
      el.style.textAlign = next.align;
      el.setAttribute("data-rb-fmt", serializeFmt(next));
    }
    const ok = await post(`${apiBase}/edit-piece-text`, {
      scriptId,
      sceneIndex,
      pieceId: selected.pieceId,
      format: patch,
    });
    if (!ok) onChanged(); // resync from the persisted source
  };

  // ---- undo ---------------------------------------------------------------
  const refreshUndoDepth = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/undo?scriptId=${encodeURIComponent(scriptId)}`);
      const json = (await res.json().catch(() => ({}))) as { depth?: number };
      if (typeof json.depth === "number") setUndoDepth(json.depth);
    } catch {
      /* undo availability is a nicety; never block the editor on it */
    }
  }, [apiBase, scriptId]);
  useEffect(() => {
    void refreshUndoDepth();
  }, [refreshUndoDepth, reloadKey]);

  const undo = async () => {
    if (busy || undoDepth === 0) return;
    setBusy("undo");
    const { ok } = await postJson(`${apiBase}/undo`, { scriptId });
    setBusy(null);
    if (ok) {
      setSelected(null);
      onChanged();
    }
  };
  // ⌘Z / Ctrl+Z anywhere in the editor (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === "z" || e.key === "Z") || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if (editingRef.current) return; // inline text session owns its own undo
      e.preventDefault();
      void undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, undoDepth, apiBase, scriptId]);

  // ---- resize -------------------------------------------------------------
  /** Drag one of the 8 grips. The box is tracked in overlay px for a live preview,
   *  then converted to absolute canvas px once, on release. */
  const onResizeStart = (e: React.MouseEvent, dir: HandleDir) => {
    if (!box || busy) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, ...box };
    const track = (b: { left: number; top: number; width: number; height: number }) => {
      resizeRef.current = b;
      setResizeBox(b);
    };
    track({ left: box.left, top: box.top, width: box.width, height: box.height });
    const MIN = 12;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { left, top, width, height } = start;
      if (dir.includes("w")) {
        const d = Math.min(dx, width - MIN);
        left = start.left + d;
        width = start.width - d;
      }
      if (dir.includes("e")) width = Math.max(MIN, start.width + dx);
      if (dir.includes("n")) {
        const d = Math.min(dy, height - MIN);
        top = start.top + d;
        height = start.height - d;
      }
      if (dir.includes("s")) height = Math.max(MIN, start.height + dy);
      track({ left, top, width, height });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const final = resizeRef.current;
      if (final && selected) void commitResize(final);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const commitResize = async (b: { left: number; top: number; width: number; height: number }) => {
    if (!selected) return;
    const p0 = overlayToCanvas(b.left, b.top);
    const p1 = overlayToCanvas(b.left + b.width, b.top + b.height);
    const bounds = clampBounds({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y });
    setBusy("resize");
    const ok = await post(`${apiBase}/edit-layout`, {
      scriptId,
      sceneIndex,
      pieceId: selected.pieceId,
      op: "resize",
      ...bounds,
    });
    setBusy(null);
    setResizeBox(null);
    if (ok) {
      reselectIdRef.current = selected.pieceId;
      setSelected(null);
      onChanged();
    }
  };

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

  // A live resize drives the box directly; otherwise it's the measured rect plus any
  // in-flight move delta.
  const box =
    resizeBox ??
    (selected
      ? {
          left: selected.rect.left + (dragDelta?.dx ?? 0),
          top: selected.rect.top + (dragDelta?.dy ?? 0),
          width: selected.rect.width,
          height: selected.rect.height,
        }
      : null);
  // Offer "Edit text" for pure-copy pieces (text/chrome always render bound content) and,
  // for any other kind, when the click resolved to bound copy — a data-content-path tag or
  // a text-to-field match (textTargetRef.path). So a headline inside a diegetic piece is
  // editable, while decorative diegetic labels that map to no field are not (no dead-end).
  const canEditText =
    !!selected && (selected.kind === "text" || selected.kind === "chrome" || !!textTargetRef.current?.path);

  return (
    <div ref={overlayRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {/* drag shield: while dragging, catch every mouse event before the iframe can
          swallow it (iframe docs don't forward mousemove to the parent window, so a
          fast drag that escaped the handle used to stall mid-gesture) */}
      {dragDelta && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, cursor: "move", pointerEvents: "auto" }} />
      )}

      <style dangerouslySetInnerHTML={{ __html: ORB_KEYFRAMES }} />

      {/* Add toolbar (top-left). Neutral chrome; the emerald is reserved for the
          primary action and active state (DESIGN.md). */}
      {!editing && (
        <div className="absolute left-2 top-2 flex items-center gap-1" style={{ pointerEvents: "auto" }}>
          <span className="mr-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">Add</span>
          {(["text", "image", "icon"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void insertPrimitive(p)}
              disabled={!!busy}
              className={`${HIT} ${R_SM} ${CHROME} px-2.5 text-[11px] font-medium capitalize disabled:opacity-50`}
            >
              {p}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={tool === "generate"}
            onClick={() => {
              setSelected(null);
              setHovered(null);
              setGenBox(null);
              setMarquee(null);
              setTool((t) => (t === "generate" ? null : "generate"));
            }}
            disabled={!!busy}
            className={
              `ml-1 ${HIT} ${R_SM} px-2.5 text-[11px] font-semibold disabled:opacity-50 gap-1.5 ` +
              (tool === "generate" ? ACTIVE : `${CHROME} !text-accent`)
            }
          >
            {busy === "insert" ? <CrystalOrb /> : null}
            {tool === "generate" ? "Drawing…" : busy === "insert" ? "Generating…" : "Generate area"}
          </button>
        </div>
      )}

      {/* Marquee capture layer — armed generate tool. Catches the drag before the
          iframe; crosshair signals "draw a box". Hidden once a box is frozen. */}
      {tool === "generate" && !genBox && (
        <div
          onMouseDown={onMarqueeDown}
          style={{ position: "absolute", inset: 0, cursor: "crosshair", pointerEvents: "auto", zIndex: 40 }}
        >
          {!marquee && (
            <div
              style={{ pointerEvents: "none" }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-accent-ink"
            >
              Drag to draw an area · Esc to cancel
            </div>
          )}
        </div>
      )}

      {/* The rubber band — shown for BOTH the native empty-canvas drag and the
          explicitly armed tool, so the two paths look identical to the user. */}
      {marquee && (
        <div
          style={{
            position: "absolute",
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
            border: "1.5px dashed var(--accent, #00c28a)",
            background: "rgba(0,194,138,0.12)",
            borderRadius: 8,
            pointerEvents: "none",
            zIndex: 41,
          }}
        />
      )}

      {/* Frozen generate box + prompt input anchored under it. */}
      {genBox && (
        <>
          <div
            style={{
              position: "absolute",
              left: genBox.left,
              top: genBox.top,
              width: genBox.width,
              height: genBox.height,
              border: "2px solid var(--accent, #00c28a)",
              background: "rgba(0,194,138,0.08)",
              borderRadius: 4,
              pointerEvents: "none",
            }}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitGenerate();
            }}
            style={{
              position: "absolute",
              // Keep the prompt inside the canvas: clamp horizontally, and flip it
              // ABOVE the box when a box drawn near the bottom leaves no room below.
              left: Math.max(4, Math.min(genBox.left, (overlayRef.current?.clientWidth ?? 9999) - 440)),
              top:
                genBox.top + genBox.height + 8 + 40 <= (overlayRef.current?.clientHeight ?? 0)
                  ? genBox.top + genBox.height + 8
                  : Math.max(4, genBox.top - 44),
              pointerEvents: "auto",
            }}
            className={`flex items-center gap-1 ${R_MD} border border-white/10 bg-[#11141b] px-1.5 py-1 shadow-xl`}
          >
            <input
              autoFocus
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setGenBox(null);
                  setGenPrompt("");
                  setTool(null);
                }
              }}
              disabled={!!busy}
              aria-label="Describe the element to generate"
              placeholder="What goes here? e.g. a KPI tile showing 3.2x"
              className={`h-[28px] w-72 ${R_SM} bg-white/10 px-2 text-[11px] text-white placeholder-white/45 outline-none focus:bg-white/15 disabled:opacity-50`}
            />
            <button
              type="submit"
              disabled={!!busy || !genPrompt.trim()}
              className={`${HIT} ${R_SM} ${ACTIVE} gap-1.5 px-2.5 text-[11px] font-semibold disabled:opacity-50`}
            >
              {busy === "insert" ? (
                <>
                  <CrystalOrb /> Generating…
                </>
              ) : (
                "Generate"
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setGenBox(null);
                setGenPrompt("");
                setTool(null);
              }}
              disabled={!!busy}
              className={`${HIT} ${R_SM} px-2 text-[11px] font-medium text-white/70 hover:bg-white/10 disabled:opacity-50`}
            >
              Cancel
            </button>
          </form>
        </>
      )}
      {/* Top-right: undo + the x-ray toggle. The top strip now holds ONLY controls —
          the guidance hint moved to the bottom so nothing overlaps. */}
      <div className="absolute right-2 top-2 flex items-center gap-1" style={{ pointerEvents: "auto" }}>
        {undoDepth > 0 && !editing && (
          <button
            type="button"
            onClick={() => void undo()}
            disabled={!!busy}
            title="Undo last change (⌘Z)"
            aria-label="Undo last change"
            className={`${HIT} ${R_SM} ${CHROME} px-2.5 text-[11px] font-medium disabled:opacity-50`}
          >
            {busy === "undo" ? "Undoing…" : "↩ Undo"}
          </button>
        )}
        <button
          type="button"
          aria-pressed={showAll}
          onClick={() => setShowAll((s) => !s)}
          className={`${HIT} ${R_SM} px-2.5 text-[11px] font-medium ${showAll ? ACTIVE : CHROME}`}
        >
          {showAll ? "Hide outlines" : "Show all pieces"}
        </button>
      </div>

      {/* Guidance, bottom-centre — out of the way of both toolbars. */}
      {!selected && !editing && !tool && !genBox && !marquee && (
        <div
          style={{ pointerEvents: "none" }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#11141b]/85 px-3 py-1 text-[11px] font-medium text-white/70"
        >
          Click a piece to edit · drag an empty area to generate something new
        </div>
      )}
      {editing && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2" style={{ pointerEvents: "auto" }}>
          <span className="rounded-full bg-[#11141b]/90 px-3 py-1 text-[11px] font-medium text-white/80">
            Editing text — click any field · enter for next · esc to cancel
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => finishSessionRef.current?.(true)}
            className={`${HIT} rounded-full ${ACTIVE} px-3 text-[11px] font-semibold`}
          >
            Done
          </button>
        </div>
      )}

      {/* x-ray: outline every piece — neutral, so it never competes with the video */}
      {showAll &&
        allPieces.map((p) => (
          <div key={p.pieceId} style={{ position: "absolute", left: p.rect.left, top: p.rect.top, width: p.rect.width, height: p.rect.height, border: "1px dashed rgba(255,255,255,0.34)", borderRadius: 8, pointerEvents: "none" }}>
            <span className="absolute -top-[9px] left-1 rounded-[4px] bg-[#11141b]/90 px-1 font-mono text-[9px] leading-[1.4] text-white/70">{p.kind}</span>
          </div>
        ))}

      {/* hover reveal (only when not selected) — labeled so what you'd select is explicit */}
      {hovered && !selected && !editing && !marquee && (
        <div style={{ position: "absolute", left: hovered.rect.left, top: hovered.rect.top, width: hovered.rect.width, height: hovered.rect.height, border: "1.5px solid var(--accent-line, rgba(0,194,138,0.42))", borderRadius: 8, pointerEvents: "none" }}>
          <span className="absolute -top-[10px] left-1 rounded-[4px] bg-[#11141b]/90 px-1.5 text-[9px] font-medium leading-[1.5] text-white/80">
            {hovered.kind} · click to edit
          </span>
        </div>
      )}

      {box && selected && (
        <>
          <div
            style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, border: "2px solid var(--accent, #00c28a)", borderRadius: 8, boxShadow: "0 0 0 9999px rgba(10,12,20,0.28)", pointerEvents: "none", transition: dragDelta || resizeBox ? "none" : "left 100ms, top 100ms" }}
          />
          <div onMouseDown={onDragStart} title="Drag to move" style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, cursor: busy ? "wait" : "move", pointerEvents: "auto" }} />

          {/* Resize grips — the only way to change an element's size after creation. */}
          {!busy && !editing &&
            HANDLES.map(([dir, cursor]) => {
              const mid = dir.length === 1;
              const x =
                dir.includes("w") ? box.left : dir.includes("e") ? box.left + box.width : box.left + box.width / 2;
              const y =
                dir.includes("n") ? box.top : dir.includes("s") ? box.top + box.height : box.top + box.height / 2;
              return (
                <div
                  key={dir}
                  role="slider"
                  aria-label={`Resize ${dir}`}
                  aria-valuenow={mid ? Math.round(box.width) : Math.round(box.height)}
                  onMouseDown={(e) => onResizeStart(e, dir)}
                  style={{
                    position: "absolute",
                    left: x - 5,
                    top: y - 5,
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: "var(--accent, #00c28a)",
                    border: "1.5px solid rgba(255,255,255,0.9)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                    cursor,
                    pointerEvents: "auto",
                    zIndex: 45,
                  }}
                />
              );
            })}
          <div
            style={{
              position: "absolute",
              left: Math.max(4, box.left),
              top: Math.max(4, box.top - (42 + (fmt ? 30 : 0) + (regenAsk ? 32 : 0))),
              pointerEvents: "auto",
            }}
            className={`flex flex-col gap-1 ${R_MD} border border-white/10 bg-[#11141b] px-1.5 py-1 shadow-xl`}
          >
            <div className="flex items-center gap-1">
              <span className="px-1.5 font-mono text-[10px] text-white/70">
                {selected.pieceId}
                <span className="ml-1 text-white/55">{selected.kind}</span>
              </span>
              {canEditText && (
                <button
                  type="button"
                  onClick={editTextFromToolbar}
                  disabled={!!busy}
                  className={`${HIT} ${R_SM} ${CHROME} px-2.5 text-[11px] font-medium disabled:opacity-50`}
                >
                  Edit text
                </button>
              )}
              <button
                type="button"
                aria-pressed={regenAsk}
                onClick={() => setRegenAsk((a) => !a)}
                disabled={!!busy}
                className={`${HIT} ${R_SM} gap-1.5 px-2.5 text-[11px] font-medium disabled:opacity-50 ${regenAsk ? ACTIVE : CHROME}`}
              >
                {busy === "regenerate" ? (
                  <>
                    <CrystalOrb /> Regenerating…
                  </>
                ) : (
                  "Regenerate"
                )}
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={!!busy}
                className={`${HIT} ${R_SM} px-2.5 text-[11px] font-medium text-white/80 hover:bg-red-500/80 hover:text-white disabled:opacity-50`}
              >
                {busy === "delete" ? "Deleting…" : "Delete"}
              </button>
            </div>
            {/* Formatting — inserted text boxes only. Theme-locked colours; every
                change paints instantly and persists to the piece source. */}
            {fmt && (
              <div className="flex items-center gap-0.5 border-t border-white/10 pt-1">
                <button
                  type="button"
                  title="Smaller"
                  onClick={() => void applyFormat({ size: fmt.size - 4 })}
                  disabled={!!busy || fmt.size <= 8}
                  className={`${HIT} ${R_SM} text-[13px] leading-none text-white/70 hover:bg-white/10 disabled:opacity-40`}
                >
                  A<span className="text-[9px]">▾</span>
                </button>
                <span className="min-w-[22px] text-center font-mono text-[10px] text-white/70">{fmt.size}</span>
                <button
                  type="button"
                  title="Bigger"
                  onClick={() => void applyFormat({ size: fmt.size + 4 })}
                  disabled={!!busy || fmt.size >= 400}
                  className={`${HIT} ${R_SM} text-[13px] leading-none text-white/70 hover:bg-white/10 disabled:opacity-40`}
                >
                  A<span className="text-[9px]">▴</span>
                </button>

                <span className="mx-0.5 h-4 w-px bg-white/10" />

                <button
                  type="button"
                  title="Bold"
                  onClick={() => void applyFormat({ weight: fmt.weight >= 700 ? 500 : 700 })}
                  disabled={!!busy}
                  className={
                    `${HIT} ${R_SM} text-[11px] font-bold leading-none disabled:opacity-40 ` +
                    (fmt.weight >= 700 ? "bg-accent text-accent-ink" : "text-white/70 hover:bg-white/10")
                  }
                >
                  B
                </button>
                <button
                  type="button"
                  title="Italic"
                  onClick={() => void applyFormat({ italic: !fmt.italic })}
                  disabled={!!busy}
                  className={
                    `${HIT} ${R_SM} text-[11px] italic leading-none disabled:opacity-40 ` +
                    (fmt.italic ? "bg-accent text-accent-ink" : "text-white/70 hover:bg-white/10")
                  }
                >
                  I
                </button>
                <button
                  type="button"
                  title="Underline"
                  onClick={() => void applyFormat({ underline: !fmt.underline })}
                  disabled={!!busy}
                  className={
                    `${HIT} ${R_SM} text-[11px] leading-none underline disabled:opacity-40 ` +
                    (fmt.underline ? "bg-accent text-accent-ink" : "text-white/70 hover:bg-white/10")
                  }
                >
                  U
                </button>

                <span className="mx-0.5 h-4 w-px bg-white/10" />

                {/* Colour — the video's own palette, so an edit can't go off-brand */}
                <div className="relative" data-rb-colorpop>
                  <button
                    type="button"
                    title="Text colour"
                    aria-label="Text colour"
                    aria-expanded={colorOpen}
                    onClick={() => setColorOpen((o) => !o)}
                    disabled={!!busy}
                    className={`${HIT} ${R_SM} gap-1 text-white/70 hover:bg-white/10 disabled:opacity-40`}
                  >
                    <span
                      className="block h-3 w-3 rounded-sm border border-white/25"
                      style={{
                        background:
                          fmt.color === "inherit"
                            ? "linear-gradient(135deg,#fff 0 50%,#888 50% 100%)"
                            : fmt.color,
                      }}
                    />
                    <span className="text-[9px]">▾</span>
                  </button>
                  {colorOpen && (
                    <div className={`absolute left-0 top-full z-10 mt-1 flex w-[132px] flex-wrap gap-1 ${R_SM} border border-white/10 bg-[#11141b] p-1.5 shadow-xl`}>
                      <button
                        type="button"
                        title="Auto (inherit the scene's ink)"
                        onClick={() => {
                          void applyFormat({ color: "inherit" });
                          setColorOpen(false);
                        }}
                        className="h-5 w-5 rounded-[4px] border border-white/25"
                        style={{ background: "linear-gradient(135deg,#fff 0 50%,#888 50% 100%)" }}
                      />
                      {swatches.map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={c}
                          onClick={() => {
                            void applyFormat({ color: c });
                            setColorOpen(false);
                          }}
                          className="h-5 w-5 rounded-[4px] border border-white/25"
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <span className="mx-0.5 h-4 w-px bg-white/10" />

                {(["left", "center", "right"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    title={`Align ${a}`}
                    onClick={() => void applyFormat({ align: a })}
                    disabled={!!busy}
                    className={
                      `${HIT} ${R_SM} disabled:opacity-40 ` +
                      (fmt.align === a ? "bg-accent text-accent-ink" : "text-white/70 hover:bg-white/10")
                    }
                  >
                    <AlignIcon a={a} />
                  </button>
                ))}
              </div>
            )}
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
                  className={`h-[28px] w-64 ${R_SM} bg-white/10 px-2 text-[11px] text-white placeholder-white/45 outline-none focus:bg-white/15 disabled:opacity-50`}
                />
                <button
                  type="submit"
                  disabled={!!busy || !regenText.trim()}
                  className={`${HIT} ${R_SM} ${ACTIVE} px-2.5 text-[11px] font-semibold disabled:opacity-50`}
                >
                  Go
                </button>
              </form>
            )}
          </div>
        </>
      )}

      {error && (
        <div style={{ pointerEvents: "auto" }} className={`absolute bottom-12 left-1/2 -translate-x-1/2 ${R_SM} bg-red-600/90 px-3 py-1.5 text-[11px] text-white`}>
          {error}
        </div>
      )}
    </div>
  );
}
