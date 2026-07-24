"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  SANDBOX_CONTENT,
  SANDBOX_INTENTS,
  MARQUEE_MIN,
  clampBoxToRegion,
  isRealMarquee,
  normalizeBox,
  saveSandboxState,
  variantFor,
  type LandingSandboxState,
  type SandboxBox,
  type SandboxElement,
  type SandboxIntent,
} from "../lib/landing-sandbox";

/**
 * The landing's INTERACTIVE half — the visitor's turn (DESIGN.md "Landing —
 * the canvas performs"; the 2026-07-24 consultation's deferred idea, ported
 * onto the v3 cursor-authored performance).
 *
 * The scripted beats in LandingCanvas.tsx are a pure function of scroll; this
 * module is additive and independent: pointer plumbing for a real marquee,
 * an intent picker (chips — the landing ships NO prompt box), instant
 * materialization from a local content set (zero LLM calls, mono `sandbox`
 * label), and persistence to localStorage so /new can offer "continue what
 * you started" after sign-in.
 *
 * Bounds discipline matches the editor: the user's box is law — clamping
 * only slides a box inside the band, it never resizes what they drew.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _MIN = MARQUEE_MIN;

export function Handles() {
  const pos = [
    "-left-1 -top-1",
    "left-1/2 -top-1 -translate-x-1/2",
    "-right-1 -top-1",
    "-left-1 top-1/2 -translate-y-1/2",
    "-right-1 top-1/2 -translate-y-1/2",
    "-left-1 -bottom-1",
    "left-1/2 -bottom-1 -translate-x-1/2",
    "-right-1 -bottom-1",
  ];
  return (
    <>
      {pos.map((c) => (
        <span
          key={c}
          className={`absolute ${c} z-20 h-2 w-2 rounded-[2px] border border-accent bg-surface`}
          aria-hidden
        />
      ))}
    </>
  );
}

/* ─── beats ──────────────────────────────────────────────────────────── */


export function DotGrid() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-[0.5]"
      style={{
        backgroundImage:
          "radial-gradient(circle, rgba(18,26,43,0.10) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
      aria-hidden
    />
  );
}


type HeroOffsets = Record<string, { x: number; y: number }>;

type SandboxController = {
  elements: SandboxElement[];
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  pending: SandboxBox | null;
  heroOffsets: HeroOffsets;
  heroDragging: string | null;
  elementDragging: string | null;
  drawing: boolean;
  hostRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  choose: (intent: SandboxIntent) => void;
  dismiss: () => void;
};

type DragState =
  | { kind: "marquee"; x0: number; y0: number }
  | { kind: "element"; id: string; startX: number; startY: number; origin: SandboxBox }
  | { kind: "hero"; id: string; startX: number; startY: number; origin: { x: number; y: number } };

/**
 * All pointer plumbing for one sandbox surface (the scroll stage or the
 * static panel). One host-level handler set routes a press exactly like the
 * editor does: press on a draggable element = drag it; press on a link /
 * button / scripted piece = pass through; press on the capture region
 * (empty canvas inside the band) = marquee. The user's box is law —
 * clamping only slides a box inside the region, it never resizes what they
 * drew.
 */
