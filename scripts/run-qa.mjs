// QA suite runner — drives the real product in a real browser.
//
// Mirrors scripts/run-tests.mjs (esbuild-bundle the TS, import the bundle) so
// the project keeps ONE way of running TypeScript, with no test framework.
//
//   node scripts/run-qa.mjs                     # free tier, local dev server
//   QA_TIER=smoke node scripts/run-qa.mjs       # + one real generation
//   QA_TIER=full  node scripts/run-qa.mjs       # + a full deck build (~$1)
//   QA_BASE=https://renderball.com node scripts/run-qa.mjs
//   QA_HEADED=1 node scripts/run-qa.mjs         # watch it happen
//
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

const work = join(process.cwd(), "node_modules", ".cache", "rb-qa");
mkdirSync(work, { recursive: true });

const entry = join(process.cwd(), "qa", "main.ts");
const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});

const outFile = join(work, "qa-main.mjs");
writeFileSync(outFile, result.outputFiles[0].text);
await import(pathToFileURL(outFile).href);
