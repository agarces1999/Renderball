#!/usr/bin/env node
/**
 * One dogfood run — Renderball acting as its own user.
 *
 * 1. Pick the LEAST-recently-used brand from scripts/dogfood-brands.json
 *    (rotation tracked in .data/dogfood-log.json).
 * 2. Generate (crawl + script) + build (design + choreography) it via the dev
 *    server — self-boots `npm run dev` (the warmed wrapper) if it's down.
 * 3. Render a settled PNG per scene (scripts/dogfood-stills.mjs, headless).
 * 4. Print a JSON manifest (scriptId, stills paths, build warnings) the dogfood
 *    AGENT reads to critique + ship fixes, and append to the rotation log.
 *
 * Pure mechanics — no judgment, no code changes. Usage: node scripts/dogfood-run.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";

const root = process.cwd();
const PORT = process.env.PORT || "3000";
const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(JSON.stringify(o, null, 2));

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
const brand = [...brands].sort((a, b) => lastTs(a.url) - lastTs(b.url))[0];
if (!brand) {
  out({ ok: false, stage: "select", error: "no brands configured" });
  process.exit(1);
}

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
  for (const r of ["/api/preview/build", "/api/dev/generate"]) {
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
    { url: brand.url, prompt: brand.prompt, distribution_format: "landscape", duration_seconds: 30 },
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

// 4. Build (design + choreography + gates).
let build;
try {
  build = await postJson("/api/preview/build", { scriptId }, 560_000);
} catch (e) {
  out({ ok: false, stage: "build", url: brand.url, scriptId, error: String(e) });
  process.exit(1);
}
if (!build?.ok) {
  out({ ok: false, stage: "build", url: brand.url, scriptId, error: build?.error ?? "unknown", render_errors: build?.render_errors });
  process.exit(1);
}

// 5. Per-scene stills (headless MP4 render + ffmpeg frame extraction — settled).
await new Promise((resolve, reject) => {
  const c = spawn("node", ["scripts/dogfood-stills.mjs", scriptId], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`stills exited ${code}`))));
});
const stillsDir = path.join(root, ".data", "dogfood", scriptId);
const stills = (await fs.readdir(stillsDir))
  .filter((f) => /^scene-\d+\.png$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)))
  .map((f) => path.join(stillsDir, f));

// 6. Log + manifest.
const ts = Number(process.env.DOGFOOD_TS) || Date.now();
log.runs = log.runs ?? [];
log.runs.push({ ts, url: brand.url, scriptId, warnings: build.warnings ?? {} });
await fs.writeFile(logPath, JSON.stringify(log, null, 2));

out({
  ok: true,
  url: brand.url,
  prompt: brand.prompt,
  scriptId,
  previewUrl: `${base}/preview/${scriptId}`,
  stillsDir,
  stills,
  warnings: build.warnings ?? {},
});
