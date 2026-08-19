/**
 * Render-truth measurement primitive.
 *
 * The whole quality system pivots on this: instead of static-analyzing the
 * generated CODE (which can't see flex/content overflow, computed contrast, or
 * transforms), we render each scene in a REAL browser and measure what actually
 * paints. Every defect that ships (clipped text, light-on-light logos, dead
 * regions) is a property of the rendered output, not the source — so we measure
 * the output.
 *
 * How:
 *   1. Bundle + eval the genDir's Composition.tsx and grab Section{N} — the
 *      EXACT path ssr-render.ts's gate uses, so "renders here" == "renders in
 *      the preview/MP4".
 *   2. renderToStaticMarkup(Section, { script }) → the scene's real DOM.
 *   3. Load it in headless Chromium (Playwright) at 1920×1080, with every CSS
 *      animation jumped to its settled END state via a `animation-delay:
 *      -100000s !important` override (fill-mode forwards/both → final frame).
 *      This matches what the SectionClock pins for the MP4's late frames,
 *      without needing the Remotion clock.
 *   4. page.evaluate → every element's getBoundingClientRect + computed colors.
 *   5. screenshot the frame (for the deterministic contrast/dead-region checks
 *      and the vision gate).
 *
 * Deliberately uses Playwright (stable, documented page API) over Remotion's
 * internal puppeteer fork (newPage needs internal types; screenshot lives behind
 * a deep dist import the package `exports` map can block). Boring-by-default for
 * a load-bearing primitive.
 *
 * Best-effort + fail-closed: a browser/load error returns { error } for that
 * scene (the gate treats a measurement error as a gate failure, never silent).
 */
import { promises as fs } from "fs";
import path from "path";
import { FIT_TEXT_SCRIPT, textFitEnabled } from "./fit-text";
import { createRequire } from "module";
import React from "react";
import * as esbuild from "esbuild";
import { sandboxedRequire, shadowedFunctionArgs, shadowedValues } from "./code-guard";

// Same externals the SSR gate uses — peer deps resolve at runtime; only the
// local TS (Composition + ./Img/./BrandChrome shims) bundles.
const EXTERNALS = [
  "react",
  "react-dom",
  "react-dom/server",
  "recharts",
  "lucide-react",
  "shiki",
  "simple-icons",
  "simple-icons/icons",
  "remotion",
  "@remotion/lottie",
];

const nodeRequire: NodeRequire = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return eval("require") as NodeRequire;
  } catch {
    return createRequire(path.join(process.cwd(), "package.json"));
  }
})();

