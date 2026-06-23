// LOOP 1 — the worker. Continuously: pick next brand (round-robin) →
// generate → build → stills → record a per-iteration result + a QA snapshot
// (warnings, render-truth findings, advisory vision findings). Writes a
// heartbeat the watchdog (LOOP 2) reads, and a persistent counter toward the
// target. Designed to run FOREVER until completed >= target, surviving a dev
// server restart underneath it (the watchdog owns the server).
//
// "completed" counts only REAL build verdicts (the build endpoint returned a
// JSON result, ok or content-fail). Infra errors (server down, connection
// reset, http timeout) do NOT count — they back off and retry the same brand,
// so "100 loops" means 100 genuine feedback data points, not server-down noise.
//
// cwd MUST be the repo root (VIDEO_GEN-speed). Run: node scripts/loop/rb-build-loop.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fsp, readFileSync, writeFileSync } from "node:fs";

const LOOPDIR = ".data/loops";
const RESULTS = `${LOOPDIR}/results`;
const STATE = `${LOOPDIR}/state.json`;
const HEARTBEAT = `${LOOPDIR}/heartbeat.json`;
const BRANDS_FILE = "scripts/loop/brands.json";
const PORT = 3007;

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJSON = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
const heartbeat = (phase, slug, iteration, extra = {}) =>
  writeJSON(HEARTBEAT, { ts: nowSec(), iso: new Date().toISOString(), phase, slug, iteration, ...extra });

// A z.ai OUTAGE is NOT a real build verdict — treat it like infra: BACK OFF and
// retry the same brand, never count it. Two families:
//   1. BALANCE/RATE — code 1113 / "insufficient balance" / "please recharge";
//      429 / "too many requests". Without this, when the balance ran out every
//      build failed in <1min, each counted as a failure, and the auto-QA raced
//      the loop to target=100 with ~88 garbage failures (the 2026-06-22 runaway).
//   2. SERVER-OVERLOAD — "overloaded_error" / HTTP 500 "[Operation failed]" /
//      "Internal Network Failure". z.ai has overload spells (pass-2 counted
//      figma+linear+duolingo as failures when they were just 500s). The pipeline
//      now RETRIES these in-stream; this is the loop-level net for when the
//      retries exhaust or the generate path (no stream retry) hits one.
// Outage → pause, don't advance, don't count.
const isOutageErr = (s) =>
  /\b1113\b|insufficient balance|please recharge|rate[ _-]?limit|\b429\b|too many requests|overloaded|operation failed|internal network failure/i.test(
    String(s || ""),
  );

// Resolves with the parsed JSON verdict; REJECTS on an infra error (no server,
// reset, timeout) so the caller can tell "the build ran and failed" (a data
// point) from "we never reached the server" (retry, don't count).
const postHttp = (route, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "localhost", port: PORT, path: route, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => { let buf = ""; res.on("data", (d) => (buf += d));
        res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, json: null, raw: buf.slice(0, 600) }); } }); });
    req.on("error", reject);
    req.setTimeout(timeoutMs);
    req.on("timeout", () => req.destroy(new Error(`http timeout after ${timeoutMs}ms`)));
    req.write(data); req.end();
  });

await fsp.mkdir(RESULTS, { recursive: true });
const brands = readJSON(BRANDS_FILE, { brands: [] }).brands;
if (!brands.length) { console.error("no brands in", BRANDS_FILE); process.exit(1); }

let state = readJSON(STATE, null);
if (!state) { state = { target: 100, built: 0, qa_done: 0, ok: 0, failed: 0, started_at: new Date().toISOString() }; }
// Gate fields: `built` = compositions produced; `qa_done` = builds the agent has
// QA'd + fixed. The worker never lets built run more than 1 ahead of qa_done.
if (state.built === undefined) state.built = state.completed ?? 0;
if (state.qa_done === undefined) state.qa_done = state.completed ?? 0;
writeJSON(STATE, state);

console.log(`[build-loop] up. target=${state.target} built=${state.built} qa_done=${state.qa_done} brands=${brands.length}`);

