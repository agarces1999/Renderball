// Send yourself a test alert.
//
// An alert channel you have not tested is not an alert channel — the first time
// it fires will be during an incident, which is the worst possible moment to
// discover the password was wrong. This sends the real thing through the real
// code path.
//
//   node scripts/test-alert.mjs
//
// Reads .env.local the same way the QA runner does, so it tests exactly what
// your local config would do. To test the PRODUCTION config, run it with those
// values in the environment instead:
//
//   RB_ALERT_EMAIL=you@gmail.com SMTP_URL='smtps://...' node scripts/test-alert.mjs
//
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

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

const work = join(process.cwd(), "node_modules", ".cache", "rb-alert");
mkdirSync(work, { recursive: true });
const built = await esbuild.build({
  entryPoints: [join(process.cwd(), "lib", "alert.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const outFile = join(work, "alert.mjs");
writeFileSync(outFile, built.outputFiles[0].text);
const { sendAlert, isEmailAlertingConfigured } = await import(pathToFileURL(outFile).href);

const email = process.env.RB_ALERT_EMAIL;
const webhook = process.env.RB_ALERT_WEBHOOK;

console.log("\n▶ Alert channels");
console.log(`  email:   ${isEmailAlertingConfigured() ? `→ ${email}` : "not configured (needs RB_ALERT_EMAIL + SMTP_URL)"}`);
console.log(`  webhook: ${webhook ? "→ configured" : "not configured (RB_ALERT_WEBHOOK)"}`);

if (!isEmailAlertingConfigured() && !webhook) {
  console.log("\nNothing to test. Set RB_ALERT_EMAIL + SMTP_URL (or RB_ALERT_WEBHOOK) and run again.\n");
  process.exit(1);
}

console.log("\n  sending…");
await sendAlert({
  key: `test-${Date.now()}`, // never suppressed, however many times you run it
  level: "critical",
  title: "Test alert — everything is fine",
  detail:
    "You ran scripts/test-alert.mjs. If you are reading this, the channel works and " +
    "you will hear about the real thing: the LLM account running dry, which stops " +
    "every build, generate and regenerate in the product.",
});

console.log("  sent. Check your inbox (and spam, the first time).\n");