const { renderToStaticMarkup } = nodeRequire("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

/**
 * ONE warm Chromium per process (speed playbook 2026-08-18). Every measure
 * pass used to launch and close its own browser — a 400-600ms tax per pass,
 * multiplied by every gate-retry round of every build. Pool practice from
 * the capture-at-scale literature: keep the browser, hand out fresh pages,
 * RECYCLE after ~80 passes (held-forever Chromium accumulates leaked memory
 * and stale GPU state). On globalThis for the Next dev multi-instance
 * reason (lib/db.ts). The type is `unknown` because playwright itself is
 * dynamically imported below.
 */
const globalForBrowser = globalThis as unknown as {
  __rbMeasureBrowser?: { browser: { isConnected(): boolean; close(): Promise<void> } | null; uses: number };
};
const warmState = (globalForBrowser.__rbMeasureBrowser ??= { browser: null, uses: 0 });
const WARM_BROWSER_MAX_USES = 80;

export interface MeasuredElement {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Computed text color, rgb() string. */
  color: string;
  /** Computed own background-color, rgb()/rgba() string. */
  bg: string;
  /** Trimmed direct text (first ~60 chars), empty if the element has no own text. */
  text: string;
  isImg: boolean;
  src?: string;
  /** <img> only: the DECODED intrinsic width. 0 = the image failed to load/
   *  decode (renders as the broken-image glyph) — the v12 broken-image swap
   *  keys off this. Undefined for non-imgs and for older fixtures. */
  imgNaturalWidth?: number;
  fontSize: number;
  opacity: number;
  /** Enclosing LEGO piece id (closest [data-piece]), "" when outside any piece. */
  piece: string;
  /** The enclosing piece's kind (data-kind: text/diegetic/image/atmosphere/chrome),
   *  "" when outside any piece. Optional so hand-built test fixtures stay small. */
  pieceKind?: string;
  /** True when an ancestor WITHIN the same piece paints an opaque background or
   *  gradient under this element (text on its own card/scrim — intentional). */
  onOpaqueSurface: boolean;
  /** True when elementFromPoint at this element's center hits a NON-related
   *  element — i.e. something else is stacked ON TOP of it (the clipped-by-mock
   *  signal; text that is visibly on top reports false). */
  coveredAtCenter: boolean;
  /** data-content-path on the element, an ancestor, or (for fit boxes) a descendant. */
  contentPath?: string;
  /** Residual fullness when the fit runtime hit its floor on this box (>1 = overfull). */
  fitFloor?: number;
  /** Computed border-top-left-radius in px (0 = square). Optional: older
   *  fixtures predate it. v13 — the skeleton-bar detector keys on rounding. */
  radius?: number;
  /** Index (into this scene's elements array) of the nearest RECORDED ancestor,
   *  -1 at the top. Optional: older fixtures predate it. v13 — sibling
   *  grouping for the skeleton-bar detector. */
  parentIx?: number;
  /** True when the subtree carries ANY text (own or descendants'). Optional:
   *  older fixtures predate it. */
  hasTextDesc?: boolean;
  /** True when the element paints a background-image/gradient (computed
   *  backgroundColor alone is transparent for gradients). Optional. */
  hasBgImage?: boolean;
  /** v15 — VISIBLE rect: the layout rect intersected with every clipping
   *  ancestor's box (overflow hidden/clip/auto/scroll, incl. #rb-stage). A
   *  layout box extending past an overflow-hidden panel reports its painted
   *  extent here (getBoundingClientRect alone reports PHANTOM layout — the
   *  cycle-6 s0 hero panel measured 822px wide while only 400px painted).
   *  Optional: older fixtures predate it. */
  vx?: number;
  vy?: number;
  vw?: number;
  vh?: number;
  /** v16 — boundary treatment. A panel can be VISIBLE against a same-tone
   *  canvas through its edge (hairline border / drop shadow) with no interior
   *  tonal spread at all — the standard light-SaaS card idiom. The washout
   *  detector's edge-evidence arm keys on these. Optional: older fixtures
   *  predate them. */
  borderTopWidth?: number;
  /** Computed border-top-color, rgb()/rgba() string. */
  borderColor?: string;
  /** Computed box-shadow ("none" when absent). */
  boxShadow?: string;
}

/** A rect in canvas px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Per-EDGE spill of a piece's painted content past its DECLARED box, in px.
 * Positive = content painted outside that edge. All four are ≥0; `maxPx` is the
 * worst single edge, which is the number worth alerting on.
 */
export interface BoxOverflow {
  top: number;
  right: number;
  bottom: number;
  left: number;
  maxPx: number;
}

/**
 * ONE LEGO piece's authored-vs-painted truth, the unit the persisted rect file
 * exists to make queryable offline.
 *
 * `declared` is read from the wrapper's OWN inline style — assemble.ts emits
 * `left/top/width/height` literally on every non-atmosphere `[data-piece]`
 * wrapper, so the declared box is present in the DOM and needs no plumbing from
 * the composer. That is what makes this record self-contained: any caller of
 * measureScenes gets it, with no threading of plan bounds through the stack.
 */
export interface PieceRect {
  /** data-piece — the LEGO piece id ("s2.hero"). */
  id: string;
  /** data-kind — text | diegetic | image | atmosphere | chrome. */
  kind: string;
  /** data-throughline slug, when this piece carries the recurring motif. */
  throughline?: string;
  /**
   * The box the piece DECLARED, in STAGE coordinates. Size comes from the
   * wrapper's inline `width`/`height` (or `data-box-h` for text pieces, which
   * emit no CSS height); ORIGIN comes from the wrapper's measured rect, not
   * from the inline `left`/`top`. That distinction is load-bearing: a NESTED
   * child piece declares left/top relative to its parent, so comparing raw
   * inline coordinates against a stage-absolute painted rect manufactured a
   * false 1160px "overflow" on a real build (cycle10-falabella s0). The browser
   * has already resolved the origin correctly — use its answer.
   *
   * null for a full-bleed atmosphere wrapper (inset:0 — nothing to exceed).
   */
  declared: Rect | null;
  /**
   * False when the piece declares no height of its own — today every TEXT piece
   * without `data-box-h`, and the whole point of Bug 2's text arm. A reader can
   * tell "inside its box" from "had no bottom edge to be outside of".
   */
  heightDeclared: boolean;
  /** The wrapper element's own measured getBoundingClientRect. */
  wrapper: Rect;
  /** Union of every descendant's VISIBLE rect (layout rect ∩ clipping
   *  ancestors) — what the piece actually PAINTS, which is the thing a declared
   *  height was supposed to bound and today does not. */
  painted: Rect;
  /** painted vs declared, per edge. null when `declared` is null. */
  overflow: BoxOverflow | null;
  /** Descendant elements measured into `painted` (0 ⇒ an empty piece). */
  nodes: number;
}

/**
 * The on-disk record written next to the frames as `rects-scene-{N}.json`.
 * Versioned so a future reader can tell which fields to expect.
 */
export interface SceneRects {
  version: 1;
  scene: number;
  width: number;
  height: number;
  aspect: string;
  measuredAt: string;
  pieces: PieceRect[];
  /** The full element walk, verbatim — the raw material for any future
   *  offline query we have not thought of yet. */
  elements: MeasuredElement[];
}

export interface SceneMeasurement {
  scene: number;
  width: number;
  height: number;
  elements: MeasuredElement[];
  /** Per-piece authored-vs-painted rects (also persisted to disk). */
  pieces?: PieceRect[];
  /** Absolute path to the rendered PNG, or undefined if screenshot failed. */
  screenshotPath?: string;
  /** Absolute path to the persisted `rects-scene-{N}.json`, when written. */
  rectsPath?: string;
  /** What the render-time text-fit pass did on this scene (fit-text.ts) —
   *  candidates found overfull, boxes fitted, boxes that hit the readability
   *  floor and stayed marked. The floor count is the live signal for the
   *  semantic shorten path (docs/TEXT_FIT.md layer 3). */
  fit?: { candidates: number; fitted: number; floored: number };
  /** The exact browser that produced these rects (e.g. "HeadlessChrome/140…").
   *  Recorded because chromium binary DRIFT is the leading suspect for the
   *  prod-only phantom findings — the deploy's `playwright install chromium
   *  || true` can silently leave an older browser in place, and text metrics
   *  differ across major versions. Same string on every scene of a run. */
  browserVersion?: string;
  /**
   * MEASUREMENT TRUST (2026-08-14). A production ladder exhausted on a deck
   * whose stored bytes measure clean on macOS AND in the exact playwright
   * Linux image, fonts loading or deliberately broken — so a prod-side
   * measurement produced findings no reachable environment reproduces, and
   * repairs were bought against them. The measurement now DECLARES the
   * conditions under which its text metrics can be trusted:
   *   fontFailures — declared brand families document.fonts reports unloaded
   *                  at walk time (fallback metrics were in effect);
   *   fitSettled   — false when the walk proceeded past the bounded wait
   *                  with the fit pass unfinished (mid-fit geometry).
   * Text-metric-dependent findings on an untrusted scene are advisory, never
   * blocking — a claim the gates enforce, not the callers.
   */
  fontFailures?: string[];
  fitSettled?: boolean;
  /** Set when the scene could not be measured at all (treat as a gate failure). */
  error?: string;
}

export const CANVAS_DIMS: Record<string, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

// The DOM-walk runs INSIDE the browser page (serialized by Playwright). Keep it
// dependency-free and self-contained.
const PAGE_WALK = `(() => {
  const out = [];
  const recordedIx = new Map();
  const alphaOf = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
    if (!m) return 0;
    const p = m[1].split(",").map((v) => parseFloat(v.trim()));
    return p.length >= 4 ? (isNaN(p[3]) ? 1 : p[3]) : 1;
  };
  const els = document.querySelectorAll("*");
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    // direct text only (not descendants') so a wrapper isn't credited with child copy
    let text = "";
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
    text = text.replace(/\\s+/g, " ").trim().slice(0, 60);
    // LEGO piece ancestry + whether an ancestor INSIDE the same piece paints an
    // opaque surface under this element (text on its own card = intentional).
    // Gradients count: computed backgroundColor is transparent for them, but a
    // gradient-backed card is every bit a surface (Arc's overlay card).
    const pieceEl = el.closest ? el.closest("[data-piece]") : null;
    const piece = pieceEl ? pieceEl.getAttribute("data-piece") || "" : "";
    const pieceKind = pieceEl ? pieceEl.getAttribute("data-kind") || "" : "";
    let onOpaqueSurface = false;
    for (let a = el.parentElement; a && pieceEl && pieceEl.contains(a); a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (alphaOf(acs.backgroundColor) >= 0.5 || (acs.backgroundImage && acs.backgroundImage !== "none")) {
        onOpaqueSurface = true;
        break;
      }
      if (a === pieceEl) break;
    }
    // Stacking truth: is something unrelated painted ON TOP of this element's
    // center? (elementFromPoint sees the topmost hit-testable element — the
    // clipped-by-a-mock case; an element visibly on top reports false.)
    let coveredAtCenter = false;
    try {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
        const hit = document.elementFromPoint(cx, cy);
        coveredAtCenter = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
      }
    } catch (e) {}
    // Nearest RECORDED ancestor (skipped ancestors — 0x0, display:none — are
    // walked through so sibling grouping survives them).
    let parentIx = -1;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (recordedIx.has(p)) { parentIx = recordedIx.get(p); break; }
    }
    // v15 — VISIBLE rect: intersect the layout rect with every clipping
    // ancestor (overflow hidden/clip/auto/scroll). Layout boxes that extend
    // past an overflow-hidden panel otherwise report phantom extents.
    let vx0 = r.x, vy0 = r.y, vx1 = r.x + r.width, vy1 = r.y + r.height;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (/(hidden|clip|auto|scroll)/.test(acs.overflow + " " + acs.overflowX + " " + acs.overflowY)) {
        const ar = a.getBoundingClientRect();
        vx0 = Math.max(vx0, ar.x); vy0 = Math.max(vy0, ar.y);
        vx1 = Math.min(vx1, ar.x + ar.width); vy1 = Math.min(vy1, ar.y + ar.height);
      }
    }
    recordedIx.set(el, out.length);
    out.push({
      tag: el.tagName.toLowerCase(),
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      color: cs.color,
      bg: cs.backgroundColor,
      text,
      // Semantic-shorten wiring (TEXT_FIT layer 3): which script field this
      // box shows, and how overfull the fit runtime left it. The path is
      // looked up on the element, then up (a span inside the fitted box),
      // then down (the fitted box wrapping the bound span).
      //
      // PLAIN JAVASCRIPT ONLY in this walker: it reaches page.evaluate as
      // RAW SOURCE, so a TypeScript cast here is a SyntaxError in the
      // browser and every scene reports measure-error — which is a
      // hard-failed build. Caught by the witness build minutes after the
      // typed version shipped; tsc cannot see this class at all.
      contentPath: (function () {
        var own = el.getAttribute("data-content-path");
        if (own) return own;
        var up = el.closest("[data-content-path]");
        if (up) return up.getAttribute("data-content-path") || undefined;
        var down = el.querySelector("[data-content-path]");
        if (down) return down.getAttribute("data-content-path") || undefined;
        return undefined;
      })(),
      fitFloor: (function () {
        var f = parseFloat(el.getAttribute("data-rb-fit-floor") || "");
        return isFinite(f) && f > 1.02 ? f : undefined;
      })(),
      isImg: el.tagName === "IMG",
      src: el.tagName === "IMG" ? el.getAttribute("src") || undefined : undefined,
      imgNaturalWidth: el.tagName === "IMG" ? (typeof el.naturalWidth === "number" ? el.naturalWidth : 0) : undefined,
      fontSize: parseFloat(cs.fontSize) || 0,
      opacity: parseFloat(cs.opacity),
      piece,
      pieceKind,
      onOpaqueSurface,
      coveredAtCenter,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      parentIx,
      hasTextDesc: ((el.textContent || "").trim().length > 0),
      hasBgImage: !!(cs.backgroundImage && cs.backgroundImage !== "none"),
      vx: Math.round(vx0), vy: Math.round(vy0),
      vw: Math.round(Math.max(0, vx1 - vx0)), vh: Math.round(Math.max(0, vy1 - vy0)),
      borderTopWidth: parseFloat(cs.borderTopWidth) || 0,
      borderColor: cs.borderTopColor,
      boxShadow: cs.boxShadow,
    });
  }
  return out;
})()`;

/**
 * Per-PIECE walk — authored box vs painted extent, for every `[data-piece]`
 * wrapper. Runs in the page alongside PAGE_WALK (kept separate so the element
 * walk's shape, which several gates parse, is untouched).
 *
 * `declared` comes from the wrapper's own INLINE style rather than a computed
 * one: assemble.ts writes literal px there, and reading the inline value keeps
 * "what the composer declared" distinct from "what the browser resolved" —
 * which is the exact comparison this record exists to make.
 */
const PIECE_WALK = `(() => {
  const px = (v) => {
    if (!v) return null;
    const m = /^(-?[\\d.]+)px$/.exec(String(v).trim());
    return m ? Math.round(parseFloat(m[1])) : null;
  };
  const stage = document.getElementById("rb-stage");
  const origin = stage ? stage.getBoundingClientRect() : { x: 0, y: 0 };
  const out = [];
  for (const el of document.querySelectorAll("[data-piece]")) {
    // EVERY piece appears TWICE in the DOM: the <Piece> shim marker (which the
    // LEGO decomposer keys on) renders its own data-piece div at
    // display:contents, wrapping the real positioned one. A contents box
    // generates no layout at all, so its rect is meaningless and it declares
    // nothing — recording it would double every piece in the file and pair a
    // null declared box with a real painted one. Skip it; the positioned
    // wrapper inside is the piece.
    if (getComputedStyle(el).display === "contents") continue;
    const s = el.style || {};
    const wr = el.getBoundingClientRect();
    const wrapper = {
      x: Math.round(wr.x - origin.x), y: Math.round(wr.y - origin.y),
      w: Math.round(wr.width), h: Math.round(wr.height),
    };
    // Size from the inline declaration; ORIGIN from the resolved rect (a nested
    // child's inline left/top are parent-relative — see PieceRect.declared).
    const W = px(s.width);
    const boxH = el.getAttribute("data-box-h");
    const H = px(s.height) ?? px(s.maxHeight) ?? (boxH !== null && boxH !== "" && isFinite(Number(boxH)) ? Math.round(Number(boxH)) : null);
    const heightDeclared = H !== null;
    const declared = W !== null ? { x: wrapper.x, y: wrapper.y, w: W, h: H !== null ? H : wrapper.h } : null;
    // Painted extent = union of every descendant's VISIBLE rect (layout rect
    // intersected with each clipping ancestor), same clipping model PAGE_WALK
    // uses so the two records agree.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, nodes = 0;
    for (const d of el.querySelectorAll("*")) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(d);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
      let vx0 = r.x, vy0 = r.y, vx1 = r.x + r.width, vy1 = r.y + r.height;
      for (let a = d.parentElement; a; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (/(hidden|clip|auto|scroll)/.test(acs.overflow + " " + acs.overflowX + " " + acs.overflowY)) {
          const ar = a.getBoundingClientRect();
          vx0 = Math.max(vx0, ar.x); vy0 = Math.max(vy0, ar.y);
          vx1 = Math.min(vx1, ar.x + ar.width); vy1 = Math.min(vy1, ar.y + ar.height);
        }
      }
      if (vx1 <= vx0 || vy1 <= vy0) continue; // fully clipped away
      x0 = Math.min(x0, vx0); y0 = Math.min(y0, vy0);
      x1 = Math.max(x1, vx1); y1 = Math.max(y1, vy1);
      nodes++;
    }
    const painted = nodes > 0
      ? { x: Math.round(x0 - origin.x), y: Math.round(y0 - origin.y), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
      : wrapper;
    let overflow = null;
    if (declared) {
      const top = Math.max(0, declared.y - painted.y);
      const left = Math.max(0, declared.x - painted.x);
      const right = Math.max(0, (painted.x + painted.w) - (declared.x + declared.w));
      const bottom = Math.max(0, (painted.y + painted.h) - (declared.y + declared.h));
      overflow = { top, right, bottom, left, maxPx: Math.max(top, right, bottom, left) };
    }
    const through = el.getAttribute("data-throughline");
    out.push({
      id: el.getAttribute("data-piece") || "",
      kind: el.getAttribute("data-kind") || "",
      ...(through ? { throughline: through } : {}),
      declared, heightDeclared, wrapper, painted, overflow, nodes,
    });
  }
  return out;
})()`;

/**
 * Roll the per-piece overflow up into one greppable telemetry line: how many
 * pieces painted beyond their declared box, and by how much. Pure — the caller
 * decides where to log it.
 */
export const summarizeBoxOverflow = (
  measurements: Pick<SceneMeasurement, "scene" | "pieces">[],
): {
  pieces: number;
  overflowing: number;
  totalPx: number;
  noHeight: number;
  worst: { pieceId: string; scene: number; maxPx: number } | null;
  line: string;
} => {
  let pieces = 0;
  let overflowing = 0;
  let totalPx = 0;
  let noHeight = 0;
  let worst: { pieceId: string; scene: number; maxPx: number } | null = null;
  const byKind = new Map<string, number>();
  for (const m of measurements) {
    for (const p of m.pieces ?? []) {
      if (!p.overflow) continue;
      pieces++;
      if (!p.heightDeclared) noHeight++;
      if (p.overflow.maxPx <= 0) continue;
      overflowing++;
      totalPx += p.overflow.maxPx;
      byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
      if (!worst || p.overflow.maxPx > worst.maxPx) {
        worst = { pieceId: p.id, scene: m.scene, maxPx: p.overflow.maxPx };
      }
    }
  }
  const kinds = [...byKind.entries()].map(([k, n]) => `${k}:${n}`).join(", ");
  const line =
    `box-overflow: ${overflowing}/${pieces} piece(s) painted beyond their declared box` +
    (kinds ? ` [${kinds}]` : "") +
    (overflowing ? ` · ${totalPx}px total spill` : "") +
    (worst ? ` · worst ${worst.pieceId} (s${worst.scene}) +${worst.maxPx}px` : "") +
    (noHeight ? ` · ${noHeight} piece(s) declare no height (bottom edge unenforceable)` : "");
  return { pieces, overflowing, totalPx, noHeight, worst, line };
};

const buildSceneHtml = (
  bodyHtml: string,
  fonts: { family?: string; src?: string }[],
  dims: { w: number; h: number },
): string => {
  // @font-face for any captured brand font so text measures at real metrics.
  const faces = fonts
    .filter((f) => f.family && f.src)
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";src:url("${f.src}");font-display:block;}`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;}
    ${faces}
    /* Jump every animation to its settled END state (fill-mode forwards/both
       → final frame). !important longhand beats the inline shorthand's delay. */
    *,*::before,*::after{animation-delay:-100000s !important;}
    #rb-stage{position:relative;width:${dims.w}px;height:${dims.h}px;overflow:hidden;}
  </style></head><body>
    <div id="rb-stage">${bodyHtml}</div>
    ${textFitEnabled() ? `<script>${FIT_TEXT_SCRIPT}</script>` : ""}
  </body></html>`;
};

/**
 * Measure every scene of a written genDir in a real browser. Returns one entry
 * per scene with measured element rects/colors + a screenshot path. Screenshots
 * are written to `${outDir}/measure-scene-${i}.png`.
 */
export const measureScenes = async (
  genDir: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: any,
  outDir: string,
  opts: {
    /** Screenshots are the expensive half of a pass (GPU readback + PNG
     *  encode per scene) and only passes feeding PIXEL gates (contrast,
     *  washout, vision) need them. Rect-only callers — the semantic-shorten
     *  pre-measure — pass false. Default true: every existing caller keeps
     *  its pixels. */
    screenshots?: boolean;
  } = {},
): Promise<SceneMeasurement[]> => {
  const wantShots = opts.screenshots !== false;
  const sceneCount: number = Array.isArray(script?.scenes) ? script.scenes.length : 0;
  const aspect: string = script?.config?.aspect_ratio || "16:9";
  const dims = CANVAS_DIMS[aspect] || CANVAS_DIMS["16:9"];
  const fonts: { family?: string; src?: string }[] = Array.isArray(script?.assets?.fonts)
    ? script.assets.fonts
    : [];

  // ── bundle + eval the composition (same pattern as ssr-render.ts) ──────────
  const compPath = path.join(genDir, "Composition.tsx");
  let mod: Record<string, unknown>;
  try {
    const result = await esbuild.build({
      entryPoints: [compPath],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      jsx: "automatic",
      write: false,
      external: EXTERNALS,
      logLevel: "silent",
    });
    const bundle = result.outputFiles[0].text;
    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(...shadowedFunctionArgs(), bundle)(
      moduleObj,
      moduleObj.exports,
      sandboxedRequire(nodeRequire),
      ...shadowedValues(),
    );
    mod = moduleObj.exports;
  } catch (err) {
    const error = `compile/eval: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    return Array.from({ length: sceneCount }, (_, i) => ({
      scene: i,
      width: dims.w,
      height: dims.h,
      elements: [],
      error,
    }));
  }

  // ── render each Section to HTML up front (Node side) ───────────────────────
  const htmls: (string | null)[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const Section = [`Section${i}`, `Scene${i}Slide`, `Scene${i}`, `Slide${i}`]
      .map((n) => mod[n])
      .find((f) => typeof f === "function") as
      | React.ComponentType<{ script: unknown }>
      | undefined;
    if (!Section) {
      htmls.push(null);
      continue;
    }
    try {
      htmls.push(renderToStaticMarkup(React.createElement(Section, { script })));
    } catch {
      htmls.push(null);
    }
  }

  await fs.mkdir(outDir, { recursive: true });

  // ── load each in a real browser, measure + screenshot ─────────────────────
  // Playwright is a dev/runtime dep; dynamic-import so a missing browser fails
  // closed per-scene rather than crashing module load.
  let chromium: typeof import("playwright").chromium;
  try {
    // CJS/ESM interop: `chromium` is normally on the namespace, but under Next
    // dev a hot-recompile (e.g. a commit landing mid-build, which is what broke
    // loop iteration 2) can re-wrap the CJS module so the export lands under
    // `.default` instead — the bare `({ chromium } = ...)` destructure then
    // yielded `undefined` and `chromium.launch` crashed with "Cannot read
    // properties of undefined (reading 'launch')". Resolve BOTH shapes, and fail
    // loudly (→ "playwright unavailable" measure-error) if truly absent.
    const pw = (await import("playwright")) as unknown as {
      chromium?: typeof import("playwright").chromium;
      default?: { chromium?: typeof import("playwright").chromium };
    };
    const resolved = pw.chromium ?? pw.default?.chromium;
    if (!resolved) {
      throw new Error("playwright loaded but its `chromium` export is undefined (module interop)");
    }
    chromium = resolved;
  } catch (err) {
    const error = `playwright unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return Array.from({ length: sceneCount }, (_, i) => ({
      scene: i, width: dims.w, height: dims.h, elements: [], error,
    }));
  }

  // The PACKAGE import above succeeds whenever node_modules is present; what is
  // typically missing is the chromium BINARY (no `playwright install`). That
  // surfaces HERE, at launch — so it must be inside its own try, or it throws
  // uncaught out of measureScenes and the build route 500s instead of returning
  // the documented per-scene measure-error that fail-closes to a 422.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    const held = warmState.browser as Awaited<ReturnType<typeof chromium.launch>> | null;
    if (held?.isConnected() && warmState.uses < WARM_BROWSER_MAX_USES) {
      warmState.uses += 1;
      browser = held;
    } else {
      if (held?.isConnected()) void held.close().catch(() => {});
      browser = await chromium.launch({ args: ["--no-sandbox"] });
      warmState.browser = browser;
      warmState.uses = 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    const error = /executable doesn'?t exist|please run|install/i.test(msg)
      ? `playwright chromium not installed — run: npx playwright install chromium (${msg})`
      : `browser launch failed: ${msg}`;
    return Array.from({ length: sceneCount }, (_, i) => ({
      scene: i, width: dims.w, height: dims.h, elements: [], error,
    }));
  }
  const results: SceneMeasurement[] = [];
  let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;
  try {
    page = await browser.newPage({
      viewport: { width: dims.w, height: dims.h },
      deviceScaleFactor: 1,
    });
    for (let i = 0; i < sceneCount; i++) {
      const bodyHtml = htmls[i];
      if (bodyHtml == null) {
        results.push({ scene: i, width: dims.w, height: dims.h, elements: [], error: `no Section${i} / render failed` });
        continue;
      }
      try {
        const html = buildSceneHtml(bodyHtml, fonts, dims);
        // `networkidle` waits on the brand's REMOTE fonts/images, an unbounded
        // flakiness source for what is now a BLOCKING gate. Retry once on the
        // more lenient `load` so a transient remote stall doesn't hard-fail a
        // build; a genuinely-broken scene still errors on both attempts.
        try {
          await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
        } catch {
          await page.setContent(html, { waitUntil: "load", timeout: 30000 });
        }
        // fonts loaded + a beat for layout to settle
        await page.evaluate("document.fonts && document.fonts.ready").catch(() => {});
        // The fit pass (fit-text.ts) runs after fonts settle and rewrites text
        // geometry; measuring before it finishes would gate a page nobody will
        // ever see. Bounded so a broken page cannot hang the gate.
        await page
          .waitForFunction("!window.__rbFitDone || window.__rbFitSummary", { timeout: 5000 })
          .catch(() => {});
        await page.evaluate("window.__rbFitDone").catch(() => {});
        // SETTLE entry animations to their FINAL state before measuring AND
        // screenshotting. setContent renders at t=0, so without this we captured
        // an EARLY frame — diegetic elements (cards, terminals, mock UIs, charts)
        // were still animating in (opacity 0 / off-screen). That caused (a) the
        // render-truth gate to see false OFF-CANVAS (elements mid slide-in),
        // triggering the expensive repair ladder, and (b) the advisory vision
        // gate to judge scenes as "wall-of-type, no diegetic element" (the
        // over-flagging seen on Linear/Duolingo/Vercel). finish() jumps finite
        // entry animations to their end; infinite ambient ones throw → skipped.
        await page
          .evaluate(
            "try{(document.getAnimations?document.getAnimations():[]).forEach(function(a){try{a.finish()}catch(e){}})}catch(e){}",
          )
          .catch(() => {});
        await page.waitForTimeout(250).catch(() => {});
        const fitSummary = (await page
          .evaluate("window.__rbFitSummary || null")
          .catch(() => null)) as { candidates: number; fitted: number; floored: number } | null;
        // Trust markers: which declared families never loaded, and whether
        // the fit pass had actually finished before this walk.
        const declaredFamilies = fonts.map((f) => f.family).filter((f): f is string => !!f);
        const fontFailures = (await page
          .evaluate(
            `(function(fams){try{if(!document.fonts||!document.fonts.check)return [];var out=[];for(var i=0;i<fams.length;i++){try{if(!document.fonts.check('16px "'+fams[i]+'"'))out.push(fams[i]);}catch(e){}}return out;}catch(e){return []}})(${JSON.stringify(declaredFamilies)})`,
          )
          .catch(() => [])) as string[];
        const fitSettled = fitSummary !== null || !(await page
          .evaluate("typeof window.__rbFitDone !== 'undefined'")
          .catch(() => false));
        const elements = (await page.evaluate(PAGE_WALK)) as MeasuredElement[];
        // Per-piece authored-vs-painted rects. Best-effort: a failure here must
        // never fail a measurement the BLOCKING gates depend on.
        let pieces: PieceRect[] = [];
        try {
          pieces = (await page.evaluate(PIECE_WALK)) as PieceRect[];
        } catch {
          pieces = [];
        }
        const screenshotPath = wantShots ? path.join(outDir, `measure-scene-${i}.png`) : undefined;
        if (screenshotPath) {
          await page.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
        }
        // PERSIST the rects. getBoundingClientRect was computed on every build
        // and then thrown away, so "what did this build actually paint, versus
        // what did it declare?" was unanswerable after the fact. Writing it
        // next to the frames turns that into a $0 offline query, forever.
        let rectsPath: string | undefined;
        try {
          rectsPath = path.join(outDir, `rects-scene-${i}.json`);
          const record: SceneRects = {
            version: 1,
            scene: i,
            width: dims.w,
            height: dims.h,
            aspect,
            measuredAt: new Date().toISOString(),
            pieces,
            elements,
          };
          await fs.writeFile(rectsPath, JSON.stringify(record));
        } catch {
          rectsPath = undefined; // disk trouble must not fail the gate
        }
        results.push({
          scene: i,
          width: dims.w,
          height: dims.h,
          elements,
          pieces,
          screenshotPath,
          rectsPath,
          browserVersion: browser.version(),
          ...(fitSummary ? { fit: fitSummary } : {}),
          ...(fontFailures.length > 0 ? { fontFailures } : {}),
          fitSettled,
        });
      } catch (err) {
        results.push({
          scene: i, width: dims.w, height: dims.h, elements: [],
          error: `measure: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        });
      }
    }
  } finally {
    // The page must close now that the browser survives the pass — it was
    // previously torn down implicitly by browser.close(), and a leaked page
    // per pass would grow the shared browser until the recycle.
    if (page) await page.close().catch(() => {});
    // Shared warm browser: pages are closed per pass, the BROWSER stays for
    // the next one (launch was 400-600ms x every gate-retry round). Recycled
    // by the launch block above after {WARM_BROWSER_MAX_USES}-ish uses.
  }
  return results;
};
