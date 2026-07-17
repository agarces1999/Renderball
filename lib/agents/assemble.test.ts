/**
 * Tests for the deterministic assembler (LEGO engine M0). Proves it emits the
 * Composition.tsx contract: correct imports, one self-contained `Section{K}` per
 * scene (each with its own <style> block), pieces inlined into positioned
 * wrappers, nested children inlined, throughline px co-located with the
 * data-throughline attribute, a Generated alias — and that the output actually
 * COMPILES (esbuild tsx transform, the same verifyCompilable the build uses).
 */
import { assembleComposition, clampPieceOffsets, type AssembleInput } from "./assemble";
import { verifyCompilable } from "./code-extraction";
import { decompose, reassemble, pieceCount } from "./lego-decompose";
import type { Theme, SceneManifest, Piece } from "../edit/piece-model";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const theme: Theme = {
  palette: {
    BG: "#110e09", ACCENT: "#ccff00", INK: "#f4f1ea",
    PANEL_BG: "rgba(244,241,234,0.04)", HAIRLINE: "rgba(244,241,234,0.12)",
  },
  fonts: {
    display: '"Display", sans-serif', body: '"Body", sans-serif', mono: '"Mono", monospace',
    fontFaceCss: "@font-face{font-family:'Display';src:url('https://cdn.x/f.woff2');}",
  },
  keyframes: "@keyframes fadeRise{from{opacity:0}to{opacity:1}}",
  grammar: { radiusScale: [8, 12, 16], strokeWeight: 1, hairline: "HAIRLINE", panelBg: "PANEL_BG", shadowRecipe: "0 30px 80px rgba(0,0,0,0.4)", dataFont: "mono" },
};

const scenes: SceneManifest[] = [
  {
    scene: 0,
    background: "BG",
    pieces: [
      { id: "s0.text", kind: "text", file: "scene0/text.tsx", bounds: { x: 80, y: 120, w: 760, h: 0, z: 2 } },
      {
        id: "s0.panel", kind: "diegetic", file: "scene0/panel.tsx", bounds: { x: 960, y: 140, w: 840, h: 780, z: 2 },
        children: [
          { id: "s0.panel.row", kind: "diegetic", file: "scene0/panel-row.tsx", bounds: { x: 980, y: 200, w: 800, h: 60, z: 3 } },
        ],
      },
      { id: "s0.bar", kind: "diegetic", file: "scene0/bar.tsx", bounds: { x: 80, y: 690, w: 1760, h: 6, z: 5 }, throughlineSlug: "progress-bar" },
      { id: "s0.atmos", kind: "atmosphere", file: "scene0/atmos.tsx", bounds: { x: 0, y: 0, w: 1920, h: 1080, z: 0 } },
      { id: "s0.chrome", kind: "chrome", file: "scene0/chrome.tsx", bounds: { x: 0, y: 0, w: 1920, h: 1080, z: 20 } },
    ],
  },
];

const bodies: Record<string, string> = {
  "s0.text": `<h1 style={{ fontFamily: FONT_DISPLAY, color: INK, margin: 0, animation: "fadeRise 0.4s ease-out forwards" }}>{lastWordAccent(c.headline, ACCENT)}</h1>`,
  "s0.panel": `<div style={{ width: "100%", height: "100%", background: PANEL_BG, borderRadius: GRAMMAR.radiusScale[1], border: \`1px solid \${HAIRLINE}\` }} />`,
  "s0.panel.row": `<div style={{ color: INK, fontFamily: FONT_MONO }}>{c.eyebrow}</div>`,
  "s0.bar": `<div style={{ width: "100%", height: "100%", background: ACCENT }} />`,
  "s0.atmos": `<div style={{ width: "100%", height: "100%", background: BG }} />`,
};

const input: AssembleInput = { theme, scenes, pieceBody: (p) => bodies[p.id] ?? "<div />" };
const out = assembleComposition(input);

console.log("assemble (LEGO engine M0)");

