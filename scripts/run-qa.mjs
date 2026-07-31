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
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

// Load .env.local ourselves.
//
// Next does this automatically, so the dev server has DATABASE_URL and this
// runner did not — which meant the suite could not restore the document's
// script row, the files and the database drifted apart, and page-op refused
// every request with "store/script scene mismatch". The failure surfaced as
// six unrelated-looking flow failures.
const envFile = join(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue; // a real env var always wins
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

// The QA process must not be able to page anyone either — see the same block in
// scripts/run-tests.mjs for what happens when it can. (The SERVER under test
// keeps its own configuration; this only disarms alerts raised inside the
// runner.)
for (const key of [
  "RB_ALERT_WEBHOOK",
  "RB_ALERT_EMAIL",
  "RB_ALERT_FROM",
  "SMTP_URL",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
]) {
  delete process.env[key];
}

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
