// Runner for scripts/cycle9-product-path.ts — esbuild-bundles the TS and imports
// it (same pattern as scripts/dogfood-spike.mjs). From the repo root:
//   set -a && source .env.local && set +a && \
//     RB_BUILD_MODE=cast RB_CAST_MODEL=accounts/fireworks/routers/glm-5p2-fast \
//     RB_DOGFOOD_BRIEF=01KT6WXWCNRB7GEDCXHJTEZ4CH RB_DOGFOOD_TAG=tonys \
//     node scripts/cycle9-product-path.mjs
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

const result = await esbuild.build({
  entryPoints: [join(here, "cycle9-product-path.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});

const work = join(process.cwd(), "node_modules", ".cache", "rb-cycle9-product-path");
mkdirSync(work, { recursive: true });
const outFile = join(work, "cycle9-product-path.bundle.mjs");
writeFileSync(outFile, result.outputFiles[0].text);
await import(pathToFileURL(outFile).href);
