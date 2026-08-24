/**
 * The deterministic assembler — the keystone of the component/LEGO engine.
 *
 * Input: a frozen Theme + per-scene SceneManifests (the nestable piece tree) + a
 * resolver that returns each piece's inlinable JSX body. Output: the EXACT
 * `Composition.tsx` contract every existing consumer already renders identically
 * (mapped precisely from the contract spec — see project memory
 * [[project_lego_component_pivot]]):
 *
 *   import React / ./Img / ./BrandChrome  →  inline Script interface  →  module
 *   consts (palette + fonts + BRAND_FONTS_CSS + SHARED_KEYFRAMES + GRAIN +
 *   SECTION_FRAME)  →  helpers (Chrome, lastWordAccent)  →  one `export const
 *   Section{K}` per scene (each carrying its OWN `<style>` with BRAND_FONTS_CSS +
 *   SHARED_KEYFRAMES so it animates when measured/previewed STANDALONE), with each
 *   piece INLINED into a positioned wrapper  →  `export const Generated`.
 *
 * CRITICAL CONTRACT POINTS the assembler honors (or pixel-equivalence breaks):
 *  - Pieces are INLINED (not imported) so the finalize regexes (injectLogoSrc,
 *    inlineFontFaces, repairBrokenImages, lucide repair) — which scan the
 *    Composition STRING — see every logo/font/image URL. The per-file pieces stay
 *    the editable source; this re-inlines them on every build.
 *  - Each Section re-injects `<style>{BRAND_FONTS_CSS + SHARED_KEYFRAMES}</style>`
 *    (NOT deduped) — a Section is mounted alone by preview SSR + measure-scene.
 *  - LOGO_SRC is NOT emitted; Chrome references it so injectLogoSrc injects it.
 *  - Sections are named exactly `Section{i}` (pickSection looks for that first).
 *  - Throughline pieces get `data-throughline` AND literal px left/top CO-LOCATED
 *    on the same wrapper div, so assessContinuity/Presence still see them.
 *  - EVERY emitted piece wrapper carries `data-piece` + `data-kind` (attribute
 *    names mirror the Piece shim in build-wrapper.ts exactly) — measure-scene's
 *    PAGE_WALK resolves each element to closest('[data-piece]') and reads
 *    data-kind, and the BLOCKING render-truth gates (findCrossPieceOverlap,
 *    findStrandedHero) key off those measured piece/pieceKind fields. Without
 *    the attributes those gates silently fail OPEN on assembled output.
 *  - Piece-LOCAL `@keyframes` are namespaced per piece (pulse → s0_a_pulse) so
 *    two pieces' same-named local keyframes can't last-write-win across pieces
 *    once Generated mounts every Section into one document. SHARED_KEYFRAMES
 *    names are NEVER renamed — they are shared by design and every piece
 *    references them by the shared name.
 *  - All animation is CSS `@keyframes` (in SHARED_KEYFRAMES) so SectionClock's
 *    getAnimations() can pin it for the MP4. No Remotion hooks inside a piece.
 */
import type { Theme, SceneManifest, Piece } from "../edit/piece-model";

/** Resolve a piece to its inlinable JSX body string — the piece's render output
 *  referencing the emitted module consts (BG/ACCENT/…) + `c` (scene content).
 *  Produced per-file by the decomposer; passed directly for the M0 spike + tests. */
export type PieceBodyResolver = (piece: Piece, sceneIndex: number) => string;

export interface AssembleInput {
  theme: Theme;
  scenes: SceneManifest[];
  pieceBody: PieceBodyResolver;
}

const INDENT = "  ";

/** Emit the de-entangled module consts from the frozen theme. Palette keys ARE
 *  the const names (BG, ACCENT, INK, …) so pieces reference bare consts exactly
 *  like the monolithic model. */
