"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * EditorShell — the editor's app-shell chrome, shared by the real editor
 * (/preview) and the dev harness (/dev/edit), and matched 1:1 to the landing's
 * editor performance (components/LandingEditor.tsx). What the landing promises,
 * the product wears: a left slide rail, one unified top toolbar (the real
 * tools + dimensions + zoom + a saved indicator), and a framed light canvas.
 *
 * Purely presentational: every tool button drives a callback on `controls`,
 * which the page wires to the ElementEditor ref. The canvas contents (the
 * iframe + the ElementEditor overlay) come in as `children`.
 */

export interface EditorToolController {
  tool: "select" | "generate";
  canUndo: boolean;
  busy?: boolean;
  select: () => void;
  generate: () => void;
  addText: () => void;
  /** Opens a file picker — this is an upload, not a shape. */
  addImage: () => void;
  undo: () => void;
}

export interface EditorSlide {
  label: string;
  bg?: string;
  ink?: string;
  accent?: string;
  /** Real page preview (the per-scene thumbnail route, version-stamped by the
   *  caller). Absent or failed-to-load falls back to the drawn glyph. */
  thumbSrc?: string;
}

export interface EditorShellProps {
  slides: EditorSlide[];
  active: number;
  onSelect: (i: number) => void;
  /** Drag-to-reorder (founder call 2026-08-29: dragging the rail rows IS the
   *  reorder control — the Move left/right buttons are gone). Absent = the
   *  rail is select-only. */
  onReorder?: (from: number, to: number) => void;
  /** Optional "＋" affordance under the slide list. */
  onAddSlide?: () => void;
  /** Canvas dimensions, shown in the toolbar and driving the frame's aspect. */
  width: number;
  height: number;
  /** e.g. "Fit" or "100%". Purely a label. */
  zoomLabel?: string;
  status?: "saved" | "saving";
  controls: EditorToolController;
  /** Right side of the toolbar — export / regenerate / kind-specific actions. */
  actions?: ReactNode;
  /** Inspector column beside the canvas, on the LEFT next to the slide rail. */
  sidePanel?: ReactNode;
  /** A strip between the toolbar and canvas — warnings, an open regen form. */
  banner?: ReactNode;
  /** The framed canvas contents: the iframe and the ElementEditor overlay. */
  children: ReactNode;
  /** Rail footer (a back link, support, etc.). */
  footer?: ReactNode;
}

