// Validation replay: the REAL findCoveredTextCluster over all stored scenes.
import { createRequire } from "module";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
const esbuild = createRequire("/Users/alfonsogarces/VIDEO_GEN/package.json")("esbuild");

const ROOT = "/Users/alfonsogarces/VIDEO_GEN";
const work = join(ROOT, "node_modules", ".cache", "rb-replay");
mkdirSync(work, { recursive: true });
const entry = join(work, "entry-cluster.ts");
writeFileSync(entry, `export { findCoveredTextCluster } from ${JSON.stringify(join(ROOT, "lib/render/render-truth-gates.ts"))};\n`);
const out = join(work, "entry-cluster.mjs");
await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node18", packages: "external", outfile: out });
const { findCoveredTextCluster } = await import(pathToFileURL(out).href);

const dogfood = join(ROOT, ".data", "dogfood");
const builds = readdirSync(dogfood, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(dogfood, d.name, "_measure")))
  .map((d) => d.name)
  .sort();

let fires = 0;
for (const b of builds) {
  const mdir = join(dogfood, b, "_measure");
  for (const rf of readdirSync(mdir).filter((f) => /^rects-scene-\d+\.json$/.test(f)).sort()) {
    const rec = JSON.parse(readFileSync(join(mdir, rf), "utf8"));
    if (!Array.isArray(rec.elements)) continue;
    const f = findCoveredTextCluster({ scene: rec.scene, width: rec.width, height: rec.height, elements: rec.elements });
    for (const x of f) {
      fires += 1;
      console.log(`FIRE ${b} s${rec.scene}: ${x.detail.slice(0, 160)}`);
    }
  }
}
console.log(`\n${fires} fire(s) across ${builds.length} builds`);