await check("emits the import + Script-interface header", () => {
  assert(out.includes('import React from "react";'), "react import");
  assert(out.includes('import { Img } from "./Img";'), "Img import");
  assert(out.includes('import { BrandChrome } from "./BrandChrome";'), "BrandChrome import");
  assert(out.includes("interface Script {"), "Script interface");
});

await check("emits theme consts (palette keys become bare consts)", () => {
  assert(out.includes('const BG = "#110e09";'), "BG const");
  assert(out.includes('const ACCENT = "#ccff00";'), "ACCENT const");
  assert(out.includes("const BRAND_FONTS_CSS = `"), "BRAND_FONTS_CSS");
  assert(out.includes("const SHARED_KEYFRAMES = `"), "SHARED_KEYFRAMES");
  assert(out.includes("const SECTION_FRAME"), "SECTION_FRAME");
  assert(!out.includes("const LOGO_SRC"), "LOGO_SRC must NOT be emitted (injectLogoSrc injects it)");
});

await check("each Section is self-contained with its own <style> block + Chrome", () => {
  assert(out.includes("export const Section0: React.FC<{ script: Script }>"), "Section0 export");
  assert(out.includes("const c = script.scenes[0].content;"), "scene content binding");
  assert(out.includes("<style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS + SHARED_KEYFRAMES }} />"), "per-Section style block");
  assert(out.includes("<Chrome sceneIndex={0} totalScenes={script.scenes.length} />"), "Chrome (also makes LOGO_SRC referenced)");
});

await check("pieces inline into positioned wrappers; nested child inlined", () => {
  assert(out.includes("position: \"absolute\", left: 80, top: 120"), "text piece positioned");
  assert(out.includes("{lastWordAccent(c.headline, ACCENT)}"), "text body inlined");
  assert(out.includes("{c.eyebrow}"), "nested child (panel row) inlined");
  // atmosphere is full-bleed (inset:0) at its z
  assert(/inset: 0, zIndex: 0/.test(out), "atmosphere full-bleed at z0");
  // chrome piece is NOT double-emitted as a wrapper (Section emits <Chrome/> itself)
  assert(!out.includes('left: 0, top: 0, width: 1920, height: 1080, zIndex: 20'), "chrome piece not wrapped");
});

