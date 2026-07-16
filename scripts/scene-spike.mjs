// Tiny runner for scripts/scene-spike.ts — esbuild-bundles the TS and imports
// it (same pattern as scripts/bakeoff-eyeball.mjs). Usage, from the repo root:
//   set -a && source .env.local && set +a && node scripts/scene-spike.mjs
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

// Bundle local TS; leave node_modules (esbuild, playwright, react, …) as
// runtime requires — measure-scene.ts lazily imports playwright + esbuild.
const result = await esbuild.build({
  entryPoints: [join(here, "scene-spike.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});

// IMPORTANT: write the bundle INSIDE the project (under node_modules/.cache) so
// runtime imports of project packages resolve — same reasoning as run-tests.mjs.
const work = join(process.cwd(), "node_modules", ".cache", "rb-scene-spike");
mkdirSync(work, { recursive: true });
const outFile = join(work, "scene-spike.bundle.mjs");
writeFileSync(outFile, result.outputFiles[0].text);
await import(pathToFileURL(outFile).href); // argv passes through untouched