const emitThemeConsts = (theme: Theme): string => {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(theme.palette)) {
    lines.push(`const ${name} = ${JSON.stringify(value)};`);
  }
  lines.push(`const FONT_DISPLAY = ${JSON.stringify(theme.fonts.display)};`);
  lines.push(`const FONT_BODY = ${JSON.stringify(theme.fonts.body)};`);
  lines.push(`const FONT_MONO = ${JSON.stringify(theme.fonts.mono)};`);
  lines.push(`const BRAND_FONTS_CSS = ${backtick(theme.fonts.fontFaceCss)};`);
  lines.push(`const SHARED_KEYFRAMES = ${backtick(theme.keyframes)};`);
  lines.push(
    `const GRAMMAR = Object.freeze(${JSON.stringify(theme.grammar)});`,
  );
  lines.push(
    `const SECTION_FRAME: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "hidden", boxSizing: "border-box" };`,
  );
  return lines.join("\n");
};

/** Template-literal-encode a multi-line CSS string (escape backslash, backtick,
 *  and `${` so a literal stays inert). */
const backtick = (s: string): string =>
  "`" + (s ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";

const HELPERS = `const Chrome = (p: { sceneIndex: number; totalScenes: number; showCornerLogo?: boolean; category?: string }) => (
  <BrandChrome
    {...p}
    variant="corner"
    logoSrc={LOGO_SRC}
    wordmark={BRAND_WORDMARK}
    ink={INK}
    accent={ACCENT}
    fontDisplay={FONT_DISPLAY}
    fontBody={FONT_BODY}
  />
);

const lastWordAccent = (text: string, color: string, emStyle?: React.CSSProperties): React.ReactNode => {
  if (!text) return text;
  const parts = text.split(" ");
  if (parts.length < 2) return <em style={{ fontStyle: "italic", color, ...emStyle }}>{text}</em>;
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1).join(" ");
  return (<>{rest}{" "}<em style={{ fontStyle: "italic", color, fontWeight: 300, ...emStyle }}>{last}</em></>);
};`;

/** Namespace a piece's LOCAL `@keyframes` — and every same-piece reference — with
 *  a CSS-ident prefix derived from the piece id ("s0.bar": drift1 → s0_bar_drift1).
 *  CSS keyframe names are DOCUMENT-global and Generated mounts every Section into
 *  one document, so two pieces each declaring a local `@keyframes pulse` would
 *  silently last-write-win across pieces (and a local redeclaration of a shared
 *  name would hijack it for every other piece). This is the minimal correct form
 *  of the piece-model invariant (piece-model.ts `Theme.keyframes`): ONLY names
 *  declared inside the piece body are renamed — SHARED_KEYFRAMES names must stay
 *  untouched, because pieces reference them by the shared name and renaming the
 *  shared preamble would orphan every reference.
 *
 *  Renames apply ONLY in animation contexts — the `@keyframes` declaration and
 *  the VALUE of `animation` / `animationName` / `animation-name` properties (a
 *  quoted/template string in style objects, or a bare CSS value up to `;`/`}`
 *  in style blocks). Keyframe names are often English words (pulse, float,
 *  drift); renaming any wider — even rest-of-line — corrupts visible COPY
 *  mentioning the word. The lookarounds rename bare identifiers only, so
 *  `${token}` interpolations and hyphenated neighbors pass through intact. The
 *  declared-name charset has no regex metacharacters, so names inject safely. */
const namespaceLocalKeyframes = (body: string, pieceId: string): string => {
  const declared = new Set<string>();
  for (const m of body.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) declared.add(m[1]);
  if (declared.size === 0) return body;
  const prefix = pieceId.replace(/[^A-Za-z0-9_]/g, "_");
  const renameIn = (segment: string): string => {
    for (const name of declared) {
      segment = segment.replace(new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "g"), `${prefix}_${name}`);
    }
    return segment;
  };
  return body
    .replace(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g, (_, name) => `@keyframes ${prefix}_${name}`)
    .replace(
      /(\banimation(?:Name|-name)?\s*:\s*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^;}\n]*)/g,
      (_, prop, value) => prop + renameIn(value),
    );
};

