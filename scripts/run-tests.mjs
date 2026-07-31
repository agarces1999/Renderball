// Minimal TS test runner — no test-framework dependency, no API key.
//
// Compiles each `*.test.ts` with esbuild (already a project dep), then imports
// the bundle so its top-level assertions run. A failing test sets
// process.exitCode = 1, which we propagate. Usage:
//   node scripts/run-tests.mjs                 # runs every lib/**/*.test.ts
//   node scripts/run-tests.mjs path/to/x.test.ts
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

// Load .env.local, so tests that touch the database or storage work the same way
// the app does. Next loads it automatically; a plain node runner does not, and a
// missing DATABASE_URL turns a real assertion into a silent skip.
const envFile = join(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// STRIP THE ALERT CHANNELS. Learned the embarrassing way: lib/resilience.test.ts
// trips the spend breaker on purpose to prove the breaker works, and the breaker
// sends a CRITICAL alert. The moment real Gmail credentials landed in
// .env.local, every test run emailed the founder "Generation is DOWN" — a dozen
// times in one evening, about a production site that was perfectly healthy.
//
// A test suite must not be able to page anyone. Removing the credentials is
// stronger than a flag some future runner forgets to set: with nothing
// configured, lib/alert.ts is inert by construction. Tests that need to exercise
// the sending path set their own fake values (see lib/alert.test.ts).
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
// lib/ AND app/: route handlers now carry tests too (webhooks, contracts), and
// they are exactly the code paths that had none.
const files =
  argv.length > 0
    ? argv
    : [...findTests(join(process.cwd(), "lib")), ...findTests(join(process.cwd(), "app"))];

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
  // `packages: "external"` leaves bare specifiers untouched — including
  // "next/server", which node's ESM resolver refuses without an extension (it
  // suggests "next/server.js" itself). esbuild's `alias` is bypassed for
  // externals, so the specifier is rewritten in the emitted bundle. This is what
  // lets an app/ route handler be imported and called directly by a test, which
  // is how the webhooks get covered at all.
  const bundled = result.outputFiles[0].text.replace(
    /(["'])next\/(server|headers)\1/g,
    (_m, q, sub) => `${q}next/${sub}.js${q}`,
  );
  writeFileSync(outFile, bundled);
  // Reset between files; the test sets exitCode=1 on failure.
  process.exitCode = 0;
  await import(pathToFileURL(outFile).href);
  if (process.exitCode === 1) anyFailed = true;
}

process.exitCode = anyFailed ? 1 : 0;
