/**
 * Tests for painted-content verification (pixel truth for rendered frames).
 *
 * Run: `node scripts/run-tests.mjs lib/render/painted-content.test.ts`
 * (from the repo root). No API key, no network.
 *
 * Two layers:
 *  1. SYNTHETIC frames (built in-memory with sharp) lock the measurement
 *     mechanics: solid = no ink, a painted block = proportional ink in the
 *     right quadrant, backdrop gradients don't count as ink, best-frame
 *     selection, and the flag logic.
 *  2. REAL dogfood frames (.data/dogfood/*-settled/, present on the dev/loop
 *     machine, gitignored) lock the CALIBRATION: the sentry invisible-text
 *     scene — content that plays in the browser preview but never paints in
 *     the rendered MP4 — must flag LOW ink, while sparse-but-real dark-UI
 *     frames (raycast) and rich frames (posthog) must pass. When .data is
 *     absent (fresh clone / CI), that layer is skipped with a notice; the
 *     synthetic layer still runs everywhere.
 */
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import {
  assessFrameInk,
  assessEmptyBand,
  assessEmptyColumnRun,
  assessRegionInk,
  largestEmptyRun,
  verifyPaintedScenes,
  INK_FLOOR,
  QUADRANT_FLOOR,
  COLUMN_INK_FLOOR,
} from "./painted-content";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
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

// ── Synthetic frame builders ───────────────────────────────────────────────
const W = 320;
const H = 180;

const solid = (rgb: { r: number; g: number; b: number }): Promise<Buffer> =>
  sharp({ create: { width: W, height: H, channels: 3, background: rgb } })
    .png()
    .toBuffer();

/** Dark frame with a bright block at (left, top, w, h). */
const withBlock = async (
  left: number,
  top: number,
  w: number,
  h: number,
): Promise<Buffer> => {
  const block = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 16, g: 16, b: 24 } },
  })
    .composite([{ input: block, left, top }])
    .png()
    .toBuffer();
};

/** Vertical backdrop gradient (±8 per channel around a dark tone) — the kind
 * of soft wash the generated comps use as scene backgrounds. */
const gradient = (): Promise<Buffer> => {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = Math.round(30 + (16 * y) / (H - 1)); // 30 → 46
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      raw[p] = v;
      raw[p + 1] = v;
      raw[p + 2] = v + 10;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
};

// ── Layer 1: measurement mechanics (synthetic, runs everywhere) ────────────
await check("a solid frame has ~zero ink in every quadrant", async () => {
  const r = await assessFrameInk(await solid({ r: 20, g: 24, b: 32 }));
  assert(r.inkRatio < 0.001, `inkRatio ${r.inkRatio} should be ~0`);
  for (const k of ["tl", "tr", "bl", "br"] as const) {
    assert(r.quadrants[k] < 0.001, `quadrant ${k} ${r.quadrants[k]} should be ~0`);
  }
});

await check("a soft backdrop gradient does NOT count as ink", async () => {
  const r = await assessFrameInk(await gradient());
  assert(r.inkRatio < 0.001, `gradient measured ${r.inkRatio} ink — bg detection broken`);
});

await check("a bright block measures proportional ink in the right quadrant", async () => {
  // Block fills the top-left quadrant exactly: 25% of the frame, ~100% of tl.
  const r = await assessFrameInk(await withBlock(0, 0, W / 2, H / 2));
  assert(Math.abs(r.inkRatio - 0.25) < 0.02, `inkRatio ${r.inkRatio}, expected ~0.25`);
  assert(r.quadrants.tl > 0.95, `tl ${r.quadrants.tl} should be ~1`);
  assert(r.quadrants.tr < 0.01, `tr ${r.quadrants.tr} should be ~0`);
  assert(r.quadrants.bl < 0.01, `bl ${r.quadrants.bl} should be ~0`);
  assert(r.quadrants.br < 0.01, `br ${r.quadrants.br} should be ~0`);
});

