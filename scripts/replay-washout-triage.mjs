// Offline decision replay for the v16 washout×sparse triage — ZERO API CALLS.
// For every stored build with element-level rects, runs the REAL
// readDominantPanel over every hero piece and reports which pieces would have
// been (a) sparse→furnish-routed, (b) dense→lift-eligible, (c) unreadable.
// Ground truth to check against:
//   MUST read SPARSE  — alloc2-on-2 s1.hero (dark inbox), alloc2-on-1 s3.hero
//                       (giant slab) — the founder's two black boxes, plus the
//                       pre-lift white panels behind them in earlier rounds.
//   MUST read DENSE   — flags-notion s2 sidebar-style heroes, flags-on-rappi
//                       phone heroes (dark but rich interiors).
import { createRequire } from "module";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
const esbuild = createRequire("/Users/alfonsogarces/VIDEO_GEN/package.json")("esbuild");

const ROOT = "/Users/alfonsogarces/VIDEO_GEN";
const work = join(ROOT, "node_modules", ".cache", "rb-replay");
mkdirSync(work, { recursive: true });

const entry = join(work, "entry.ts");
writeFileSync(
  entry,
  `export { readDominantPanel } from ${JSON.stringify(join(ROOT, "lib/render/hero-contrast.ts"))};\n`,
);
const out = join(work, "entry.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  outfile: out,
});
const { readDominantPanel } = await import(pathToFileURL(out).href);

const FLOOR = 0.4; // CARD_INTERIOR_FLOOR
const dogfood = join(ROOT, ".data", "dogfood");
const builds = readdirSync(dogfood, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(dogfood, d.name, "_measure")))
  .map((d) => d.name)
  .sort();

let sparse = 0, dense = 0, unread = 0;
for (const b of builds) {
  const mdir = join(dogfood, b, "_measure");
  const rectFiles = readdirSync(mdir).filter((f) => /^rects-scene-\d+\.json$/.test(f)).sort();
  for (const rf of rectFiles) {
    const rec = JSON.parse(readFileSync(join(mdir, rf), "utf8"));
    if (!Array.isArray(rec.elements)) continue;
    const m = { scene: rec.scene, width: rec.width, height: rec.height, elements: rec.elements };
    const heroPieces = [...new Set(rec.elements.map((e) => e.piece).filter((p) => p && p.endsWith(".hero")))];
    for (const pieceId of heroPieces) {
      const r = readDominantPanel(m, pieceId, "#ffffff");
      if (!r) {
        unread += 1;
        console.log(`${b} s${rec.scene} ${pieceId}: UNREADABLE (no panel-sized surface or legacy fixture)`);
        continue;
      }
      const cls = r.coverage < FLOOR ? "SPARSE→furnish" : "dense→lift-ok";
      if (r.coverage < FLOOR) sparse += 1; else dense += 1;
      console.log(
        `${b} s${rec.scene} ${pieceId}: ${cls} — coverage ${(r.coverage * 100).toFixed(1)}% of ${r.panel.w}x${r.panel.h}` +
          `${r.edgeTreated ? ` · edge-treated (${r.edgeDetail})` : ""}`,
      );
    }
  }
}
console.log(`\nTOTAL: ${sparse} sparse→furnish · ${dense} dense→lift-ok · ${unread} unreadable`);
