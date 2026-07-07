#!/usr/bin/env node
/**
 * One dogfood run — Renderball acting as its own user.
 *
 * 1. Pick the LEAST-recently-used brand from scripts/dogfood-brands.json
 *    (rotation tracked in .data/dogfood-log.json).
 * 2. Generate (crawl + script) + build (design + choreography) it via the dev
 *    server — self-boots `npm run dev` (the warmed wrapper) if it's down.
 * 3. Render a settled PNG per scene (scripts/dogfood-stills.mjs, headless).
 * 4. Persist + print a JSON manifest (scriptId, stills paths, per-scene paint
 *    report, build warnings) the dogfood AGENT reads to critique + ship fixes,
 *    and append to the rotation log. The same manifest lands on disk as
 *    .data/dogfood/<scriptId>/manifest.json so the QA step can read paint
 *    verdicts after the run's stdout is gone.
 *
 * Pure mechanics — no judgment, no code changes.
 * Usage: node scripts/dogfood-run.mjs
 *        node scripts/dogfood-run.mjs --stills-only <scriptId>   (re-run only
 *        stills + manifest persistence against an existing build — no API spend)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";

const root = process.cwd();
const PORT = process.env.PORT || "3000";
const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(JSON.stringify(o, null, 2));

// Stills + manifest persistence — shared by the full run and --stills-only.
// dogfood-stills.mjs prints its manifest (per-scene max-ink frame, candidates,
// paint report) as the LAST JSON object on stdout; renderer progress lines may
// precede it, so parse from the last opening brace that yields a full document
// (a nested brace fails on trailing closers, so only the root parses).
const stillsStep = async (scriptId, runFields = {}) => {
  const stdoutText = await new Promise((resolve, reject) => {
    let buf = "";
    const c = spawn("node", ["scripts/dogfood-stills.mjs", scriptId], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => { buf += d; });
    c.on("exit", (code) => (code === 0 ? resolve(buf) : reject(new Error(`stills exited ${code}`))));
  });
  let report = null;
  for (let i = stdoutText.lastIndexOf("{"); i >= 0; i = stdoutText.lastIndexOf("{", i - 1)) {
    try {
      report = JSON.parse(stdoutText.slice(i));
      break;
    } catch { /* nested brace — keep scanning */ }
  }
  const stillsDir = path.join(root, ".data", "dogfood", scriptId);
  const stills = (await fs.readdir(stillsDir))
    .filter((f) => /^scene-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)))
    .map((f) => path.join(stillsDir, f));
  const manifest = {
    ok: true,
    ...runFields,
    scriptId,
    stillsDir,
    stills,
    // Pixel truth from dogfood-stills — absent only if its stdout was unparseable.
    ...(report
      ? { sceneStills: report.stills, paint: report.paint, tailMotion: report.tailMotion }
      : {}),
  };
  // A failed disk write degrades to stdout-only (today's behavior), never a crash.
  try {
    await fs.writeFile(path.join(stillsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  } catch { /* stdout manifest still carries the report */ }
  return manifest;
};

if (process.argv[2] === "--stills-only") {
  const id = process.argv[3];
  if (!id) {
    out({ ok: false, stage: "stills", error: "usage: dogfood-run.mjs --stills-only <scriptId>" });
    process.exit(1);
  }
  out(await stillsStep(id));
  process.exit(0);
}

// 1. Brand selection — least-recently-used.
const brandsFile = JSON.parse(
  await fs.readFile(path.join(root, "scripts", "dogfood-brands.json"), "utf8"),
);
const brands = brandsFile.brands ?? [];
const logPath = path.join(root, ".data", "dogfood-log.json");
let log = { runs: [] };
try {
  log = JSON.parse(await fs.readFile(logPath, "utf8"));
} catch {
  /* first run */
}
const lastTs = (url) => {
  const r = [...(log.runs ?? [])].reverse().find((x) => x.url === url);
  return r ? r.ts : 0;
};
// NEW COMPANY EVERY RUN: least-recently-used first, and never the same brand as
// the immediately-previous run (LRU already guarantees this with >=2 brands;
// the guard makes it explicit). Only successful runs are logged, so a brand that
// failed (e.g. API down) is correctly retried rather than skipped.
const ordered = [...brands].sort((a, b) => lastTs(a.url) - lastTs(b.url));
const lastUrl = (log.runs ?? []).slice(-1)[0]?.url;
const brand = ordered[0]?.url === lastUrl && ordered[1] ? ordered[1] : ordered[0];
if (!brand) {
  out({ ok: false, stage: "select", error: "no brands configured" });
  process.exit(1);
}

// NEW SCRIPT EVERY RUN: every generate call already does a fresh crawl + a new
// ULID script (nothing is cached). To also guarantee a genuinely *different*
// story when a brand eventually cycles back, rotate a creative angle by how many
// times THIS brand has already run — so the repeat is a new narrative, not a
// near-duplicate of the same prompt.
const ANGLES = [
  "Open on the core problem the product eliminates, then reveal the product as the turn.",
  "Lead with a live product demo — the actual workflow/UI in motion as the hero.",
  "Tell it through one customer's before/after: the pain, the switch, the payoff.",
  "Frame it as a founder/vision manifesto — why this has to exist now.",
  "Center the single most striking metric (speed / scale / savings) and prove it.",
  "Stage the old way vs the new way as a head-to-head transformation.",
];
const brandRunCount = (log.runs ?? []).filter((r) => r.url === brand.url).length;
const angleIndex = brandRunCount % ANGLES.length;
const runPrompt = `${brand.prompt}\n\nCreative angle for THIS version (make it distinct from any prior version of this brand): ${ANGLES[angleIndex]}`;

// 2. Ensure the dev server is up (self-boot the warmed wrapper if needed).
const serverUp = async () => {
  try {
    await fetch(base, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
};
if (!(await serverUp())) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !(await serverUp())) await sleep(2000);
  if (!(await serverUp())) {
    out({ ok: false, stage: "server", error: "dev server did not come up" });
    process.exit(1);
  }
  // Warm the heavy routes so the first POST doesn't compile-while-running.
  for (const r of ["/api/dev/build", "/api/dev/generate"]) {
    try { await fetch(base + r, { method: "GET", signal: AbortSignal.timeout(120_000) }); } catch { /* best-effort */ }
  }
}

const postJson = async (route, body, timeoutMs) => {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
};

// 3. Generate (crawl + script).
let gen;
try {
  gen = await postJson(
    "/api/dev/generate",
    { url: brand.url, prompt: runPrompt, distribution_format: "landscape", duration_seconds: 30 },
    300_000,
  );
} catch (e) {
  out({ ok: false, stage: "generate", url: brand.url, error: String(e) });
  process.exit(1);
}
if (!gen?.ok) {
  out({ ok: false, stage: "generate", url: brand.url, error: gen?.error ?? "unknown" });
  process.exit(1);
}
const scriptId = gen.scriptId;

// 4. Build (design + choreography + gates). Clerk protects /api/preview/*
// since the launch foundation, so headless runs go through the dev-only
// route (NODE_ENV-gated, sessionless — same runPreviewBuild underneath).
let build;
try {
  build = await postJson("/api/dev/build", { scriptId }, 560_000);
} catch (e) {
  out({ ok: false, stage: "build", url: brand.url, scriptId, error: String(e) });
  process.exit(1);
}
if (!build?.ok) {
  out({ ok: false, stage: "build", url: brand.url, scriptId, error: build?.error ?? "unknown", render_errors: build?.render_errors });
  process.exit(1);
}

// 5. Per-scene stills (headless MP4 render + ffmpeg frame extraction — settled)
//    + manifest.json with the paint report persisted next to the PNGs.
const manifest = await stillsStep(scriptId, {
  url: brand.url,
  prompt: runPrompt,
  angleIndex,
  angle: ANGLES[angleIndex],
  previewUrl: `${base}/preview/${scriptId}`,
  warnings: build.warnings ?? {},
  // Render-truth verdict from the build route's real-browser measurement: the
  // deterministic gates (overflow — blocking, already repaired-or-passed by the
  // self-repair ladder) plus the advisory vision findings (washed-out logos,
  // off-brand canvas, wall-of-type). The QA step consolidates these MACHINE-
  // measured findings instead of re-deriving overflow by eye (Phase 4 unify).
  renderTruth: build.render_truth ?? null,
});

// 6. Log + manifest.
const ts = Number(process.env.DOGFOOD_TS) || Date.now();
log.runs = log.runs ?? [];
log.runs.push({ ts, url: brand.url, scriptId, angleIndex, warnings: build.warnings ?? {} });
await fs.writeFile(logPath, JSON.stringify(log, null, 2));

out(manifest);