await check("background tone is reported (diagnostics)", async () => {
  const r = await assessFrameInk(await solid({ r: 40, g: 50, b: 60 }));
  assert(
    Math.abs(r.background.r - 40) <= 2 &&
      Math.abs(r.background.g - 50) <= 2 &&
      Math.abs(r.background.b - 60) <= 2,
    `background ${JSON.stringify(r.background)} should be ~(40,50,60)`,
  );
});

await check("verifyPaintedScenes flags a blank scene as low-ink + empty quadrants", async () => {
  const report = await verifyPaintedScenes([[await solid({ r: 18, g: 18, b: 26 })]]);
  assert(!report.ok, "report should not be ok");
  const v = report.scenes[0];
  assert(v.flags.includes("low-ink"), `flags ${JSON.stringify(v.flags)} missing low-ink`);
  assert(
    v.flags.includes("empty-quadrant") && v.emptyQuadrants.length === 4,
    "all four quadrants should be empty",
  );
});

await check("verifyPaintedScenes judges the scene on its BEST (max-ink) frame", async () => {
  // Frame 0 is blank (the build-up moment), frame 1 is fully painted across
  // all quadrants (the settled moment). The scene must pass on frame 1.
  const blank = await solid({ r: 16, g: 16, b: 24 });
  const painted = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 16, g: 16, b: 24 } },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: W - 20,
            height: H - 20,
            channels: 3,
            background: { r: 230, g: 230, b: 230 },
          },
        })
          .png()
          .toBuffer(),
        left: 10,
        top: 10,
      },
    ])
    .png()
    .toBuffer();
  const report = await verifyPaintedScenes([[blank, painted]]);
  const v = report.scenes[0];
  assert(v.bestFrame === 1, `bestFrame ${v.bestFrame}, expected 1`);
  assert(v.ok, `scene should pass on its best frame, flags ${JSON.stringify(v.flags)}`);
  assert(v.frames.length === 2, "all candidate scores reported");
  assert(v.frames[0].inkRatio < v.frames[1].inkRatio, "candidate scores in input order");
});

await check("a painted scene with one dead quadrant flags empty-quadrant only", async () => {
  // Text-sized bright blocks in tl/tr/bl, nothing in br. The dark background
  // stays dominant (blocks cover ~5% of the frame, comfortably > INK_FLOOR).
  const block = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 235, g: 235, b: 235 } },
  })
    .png()
    .toBuffer();
  const frame = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 16, g: 16, b: 24 } },
  })
    .composite([
      { input: block, left: 20, top: 20 }, // tl
      { input: block, left: W - 60, top: 20 }, // tr
      { input: block, left: 20, top: H - 60 }, // bl
    ])
    .png()
    .toBuffer();
  const report = await verifyPaintedScenes([[frame]]);
  const v = report.scenes[0];
  assert(!v.flags.includes("low-ink"), "plenty of ink — must not flag low-ink");
  assert(
    v.flags.includes("empty-quadrant") &&
      v.emptyQuadrants.length === 1 &&
      v.emptyQuadrants[0] === "br",
    `expected only br empty, got ${JSON.stringify(v.emptyQuadrants)}`,
  );
});

await check("a scene with no frames is flagged no-frames (not ok)", async () => {
  const report = await verifyPaintedScenes([[]]);
  assert(!report.ok, "no frames cannot be ok");
  assert(report.scenes[0].flags.includes("no-frames"), "missing no-frames flag");
  assert(report.scenes[0].bestFrame === -1, "bestFrame is -1");
});

// ── Layer 2: calibration lock against the REAL dogfood frames ──────────────
// These are the frames the floors were calibrated on (see painted-content.ts
// header). Sentry scene-1 is the empirically broken scene: its text plays in
// the browser preview but never paints in the rendered MP4.
const DOGFOOD = path.join(process.cwd(), ".data", "dogfood");
const SENTRY = path.join(DOGFOOD, "01KTQH4GC70VM6R4412Q729152-settled");
const RAYCAST = path.join(DOGFOOD, "01KTQG2M93MDZV1EMGN2WQ211V-settled");
const POSTHOG = path.join(DOGFOOD, "01KTQJCFVKEJYFK06FX52NCMGT-settled");