// ── Declared-box enforcement (flag-gated) ───────────────────────────────────
//
// A declared `height` on a piece wrapper did not CLIP: nothing here ever set
// `overflow`, so a 300px-tall box whose interior painted 440px simply spilled
// over its neighbours. Text pieces got no height at all (deliberately — "never
// clip a wrapped headline"), so a long headline grew downward without limit.
//
// Enforcement is OFF by default (`RB_ENFORCE_BOX=on` to enable) because the
// blast radius is visual and the sizing data to justify it only starts existing
// with the rect persistence landing alongside this (measure-scene.ts writes
// `rects-scene-N.json`; `summarizeBoxOverflow` counts the offenders). Turn it
// on once those numbers say what it would actually change.
//
// The two arms differ ON PURPOSE:
//   - NON-TEXT gets `overflow: hidden`. It clips at the PIECE boundary only, so
//     deliberate layering INSIDE a piece (the Razorpay s2 toast overhanging its
//     modal — both descendants of the same hero) is untouched by construction.
//     A piece that genuinely means to leave its own box sets `bleed`.
//   - TEXT is NEVER clipped — cutting words in half is a worse defect than the
//     one being fixed. It gets `maxHeight` plus a precomputed `fitScale`
//     downscale (see Piece.fitScale), so an over-long headline gets SMALLER
//     rather than growing into its neighbour.
const enforceBoxEnabled = (): boolean => (process.env.RB_ENFORCE_BOX ?? "").toLowerCase() === "on";

/**
 * Half 2 (task #114): the box CONTRACT — generation is TOLD to fill a
 * system-owned box (cast-build's elementBrief swaps its BOUNDS line for the
 * insert-element contract wording, proven at 17/17 measured compliance), and
 * this assembler makes the box real. One flag drives both halves, because a
 * contract without enforcement re-creates the witnessed C1 escape (interiors
 * authored canvas-scale geometry 138–1,295px outside plan slots), and
 * enforcement without the contract amputates content the model was never told
 * to fit (a model writing width:680 into a 460px box loses 220px to the clip).
 */
export const boxContractEnabled = (): boolean => (process.env.RB_BOX_CONTRACT ?? "").toLowerCase() === "on";

/** Inline one piece (and its nested children) into a positioned wrapper. Text
 *  pieces flow-size (maxWidth, height auto) so a wrapped headline is never clipped;
 *  others use a fixed rect. Atmosphere is full-bleed. Chrome is emitted by the
 *  Section itself (see emitSection), which passes `showCornerLogo={false}` when
 *  the manifest says the head's singularity budget gave the scene's one brand
 *  mark to an authored element instead of the corner lockup. The decision is
 *  made upstream in cast-build (`cornerLogoVisible`); this module only emits it.
 *  Section itself. Throughline pieces co-locate data-throughline + literal px. */
