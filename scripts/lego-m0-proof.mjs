#!/usr/bin/env node
/**
 * LEGO engine M0 step 3 — render-equivalence proof.
 *
 * Hand-authors ONE real Robinhood-style scene as a frozen Theme + a SceneManifest
 * (the nestable piece tree) + piece bodies, runs the deterministic assembler, drops
 * the result in a genDir with the real Img/BrandChrome shims, and renders Section0
 * through the UNCHANGED measure-scene SSR+Playwright path (the exact path the
 * render-truth gates use). Proves an assembled-from-pieces Composition.tsx mounts
 * a Section standalone, resolves its shims, loads fonts, settles its animation, and
 * passes the gates — the M0 go/no-go for the whole pivot.
 *
 * Usage: node scripts/lego-m0-proof.mjs   → writes a PNG + prints the verdict JSON.
 */
import * as esbuild from "esbuild";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const bundleTs = async (entry, name) => {
  const out = path.join(root, "node_modules", ".cache", "rb-lego", `${name}.mjs`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: "node",
    format: "esm", target: "node18", packages: "external", outfile: out, logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
};

const { assembleComposition } = await bundleTs("lib/agents/assemble.ts", "assemble");
const { measureScenes } = await bundleTs("lib/render/measure-scene.ts", "measure");
const { findRenderTruthFailures } = await bundleTs("lib/render/render-truth-gates.ts", "gates");

// ── the frozen theme (Robinhood: dark canvas, lime accent) ───────────────────
const theme = {
  palette: {
    BG: "#0E1413", ACCENT: "#A3E635", INK: "#F4F4F1",
    INK_MUTE: "rgba(244,244,241,0.62)", RED: "#E5484D",
    PANEL_BG: "rgba(255,255,255,0.035)", HAIRLINE: "rgba(255,255,255,0.10)",
  },
  fonts: {
    display: '"Inter", sans-serif', body: '"Inter", sans-serif', mono: 'ui-monospace, "SF Mono", monospace',
    fontFaceCss: "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');",
  },
  keyframes: "@keyframes fadeRise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}",
  grammar: { radiusScale: [8, 12, 16], strokeWeight: 1, hairline: "HAIRLINE", panelBg: "PANEL_BG", shadowRecipe: "0 30px 80px rgba(0,0,0,0.4)", dataFont: "mono" },
};

// ── the scene manifest (4 top-level pieces + a nested panel row) ─────────────
const scenes = [{
  scene: 0,
  background: "BG",
  pieces: [
    { id: "s0.atmos", kind: "atmosphere", file: "p/atmos.tsx", bounds: { x: 0, y: 0, w: 1920, h: 1080, z: 0 } },
    { id: "s0.text", kind: "text", file: "p/text.tsx", bounds: { x: 96, y: 150, w: 760, h: 0, z: 2 } },
    { id: "s0.panel", kind: "diegetic", file: "p/panel.tsx", bounds: { x: 1000, y: 180, w: 824, h: 720, z: 2 } },
    { id: "s0.bar", kind: "diegetic", file: "p/bar.tsx", bounds: { x: 96, y: 936, w: 1728, h: 6, z: 5 }, throughlineSlug: "progress-bar" },
    { id: "s0.chrome", kind: "chrome", file: "p/chrome.tsx", bounds: { x: 0, y: 0, w: 1920, h: 1080, z: 20 } },
  ],
}];

// ── piece bodies (inlinable JSX referencing the emitted consts + `c`) ────────
const bodies = {
  "s0.atmos": `<div style={{ width: "100%", height: "100%", background: \`radial-gradient(circle at 28% 42%, \${ACCENT}1f, transparent 58%)\` }} />`,
  "s0.text": `<div style={{ display: "flex", flexDirection: "column", gap: 22, animation: "fadeRise 0.5s ease-out forwards" }}>
    <div style={{ fontFamily: FONT_MONO, fontSize: 14, letterSpacing: "0.18em", color: ACCENT, textTransform: "uppercase" }}>{c.eyebrow}</div>
    <h1 style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 78, lineHeight: 1.04, letterSpacing: "-0.02em", color: INK, margin: 0 }}>{lastWordAccent(c.headline, ACCENT)}</h1>
    <p style={{ fontFamily: FONT_BODY, fontSize: 22, lineHeight: 1.5, color: INK_MUTE, margin: 0, maxWidth: 600 }}>{c.lede}</p>
    <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      {(c.bullets || []).map((b, i) => (<li key={i} style={{ fontFamily: FONT_BODY, fontSize: 18, color: INK_MUTE, display: "flex", gap: 12 }}><span style={{ color: ACCENT }}>—</span>{b}</li>))}
    </ul>
  </div>`,
  "s0.panel": `<div style={{ width: "100%", height: "100%", background: PANEL_BG, border: \`1px solid \${HAIRLINE}\`, borderRadius: GRAMMAR.radiusScale[2], boxShadow: GRAMMAR.shadowRecipe, padding: 32, boxSizing: "border-box" }}>
    <div style={{ fontFamily: FONT_MONO, fontSize: 13, letterSpacing: "0.14em", color: INK_MUTE, textTransform: "uppercase", marginBottom: 24 }}>Account eligibility</div>
    {[["High","Tier 3","Blocked"],["High","Tier 2","Blocked"],["Medium","Tier 1","Pending"]].map((r, i) => (
      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 0", borderBottom: \`1px solid \${HAIRLINE}\`, fontFamily: FONT_MONO, fontSize: 16, color: INK }}>
        <span>{r[0]}</span><span style={{ color: INK_MUTE }}>{r[1]}</span><span style={{ color: RED, fontWeight: 600 }}>{r[2]}</span>
      </div>
    ))}
    <div style={{ marginTop: 26, padding: "16px 18px", background: "rgba(229,72,77,0.10)", border: "1px solid rgba(229,72,77,0.4)", borderRadius: GRAMMAR.radiusScale[0], fontFamily: FONT_MONO, fontSize: 14, color: RED }}>● Access restricted</div>
  </div>`,
  "s0.bar": `<div style={{ width: "100%", height: "100%", background: \`linear-gradient(90deg, \${ACCENT}, transparent)\`, borderRadius: 3 }} />`,
};

const comp = assembleComposition({ theme, scenes, pieceBody: (p) => bodies[p.id] ?? "<div />" });

// Mimic the finalize chain's injectLogoSrc (we don't run finalize in the spike).
const logo = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="9" fill="#A3E635"/></svg>',
).toString("base64");
const compFinal = comp.replace(
  'import { BrandChrome } from "./BrandChrome";',
  `import { BrandChrome } from "./BrandChrome";\nconst LOGO_SRC = ${JSON.stringify(logo)};`,
);

