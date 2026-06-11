#!/usr/bin/env node
/**
 * Headless per-scene screenshots of a generated composition — HONEST frames.
 *
 * renderStill captures a single isolated frame and does NOT play the comps'
 * entrance animations (it shows a half-faded mid-entrance state regardless of
 * which frame you pick). The MP4 render (renderMedia) DOES play them — it's the
 * real product output. So: render the MP4 once (downscaled for speed, at NATIVE
 * fps so frame-counted animations stay correctly timed), then ffmpeg-extract
 * frames from it.
 *
 * A single fixed-timestamp frame (the old 85% approach) misreads scenes whose
 * choreography builds late or exits early — and it can't tell "this scene's
 * content never paints in the export" (the sentry invisible-text bug) from
 * "we sampled an awkward moment". So each scene is sampled at several progress
 * points, every candidate is scored with the painted-content lib (ink = pixels
 * differing from the dominant background tone), and the MAX-ink frame becomes
 * scene-<i>.png — the loop's critique input. The manifest carries a paint
 * report (per-scene inkRatio + empty quadrants + low-ink flags) so the loop
 * critiques pixel truth, not luck-of-the-timestamp.
 *
 * No dev server, no preview MCP — safe for cron. Needs ffmpeg on PATH (or $FFMPEG).
 * Usage: node scripts/dogfood-stills.mjs <scriptId>
 *   DOGFOOD_KEEP_CANDIDATES=1   also keep every candidate in scene-<i>-all/
 * Output: .data/dogfood/<scriptId>/scene-<i>.png + a JSON manifest on stdout.
 */
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import * as esbuild from "esbuild";
import { execFile } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const scriptId = process.argv[2];
if (!scriptId) {
  console.error("usage: node scripts/dogfood-stills.mjs <scriptId>");
  process.exit(1);
}

const root = process.cwd();
const genDir = path.join(root, "src", "generated", scriptId);
const script = JSON.parse(
  await fs.readFile(path.join(root, ".data", "scripts", `${scriptId}.json`), "utf8"),
);
const fps = script.config?.fps ?? 30;
const aspect = script.config?.aspect_ratio ?? "16:9";
const dims =
  aspect === "9:16"
    ? { width: 1080, height: 1920 }
    : aspect === "1:1"
      ? { width: 1080, height: 1080 }
      : { width: 1920, height: 1080 };
const scenes = Array.isArray(script.scenes) ? script.scenes : [];
const lastEnd = Math.max(1, ...scenes.map((s) => s.end_seconds ?? 0));
const totalFrames = Math.max(1, Math.round(lastEnd * fps));

const outDir = path.join(root, ".data", "dogfood", scriptId);
await fs.mkdir(outDir, { recursive: true });
const mp4 = path.join(outDir, "_full.mp4");

// Painted-content scoring — bundle the TS lib once (esbuild, same trick as
// scripts/run-tests.mjs) so this script shares the EXACT ink logic the unit
// tests lock down, instead of a drifting inline copy. The bundle lands inside
// the project so its external `sharp` import resolves against node_modules.
const paintLibOut = path.join(root, "node_modules", ".cache", "rb-dogfood", "painted-content.mjs");
await fs.mkdir(path.dirname(paintLibOut), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, "lib", "render", "painted-content.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  outfile: paintLibOut,
  logLevel: "silent",
});
const { verifyPaintedScenes, INK_FLOOR, QUADRANT_FLOOR } = await import(
  pathToFileURL(paintLibOut).href
);

// Render the MP4 (downscaled 0.5 for speed; native fps so animations are timed
// correctly). This plays every entrance/sustained animation.
const bundleLocation = await bundle({
  entryPoint: path.join(genDir, "index.tsx"),
  outDir: path.join(root, ".data", "render-bundle", scriptId),
});
const base = await selectComposition({
  serveUrl: bundleLocation,
  id: "Generated",
  inputProps: { script },
});
await renderMedia({
  composition: { ...base, width: dims.width, height: dims.height, durationInFrames: totalFrames, fps },
  serveUrl: bundleLocation,
  codec: "h264",
  outputLocation: mp4,
  inputProps: { script },
  scale: 0.5,
});

