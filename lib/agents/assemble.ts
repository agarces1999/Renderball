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

/** Inline one piece (and its nested children) into a positioned wrapper. Text
 *  pieces flow-size (maxWidth, height auto) so a wrapped headline is never clipped;
 *  others use a fixed rect. Atmosphere is full-bleed. Chrome is emitted by the
 *  Section itself. Throughline pieces co-locate data-throughline + literal px. */
const emitPiece = (piece: Piece, sceneIndex: number, resolve: PieceBodyResolver, pad: string): string => {
  if (piece.kind === "chrome") return ""; // Section emits <Chrome/> itself
  const b = piece.bounds;
  const body = resolve(piece, sceneIndex);
  const childMarkup = (piece.children ?? [])
    .map((ch) => emitPiece(ch, sceneIndex, resolve, pad + INDENT))
    .filter(Boolean)
    .join("\n");

  if (piece.kind === "atmosphere") {
    // Full-bleed decorative layer; bounds.z controls stacking (glow under, grain over).
    return `${pad}<div style={{ position: "absolute", inset: 0, zIndex: ${b.z}, pointerEvents: "none" }}>\n${pad}${INDENT}${body}\n${childMarkup ? childMarkup + "\n" : ""}${pad}</div>`;
  }

  const sizing =
    piece.kind === "text"
      ? `width: ${b.w}, maxWidth: ${b.w}` // flow height — never clip a wrapped headline
      : `width: ${b.w}, height: ${b.h}`;
  const throughAttr = piece.throughlineSlug
    ? ` data-throughline=${JSON.stringify(piece.throughlineSlug)}`
    : "";
  // Co-locate data-throughline AND literal px left/top on this same wrapper so
  // assessContinuity's pxAnchor + assessThroughlinePresence still read them.
  return `${pad}<div${throughAttr} style={{ position: "absolute", left: ${b.x}, top: ${b.y}, ${sizing}, zIndex: ${b.z} }}>\n${pad}${INDENT}${body}\n${childMarkup ? childMarkup + "\n" : ""}${pad}</div>`;
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
      <Chrome sceneIndex={${k}} totalScenes={script.scenes.length} />
    </div>
  );
};`;
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