export function useSandbox({
  hostRef,
  surface,
  armed,
  interactive,
  regionTop = 0,
  heroBase,
  startVariants,
}: {
  hostRef: React.RefObject<HTMLDivElement>;
  surface: LandingSandboxState["surface"];
  armed: boolean;
  interactive: boolean;
  regionTop?: number;
  heroBase?: Record<string, SandboxBox>;
  /** Variant offset per intent, so a visitor's first pick never duplicates
   *  the content a scripted artifact is already showing on the same stage. */
  startVariants?: Partial<Record<SandboxIntent, number>>;
}): SandboxController {
  const [elements, elementsState] = useState<SandboxElement[]>([]);
  // Ref mirror so event handlers always see the latest committed list and
  // persistence never runs inside a state updater (StrictMode double-invokes
  // updaters; localStorage writes belong outside them).
  const elementsRef = useRef<SandboxElement[]>(elements);
  const setElements = (update: (els: SandboxElement[]) => SandboxElement[]) => {
    elementsRef.current = update(elementsRef.current);
    elementsState(elementsRef.current);
  };
  const [marquee, setMarquee] = useState<SandboxController["marquee"]>(null);
  const [pending, setPending] = useState<SandboxBox | null>(null);
  const [heroOffsets, setHeroOffsets] = useState<HeroOffsets>({});
  const [heroDragging, setHeroDragging] = useState<string | null>(null);
  const [elementDragging, setElementDragging] = useState<string | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const heroMovesRef = useRef(0);
  const drawCountRef = useRef<Record<SandboxIntent, number>>({
    kpi: startVariants?.kpi ?? 0,
    chart: startVariants?.chart ?? 0,
    quote: startVariants?.quote ?? 0,
  });
  const idRef = useRef(0);

  // Serialize the visitor's work for /new's "continue what you started".
  // Only real work is written — an empty session never clobbers a previous
  // visit's stored canvas.
  const persist = (els: SandboxElement[], heroMoves: number) => {
    if (els.length === 0 && heroMoves === 0) return;
    const host = hostRef.current;
    saveSandboxState({
      v: 1,
      surface,
      stage: { w: host?.clientWidth ?? 0, h: host?.clientHeight ?? 0 },
      elements: els,
      heroMoves,
      updatedAt: Date.now(),
    });
  };

  /** The drawable region: the band on the stage, the whole host on the panel. */
  const region = (): SandboxBox => {
    const host = hostRef.current;
    const w = host?.clientWidth ?? 0;
    const h = host?.clientHeight ?? 0;
    return { x: 0, y: regionTop, w, h: Math.max(0, h - regionTop) };
  };

  const toLocal = (e: React.PointerEvent) => {
    const r = hostRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || dragRef.current) return;
    const t = e.target as HTMLElement;
    if (pending) {
      // A press anywhere outside the picker abandons the pending box.
      if (!t.closest("[data-rb-picker]")) setPending(null);
      return;
    }
    const dragEl = t.closest<HTMLElement>("[data-rb-drag]");
    if (dragEl && interactiveRef.current) {
      const id = dragEl.dataset.rbDrag!;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (id.startsWith("hero:")) {
        dragRef.current = {
          kind: "hero",
          id,
          startX: e.clientX,
          startY: e.clientY,
          origin: heroOffsets[id] ?? { x: 0, y: 0 },
        };
        setHeroDragging(id);
      } else {
        const el = elementsRef.current.find((el) => el.id === id);
        if (!el) return;
        dragRef.current = {
          kind: "element",
          id,
          startX: e.clientX,
          startY: e.clientY,
          origin: el.box,
        };
        setElementDragging(id);
      }
      return;
    }
    // Marquees start only on the capture region — empty canvas inside the
    // band. Links, buttons, and scripted pieces pass through untouched.
    if (t.closest("a,button,input,textarea,select,[data-rb-piece]")) return;
    if (!armedRef.current || !t.closest("[data-rb-region]")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toLocal(e);
    dragRef.current = { kind: "marquee", x0: pt.x, y0: pt.y };
    setMarquee({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "marquee") {
      const pt = toLocal(e);
      setMarquee({ x0: d.x0, y0: d.y0, x1: pt.x, y1: pt.y });
    } else if (d.kind === "element") {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const clamped = clampBoxToRegion(
        { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy },
        region(),
      );
      setElements((els) =>
        els.map((el) => (el.id === d.id ? { ...el, box: clamped } : el)),
      );
    } else {
      const base = heroBase?.[d.id];
      const ox = d.origin.x + (e.clientX - d.startX);
      const oy = d.origin.y + (e.clientY - d.startY);
      let off = { x: ox, y: oy };
      if (base) {
        const clamped = clampBoxToRegion(
          { x: base.x + ox, y: base.y + oy, w: base.w, h: base.h },
          region(),
        );
        off = { x: clamped.x - base.x, y: clamped.y - base.y };
      }
      setHeroOffsets((cur) => ({ ...cur, [d.id]: off }));
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.kind === "marquee") {
      setMarquee(null);
      if (!cancelled) {
        const pt = toLocal(e);
        const box = normalizeBox(d.x0, d.y0, pt.x, pt.y);
        if (isRealMarquee(box)) setPending(clampBoxToRegion(box, region()));
      }
      return;
    }
    if (d.kind === "element") {
      setElementDragging(null);
      setElements((els) =>
        els.map((el) => (el.id === d.id ? { ...el, moved: true } : el)),
      );
      persist(elementsRef.current, heroMovesRef.current);
      return;
    }
    setHeroDragging(null);
    heroMovesRef.current += 1;
    persist(elementsRef.current, heroMovesRef.current);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, false);
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, true);

  const choose = (intent: SandboxIntent) => {
    if (!pending) return;
    const variant = variantFor(intent, drawCountRef.current[intent]);
    drawCountRef.current[intent] += 1;
    const el: SandboxElement = {
      id: `sb-${surface}-${idRef.current++}`,
      intent,
      variant,
      box: pending,
      moved: false,
    };
    setPending(null);
    setElements((els) => [...els, el]);
    persist(elementsRef.current, heroMovesRef.current);
  };

  const dismiss = () => setPending(null);

  // Escape abandons the gesture in flight (mirrors the editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPending(null);
      if (dragRef.current?.kind === "marquee") {
        dragRef.current = null;
        setMarquee(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // When the deck beat clears the stage, in-flight sandbox chrome goes too.
  useEffect(() => {
    if (!interactive) {
      setPending(null);
      setMarquee(null);
    }
  }, [interactive]);

  return {
    elements,
    marquee,
    pending,
    heroOffsets,
    heroDragging,
    elementDragging,
    drawing: marquee !== null || heroDragging !== null || elementDragging !== null,
    hostRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    choose,
    dismiss,
  };
}

/** The marquee catcher: empty canvas inside the band. Sits UNDER the beats
 *  and the visitor's elements in paint order, so anything interactive wins
 *  the hit-test and everything else falls through to "draw here". */
export function CaptureRegion({ top, armed }: { top: number; armed: boolean }) {
  return (
    <div
      data-rb-region
      className="absolute inset-x-0 bottom-0 cursor-crosshair"
      style={{ top, pointerEvents: armed ? "auto" : "none" }}
      aria-hidden
    />
  );
}


/** The visitor's layer: their elements, the live rubber band, the frozen box
 *  with its intent picker, and (via children) the draw-here hint. Dimmed and
 *  inert once the deck beat clears the stage for the finale. */
export function SandboxLayer({
  sb,
  interactive,
  tabbable,
  children,
}: {
  sb: SandboxController;
  interactive: boolean;
  tabbable: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 transition-opacity duration-700"
      style={{ opacity: interactive ? 1 : 0.35 }}
    >
      {sb.elements.map((el) => (
        <UserElement
          key={el.id}
          el={el}
          dragging={sb.elementDragging === el.id}
          interactive={interactive}
        />
      ))}

      {sb.marquee && (
        <div
          className="absolute rounded-lg"
          style={{
            left: Math.min(sb.marquee.x0, sb.marquee.x1),
            top: Math.min(sb.marquee.y0, sb.marquee.y1),
            width: Math.abs(sb.marquee.x1 - sb.marquee.x0),
            height: Math.abs(sb.marquee.y1 - sb.marquee.y0),
            border: "1.5px dashed var(--accent, #00c28a)",
            background: "rgba(0,194,138,0.12)",
          }}
          aria-hidden
        />
      )}

      {sb.pending && (
        <>
          <div
            className="absolute rounded-[4px]"
            style={{
              left: sb.pending.x,
              top: sb.pending.y,
              width: sb.pending.w,
              height: sb.pending.h,
              border: "2px solid var(--accent, #00c28a)",
              background: "rgba(0,194,138,0.08)",
            }}
            aria-hidden
          />
          <IntentPicker box={sb.pending} sb={sb} tabbable={tabbable} />
        </>
      )}

      {children}
    </div>
  );
}

/** Precomputed-intent picker under the frozen box — the landing's diegetic
 *  stand-in for the editor's generate prompt. Chips, not a text box (the
 *  landing ships no prompt box); picks materialize instantly, zero LLM. */
function IntentPicker({
  box,
  sb,
  tabbable,
}: {
  box: SandboxBox;
  sb: SandboxController;
  tabbable: boolean;
}) {
  // Anchored under the frozen box; clamped inside the host and flipped above
  // when a box drawn near the bottom leaves no room (mirrors the editor).
  const PICKER_W = 384;
  const PICKER_H = 40;
  const hostW = sb.hostRef.current?.clientWidth ?? 1180;
  const hostH = sb.hostRef.current?.clientHeight ?? 800;
  return (
    <div
      data-rb-picker
      className="pointer-events-auto absolute z-30 flex flex-wrap items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-1.5 shadow-sm"
      style={{
        left: Math.max(4, Math.min(box.x, hostW - PICKER_W - 4)),
        top:
          box.y + box.h + 8 + PICKER_H <= hostH
            ? box.y + box.h + 8
            : Math.max(4, box.y - PICKER_H - 8),
        maxWidth: Math.max(180, hostW - 8),
      }}
    >
      <span className="whitespace-nowrap font-mono text-[11px] text-muted">
        what lives here —
      </span>
      {SANDBOX_INTENTS.map((i) => (
        <button
          key={i.intent}
          type="button"
          tabIndex={tabbable ? 0 : -1}
          onClick={() => sb.choose(i.intent)}
          className="whitespace-nowrap rounded-full border border-hairline-strong px-2.5 py-1 font-mono text-[11px] text-ink-soft transition-colors hover:border-accent-line hover:text-ink"
        >
          {i.chip}
        </button>
      ))}
      <button
        type="button"
        tabIndex={tabbable ? 0 : -1}
        onClick={sb.dismiss}
        aria-label="Dismiss"
        className="px-1 font-mono text-[12px] text-faint transition-colors hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}


/** One materialized visitor element: content fits the drawn box exactly
 *  (the box is law), drags with the selection-handle affordance, and wears
 *  the honest mono `sandbox` tag. */
function UserElement({
  el,
  dragging,
  interactive,
}: {
  el: SandboxElement;
  dragging: boolean;
  interactive: boolean;
}) {
  return (
    <div
      className="group absolute"
      style={{
        left: el.box.x,
        top: el.box.y,
        width: el.box.w,
        height: el.box.h,
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      <div
        data-rb-drag={el.id}
        data-rb-anim
        className={`relative h-full w-full overflow-hidden rounded-lg border bg-surface shadow-[0_16px_40px_-24px_rgba(18,26,43,0.35)] [touch-action:none] ${
          dragging ? "cursor-grabbing border-accent-line" : "cursor-grab border-hairline"
        }`}
        style={{ animation: "rb-fade-up 0.38s cubic-bezier(0.16,1,0.3,1) both" }}
      >
        <SandboxElementContent el={el} />
      </div>
      <span
        className={`transition-opacity duration-150 ${
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        aria-hidden
      >
        <Handles />
      </span>
      <p className="absolute -bottom-5 left-0 whitespace-nowrap font-mono text-[10px] tracking-[0.1em] text-faint">
        sandbox
        <span
          className={`tabular-nums transition-opacity duration-150 ${
            dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          {" "}
          · x {Math.round(el.box.x)} · y {Math.round(el.box.y)} · {Math.round(el.box.w)} ×{" "}
          {Math.round(el.box.h)}
        </span>
      </p>
    </div>
  );
}

/** Intent content, scaled off the box dimensions so any drawn size reads.
 *  Kin of the scripted artifacts — the visitor's elements deserve the same
 *  design bar (delta chip + sparkline when the box has room). */
function SandboxElementContent({ el }: { el: SandboxElement }) {
  const { w, h } = el.box;
  if (el.intent === "kpi") {
    const c = SANDBOX_CONTENT.kpi[el.variant % SANDBOX_CONTENT.kpi.length];
    const spark = [12, 16, 14, 20, 24, 22, 30, 34];
    const max = Math.max(...spark);
    const pts = spark
      .map((v, i) => `${(i / (spark.length - 1)) * 96 + 2},${34 - (v / max) * 30}`)
      .join(" ");
    return (
      <div
        className="flex h-full flex-col justify-center"
        style={{ padding: Math.max(10, Math.min(20, h * 0.1)) }}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            {c.eyebrow}
          </p>
          {w >= 210 && (
            <span className="shrink-0 rounded-full bg-[rgba(18,26,43,0.05)] px-2 py-0.5 font-mono text-[10px] text-accent-text">
              {c.delta}
            </span>
          )}
        </div>
        <p
          className="mt-1.5 font-display font-bold leading-none tracking-tight text-accent-text"
          style={{ fontSize: Math.max(16, Math.min(h * 0.34, w * 0.22, 56)) }}
        >
          {c.value}
        </p>
        <p className="mt-1.5 truncate text-[12.5px] text-ink-soft">{c.note}</p>
        {h >= 150 && (
          <svg viewBox="0 0 100 36" className="mt-2 h-8 w-full text-accent-text" aria-hidden>
            <polyline
              points={pts}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
    );
  }
  if (el.intent === "chart") {
    const c = SANDBOX_CONTENT.chart[el.variant % SANDBOX_CONTENT.chart.length];
    return (
      <div
        className="flex h-full flex-col"
        style={{ padding: Math.max(8, Math.min(16, h * 0.08)) }}
      >
        <p className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          {c.label}
        </p>
        <div className="mt-2 flex min-h-0 flex-1 items-end gap-1.5 border-b border-hairline pb-0.5">
          {c.bars.map((v, i) => {
            const last = i === c.bars.length - 1;
            return (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                {h >= 150 && (
                  <span
                    className={`font-mono text-[9px] tabular-nums ${
                      last ? "text-accent-text" : "text-muted"
                    }`}
                  >
                    {v}
                  </span>
                )}
                <div
                  className={`w-full rounded-[3px] ${last ? "bg-accent" : "bg-surface-3"}`}
                  style={{ height: `${v * 0.72}%` }}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  const c = SANDBOX_CONTENT.quote[el.variant % SANDBOX_CONTENT.quote.length];
  return (
    <div
      className="flex h-full flex-col justify-center"
      style={{ padding: Math.max(10, Math.min(22, h * 0.12)) }}
    >
      <p
        className="font-display font-bold leading-[1.15] tracking-tight text-ink"
        style={{ fontSize: Math.max(13, Math.min(h * 0.18, w * 0.07, 24)) }}
      >
        “{c.text}”
      </p>
      <p className="mt-2 font-mono text-[10px] tracking-[0.1em] text-muted">— {c.by}</p>
    </div>
  );
}


/** The invitation: a ghost box + mono line where the visitor's turn starts. */
export function SandboxHint({
  show,
  style,
}: {
  show: boolean;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="absolute flex items-center justify-center rounded-lg border border-dashed border-hairline-strong transition-opacity duration-500"
      style={{ ...style, opacity: show ? 1 : 0 }}
      aria-hidden
    >
      <p className="font-mono text-[11px] tracking-[0.08em] text-muted">
        your turn — draw here
      </p>
    </div>
  );
}

/** The bounded sandbox for the static branch (mobile + reduced motion): the
 *  same draw → pick → materialize loop inside a panel, without the scroll
 *  theatrics. `still` is the server-rendered composed frame the caller
 *  supplies (kept in LandingCanvas so this module stays presentation-free). */
export function SandboxPanel({ still }: { still?: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sb = useSandbox({
    hostRef,
    surface: "panel",
    armed: true,
    interactive: true,
  });
  return (
    <div className="mt-14 text-left">
      <div
        ref={hostRef}
        className={`relative h-[340px] overflow-hidden rounded-lg border border-hairline bg-canvas ${
          sb.drawing ? "select-none" : ""
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={sb.onPointerDown}
        onPointerMove={sb.onPointerMove}
        onPointerUp={sb.onPointerUp}
        onPointerCancel={sb.onPointerCancel}
      >
        <CaptureRegion top={0} armed={!sb.pending} />
        <DotGrid />
        {still && (
          <div
            data-rb-piece
            className="absolute left-4 top-4 w-[360px] origin-top-left scale-[0.78] cursor-default"
          >
            {still}
          </div>
        )}
        <SandboxLayer sb={sb} interactive tabbable>
          <SandboxHint
            show={sb.elements.length === 0 && !sb.marquee && !sb.pending}
            style={{ right: 16, bottom: 24, width: 170, height: 76 }}
          />
        </SandboxLayer>
      </div>
      <p className="mt-3 font-mono text-[10px] tracking-[0.1em] text-faint">
        drawn as a box · generated as a real element · sandbox — zero model
        calls in here
      </p>
    </div>
  );
}
