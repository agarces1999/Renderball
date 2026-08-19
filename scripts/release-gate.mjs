#!/usr/bin/env node
/**
 * THE RELEASE GATE — one command, the whole deploy ritual, in order, loudly
 * (founder, 2026-08-14: "fix the QA process so every time you deploy a fix
 * I am not the first one to notice it doesn't work").
 *
 *   node scripts/release-gate.mjs             # free gates + push + verify deploy
 *   node scripts/release-gate.mjs --spend     # ALSO runs the paid correctness
 *                                             # probes first (~$0.40, real outline)
 *   node scripts/release-gate.mjs --no-push   # gates only, stop before pushing
 *
 * Order (each stage must be green before the next):
 *   1. tsc + tsc(qa) + full suite            free, ~2 min
 *   2. [--spend] outline-stream probe        the live-typing correctness probe
 *   3. git push origin launch-deploy
 *   4. CI watched BY THIS COMMIT'S SHA       (the race that reported red as
 *                                             green twice is why: gh run list
 *                                             without --commit watches whatever
 *                                             ran last)
 *   5. prod serves this SHA + health all-ok + public surface answers
 *
 * CI runs the same post-deploy smoke on every push independently
 * (postdeploy-smoke in ci.yml) — a broken deploy turns CI red and emails the
 * founder even when nobody ran this script. This script exists so the person
 * shipping finds out FIRST, at the keyboard.
 *
 * Probes assert CORRECTNESS, not presence — a rendered page must contain no
 * error text, a typed outline must be in the brief's language. "The thumbnail
 * was visible" once passed while every thumbnail said "Render error:
 * LOGO_SRC is not defined"; that class of green is banned.
 */
import { execSync, spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));

/**
 * NEVER run two gates at once. Learned 2026-08-14: a gate was running in the
 * background while the next change was being written, and its `git add -A`
 * swept those unrelated files into the commit it was shipping — two features
 * landed under one message that described only the first. The code was fine;
 * the history lied. This lock makes the second run refuse instead.
 */
const LOCK = "/tmp/rb-release-gate.lock";
try {
  const { existsSync, writeFileSync, unlinkSync, readFileSync } = await import("node:fs");
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) {
      console.error(`✗ another release gate is already running (pid ${pid}). Wait for it — concurrent gates cross-contaminate commits.`);
      process.exit(1);
    }
  }
  writeFileSync(LOCK, String(process.pid));
  const release = () => { try { unlinkSync(LOCK); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
} catch {
  /* lock is best-effort — never block a ship on it */
}
const sh = (cmd, opts = {}) => {
  console.log(`\n▶ ${cmd}`);
  const r = spawnSync("bash", ["-c", cmd], { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\n✗ GATE FAILED at: ${cmd}`);
    process.exit(1);
  }
};
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

// ── 1. free gates ───────────────────────────────────────────────────────────
sh("npx tsc --noEmit -p tsconfig.json");
sh("npm run typecheck:qa");
sh("node scripts/run-tests.mjs");
// The webpack build catches what tsc structurally cannot: bundle-graph
// failures. Two same-day instances forced this stage in: TS syntax inside a
// raw-source page.evaluate walker (runtime), and instrumentation.ts pulling
// child_process into the EDGE bundle (compile) — both green under tsc, both
// dead on deploy. ~60-90s per gate is the price of pushes that build.
sh("RB_BUILD_DIR=.next-gate npm run build");

// ── 2. paid correctness probes (explicit opt-in only) ───────────────────────
if (args.has("--spend")) {
  sh(
    "export $(grep -E '^QA_TEST_(EMAIL|PASSWORD|CODE)=' .env.local | xargs) && npx tsx qa/probe-outline-stream.ts",
  );
} else {
  console.log("\n(skipping paid probes — pass --spend to run them; ~$0.40)");
}

if (args.has("--no-push")) {
  console.log("\n✓ gates green — stopping before push (--no-push)");
  process.exit(0);
}

// ── 3-4. push, then watch CI pinned to THIS sha ─────────────────────────────
sh("git push origin launch-deploy");
const sha = out("git rev-parse HEAD");
const short = sha.slice(0, 7);
console.log(`\n▶ waiting for CI on ${short}`);
let runId = "";
for (let i = 0; i < 24 && !runId; i++) {
  try {
    const j = JSON.parse(out(`gh run list --commit ${sha} --limit 1 --json databaseId`));
    runId = j[0]?.databaseId ? String(j[0].databaseId) : "";
  } catch {}
  if (!runId) execSync("sleep 5");
}
if (!runId) {
  console.error("✗ no CI run appeared for this commit");
  process.exit(1);
}
sh(`gh run watch ${runId} --exit-status`);

// ── 5. prod actually serves this sha, healthy, answering ────────────────────
console.log(`\n▶ waiting for renderball.com to serve ${short}`);
let served = false;
for (let i = 0; i < 60 && !served; i++) {
  try {
    const h = JSON.parse(out("curl -s --max-time 10 https://renderball.com/api/health"));
    if (h.commit === short) {
      served = true;
      const bad = Object.entries(h.checks ?? {}).filter(
        ([, v]) => v !== "ok" && v !== "not-configured",
      );
      if (h.status !== "ok" || bad.length) {
        console.error(`✗ deployed but unhealthy: ${h.status} ${JSON.stringify(bad)}`);
        process.exit(1);
      }
      break;
    }
  } catch {}
  execSync("sleep 15");
}
if (!served) {
  console.error(`✗ production never served ${short} — deploy failed or hung`);
  process.exit(1);
}
const code = (u) => out(`curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${u}"`);
if (code("https://renderball.com/") !== "200") {
  console.error("✗ landing broken");
  process.exit(1);
}
if (code("https://renderball.com/api/documents/generate/stream?scriptId=x") !== "401") {
  console.error("✗ stream route unguarded or dead");
  process.exit(1);
}
console.log(`\n✓ SHIPPED AND VERIFIED: prod serves ${short}, healthy, surface answering.`);