const emitPiece = (piece: Piece, sceneIndex: number, resolve: PieceBodyResolver, pad: string): string => {
  if (piece.kind === "chrome") return ""; // Section emits <Chrome/> itself
  const b = piece.bounds;
  const body = namespaceLocalKeyframes(resolve(piece, sceneIndex), piece.id);
  const childMarkup = (piece.children ?? [])
    .map((ch) => emitPiece(ch, sceneIndex, resolve, pad + INDENT))
    .filter(Boolean)
    .join("\n");

  // Attribute names mirror the Piece shim (build-wrapper.ts) EXACTLY: measure-scene's
  // PAGE_WALK resolves every element to closest('[data-piece]') + its data-kind, and
  // the BLOCKING render-truth gates (findCrossPieceOverlap, findStrandedHero) key off
  // those measured fields — omit these and the gates fail open on assembled output.
  const pieceAttrs = ` data-piece=${JSON.stringify(piece.id)} data-kind=${JSON.stringify(piece.kind)}`;

  // cycle-9 P2: wrap the positioned wrapper in a transparent <Piece> marker so the
  // deterministic LEGO decomposer (lego-decompose keys on `<Piece id kind>`) can
  // split the cast composition into editable per-piece files, exactly like the
  // monolithic path. The Piece shim renders display:contents (zero layout box —
  // pixel-identical) and its SOURCE tag carries `id=`/`kind=`, NOT `data-piece=`,
  // so every source-keyed cast tool (pieceSpanInCode, clampPieceOffsets,
  // forceHeroSurfaceLift, measure's data-piece anchor) still reads the inner
  // positioned <div data-piece> unchanged.
  const throughProp = piece.throughlineSlug ? ` throughline=${JSON.stringify(piece.throughlineSlug)}` : "";
  const pieceOpen = `${pad}<Piece id=${JSON.stringify(piece.id)} kind=${JSON.stringify(piece.kind)}${throughProp}>`;
  const pieceClose = `${pad}</Piece>`;
  const wrap = (inner: string): string => `${pieceOpen}\n${inner}\n${pieceClose}`;

  if (piece.kind === "atmosphere") {
    // Full-bleed decorative layer; bounds.z controls stacking (glow under, grain over).
    return wrap(`${pad}<div${pieceAttrs} style={{ position: "absolute", inset: 0, zIndex: ${b.z}, pointerEvents: "none" }}>\n${pad}${INDENT}${body}\n${childMarkup ? childMarkup + "\n" : ""}${pad}</div>`);
  }

  const isText = piece.kind === "text";
  const enforce = enforceBoxEnabled() || boxContractEnabled();
  // A piece may never be clipped out of existence: `bleed` is the explicit
  // opt-out, and a full-canvas treatment has no meaningful box to clip against.
  const exemptFromClip = piece.bleed === true;

  let sizing: string;
  if (isText) {
    // maxHeight (not height) even when enforcing: the box is a CEILING the copy
    // may come in under, and a fixed height would stretch a short headline's
    // background/box. `fitScale` is what actually keeps it inside — computed
    // upstream from the same font metrics the capacity budget uses, so it is
    // deterministic and identical in SSR, the preview and the MP4.
    const fit = typeof piece.fitScale === "number" && piece.fitScale > 0 && piece.fitScale < 1 ? piece.fitScale : null;
    const parts = [`width: ${b.w}`, `maxWidth: ${b.w}`];
    if (enforce) {
      parts.push(`maxHeight: ${b.h}`);
      if (fit) {
        // Scale the box down and widen it by the inverse so the SCALED result
        // still occupies exactly b.w — a pure-CSS shrink-to-fit with no runtime
        // measurement, so SSR, the measure pass and the render all agree.
        parts[0] = `width: ${Math.round(b.w / fit)}`;
        parts[1] = `maxWidth: ${Math.round(b.w / fit)}`;
        parts.push(`transform: "scale(${fit})"`, `transformOrigin: "top left"`);
      }
    }
    sizing = parts.join(", ");
  } else {
    sizing = `width: ${b.w}, height: ${b.h}`;
    if (enforce && !exemptFromClip) sizing += `, overflow: "hidden"`;
  }

  const throughAttr = piece.throughlineSlug
    ? ` data-throughline=${JSON.stringify(piece.throughlineSlug)}`
    : "";
  // The PLAN's declared height, recorded as data (never style) on text wrappers.
  // Text emits no CSS height by design, so before this the declared height was
  // absent from the DOM entirely and "did this headline outgrow its box?" was
  // unanswerable from a measured frame. measure-scene's PIECE_WALK reads it.
  // Costs nothing visually and is emitted whether or not enforcement is on —
  // measuring the problem must not require turning on the fix.
  const boxAttr = isText ? ` data-box-h={${b.h}}` : "";
  const bleedAttr = piece.bleed ? ` data-bleed="1"` : "";
  // Co-locate data-throughline AND literal px left/top on this same wrapper so
  // assessContinuity's pxAnchor + assessThroughlinePresence still read them.
  return wrap(`${pad}<div${pieceAttrs}${throughAttr}${boxAttr}${bleedAttr} style={{ position: "absolute", left: ${b.x}, top: ${b.y}, ${sizing}, zIndex: ${b.z} }}>\n${pad}${INDENT}${body}\n${childMarkup ? childMarkup + "\n" : ""}${pad}</div>`);
};