await check("throughline piece co-locates data-throughline + literal px on one wrapper", () => {
  assert(/data-throughline="progress-bar" style=\{\{ position: "absolute", left: 80, top: 690/.test(out),
    "data-throughline + left/top must be on the SAME wrapper (assessContinuity reads px off that tag)");
});

await check("every emitted piece wrapper carries data-piece + data-kind (gate visibility)", () => {
  // measure-scene's PAGE_WALK reads closest('[data-piece]') + data-kind; the BLOCKING
  // render-truth gates (findCrossPieceOverlap, findStrandedHero) fail OPEN without them.
  const walk = (ps: Piece[]) => {
    for (const p of ps) {
      if (p.kind !== "chrome") { // Section emits <Chrome/> itself — no wrapper to attribute
        assert(out.includes(`data-piece="${p.id}" data-kind="${p.kind}"`),
          `piece ${p.id} wrapper must carry data-piece + data-kind (kind ${p.kind})`);
      }
      if (p.children) walk(p.children);
    }
  };
  scenes.forEach((s) => walk(s.pieces));
  // throughline attr still co-locates AFTER the piece attrs on the same wrapper
  assert(out.includes('data-piece="s0.bar" data-kind="diegetic" data-throughline="progress-bar"'),
    "piece attrs + data-throughline on the same wrapper");
});

await check("emits the Generated alias rendering every Section", () => {
  assert(out.includes("export const Generated: React.FC<{ script: Script }>"), "Generated export");
  assert(out.includes("<Section0 script={script} />"), "Generated mounts Section0");
});

// ── cycle-9 P2: <Piece> markers → the LEGO decomposer works on cast output ──
await check("wraps each non-chrome piece in a <Piece id kind> marker (+ imports the shim)", () => {
  assert(out.includes('import { Piece } from "./Piece";'), "Piece shim imported");
  assert(out.includes('<Piece id="s0.text" kind="text">'), "text piece wrapped");
  assert(out.includes('<Piece id="s0.panel" kind="diegetic">'), "diegetic piece wrapped");
  assert(out.includes('<Piece id="s0.bar" kind="diegetic" throughline="progress-bar">'), "throughline prop carried on the marker");
  assert(out.includes('<Piece id="s0.atmos" kind="atmosphere">'), "atmosphere piece wrapped");
  assert(!out.includes('id="s0.chrome"'), "chrome piece is NOT wrapped (Section emits <Chrome/>)");
  // The SOURCE marker carries id=/kind=, NOT data-piece= — so every data-piece-keyed
  // cast tool (pieceSpanInCode, clampPieceOffsets, forced-lift) still reads the inner div.
  assert(!/<Piece[^>]*data-piece=/.test(out), "the <Piece> tag must not carry data-piece in source");
});

await check("cast output decomposes and round-trips byte-identically (lego editor unblocked)", () => {
  const d = decompose(out);
  assert(pieceCount(d) === 4, `expected 4 decomposable pieces (text/panel/bar/atmos), got ${pieceCount(d)}`);
  assert(reassemble(d) === out, "decompose → reassemble must be byte-identical to the assembled composition");
  const ids = d.scenes.flatMap((s) => s.pieces.map((p) => p.id)).sort();
  assert(ids.includes("s0.text") && ids.includes("s0.panel") && ids.includes("s0.bar") && ids.includes("s0.atmos"),
    `decomposed ids: ${ids.join(", ")}`);
});

await check("the assembled Composition.tsx COMPILES (esbuild tsx)", async () => {
  const err = await verifyCompilable(out);
  assert(err === null, `should compile but: ${err}`);
});

// ————— piece-LOCAL keyframe namespacing (Theme.keyframes invariant, piece-model.ts) —————
// Keyframe names are document-global and Generated mounts every Section into one
// document, so two pieces declaring the same LOCAL @keyframes name would silently
// last-write-win. Shared names (SHARED_KEYFRAMES) must stay untouched.
const kfScenes: SceneManifest[] = [
  {
    scene: 0,
    background: "BG",
    pieces: [
      { id: "s0.a", kind: "diegetic", file: "scene0/a.tsx", bounds: { x: 80, y: 100, w: 400, h: 300, z: 1 } },
      { id: "s0.b", kind: "diegetic", file: "scene0/b.tsx", bounds: { x: 600, y: 100, w: 400, h: 300, z: 1 } },
    ],
  },
];
const kfBodies: Record<string, string> = {
  // Both pieces declare a LOCAL `@keyframes pulse` (different frames!). s0.a also
  // references the SHARED fadeRise, and its keyframe CSS carries a ${HAIRLINE}
  // interpolation that must survive the rename byte-for-byte.
  "s0.a": `<><style dangerouslySetInnerHTML={{ __html: \`@keyframes pulse{from{opacity:0.2}to{opacity:1;border-color:\${HAIRLINE}}}\` }} /><div style={{ animation: "pulse 1s infinite, fadeRise 0.4s ease-out" }} /></>`,
  // s0.b's visible COPY contains the bare word "pulse" — keyframe names are
  // often English words, and the rename must never touch prose.
  "s0.b": `<><style dangerouslySetInnerHTML={{ __html: \`@keyframes pulse{from{transform:scale(0.9)}to{transform:scale(1.1)}}\` }} /><div style={{ animationName: "pulse" }}>Feel the pulse of your data</div></>`,
};
const kfOut = assembleComposition({ theme, scenes: kfScenes, pieceBody: (p) => kfBodies[p.id] ?? "<div />" });

await check("same-named LOCAL keyframes are namespaced per piece (no cross-piece collision)", () => {
  assert(kfOut.includes("@keyframes s0_a_pulse{"), "s0.a's local pulse namespaced to s0_a_pulse");
  assert(kfOut.includes("@keyframes s0_b_pulse{"), "s0.b's local pulse namespaced to s0_b_pulse");
  assert(!/@keyframes pulse\{/.test(kfOut), "no bare @keyframes pulse survives (would last-write-win)");
});

await check("local keyframe REFERENCES follow the rename; shared refs + ${token} survive", () => {
  assert(kfOut.includes('animation: "s0_a_pulse 1s infinite, fadeRise 0.4s ease-out"'),
    "s0.a's animation shorthand renamed — and the SHARED fadeRise reference untouched");
  assert(kfOut.includes('animationName: "s0_b_pulse"'), "s0.b's animationName renamed");
  assert(kfOut.includes("border-color:${HAIRLINE}"), "${token} interpolation survives the rename intact");
});

await check("visible COPY containing a keyframe name is NEVER rewritten", () => {
  assert(kfOut.includes("Feel the pulse of your data"),
    "prose mentioning 'pulse' must survive — renames apply only in animation contexts");
});

await check("SHARED_KEYFRAMES itself is never renamed (pieces reference shared names)", () => {
  assert(kfOut.includes("@keyframes fadeRise{from{opacity:0}to{opacity:1}}"),
    "shared preamble emitted verbatim — namespacing it would orphan every piece reference");
});

await check("the keyframe-namespaced Composition.tsx COMPILES (esbuild tsx)", async () => {
  const err = await verifyCompilable(kfOut);
  assert(err === null, `should compile but: ${err}`);
});

// ── clampPieceOffsets (v10 — the deterministic edge-crop reposition) ────────

await check("clampPieceOffsets shifts a named wrapper's literal top/left; everything else byte-identical", () => {
  const r = clampPieceOffsets(out, [{ pieceId: "s0.panel", dy: -112 }]);
  assert(r.applied.length === 1 && r.skipped.length === 0, `one applied move, got ${JSON.stringify({ a: r.applied, s: r.skipped })}`);
  assert(r.applied[0].from.top === 140 && r.applied[0].to.top === 28, `140 → 28, got ${JSON.stringify(r.applied[0])}`);
  assert(r.applied[0].from.left === 960 && r.applied[0].to.left === 960, "left untouched on a dy-only move");
  assert(r.code.includes('data-piece="s0.panel" data-kind="diegetic" style={{ position: "absolute", left: 960, top: 28,'), "wrapper rewritten in place");
  assert(!new RegExp(`data-piece="s0\\.panel"[^>]*top: 140`).test(r.code), "old offset gone");
  // The move touches ONLY the named wrapper — the nested child keeps its own top.
  assert(r.code.includes('data-piece="s0.panel.row" data-kind="diegetic" style={{ position: "absolute", left: 980, top: 200,'), "nested child wrapper untouched");
});

await check("clampPieceOffsets floors offsets at 0, applies dx, and the clamped code still compiles", async () => {
  const r = clampPieceOffsets(out, [{ pieceId: "s0.text", dy: -500, dx: -30 }]);
  assert(r.applied[0].to.top === 0 && r.applied[0].to.left === 50, `floored at 0 / left 50, got ${JSON.stringify(r.applied[0])}`);
  const err = await verifyCompilable(r.code);
  assert(err === null, `clamped composition must compile: ${err}`);
});

await check("clampPieceOffsets reports unclampable moves as skipped (atmosphere, unknown ids, zero moves)", () => {
  const r = clampPieceOffsets(out, [
    { pieceId: "s0.atmos", dy: -50 }, // inset:0 wrapper — no literal left/top
    { pieceId: "s9.ghost", dy: -50 }, // not in the code
    { pieceId: "s0.panel" }, // zero move
  ]);
  assert(r.applied.length === 0, "nothing applied");
  assert(r.skipped.length === 3, `all three skipped with reasons, got ${JSON.stringify(r.skipped)}`);
  assert(r.code === out, "code untouched when nothing applies");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
