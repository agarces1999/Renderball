//
// Tests for the hero-contrast (washout) gate — the sensor that makes
// "pale-on-pale hero" a measurable, blocking defect instead of a vision-judge
// opinion. Two layers:
//
//   1. REAL fixtures: the archived scene PNGs on disk
//      (.data/acceptance5/glm52-fireworks/scene{0..4}.png — the v5 GLM-5.2 @
//      Fireworks run — and .data/acceptance/reference/scene3.png — the
//      Duolingo GLM reference), sampled at the hero bounds below. The v5
//      scene-0 hero (the washout vision passed) MUST fire; the v5 scene-1
//      tab-cluster hero and every reference hero MUST pass.
//
//      BOUNDS PROVENANCE: the v5 build report does not persist element
//      bounds, so these rects were RE-MEASURED via the exact SSR/measure path
//      that produced the PNGs (measureScenes on src/generated/
//      CAST_SPIKE_A5_GLM52 and on the reassembled Duolingo reference
//      01KWTMK9WXRZNF7X553R9AN63M, 2026-07-16) and pinned here as constants.
//      The freshly rendered frames' region stats matched the disk PNGs to
//      within rounding, so the pinned bounds are exact for these files. To
//      regenerate: measureScenes(genDir, script, tmp) →
//      heroRegionsFromMeasurement per scene.
//
//   2. Unit fixtures for the geometry: region union/clamp/degenerate-skip on
//      hand-built measurements, and the finding contract.
//
import path from "path";
import {
  assessHeroWashout,
  heroRegionsFromMeasurement,
  WASHOUT_SPREAD_FLOOR,
  WASHOUT_STDDEV_FLOOR,
  type HeroContrastResult,
} from "./hero-contrast";
import type { MeasuredElement, SceneMeasurement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("hero-contrast");

// ── unit: region geometry ────────────────────────────────────────────────────

const el = (piece: string, x: number, y: number, w: number, h: number): MeasuredElement => ({
  tag: "div", x, y, w, h,
  color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)", text: "", isImg: false,
  fontSize: 16, opacity: 1, piece, pieceKind: "diegetic",
  onOpaqueSurface: false, coveredAtCenter: false,
});

const measurement = (scene: number, elements: MeasuredElement[], screenshotPath?: string): SceneMeasurement => ({
  scene, width: 1920, height: 1080, elements, ...(screenshotPath ? { screenshotPath } : {}),
});

await check("heroRegionsFromMeasurement: union of member rects, clamped to canvas", () => {
  const m = measurement(0, [
    el("s0.hero", 100, 200, 300, 100),
    el("s0.hero", 250, 150, 200, 400),
    el("s0.hero", 1800, 900, 400, 400), // spills off canvas → clamped
    el("s0.copy", 0, 0, 500, 500), // not a hero
  ]);
  const regions = heroRegionsFromMeasurement(m);
  assert(regions.length === 1, `one hero region expected, got ${regions.length}`);
  const r = regions[0];
  assert(r.pieceId === "s0.hero", `pieceId s0.hero, got ${r.pieceId}`);
  assert(r.x === 100 && r.y === 150, `union origin 100,150, got ${r.x},${r.y}`);
  assert(r.x + r.w === 1920 && r.y + r.h === 1080, `clamped to canvas, got extent ${r.x + r.w}x${r.y + r.h}`);
});

await check("heroRegionsFromMeasurement: zero-size members ignored; degenerate heroes skipped; multiple heroes kept", () => {
  const m = measurement(2, [
    el("s2.hero", 500, 500, 0, 0), // zero-size — ignored
    el("s2.hero", 500, 500, 4, 4), // under MIN_REGION_PX → region skipped
    el("s2.heroB.hero", 100, 100, 50, 50),
  ]);
  const regions = heroRegionsFromMeasurement(m);
  assert(regions.length === 1 && regions[0].pieceId === "s2.heroB.hero", `only the measurable hero survives, got ${regions.map((r) => r.pieceId).join(",")}`);
});

// ── real fixtures ────────────────────────────────────────────────────────────
// Pinned bounds — see BOUNDS PROVENANCE in the file header.

const A5_PNGS = path.join(process.cwd(), ".data/acceptance5/glm52-fireworks");
const REF_PNGS = path.join(process.cwd(), ".data/acceptance/reference");

const HERO_BOUNDS: { scene: number; pieceId: string; png: string; x: number; y: number; w: number; h: number; expect: "washout" | "pass" }[] = [
  // v5 GLM-5.2 @ Fireworks — measured spread/std: s0 30/15.1 (the washout),
  // s1 227/54.8, s3 62/27.7, s4 90/25.9. (s2.hero is the hollow lone-element
  // hero — region 782x542 spread 0/5.5 — exercised separately below.)
  { scene: 0, pieceId: "s0.hero", png: path.join(A5_PNGS, "scene0.png"), x: 1020, y: 270, w: 800, h: 540, expect: "washout" },
  { scene: 1, pieceId: "s1.hero", png: path.join(A5_PNGS, "scene1.png"), x: 1056, y: 220, w: 768, h: 640, expect: "pass" },
  { scene: 3, pieceId: "s3.hero", png: path.join(A5_PNGS, "scene3.png"), x: 1020, y: 280, w: 780, h: 520, expect: "pass" },
  { scene: 4, pieceId: "s4.hero", png: path.join(A5_PNGS, "scene4.png"), x: 560, y: 700, w: 825, h: 280, expect: "pass" },
  // Duolingo GLM reference — its only ".hero" piece: measured 90/24.0.
  { scene: 3, pieceId: "s3.hero", png: path.join(REF_PNGS, "scene3.png"), x: 680, y: 279, w: 560, h: 421, expect: "pass" },
];

