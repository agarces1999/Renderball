/**
 * Tests for the v15 per-text-node contrast gate (Lever C).
 *
 * Run: `node scripts/run-tests.mjs lib/render/text-contrast.test.ts`
 *
 * Color math + backdrop sampling are pure and unit-tested directly. The gate is
 * exercised end-to-end on synthetic solid-color PNGs + hand-built text nodes:
 *  - the cycle-6 WHITE-ON-WHITE ghost blocks (~1:1);
 *  - a legible navy-on-cream headline PASSES (the old whole-box arm false-fired
 *    it at "1.15:1" by averaging the glyphs in — the retirement this replaces);
 *  - a dim grey micro-label ADVISES (never blocks — intentional diegetic dim);
 *  - saturated lime display type on white never blocks (chromatic contrast).
 */
import { promises as fs, existsSync } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  relLum,
  wcagRatio,
  parseCssColor,
  sampleBackdrop,
  isJudgeableTextNode,
  assessTextNodeContrast,
  TEXT_CONTRAST_BLOCK_RATIO,
  TEXT_CONTRAST_ADVISORY_RATIO,
  BUSY_BACKDROP_MIN_FRAC,
} from "./text-contrast";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("text-contrast");

// ── color math ───────────────────────────────────────────────────────────────
await check("relLum + wcagRatio: black/white is 21:1, white/white is 1:1", () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  assert(Math.abs(wcagRatio(white, black) - 21) < 0.1, `bw ${wcagRatio(white, black)}`);
  assert(Math.abs(wcagRatio(white, white) - 1) < 1e-6, `ww ${wcagRatio(white, white)}`);
  assert(relLum(0, 0, 0) === 0 && Math.abs(relLum(255, 255, 255) - 1) < 1e-6, "lum poles");
});

await check("parseCssColor: hex, #rgb, rgb(), rgba() with alpha; rejects garbage", () => {
  assert(JSON.stringify(parseCssColor("#ff8800")) === JSON.stringify({ r: 255, g: 136, b: 0, a: 1 }), "hex6");
  assert(JSON.stringify(parseCssColor("#f80")) === JSON.stringify({ r: 255, g: 136, b: 0, a: 1 }), "hex3");
  assert(parseCssColor("rgba(10,20,30,0.5)")?.a === 0.5, "rgba alpha");
  assert(parseCssColor("rgb(1,2,3)")?.a === 1, "rgb defaults a=1");
  assert(parseCssColor("not-a-color") === null, "garbage rejects");
});

// ── sampleBackdrop mechanics (pure, on hand-built RGB buffers) ────────────────
const rawSolid = (w: number, h: number, c: [number, number, number]) => {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { data[i * 3] = c[0]; data[i * 3 + 1] = c[1]; data[i * 3 + 2] = c[2]; }
  return { data, width: w, height: h, channels: 3 };
};

await check("sampleBackdrop: a pure WHITE region under white text is the ghost — modal stays white, no alt cluster", () => {
  const img = rawSolid(24, 24, [255, 255, 255]);
  const bd = sampleBackdrop(img, { x: 2, y: 2, w: 20, h: 20 }, { r: 255, g: 255, b: 255 }, { allowAltCluster: true });
  assert(!!bd && bd.r > 250 && bd.frac > 0.9, `white backdrop, got ${JSON.stringify(bd)}`);
});

await check("sampleBackdrop: GLYPH DOMINATION — mostly-fg rect finds the minority backdrop cluster", () => {
  // 24×24: top 16 rows white (the glyphs), bottom 8 rows dark (the surface).
  const data = new Uint8Array(24 * 24 * 3);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const i = (y * 24 + x) * 3;
    const v = y < 16 ? 255 : 20;
    data[i] = v; data[i + 1] = v; data[i + 2] = v;
  }
  const img = { data, width: 24, height: 24, channels: 3 };
  const bd = sampleBackdrop(img, { x: 0, y: 0, w: 24, h: 24 }, { r: 255, g: 255, b: 255 }, { allowAltCluster: true });
  assert(!!bd && bd.r < 60, `alt cluster = the dark surface, got ${JSON.stringify(bd)}`);
});

await check("BUSY-BACKDROP guard constant is exported and sane", () => {
  assert(BUSY_BACKDROP_MIN_FRAC > 0 && BUSY_BACKDROP_MIN_FRAC < 1, `frac floor ${BUSY_BACKDROP_MIN_FRAC}`);
});

