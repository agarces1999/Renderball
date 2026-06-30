/**
 * Tests for the deterministic assembler (LEGO engine M0). Proves it emits the
 * Composition.tsx contract: correct imports, one self-contained `Section{K}` per
 * scene (each with its own <style> block), pieces inlined into positioned
 * wrappers, nested children inlined, throughline px co-located with the
 * data-throughline attribute, a Generated alias — and that the output actually
 * COMPILES (esbuild tsx transform, the same verifyCompilable the build uses).
 */
import { assembleComposition, type AssembleInput } from "./assemble";
import { verifyCompilable } from "./code-extraction";
import type { Theme, SceneManifest } from "../edit/piece-model";

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

await check("emits the Generated alias rendering every Section", () => {
  assert(out.includes("export const Generated: React.FC<{ script: Script }>"), "Generated export");
  assert(out.includes("<Section0 script={script} />"), "Generated mounts Section0");
});

await check("the assembled Composition.tsx COMPILES (esbuild tsx)", async () => {
  const err = await verifyCompilable(out);
  assert(err === null, `should compile but: ${err}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