const realFrames = {
  sentryBroken: path.join(SENTRY, "scene-1-p60.png"),
  raycastRich: path.join(RAYCAST, "scene-2-p80.png"),
  raycastSparse: path.join(RAYCAST, "scene-1.png"),
  posthogRich: path.join(POSTHOG, "scene-4.png"),
};
const haveRealFrames = Object.values(realFrames).every((f) => existsSync(f));

if (!haveRealFrames) {
  console.log(
    "  - SKIP real-frame calibration checks (.data/dogfood/*-settled/ not on disk — gitignored; synthetic layer above still covers the mechanics)",
  );
} else {
  await check("REAL: sentry invisible-text frame (scene-1-p60) flags LOW ink", async () => {
    const r = await assessFrameInk(realFrames.sentryBroken);
    assert(
      r.inkRatio < INK_FLOOR,
      `sentry broken frame inkRatio ${r.inkRatio.toFixed(4)} should be < floor ${INK_FLOOR}`,
    );
  });

  await check("REAL: raycast scene-2-p80 (rich dark-UI frame) passes both rules", async () => {
    const report = await verifyPaintedScenes([[realFrames.raycastRich]]);
    const v = report.scenes[0];
    assert(v.ok, `raycast rich frame should pass, flags ${JSON.stringify(v.flags)} ink ${v.inkRatio.toFixed(4)}`);
  });

  await check("REAL: posthog scene-4 (rich frame) passes both rules", async () => {
    const report = await verifyPaintedScenes([[realFrames.posthogRich]]);
    const v = report.scenes[0];
    assert(v.ok, `posthog rich frame should pass, flags ${JSON.stringify(v.flags)} ink ${v.inkRatio.toFixed(4)}`);
  });

  await check("REAL: sparse-but-real dark UI (raycast scene-1) clears the ink floor", async () => {
    // The reason INK_FLOOR is 0.02 and not the a-priori 0.04: this legitimate
    // command-palette-on-black frame measures ~0.034. If this check starts
    // failing after a floor change, the floor is flagging real content.
    const r = await assessFrameInk(realFrames.raycastSparse);
    assert(
      r.inkRatio >= INK_FLOOR,
      `legit sparse frame inkRatio ${r.inkRatio.toFixed(4)} fell below floor ${INK_FLOOR}`,
    );
  });

  await check("REAL: end-to-end scene verdicts separate broken from healthy", async () => {
    // Scene 0 = the broken sentry scene's candidates; scene 1 = posthog's
    // rich candidates. Exactly the broken one must flag.
    const report = await verifyPaintedScenes([
      [
        path.join(SENTRY, "scene-1-p30.png"),
        path.join(SENTRY, "scene-1-p60.png"),
        path.join(SENTRY, "scene-1-p80.png"),
        path.join(SENTRY, "scene-1.png"),
      ],
      [
        path.join(POSTHOG, "scene-4-p30.png"),
        path.join(POSTHOG, "scene-4-p60.png"),
        path.join(POSTHOG, "scene-4-p80.png"),
        path.join(POSTHOG, "scene-4.png"),
      ],
    ]);
    assert(!report.ok, "report must not be ok while a scene is broken");
    assert(
      report.scenes[0].flags.includes("low-ink"),
      `sentry scene must flag low-ink even on its best frame (ink ${report.scenes[0].inkRatio.toFixed(4)})`,
    );
    assert(report.scenes[1].ok, `posthog scene must pass, flags ${JSON.stringify(report.scenes[1].flags)}`);
  });

  await check("REAL: quadrant floor keeps clear margin on the rich frames", async () => {
    // raycast scene-2-p80's lightest quadrant measured ~0.0079 at calibration
    // (vs floor 0.004). QUADRANT_FLOOR must keep meaningful headroom under it
    // or asymmetric-but-rich layouts start flagging.
    const r = await assessFrameInk(realFrames.raycastRich);
    const lightest = Math.min(r.quadrants.tl, r.quadrants.tr, r.quadrants.bl, r.quadrants.br);
    assert(
      lightest >= QUADRANT_FLOOR * 1.5,
      `lightest quadrant ${lightest.toFixed(4)} too close to floor ${QUADRANT_FLOOR}`,
    );
  });
}