// ── end-to-end: synthetic solid PNGs + text nodes ────────────────────────────
const CW = 400;
const CH = 300;
const tmp = path.join(os.tmpdir(), `rb-tc-${process.pid}`);
const solidPng = async (name: string, c: { r: number; g: number; b: number }): Promise<string> => {
  await fs.mkdir(tmp, { recursive: true });
  const p = path.join(tmp, `${name}.png`);
  await fs.writeFile(p, await sharp({ create: { width: CW, height: CH, channels: 3, background: c } }).png().toBuffer());
  return p;
};
const txt = (p: Partial<MeasuredElement>): MeasuredElement => ({
  tag: "div", x: 60, y: 60, w: 200, h: 60, color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)",
  text: "Built for you", isImg: false, src: undefined, fontSize: 40, opacity: 1,
  piece: "s0.hero", onOpaqueSurface: false, coveredAtCenter: false, ...p,
});
const sceneOf = (screenshotPath: string, els: MeasuredElement[]): SceneMeasurement => ({
  scene: 0, width: CW, height: CH, elements: els, screenshotPath,
});

await check("isJudgeableTextNode: text ≥2 chars, ≥8px, visible, uncovered; skips imgs, tiny, covered, decorative", () => {
  const A = CW * CH;
  assert(isJudgeableTextNode(txt({}), A), "normal text node judges");
  assert(!isJudgeableTextNode(txt({ isImg: true }), A), "img skips");
  assert(!isJudgeableTextNode(txt({ text: "x" }), A), "1-char skips");
  assert(!isJudgeableTextNode(txt({ coveredAtCenter: true }), A), "covered skips");
  assert(!isJudgeableTextNode(txt({ fontSize: 120, opacity: 0.2 }), A), "decorative watermark skips");
});

await check("GHOST: white text on the lifted WHITE panel BLOCKS (~1:1) — the cycle-6 s0 defect", async () => {
  const p = await solidPng("white", { r: 255, g: 255, b: 255 });
  const r = await assessTextNodeContrast([sceneOf(p, [txt({ color: "rgb(255,255,255)", fontSize: 44 })])]);
  assert(r.findings.length === 1 && r.findings[0].blocking, `ghost blocks, got ${JSON.stringify(r.findings)}`);
  assert(r.findings[0].ratio < TEXT_CONTRAST_BLOCK_RATIO, `ratio ${r.findings[0].ratio} < ${TEXT_CONTRAST_BLOCK_RATIO}`);
  assert(/Recolor this text/.test(r.findings[0].repairInstruction) && /Never repaint the surface/.test(r.findings[0].repairInstruction), "routes to fix the TEXT, not the surface");
});

await check("PASS: legible navy on cream does NOT fire (the retired whole-box arm's 1.15:1 false positive)", async () => {
  const p = await solidPng("cream", { r: 245, g: 240, b: 230 });
  const r = await assessTextNodeContrast([sceneOf(p, [txt({ color: "rgb(20,30,60)", fontSize: 44 })])]);
  assert(r.findings.length === 0, `navy-on-cream clean, got ${JSON.stringify(r.findings)}`);
});

await check("ADVISORY: a dim grey micro-label on near-black advises, never blocks (intentional diegetic dim)", async () => {
  const p = await solidPng("near-black", { r: 12, g: 12, b: 15 });
  const r = await assessTextNodeContrast([sceneOf(p, [txt({ text: "ACCOUNT SETUP", color: "rgb(84,84,90)", fontSize: 10 })])]);
  assert(r.findings.length === 0, `no BLOCKING finding (small text), got ${JSON.stringify(r.findings)}`);
  assert(r.advisories.length === 1, `one advisory, got ${JSON.stringify(r.advisories)}`);
});

await check("CHROMATIC: saturated lime display type on white never blocks (reads by hue, not luminance)", async () => {
  const p = await solidPng("white2", { r: 255, g: 255, b: 255 });
  const r = await assessTextNodeContrast([sceneOf(p, [txt({ text: "MURDER YOUR THIRST", color: "rgb(204,255,0)", fontSize: 48 })])]);
  assert(r.findings.length === 0, `chromatic lime never blocks, got ${JSON.stringify(r.findings)}`);
  const stat = r.stats.find((s) => s.chromatic);
  assert(!!stat, "recorded as chromatic in stats");
});

await check("a well-contrasted headline (dark on white) is never recorded (above the advisory ceiling)", async () => {
  const p = await solidPng("white3", { r: 255, g: 255, b: 255 });
  const r = await assessTextNodeContrast([sceneOf(p, [txt({ color: "rgb(10,10,10)", fontSize: 44 })])]);
  assert(r.findings.length === 0 && r.advisories.length === 0, `clean headline, got ${JSON.stringify({ f: r.findings, a: r.advisories })}`);
  assert(TEXT_CONTRAST_ADVISORY_RATIO === 4.5, "advisory ceiling 4.5");
});

await check("measure-error / screenshot-less scenes skip cleanly (never fabricate)", async () => {
  const err: SceneMeasurement = { scene: 0, width: CW, height: CH, elements: [], error: "boom" };
  const noShot: SceneMeasurement = { scene: 1, width: CW, height: CH, elements: [txt({})], screenshotPath: undefined };
  const r = await assessTextNodeContrast([err, noShot]);
  assert(r.findings.length === 0 && r.advisories.length === 0, "nothing fabricated without pixels");
});

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
