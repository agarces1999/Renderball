"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { matchFieldPath } from "../../../lib/edit/scene-content";
import { asciiTrim } from "../../../lib/edit/piece-literal";
import { cascadeBox } from "../../../lib/edit/cascade-box";
import { snapBox, DEFAULT_SNAP_THRESHOLD, type Guide } from "../../../lib/edit/snap";
import { nudgeFor, constrainToAxis } from "../../../lib/edit/nudge";

/** Host-scaling mode — see components/SceneFrame.tsx for why the literal is required. */
const HOST_SCALE = ["on", "1", "true", "yes"].includes(
  String(process.env.NEXT_PUBLIC_RB_HOST_SCALE ?? "").trim().toLowerCase(),
);
import { parseFmt, serializeFmt, type FreetextFormat } from "../../../lib/edit/freetext";
import { MOTION_SETTLE_CAP_MS, SETTLE_CSS, SETTLE_STYLE_ID } from "../../../lib/render/settle-css";

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
  /** A commit landed WITHOUT needing a reload (optimistic geometry). Parents
   *  refresh derived things (thumbnails, autosave chips) but must NOT bump
   *  the iframe. Optional so both clients adopt at their own pace. */
  onCommitted?: () => void;
  apiBase?: string;
  /** Start with the piece x-ray on (the dev dashboard defaults to visible). */
  defaultShowAll?: boolean;
  /**
   * Hide the overlay's own floating controls (the Add pill, the top-right
   * undo/x-ray cluster, the bottom guidance hint). The editor SHELL renders a
   * unified toolbar instead and drives the same actions through the ref below.
   * Selection, hover, marquee, grips and text-edit chrome always stay.
   */
  hideToolbar?: boolean;
  /** Report tool/undo/x-ray/busy state up so a shell toolbar can reflect it. */
  onState?: (s: EditorState) => void;
}

/** The actions a shell toolbar can invoke — the same ones the internal pill fires. */
export interface ElementEditorHandle {
  /** Morph the live scene doc from a fresh server render; false = caller
   *  should fall back to a full reload. */
  morphReload: () => Promise<boolean>;
  addText: () => void;
  addImage: () => void;
  addIcon: () => void;
  toggleGenerate: () => void;
  toggleOutlines: () => void;
  undo: () => void;
  /**
   * Regenerate the CURRENTLY selected element with this instruction — the
   * Element panel's path (2026-08-14). Runs the editor's own regen so the
   * selection survives the reload (reselectIdRef); a panel that fetched the
   * route directly watched its own tab vanish mid-success, because the
   * reload cleared the selection it depended on.
   */
  regenerateSelected: (instruction: string) => void;
  /**
   * Animate the CURRENTLY selected element with this motion instruction
   * (2026-09-03) — the regenerate path in motion-only mode, then the page's
   * choreography replays so the user SEES what they just asked for.
   */
  animateSelected: (instruction: string) => void;
  /** Replay the current page's entrance choreography in place (no reload). */
  replayMotion: () => void;
}

/** A snapshot of the editor's chrome-relevant state, for a shell toolbar. */
export interface EditorState {
  tool: "select" | "generate";
  showAll: boolean;
  canUndo: boolean;
  busy: string | null;
  /** The selected element, for the shell's Element panel (2026-08-14 —
   *  click an element, see and edit the prompt behind it). Null = none. */
  selected: { pieceId: string; kind: string } | null;
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

/**
 * Footprint of the generate prompt bar (kind toggle + input + Generate/Cancel).
 * The bar is content-sized, but its widest part — the input — is a fixed w-72,
 * so these are accurate enough to decide whether the bar fits INSIDE the box the
 * user drew, and to centre it there. Single-sourced: the outside-the-box clamp
 * uses the same width.
 */
/** One proposed region from the Suggest box (lib/agents/suggest-layout.ts). */
export interface LayoutSuggestion {
  label: string;
  prompt: string;
  bounds: { x: number; y: number; w: number; h: number };
}

/**
 * What generation looks like while it runs.
 *
 * Sits exactly on the box being built, so the wait happens WHERE the thing will
 * appear rather than in a corner spinner — the box reads as already claimed. A
 * slow sheen sweeps the area (that is the work), the crystal ball from the brand
 * turns above the label, and the border breathes. Every layer is CSS: no images,
 * no library, and nothing that keeps painting once the element lands.
 *
 * `prefers-reduced-motion` drops the sweep and the pulse and leaves a static
 * tinted box with the label, which still answers "is anything happening".
 */
function GeneratingOverlay({
  box,
  label,
}: {
  box: { left: number; top: number; width: number; height: number };
  label: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        borderRadius: 10,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 46,
        border: "1.5px solid var(--accent, #00c28a)",
        background: "rgba(0,194,138,0.07)",
        animation: "rb-gen-breathe 2.4s ease-in-out infinite",
      }}
      aria-live="polite"
      aria-label={label}
    >
      <style>{`
        @keyframes rb-gen-sweep {
          0%   { transform: translateX(-120%); }
          100% { transform: translateX(120%); }
        }
        @keyframes rb-gen-breathe {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0,194,138,0.30); }
          50%      { box-shadow: 0 0 22px 3px rgba(0,194,138,0.22); }
        }
        @keyframes rb-gen-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .rb-gen-sweep, .rb-gen-orb { animation: none !important; }
        }
      `}</style>

