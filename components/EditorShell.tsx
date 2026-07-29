"use client";

import Link from "next/link";
import type { ReactNode } from "react";
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
}

export interface EditorShellProps {
  slides: EditorSlide[];
  active: number;
  onSelect: (i: number) => void;
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
        <EditorRail slides={slides} active={active} onSelect={onSelect} onAddSlide={onAddSlide} />

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
            user's brand-coloured slide is the loudest thing (DESIGN.md) */}
        <div className="flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-hairline bg-surface-2 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
          <div
            className="relative max-h-full w-full overflow-hidden rounded-lg border border-hairline bg-surface shadow-[0_30px_80px_-42px_rgba(18,26,43,0.5)]"
            style={{ aspectRatio: `${width}/${height}`, maxWidth: `calc(100vh * ${width} / ${height})` }}
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
  onAddSlide,
}: {
  slides: EditorSlide[];
  active: number;
  onSelect: (i: number) => void;
  onAddSlide?: () => void;
}) {
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

      <div className="flex max-h-[42vh] min-h-0 flex-col gap-1.5 overflow-y-auto">
        {slides.map((s, i) => {
          const on = i === active;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              className={cn(
                "group flex items-center gap-2 rounded-md border p-1.5 text-left transition-all",
                on
                  ? "border-accent-line bg-accent-soft"
                  : "border-hairline bg-surface hover:border-hairline-strong",
              )}
            >
              <span className="font-mono text-[9px] tabular-nums text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <RailThumb slide={s} on={on} />
              <span
                className={cn(
                  "flex-1 truncate text-[11.5px]",
                  on ? "text-ink" : "text-muted",
                )}
              >
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** A generated mini of the slide — same treatment as the landing's rail. */
function RailThumb({ slide, on }: { slide: EditorSlide; on: boolean }) {
  return (
    <span
      className={cn(
        "block aspect-video w-9 shrink-0 overflow-hidden rounded-[3px] border",
        on ? "border-accent-line" : "border-hairline",
      )}
      style={{ background: slide.bg ?? "var(--surface-2)" }}
      aria-hidden
    >
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
