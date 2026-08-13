// Does this deck's gate verdict depend on whether its brand webfonts load?
//
// Motivated by a production mystery (2026-08-14): a deck the prod ladder
// exhausted on measures CLEAN locally, both fit arms. If the verdict flips
// when fonts are unreachable, the prod failure was a MEASUREMENT artifact —
// fallback metrics re-wrapping text into phantom overflow — not a real
// layout defect. (The research's #1 failure mode for measured text, showing
// up between environments instead of between libraries.)
//
//   node scripts/replay-font-sensitivity.mjs <scriptId>
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const id = process.argv[2];
if (!id) { console.error("usage: node scripts/replay-font-sensitivity.mjs <scriptId>"); process.exit(1); }
const genDir = path.join(REPO, "src", "generated", id);
if (!existsSync(path.join(genDir, "script.json"))) { console.error("no script.json for", id); process.exit(1); }

const work = path.join(REPO, "node_modules", ".cache", "rb-font-sense");
mkdirSync(work, { recursive: true });
const entry = path.join(work, "entry.ts");
writeFileSync(
  entry,
  `export { measureScenes } from ${JSON.stringify(path.join(REPO, "lib/render/measure-scene.ts"))};
export { findRenderTruthFailures } from ${JSON.stringify(path.join(REPO, "lib/render/render-truth-gates.ts"))};`,
);
const out = await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node18", packages: "external", write: false, logLevel: "silent" });
const modPath = path.join(work, `b-${process.pid}.mjs`);
writeFileSync(modPath, out.outputFiles[0].text);
const { measureScenes, findRenderTruthFailures } = await import(pathToFileURL(modPath).href);

const script = JSON.parse(readFileSync(path.join(genDir, "script.json"), "utf8"));
const SCRATCH = path.join(
  "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad",
  "font-sense",
);
mkdirSync(SCRATCH, { recursive: true });

const tally = (gate) => {
  const t = {};
  for (const f of gate.blocking ?? []) t[`s${f.scene}:${f.kind}`] = (t[`s${f.scene}:${f.kind}`] ?? 0) + 1;
  return Object.entries(t).map(([k, v]) => `${k}×${v}`).join(" ") || "clean";
};

for (const arm of ["fonts-load", "fonts-broken"]) {
  const s = JSON.parse(JSON.stringify(script));
  if (arm === "fonts-broken") {
    // Point every @font-face at a dead local address — the deterministic
    // stand-in for "the CDN refused the datacenter" (fallback metrics apply).
    for (const f of s.assets?.fonts ?? []) f.src = "http://127.0.0.1:9/x.woff2";
  }
  const outDir = path.join(SCRATCH, `${id}-${arm}`);
  mkdirSync(outDir, { recursive: true });
  const measurements = await measureScenes(genDir, s, outDir);
  const gate = await findRenderTruthFailures(measurements, {});
  console.log(arm.padEnd(13), tally(gate));
}
