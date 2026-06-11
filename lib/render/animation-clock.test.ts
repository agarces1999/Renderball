/**
 * Render-truth proof for the CSS-animation clock (the dropped-animation bug).
 *
 * Run: `node scripts/run-tests.mjs lib/render/animation-clock.test.ts`
 * (repo root — fixtures + node_modules resolve via process.cwd()). No API
 * key, no network. Needs ffmpeg (/opt/homebrew/bin/ffmpeg or on PATH) and
 * the Remotion headless shell (cached after any prior render).
 *
 * THE BUG (verified empirically on src/generated/01KTQH4GC70VM6R4412Q729152):
 * elements at opacity:0 animated with a LONG animation-delay (>= ~2.3s) +
 * fill forwards never painted in the MP4 at ANY timestamp, while short
 * delays (<= 0.75s) in the same section painted fine — and the browser
 * preview played all of them. The export silently lost approved content.
 *
 * THE FIX lives in buildIndexTsx (build-wrapper.ts): during rendering only,
 * a SectionClock wrapper pins every Web Animations API animation in each
 * section's subtree to the Remotion frame (anim.currentTime = frame/fps*1000,
 * scene-relative), so delays elapse, fills hold, and loops cycle exactly as
 * wall-clock playback would.
 *
 * Unlike every other gate (static checks, SSR), this test renders REAL MP4
 * FRAMES through bundle() + renderMedia() — the production path — then
 * crops fixed regions with sharp and asserts luminance:
 *   frame @1.0s  → scene 0 text painted        (render sanity control)
 *   frame @3.0s  → scene 1 control painted,    (short delay still works)
 *                  delayed payoff NOT painted  (delay is scene-relative,
 *                                               not jammed to end state)
 *   frame @5.5s  → delayed payoff painted      (THE dropped case, fixed)
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import sharp from "sharp";
import type { Script } from "../../src/schema";
import {
  buildIndexTsx,
  writeGeneratedFiles,
  RENDER_FPS,
  RENDER_QUALITY,
  totalFramesForScript,
  dimensionsForScript,
} from "./build-wrapper";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;
// Async variant of the check() pattern (render-gate.test.ts) — renders are
// async, so each check is awaited at top level.
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg")
  ? "/opt/homebrew/bin/ffmpeg"
  : "ffmpeg";

// ── Fixtures ────────────────────────────────────────────────────────────────
const FIXTURES = path.join(process.cwd(), "lib", "render", "__fixtures__");
if (!existsSync(FIXTURES)) {
  throw new Error(
    `fixtures not found at ${FIXTURES} — run tests from the repo root`,
  );
}
const CODE = await fs.readFile(
  path.join(FIXTURES, "delayed-animation-composition.tsx.txt"),
  "utf-8",
);
const SCRIPT = JSON.parse(
  await fs.readFile(path.join(FIXTURES, "delayed-animation-script.json"), "utf-8"),
) as Script;

// The genDir must live INSIDE the project so Remotion's webpack resolves
// remotion/react against the project's node_modules (a tmpdir() genDir
// cannot). .data/ is gitignored — same home as the render-bundle cache.
const WORK = path.join(
  process.cwd(),
  ".data",
  "anim-clock-test",
  `run-${Date.now()}`,
);

// Output frames are 1920x1080 × scale 0.25 = 480x270. Crop regions sized to
// the fixture's layout (regions in OUTPUT pixels). White text on #000 — a
// painted region has mean luminance well above 10; unpainted is ~0.
const SCALE = 0.25;
const REGIONS = {
  /** Scene 0 headline, centered (fontSize 120 @1080p). */
  sceneZero: { left: 100, top: 110, width: 280, height: 50 },
  /** Scene 1 "CONTROL" top band (top:40, fontSize 64 @1080p). */
  control: { left: 180, top: 6, width: 120, height: 30 },
  /** Scene 1 "DELAYED PAYOFF", centered (fontSize 150 @1080p). */
  payoff: { left: 110, top: 112, width: 260, height: 46 },
} as const;
const PAINTED_FLOOR = 10; // mean 8-bit luminance; painted text measures ~40-90
const UNPAINTED_CEIL = 4; // pure background measures ~0

const extractFrame = async (
  mp4: string,
  seconds: number,
  outPng: string,
): Promise<void> => {
  await execFileAsync(FFMPEG, [
    "-ss",
    String(seconds),
    "-i",
    mp4,
    "-frames:v",
    "1",
    "-y",
    outPng,
  ]);
};

