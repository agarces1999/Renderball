#!/usr/bin/env node
/**
 * Headless per-scene screenshots of a generated composition — SETTLED state.
 *
 * renderStill captures a single isolated frame and does NOT play the comps'
 * entrance animations (it shows a half-faded mid-entrance state regardless of
 * which frame you pick). The MP4 render (renderMedia) DOES play them — it's the
 * real product output. So: render the MP4 once (downscaled for speed, at NATIVE
 * fps so frame-counted animations stay correctly timed), then ffmpeg-extract a
 * frame ~85% through each scene (settled: past entrances, before exits).
 *
 * No dev server, no preview MCP — safe for cron. Needs ffmpeg on PATH (or $FFMPEG).
 * Usage: node scripts/dogfood-stills.mjs <scriptId>
 * Output: .data/dogfood/<scriptId>/scene-<i>.png + a JSON manifest on stdout.
 */
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { execFile } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";

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

const stills = [];
for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  const start = s.start_seconds ?? 0;
  const end = s.end_seconds ?? start + 1;
  const at = Math.min(lastEnd - 0.05, start + Math.max(0, (end - start) * 0.85));
  const file = path.join(outDir, `scene-${i}.png`);
  await extractWithFallback(at, file);
  stills.push({ scene: i, label: s.label ?? "", register: s.register ?? "", atSeconds: Number(at.toFixed(2)), file });
}

// Keep the dir small — drop the intermediate MP4.
await fs.rm(mp4, { force: true });

console.log(JSON.stringify({ scriptId, aspect, outDir, stills }, null, 2));