const emitSection = (scene: SceneManifest, resolve: PieceBodyResolver): string => {
  const k = scene.scene;
  const pieces = scene.pieces
    .map((p) => emitPiece(p, k, resolve, INDENT.repeat(3)))
    .filter(Boolean)
    .join("\n");
  return `export const Section${k}: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[${k}].content;
  return (
    <div style={{ ...SECTION_FRAME, background: ${scene.background}, fontFamily: FONT_BODY, color: INK }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS + SHARED_KEYFRAMES }} />
${pieces}
      <Chrome sceneIndex={${k}} totalScenes={script.scenes.length}${scene.showCornerLogo === false ? " showCornerLogo={false}" : ""} />
    </div>
  );
};`;
};

// ── deterministic edge-crop clamp (v10) ─────────────────────────────────────
// The measured arm (render-truth-gates findEdgeCroppedPieces) names pieces
// whose rendered union clips the canvas bottom/right edge. The cheapest true
// fix is a REPOSITION, not a regen: every non-atmosphere wrapper this module
// emits carries literal `left: X, top: Y` px (see emitPiece), so shifting the
// wrapper is a string-exact, zero-token repair on the assembled composition.

export interface PieceOffsetMove {
  pieceId: string;
  /** Shift in px (negative = up/left). Offsets are floored at 0 after the move. */
  dx?: number;
  dy?: number;
}