// Mean 8-bit luminance of a crop, computed from raw pixels. NOTE: sharp's
// .stats() ignores preceding pipeline ops (it reads the ORIGINAL input), so
// .extract(...).stats() would silently measure the whole frame — go through
// .raw().toBuffer() instead.
const regionLuminance = async (
  png: string,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> => {
  const buf = await sharp(png).extract(region).greyscale().raw().toBuffer();
  let sum = 0;
  for (const px of buf) sum += px;
  return sum / buf.length;
};

try {
  // ── 1: the emitted wrapper carries the render-only animation clock ────────
  await check("index.tsx wraps every Sequence in the render-only SectionClock", async () => {
    const index = buildIndexTsx(SCRIPT);
    assert(index.includes("SectionClock"), "no SectionClock in emitted index.tsx");
    assert(
      index.includes("getAnimations"),
      "SectionClock does not sync via element.getAnimations",
    );
    assert(
      index.includes("isRendering"),
      "SectionClock is not gated on getRemotionEnvironment().isRendering — it would hijack live playback",
    );
    // Every scene's section must be inside the clock.
    const sequences = index.match(/<Sequence /g) ?? [];
    const clocks = index.match(/<SectionClock>/g) ?? [];
    assert(
      sequences.length === SCRIPT.scenes.length &&
        clocks.length === SCRIPT.scenes.length,
      `expected ${SCRIPT.scenes.length} Sequence+SectionClock pairs, got ${sequences.length}/${clocks.length}`,
    );
  });

  // ── 2: render the fixture through the REAL production path ────────────────
  const genDir = path.join(WORK, "gen");
  await writeGeneratedFiles(genDir, {
    designCode: CODE,
    code: CODE,
    script: SCRIPT,
  });

  const bundleLocation = await bundle({
    entryPoint: path.join(genDir, "index.tsx"),
    outDir: path.join(WORK, "bundle"),
  });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "Generated",
    inputProps: { script: SCRIPT },
    logLevel: "error",
  });

  const dims = dimensionsForScript(SCRIPT);
  const mp4 = path.join(WORK, "out.mp4");
  await renderMedia({
    composition: {
      ...composition,
      width: dims.width,
      height: dims.height,
      durationInFrames: totalFramesForScript(SCRIPT),
      fps: RENDER_FPS,
    },
    serveUrl: bundleLocation,
    outputLocation: mp4,
    inputProps: { script: SCRIPT },
    ...RENDER_QUALITY,
    // Small + chunked: scale keeps it fast; concurrency 2 forces the second
    // page to seek INTO scene 1 mid-flight (fresh mount at a nonzero frame),
    // the same arbitrary-seek case production chunking hits.
    scale: SCALE,
    concurrency: 2,
    logLevel: "error",
  });

  const early = path.join(WORK, "t1.0.png"); // scene 0
  const mid = path.join(WORK, "t3.0.png"); //   scene 1 @ local 1.0s
  const late = path.join(WORK, "t5.5.png"); //  scene 1 @ local 3.5s
  await extractFrame(mp4, 1.0, early);
  await extractFrame(mp4, 3.0, mid);
  await extractFrame(mp4, 5.5, late);

  await check("control: scene 0 text paints (the render itself works)", async () => {
    const lum = await regionLuminance(early, REGIONS.sceneZero);
    assert(
      lum > PAINTED_FLOOR,
      `scene 0 headline unpainted (mean luminance ${lum.toFixed(1)} <= ${PAINTED_FLOOR}) — render is broken, later checks are meaningless`,
    );
  });

  await check("control: short-delay (0.3s) text paints in scene 1", async () => {
    const lum = await regionLuminance(mid, REGIONS.control);
    assert(
      lum > PAINTED_FLOOR,
      `short-delay control unpainted at t=3.0s (mean ${lum.toFixed(1)} <= ${PAINTED_FLOOR})`,
    );
  });

  await check("delay is scene-relative: payoff NOT painted at scene-local 1.0s", async () => {
    const lum = await regionLuminance(mid, REGIONS.payoff);
    assert(
      lum < UNPAINTED_CEIL,
      `payoff visible too early (mean ${lum.toFixed(1)} >= ${UNPAINTED_CEIL}) — the clock is using absolute time or jamming animations to end state`,
    );
  });

  await check("THE BUG: 2.5s-delayed text PAINTS in the rendered MP4", async () => {
    const lum = await regionLuminance(late, REGIONS.payoff);
    assert(
      lum > PAINTED_FLOOR,
      `delayed payoff never painted (mean luminance ${lum.toFixed(1)} <= ${PAINTED_FLOOR}) — the renderer dropped a delayed CSS animation the preview plays`,
    );
  });

  await check("short-delay control still painted at the late frame (fill holds)", async () => {
    const lum = await regionLuminance(late, REGIONS.control);
    assert(
      lum > PAINTED_FLOOR,
      `control text vanished by t=5.5s (mean ${lum.toFixed(1)} <= ${PAINTED_FLOOR}) — fill-forwards state not held`,
    );
  });
} finally {
  if (failed === 0) {
    await fs.rm(WORK, { recursive: true, force: true });
  } else {
    console.log(`  (artifacts kept for debugging: ${WORK})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
