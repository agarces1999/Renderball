// Tiny runner for scripts/acceptance-spike.ts — esbuild-bundles the TS and
// imports it (same pattern as scripts/full-spike.mjs). Usage, from the repo root:
//   set -a && source .env.local && set +a && node scripts/acceptance-spike.mjs
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

// Bundle local TS; leave node_modules (esbuild, playwright, prisma, react, …)
// as runtime requires — measure-scene.ts lazily imports playwright + esbuild,
// density-gates requires react-dom/server, and lib/store pulls @prisma/client.
const result = await esbuild.build({
  entryPoints: [join(here, "acceptance-spike.ts")],
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
const work = join(process.cwd(), "node_modules", ".cache", "rb-acceptance-spike");
mkdirSync(work, { recursive: true });
const outFile = join(work, "acceptance-spike.bundle.mjs");
writeFileSync(outFile, result.outputFiles[0].text);
await import(pathToFileURL(outFile).href); // argv passes through untouched