while (true) {
  state = readJSON(STATE, state);
  if ((state.qa_done ?? 0) >= (state.target ?? 100)) { console.log(`[build-loop] target ${state.target} qa_done reached`); break; }
  // QA GATE: never build ahead of QA. If a built composition still awaits the
  // agent's QA+fix, wait — the fix must land before the next build so quality
  // compounds build-over-build. Safe if the agent is slow/away: it just waits.
  if ((state.built ?? 0) > (state.qa_done ?? 0)) {
    heartbeat("awaiting-qa", state.last?.slug ?? "-", state.built ?? 0, { awaiting: (state.qa_done ?? 0) + 1 });
    await sleep(30_000);
    continue;
  }
  const iteration = (state.built ?? 0) + 1;
  const brand = brands[(iteration - 1) % brands.length];
  const t0 = Date.now();
  const rec = { iteration, slug: brand.slug, url: brand.url, startedAt: new Date().toISOString() };
  let infra = false;

  try {
    heartbeat("generate", brand.slug, iteration);
    let gen;
    try {
      gen = await postHttp("/api/dev/generate",
        { url: brand.url, prompt: brand.prompt, distribution_format: "landscape", duration_seconds: 30 }, 1_200_000);
    } catch (e) { infra = true; throw new Error(`generate INFRA: ${e.message}`); }
    if (!gen.json) { infra = true; throw new Error(`generate non-JSON (status ${gen.status})`); }
    if (!gen.json.ok) {
      // z.ai outage during generate → treat as infra (back off + wait, don't count).
      if (isOutageErr(JSON.stringify(gen.json))) infra = true;
      throw new Error(`generate ${infra ? "OUTAGE" : "rejected"}: ${JSON.stringify(gen.json).slice(0, 200)}`);
    }
    rec.scriptId = gen.json.scriptId;
    rec.scenes = (gen.json.script?.scenes ?? []).map((s, i) => ({ i, label: s.label, headline: s.content?.headline }));

    heartbeat("build", brand.slug, iteration, { scriptId: rec.scriptId });
    let b;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        b = await postHttp("/api/preview/build", { scriptId: rec.scriptId }, 10_800_000); // 3h
      } catch (e) { infra = true; throw new Error(`build INFRA: ${e.message}`); }
      const transient = b.status === 404 || (typeof b.raw === "string" && b.raw.trimStart().startsWith("<"));
      if (!transient) break;
      await sleep(5000);
    }
    if (!b.json) { infra = true; throw new Error(`build non-JSON (status ${b.status})`); }
    rec.build = { ok: b.json.ok, stage: b.json.stage, error: b.json.error, warnings: b.json.warnings ?? null,
      render_errors: b.json.render_errors ?? null,
      render_truth: b.json.render_truth ? { reason: b.json.render_truth.reason, blockingCount: (b.json.render_truth.blocking ?? []).length, blocking: b.json.render_truth.blocking ?? null, steps: b.json.render_truth.steps ?? null } : null };
    rec.vision = b.json.render_truth?.vision ?? null;

    // z.ai outage surfaced as a build verdict (e.g. balance died mid-run) → treat
    // as infra so the loop backs off + waits for recharge instead of counting it
    // and advancing toward target.
    if (!b.json.ok && isOutageErr(b.json.error)) {
      infra = true;
      throw new Error(`build OUTAGE: ${String(b.json.error).slice(0, 140)}`);
    }

    if (b.json.ok) {
      heartbeat("stills", brand.slug, iteration, { scriptId: rec.scriptId });
      await new Promise((resolve) => {
        const c = spawn("node", ["scripts/dogfood-stills.mjs", rec.scriptId], { stdio: "ignore" });
        const k = setTimeout(() => c.kill(), 600_000);
        c.on("exit", () => { clearTimeout(k); resolve(); });
      });
      rec.stillsDir = `${LOOPDIR}/../dogfood/${rec.scriptId}`;
    }
  } catch (e) {
    rec.error = e instanceof Error ? e.message : String(e);
    rec.infra = infra;
  }
  rec.mins = ((Date.now() - t0) / 60000).toFixed(1);
  rec.endedAt = new Date().toISOString();

  if (infra) {
    // Did not reach a build verdict (server down / reset / timeout). Don't count
    // it toward the target; back off so we don't hot-loop, then retry same brand.
    console.log(`[build-loop] iter ${iteration} ${brand.slug}: INFRA (${rec.error}) — backoff 60s, NOT counted`);
    heartbeat("infra-backoff", brand.slug, iteration, { error: rec.error });
    writeJSON(`${RESULTS}/_infra-${nowSec()}-${brand.slug}.json`, rec);
    await sleep(60_000);
    continue; // completed unchanged → same iteration/brand retried
  }

  // Real verdict → record + mark BUILT (awaiting QA). The agent QAs + fixes, then
  // advances qa_done, which releases the gate for the next build.
  const resultPath = `${RESULTS}/${String(iteration).padStart(3, "0")}-${brand.slug}.json`;
  writeJSON(resultPath, rec);
  state = readJSON(STATE, state);
  state.built = iteration;
  if (rec.build?.ok) state.ok = (state.ok ?? 0) + 1; else state.failed = (state.failed ?? 0) + 1;
  state.last = { iteration, slug: brand.slug, ok: rec.build?.ok ?? false, mins: rec.mins,
    visionFindings: Array.isArray(rec.vision) ? rec.vision.length : null, at: rec.endedAt };
  writeJSON(STATE, state);
  writeJSON(`${LOOPDIR}/awaiting_qa.json`, { iteration, slug: brand.slug, scriptId: rec.scriptId ?? null,
    ok: rec.build?.ok ?? false, stillsDir: rec.stillsDir ?? null, resultPath });
  console.log(`[build-loop] iter ${iteration} ${brand.slug}: ${rec.build?.ok ? "OK" : "FAIL(" + rec.build?.stage + ")"} ${rec.mins}m BUILT — awaiting QA (built=${state.built} qa_done=${state.qa_done})`);
  heartbeat("awaiting-qa", brand.slug, iteration, { ok: rec.build?.ok ?? false });
  await sleep(3000);
}
heartbeat("finished", "-", (readJSON(STATE, state).qa_done ?? 0));
console.log("[build-loop] finished.");