let real: HeroContrastResult | null = null;

await check("real PNGs sample cleanly at the pinned hero bounds (one browser pass)", async () => {
  // Distinct scene keys so each fixture maps to its own measurement (the two
  // scene-3 entries come from different builds/PNGs).
  const ms = HERO_BOUNDS.map((b, i) =>
    measurement(i, [el(b.pieceId, b.x, b.y, b.w, b.h)], b.png),
  );
  real = await assessHeroWashout(ms);
  assert(real.errors.length === 0, `sampling errors: ${real.errors.join(" | ")}`);
  assert(real.stats.length === HERO_BOUNDS.length, `stats for all ${HERO_BOUNDS.length} regions, got ${real.stats.length}`);
});

await check("v5 scene-0 hero (pale-on-pale desk tableau) FIRES hero-washout", () => {
  assert(real !== null, "real fixtures did not sample");
  const f = real!.findings.filter((x) => x.scene === 0);
  assert(f.length === 1, `exactly one finding on the washout hero, got ${f.length}: ${real!.findings.map((x) => `${x.scene}:${x.pieceId}`).join(",")}`);
  assert(f[0].kind === "hero-washout" && f[0].blocking, "hero-washout, blocking");
  assert(f[0].pieceId === "s0.hero" && f[0].detail.includes(`"s0.hero"`), `finding names the hero id: ${f[0].detail}`);
  assert(f[0].stats.spread < WASHOUT_SPREAD_FLOOR && f[0].stats.stdDev < WASHOUT_STDDEV_FLOOR, `both floors breached: ${JSON.stringify(f[0].stats)}`);
  assert(/spread 3\d(\.\d)?/.test(f[0].detail), `measured spread (~30) in detail: ${f[0].detail}`);
  assert(f[0].repairInstruction.includes("s0.hero"), "repair instruction targets the hero by id");
});

await check("v5 scene-1 tab cluster + v5 s3/s4 heroes + reference hero all PASS", () => {
  assert(real !== null, "real fixtures did not sample");
  const passing = HERO_BOUNDS.map((b, i) => ({ ...b, key: i })).filter((b) => b.expect === "pass");
  for (const b of passing) {
    const hit = real!.findings.find((x) => x.scene === b.key);
    assert(!hit, `${b.png.split("/").slice(-2).join("/")} ${b.pieceId} must pass, fired: ${hit?.detail}`);
    const s = real!.stats.find((x) => x.scene === b.key);
    assert(!!s, `stats present for ${b.pieceId}`);
    assert(s!.spread >= WASHOUT_SPREAD_FLOOR || s!.stdDev >= WASHOUT_STDDEV_FLOOR, `at least one floor cleared: ${JSON.stringify(s)}`);
  }
});

await check("v5 scene-2 hollow hero (lone element in a void) also reads as a washout by pixels", async () => {
  // Region re-measured 2026-07-16: 782x542 @ 1020,270 — spread 0, stdDev 5.5.
  // The per-hero density floor names this piece too; both sensors agreeing on
  // a void is the intended overlap, not double-counting.
  const m = measurement(2, [el("s2.hero", 1020, 270, 782, 542)], path.join(A5_PNGS, "scene2.png"));
  const r = await assessHeroWashout([m]);
  assert(r.errors.length === 0, `errors: ${r.errors.join(" | ")}`);
  assert(r.findings.length === 1 && r.findings[0].pieceId === "s2.hero", `washout on s2.hero, got ${r.findings.map((f) => f.pieceId).join(",") || "none"}`);
});

await check("finding contract: kind, scene, pieceId, blocking, measured numbers, actionable repair", () => {
  assert(real !== null, "real fixtures did not sample");
  for (const f of real!.findings) {
    assert(f.kind === "hero-washout" && f.blocking === true, "kind + blocking");
    assert(typeof f.pieceId === "string" && f.pieceId.endsWith(".hero"), "names a hero piece");
    assert(f.detail.length > 40 && /\d/.test(f.detail), "humanized detail with measured numbers");
    assert(f.repairInstruction.length > 60, "actionable repair instruction");
    assert(f.stats.sampledPixels > 1000, "real sampling volume");
  }
});

await check("scenes without screenshots or heroes are skipped without fabricated findings", async () => {
  const r = await assessHeroWashout([
    measurement(0, [el("s0.hero", 100, 100, 200, 200)]), // no screenshot
    measurement(1, [el("s1.copy", 100, 100, 200, 200)], path.join(A5_PNGS, "scene1.png")), // no hero
  ]);
  assert(r.stats.length === 0 && r.findings.length === 0 && r.errors.length === 0, `nothing to measure → empty result, got ${JSON.stringify({ s: r.stats.length, f: r.findings.length, e: r.errors })}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