export function EditorShell({
  slides,
  active,
  onSelect,
  onReorder,
  onAddSlide,
  width,
  height,
  zoomLabel = "Fit",
  status = "saved",
  controls,
  actions,
  sidePanel,
  banner,
  children,
  footer,
}: EditorShellProps) {
  return (
    <div className="flex h-screen gap-4 overflow-hidden bg-canvas p-4">
      {/* ONE left column: the pages, then the commands that act on them, then
          the way out. Page actions (move / duplicate / delete) operate on
          exactly what the rail lists, so they sit directly UNDER that list
          rather than in a second column beside it — which read as two separate
          pieces of chrome competing for the same attention. */}
      <div className="flex w-[288px] shrink-0 flex-col gap-3">
        <EditorRail slides={slides} active={active} onSelect={onSelect} onReorder={onReorder} onAddSlide={onAddSlide} />

        {sidePanel && (
          <div className="hidden min-h-0 flex-1 overflow-y-auto lg:block">{sidePanel}</div>
        )}

        {footer && (
          <div className="shrink-0 px-1 pb-1 font-mono text-[11px] text-muted">{footer}</div>
        )}
      </div>

      <main className="flex min-w-0 flex-1 flex-col gap-3">
        <EditorToolbar
          width={width}
          height={height}
          zoomLabel={zoomLabel}
          status={status}
          controls={controls}
          actions={actions}
        />

        {banner}

        {/* the canvas: a framed, light stage — the letterbox recedes so the
            user's brand-coloured slide is the loudest thing (DESIGN.md).
            `container-type: size` makes this stage the measuring stick for the
            frame below; it is the only reason the frame can size itself off
            real available space instead of guessing. */}
        <div
          className="flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-hairline bg-surface-2 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]"
          style={{ containerType: "size" }}
        >
          {/* The frame's width is capped by the stage's own HEIGHT, not the
              viewport's.
                The cap used to be `maxWidth: calc(100vh * w/h)`, and 100vh is a
              lie here: the stage never gets the whole viewport, it gets what is
              left after the shell padding, the toolbar, the gaps and any banner
              (~141px, more with a banner). So the width cap never bound,
              `max-h-full` clamped the height instead, and — measured in Chrome —
              clamping one axis of an aspect-ratio box does NOT pull the other
              back: the frame went to 1.90:1 at a 700px viewport and 2.61:1 with
              a banner at 620px, which is where the black pillarbox came from.
                `100cqh` is the stage's content-box height, so this cap tracks
              whatever chrome is actually on screen and cannot drift when the
              chrome changes. min() picks the binding axis, aspect-ratio derives
              the other, and nothing clamps afterwards. Measured 16:9 to within
              0.00008 at viewport heights 1400/1000/800/700/620/540/500, with and
              without a banner, at both 1440 and 1100 wide.
                `w-full` and `max-h-full` stay as the graceful fallback: on an
              engine without container-query units the whole inline width
              declaration is invalid and the class takes over, i.e. exactly the
              old behaviour rather than a zero-width frame. */}
          <div
            className="relative max-h-full w-full overflow-hidden rounded-lg border border-hairline bg-surface shadow-[0_30px_80px_-42px_rgba(18,26,43,0.5)]"
            style={{
              aspectRatio: `${width}/${height}`,
              width: `min(100%, calc(100cqh * ${width} / ${height}))`,
            }}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

/* ─── left rail: the document's slides ───────────────────────────────── */

function EditorRail({
  slides,
  active,
  onSelect,
  onReorder,
  onAddSlide,
}: {
  slides: EditorSlide[];
  active: number;
  onSelect: (i: number) => void;
  onReorder?: (from: number, to: number) => void;
  onAddSlide?: () => void;
}) {
  /* Drag-to-reorder (founder call 2026-08-29): press a row, travel past a
   * small threshold, and an accent insertion line tracks the drop slot; on
   * release the row moves there. Under the threshold it is a plain click —
   * selection must never be lost to a twitchy hand. Rects are cached at
   * gesture start (rows don't move mid-drag), and the row list is the drag
   * surface — no handles, the whole row is grabbable, exactly like gslides. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ from: number; startY: number; rects: { top: number; bottom: number }[] } | null>(null);
  /** Synchronous "this gesture travelled" — the click that follows mouseup
   *  must know immediately, and the drop handler must not depend on async
   *  state (the first cut read dragRef AFTER nulling it: every drop computed
   *  slot 0 and silently no-op'd). */
  const travelledRef = useRef(false);
  const [dragging, setDragging] = useState<{ from: number; slot: number } | null>(null);

  const slotForY = (rects: { top: number; bottom: number }[], clientY: number): number => {
    for (let i = 0; i < rects.length; i++) {
      if (clientY < (rects[i].top + rects[i].bottom) / 2) return i;
    }
    return rects.length;
  };

  const onRowMouseDown = (e: React.MouseEvent, i: number) => {
    if (!onReorder || e.button !== 0 || slides.length < 2) return;
    const rowEls = Array.from(listRef.current?.querySelectorAll("[data-rail-row]") ?? []) as HTMLElement[];
    const rects = rowEls.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    const rowEl = rowEls[i];
    dragRef.current = { from: i, startY: e.clientY, rects };
    travelledRef.current = false;
    let lastSlot = -1;
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!travelledRef.current && Math.abs(ev.clientY - d.startY) < 5) return;
      travelledRef.current = true;
      // The ROW rides the cursor — imperative transform, zero React work per
      // move (a setState per mousemove re-rendered the whole rail at pointer
      // rate and read as lag; founder: "the drag feels a little slow"). React
      // hears only slot CHANGES, which is what the insertion line needs.
      if (rowEl) {
        rowEl.style.transform = `translateY(${ev.clientY - d.startY}px)`;
        rowEl.style.zIndex = "20";
        rowEl.style.pointerEvents = "none";
      }
      const slot = slotForY(d.rects, ev.clientY);
      if (slot !== lastSlot) {
        lastSlot = slot;
        setDragging({ from: d.from, slot });
      }
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const d = dragRef.current;
      dragRef.current = null;
      if (rowEl) {
        rowEl.style.transform = "";
        rowEl.style.zIndex = "";
        rowEl.style.pointerEvents = "";
      }
      setDragging(null);
      if (d && travelledRef.current) {
        const slot = slotForY(d.rects, ev.clientY);
        // Dropping into its own slot (or the gap just after itself) is a no-op.
        const to = slot > d.from ? slot - 1 : slot;
        if (to !== d.from) onReorder(d.from, to);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    // Full width of the left column, and only as tall as it needs to be: the
    // page inspector sits underneath, so the slide list caps itself and scrolls
    // instead of growing until the commands are pushed off-screen.
    <aside className="flex w-full shrink-0 flex-col gap-3">
      <Link href="/documents" className="flex items-center gap-2.5 px-1 pt-1">
        <span className="orb h-6 w-6 shrink-0" aria-hidden />
        <span className="font-display text-[16px] font-semibold tracking-tight text-ink">
          Renderball
        </span>
      </Link>

      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
          Document
        </span>
        {onAddSlide && (
          <button
            type="button"
            onClick={onAddSlide}
            title="Add a slide"
            className="flex h-5 w-5 items-center justify-center rounded-[5px] border border-hairline text-[13px] leading-none text-muted transition-colors hover:border-hairline-strong hover:text-ink"
          >
            +
          </button>
        )}
      </div>

      <div ref={listRef} className="flex max-h-[42vh] min-h-0 flex-col gap-1.5 overflow-y-auto">
        {slides.map((s, i) => {
          const on = i === active;
          const lifted = dragging?.from === i;
          return (
            <div key={i} className="relative">
              {dragging && dragging.slot === i && dragging.from !== i && (
                <span aria-hidden className="absolute -top-[4px] left-1 right-1 z-10 block h-[2px] rounded-full bg-accent" />
              )}
              {/* Preview-only rows (founder, 2026-08-29 second pass): the mini
                  IS the row — no label beside it. The name lives on as the
                  tooltip and the accessible name. */}
              <button
                type="button"
                data-rail-row
                title={s.label}
                aria-label={`Page ${i + 1} — ${s.label}`}
                onMouseDown={(e) => onRowMouseDown(e, i)}
                onClick={() => {
                  // A completed drag must not also select — the mouseup already
                  // decided what happened; a plain click still selects.
                  if (!travelledRef.current) onSelect(i);
                }}
                className={cn(
                  "group relative flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition-colors",
                  onReorder && slides.length > 1 && "cursor-grab active:cursor-grabbing",
                  lifted && "shadow-lg",
                  on
                    ? "border-accent-line bg-accent-soft"
                    : "border-hairline bg-surface hover:border-hairline-strong",
                )}
              >
                <span className="font-mono text-[9px] tabular-nums text-faint">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <RailThumb slide={s} on={on} />
              </button>
            </div>
          );
        })}
        {dragging && dragging.slot === slides.length && (
          <span aria-hidden className="mx-1 block h-[2px] rounded-full bg-accent" />
        )}
      </div>
    </aside>
  );
}

/** The REAL page in miniature (founder call 2026-08-29, gslides-style): the
 *  per-scene thumbnail when one exists, the drawn glyph otherwise — a page
 *  that has never rendered (mid-build, capture failure) degrades to the same
 *  mini the landing rail draws, never to a broken-image icon. */
function RailThumb({ slide, on }: { slide: EditorSlide; on: boolean }) {
  const [broken, setBroken] = useState(false);
  const showImage = !!slide.thumbSrc && !broken;
  return (
    <span
      className={cn(
        "block aspect-video min-w-0 flex-1 overflow-hidden rounded-[3px] border",
        on ? "border-accent-line" : "border-hairline",
      )}
      style={showImage ? undefined : { background: slide.bg ?? "var(--surface-2)" }}
      aria-hidden
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={slide.thumbSrc}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <>
          <span
            className="block h-[3px] w-2/3 rounded-full"
            style={{ margin: "4px 0 0 3px", background: slide.ink ?? "var(--muted)", opacity: 0.9 }}
          />
          <span
            className="block h-[1.5px] w-1/2 rounded-full"
            style={{ margin: "2px 0 0 3px", background: slide.ink ?? "var(--faint)", opacity: 0.35 }}
          />
          <span
            className="block h-[4px] w-1/4 rounded-[1px]"
            style={{ margin: "3px 0 0 3px", background: slide.accent ?? "var(--accent)" }}
          />
        </>
      )}
    </span>
  );
}

