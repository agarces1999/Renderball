// Minimal TS test runner — no test-framework dependency, no API key.
//
// Compiles each `*.test.ts` with esbuild (already a project dep), then imports
// the bundle so its top-level assertions run. A failing test sets
// process.exitCode = 1, which we propagate. Usage:
//   node scripts/run-tests.mjs                 # runs every lib/**/*.test.ts
//   node scripts/run-tests.mjs path/to/x.test.ts
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

// Dependency-free recursive scan for *.test.ts under a root.
const findTests = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

const argv = process.argv.slice(2);
const files = argv.length > 0 ? argv : findTests(join(process.cwd(), "lib"));

if (files.length === 0) {
  console.log("No *.test.ts files found.");
  process.exit(0);
}

// IMPORTANT: write bundles INSIDE the project (under node_modules/.cache) so
// the test's runtime `import("esbuild")` (kept external) resolves against the
// project's node_modules. A tmpdir() location can't resolve project packages.
const work = join(process.cwd(), "node_modules", ".cache", "rb-tests");
mkdirSync(work, { recursive: true });
let anyFailed = false;

for (const file of files) {
  console.log(`\n▶ ${file}`);
  // Bundle local TS; leave node_modules (incl. esbuild itself) as runtime
  // requires. code-extraction.ts only lazily imports esbuild, so this is clean.
  const result = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  const outFile = join(work, file.replace(/[^a-z0-9]+/gi, "_") + ".mjs");
  writeFileSync(outFile, result.outputFiles[0].text);
  // Reset between files; the test sets exitCode=1 on failure.
  process.exitCode = 0;
  await import(pathToFileURL(outFile).href);
  if (process.exitCode === 1) anyFailed = true;
}

process.exitCode = anyFailed ? 1 : 0;