export interface ClampResult {
  code: string;
  applied: { pieceId: string; from: { left: number; top: number }; to: { left: number; top: number } }[];
  /** Moves that found no literally-positioned wrapper (atmosphere pieces, ids
   *  not in the code) — the caller escalates these to a regen. */
  skipped: { pieceId: string; reason: string }[];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Apply wrapper-offset moves to an assembled composition. Only wrappers with
 *  the literal `left: X, top: Y` shape emitPiece writes are touched. */
export const clampPieceOffsets = (code: string, moves: PieceOffsetMove[]): ClampResult => {
  const result: ClampResult = { code, applied: [], skipped: [] };
  for (const move of moves) {
    const dx = move.dx ?? 0;
    const dy = move.dy ?? 0;
    if (dx === 0 && dy === 0) {
      result.skipped.push({ pieceId: move.pieceId, reason: "zero move" });
      continue;
    }
    const rx = new RegExp(
      `(<div[^>]*data-piece=${escapeRegExp(JSON.stringify(move.pieceId))}[^>]*style=\\{\\{ position: "absolute", left: )(-?\\d+(?:\\.\\d+)?)(, top: )(-?\\d+(?:\\.\\d+)?)`,
    );
    const m = rx.exec(result.code);
    if (!m) {
      result.skipped.push({
        pieceId: move.pieceId,
        reason: "no literally-positioned wrapper found (atmosphere/full-bleed piece, or id absent)",
      });
      continue;
    }
    const from = { left: Number(m[2]), top: Number(m[4]) };
    const to = { left: Math.max(0, from.left + dx), top: Math.max(0, from.top + dy) };
    result.code =
      result.code.slice(0, m.index) +
      `${m[1]}${to.left}${m[3]}${to.top}` +
      result.code.slice(m.index + m[0].length);
    result.applied.push({ pieceId: move.pieceId, from, to });
  }
  return result;
};

// ── interior-overfill shrink (Half 2's honest companion, task #114) ─────────
//
// Witnessed on the first box-contract build (2026-08-24, witness 5): with the
// contract on, wrappers land exactly on their plan slots — but a model that
// overfills its interior now gets CLIPPED instead of spilling, and the clip
// amputates real content (scene 3 cut stat chips mid-glyph; scene 4 cut the
// headline mid-word). Enforcement traded invisible misplacement for visible
// truncation. The honest repair is the one text pieces already get: a measured
// shrink — content complete at a slightly smaller size — never a blind cut.
//
// Zero tokens, fully deterministic, and it can only shrink (never grow, never
// move), so repeated application converges. The scale uses the same
// inverse-widening trick as the text fitScale: the box is widened to W/f and
// scaled by f, so the PAINTED footprint stays exactly W×H at the same origin.
//
// The planner reads each wrapper's box from the CODE (not the plan), so pieces
// the edge-crop clamp has already moved are measured against their true box.
// Only the enforce-mode non-text wrapper shape is eligible — the literal
// `left/top/width/height/overflow:"hidden"` signature — which structurally
// excludes text (maxHeight, its own fitScale), bleed (no clip), atmosphere
// (inset) and chrome (no wrapper). Overfill is judged on INK (text and images):
// decoration that pokes past a clipped edge is harmless bleed, and shrinking a
// whole piece to rescue a gradient would manufacture a defect to fix none.

export interface OverfillShrink {
  pieceId: string;
  /** 0 < fitScale < 1 — the scale that brings the ink union inside the box. */
  fitScale: number;
}

export interface OverfillPlan {
  shrinks: OverfillShrink[];
  /** Overfilled pieces the planner refuses to shrink (below the floor). */
  refused: Array<{ pieceId: string; fitScale: number; reason: string }>;
}

/** Below this scale a silent shrink is its own defect — the content is so
 *  oversized that tiny-but-complete reads as broken. Those stay clipped and
 *  visible, for the gates and the regen ladder to judge. */
export const OVERFILL_SHRINK_FLOOR = 0.75;

interface MeasuredInkElement {
  piece?: string;
  pieceKind?: string;
  text?: string;
  isImg?: boolean;
  x: number; y: number; w: number; h: number;
}

export const planOverfillShrinks = (
  code: string,
  measurements: Array<{ error?: string; elements?: MeasuredInkElement[] }>,
  tolPx: number = 8,
): OverfillPlan => {
  const plan: OverfillPlan = { shrinks: [], refused: [] };
  // Ink union per piece, canvas-space. Clipped children still report their full
  // layout rect (getBoundingClientRect ignores paint clipping) — which is
  // exactly what makes the amputation measurable.
  const ink = new Map<string, { x2: number; y2: number }>();
  for (const m of measurements) {
    if (m.error) continue;
    for (const r of m.elements ?? []) {
      if (!r.piece || r.pieceKind === "atmosphere" || r.pieceKind === "chrome") continue;
      if (!((r.text && r.text.trim()) || r.isImg) || r.w <= 2 || r.h <= 2) continue;
      const c = ink.get(r.piece);
      const x2 = r.x + r.w;
      const y2 = r.y + r.h;
      ink.set(r.piece, c ? { x2: Math.max(c.x2, x2), y2: Math.max(c.y2, y2) } : { x2, y2 });
    }
  }
  for (const [pieceId, u] of ink) {
    const rx = new RegExp(
      `<div[^>]*data-piece=${escapeRegExp(JSON.stringify(pieceId))}[^>]*style=\\{\\{ position: "absolute", left: (-?\\d+(?:\\.\\d+)?), top: (-?\\d+(?:\\.\\d+)?), width: (\\d+(?:\\.\\d+)?), height: (\\d+(?:\\.\\d+)?), transform:`,
    );
    if (rx.test(code)) continue; // already scaled — converged, never re-shrink
    const rx2 = new RegExp(
      `<div[^>]*data-piece=${escapeRegExp(JSON.stringify(pieceId))}[^>]*style=\\{\\{ position: "absolute", left: (-?\\d+(?:\\.\\d+)?), top: (-?\\d+(?:\\.\\d+)?), width: (\\d+(?:\\.\\d+)?), height: (\\d+(?:\\.\\d+)?), overflow: "hidden"`,
    );
    const m = rx2.exec(code);
    if (!m) continue; // not an enforce-mode clipped wrapper (text/bleed/atmosphere)
    const left = Number(m[1]);
    const top = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    const needW = u.x2 - left;
    const needH = u.y2 - top;
    if (needW <= w + tolPx && needH <= h + tolPx) continue; // fits — nothing to do
    const fit = Math.min(w / Math.max(needW, 1), h / Math.max(needH, 1));
    // Round DOWN so the shrink never comes up short of the box.
    const fitScale = Math.floor(fit * 1000) / 1000;
    if (fitScale >= 1) continue;
    if (fitScale < OVERFILL_SHRINK_FLOOR) {
      plan.refused.push({
        pieceId, fitScale,
        reason: `needs scale ${fitScale} (< floor ${OVERFILL_SHRINK_FLOOR}) — content ~${Math.round((1 / fitScale - 1) * 100)}% oversize, stays clipped for the gates`,
      });
      continue;
    }
    plan.shrinks.push({ pieceId, fitScale });
  }
  return plan;
};

export interface ShrinkResult {
  code: string;
  applied: Array<{ pieceId: string; fitScale: number; from: { w: number; h: number } }>;
  skipped: Array<{ pieceId: string; reason: string }>;
}

export const shrinkOverfilledPieces = (code: string, shrinks: OverfillShrink[]): ShrinkResult => {
  const result: ShrinkResult = { code, applied: [], skipped: [] };
  for (const s of shrinks) {
    if (!(s.fitScale > 0 && s.fitScale < 1)) {
      result.skipped.push({ pieceId: s.pieceId, reason: `fitScale ${s.fitScale} out of range` });
      continue;
    }
    const rx = new RegExp(
      `(<div[^>]*data-piece=${escapeRegExp(JSON.stringify(s.pieceId))}[^>]*style=\\{\\{ position: "absolute", left: -?\\d+(?:\\.\\d+)?, top: -?\\d+(?:\\.\\d+)?, width: )(\\d+(?:\\.\\d+)?)(, height: )(\\d+(?:\\.\\d+)?)(, overflow: "hidden")`,
    );
    const m = rx.exec(result.code);
    if (!m) {
      result.skipped.push({
        pieceId: s.pieceId,
        reason: "no clipped fixed-size wrapper found (text/bleed/atmosphere, already scaled, or id absent)",
      });
      continue;
    }
    const w = Number(m[2]);
    const h = Number(m[4]);
    const w2 = Math.round(w / s.fitScale);
    const h2 = Math.round(h / s.fitScale);
    result.code =
      result.code.slice(0, m.index) +
      `${m[1]}${w2}${m[3]}${h2}, transform: "scale(${s.fitScale})", transformOrigin: "top left"${m[5]}` +
      result.code.slice(m.index + m[0].length);
    result.applied.push({ pieceId: s.pieceId, fitScale: s.fitScale, from: { w, h } });
  }
  return result;
};

export interface BoxCropFinding {
  scene: number;
  pieceId: string;
  edge: "bottom" | "right";
  /** Ink extent past the piece's PAINTED box edge, px. */
  overflowPx: number;
  union: { x: number; y: number; w: number; h: number };
}

/**
 * Ink that extends past its own piece's painted box — the residual the shrink
 * cannot fix. Witnessed on witness 5: interiors that set width:100% AND an
 * offset (padding-left, a row below the box, a decorative page counter at the
 * box edge) overflow by the offset at ANY scale, because the 100% width
 * re-expands as the shrink widens the box. Scaling only multiplies the offset
 * by the scale (60px → 55px). These are CONTRACT violations, not size
 * misjudgments, so they route to the regen ladder with the violation named —
 * the same residual path the canvas edge-crop clamp uses.
 *
 * Both wrapper forms are parsed: plain (`width, height, overflow`) and
 * already-shrunk (`width, height, transform: "scale(f)"`), with the painted
 * box = width × scale. Ink-only, same doctrine as the planner.
 */
export const findBoxCroppedInk = (
  code: string,
  measurements: Array<{ scene?: number; error?: string; elements?: MeasuredInkElement[] }>,
  tolPx: number = 8,
): BoxCropFinding[] => {
  const findings: BoxCropFinding[] = [];
  for (const m of measurements) {
    if (m.error) continue;
    const union = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
    for (const r of m.elements ?? []) {
      if (!r.piece || r.pieceKind === "atmosphere" || r.pieceKind === "chrome") continue;
      if (!((r.text && r.text.trim()) || r.isImg) || r.w <= 2 || r.h <= 2) continue;
      const c = union.get(r.piece);
      const b = { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
      union.set(r.piece, c ? { x1: Math.min(c.x1, b.x1), y1: Math.min(c.y1, b.y1), x2: Math.max(c.x2, b.x2), y2: Math.max(c.y2, b.y2) } : b);
    }
    for (const [pieceId, u] of union) {
      const esc = escapeRegExp(JSON.stringify(pieceId));
      const scaled = new RegExp(
        `<div[^>]*data-piece=${esc}[^>]*style=\\{\\{ position: "absolute", left: (-?\\d+(?:\\.\\d+)?), top: (-?\\d+(?:\\.\\d+)?), width: (\\d+(?:\\.\\d+)?), height: (\\d+(?:\\.\\d+)?), transform: "scale\\((0\\.\\d+)\\)"`,
      ).exec(code);
      const plain = scaled
        ? null
        : new RegExp(
            `<div[^>]*data-piece=${esc}[^>]*style=\\{\\{ position: "absolute", left: (-?\\d+(?:\\.\\d+)?), top: (-?\\d+(?:\\.\\d+)?), width: (\\d+(?:\\.\\d+)?), height: (\\d+(?:\\.\\d+)?), overflow: "hidden"`,
          ).exec(code);
      const mm = scaled ?? plain;
      if (!mm) continue;
      const scale = scaled ? Number(scaled[5]) : 1;
      const left = Number(mm[1]);
      const top = Number(mm[2]);
      const paintedW = Number(mm[3]) * scale;
      const paintedH = Number(mm[4]) * scale;
      const overRight = u.x2 - (left + paintedW);
      const overBottom = u.y2 - (top + paintedH);
      const over = Math.max(overRight, overBottom);
      if (over <= tolPx) continue;
      findings.push({
        scene: m.scene ?? 0,
        pieceId,
        edge: overRight >= overBottom ? "right" : "bottom",
        overflowPx: Math.round(over),
        union: { x: Math.round(u.x1), y: Math.round(u.y1), w: Math.round(u.x2 - u.x1), h: Math.round(u.y2 - u.y1) },
      });
    }
  }
  return findings;
};

/** Assemble the full Composition.tsx string from theme + manifests + piece bodies. */
export const assembleComposition = (input: AssembleInput): string => {
  const { theme, scenes, pieceBody } = input;
  const sections = scenes.map((s) => emitSection(s, pieceBody)).join("\n\n");
  const generated = `export const Generated: React.FC<{ script: Script }> = ({ script }) => (
  <>
${scenes.map((s) => `${INDENT}<Section${s.scene} script={script} />`).join("\n")}
  </>
);`;

  return `import React from "react";
import { Img } from "./Img";
import { Piece } from "./Piece";
import { BrandChrome } from "./BrandChrome";

interface Script {
  scenes: Array<{ content: any }>;
  assets?: { images?: any[] };
  config?: any;
}

${emitThemeConsts(theme)}

${HELPERS}

${sections}

${generated}
`;
};