// ── stand up a genDir with the real shims + render Section0 ───────────────────
const id = "__lego_proof__";
const genDir = path.join(root, "src", "generated", id);
await fs.rm(genDir, { recursive: true, force: true });
await fs.mkdir(genDir, { recursive: true });
await fs.writeFile(path.join(genDir, "Composition.tsx"), compFinal);
const rh = path.join(root, "src", "generated", "01KW048WG3E399G5ZKS3JV9T16");
for (const f of ["Img.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"]) {
  await fs.copyFile(path.join(rh, f), path.join(genDir, f)).catch(() => {});
}

const script = {
  config: { aspect_ratio: "16:9", fps: 30 },
  assets: { images: [], fonts: [] },
  scenes: [{
    content: {
      eyebrow: "The old way",
      headline: "The market was built for the few",
      lede: "High minimums, hidden fees, fine print designed to keep most people out.",
      bullets: ["Steep account minimums", "Commission on every trade", "Tools locked behind tiers"],
    },
  }],
};

const outDir = path.join(genDir, ".render-truth");
const meas = await measureScenes(genDir, script, outDir);
const gate = await findRenderTruthFailures(meas, { brandBackground: theme.palette.BG });

console.log(JSON.stringify({
  ok: !meas[0]?.error,
  screenshot: meas[0]?.screenshotPath,
  error: meas[0]?.error ?? null,
  measuredElements: meas[0]?.elements?.length ?? 0,
  findings: gate.findings,
  blocking: gate.blocking,
}, null, 2));
