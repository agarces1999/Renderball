#!/usr/bin/env node
/**
 * Dev server wrapper — resilient cold-start for the heavy agent routes.
 *
 * Next.js dev compiles a route's module graph on the FIRST request to it. The
 * agent routes (/api/preview/build, /api/dev/generate) pull in the whole
 * pipeline (esbuild, sharp, the Anthropic SDK, the SSR-render gate, font/image
 * inlining) — a large graph. Hitting one COLD with a real POST compiles that
 * graph AND runs a 1-5 minute handler at the same time; the memory/CPU spike
 * intermittently drops the connection or kills the dev worker ("Empty reply from
 * server" / connection refused). The reliable workaround is to compile the route
 * FIRST with a cheap GET (returns 405 without running the handler), so the real
 * POST never compiles-while-running.
 *
 * This wrapper automates that: it starts `next dev` with a higher heap ceiling,
 * then fires a warm-up GET at each heavy route once the server is listening.
 * Best-effort — a failed warm-up never affects the server. Dev-only; production
 * (`next start`) serves pre-built routes and never hits this path.
 *
 * Opt-outs: RB_DEV_NO_WARM=1 skips warming; RB_DEV_HEAP_MB tunes the heap (MB).
 */
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = process.env.PORT || "3000";
const HEAP_MB = process.env.RB_DEV_HEAP_MB || "4096";
const HEAVY_ROUTES = ["/api/preview/build", "/api/dev/generate"];

// Raise the heap so the cold-compile + heavy handler peak doesn't OOM. Append to
// any existing NODE_OPTIONS; inherited by Next's compile workers too.
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${HEAP_MB}`]
    .filter(Boolean)
    .join(" "),
};

// Spawn the local next binary directly (no PATH dependency), forwarding any
// extra args (e.g. `npm run dev -- -p 4000`), stdio, and signals.
const nextBin = path.join(process.cwd(), "node_modules", ".bin", "next");
const child = spawn(nextBin, ["dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

if (process.env.RB_DEV_NO_WARM !== "1") {
  const base = `http://localhost:${PORT}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    // Wait (up to ~90s) for the server to start listening.
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        await fetch(base, { signal: AbortSignal.timeout(3000) });
        up = true;
        break;
      } catch {
        await sleep(1000);
      }
    }
    if (!up) return;
    await sleep(1500); // let the dev server settle before compiling heavy routes
    for (const route of HEAVY_ROUTES) {
      try {
        // GET → 405 (POST-only handlers) but still compiles the route module.
        await fetch(base + route, {
          method: "GET",
          signal: AbortSignal.timeout(120_000),
        });
        console.log(`[dev] pre-compiled ${route}`);
      } catch {
        /* best-effort warm-up; never fatal */
      }
    }
  })();
}