/* ─── top toolbar: the real tools, dimensions, zoom, saved state ──────── */

function EditorToolbar({
  width,
  height,
  zoomLabel,
  status,
  controls: c,
  actions,
}: {
  width: number;
  height: number;
  zoomLabel: string;
  status: "saved" | "saving";
  controls: EditorToolController;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-1.5">
      {/* pointer tools */}
      <ToolButton
        label="Select"
        hint="Select — click an element to move, resize, rewrite or regenerate it"
        active={c.tool === "select"}
        onClick={c.select}
      >
        <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" fill="currentColor">
          <path d="M4 2 L4 15 L7.5 11.8 L10 17 L11.8 16.2 L9.4 11.2 L14 11 Z" />
        </svg>
      </ToolButton>
      {/* Not a duplicate of Select, which only starts a box on EMPTY canvas.
          On a full slide every press lands on an element, so this arms the whole
          canvas as a drawing surface — the only way to draw over what is there. */}
      <ToolButton
        label="Generate"
        hint="Draw a box anywhere — including over existing elements — and say what belongs in it"
        active={c.tool === "generate"}
        onClick={c.generate}
        disabled={c.busy}
      >
        <span className="h-3 w-3.5 rounded-[2px] border-[1.5px] border-dashed border-current" />
      </ToolButton>

      <Divider />

      {/* add primitives — deterministic, no model, no spend */}
      <ToolButton label="Text" hint="Add an editable text box" onClick={c.addText} disabled={c.busy}>
        <span className="font-display text-[12px] font-bold leading-none">T</span>
      </ToolButton>
      <ToolButton
        label="Image"
        hint="Upload an image from your computer"
        onClick={c.addImage}
        disabled={c.busy}
      >
        {/* An upload glyph, not a plain square: this opens a file picker, and a
            bare rectangle read as "draw a rectangle". */}
        <svg
          viewBox="0 0 18 18"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M9 11.5 V3" />
          <path d="M5.75 6.25 L9 3 L12.25 6.25" />
          <path d="M3 11.5 v2.25 a1 1 0 0 0 1 1 h10 a1 1 0 0 0 1 -1 V11.5" />
        </svg>
      </ToolButton>

      <Divider />

      <ToolButton label="Undo" hint="Undo the last edit" onClick={c.undo} disabled={!c.canUndo}>
        <span className="text-[13px] leading-none">↩</span>
      </ToolButton>

      <Divider />
      <span className="font-mono text-[10.5px] text-muted">
        {width} × {height}
      </span>
      <Divider />
      <span className="font-mono text-[10.5px] text-faint">{zoomLabel}</span>

      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              status === "saving" ? "bg-amber-400" : "bg-accent",
            )}
            aria-hidden
          />
          {status === "saving" ? "saving…" : "autosaved"}
        </span>
        {actions}
      </span>
    </div>
  );
}

/**
 * A tool: glyph with its NAME under it.
 *
 * The row was icon-only, and icon-only asks the user to guess. Two of the
 * glyphs were guessed wrong in practice — a dashed rectangle does not say
 * "generate", and a plain square does not say "upload an image" — so the label
 * is part of the control now rather than a tooltip you have to hover to find.
 * `hint` carries the longer explanation for those who do hover.
 */
function ToolButton({
  label,
  hint,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ?? label}
      aria-label={hint ?? label}
      aria-pressed={active}
      // Stable hook for the QA suite. The accessible name is the long HINT
      // (better for screen readers), which makes "the button called Select"
      // unmatchable — so automation targets this instead of prose that is free
      // to change.
      data-rb-tool={label.toLowerCase()}
      className={cn(
        "flex w-[54px] shrink-0 flex-col items-center justify-center gap-1 rounded-md py-1.5 transition-colors disabled:opacity-40",
        active
          ? "bg-accent-soft text-accent-text"
          : "text-muted hover:bg-surface-2 hover:text-ink",
      )}
    >
      <span className="flex h-4 items-center justify-center">{children}</span>
      <span className="font-mono text-[9.5px] leading-none tracking-tight">{label}</span>
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-hairline" aria-hidden />;
}