// ffmpeg frame extraction (robust to PATH: $FFMPEG → ffmpeg → common abs paths).
const ffmpegCandidates = [process.env.FFMPEG, "ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter(Boolean);
const extract = (bin, t, file) =>
  new Promise((resolve, reject) => {
    execFile(bin, ["-ss", String(t), "-i", mp4, "-frames:v", "1", "-y", file, "-loglevel", "error"], (err) =>
      err ? reject(err) : resolve(),
    );
  });
const extractWithFallback = async (t, file) => {
  for (const bin of ffmpegCandidates) {
    try {
      await extract(bin, t, file);
      return true;
    } catch (e) {
      if (e?.code === "ENOENT") continue; // try next ffmpeg path
      throw e;
    }
  }
  throw new Error("ffmpeg not found (set $FFMPEG)");
};

// Candidate frames per scene: early build-up through near-exit. The max-ink
// candidate becomes the scene's still; the spread means a scene only scores
// low if it NEVER paints (the renderer-dropped-animation failure mode), not
// because one timestamp landed mid-choreography.
const CANDIDATE_PERCENTS = [0.35, 0.55, 0.7, 0.85, 0.97];
const keepCandidates = process.env.DOGFOOD_KEEP_CANDIDATES === "1";

const sceneCandidates = []; // [{ percent, atSeconds, file }] per scene
for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  const start = s.start_seconds ?? 0;
  const end = s.end_seconds ?? start + 1;
  const candDir = path.join(outDir, `scene-${i}-all`);
  await fs.rm(candDir, { recursive: true, force: true }); // no stale candidates
  await fs.mkdir(candDir, { recursive: true });
  const candidates = [];
  for (const p of CANDIDATE_PERCENTS) {
    const at = Math.min(lastEnd - 0.05, start + Math.max(0, (end - start) * p));
    const file = path.join(candDir, `p${Math.round(p * 100)}.png`);
    await extractWithFallback(at, file);
    candidates.push({ percent: p, atSeconds: Number(at.toFixed(2)), file });
  }
  sceneCandidates.push(candidates);
}

// Score every candidate; per-scene verdicts come from the max-ink frame.
const paint = await verifyPaintedScenes(sceneCandidates.map((c) => c.map((x) => x.file)));

// Keep the best frame as the scene's still (the loop's critique input).
const stills = [];
for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  const verdict = paint.scenes[i];
  const candidates = sceneCandidates[i];
  const best = candidates[Math.max(0, verdict.bestFrame)];
  const file = path.join(outDir, `scene-${i}.png`);
  await fs.copyFile(best.file, file);
  if (!keepCandidates) {
    await fs.rm(path.join(outDir, `scene-${i}-all`), { recursive: true, force: true });
  }
  stills.push({
    scene: i,
    label: s.label ?? "",
    register: s.register ?? "",
    atSeconds: best.atSeconds,
    percent: best.percent,
    file,
    inkRatio: Number(verdict.inkRatio.toFixed(4)),
    emptyQuadrants: verdict.emptyQuadrants,
    flags: verdict.flags,
    candidates: candidates.map((c, k) => ({
      percent: c.percent,
      atSeconds: c.atSeconds,
      inkRatio: Number(verdict.frames[k].inkRatio.toFixed(4)),
    })),
  });
}

// Keep the dir small — drop the intermediate MP4.
await fs.rm(mp4, { force: true });

console.log(
  JSON.stringify(
    {
      scriptId,
      aspect,
      outDir,
      stills,
      // Paint report — pixel truth per scene. "low-ink" here means the scene's
      // BEST frame is near-blank in the actual export: the invisible-content
      // bug, not a sampling artifact. "empty-quadrant" is the pixel version of
      // the 100%-screen-usage rule.
      paint: {
        ok: paint.ok,
        floors: { inkFloor: INK_FLOOR, quadrantFloor: QUADRANT_FLOOR },
        scenes: paint.scenes.map((v) => ({
          scene: v.scene,
          ok: v.ok,
          flags: v.flags,
          inkRatio: Number(v.inkRatio.toFixed(4)),
          quadrants: Object.fromEntries(
            Object.entries(v.quadrants).map(([k, x]) => [k, Number(x.toFixed(4))]),
          ),
          emptyQuadrants: v.emptyQuadrants,
        })),
      },
    },
    null,
    2,
  ),
);
