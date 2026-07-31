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

// The whole point of this script is to actually send one, so it opts out of the
// "only deliver in production" rule that keeps a laptop from paging anyone.
process.env.RB_ALERT_FORCE = "1";

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
const { sendAlert, isEmailAlertingConfigured, alertRecipient } = await import(
  pathToFileURL(outFile).href
);

const webhook = process.env.RB_ALERT_WEBHOOK;
const ready = isEmailAlertingConfigured();

console.log("\n▶ Alert channels");
console.log(`  email:   ${ready ? `→ ${alertRecipient()}` : "not set up"}`);
console.log(`  webhook: ${webhook ? "→ configured" : "not set up"}`);

if (!ready && !webhook) {
  // The failure mode this catches is a half-filled .env.local, so say which
  // half is missing rather than restating the whole setup.
  const missing = [];
  if (!alertRecipient()) missing.push("GMAIL_USER");
  if (!process.env.GMAIL_APP_PASSWORD && !process.env.SMTP_URL) missing.push("GMAIL_APP_PASSWORD");
  console.log(`\n  Add these two lines to .env.local, then run this again:\n`);
  for (const key of missing.length ? missing : ["GMAIL_USER", "GMAIL_APP_PASSWORD"]) {
    console.log(`    ${key}=`);
  }
  console.log(
    `\n  GMAIL_USER is your address. GMAIL_APP_PASSWORD is the 16-character\n` +
      `  code from https://myaccount.google.com/apppasswords — not your\n` +
      `  normal password. Spaces in it are fine, they get stripped.\n`,
  );
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