// ── largestEmptyRun (pure — the band-scan core) ────────────────────────────
await check("largestEmptyRun: finds the longest empty run in range", () => {
  // filled at 2,3 and 7 → empty runs [0,1]=2, [4,6]=3, [8,9]=2 within [0,10)
  const e = [true, true, false, false, true, true, true, false, true, true];
  const r = largestEmptyRun(e, 0, 10);
  assert(r.len === 3 && r.start === 4, `got len=${r.len} start=${r.start}`);
});
await check("largestEmptyRun: respects the [lo,hi) window (margins excluded)", () => {
  // all empty, but window is [3,7) → longest run is 4 starting at 3
  const e = new Array(10).fill(true);
  const r = largestEmptyRun(e, 3, 7);
  assert(r.len === 4 && r.start === 3, `got len=${r.len} start=${r.start}`);
});
await check("largestEmptyRun: no empty rows → len 0", () => {
  const r = largestEmptyRun(new Array(10).fill(false), 0, 10);
  assert(r.len === 0, `got ${r.len}`);
});
await check("largestEmptyRun: a run ending exactly at hi is counted", () => {
  // empty from 5..9; window [0,10) → run len 5 start 5
  const e = [false, false, false, false, false, true, true, true, true, true];
  const r = largestEmptyRun(e, 0, 10);
  assert(r.len === 5 && r.start === 5, `got len=${r.len} start=${r.start}`);
});

// ── assessEmptyBand (pixel band on synthetic frames) ───────────────────────
// bright content on a dark bg (bg is the majority ⇒ dominant-background = dark).
const withBlocks = async (rects: [number, number, number, number][]): Promise<Buffer> => {
  const blocks = await Promise.all(
    rects.map(async ([, , w, h]) =>
      sharp({ create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer(),
    ),
  );
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 16, g: 16, b: 24 } } })
    .composite(blocks.map((input, i) => ({ input, left: rects[i][0], top: rects[i][1] })))
    .png()
    .toBuffer();
};

await check("assessEmptyBand: a top-only content cluster ⇒ large empty band below", async () => {
  // one bright strip in the top 22% (y 0..40 of 180); interior [18,162) mostly empty
  const r = await assessEmptyBand(await withBlocks([[0, 0, W, 40]]));
  assert(r.bandFracH > 0.55, `expected a big band, got ${r.bandFracH.toFixed(2)}`);
});

await check("assessEmptyBand: a barbell (top + bottom, empty middle) fires", async () => {
  // cluster at top (y 8..44) and bottom (y 150..168), empty middle ~106px = 59%H
  const r = await assessEmptyBand(await withBlocks([[0, 8, W, 36], [0, 150, W, 18]]));
  assert(r.bandFracH >= 0.3, `barbell should exceed the 0.30 gate, got ${r.bandFracH.toFixed(2)}`);
});

await check("assessEmptyBand: content spanning the interior ⇒ small band (no fire)", async () => {
  // a centered column covering y 30..150 (67% of H) with columns 80..240 (real ink rows)
  const r = await assessEmptyBand(await withBlocks([[80, 30, 160, 120]]));
  assert(r.bandFracH < 0.3, `filled interior must not fire, got ${r.bandFracH.toFixed(2)}`);
});