      {/* the sweep — a wide angled sheen crossing the box */}
      <div
        className="rb-gen-sweep"
        style={{
          position: "absolute",
          inset: "-40% -10%",
          background:
            "linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%)",
          animation: "rb-gen-sweep 1.9s ease-in-out infinite",
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span
          className="rb-gen-orb"
          style={{ display: "inline-flex", animation: "rb-gen-spin 3.2s linear infinite" }}
        >
          <CrystalOrb size={box.width > 220 && box.height > 120 ? 26 : 16} />
        </span>
        {/* The label is dropped in boxes too small to hold it legibly. */}
        {box.width > 190 && box.height > 74 && (
          <span
            className={`${R_SM} bg-[#11141b] px-2 py-1 font-mono text-[10.5px] tracking-tight text-white/90`}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

/** One row of the right-click menu. */
function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={
        "block w-full px-3 py-1.5 text-left text-[12px] transition-colors disabled:opacity-40 " +
        (danger ? "text-red-300 hover:bg-red-500/15" : "text-white/85 hover:bg-white/10")
      }
    >
      {children}
    </button>
  );
}

const GEN_BAR_W = 560;
const GEN_BAR_H = 40;
/** Breathing room required between the bar and the box edge to sit inside. */
const GEN_BAR_PAD = 14;
/** The same controls stacked in three rows — chips, prompt, buttons — for a box
 *  that is tall enough to host them but too narrow for the single row. */
const GEN_STACK_W = 232;
const GEN_STACK_H = 116;
const GEN_STACK_PAD = 10;
/** A stacked panel never grows past this, so a huge-but-narrow box does not get
 *  a comically wide column. */
const GEN_STACK_MAX_W = 320;

export type GenBarLayout = "row" | "stack" | "outside";

/**
 * Where the generate controls go for a given drawn box.
 *
 * The box is the thing being filled, so the question about what goes in it
 * belongs IN it — a detached toolbar reads as chrome, and when the box sits near
 * an edge the detached bar also has to be clamped, which drags it across
 * whatever is next to the box.
 *
 * Two inside shapes, because one fixed 560×40 row made "inside" mean "only for
 * boxes wider than 588px" and a perfectly ordinary tall-narrow box (a sidebar
 * card, a portrait image slot) still got the detached bar:
 *   row   — the full single line, centred, when the box can hold 560×40.
 *   stack — the identical controls in three rows, centred, when the box can hold
 *           232×116. Same buttons, same order, nothing dropped.
 * Only a box too small for even the stack falls outside: below when there is
 * room, flipped above when it hugs the bottom edge, clamped so the controls can
 * never leave the canvas.
 *
 * Pure and exported so every branch is unit-tested rather than eyeballed.
 */
export const genBarPosition = (
  box: { left: number; top: number; width: number; height: number },
  overlayW: number,
  overlayH: number,
): { left: number; top: number; inside: boolean; layout: GenBarLayout; width: number } => {
  if (box.width >= GEN_BAR_W + GEN_BAR_PAD * 2 && box.height >= GEN_BAR_H + GEN_BAR_PAD * 2) {
    return {
      left: box.left + (box.width - GEN_BAR_W) / 2,
      top: box.top + (box.height - GEN_BAR_H) / 2,
      inside: true,
      layout: "row",
      width: GEN_BAR_W,
    };
  }
  if (box.width >= GEN_STACK_W + GEN_STACK_PAD * 2 && box.height >= GEN_STACK_H + GEN_STACK_PAD * 2) {
    const width = Math.min(box.width - GEN_STACK_PAD * 2, GEN_STACK_MAX_W);
    return {
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - GEN_STACK_H) / 2,
      inside: true,
      layout: "stack",
      width,
    };
  }
  return {
    left: Math.max(4, Math.min(box.left, overlayW - GEN_BAR_W)),
    top:
      box.top + box.height + 8 + GEN_BAR_H <= overlayH
        ? box.top + box.height + 8
        : Math.max(4, box.top - 44),
    inside: false,
    layout: "outside",
    width: GEN_BAR_W,
  };
};

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

export const ElementEditor = forwardRef<ElementEditorHandle, Props>(
  function ElementEditor(
    {
      iframeRef,
      scriptId,
      sceneIndex,
      reloadKey,
      canvasWidth,
      onChanged,
      onCommitted,
      apiBase = "/api/preview",
      defaultShowAll = false,
      hideToolbar = false,
      onState,
    }: Props,
    ref,
  ) {
  const [selected, setSelected] = useState<PieceRef | null>(null);
  const [hovered, setHovered] = useState<PieceRef | null>(null);
  const [showAll, setShowAll] = useState(defaultShowAll);
  const [allPieces, setAllPieces] = useState<PieceRef[]>([]);
  const [busy, setBusyState] = useState<
    null | "regenerate" | "animate" | "delete" | "move" | "text" | "insert" | "resize" | "undo" | "front" | "back" | "duplicate"
  >(null);
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
  /**
   * Alignment guides for the drag in flight. Written from the rAF paint loop, but ONLY
   * when the set actually changes — a setState per frame would undo the whole reason
   * the drag path is transform-only. A drag crosses a handful of guides, not sixty a
   * second.
   */
  const [guides, setGuides] = useState<Guide[]>([]);
  const guidesKeyRef = useRef("");
  /**
   * Nudges accumulate and commit once the keys stop.
   *
   * Held arrows fire at the OS repeat rate; one POST per repeat would be dozens of
   * round trips for a single intent, and each reply racing the next. The element moves
   * optimistically on every keystroke (same transform the drag uses) and the total
   * lands in a single request when the burst ends — the pattern the drag path already
   * established, applied to the keyboard.
   */
  const nudgeRef = useRef<{ dx: number; dy: number; timer: number | null }>({ dx: 0, dy: 0, timer: null });

  /** The offset the paint loop last applied, in canvas px — what commit must persist. */
  const snappedRef = useRef<null | { sx: number; sy: number }>(null);
  /**
   * The numeric X/Y/W/H panel's draft, as STRINGS. Strings, not numbers, because a
   * user mid-edit legitimately passes through states like "" and "-" that a number
   * cannot hold — parse at commit, never at keystroke. Null while nothing is selected.
   */
  const [boundsDraft, setBoundsDraft] = useState<null | { x: string; y: string; w: string; h: string }>(null);
  const [aspectLock, setAspectLock] = useState(false);
  /** True while any of the four fields has focus — the sync effect must not clobber
   *  half-typed input with a remeasure. */
  const boundsFocusRef = useRef(false);
  const [genPrompt, setGenPrompt] = useState("");
  // What the marquee generates: a JSX element (LLM) or an image (diffusion).
  // An explicit switch on the prompt bar — never guessed from the prompt text.
  const [genKind, setGenKind] = useState<"element" | "image" | "icon">("element");
  /** "Match style": resemble the newest generated piece of the same kind —
   *  the server resolves the reference (model + seed + a cached style read
   *  of its pixels), so a family spans every page of the document. */
  const [matchStyle, setMatchStyle] = useState(true);
  // ── suggest a layout ──────────────────────────────────────────────────────
  // The question before the marquee: the marquee assumes you know where a thing
  // goes; this proposes the whole composition. Suggestions are REGIONS ONLY —
  // accepting one hands its box and its words to the marquee flow, so nothing is
  // generated (or billed for generation) until an explicit click.
  /**
   * Right-click menu, anchored in OVERLAY px at the click.
   *
   * The click itself happens inside the iframe, so the listener lives on that
   * document — but the menu is rendered in the overlay, which sits over it and is
   * not clipped by the slide.
   */
  const [menu, setMenu] = useState<null | { x: number; y: number; pieceId: string; kind: string }>(
    null,
  );
  const [suggestPrompt, setSuggestPrompt] = useState("");
  const [suggestions, setSuggestions] = useState<LayoutSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  /**
   * The canvas size the suggested bounds are expressed in, as reported by the
   * server that produced them.
   *
   * Regions are then drawn as PERCENTAGES of the slide, which needs no
   * measurement at all. Measuring the rendered canvas instead was tried and is a
   * trap: the iframe reports zero width until it lays out, so a read taken at the
   * wrong instant yields scale 1 and every region is painted at full canvas size
   * inside a much smaller overlay — silently, since the numbers look plausible.
   * The canvas fills the overlay, so percentages are exact and immune to timing,
   * zoom and resize alike.
   */
  const [suggestCanvas, setSuggestCanvas] = useState<{ w: number; h: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Hidden file input for the Add-toolbar image path (upload, not placeholder).
  const fileRef = useRef<HTMLInputElement>(null);
  // Formatting for an INSERTED text box (null when the selection isn't one). Read
  // from the live span's data-rb-fmt, so it always reflects what's on screen.
  const [fmt, setFmt] = useState<FreetextFormat | null>(null);
  const [swatches, setSwatches] = useState<string[]>([]);
  const [colorOpen, setColorOpen] = useState(false);
  // Undo depth drives the control's visibility; every mutating op pushes a snapshot.
  const [undoDepth, setUndoDepth] = useState(0);
  /** Order-safe handle to refreshUndoDepth (defined much later): optimistic
   *  and morph commits bypass reloadKey — the old sole refresh trigger — so
   *  they refresh depth through this ref or the undo control never arms. */
  const refreshUndoDepthRef = useRef<() => void>(() => {});
  // Live resize (overlay px) while dragging a grip; committed to canvas px on release.
  const [resizeBox, setResizeBox] = useState<null | { left: number; top: number; width: number; height: number }>(null);
  const resizeRef = useRef<null | { left: number; top: number; width: number; height: number }>(null);
  // True only while a mouse button is actually down on a move/resize gesture.
  // The full-screen shields key on THIS, not on the preview boxes — the boxes
  // persist through the commit round-trip for visual continuity, but a shield
  // that outlives the gesture eats the user's next click.
  const [gestureHeld, setGestureHeld] = useState(false);
  // A session that expired mid-edit. One persistent overlay with the way
  // back, not an error toast per gesture.
  const [sessionDead, setSessionDead] = useState(false);
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
  /**
   * Whether the canvas iframe element exists yet.
   *
   * The listener effect bails when `iframeRef.current` is null, and its only
   * other dependencies are a stable ref plus reloadKey/sceneIndex — so a mount
   * where the effect ran BEFORE the iframe committed left the canvas inert
   * forever: no select, no hover, no right-click, no double-click, and
   * therefore no delete, resize or drag. Silently, with no error. This flag
   * changes, so the effect re-runs the moment the element appears.
   */
  const [iframeReady, setIframeReady] = useState(false);

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
  /** In-flight generate, so Cancel can actually abandon it. */
  const generateAbortRef = useRef<AbortController | null>(null);
  const textTargetRef = useRef<TextTarget | null>(null);
  // Active multi-field edit session's finisher (Done button / unmount call it).
  const finishSessionRef = useRef<((save: boolean) => void) | null>(null);
  // Tears down the live-refit input listener of the CURRENT text session
  // (registered after finish() is defined, so it rides a ref, not a closure).
  const cleanupInputRef = useRef<(() => void) | null>(null);
  // The scene's editable copy fields (path+value), fetched so we can tell whether a
  // clicked text element is bound content and resolve its exact path — the affordance
  // for "Edit text" appears only on text that actually maps to a field.
  const fieldsRef = useRef<{ path: string; value: string }[]>([]);
  const dragRef = useRef<{ startX: number; startY: number; scale: number } | null>(null);
  /** True once a press on the selection has travelled far enough to BE a drag. */
  const draggingRef = useRef(false);
  /**
   * The last click anywhere on the canvas, in PARENT-viewport coordinates.
   *
   * Double-click has to be detected by hand here, because the browser cannot do
   * it for us: the first click SELECTS, which mounts the drag surface over the
   * element, so the two clicks of one gesture land on different elements — and
   * often in different documents. Whether a native `dblclick` fires at all then
   * depends on whether React painted between them, which measured as a coin
   * flip. Recording the click ourselves makes it deterministic, and both
   * surfaces (iframe and overlay) write to the same ref so a gesture that
   * crosses the boundary is still one gesture.
   */
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const DOUBLE_CLICK_MS = 450;
  const DOUBLE_CLICK_SLOP = 6;
  /** The press in progress qualifies as a double-click IF it never travels. */
  const secondPressRef = useRef(false);
  /** Same, for a press that landed inside the frame rather than on the overlay. */
  const pendingIframeDblRef = useRef<{ piece: Element; target: HTMLElement; x: number; y: number } | null>(null);
  const dragHandlersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  /** Live scene nodes being dragged, with whatever transform they already had —
   *  and, when a CSS animation was holding their pose, what to put back. */
  type LiveNode = {
    el: HTMLElement;
    base: string;
    restore?: { animation: string; opacity: string; transform: string };
  };
  const liveNodesRef = useRef<LiveNode[]>([]);
  /** An animate op wants the page's motion replayed once its result is on
   *  screen — set before the commit, consumed by whichever path lands it
   *  (the in-place morph, or the fallback reload's attach). */
  const replayAfterLoadRef = useRef(false);
  /** Generation of the pending settle-after-entrance wait. A replay cancels
   *  the animations an earlier wait was watching, which RESOLVES that wait
   *  (cancel rejects `finished`, caught) — without this guard it settled the
   *  page instantly and the fresh replay jumped straight to its end. */
  const settleGenRef = useRef(0);
  const pendingRef = useRef<null | { dx: number; dy: number; bypass?: boolean }>(null);
  const rafRef = useRef(0);
  /** The selection frame element, driven imperatively during a gesture. */
  const frameRef = useRef<HTMLDivElement | null>(null);

  /**
   * The real DOM nodes a piece paints. Pieces are `display: contents`, so the
   * piece wrapper has no box of its own — its element children are what move.
   * Their existing transform is captured so an entry animation's transform is
   * composed with, never clobbered.
   */
  const livePieceNodes = (pieceId: string): LiveNode[] => {
    const doc = iframeRef.current?.contentDocument;
    const wrap = doc?.querySelector(`[data-piece="${CSS.escape(pieceId)}"]`);
    if (!wrap) return [];
    const out: LiveNode[] = [];
    for (const child of Array.from(wrap.children)) {
      // NOT `instanceof HTMLElement`: these nodes live in the IFRAME's realm,
      // so the parent window's constructor never matches them and the check
      // silently rejected every child — the drag stayed invisible while
      // everything else about it worked. Duck-type on the style object, which
      // is realm-agnostic.
      const el = child as HTMLElement;
      if (!el.style) continue;
      const node: LiveNode = { el, base: el.style.transform || "" };
      // MOTION (2026-09-03): a CSS animation outranks inline styles in the
      // cascade, so a node still holding an entrance frame — grabbed
      // mid-flight, or authored with fill-mode "forwards" against the
      // contract — would ignore the drag's transform entirely. Pin the pose
      // it is PAINTED in (computed opacity + transform), stop the animation,
      // and compose the drag with that; clearLiveDrag puts it all back.
      try {
        const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
        if (cs && cs.animationName && cs.animationName !== "none") {
          node.restore = { animation: el.style.animation, opacity: el.style.opacity, transform: el.style.transform };
          const painted = cs.transform === "none" ? "" : cs.transform;
          el.style.animation = "none";
          el.style.opacity = cs.opacity;
          el.style.transform = painted;
          node.base = painted;
        }
      } catch {
        /* pinning is best-effort — a settled node drags fine without it */
      }
      out.push(node);
    }
    return out;
  };

  /**
   * MOTION: a page's first visit plays its entrance; once every animation has
   * finished (or the cap passes — an ambient loop never finishes) the live
   * document is settled IN PLACE, so later morphs and drags land static
   * without a reload. The server already settles post-edit reloads, in which
   * case the style is present and this is a no-op.
   */
  const settleAfterEntrance = (doc: Document | null | undefined) => {
    try {
      if (!doc?.head || doc.getElementById(SETTLE_STYLE_ID)) return;
      const anims = typeof doc.getAnimations === "function" ? doc.getAnimations() : [];
      // Only FINITE animations are awaited — an ambient loop's `finished`
      // never resolves and would push every settle to the cap.
      const finite = anims.filter((a) => {
        try {
          return Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity);
        } catch {
          return false;
        }
      });
      const finished = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
      const cap = new Promise<void>((resolve) => setTimeout(resolve, MOTION_SETTLE_CAP_MS));
      const gen = ++settleGenRef.current;
      void Promise.race([finished, cap]).then(() => {
        if (gen !== settleGenRef.current) return; // a replay superseded this wait
        if (!doc.head || doc.getElementById(SETTLE_STYLE_ID)) return;
        const style = doc.createElement("style");
        style.id = SETTLE_STYLE_ID;
        style.textContent = SETTLE_CSS;
        doc.head.appendChild(style);
      });
    } catch {
      /* settling is best-effort — the page is merely left animated */
    }
  };

  /**
   * Replay the page's choreography in place: lift the settle style, restart
   * every CSS animation from zero, then settle again once it has played.
   *
   * Restart by toggling `animation` off, forcing a reflow, and putting the
   * inline value back — NOT via getAnimations().cancel()/play(): Chrome drops
   * a finished CSS animation from getAnimations() (no forwards fill → no
   * effect → gone), so after the entrance has played that list holds only
   * the ambient loops and a cancel/play replay restarts nothing visible
   * (measured 2026-09-03: 1 animation listed of 9 authored).
   */
  const replayMotionIn = (doc: Document | null | undefined) => {
    try {
      if (!doc?.body) return;
      doc.getElementById(SETTLE_STYLE_ID)?.remove();
      const view = doc.defaultView;
      const animated: { el: HTMLElement; anim: string }[] = [];
      doc.querySelectorAll<HTMLElement>("*").forEach((el) => {
        if (!el.style || !view) return;
        const cs = view.getComputedStyle(el);
        if (cs.animationName && cs.animationName !== "none") animated.push({ el, anim: el.style.animation });
      });
      for (const { el } of animated) el.style.animation = "none";
      void doc.body.offsetWidth; // reflow: the engine sees the animations removed
      for (const { el, anim } of animated) el.style.animation = anim;
      settleAfterEntrance(doc);
    } catch {
      /* best-effort */
    }
  };

  /** Drop the live drag styling — after the gesture, or after the reload lands. */
  const clearLiveDrag = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    for (const n of liveNodesRef.current) {
      if (n.restore) {
        n.el.style.transform = n.restore.transform;
        n.el.style.opacity = n.restore.opacity;
        n.el.style.animation = n.restore.animation;
      } else {
        n.el.style.transform = n.base;
      }
      n.el.style.willChange = "";
    }
    // The FRAME's transform is imperative too — React never manages it, so a
    // remounted selection box can inherit the stale offset and sit hundreds
    // of px from the element it claims to outline (probe-caught: frame 1336
    // vs ink 823 after a drag).
    if (frameRef.current) frameRef.current.style.transform = "";
    liveNodesRef.current = [];
    pendingRef.current = null;
  };
  /**
   * MORPH-NOT-RELOAD (speed playbook; the LiveView/Turbo-8/Builder.io
   * pattern): fetch the freshly rendered scene doc and DOM-patch it into the
   * LIVE iframe instead of renavigating. The reload's 1.4-1.6s was never
   * compile (7ms) — it was teardown, parse, fonts, fit, paint; morphing
   * keeps the document, so only changed nodes ripple. Scripts in the new
   * HTML deliberately do not re-execute: the fit runtime exposes __rbRefit
   * for exactly this call. Any failure returns false and the caller falls
   * back to the full reload — the old path demoted to the error path.
   * Scoped tonight to TEXT-CLASS edits (content changes, structure stable).
   */
  const morphReload = async (): Promise<boolean> => {
    try {
      const f = iframeRef.current;
      const doc = f?.contentDocument;
      const src = f?.src;
      if (!f || !doc?.documentElement || !src) return false;
      const res = await fetch(src, { cache: "no-store" });
      if (!res.ok) return false;
      const html = await res.text();
      const next = new DOMParser().parseFromString(html, "text/html");
      if (!next.documentElement) return false;
      // PIECE-SWAP: the piece partition is the morph unit. (idiomorph was
      // tried first and threw inside its own traversal on our documents —
      // probe-recorded; the partition we already have is simpler and covers
      // adds/removes exactly.) Three passes over ids, then an ancestor
      // style sync so section-level changes (a re-skin's background) land
      // without a reload.
      const liveById = new Map<string, Element>();
      doc.querySelectorAll("[data-piece]").forEach((el) => liveById.set(el.getAttribute("data-piece") || "", el));
      const nextIds = new Set<string>();
      const nextPieces = Array.from(next.querySelectorAll("[data-piece]"));
      if (liveById.size === 0 || nextPieces.length === 0) return false; // structure too different — reload
      for (const newEl of nextPieces) nextIds.add(newEl.getAttribute("data-piece") || "");

      let swapped = 0;
      let removed = 0;
      let added = 0;
      // removed: live pieces absent from the fresh render
      for (const [id, el] of liveById) {
        if (!nextIds.has(id)) {
          el.remove();
          removed += 1;
        }
      }
      // changed + added, in the fresh document's order (paint order matters)
      let prevLive: Element | null = null;
      for (const newEl of nextPieces) {
        const id = newEl.getAttribute("data-piece") || "";
        const live = liveById.get(id);
        if (live) {
          if (live.outerHTML !== newEl.outerHTML) {
            const imported = doc.importNode(newEl, true);
            live.replaceWith(imported);
            prevLive = imported;
            swapped += 1;
          } else {
            prevLive = live;
          }
        } else {
          const imported = doc.importNode(newEl, true);
          if (prevLive && prevLive.parentElement) {
            prevLive.after(imported);
          } else {
            const anchor = doc.querySelector("[data-piece]");
            if (!anchor?.parentElement) return false;
            anchor.parentElement.insertBefore(imported, anchor);
          }
          prevLive = imported;
          added += 1;
        }
      }
      // Ancestor sync: section root + up to 4 ancestors carry style/class
      // (a re-skin repaints the canvas outside any piece).
      let liveAnc = doc.querySelector("[data-piece]")?.parentElement ?? null;
      let nextAnc = next.querySelector("[data-piece]")?.parentElement ?? null;
      for (let depth = 0; depth < 4 && liveAnc && nextAnc; depth += 1) {
        const st = nextAnc.getAttribute("style");
        const cl = nextAnc.getAttribute("class");
        if (st !== null) liveAnc.setAttribute("style", st); else liveAnc.removeAttribute("style");
        if (cl !== null) liveAnc.setAttribute("class", cl); else liveAnc.removeAttribute("class");
        liveAnc = liveAnc.parentElement;
        nextAnc = nextAnc.parentElement;
      }
      const win = f.contentWindow as unknown as {
        __rbRefit?: () => void;
        __rbLottieMount?: () => void;
      };
      win.__rbRefit?.();
      win.__rbLottieMount?.();
      // Probe-readable trace of what the morph actually did — the drag/undo
      // probes assert on this instead of guessing from pixels alone.
      (window as unknown as { __rbLastMorph?: unknown }).__rbLastMorph = {
        at: Date.now(),
        swapped,
        removed,
        added,
        pieces: nextPieces.length,
      };
      // Re-assert the canvas scale. The ancestor sync above deliberately
      // overwrites style on the section root and its ancestors so a re-skin
      // repaints — and .renderball-canvas is one of those ancestors, carrying
      // the inline transform fit() set at load. The fresh render has no such
      // transform (fit() never ran in a document that was never attached), so
      // the sync silently strips it and the whole page renders unscaled.
      // fit() is idempotent; running it after every morph costs nothing.
      try {
        (doc.defaultView as (Window & { __rbFit?: () => void }) | null)?.__rbFit?.();
      } catch {
        /* a missing hook means an older scene doc; the reload path still scales */
      }
      setDocTick((t) => t + 1);
      return true;
    } catch {
      return false;
    }
  };

  /** Every same-scene commit funnels here: morph first, full reload only as
   *  the fallback. Selection is preserved through a successful morph (the
   *  document object never changed), so callers skip the reselect dance. */
  const settleCommit = async (
    reselectId?: string,
    opts: {
      /** After a successful morph: select this piece (an insert's new id),
       *  or null to clear (an undo whose target may be gone). Default keeps
       *  the current selection — the document object never changed. */
      afterMorph?: string | null;
    } = {},
  ) => {
    const morphed = await morphReload();
    if (morphed) {
      refreshUndoDepthRef.current();
      if (opts.afterMorph === null) {
        setSelected(null);
      } else if (typeof opts.afterMorph === "string") {
        const doc = iframeRef.current?.contentDocument;
        const piece = doc?.querySelector(`[data-piece="${CSS.escape(opts.afterMorph)}"]`);
        const rect = piece ? rectOf(piece) : null;
        if (piece && rect) {
          setSelected({ pieceId: opts.afterMorph, kind: piece.getAttribute("data-kind") ?? "", rect });
        }
      }
      return;
    }
    if (reselectId) reselectIdRef.current = reselectId;
    setSelected(null);
    onChanged();
  };

  const [dragDelta, setDragDelta] = useState<{ dx: number; dy: number } | null>(null);
  /** One-shot: the commit right after a drop repositions the frame via rect —
   *  its 100ms left/top transition would read as a wobble (the frame is
   *  ALREADY there visually via the gesture transform), so that one commit
   *  renders transition-free. */
  const justDroppedRef = useRef(false);

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
    // A persisted MOVE renders as an anti-symmetric inset frame around the piece
    // (lego-store wrapOffset: left:dx, top:dy, right:-dx, bottom:-dy). It's a
    // coordinate frame, not content — its own rect is canvas-sized and shifted,
    // which used to inflate the union after any large move (the selection box
    // hung off the piece). Skip the frame itself; its children still measure.
    const isOffsetFrame = (c: Element): boolean => {
      const s = (c as HTMLElement).style;
      if (!s || s.position !== "absolute") return false;
      const l = parseFloat(s.left);
      const t = parseFloat(s.top);
      const r = parseFloat(s.right);
      const b = parseFloat(s.bottom);
      return (
        Number.isFinite(l) && Number.isFinite(t) && Number.isFinite(r) && Number.isFinite(b) &&
        l === -r && t === -b && (l !== 0 || t !== 0)
      );
    };
    const collect = (dropFullBleed: boolean): DOMRect[] => {
      const rects: DOMRect[] = [];
      const own = el.getBoundingClientRect();
      if (own.width > 0 && own.height > 0 && !(dropFullBleed && isFullBleed(own))) rects.push(own);
      el.querySelectorAll("*").forEach((c) => {
        if (isOffsetFrame(c)) return;
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
    async (
      url: string,
      body: unknown,
      signal?: AbortSignal,
    ): Promise<{ ok: boolean; json: Record<string, unknown> }> => {
      setError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        // Clerk's middleware answers a DEAD SESSION with an HTML 404 — to a
        // fetch that expected JSON. Before this check, every gesture after a
        // session expired said "request failed (404)" forever, with no hint
        // that signing back in fixes everything.
        if (res.status === 404 && (res.headers.get("content-type") ?? "").includes("text/html")) {
          setSessionDead(true);
          return { ok: false, json: {} };
        }
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setError(json.error || `request failed (${res.status})`);
          return { ok: false, json: json as Record<string, unknown> };
        }
        return { ok: true, json: json as Record<string, unknown> };
      } catch (e) {
        // An abort is the user pressing Cancel. Reporting it as a failure
        // would put a red error under a box they deliberately abandoned.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return { ok: false, json: {} };
      }
    },
    [],
  );
  const post = useCallback(
    async (url: string, body: unknown): Promise<boolean> => (await postJson(url, body)).ok,
    [postJson],
  );
  // Multipart sibling of postJson (uploads) — same error surface.
  const postForm = useCallback(
    async (url: string, form: FormData): Promise<{ ok: boolean; json: Record<string, unknown> }> => {
      setError(null);
      try {
        const res = await fetch(url, { method: "POST", body: form });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setError(json.error || `upload failed (${res.status})`);
          return { ok: false, json: json as Record<string, unknown> };
        }
        return { ok: true, json: json as Record<string, unknown> };
      } catch (e) {
        // An abort is the user pressing Cancel. Reporting it as a failure
        // would put a red error under a box they deliberately abandoned.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return { ok: false, json: {} };
      }
    },
    [],
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

  /**
   * One editable run of text inside a piece. Exactly one of the three save paths
   * applies: `path` → SceneContent (the batched /edit-element route), `freetext` → an
   * inserted box's literal, `literal` → text the model hardcoded into the JSX.
   */
  interface EditableEl {
    el: HTMLElement;
    path?: string;
    oldText: string;
    freetext?: boolean;
    literal?: { occurrence: number; total: number };
  }
  const collectEditableFields = (piece: Element): EditableEl[] => {
    const out: EditableEl[] = [];
    const seenPaths = new Set<string>();
    const add = (
      el: HTMLElement,
      path: string | undefined,
      oldText: string,
      freetext?: boolean,
      literal?: { occurrence: number; total: number },
    ) => {
      if (!oldText) return;
      if (path && seenPaths.has(path)) return; // one element per content field
      if (out.some((f) => f.el.contains(el) || el.contains(f.el))) return; // no nested editables
      out.push({ el, path, oldText, freetext, literal });
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
    // HARDCODED LITERALS — text the model wrote straight into the JSX, bound to no
    // content field at all. 17% of stored pieces are entirely this (a mocked Linear
    // window, a phone screen reading "Portfolio"), and until now every word of it was
    // unreachable: the session opened zero fields and reported "No editable text
    // found", which was true and read as a bug.
    //
    // ONLY single-text-node elements qualify. That is what guarantees the clicked
    // string is one contiguous run in the source — "Hello <b>world</b>" spans two
    // literals and must never be offered. occurrence/total are counted over EVERY
    // qualifying leaf in the piece, including ones the nesting guard drops, because
    // the server compares that count against the source to detect a literal being
    // rendered N times by a `.map()` (see lib/edit/piece-literal.ts).
    const leaves: { el: HTMLElement; text: string }[] = [];
    piece.querySelectorAll<HTMLElement>(BLOCK_FIELD_SEL + ",span,strong,em,b,i,small").forEach((el) => {
      if (el.childNodes.length !== 1 || el.firstChild?.nodeType !== 3) return;
      const text = asciiTrim(el.textContent ?? "");
      if (text) leaves.push({ el, text });
    });
    const seenOfText = new Map<string, number>();
    for (const { el, text } of leaves) {
      const occurrence = seenOfText.get(text) ?? 0;
      seenOfText.set(text, occurrence + 1);
      if (matchFieldPath(fieldsRef.current, text)) continue; // bound copy — already handled
      if (el.closest("[data-rb-freetext]")) continue; // inserted box — already handled
      add(el, undefined, text, false, {
        occurrence,
        total: leaves.filter((l) => l.text === text).length,
      });
    }
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
      cleanupInputRef.current?.();
      cleanupInputRef.current = null;
      finishSessionRef.current = null;
      editingRef.current = false;
      setEditing(false);
      const changed: {
        path?: string;
        oldText: string;
        newText: string;
        freetext?: boolean;
        literal?: { occurrence: number; total: number };
      }[] = [];
      for (const f of fields) {
        f.el.removeAttribute("contenteditable");
        f.el.style.outline = "";
        f.el.style.outlineOffset = "";
        f.el.style.borderRadius = "";
        f.el.style.cursor = "";
        const newText = (f.el.textContent ?? "").trim();
        if (save && newText.length > 0 && newText !== f.oldText) {
          changed.push({ path: f.path, oldText: f.oldText, newText, freetext: f.freetext, literal: f.literal });
        } else {
          f.el.innerHTML = f.savedHTML; // revert flatten (unchanged / cancelled)
        }
      }
      if (changed.length === 0) return;
      setBusy("text");
      // Split by save path: bound SceneContent copy → the batched edit-element route;
      // inserted free-text boxes → edit-piece-text (their text is a body literal, not
      // a content field). Both reassemble Composition.tsx; one onChanged() reloads.
      const contentEdits = changed.filter((c) => !c.freetext && !c.literal);
      const freeEdits = changed.filter((c) => c.freetext);
      const literalEdits = changed.filter((c) => c.literal && !c.freetext);
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
      // Hardcoded literals: one request each, and SEQUENTIAL on purpose. Every patch
      // rewrites the same piece body, so two in flight would race and the second would
      // be computed against a stale source. The server reports its own reason (notably
      // a deliberate refusal when one source line renders several elements), so keep
      // it rather than overwriting it with a generic count.
      let literalError: string | null = null;
      for (const c of literalEdits) {
        const { ok, json } = await postJson(`${apiBase}/edit-piece-text`, {
          scriptId,
          sceneIndex,
          pieceId: sessionPieceId,
          value: c.newText,
          literal: { oldText: c.oldText, ...c.literal },
        });
        if (ok) anyOk = true;
        else {
          failedCount += 1;
          literalError = literalError ?? (typeof json?.error === "string" ? json.error : null);
        }
      }
      setBusy(null);
      if (failedCount > 0) {
        // A literal refusal explains WHY and what to do instead; a bare count does not.
        setError(
          literalError ??
            `${failedCount} of ${changed.length} edits could not be applied — the rest were saved.`,
        );
      }
      if (anyOk) {
        // Morph first (content-only change, structure stable); the full
        // reload remains as the fallback and re-applies accents identically.
        const morphed = await morphReload();
        if (!morphed) onChanged();
      }
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
    // LIVE AUTOFIT WHILE TYPING (client-preview Phase 2, founder GO
    // 2026-08-20). Fit sizes were computed for the OLD text at load, so a
    // growing line overflowed its box until commit re-rendered. Re-run the
    // scene's fit pass (window.__rbRefit, the same idempotent re-entry hook
    // the morph path uses) on a trailing throttle per keystroke — text now
    // shrinks/reflows live, PowerPoint-style. DOM-only; commit unchanged.
    let refitTimer: number | null = null;
    const win = doc.defaultView as (Window & { __rbRefit?: () => void }) | null;
    const onInput = () => {
      if (!win?.__rbRefit) return;
      if (refitTimer !== null) win.clearTimeout(refitTimer);
      refitTimer = win.setTimeout(() => {
        refitTimer = null;
        try {
          win.__rbRefit?.();
        } catch {
          /* fit is best-effort during typing; commit re-renders regardless */
        }
      }, 120);
    };
    doc.addEventListener("input", onInput, true);
    cleanupInputRef.current = () => {
      doc.removeEventListener("input", onInput, true);
      if (refitTimer !== null && win) win.clearTimeout(refitTimer);
      refitTimer = null;
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
    setGenKind("element");
    const iframe = iframeRef.current;
    if (!iframe) {
      // Not mounted yet — watch for it rather than abandoning the canvas.
      const wait = window.setInterval(() => {
        if (iframeRef.current) {
          window.clearInterval(wait);
          setIframeReady(true);
        }
      }, 100);
      return () => window.clearInterval(wait);
    }
    let doc: Document | null = null;
    let lastHover = "";

    // A click should land on the piece that PAINTED at that point — not on an
    // invisible full-canvas positioning wrapper stacked above it (the Vercel
    // ghost-layer finding, 2026-08-28: two transparent left:0/right:0 wrappers
    // swallowed every canvas click on the page). Walk the element stack under
    // the cursor and take the first piece with visible ink; when nothing under
    // the point painted, fall back to the plain closest() behavior.
    const paintsInkAt = (el: Element): boolean => {
      const tag = el.tagName?.toLowerCase?.() ?? "";
      if (["img", "svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "video", "canvas"].includes(tag)) return true;
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && (n.textContent ?? "").trim()) return true;
      }
      const win = el.ownerDocument?.defaultView;
      if (!win) return false;
      const cs = win.getComputedStyle(el);
      if (cs.backgroundColor && cs.backgroundColor !== "transparent" && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(cs.backgroundColor)) return true;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
      if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) return true;
      if (cs.boxShadow && cs.boxShadow !== "none") return true;
      return false;
    };
    const inkedPieceAt = (me: MouseEvent): Element | null => {
      const stack = (doc as Document | null)?.elementsFromPoint?.(me.clientX, me.clientY) ?? [];
      for (const el of stack) {
        const p = el.closest?.("[data-piece]") as Element | null;
        if (p && paintsInkAt(el)) return p;
      }
      return null;
    };

    const onClick = (e: Event) => {
      if (editingRef.current || busyRef.current || toolRef.current) return;
      const target = e.target as Element | null;
      const piece = (inkedPieceAt(e as MouseEvent) ?? target?.closest?.("[data-piece]")) as Element | null;
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
      // Remember where this click landed, in the parent's frame of reference, so
      // a second click on the drag surface this selection is about to mount can
      // recognise itself as the other half of a double-click.
      const me = e as MouseEvent;
      const host = iframe.getBoundingClientRect();
      lastClickRef.current = { t: Date.now(), x: host.left + me.clientX, y: host.top + me.clientY };
      textTargetRef.current = target ? resolveTextTarget(target, piece) : null;
      setSelected({ pieceId: piece.getAttribute("data-piece")!, kind: piece.getAttribute("data-kind") ?? "", rect });
    };

    const onDbl = (e: Event) => {
      // Inside an active session, double-click must fall through to native word
      // selection — starting a second session would orphan the first's listeners.
      if (editingRef.current || busyRef.current || toolRef.current) return;
      const target = e.target as Element | null;
      const piece = (inkedPieceAt(e as MouseEvent) ?? target?.closest?.("[data-piece]")) as Element | null;
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
      if (e.button !== 0) return; // primary button only — see onDragStart
      if (editingRef.current || busyRef.current || toolRef.current) return;
      const target = e.target as Element | null;
      const piece = target?.closest?.("[data-piece]") as Element | null;

      // The other landing spot for the second press of a double-click. Whether
      // it arrives here or on the overlay's drag surface depends on whether the
      // first click's selection has painted yet — so both places check, and
      // whichever gets it opens the session. Resolved from the event target
      // rather than from `selected`, which this listener captured at mount.
      if (piece) {
        const prev = lastClickRef.current;
        const host = iframe.getBoundingClientRect();
        const x = host.left + e.clientX;
        const y = host.top + e.clientY;
        lastClickRef.current = { t: Date.now(), x, y };
        // Deferred to mouseup for the same reason as the overlay path above: a
        // press that is about to become a drag looks identical to one that is
        // about to become a double-click, until it moves.
        if (
          prev &&
          Date.now() - prev.t < DOUBLE_CLICK_MS &&
          Math.abs(x - prev.x) <= DOUBLE_CLICK_SLOP &&
          Math.abs(y - prev.y) <= DOUBLE_CLICK_SLOP &&
          collectEditableFields(piece).length > 0
        ) {
          pendingIframeDblRef.current = { piece, target: target as HTMLElement, x: e.clientX, y: e.clientY };
        }
      }

      if (piece) return; // a piece press = select/drag, not marquee
      pendingMarqueeRef.current = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: MouseEvent) => {
      const p = pendingMarqueeRef.current;
      if (!p) return;
      if (Math.abs(e.clientX - p.x) < 6 && Math.abs(e.clientY - p.y) < 6) return; // not a drag yet
      setMarquee({ x0: p.x, y0: p.y, x1: e.clientX, y1: e.clientY });
    };
    const onUp = (e: MouseEvent) => {
      // A press on a piece that never travelled, soon after a click in the same
      // place, is a double-click — decided here rather than on mousedown, where
      // it is indistinguishable from the start of a drag.
      const dbl = pendingIframeDblRef.current;
      pendingIframeDblRef.current = null;
      if (dbl) {
        const moved =
          Math.abs(e.clientX - dbl.x) > DOUBLE_CLICK_SLOP ||
          Math.abs(e.clientY - dbl.y) > DOUBLE_CLICK_SLOP;
        if (!moved && !editingRef.current && !busyRef.current) {
          lastClickRef.current = null;
          startTextFields(dbl.piece, dbl.target);
          return;
        }
      }

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

    // Right-click a piece: select it and open the element menu at the pointer.
    // The browser's own menu is suppressed only when the click landed on an
    // element — right-clicking bare canvas still behaves normally.
    const onContext = (ev: MouseEvent) => {
      if (editingRef.current || busyRef.current) return;
      const el = (ev.target as Element | null)?.closest?.("[data-piece]") as HTMLElement | null;
      if (!el) return;
      const pieceId = el.getAttribute("data-piece");
      if (!pieceId) return;
      ev.preventDefault();
      const rect = rectOf(el);
      if (rect) setSelected({ pieceId, kind: el.getAttribute("data-kind") ?? "", rect });
      // The iframe fills the overlay at inset:0, so its client coords ARE
      // overlay coords — no conversion needed.
      setMenu({ x: ev.clientX, y: ev.clientY, pieceId, kind: el.getAttribute("data-kind") ?? "" });
    };

    const attach = () => {
      try {
        doc = iframe.contentDocument;
        if (!doc) return;
        // Tag the document itself. Comparing document IDENTITY is not enough:
        // a frame can reuse the same object across navigations, and then the
        // listeners are gone while the reference still matches — the canvas
        // goes inert and nothing detects it.
        (doc as Document & { __rbBound?: boolean }).__rbBound = true;
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("contextmenu", onContext, true);
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
        // MOTION: let a first visit's entrance play, then settle the live
        // document so edits land static (no-op on server-settled reloads).
        settleAfterEntrance(doc);
        // The NEW document is live now — recompute anything measured against the
        // old one (x-ray rects) and restore the selection a move/regen preserved.
        setDocTick((t) => t + 1);
        /**
         * Only the document we are ACTUALLY waiting for may consume the
         * reselect intent.
         *
         * Measured 2026-08-14: after a move, the selection outline was left
         * behind at the old position permanently, and every follow-up nudge
         * aimed at empty space. Cause: onChanged() bumps reloadKey, this
         * effect re-runs immediately, and at that instant the browser has not
         * navigated yet — contentDocument is still the OLD document reporting
         * readyState "complete", so attach() ran synchronously against it,
         * consumed reselectIdRef and re-measured the stale rect. By the time
         * the real document loaded (measured 1.49s later) the intent was
         * already gone. This is the same stale-contentDocument hazard docTick
         * documents; the reselect path simply was not covered by it.
         *
         * The live document carries its reload key in its own URL, so the
         * check is exact rather than a guess about timing.
         */
        const liveSrc = iframe.contentDocument?.location?.search ?? "";
        const expected = `v=${reloadKey}`;
        const isTargetDoc = liveSrc.includes(expected);
        const reselect = isTargetDoc ? reselectIdRef.current : null;
        if (reselect) {
          reselectIdRef.current = null;
          // The authoritative render is finally on screen — the client's
          // held drag transform has served its purpose and must go, or the
          // element would sit double-offset.
          clearLiveDrag();
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
        // An animate op that fell back to a reload: its result is on screen
        // now (settled by the server) — replay so the new motion is seen.
        if (isTargetDoc && replayAfterLoadRef.current) {
          replayAfterLoadRef.current = false;
          setTimeout(() => replayMotionIn(iframe.contentDocument), 80);
        }
      } catch {
        /* cross-origin — should not happen (SAMEORIGIN) */
      }
    };
    if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") attach();
    iframe.addEventListener("load", attach);

    /**
     * Keep trying until the listeners are actually on the CURRENT document.
     *
     * Every canvas interaction — select, hover, right-click, double-click, and
     * therefore delete/resize/drag — depends on listeners bound to the iframe's
     * document. Binding happened in exactly two moments: a synchronous check for
     * `readyState === "complete"`, and the `load` event. Miss both — the frame
     * swaps its document between those two lines, or `load` fired before React
     * subscribed — and the canvas is INERT. Not degraded: clicking does nothing
     * at all, silently, with no error anywhere.
     *
     * That is what the QA suite hit: eight flows failed together and every one of
     * them needed these listeners, while every flow that did not (toolbar, page
     * ops, Suggest) passed. Rather than chase which moment was missed, the
     * attachment is made self-healing — cheap, and it cannot race.
     */
    const ensureAttached = window.setInterval(() => {
      const live = iframe.contentDocument as (Document & { __rbBound?: boolean }) | null;
      // Re-bind whenever the LIVE document is not carrying our mark, which
      // covers a fresh document, a reused one, and a first attach that never
      // ran — without needing to know which happened.
      if (live && !live.__rbBound) attach();
    }, 200);

    return () => {
      window.clearInterval(ensureAttached);
      iframe.removeEventListener("load", attach);
      try {
        if (doc) delete (doc as Document & { __rbBound?: boolean }).__rbBound;
        doc?.removeEventListener("click", onClick, true);
        doc?.removeEventListener("contextmenu", onContext, true);
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
  }, [iframeRef, reloadKey, sceneIndex, iframeReady]);

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
  /**
   * The canvas's rendered scale, or NULL when it cannot be measured.
   *
   * The distinction matters because the fallback is 1, and 1 is a plausible-looking
   * wrong answer: `overlayToCanvas` divides by it, so an unmeasurable canvas turns a
   * box drawn 400 screen px wide into "400 canvas px" when the truth is ~770. The
   * element then arrives at roughly half the size the user drew — reported as "the
   * element is not the size of the original square" (2026-08-22).
   *
   * `occupiedBounds` already refuses to guess here, in those words. Anything that
   * CREATES or MOVES geometry should refuse too; only read-only callers may take the
   * 1 and carry on.
   */
  const measuredCanvasScale = (): number | null => {
    if (canvasWidth <= 0) return null;
    if (HOST_SCALE) {
      // HOST-SCALED: the document inside is 1:1 and the IFRAME ELEMENT carries the
      // transform. An element's getBoundingClientRect() inside a frame is reported in
      // that frame's own viewport and is NOT affected by the parent's transform — so
      // measuring the inner canvas here would always return 1 and every pointer
      // coordinate would be off by the scale. The frame's own rect, read from the
      // parent where the transform lives, is the honest number.
      const f = iframeRef.current;
      if (!f) return null;
      const w = f.getBoundingClientRect().width;
      return w > 0 ? w / canvasWidth : null;
    }
    const canvas = iframeRef.current?.contentDocument?.querySelector(".renderball-canvas");
    if (!canvas) return null;
    const w = (canvas as HTMLElement).getBoundingClientRect().width;
    return w > 0 ? w / canvasWidth : null;
  };
  /** Scale for read-only use, falling back to 1. Never use this to build bounds. */
  const canvasScale = (): number => measuredCanvasScale() ?? 1;

  // ── insert (add primitive) + generate (marquee) ───────────────────────────

  const canvasEl = (): HTMLElement | null =>
    (iframeRef.current?.contentDocument?.querySelector(".renderball-canvas") as HTMLElement | null) ?? null;
  // Overlay-local px (== iframe-viewport px) → canvas px. The canvas is scaled to fit
  // and may be letterboxed, so subtract its rendered origin THEN divide by scale.
  /** A suggested region as percentages of the slide — see `suggestCanvas`. */
  const suggestionPct = (
    b: { x: number; y: number; w: number; h: number },
  ): { left: string; top: string; width: string; height: string } => {
    const cw = suggestCanvas?.w || canvasWidth || 1920;
    const ch = suggestCanvas?.h || Math.round((canvasWidth || 1920) * 9 / 16);
    return {
      left: `${(b.x / cw) * 100}%`,
      top: `${(b.y / ch) * 100}%`,
      width: `${(b.w / cw) * 100}%`,
      height: `${(b.h / ch) * 100}%`,
    };
  };

  /**
   * Where the slide's (0,0) sits in OVERLAY-local px.
   *
   * Legacy: the inner canvas is positioned and scaled inside the frame, and its rect —
   * reported in the iframe's own viewport, which the overlay exactly covers — IS the
   * origin. Host-scaled: the canvas sits at 0,0 in a 1:1 document and the transform
   * lives on the frame element, so the origin is the frame's offset WITHIN ITS
   * CONTAINER (SceneFrame's inset-0 wrapper — the same box the overlay fills). The
   * first host branch subtracted the frame's raw viewport rect, which is only correct
   * when that container happens to sit at the viewport origin; anywhere else every
   * marquee and guide would shift by the container's page position (review,
   * 2026-08-24 — latent, the flag has never shipped on).
   */
  const originInOverlay = (): { x: number; y: number } => {
    if (HOST_SCALE) {
      const f = iframeRef.current;
      const parent = f?.parentElement;
      if (!f || !parent) return { x: 0, y: 0 };
      const fr = f.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      return { x: fr.left - pr.left, y: fr.top - pr.top };
    }
    const r = canvasEl()?.getBoundingClientRect();
    return { x: r ? r.left : 0, y: r ? r.top : 0 };
  };

  const overlayToCanvas = (localX: number, localY: number): { x: number; y: number } => {
    const scale = canvasScale() || 1;
    const o = originInOverlay();
    return { x: (localX - o.x) / scale, y: (localY - o.y) / scale };
  };
  // Intrinsic canvas dimensions in canvas px (width is the known prop; height is the
  // rendered height un-scaled) — used to centre a default box for add-primitive.
  const canvasIntrinsic = (): { w: number; h: number } | null => {
    const c = canvasEl();
    const r = c?.getBoundingClientRect();
    // The height is DERIVED by dividing by the scale, so an unmeasurable scale would
    // report the on-screen height as the canvas height — a default insert box sized
    // to the viewport rather than the slide. Null is already the "not ready" signal
    // every caller handles; use it rather than a fallback of 1.
    const scale = measuredCanvasScale();
    if (!r || canvasWidth <= 0 || scale === null) return null;
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

  /** The selection's bounds in CANVAS px, from the same transform every gesture uses. */
  const selectedCanvasBounds = (): { x: number; y: number; w: number; h: number } | null => {
    if (!selected) return null;
    const p0 = overlayToCanvas(selected.rect.left, selected.rect.top);
    const p1 = overlayToCanvas(selected.rect.left + selected.rect.width, selected.rect.top + selected.rect.height);
    return { x: Math.round(p0.x), y: Math.round(p0.y), w: Math.round(p1.x - p0.x), h: Math.round(p1.y - p0.y) };
  };

  // Keep the numeric panel in step with the selection — except while the user is
  // typing in it, when a remeasure would eat their half-typed value.
  useEffect(() => {
    if (boundsFocusRef.current) return;
    const b = selectedCanvasBounds();
    setBoundsDraft(b ? { x: String(b.x), y: String(b.y), w: String(b.w), h: String(b.h) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, reloadKey, docTick]);

  /**
   * Commit the numeric panel: a pure position change goes through the MOVE op (cheap,
   * wrapper untouched), a size change through RESIZE with absolute bounds. The one
   * deliberate divergence from the drag-resize path: its no-wrapper fallback silently
   * REGENERATES the element, which costs tokens — the right trade under a drag
   * gesture, the wrong one for a typo in a number field. Here it explains instead.
   */
  const commitBounds = async () => {
    const d = boundsDraft;
    const cur = selectedCanvasBounds();
    if (!d || !cur || !selected || busy) return;
    const nx = Math.round(Number(d.x));
    const ny = Math.round(Number(d.y));
    const nw = Math.round(Number(d.w));
    const nh = Math.round(Number(d.h));
    if (![nx, ny, nw, nh].every(Number.isFinite) || nw <= 0 || nh <= 0) {
      setBoundsDraft({ x: String(cur.x), y: String(cur.y), w: String(cur.w), h: String(cur.h) });
      return;
    }
    const sizeChanged = nw !== cur.w || nh !== cur.h;
    const posChanged = nx !== cur.x || ny !== cur.y;
    if (!sizeChanged && !posChanged) return;
    const pieceId = selected.pieceId;
    setBusy("resize");
    if (!sizeChanged) {
      const ok = await post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId, op: "move", dx: nx - cur.x, dy: ny - cur.y });
      setBusy(null);
      if (ok) await settleCommit(pieceId, { afterMorph: pieceId });
      return;
    }
    const bounds = clampBounds({ x: nx, y: ny, w: nw, h: nh });
    const { ok, json } = await postJson(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId, op: "resize", ...bounds });
    setBusy(null);
    if (!ok && json.code === "no-wrapper") {
      setError("This element has no plain box to resize — drag a corner instead, which rebuilds it at the new size.");
      const b = selectedCanvasBounds();
      if (b) setBoundsDraft({ x: String(b.x), y: String(b.y), w: String(b.w), h: String(b.h) });
      return;
    }
    if (ok) await settleCommit(pieceId, { afterMorph: pieceId });
  };

  /**
   * Default box for a toolbar insert (text/icon/uploaded image), CASCADED off
   * anything already sitting there.
   *
   * The centred box used to be returned verbatim, so every insert landed on exactly
   * the same pixel: `left: 576, top: 454, width: 768` four times over in the founder's
   * deck (2026-08-22), four text boxes stacked so precisely that only the last one was
   * visible or clickable. Adding a second text box looked like adding nothing.
   *
   * Occupancy is measured from the live document rather than counted client-side, so
   * the cascade survives a reload and picks up where the page actually is — a counter
   * would reset to zero and stack on top again.
   */
  const defaultBounds = (kind: "text" | "media", aspect?: number | null) => {
    const dims = canvasIntrinsic();
    if (!dims) return null;
    const w = Math.round(dims.w * 0.4);
    // An uploaded image's box follows its real aspect (clamped) so it lands
    // uncropped; otherwise the stock proportions.
    let h = Math.round(dims.h * (kind === "text" ? 0.16 : 0.28));
    if (aspect && Number.isFinite(aspect) && aspect > 0) {
      h = Math.min(Math.round(w / aspect), Math.round(dims.h * 0.8));
    }
    const base = { x: Math.round((dims.w - w) / 2), y: Math.round((dims.h - h) / 2), w, h };
    return clampBounds(cascadeBox(base, occupiedBounds(), dims));
  };

  /**
   * Move the selection by a document offset: paint now, persist when the burst ends.
   *
   * The optimistic transform is the same one the drag uses, so a nudge after a drag
   * composes with it rather than fighting it, and the element never visibly waits for
   * the network.
   */
  const applyNudge = (dx: number, dy: number) => {
    if (!selected) return;
    const n = nudgeRef.current;
    n.dx += dx;
    n.dy += dy;
    const nodes = liveNodesRef.current.length ? liveNodesRef.current : livePieceNodes(selected.pieceId);
    liveNodesRef.current = nodes;
    for (const node of nodes) {
      node.el.style.transform = node.base
        ? `translate3d(${n.dx}px, ${n.dy}px, 0) ${node.base}`
        : `translate3d(${n.dx}px, ${n.dy}px, 0)`;
    }
    // The overlay follows each press: rect is the frame/handles' source of
    // truth, and before this it simply never moved on nudges — the border
    // and grips sat at the pre-nudge spot while the element walked away
    // (same family as the drag-drop stale-handles bug, 2026-08-29). The
    // 100ms left/top transition turns per-press jumps into a glide.
    const overlayScale = canvasScale();
    setSelected((s) =>
      s && s.pieceId === selected.pieceId
        ? { ...s, rect: { ...s.rect, left: s.rect.left + dx * overlayScale, top: s.rect.top + dy * overlayScale } }
        : s,
    );
    if (n.timer !== null) window.clearTimeout(n.timer);
    n.timer = window.setTimeout(() => {
      const { dx: tx, dy: ty } = nudgeRef.current;
      nudgeRef.current = { dx: 0, dy: 0, timer: null };
      if (tx === 0 && ty === 0) return;
      const pieceId = selected.pieceId;
      void post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId, op: "move", dx: tx, dy: ty }).then((ok) => {
        // The transform is a local illusion until the server agrees. On failure the
        // reload is the reconcile — the same error path the drag commit uses.
        if (!ok) onChanged();
      });
    }, 350);
  };

  const insertPrimitive = async (primitive: "text" | "icon") => {
    if (busy) return;
    const bounds = defaultBounds(primitive === "text" ? "text" : "media");
    if (!bounds) {
      setError("Canvas not ready — try again in a moment.");
      return;
    }
    setBusy("insert");
    const { ok, json } = await postJson(`${apiBase}/insert-element`, { scriptId, sceneIndex, bounds, mode: "primitive", primitive });
    setBusy(null);
    if (ok) {
      const pid = json.pieceId;
      await settleCommit(typeof pid === "string" ? pid : undefined, {
        afterMorph: typeof pid === "string" ? pid : undefined,
      });
    }
  };

  /** width/height ratio of the picked file, so the insert box fits it. */
  const imageAspect = (file: File): Promise<number | null> =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });

  // The Add-toolbar "image" path: a real file, placed at the drawn box when one
  // is open, else a centred box shaped to the image.
  const onFilePicked = async (file: File | null) => {
    if (!file || busy) return;
    let bounds: { x: number; y: number; w: number; h: number } | null;
    if (genBox) {
      const p0 = overlayToCanvas(genBox.left, genBox.top);
      const p1 = overlayToCanvas(genBox.left + genBox.width, genBox.top + genBox.height);
      bounds = clampBounds({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y });
    } else {
      bounds = defaultBounds("media", await imageAspect(file));
    }
    if (!bounds) {
      setError("Canvas not ready — try again in a moment.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("scriptId", scriptId);
    form.append("sceneIndex", String(sceneIndex));
    form.append("bounds", JSON.stringify(bounds));
    setBusy("insert");
    const { ok, json } = await postForm(`${apiBase}/upload-image`, form);
    setBusy(null);
    if (ok) {
      const pid = json.pieceId;
      setGenBox(null);
      setGenPrompt("");
      setTool(null);
      await settleCommit(typeof pid === "string" ? pid : undefined, {
        afterMorph: typeof pid === "string" ? pid : undefined,
      });
    }
  };

  const submitGenerate = async () => {
    const prompt = genPrompt.trim();
    if (!genBox || !prompt || busy) return;
    // Refuse rather than send bounds derived from a fallback scale — that is how a
    // drawn box became a half-size element. Same posture as occupiedBounds.
    if (measuredCanvasScale() === null) {
      setError("The slide is still laying out — draw the box again in a moment.");
      return;
    }
    const p0 = overlayToCanvas(genBox.left, genBox.top);
    const p1 = overlayToCanvas(genBox.left + genBox.width, genBox.top + genBox.height);
    const bounds = clampBounds({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y });

    // A generate can stall — a slow model, a lost connection, a request that
    // never comes back. When it did, the editor was WEDGED: the overlay said
    // "Generating…" indefinitely and Cancel was disabled while busy, so the
    // only way out was reloading the page and losing the drawn box. Whatever
    // caused the stall, being unable to abandon it is its own bug.
    const controller = new AbortController();
    generateAbortRef.current = controller;
    setBusy("insert");
    const { ok, json } = await postJson(
      `${apiBase}/insert-element`,
      {
        scriptId,
        sceneIndex,
        bounds,
        ...(genKind === "image"
          ? { mode: "generate-image", prompt, match: matchStyle }
          : genKind === "icon"
            ? { mode: "generate-icon", prompt, match: matchStyle }
            : { mode: "generate", prompt }),
      },
      controller.signal,
    );
    generateAbortRef.current = null;
    setBusy(null);
    if (ok) {
      const pid = json.pieceId;
      setGenBox(null);
      setGenPrompt("");
      setTool(null);
      await settleCommit(typeof pid === "string" ? pid : undefined, {
        afterMorph: typeof pid === "string" ? pid : undefined,
      });
    }
  };

  /** Abandon an in-flight generate and give the canvas back to the user. */
  const cancelGenerate = () => {
    generateAbortRef.current?.abort();
    generateAbortRef.current = null;
    setBusy(null);
    setGenBox(null);
    setGenPrompt("");
    setTool(null);
  };

  /**
   * Boxes the page's existing elements actually occupy, in CANVAS px.
   *
   * Measured live from the rendered document rather than inferred server-side:
   * built pieces carry no machine-readable geometry, so the server can only
   * describe them in words — and a model told "do not overlap the headline"
   * proposes a box over the headline anyway. The browser is the only place the
   * real rectangles exist, so it is the browser's job to send them.
   *
   * Full-bleed backdrops and move-offset frames are skipped by `rectOf`; without
   * that a single page-sized backdrop would mark the whole canvas as occupied and
   * every suggestion would be rejected.
   */
  const occupiedBounds = (): { x: number; y: number; w: number; h: number; pieceId: string }[] => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return [];
    const vw = doc.documentElement?.clientWidth ?? 0;
    const vh = doc.documentElement?.clientHeight ?? 0;
    // Refuse to guess. If the canvas has not laid out, every rect below would be
    // divided by a scale of 1 and come back at overlay pixels labelled as canvas
    // pixels — plausible-looking numbers that would push the model AWAY from the
    // free space. No geometry (the model still gets the textual context) beats
    // wrong geometry.
    const canvasRect = canvasEl()?.getBoundingClientRect();
    if (!canvasRect || canvasRect.width <= 0 || canvasWidth <= 0) return [];
    const out: { x: number; y: number; w: number; h: number; pieceId: string }[] = [];

    for (const piece of Array.from(doc.querySelectorAll("[data-piece]"))) {
      // Atmosphere is decorative — soft gradient washes and sparklines that span
      // most of the slide. Measured, they read as "the page is full" (one blob
      // came back 723×723 with nothing in it) and every proposal was rejected.
      // Content sits over a gradient perfectly happily, so it is not occupancy.
      if (piece.getAttribute("data-kind") === "atmosphere") continue;
      const pieceId = piece.getAttribute("data-piece") ?? "";

      for (const el of Array.from(piece.querySelectorAll("*"))) {
        if (el.querySelector("*")) continue; // leaves only — see below
        const r = el.getBoundingClientRect();
        if (r.width <= 8 || r.height <= 8) continue; // dots, rules, hairlines
        if (vw > 0 && vh > 0 && r.width >= vw * 0.92 && r.height >= vh * 0.92) continue; // backdrop
        // Text nodes are the real ink. An empty leaf with a size is usually a
        // rule or a decorative fill, and blocking on those over-reports too.
        if (!(el.textContent ?? "").trim()) continue;

        const p0 = overlayToCanvas(r.left, r.top);
        const p1 = overlayToCanvas(r.left + r.width, r.top + r.height);
        out.push({
          x: Math.round(p0.x),
          y: Math.round(p0.y),
          w: Math.round(p1.x - p0.x),
          h: Math.round(p1.y - p0.y),
          pieceId,
        });
      }
    }
    return out;
  };

  /** Ask for a layout. Costs a (small) model call and returns regions only. */
  const submitSuggest = async () => {
    const prompt = suggestPrompt.trim();
    if (!prompt || suggesting || busy) return;
    setSuggesting(true);
    setError(null);
    const { ok, json } = await postJson(`${apiBase}/suggest-layout`, {
      scriptId,
      sceneIndex,
      prompt,
      // Wire payload unchanged: pieceId is an editor-side concern and the
      // suggest-layout schema was never told about it.
      occupied: occupiedBounds().map(({ x, y, w, h }) => ({ x, y, w, h })),
    });
    setSuggesting(false);
    if (ok && Array.isArray(json.suggestions)) {
      const c = json.canvas as { w?: number; h?: number } | undefined;
      if (c && c.w && c.h) setSuggestCanvas({ w: c.w, h: c.h });
      setSuggestions(json.suggestions as LayoutSuggestion[]);
      // Clear any half-drawn marquee so the proposals are the only thing to act on.
      setGenBox(null);
      setTool(null);
    }
  };

  /**
   * Accept one proposed region: it becomes the marquee's frozen box with its
   * prompt pre-filled, so the user sees exactly what will be built and can edit
   * the words before spending anything. Identical to having drawn it by hand.
   */
  const acceptSuggestion = (s: LayoutSuggestion) => {
    if (busy) return;
    // Overlay px, computed from the OVERLAY's own size at click time. Measuring
    // here is safe in a way that measuring during render is not: the user has
    // just clicked the region, so the layout is settled by definition.
    const host = overlayRef.current;
    const ow = host?.clientWidth ?? 0;
    const oh = host?.clientHeight ?? 0;
    const cw = suggestCanvas?.w || canvasWidth || 1920;
    const ch = suggestCanvas?.h || Math.round((canvasWidth || 1920) * 9 / 16);
    if (ow > 0 && oh > 0) {
      setGenBox({
        left: (s.bounds.x / cw) * ow,
        top: (s.bounds.y / ch) * oh,
        width: (s.bounds.w / cw) * ow,
        height: (s.bounds.h / ch) * oh,
      });
    }
    setGenPrompt(s.prompt);
    setGenKind("element");
    setSuggestions((all) => all.filter((x) => x !== s));
  };

  // Marquee draw on the armed capture layer. Overlay-local coords via the overlay's
  // own rect; window listeners track a drag that leaves the layer (like the move shield).
  const onMarqueeDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // primary button only — see onDragStart
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
  /**
   * While a gesture is live the IFRAME must stop swallowing mouse events.
   *
   * Measured 2026-08-14: a fast drag did NOTHING. The only surface in the
   * parent document that could see a mousemove before the full-screen shield
   * existed was the drag surface, sized exactly to the element — and the
   * shield itself only mounts once a move has already been seen. So any flick
   * whose FIRST move left the element's box (trivial on a 17px text line:
   * 120px flick lost, 12px steps tracked) was never seen at all, the shield
   * never mounted, and the whole gesture died silently. That reads as "the
   * editor is clunky" when it is really "the editor did not hear you".
   *
   * Turning off pointer-events on the iframe for the duration hands every
   * move to the window immediately. Chosen over mounting the shield on
   * mousedown deliberately: that path is documented at DRAG_MIN_PX as having
   * killed double-click (the mouseup landed on the shield), and this one adds
   * no new hit target at all, so the hand-rolled double-click detector is
   * untouched. (setPointerCapture is NOT an option here — capture across an
   * iframe boundary is unspecified, W3C pointerevents#493.)
   */
  const setIframeInert = (inert: boolean) => {
    const f = iframeRef.current;
    if (f) f.style.pointerEvents = inert ? "none" : "";
  };

  const detachDrag = () => {
    const h = dragHandlersRef.current;
    if (h) {
      window.removeEventListener("mousemove", h.move);
      window.removeEventListener("mouseup", h.up);
      dragHandlersRef.current = null;
    }
    setIframeInert(false);
  };
  /**
   * How far a press must travel before it counts as a drag.
   *
   * This threshold is why double-click works. `dragDelta` mounts a FULL-SCREEN
   * shield (see the JSX below) so a fast drag cannot be swallowed by the iframe
   * — and setting it on mousedown meant every press on a selected element
   * mounted that shield instantly. The mouseup then landed on the shield rather
   * than on the element the mousedown hit, so the browser emitted no `click`,
   * and therefore never a `dblclick`: measured as zero dblclick events reaching
   * either document. A press that never moves is a click, and must stay one.
   */
  const DRAG_MIN_PX = 3;

  /** Engine taxonomy → words a person would use on a slide. */
  const kindLabel = (k: string): string =>
    ({ diegetic: "Visual", atmosphere: "Background", chrome: "Overlay", copy: "Text" } as Record<string, string>)[k] ??
    (k ? k[0].toUpperCase() + k.slice(1) : "Element");
  const onDragStart = (e: React.MouseEvent) => {
    // Primary button only: a right-click opens a menu (and on macOS swallows
    // the matching mouseup), a middle-click pastes on Linux — neither is the
    // start of a drag, and arming the handlers anyway left them stranded.
    if (e.button !== 0) return;
    if (!selected || busy) return;
    e.preventDefault();

    // Is this the second press of a double-click? Note it, but DO NOT act yet.
    //
    // Acting here — on mousedown — was wrong, and only a test that behaved like
    // a person caught it: select an element, then press again to drag it, and
    // the editor opened a text-edit session instead of moving anything. That is
    // an ordinary way to use a canvas, and the press had not yet travelled, so
    // there was no way to tell a double-click from the start of a drag.
    //
    // Mouseup knows. A press that travels is a drag; a press that does not,
    // soon after a click in the same spot, is a double-click.
    const prev = lastClickRef.current;
    lastClickRef.current = { t: Date.now(), x: e.clientX, y: e.clientY };
    secondPressRef.current =
      !!prev &&
      Date.now() - prev.t < DOUBLE_CLICK_MS &&
      Math.abs(e.clientX - prev.x) <= DOUBLE_CLICK_SLOP &&
      Math.abs(e.clientY - prev.y) <= DOUBLE_CLICK_SLOP;

    // Snap inputs, captured ONCE: reading sibling rects per frame is exactly the
    // layout thrash the transform-only drag path exists to avoid. Canvas px.
    const startTopLeft = overlayToCanvas(selected.rect.left, selected.rect.top);
    const startBottomRight = overlayToCanvas(
      selected.rect.left + selected.rect.width,
      selected.rect.top + selected.rect.height,
    );
    const movingBox = {
      x: startTopLeft.x,
      y: startTopLeft.y,
      w: startBottomRight.x - startTopLeft.x,
      h: startBottomRight.y - startTopLeft.y,
    };
    const dims0 = canvasIntrinsic();
    // Snap targets: SIBLING pieces only, unioned to piece-level boxes.
    //
    // Two corrections from review (2026-08-24). The first cut excluded the moving
    // piece GEOMETRICALLY — origin within 2px of the selection rect — but
    // occupiedBounds returns one box per text LEAF, and a leaf's origin almost never
    // matches the piece rect, so the moving piece's own leaves stayed in the target
    // set and the element could snap to itself. Exclusion is by id now. And leaves
    // are unioned per piece: "align to that card" means the card's edges and centre,
    // not sixty micro-targets from every line of text inside it.
    const leafBoxes = occupiedBounds().filter((b) => b.pieceId !== selected.pieceId);
    const unions = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
    for (const b of leafBoxes) {
      const u = unions.get(b.pieceId);
      if (!u) unions.set(b.pieceId, { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h });
      else {
        u.x1 = Math.min(u.x1, b.x);
        u.y1 = Math.min(u.y1, b.y);
        u.x2 = Math.max(u.x2, b.x + b.w);
        u.y2 = Math.max(u.y2, b.y + b.h);
      }
    }
    const siblings = [...unions.values()].map((u) => ({ x: u.x1, y: u.y1, w: u.x2 - u.x1, h: u.y2 - u.y1 }));
    dragRef.current = { startX: e.clientX, startY: e.clientY, scale: canvasScale() };
    draggingRef.current = false;
    setGestureHeld(true);
    setIframeInert(true);
    // Cache the live nodes ONCE (a rect read per move is what forces layout).
    liveNodesRef.current = livePieceNodes(selected.pieceId);
    for (const n of liveNodesRef.current) n.el.style.willChange = "transform";

    /**
     * The element itself follows the cursor now — not just an outline.
     *
     * Before this, a drag moved a 2px frame while the real element sat still
     * and teleported ~1.5s later when the iframe finished reloading. The
     * scene document is static SSR HTML with no hydration, so writing a
     * compositor-only transform onto its nodes is safe and the next reload
     * rebuilds from the server anyway. Written through a ref inside a
     * rAF-batched callback: no setState per move, no layout, no React commit
     * for a 2900-line component at 120Hz.
     */
    const paint = () => {
      rafRef.current = 0;
      const d = dragRef.current;
      const p = pendingRef.current;
      if (!d || !p) return;
      let sx = p.dx / (d.scale || 1);
      let sy = p.dy / (d.scale || 1);
      // SNAP. The threshold is a SCREEN distance divided by the zoom, so the pull feels
      // the same under the hand whether the slide is at 40% or 100%. Cmd/Ctrl bypasses
      // (p.bypass) — snapping you cannot escape makes the one position you want the one
      // position unreachable.
      if (dims0) {
        const raw = { ...movingBox, x: movingBox.x + sx, y: movingBox.y + sy };
        const snap = snapBox(raw, siblings, dims0, {
          threshold: DEFAULT_SNAP_THRESHOLD / (d.scale || 1),
          bypass: p.bypass,
        });
        sx = snap.x - movingBox.x;
        sy = snap.y - movingBox.y;
        snappedRef.current = { sx, sy };
        const key = snap.guides.map((g) => `${g.axis}${g.at}${g.source}`).join("|");
        if (key !== guidesKeyRef.current) {
          guidesKeyRef.current = key;
          setGuides(snap.guides);
        }
      }
      for (const n of liveNodesRef.current) {
        n.el.style.transform = n.base ? `translate3d(${sx}px, ${sy}px, 0) ${n.base}` : `translate3d(${sx}px, ${sy}px, 0)`;
      }
      // The outline follows the SNAPPED element, not the raw pointer — otherwise the
      // frame and the thing it frames drift apart by up to the threshold.
      const scale = d.scale || 1;
      if (frameRef.current) {
        frameRef.current.style.transform = `translate3d(${sx * scale}px, ${sy * scale}px, 0)`;
      }
    };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!draggingRef.current && Math.abs(dx) < DRAG_MIN_PX && Math.abs(dy) < DRAG_MIN_PX) return;
      const first = !draggingRef.current;
      draggingRef.current = true;
      // Shift locks the drag to whichever axis it has travelled furthest along.
      const locked = ev.shiftKey ? constrainToAxis(dx, dy) : { dx, dy };
      pendingRef.current = { dx: locked.dx, dy: locked.dy, bypass: ev.metaKey || ev.ctrlKey };
      // One React commit for the WHOLE gesture, and it carries ZERO offset:
      // it exists only to arm the overlay's dragging mode (shield up,
      // transitions off, frame positioned at the ORIGINAL rect). The offset
      // itself rides entirely on the transform, so nothing double-counts.
      if (first) setDragDelta({ dx: 0, dy: 0 });
      if (!rafRef.current) rafRef.current = requestAnimationFrame(paint);
    };
    const up = async (ev: MouseEvent) => {
      detachDrag();
      setGestureHeld(false);
      const d = dragRef.current;
      const dragged = draggingRef.current;
      const wasSecondPress = secondPressRef.current;
      dragRef.current = null;
      draggingRef.current = false;
      secondPressRef.current = false;
      if (!d || !selected || !dragged) {
        clearLiveDrag();
        setDragDelta(null);
        // It never travelled. If it was the second press of a double-click,
        // NOW it is unambiguous — a drag would have moved by here.
        if (wasSecondPress) {
          lastClickRef.current = null; // a triple-click must not open a third
          openTextSessionAt(ev.clientX, ev.clientY);
        }
        return;
      }
      setGuides([]);
      guidesKeyRef.current = "";
      const scale = d.scale || 1;
      // Commit what the user SAW — the snapped offset the paint loop last applied, not
      // the raw pointer travel. Committing the raw delta would jump the element off its
      // guide the moment the mouse came up, which reads as the snap being a lie.
      const snappedNow = snappedRef.current;
      const dx = Math.round(snappedNow ? snappedNow.sx : (ev.clientX - d.startX) / scale);
      const dy = Math.round(snappedNow ? snappedNow.sy : (ev.clientY - d.startY) / scale);
      snappedRef.current = null;
      if (dx === 0 && dy === 0) {
        clearLiveDrag();
        setDragDelta(null);
        return;
      }
      // Keep the box at the DRAGGED position while the move persists — clearing
      // dragDelta before the await snapped the outline back to the old spot for
      // the whole POST. On success the reload shows the piece at its new place
      // and the selection is restored (reselectIdRef) so nudging can continue.
      /**
       * OPTIMISTIC COMMIT (speed playbook 2026-08-18; the pattern every
       * editor studied uses — Figma, tldraw, Linear, Excalidraw: the server
       * is the arbiter of eventual truth, never a participant in the frame).
       * The element is ALREADY at its dropped position via the held
       * transform; the old flow then paid a full re-render (measured
       * 1449-1564ms) to redraw identical pixels, blanking the selection
       * meanwhile. Now the gesture ends HERE: selection stays, frame stays,
       * no reload. The POST commits in the background; the render cache and
       * the next natural reload (any structural edit) pick up the
       * server-rendered truth. Single-user makes this safe with nothing but
       * a per-piece in-flight guard and reconcile-on-failure — which is
       * exactly the old reload path, now demoted to the ERROR path.
       */
      const committedPieceId = selected.pieceId;
      // THE OVERLAY'S TRUTH ADVANCES WITH THE ELEMENT (founder screenshot,
      // 2026-08-29: handles orphaned at the pre-drag spot). The iframe nodes
      // keep their transform — the next reload bakes it into SSR truth — but
      // selected.rect, which the frame, the resize handles, and the bounds
      // panel all derive from, must move by the committed delta. Three
      // imperative cleanups ride along: the frame's gesture transform is
      // retired (React never clears a style it didn't write — the border
      // looked right while the handles didn't, which is what made this bug
      // invisible for so long), willChange is dropped, and the node capture
      // is discarded so the NEXT gesture re-reads bases that INCLUDE this
      // move — reusing this capture made the first nudge after a drag snap
      // the element back by the drag's own distance.
      if (frameRef.current) frameRef.current.style.transform = "";
      for (const n of liveNodesRef.current) n.el.style.willChange = "";
      liveNodesRef.current = [];
      justDroppedRef.current = true;
      requestAnimationFrame(() => {
        justDroppedRef.current = false;
      });
      setSelected((s) =>
        s && s.pieceId === committedPieceId
          ? { ...s, rect: { ...s.rect, left: s.rect.left + dx * scale, top: s.rect.top + dy * scale } }
          : s,
      );
      setDragDelta(null);
      setBusy(null);
      void post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId: committedPieceId, op: "move", dx, dy })
        .then((ok) => {
          if (ok) {
            // Tell the parent the doc changed WITHOUT forcing a reload-now:
            // thumbnails/persistence listeners still hear it.
            refreshUndoDepthRef.current();
            onCommitted?.();
            return;
          }
          // Rejected: reconcile from server truth — the old full path.
          clearLiveDrag();
          setError("That move didn't save — put back.");
          reselectIdRef.current = committedPieceId;
          setSelected(null);
          onChanged();
        })
        .catch(() => {
          clearLiveDrag();
          setError("That move didn't save — put back.");
          reselectIdRef.current = committedPieceId;
          setSelected(null);
          onChanged();
        });
    };
    dragHandlersRef.current = { move, up };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /**
   * Open the selected piece's text session at a point on the overlay.
   *
   * The iframe has its own `dblclick` handler (onDbl) and, through the UI, it
   * was UNREACHABLE. A double-click is down/up/click/down/up/dblclick, and the
   * FIRST click selects the piece — which drops the drag surface over it, so
   * the second press lands on the overlay in the parent document. Whether the
   * browser still emitted a `dblclick`, and to whom, came down to whether React
   * had painted in between: measured across repeated runs it landed on the
   * iframe, on the overlay, and on nobody at all. Double-click to edit text
   * looked implemented and was in practice a coin flip; the "Edit text" button
   * hid it by reaching the same session another way.
   *
   * The overlay sits at inset:0 over the frame, so subtracting the frame's
   * origin converts a parent-document point into an iframe-viewport point —
   * which is what elementFromPoint there expects, and how the session learns
   * WHICH field was double-clicked rather than always focusing the first.
   */
  const openTextSessionAt = (clientX: number, clientY: number): boolean => {
    if (!selected || busy || editing) return false;
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return false;
    const piece = doc.querySelector(`[data-piece="${selected.pieceId}"]`);
    if (!piece) return false;
    const host = frame.getBoundingClientRect();
    const under = doc.elementFromPoint(clientX - host.left, clientY - host.top);
    return startTextFields(piece, under as HTMLElement | null);
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

  /**
   * Delete / Backspace removes the selected element.
   *
   * Guarded hard, because these are also the most destructive keys in any text
   * field: it does nothing while a text element is being edited, while a request
   * is in flight, or while focus sits in ANY input — the generate prompt, the
   * Suggest box, the brand panel. Without the focus check, backspacing a typo
   * out of the prompt would silently delete the element behind it.
   */
  useEffect(() => {
    if (!selected || editing || busy) return;
    const onKey = (e: KeyboardEvent) => {
      const isDelete = e.key === "Delete" || e.key === "Backspace";
      // ⌘D / Ctrl+D duplicates — same guard set as delete, because the
      // browser's own ⌘D (bookmark) must keep working the moment focus sits
      // in any text field.
      const isDuplicate = (e.key === "d" || e.key === "D") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      // Arrows nudge. No modifier beyond Shift: Cmd/Alt+Arrow are the browser's and the
      // OS's (history, word jump, Spaces), and stealing them would be worse than the
      // feature is worth.
      const nudge = e.metaKey || e.ctrlKey || e.altKey ? null : nudgeFor(e.key, e.shiftKey);
      if (!isDelete && !isDuplicate && !nudge) return;
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          el.getAttribute("role") === "textbox");
      if (typing) return;
      e.preventDefault();
      if (nudge) {
        applyNudge(nudge.dx, nudge.dy);
        return;
      }
      if (isDuplicate) void duplicateSelected();
      else void remove();
    };

    // BOTH documents. Selecting an element means clicking inside the canvas
    // IFRAME, which moves focus into that document — so a listener on the parent
    // window alone never hears the keystroke, and the key silently did nothing
    // in exactly the situation it is for. (Caught by the QA suite: every other
    // editor flow passed and this one timed out.)
    const frameDoc = iframeRef.current?.contentDocument ?? null;
    window.addEventListener("keydown", onKey);
    frameDoc?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      frameDoc?.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editing, busy, docTick]);

