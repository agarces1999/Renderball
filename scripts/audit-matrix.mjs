// Tiny runner for scripts/audit-matrix.ts — esbuild-bundles the TS and imports
// it (same pattern as scripts/scene-spike.mjs). Usage, from the repo root:
//   set -a && source .env.local && set +a && node scripts/audit-matrix.mjs
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

// Bundle local TS; leave node_modules (esbuild, playwright, react, …) as
// runtime requires — measure-scene.ts lazily imports playwright + esbuild.
const result = await esbuild.build({
  entryPoints: [join(here, "audit-matrix.ts")],
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
const work = join(process.cwd(), "node_modules", ".cache", "rb-audit-matrix");
mkdirSync(work, { recursive: true });
const outFile = join(work, "audit-matrix.bundle.mjs");
writeFileSync(outFile, result.outputFiles[0].text);
await import(pathToFileURL(outFile).href); // argv passes through untouched
