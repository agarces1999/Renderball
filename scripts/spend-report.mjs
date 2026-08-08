#!/usr/bin/env node
// Runner for scripts/spend-report.ts — esbuild-bundles the TS and imports it
// (same pattern as scripts/dogfood-spike.mjs). Usage, from the repo root:
//   npm run spend
//   npm run spend -- --by=day --since=2026-08-01
//   npm run spend -- --deck=<scriptId>
//   npm run spend -- --check
//
// WHY A TS ENTRY rather than a self-contained .mjs doing its own SQL: the
// aggregation has to be the SAME code GET /api/admin/spend runs. Two
// implementations of "what did we spend today" is how a CLI and a dashboard
// start disagreeing in the last digit, which is precisely the ambiguity this
// tool exists to end. lib/spend/ledger.ts is that one implementation, and it is
// the thing the unit tests cover.
//
// The trade this accepts: rows are aggregated in Node, not by Postgres. At the
// documented volume (1.5-4.5k rows/day) a month is well inside memory, and
// lib/spend/source.ts caps the read. If that stops being true, push the
// GROUP BY into SQL — but push it into ledger.ts's shape so both surfaces keep
// calling one function.
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Load .env.local the way scripts/run-tests.mjs does, rather than requiring
// dotenv-cli: dotenv-cli is a devDependency and is absent from a production
// install, so `railway run npm run spend` would fail on the one machine where
// the answer matters. Real environment variables always win, so that same
// command reads production when it is run there.
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Bundle local TS; leave node_modules (@prisma/client, esbuild, …) as runtime
// requires so they resolve against the project's own installation.
const result = await esbuild.build({
  entryPoints: [join(here, "spend-report.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});

// Write the bundle INSIDE the project (node_modules/.cache) so the external
// requires resolve against the project's node_modules.
const work = join(root, "node_modules", ".cache", "rb-scripts");
mkdirSync(work, { recursive: true });
const out = join(work, "spend-report.mjs");
writeFileSync(out, result.outputFiles[0].text);
await import(pathToFileURL(out).href);