  // Escape disarms the marquee tool / cancels a pending generate box, and
  // dismisses proposed regions — one key clears every pending offer.
  useEffect(() => {
    if (!tool && !genBox && suggestions.length === 0 && busy !== "insert") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Backing out of a RUNNING generate is the same gesture as backing
        // out of a pending one. Clearing only the overlays left the request
        // in flight and every control dead behind an invisible busy state —
        // and the element still landed later, a surprise nobody asked for.
        if (generateAbortRef.current) cancelGenerate();
        setTool(null);
        setGenBox(null);
        setMarquee(null);
        setGenPrompt("");
        setSuggestions([]);
      }
    };
    // BOTH documents, like Delete and cmd-Z above: mid-generate the natural
    // "is it stuck?" click lands on the canvas, focus moves into the iframe,
    // and a window-only listener leaves Escape dead exactly when it matters.
    const frameDoc = iframeRef.current?.contentDocument ?? null;
    window.addEventListener("keydown", onKey);
    frameDoc?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      frameDoc?.removeEventListener("keydown", onKey);
    };
  }, [tool, genBox, suggestions.length, busy, docTick]);

  // A proposed layout belongs to the page it was proposed FOR. Without this,
  // dashed suggestion boxes followed the user across the slide rail, and one
  // click built the suggested element onto the wrong page. Keyed on sceneIndex
  // only — surviving the post-accept reload (reloadKey) is intentional.
  useEffect(() => {
    setSuggestions([]);
    setGenBox(null);
    setMarquee(null);
    setGenPrompt("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIndex]);

  // Errors are a moment, not a mode.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

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
  refreshUndoDepthRef.current = () => void refreshUndoDepth();
  useEffect(() => {
    void refreshUndoDepth();
  }, [refreshUndoDepth, reloadKey]);

  const undo = async () => {
    if (busy) return;
    // Deliberately NOT gated on the locally-known depth.
    //
    // `undoDepth` is refreshed by a fetch keyed on reloadKey, so immediately
    // after an edit it can still read 0 while the server has plenty to undo.
    // Gating on it made the button enabled and INERT — pressed, nothing
    // happened, no request was even sent. The server knows the truth and says so
    // if there is nothing to undo, which postJson surfaces like any other error.
    setBusy("undo");
    const { ok } = await postJson(`${apiBase}/undo`, { scriptId });
    setBusy(null);
    if (ok) {
      // Undo may have removed the selected piece — clear rather than dangle.
      await settleCommit(undefined, { afterMorph: null });
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
    // BOTH documents, like the Delete handler above: clicking an element puts
    // focus inside the canvas iframe, and a parent-window listener alone never
    // hears the keystroke — so undo was dead precisely after touching an
    // element, the moment it is most wanted.
    const frameDoc = iframeRef.current?.contentDocument ?? null;
    window.addEventListener("keydown", onKey);
    frameDoc?.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      frameDoc?.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, undoDepth, apiBase, scriptId, docTick]);

  // ---- resize -------------------------------------------------------------
  /** Drag one of the 8 grips. The box is tracked in overlay px for a live preview,
   *  then converted to absolute canvas px once, on release.
   *
   *  The shield below (`resizeBox && …`) exists because of a bug a founder
   *  found by hand: EXPANDING an element did nothing while contracting worked.
   *  Dragging a grip outward immediately leaves the 10px grip and the
   *  selection box, putting the cursor over the canvas IFRAME — which swallows
   *  mouse events, so the window mouseup that commits the resize never fired.
   *  Contracting keeps the cursor over the selection overlay, so only one
   *  direction died. The move drag already mounts a full-screen shield for
   *  exactly this; resize was missing its own. Unlike move, the shield mounts
   *  on mousedown — a grip press is never a click or double-click, so there is
   *  no gesture to preserve by waiting for travel. */
  const resizeCursorRef = useRef<string>("nwse-resize");
  const onResizeStart = (e: React.MouseEvent, dir: HandleDir, cursor: string) => {
    if (e.button !== 0) return; // primary button only — see onDragStart
    if (!box || busy) return;
    resizeCursorRef.current = cursor;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, ...box };
    const track = (b: { left: number; top: number; width: number; height: number }) => {
      resizeRef.current = b;
      setResizeBox(b);
    };
    track({ left: box.left, top: box.top, width: box.width, height: box.height });
    setGestureHeld(true);
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
      setGestureHeld(false);
      const final = resizeRef.current;
      // Always drop the live preview + shield, even when there is nothing to
      // commit — a stuck full-screen shield would make the whole editor dead.
      if (final && selected) void commitResize(final);
      else setResizeBox(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const commitResize = async (b: { left: number; top: number; width: number; height: number }) => {
    if (!selected) {
      setResizeBox(null);
      return;
    }
    const pieceId = selected.pieceId;
    const p0 = overlayToCanvas(b.left, b.top);
    const p1 = overlayToCanvas(b.left + b.width, b.top + b.height);
    const bounds = clampBounds({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y });

    setBusy("resize");
    const { ok, json } = await postJson(`${apiBase}/edit-layout`, {
      scriptId,
      sceneIndex,
      pieceId,
      op: "resize",
      ...bounds,
    });

    // Some pieces are not a single positioned box — a bare component, or a
    // fragment of siblings each positioned in the section's own coordinate
    // space. Rewriting a box they don't have is impossible, and wrapping them
    // would re-base their coordinates and scatter the layout. So the element is
    // REBUILT at the size that was just dragged, which is what the user asked
    // for either way. This one path costs tokens where a plain resize does not.
    if (!ok && json.code === "no-wrapper") {
      setBusy("regenerate");
      const redraw = await post(`${apiBase}/regenerate-element`, {
        scriptId,
        sceneIndex,
        pieceId,
        instruction:
          `Re-render this element so it exactly fills a box ${Math.round(bounds.w)}px wide by ` +
          `${Math.round(bounds.h)}px tall, positioned at x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}. ` +
          `Keep the same content, wording and styling — only its size and position change. ` +
          `Scale type and spacing so it fills the new box without overflowing it.`,
      });
      setBusy(null);
      setResizeBox(null);
      if (redraw) {
        await settleCommit(pieceId, { afterMorph: pieceId });
      }
      return;
    }

    setBusy(null);
    setResizeBox(null);
    if (ok) {
      await settleCommit(pieceId, { afterMorph: pieceId });
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
      await settleCommit(selected.pieceId, { afterMorph: selected.pieceId });
    }
  };
  const remove = async () => {
    if (!selected) return;
    /**
     * OPTIMISTIC DELETE (same doctrine as the optimistic move above): the
     * element disappears NOW — hidden, not removed, so a failed commit can
     * resurrect it byte-identically. The server round-trip and the reload
     * leave the felt path entirely; failure reconciles through the old
     * reload flow and an honest sentence.
     */
    const pieceId = selected.pieceId;
    const hidden = livePieceNodes(pieceId);
    for (const n of hidden) n.el.style.visibility = "hidden";
    setSelected(null);
    void post(`${apiBase}/edit-layout`, { scriptId, sceneIndex, pieceId, op: "delete" })
      .then((ok) => {
        if (ok) {
          refreshUndoDepthRef.current();
          onCommitted?.();
          return;
        }
        for (const n of hidden) n.el.style.visibility = "";
        setError("That delete didn't save — restored.");
        reselectIdRef.current = pieceId;
        onChanged();
      })
      .catch(() => {
        for (const n of hidden) n.el.style.visibility = "";
        setError("That delete didn't save — restored.");
        reselectIdRef.current = pieceId;
        onChanged();
      });
  };

  /**
   * Bring the selected element to the front, or send it to the back.
   *
   * The selection is kept across the reload (reselectIdRef) rather than
   * cleared: raising something is usually the first of several adjustments,
   * and losing the selection after each one makes that a chore.
   */
  const reorder = async (to: "front" | "back") => {
    if (!selected || busy) return;
    setBusy(to === "front" ? "front" : "back");
    const ok = await post(`${apiBase}/edit-layout`, {
      scriptId,
      sceneIndex,
      pieceId: selected.pieceId,
      op: to,
    });
    setBusy(null);
    if (ok) {
      await settleCommit(selected.pieceId, { afterMorph: selected.pieceId });
    }
  };

  /**
   * Duplicate the selected element (the editor's ⌘D). Deterministic and free —
   * the clone is the piece's own body under a fresh id, nudged 24px so it
   * reads as a new object. The SERVER re-renders before answering, so the
   * reselect targets the CLONE: the thing you are now holding, per every
   * editor's convention.
   */
  const duplicateSelected = async () => {
    if (!selected || busy) return;
    setBusy("duplicate");
    const res = await fetch(`${apiBase}/edit-layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scriptId, sceneIndex, pieceId: selected.pieceId, op: "duplicate" }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, id: (j as { pieceId?: string }).pieceId })))
      .catch(() => ({ ok: false, id: undefined as string | undefined }));
    setBusy(null);
    if (res.ok) {
      reselectIdRef.current = res.id ?? selected.pieceId;
      setSelected(null);
      onChanged();
    } else {
      setError("Couldn't duplicate this element.");
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

  // Arm/disarm the marquee-to-generate surface. Shared by the internal pill and
  // the shell toolbar so both stay in lockstep.
  const toggleGenerate = useCallback(() => {
    setSelected(null);
    setHovered(null);
    setGenBox(null);
    setMarquee(null);
    setTool((t) => (t === "generate" ? null : "generate"));
  }, []);
  const toggleOutlines = useCallback(() => setShowAll((s) => !s), []);

  // Actions a shell toolbar drives, and a state readout it reflects. onState is
  // kept in a ref so an inline parent callback doesn't re-fire the effect every
  // render — it fires only when the reported state actually changes.
  useImperativeHandle(
    ref,
    () => ({
      addText: () => void insertPrimitive("text"),
      addImage: () => fileRef.current?.click(),
      addIcon: () => void insertPrimitive("icon"),
      toggleGenerate,
      toggleOutlines,
      undo: () => void undo(),
      regenerateSelected: (instruction: string) => {
        void (async () => {
          const text = instruction.trim();
          if (!selected || !text || busy) return;
          setBusy("regenerate");
          const ok = await post(`${apiBase}/regenerate-element`, {
            scriptId,
            sceneIndex,
            pieceId: selected.pieceId,
            instruction: text,
          });
          setBusy(null);
          if (ok) {
            await settleCommit(selected.pieceId, { afterMorph: selected.pieceId });
          }
        })();
      },
      animateSelected: (instruction: string) => {
        void (async () => {
          const text = instruction.trim();
          if (!selected || !text || busy) return;
          setBusy("animate");
          const ok = await post(`${apiBase}/animate-element`, {
            scriptId,
            sceneIndex,
            pieceId: selected.pieceId,
            instruction: text,
          });
          setBusy(null);
          if (ok) {
            replayAfterLoadRef.current = true;
            await settleCommit(selected.pieceId, { afterMorph: selected.pieceId });
            // The morph path lands in THIS document — replay now. The reload
            // path parks the reselect intent and attach() replays on arrival.
            if (reselectIdRef.current !== selected.pieceId) {
              replayAfterLoadRef.current = false;
              replayMotionIn(iframeRef.current?.contentDocument);
            }
          }
        })();
      },
      replayMotion: () => replayMotionIn(iframeRef.current?.contentDocument),
      /** Parents call this after their own same-scene commits (brand
       *  re-skin): morph-first, and the caller falls back to a reload when
       *  it returns false. */
      morphReload,
    }),
    [toggleGenerate, toggleOutlines, selected, busy, scriptId, sceneIndex, apiBase],
  );
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    onStateRef.current?.({
      tool: tool === "generate" ? "generate" : "select",
      showAll,
      canUndo: undoDepth > 0,
      busy,
      selected: selected ? { pieceId: selected.pieceId, kind: selected.kind } : null,
    });
  }, [tool, showAll, undoDepth, busy, selected]);

  return (
    <div
      ref={overlayRef}
      // Selection state on the overlay ROOT, which always renders.
      //
      // The selection FRAME only mounts once the piece has a measured box, so
      // reading selection from it conflates "nothing is selected" with "selected
      // but not yet measured" — and automation saw a click do nothing when it
      // had in fact worked. This attribute answers only the question asked.
      data-rb-selected={selected?.pieceId ?? ""}
      data-rb-busy={busy ?? ""}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}
    >
      {/* drag shield: while dragging, catch every mouse event before the iframe can
          swallow it (iframe docs don't forward mousemove to the parent window, so a
          fast drag that escaped the handle used to stall mid-gesture) */}
      {dragDelta && gestureHeld && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, cursor: "move", pointerEvents: "auto" }} />
      )}
      {/* resize shield: same reason, resize gesture. Without it, dragging a grip
          OUTWARD (expanding) left the grip and landed on the iframe, which
          swallowed the mouseup — so expanding silently did nothing while
          contracting worked. */}
      {resizeBox && gestureHeld && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, cursor: resizeCursorRef.current, pointerEvents: "auto" }} />
      )}

      <style dangerouslySetInnerHTML={{ __html: ORB_KEYFRAMES }} />

      {/* Add toolbar (top-left). Neutral chrome; the emerald is reserved for the
          primary action and active state (DESIGN.md). */}
      {!hideToolbar && !editing && (
        <div className="absolute left-2 top-2 flex items-center gap-1" style={{ pointerEvents: "auto" }}>
          <span className="mr-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">Add</span>
          <button
            type="button"
            onClick={() => void insertPrimitive("text")}
            disabled={!!busy}
            className={`${HIT} ${R_SM} ${CHROME} px-2.5 text-[11px] font-medium disabled:opacity-50`}
          >
            Text
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
            title="Upload an image"
            className={`${HIT} ${R_SM} ${CHROME} px-2.5 text-[11px] font-medium disabled:opacity-50`}
          >
            Image
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = ""; // allow re-picking the same file
              void onFilePicked(f);
            }}
          />
          <button
            type="button"
            onClick={() => void insertPrimitive("icon")}
            disabled={!!busy}
            className={`${HIT} ${R_SM} ${CHROME} px-2.5 text-[11px] font-medium disabled:opacity-50`}
          >
            Icon
          </button>
          <button
            type="button"
            aria-pressed={tool === "generate"}
            onClick={toggleGenerate}
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

      {/* ── generation in progress ──────────────────────────────────────────
          On the box being built: the drawn marquee for a new element, or the
          selected element's own box for a regenerate / resize-by-rebuild. */}
      {(busy === "insert" || busy === "regenerate") &&
        (() => {
          const target = genBox ?? box;
          if (!target) return null;
          return (
            <GeneratingOverlay
              box={target}
              label={busy === "insert" ? "Generating…" : "Rebuilding…"}
            />
          );
        })()}

      {/* ── right-click element menu ────────────────────────────────────────
          Clamped so a right-click near the right or bottom edge still shows the
          whole menu inside the canvas rather than half of it off the slide. */}
      {menu && (
        <>
          {/* Click-away catcher. Covers the canvas so the next click anywhere
              closes the menu instead of also acting on the slide. */}
          <div
            style={{ position: "absolute", inset: 0, pointerEvents: "auto", zIndex: 44 }}
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              left: Math.max(4, Math.min(menu.x, (overlayRef.current?.clientWidth ?? 9999) - 188)),
              top: Math.max(4, Math.min(menu.y, (overlayRef.current?.clientHeight ?? 9999) - 172)),
              width: 184,
              pointerEvents: "auto",
              zIndex: 45,
            }}
            className={`overflow-hidden ${R_MD} border border-white/10 bg-[#11141b] py-1 shadow-2xl`}
          >
            <div className="px-3 pb-1.5 pt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/35">
              {menu.kind || "element"}
            </div>
            {/* Held back for weeks because a reorder "lost the element". It did:
                both edit-layout routes validated op "front"/"back" and then fell
                through their dispatch chain to deleteElement, so the click that
                was meant to raise a piece deleted it. reorderElement itself was
                never running. With that fixed, 1,446 reorders across 31 local
                decks lose nothing, and the render-side safety net still stands
                behind it. */}
            <MenuItem
              onClick={() => {
                setMenu(null);
                void duplicateSelected();
              }}
              disabled={!!busy}
            >
              Duplicate
              <span className="ml-auto pl-6 font-mono text-[10px] opacity-50">⌘D</span>
            </MenuItem>
            <div className="my-1 h-px bg-white/8" />
            <MenuItem
              onClick={() => {
                setMenu(null);
                void reorder("front");
              }}
              disabled={!!busy}
            >
              Bring to front
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                void reorder("back");
              }}
              disabled={!!busy}
            >
              Send to back
            </MenuItem>
            <div className="my-1 h-px bg-white/8" />
            <MenuItem
              onClick={() => {
                setMenu(null);
                setRegenAsk(true);
              }}
              disabled={!!busy}
            >
              Regenerate…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                void remove();
              }}
              disabled={!!busy}
              danger
            >
              Delete
            </MenuItem>
          </div>
        </>
      )}

      {/* ── Suggest: a prompt box ON the slide, above everything ─────────────
          Quiet until used (DESIGN.md: the chrome recedes so the user's work is
          the loudest thing). Hidden while a marquee prompt is open or an element
          is selected, so two prompts are never competing for the same Enter. */}
      {!genBox && !selected && !editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitSuggest();
          }}
          style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", pointerEvents: "auto", zIndex: 43 }}
          className={`flex items-center gap-1 ${R_MD} border border-black/[0.06] bg-white/85 px-1.5 py-1 shadow-lg backdrop-blur-sm transition-opacity ${suggestions.length || suggesting ? "opacity-100" : "opacity-70 hover:opacity-100 focus-within:opacity-100"}`}
        >
          <input
            value={suggestPrompt}
            onChange={(e) => setSuggestPrompt(e.target.value)}
            disabled={suggesting || !!busy}
            aria-label="Describe this page and get a suggested layout"
            placeholder="Describe this page — e.g. traction slide with 3 KPIs"
            className={`h-[28px] w-80 ${R_SM} bg-black/[0.04] px-2 text-[11px] text-ink placeholder-muted outline-none focus:bg-black/[0.06] disabled:opacity-50`}
          />
          <button
            type="submit"
            disabled={suggesting || !!busy || !suggestPrompt.trim()}
            className={`${HIT} ${R_SM} ${ACTIVE} gap-1.5 px-2.5 text-[11px] font-semibold disabled:opacity-50`}
          >
            {suggesting ? (
              <>
                <CrystalOrb /> Suggesting…
              </>
            ) : (
              "Suggest"
            )}
          </button>
          {suggestions.length > 0 && (
            <button
              type="button"
              onClick={() => setSuggestions([])}
              className={`${HIT} ${R_SM} px-2 text-[11px] font-medium text-muted hover:bg-black/[0.05]`}
            >
              Clear
            </button>
          )}
        </form>
      )}

      {/* Proposed regions: ghost boxes the user can accept one at a time. Nothing
          is generated until one is clicked — the cheap step is shown before the
          expensive one. */}
      {suggestions.map((s, i) => {
        const box = suggestionPct(s.bounds);
        return (
          <button
            key={`${s.label}-${i}`}
            type="button"
            onClick={() => acceptSuggestion(s)}
            title={s.prompt}
            style={{
              position: "absolute",
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              border: "1.5px dashed var(--accent, #00c28a)",
              background: "rgba(0,194,138,0.07)",
              borderRadius: 8,
              pointerEvents: "auto",
              zIndex: 42,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 8,
              textAlign: "center",
              cursor: "pointer",
            }}
            className="group transition-colors hover:bg-[rgba(0,194,138,0.14)]"
          >
            <span className={`${R_SM} bg-[#11141b] px-2 py-1 text-[11px] font-medium text-white shadow-md`}>
              {s.label}
            </span>
          </button>
        );
      })}

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

      {/* ALIGNMENT GUIDES. Drawn only while a drag is snapping. Canvas coordinates are
          converted back to overlay px through the same fit the drag used, so the line
          sits exactly on the edge it describes at any zoom. A sibling guide is the
          accent; a page guide is quieter, because "you lined up with the page" is
          weaker information than "you lined up with that". */}
      {guides.map((g, i) => {
        const scale = canvasScale() || 1;
        const o = originInOverlay();
        const ox = o.x;
        const oy = o.y;
        const colour = g.source === "sibling" ? "var(--accent, #00c28a)" : "rgba(120,130,150,0.55)";
        const common = { position: "absolute" as const, pointerEvents: "none" as const, zIndex: 44 };
        return g.axis === "x" ? (
          <div
            key={`gx${i}`}
            style={{
              ...common,
              left: ox + g.at * scale,
              top: oy + g.from * scale,
              width: 1,
              height: Math.max(1, (g.to - g.from) * scale),
              background: colour,
            }}
          />
        ) : (
          <div
            key={`gy${i}`}
            style={{
              ...common,
              left: ox + g.from * scale,
              top: oy + g.at * scale,
              height: 1,
              width: Math.max(1, (g.to - g.from) * scale),
              background: colour,
            }}
          />
        );
      })}

      {/* NUMERIC BOUNDS PANEL — type an exact X/Y/W/H instead of nudging toward it.
          Geist Mono per DESIGN.md (numbers are technical text); quiet chrome, bottom
          right so it never sits over the selection toolbar or the Suggest box. The
          ratio toggle keeps W and H proportional while either is edited. */}
      {selected && boundsDraft && !editing && !genBox && !marquee && !dragDelta && !resizeBox && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            zIndex: 45,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            borderRadius: 10,
            background: "rgba(15,17,22,0.9)",
            border: "1px solid rgba(255,255,255,0.09)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 11,
            color: "#e6e8ee",
          }}
        >
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ opacity: 0.55, textTransform: "uppercase" }}>{k}</span>
              <input
                value={boundsDraft[k]}
                onFocus={() => {
                  boundsFocusRef.current = true;
                }}
                onBlur={() => {
                  boundsFocusRef.current = false;
                  void commitBounds();
                }}
                onChange={(e) => {
                  const v = e.target.value;
                  setBoundsDraft((d) => {
                    if (!d) return d;
                    if (!aspectLock || (k !== "w" && k !== "h")) return { ...d, [k]: v };
                    const cw = Number(d.w) || 1;
                    const ch = Number(d.h) || 1;
                    const n = Number(v);
                    if (!Number.isFinite(n) || n <= 0) return { ...d, [k]: v };
                    return k === "w"
                      ? { ...d, w: v, h: String(Math.max(1, Math.round((n * ch) / cw))) }
                      : { ...d, h: v, w: String(Math.max(1, Math.round((n * cw) / ch))) };
                  });
                }}
                onKeyDown={(e) => {
                  // The document-level key handler must never see these: Backspace here
                  // is editing a number, not deleting the element.
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    boundsFocusRef.current = false;
                    const b = selectedCanvasBounds();
                    if (b) setBoundsDraft({ x: String(b.x), y: String(b.y), w: String(b.w), h: String(b.h) });
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                style={{
                  width: 44,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  color: "inherit",
                  font: "inherit",
                  padding: "3px 5px",
                  textAlign: "right",
                }}
              />
            </label>
          ))}
          <button
            type="button"
            onClick={() => setAspectLock((v) => !v)}
            title={aspectLock ? "W and H move together — click to unlock" : "Lock the aspect ratio"}
            style={{
              background: "transparent",
              border: `1px solid ${aspectLock ? "var(--accent, #00c28a)" : "rgba(255,255,255,0.14)"}`,
              color: aspectLock ? "var(--accent, #00c28a)" : "#9aa3b2",
              borderRadius: 6,
              padding: "3px 7px",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            ratio
          </button>
        </div>
      )}

      {/* THE DRAWN BOX IS THE FIELD (founder, 2026-08-29: "drawing a box and
          typing inside the box what you want is magical... maybe the box
          itself is the field?"). On release the rect becomes a dark-glass
          pane with the caret already blinking inside it — same material as
          the app's command menus, so it reads as the canvas asking, not a
          form appearing. The kind switch and actions shrink to a whisper
          strip at the box's edge. Enter generates, Shift+Enter breaks a
          line, Esc cancels. */}
      {genBox && (() => {
        const overlayW = overlayRef.current?.clientWidth ?? 9999;
        const overlayH = overlayRef.current?.clientHeight ?? 0;
        const stripBelow = genBox.top + genBox.height + 44 <= overlayH;
        const stripTop = stripBelow
          ? genBox.top + genBox.height + 6
          : Math.max(4, genBox.top - 36);
        const stripLeft = Math.max(4, Math.min(genBox.left, overlayW - 420));
        const pad = Math.min(16, Math.max(8, Math.round(genBox.height * 0.08)));
        return (
        <>
          <div
            style={{
              position: "absolute",
              left: genBox.left,
              top: genBox.top,
              width: genBox.width,
              height: genBox.height,
              border: "2px solid var(--accent, #00c28a)",
              // A light wash of the accent, not dark glass (founder: "that
              // grey looks a little sad — use like a light version of the
              // green"). Near-opaque so ink stays legible over any page.
              background: "rgba(228, 247, 239, 0.94)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              borderRadius: 6,
              boxShadow: "0 8px 32px rgba(5, 8, 16, 0.18)",
              pointerEvents: "auto",
            }}
          >
            <textarea
              autoFocus
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (genPrompt.trim() && !busy) void submitGenerate();
                } else if (e.key === "Escape") {
                  cancelGenerate();
                }
              }}
              disabled={!!busy}
              aria-label={
                genKind === "image"
                  ? "Describe the image to generate"
                  : genKind === "icon"
                    ? "Describe the icon to generate"
                    : "Describe the element to generate"
              }
              placeholder={
                genKind === "image"
                  ? "Describe the image\u2026 e.g. aerial photo of a harbor at dusk"
                  : genKind === "icon"
                    ? "Name the icon\u2026 e.g. a shield with a checkmark"
                    : "What goes here? e.g. a KPI tile showing 3.2x"
              }
              className="h-full w-full resize-none bg-transparent outline-none placeholder:text-[#10141c]/40 disabled:opacity-60"
              style={{
                padding: pad,
                color: "#10141c",
                caretColor: "var(--accent, #00c28a)",
                fontSize: genBox.height < 70 ? 13 : 15,
                lineHeight: 1.45,
              }}
            />
          </div>
          <div
            style={{ position: "absolute", left: stripLeft, top: stripTop, pointerEvents: "auto", zIndex: 30 }}
            className="flex items-center gap-1.5"
          >
            {/* What to put in the box — an explicit switch, never inferred
                from the prompt. Element = LLM JSX; Image = diffusion photo;
                Icon = diffusion mark, background removed. */}
            <div
              role="group"
              aria-label="What to generate"
              className="flex items-center gap-0.5 rounded-full border border-white/10 bg-[#11141b]/95 p-0.5 shadow-lg"
            >
              {(["element", "image", "icon"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={genKind === k}
                  onClick={() => setGenKind(k)}
                  disabled={!!busy}
                  className={
                    "h-6 rounded-full px-2.5 text-[11px] font-medium capitalize transition-colors disabled:opacity-50 " +
                    (genKind === k ? "bg-accent text-accent-ink" : "text-white/70 hover:bg-white/10")
                  }
                >
                  {k}
                </button>
              ))}
            </div>
            {genKind !== "element" && (
              <button
                type="button"
                role="switch"
                aria-checked={matchStyle}
                aria-label={genKind === "icon" ? "Match my existing icons" : "Match my existing images"}
                onClick={() => setMatchStyle((v) => !v)}
                disabled={!!busy}
                title="New generations resemble the last one of this kind — same model, same seed, same look"
                className={
                  "h-7 whitespace-nowrap rounded-full border border-white/10 px-2.5 text-[11px] font-medium shadow-lg transition-colors disabled:opacity-50 " +
                  (matchStyle ? "bg-accent text-accent-ink" : "bg-[#11141b]/95 text-white/70 hover:bg-white/10")
                }
              >
                Match style
              </button>
            )}
            <button
              type="button"
              onClick={() => void submitGenerate()}
              disabled={!!busy || !genPrompt.trim()}
              className="flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[11.5px] font-semibold text-accent-ink shadow-lg transition-all hover:brightness-110 disabled:opacity-50"
            >
              {busy === "insert" ? (
                <>
                  <CrystalOrb /> Generating…
                </>
              ) : (
                <>Generate {"\u21B5"}</>
              )}
            </button>
            <button
              type="button"
              onClick={cancelGenerate}
              // NOT disabled while busy. Cancel is the one control that has to
              // work when everything else is stuck — disabling it during a
              // generate left a stalled request with no way out but a reload.
              className="h-7 rounded-full border border-white/10 bg-[#11141b]/95 px-2.5 text-[11px] font-medium text-white/70 shadow-lg hover:bg-white/10"
            >
              {busy === "insert" ? "Stop" : "Cancel"}
            </button>
          </div>
        </>
        );
      })()}
      {/* Top-right: undo + the x-ray toggle. Hidden when a shell toolbar owns
          these (hideToolbar); otherwise the strip holds ONLY controls. */}
      {!hideToolbar && (
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
            onClick={toggleOutlines}
            className={`${HIT} ${R_SM} px-2.5 text-[11px] font-medium ${showAll ? ACTIVE : CHROME}`}
          >
            {showAll ? "Hide outlines" : "Show all pieces"}
          </button>
        </div>
      )}

      {/* Guidance, bottom-centre — out of the way of both toolbars. */}
      {!hideToolbar && !selected && !editing && !tool && !genBox && !marquee && (
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
            <span className="absolute -top-[9px] left-1 rounded-[4px] bg-[#11141b]/90 px-1 font-mono text-[9px] leading-[1.4] text-white/70">{kindLabel(p.kind)}</span>
          </div>
        ))}

      {/* hover reveal (only when not selected) — labeled so what you'd select is explicit */}
      {hovered && !selected && !editing && !marquee && (
        <div style={{ position: "absolute", left: hovered.rect.left, top: hovered.rect.top, width: hovered.rect.width, height: hovered.rect.height, border: "1.5px solid var(--accent-line, rgba(0,194,138,0.42))", borderRadius: 8, pointerEvents: "none" }}>
          <span className="absolute -top-[10px] left-1 rounded-[4px] bg-[#11141b]/90 px-1.5 text-[9px] font-medium leading-[1.5] text-white/80">
            {kindLabel(hovered.kind)} · click to edit
          </span>
        </div>
      )}

      {box && selected && (
        <>
          <div
              ref={frameRef}
              // Stable hook: "something is selected, and it is this piece".
              // The QA suite needs to know that without inferring it from
              // styling (qa/editor.ts). getBoundingClientRect includes the
              // drag transform, so geometry assertions keep working.
              data-rb-selection={selected.pieceId}
            style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, border: "2px solid var(--accent, #00c28a)", borderRadius: 8, boxShadow: "0 0 0 9999px rgba(10,12,20,0.28)", pointerEvents: "none", transition: dragDelta || resizeBox || justDroppedRef.current ? "none" : "left 100ms, top 100ms" }}
          />
          <div
            onMouseDown={onDragStart}
            // The selected element must offer the SAME right-click menu as an
            // unselected one. This surface sits in the parent document, so the
            // iframe's contextmenu listener never hears it — without this,
            // right-clicking the element you just selected got Chrome's menu.
            onContextMenu={(e) => {
              e.preventDefault();
              if (busy || editing || !selected) return;
              const host = overlayRef.current?.getBoundingClientRect();
              if (!host) return;
              setMenu({ x: e.clientX - host.left, y: e.clientY - host.top, pieceId: selected.pieceId, kind: selected.kind });
            }}
            // Belt and braces: when the browser DOES emit a native dblclick here
            // it arrives after our own detection has already opened the session,
            // and openTextSessionAt is a no-op while `editing`.
            onDoubleClick={(e) => openTextSessionAt(e.clientX, e.clientY)}
            title="Drag to move · double-click to edit the text"
            style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, cursor: busy ? "wait" : "move", pointerEvents: "auto" }}
          />

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
                  onMouseDown={(e) => onResizeStart(e, dir, cursor)}
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
                    title="Text color"
                    aria-label="Text color"
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

      {sessionDead && (
        <div
          style={{ pointerEvents: "auto" }}
          className="absolute inset-0 z-[70] flex items-center justify-center bg-[#0b0d12]/55 backdrop-blur-[2px]"
        >
          <div className="max-w-[380px] rounded-xl border border-hairline bg-surface p-6 text-center shadow-[0_30px_80px_-40px_rgba(18,26,43,0.6)]">
            <p className="text-[14.5px] font-semibold text-ink">Your session expired</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Nothing was lost — your document is saved. Sign back in to keep
              editing.
            </p>
            <a
              href={`/sign-in?redirect_url=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/documents")}`}
              className="mt-4 inline-block rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110"
            >
              Sign in
            </a>
          </div>
        </div>
      )}
      {error && (
        <div
          style={{ pointerEvents: "auto", cursor: "pointer" }}
          title="Dismiss"
          onClick={() => setError(null)}
          className={`absolute bottom-12 left-1/2 -translate-x-1/2 ${R_SM} bg-red-600/90 px-3 py-1.5 text-[11px] text-white`}
        >
          {error}
        </div>
      )}
    </div>
  );
});