await check("assessEmptyBand: thin bars across a row keep it filled (waveform case)", async () => {
  // 20 thin 4px bars at the SAME rows (y 70..110) — a waveform. The bars ARE ink,
  // so the mid band is filled; only the top/bottom margins are empty (< gate).
  const bars: [number, number, number, number][] = [];
  for (let i = 0; i < 20; i++) bars.push([10 + i * 15, 70, 4, 40]);
  const r = await assessEmptyBand(await withBlocks(bars));
  // top gap [18,70)=52px=29% and bottom [110,162)=52px=29% — each under 30%; the
  // waveform band itself is NOT counted empty (proves thin bars register as ink).
  assert(r.bandFracH < 0.3, `waveform rows must read filled, got ${r.bandFracH.toFixed(2)} at ${r.startFracH.toFixed(2)}`);
});

// ── v15: assessEmptyColumnRun (the vertical twin of assessEmptyBand) ──────────
const CW = 320;
const CH = 200;
const colFrame = (rects: { x: number; w: number; color?: { r: number; g: number; b: number } }[]): Promise<Buffer> =>
  sharp({ create: { width: CW, height: CH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(rects.map((r) => ({ input: { create: { width: r.w, height: CH, channels: 3, background: r.color ?? { r: 0, g: 0, b: 0 } } }, top: 0, left: r.x })))
    .png()
    .toBuffer();

await check("assessEmptyColumnRun: left-only content leaves a wide RIGHT void", async () => {
  const buf = await colFrame([{ x: 0, w: 128 }]); // 40% inked left, 60% void right
  const r = await assessEmptyColumnRun(buf, { colInkFloor: COLUMN_INK_FLOOR });
  assert(r.runFracW > 0.55 && r.runFracW < 0.65, `right void ~0.6, got ${r.runFracW.toFixed(2)}`);
  assert(r.startFracW > 0.35 && Math.abs(r.endFracW - 1) < 0.05, `band right-anchored, got [${r.startFracW.toFixed(2)},${r.endFracW.toFixed(2)}]`);
});

await check("assessEmptyColumnRun: a fully-furnished frame reports a small run", async () => {
  const buf = await colFrame([
    { x: 20, w: 30 }, { x: 110, w: 30 }, { x: 200, w: 30 }, { x: 280, w: 30 },
  ]);
  const r = await assessEmptyColumnRun(buf, { colInkFloor: COLUMN_INK_FLOOR });
  assert(r.runFracW < 0.23, `furnished → small run, got ${r.runFracW.toFixed(2)}`);
});

await check("assessEmptyColumnRun: a faint HORIZONTAL hairline (below the column floor) does NOT break a void", async () => {
  // A 2px-tall rule across the void: each column it crosses carries 2/200 = 1%
  // ink ≪ the 1.5% column floor, so the void stays contiguous.
  const buf = await sharp({ create: { width: CW, height: CH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([
      { input: { create: { width: 128, height: CH, channels: 3, background: { r: 0, g: 0, b: 0 } } }, top: 0, left: 0 },
      { input: { create: { width: 160, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }, top: 100, left: 140 },
    ])
    .png()
    .toBuffer();
  const r = await assessEmptyColumnRun(buf, { colInkFloor: COLUMN_INK_FLOOR });
  assert(r.runFracW > 0.55, `hairline doesn't split the void, got ${r.runFracW.toFixed(2)}`);
});

await check("assessRegionInk: a painted region reports its ink share; a blank region ~0", async () => {
  const buf = await colFrame([{ x: 0, w: 100 }]); // left ~31% black, white clearly dominant
  const [inked, blank] = await assessRegionInk(buf, [
    { x: 0, y: 0, w: 0.3, h: 1 },
    { x: 0.6, y: 0, w: 0.4, h: 1 },
  ]);
  assert(inked > 0.9, `left region inked, got ${inked.toFixed(2)}`);
  assert(blank < 0.05, `right region blank, got ${blank.toFixed(2)}`);
  assert((await assessRegionInk(buf, [])).length === 0, "empty region list → empty result");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
