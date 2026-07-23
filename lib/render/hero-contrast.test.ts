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
import { existsSync } from "fs";
import path from "path";
import {
  assessHeroWashout,
  heroRegionsFromMeasurement,
  heroSubPanelRegions,
  hexLum255,
  WASHOUT_SPREAD_FLOOR,
  WASHOUT_STDDEV_FLOOR,
  WASHOUT_NEAR_MISS_STD_MARGIN,
  HERO_UNDERSCALE_MIN_FRAC,
  HERO_HEALTHY_FRAC,
  heroPaintedFraction,
  findHeroUnderscale,
  rectUnionArea,
  isPaintedElement,
  cssLum255,
  edgeEvidenceForElement,
  readDominantPanel,
  EDGE_BORDER_MIN_ALPHA,
  type HeroContrastResult,
} from "./hero-contrast";
import type { MeasuredElement, SceneMeasurement } from "./measure-scene";

let passed = 0;
let failed = 0;
let skipped = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
// REAL-fixture checks sample archived scene PNGs under gitignored .data/
// paths: present in the long-lived checkout, absent in fresh clones and
// worktrees. An absent fixture makes the sampling unrunnable, not failed —
// skip LOUDLY (counted + named) so a green run can't be mistaken for full
// coverage.
const checkWithFixtures = async (name: string, fixtures: string[], fn: () => void | Promise<void>) => {
  const missing = fixtures.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    skipped++;
    console.log(`  ↷ ${name}\n      SKIPPED — gitignored fixture(s) not on disk: ${missing.map((f) => path.relative(process.cwd(), f)).join(", ")}`);
    return;
  }
  await check(name, fn);
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

// ── P3-C2 #3: secondary-panel sub-region selection + luminance helper ─────────
await check("hexLum255: dark brand canvas #15191e ≈ 24, white ≈ 255", () => {
  const dark = hexLum255("#15191e");
  const white = hexLum255("#ffffff");
  assert(dark !== null && Math.abs(dark - 24) < 3, `dark got ${dark}`);
  assert(white !== null && Math.round(white) === 255, `white got ${white}`);
  assert(hexLum255("nope") === null, "unparseable → null");
});

await check("heroSubPanelRegions: picks card-sized opaque hero panels (Brex s1 split), skips chips/bars/transparent", () => {
  const surface = (piece: string, x: number, y: number, w: number, h: number, bg: string): MeasuredElement =>
    ({ ...el(piece, x, y, w, h), bg, radius: 12 });
  const m = measurement(1, [
    surface("s1.hero", 140, 180, 800, 540, "rgb(245,246,248)"), // left bright card — card-sized ✓
    surface("s1.hero", 980, 180, 800, 540, "rgb(21,25,30)"),    // right ghost card — card-sized ✓ (near-canvas)
    surface("s1.hero", 200, 300, 70, 30, "rgb(255,89,0)"),      // a chip — too small ✗
    surface("s1.hero", 200, 700, 600, 6, "rgb(255,89,0)"),      // a thin rule — min-dim ✗
    { ...el("s1.hero", 300, 300, 400, 400), bg: "rgba(0,0,0,0)" }, // transparent wrapper ✗
    surface("s1.copy", 240, 760, 900, 200, "rgb(20,20,24)"),    // not a .hero piece ✗
  ]);
  const r = heroSubPanelRegions(m);
  assert(r.length === 2 && r.every((p) => p.secondary === true), `two hero cards selected, got ${r.length}: ${JSON.stringify(r.map((p) => [p.x, p.w]))}`);
});

await check("heroSubPanelRegions: a hero with a single full card yields no oversized sub-panel (>MAX_FRAC skipped)", () => {
  const m = measurement(2, [
    { ...el("s2.hero", 0, 0, 1900, 1060), bg: "rgb(20,22,26)" }, // ~97% of canvas → not a 'card'
  ]);
  assert(heroSubPanelRegions(m).length === 0, "whole-frame surface is not a sub-panel");
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
const REAL_PNGS = HERO_BOUNDS.map((b) => b.png);

await checkWithFixtures("real PNGs sample cleanly at the pinned hero bounds (one browser pass)", REAL_PNGS, async () => {
  // Distinct scene keys so each fixture maps to its own measurement (the two
  // scene-3 entries come from different builds/PNGs).
  const ms = HERO_BOUNDS.map((b, i) =>
    measurement(i, [el(b.pieceId, b.x, b.y, b.w, b.h)], b.png),
  );
  real = await assessHeroWashout(ms);
  assert(real.errors.length === 0, `sampling errors: ${real.errors.join(" | ")}`);
  assert(real.stats.length === HERO_BOUNDS.length, `stats for all ${HERO_BOUNDS.length} regions, got ${real.stats.length}`);
});

await checkWithFixtures("v5 scene-0 hero (pale-on-pale desk tableau) FIRES hero-washout", REAL_PNGS, () => {
  assert(real !== null, "real fixtures did not sample");
  const f = real!.findings.filter((x) => x.scene === 0);
  assert(f.length === 1, `exactly one finding on the washout hero, got ${f.length}: ${real!.findings.map((x) => `${x.scene}:${x.pieceId}`).join(",")}`);
  assert(f[0].kind === "hero-washout" && f[0].blocking, "hero-washout, blocking");
  assert(f[0].pieceId === "s0.hero" && f[0].detail.includes(`"s0.hero"`), `finding names the hero id: ${f[0].detail}`);
  assert(f[0].stats.spread < WASHOUT_SPREAD_FLOOR && f[0].stats.stdDev < WASHOUT_STDDEV_FLOOR, `both floors breached: ${JSON.stringify(f[0].stats)}`);
  assert(/spread 3\d(\.\d)?/.test(f[0].detail), `measured spread (~30) in detail: ${f[0].detail}`);
  assert(f[0].repairInstruction.includes("s0.hero"), "repair instruction targets the hero by id");
});

await checkWithFixtures("v5 scene-1 tab cluster + v5 s3/s4 heroes + reference hero all PASS", REAL_PNGS, () => {
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

await checkWithFixtures("v5 scene-2 hollow hero (lone element in a void) also reads as a washout by pixels", [path.join(A5_PNGS, "scene2.png")], async () => {
  // Region re-measured 2026-07-16: 782x542 @ 1020,270 — spread 0, stdDev 5.5.
  // The per-hero density floor names this piece too; both sensors agreeing on
  // a void is the intended overlap, not double-counting.
  const m = measurement(2, [el("s2.hero", 1020, 270, 782, 542)], path.join(A5_PNGS, "scene2.png"));
  const r = await assessHeroWashout([m]);
  assert(r.errors.length === 0, `errors: ${r.errors.join(" | ")}`);
  assert(r.findings.length === 1 && r.findings[0].pieceId === "s2.hero", `washout on s2.hero, got ${r.findings.map((f) => f.pieceId).join(",") || "none"}`);
});

await checkWithFixtures("finding contract: kind, scene, pieceId, blocking, measured numbers, actionable repair", REAL_PNGS, () => {
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

// ── v13 (#3): near-miss washout ADVISORY — real cycle-4 Oatly fixtures ──────
// Regions re-measured 2026-07-17 via measureScenes on
// src/generated/CAST_SPIKE_DOGFOOD_OATLY (1080x1080; frames archived at
// .data/dogfood/cycle4-oatly/frames): s0.hero 601x280 @ 240,640 spread 43 /
// std 19.8 and s2.hero 600x340 @ 240,620 spread 20 / std 19.4 — BOTH inside
// the advisory band (spread < 45, 19 ≤ std < 22); s1.hero 444x561 @ 560,260
// spread 158 / std 70.2 — comfortably clear.

const OATLY_FRAMES = path.join(process.cwd(), ".data/dogfood/cycle4-oatly/frames");
const oatlyMeasurement = (scene: number, pieceId: string, x: number, y: number, w: number, h: number): SceneMeasurement => ({
  scene, width: 1080, height: 1080,
  elements: [el(pieceId, x, y, w, h)],
  screenshotPath: path.join(OATLY_FRAMES, `scene${scene}.png`),
});

await checkWithFixtures("near-miss band: cycle-4 s0/s2 heroes get ADVISORIES (not findings); strong s1 gets neither", [0, 1, 2].map((s) => path.join(OATLY_FRAMES, `scene${s}.png`)), async () => {
  const r = await assessHeroWashout([
    oatlyMeasurement(0, "s0.hero", 240, 640, 601, 280),
    oatlyMeasurement(1, "s1.hero", 560, 260, 444, 561),
    oatlyMeasurement(2, "s2.hero", 240, 620, 600, 340),
  ]);
  assert(r.errors.length === 0, `sampling errors: ${r.errors.join(" | ")}`);
  assert(r.findings.length === 0, `advisory band must NOT block, got findings: ${r.findings.map((f) => f.pieceId).join(",")}`);
  const advised = r.advisories.map((a) => a.pieceId).sort();
  assert(JSON.stringify(advised) === JSON.stringify(["s0.hero", "s2.hero"]), `s0+s2 advisories expected, got [${advised.join(",")}]`);
  for (const a of r.advisories) {
    assert(a.blocking === false && a.kind === "washout-near-miss", "advisory contract: never blocking");
    assert(a.stats.spread < WASHOUT_SPREAD_FLOOR && a.stats.stdDev >= WASHOUT_STDDEV_FLOOR && a.stats.stdDev < WASHOUT_STDDEV_FLOOR + WASHOUT_NEAR_MISS_STD_MARGIN, `band membership: ${JSON.stringify(a.stats)}`);
    assert(a.advisory.startsWith("ADVISORY"), "regen feedback marked as advisory");
  }
});

await checkWithFixtures("near-miss band is EXCLUSIVE of the blocking gate — a true washout is a finding, never an advisory", [path.join(A5_PNGS, "scene0.png")], async () => {
  // v5 scene-0 (spread 30 / std 15.1) breaches BOTH floors.
  const r = await assessHeroWashout([
    measurement(0, [el("s0.hero", 1020, 270, 800, 540)], path.join(A5_PNGS, "scene0.png")),
  ]);
  assert(r.findings.length === 1, "blocking washout fires");
  assert(r.advisories.length === 0, `no advisory alongside the blocking finding, got ${r.advisories.length}`);
});

// ── v13 (#2): hero-underscale — painted-union floor on centered/quote ───────
// Real-artifact calibration lives in hero-contrast.ts's module table
// (measured 2026-07-17): Oatly s2 carton 0.33% MUST FIRE; Oatly s0 12.42%,
// LiquidDeath s1 9.26% (nearest pass), Linear s4 10.87% all PASS. The unit
// fixtures below mirror those geometries exactly.

const pel = (piece: string, x: number, y: number, w: number, h: number, over: Partial<MeasuredElement> = {}): MeasuredElement => ({
  ...el(piece, x, y, w, h),
  ...over,
});
const sq = (scene: number, elements: MeasuredElement[]): SceneMeasurement => ({
  scene, width: 1080, height: 1080, elements,
});

await check("rectUnionArea: exact union, overlap not double-counted, zero-size ignored", () => {
  assert(rectUnionArea([]) === 0, "empty");
  assert(rectUnionArea([{ x: 0, y: 0, w: 100, h: 100 }]) === 10000, "single rect");
  assert(rectUnionArea([{ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }]) === 17500, "overlap counted once");
  assert(rectUnionArea([{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 200, w: 0, h: 50 }]) === 10000, "degenerate ignored");
});

await check("isPaintedElement: opaque bg / text / img / gradient paint; transparent wrappers do not", () => {
  assert(isPaintedElement(pel("p", 0, 0, 100, 100, { bg: "rgb(36, 53, 106)" })), "opaque bg paints");
  assert(isPaintedElement(pel("p", 0, 0, 100, 100, { text: "Oats" })), "text paints");
  assert(isPaintedElement(pel("p", 0, 0, 100, 100, { isImg: true })), "img paints");
  assert(isPaintedElement(pel("p", 0, 0, 100, 100, { hasBgImage: true })), "gradient paints");
  assert(!isPaintedElement(pel("p", 0, 0, 100, 100)), "transparent wrapper does not");
  assert(!isPaintedElement(pel("p", 0, 0, 100, 100, { bg: "rgba(0, 0, 0, 0.2)" })), "near-transparent tint does not");
  assert(!isPaintedElement(pel("p", 0, 0, 100, 100, { bg: "rgb(0,0,0)", opacity: 0.02 })), "invisible does not");
});

// The Oatly-s2 mirror: a 600x340 transparent layout wrapper (bbox 17.5% of
// canvas) whose PAINTED content is a ~60x90 carton + a thin caption — the
// postage stamp. Painted union ≈ 0.55% of 1080x1080.
const cartonScene = sq(2, [
  pel("s2.hero", 240, 620, 600, 340), // transparent wrapper — inflates bbox only
  pel("s2.hero", 510, 700, 60, 90, { bg: "rgb(255, 214, 224)" }), // the carton
  pel("s2.hero", 500, 800, 80, 12, { text: "OATLY" }), // caption line
]);

await check("underscale FIRES on the centered postage-stamp hero, with the scale-it-up routing feedback", () => {
  const f = findHeroUnderscale([cartonScene], [undefined, undefined, "centered"]);
  assert(f.length === 1 && f[0].pieceId === "s2.hero", `one finding on s2.hero, got ${JSON.stringify(f.map((x) => x.pieceId))}`);
  assert(f[0].kind === "hero-underscale" && f[0].blocking === true, "blocking hero-underscale");
  assert(f[0].paintedFrac < HERO_UNDERSCALE_MIN_FRAC, `painted frac under floor: ${f[0].paintedFrac}`);
  assert(f[0].bboxFrac > 0.15, `wrapper-inflated bbox reported for context: ${f[0].bboxFrac}`);
  assert(/THE ARTIFACT OWNS THE FRAME — SCALE IT UP/.test(f[0].repairInstruction), "mandated routing feedback present");
  assert(f[0].detail.includes("centered"), "register named in detail");
});

await check("underscale is register-scoped: the same postage stamp on split/list/stat/absent registers never fires", () => {
  for (const reg of ["split", "list", "stat", "full-bleed", undefined]) {
    const f = findHeroUnderscale([cartonScene], [undefined, undefined, reg]);
    assert(f.length === 0, `register ${reg ?? "(none)"} must not fire, got ${f.length}`);
  }
});

await check("underscale PASSES a quote hero whose painted panel owns ~12% of the canvas (Oatly s0 mirror)", () => {
  // 601x280 wrapper with an OPAQUE panel filling ~86% of it → painted 12.4%.
  const m = sq(0, [
    pel("s0.hero", 240, 640, 601, 280),
    pel("s0.hero", 250, 650, 580, 250, { bg: "rgb(36, 53, 106)" }),
  ]);
  const f = findHeroUnderscale([m], ["quote"]);
  assert(f.length === 0, `12% painted union must pass, got ${JSON.stringify(f)}`);
});

await check("underscale PASSES the nearest real pass (LiquidDeath s1 mirror, ~9.3%) — floor margin holds", () => {
  // Painted union just above the floor: 335x300 ≈ 8.6% of 1080x1080.
  const m = sq(1, [pel("s1.hero", 372, 390, 335, 300, { bg: "rgb(20, 20, 20)" })]);
  const f = findHeroUnderscale([m], [undefined, "quote"]);
  assert(f.length === 0, `9%-ish painted union must pass, got ${JSON.stringify(f)}`);
});

await check("underscale skips errored scenes and non-hero pieces; overlap in painted rects is not double-counted", () => {
  const errored: SceneMeasurement = { ...cartonScene, error: "boom" };
  assert(findHeroUnderscale([errored], [undefined, undefined, "centered"]).length === 0, "errored scene skipped");
  const copyOnly = sq(2, [pel("s2.copy", 100, 100, 50, 50, { bg: "rgb(10,10,10)" })]);
  assert(findHeroUnderscale([copyOnly], [undefined, undefined, "centered"]).length === 0, "no hero piece → nothing");
  // Two fully-overlapping painted panels must not sum past the floor.
  const overlapped = sq(2, [
    pel("s2.hero", 0, 0, 200, 200, { bg: "rgb(30,30,30)" }),
    pel("s2.hero", 0, 0, 200, 200, { bg: "rgb(40,40,40)" }),
  ]);
  const f = findHeroUnderscale([overlapped], [undefined, undefined, "centered"]);
  assert(f.length === 1 && Math.abs(f[0].paintedFrac - 200 * 200 / (1080 * 1080)) < 1e-9, `overlap counted once, got ${f[0]?.paintedFrac}`);
});

// ── R4 (audit-2): heroPaintedFraction — the void-furnish hero-health signal ──
await check("heroPaintedFraction: a well-painted hero reads HEALTHY (≥ floor) on ANY register", () => {
  // A 1000x400 painted panel = ~19% of 1920x1080 → healthy.
  const m = measurement(0, [pel("s0.hero", 200, 200, 1000, 400, { bg: "rgb(24,26,32)" })]);
  const frac = heroPaintedFraction(m);
  assert(frac >= HERO_HEALTHY_FRAC, `healthy hero above floor, got ${(frac * 100).toFixed(1)}%`);
});

await check("heroPaintedFraction: a hero that paints NOTHING (transparent members) is HOLLOW (0)", () => {
  // .hero pieces exist but none PAINT (transparent bg, no text/img) → the hollow
  // bookend the furnish must fill (not a side panel beside a healthy hero).
  const m = measurement(4, [el("s4.hero", 100, 100, 1400, 800), el("s4.hero", 200, 200, 300, 120)]);
  assert(heroPaintedFraction(m) === 0, `no painted hero ink → hollow (0), got ${heroPaintedFraction(m)}`);
});

await check("heroPaintedFraction: no hero piece → 0; an errored scene → 1 (never furnish blind)", () => {
  assert(heroPaintedFraction(measurement(1, [pel("s1.copy", 0, 0, 400, 400, { bg: "rgb(10,10,10)" })])) === 0, "no hero piece → 0");
  const errored: SceneMeasurement = { ...measurement(2, []), error: "boom" };
  assert(heroPaintedFraction(errored) === 1, "unmeasurable → healthy (1), never furnish blind");
});

// ── unit: panel reading — sparsity + edge evidence (v16) ─────────────────────
// The washout×sparse triage that killed the black-slab repair. Live positives:
// Notion alloc2-on-2 s1.hero (dark inbox, content top-half only) and
// alloc2-on-1 s3.hero (giant slab, one stat card) — both were white panels the
// forced ink-lift painted black. Coverage math must read them SPARSE; a
// bordered white card (notion.com idiom) must read EDGE-TREATED.

await check("cssLum255: hex + rgb() parse to Rec.709 L; garbage is null", () => {
  const hw = cssLum255("#ffffff");
  assert(hw !== null && Math.abs(hw - 255) < 0.01, `white hex ≈255, got ${hw}`);
  const l = cssLum255("rgb(255, 255, 255)");
  assert(l !== null && Math.abs(l - 255) < 0.01, `white rgb, got ${l}`);
  assert(cssLum255("transparent") === null && cssLum255("") === null, "unparseable → null");
});

await check("edge evidence: a Notion-class hairline (1px #E7E5E2 on white) is TREATED", () => {
  const e = { ...el("s1.hero", 100, 100, 600, 400), borderTopWidth: 1, borderColor: "rgb(231, 229, 226)" };
  assert(edgeEvidenceForElement(e, "#ffffff").treated, "hairline on white counts");
});

await check("edge evidence: near-invisible or canvas-toned borders do NOT count", () => {
  const ghost = { ...el("s1.hero", 0, 0, 600, 400), borderTopWidth: 1, borderColor: `rgba(0,0,0,${EDGE_BORDER_MIN_ALPHA - 0.05})` };
  assert(!edgeEvidenceForElement(ghost, "#ffffff").treated, "alpha under the floor");
  const sameTone = { ...el("s1.hero", 0, 0, 600, 400), borderTopWidth: 2, borderColor: "rgb(252, 252, 252)" };
  assert(!edgeEvidenceForElement(sameTone, "#ffffff").treated, "white-on-white border is no boundary");
  assert(!edgeEvidenceForElement(el("s1.hero", 0, 0, 600, 400), "#ffffff").treated, "legacy fixture (no fields) → untreated");
});

await check("edge evidence: a real drop shadow counts; 'none'/zero-alpha do not", () => {
  const shadowed = { ...el("s1.hero", 0, 0, 600, 400), boxShadow: "rgba(16, 24, 40, 0.08) 0px 12px 24px 0px" };
  assert(edgeEvidenceForElement(shadowed, "#ffffff").treated, "soft shadow counts");
  const none = { ...el("s1.hero", 0, 0, 600, 400), boxShadow: "none" };
  assert(!edgeEvidenceForElement(none, "#ffffff").treated, "'none' is nothing");
  const ghost = { ...el("s1.hero", 0, 0, 600, 400), boxShadow: "rgba(0, 0, 0, 0.01) 0px 12px 24px 0px" };
  assert(!edgeEvidenceForElement(ghost, "#ffffff").treated, "invisible shadow is nothing");
});

await check("readDominantPanel: coverage = interior painted union / panel area (the sparse trigger)", () => {
  const panel = { ...el("s1.hero", 100, 100, 600, 400), bg: "rgb(255,255,255)" };
  const rowA = { ...el("s1.hero", 100, 100, 600, 100), text: "Triage product feedback", parentIx: 0 };
  const rowB = { ...el("s1.hero", 100, 200, 600, 100), text: "Resolve support tickets", parentIx: 0 };
  const m = measurement(1, [panel, rowA, rowB]);
  const r = readDominantPanel(m, "s1.hero", "#ffffff");
  assert(r !== null, "panel found");
  assert(Math.abs(r!.coverage - 0.5) < 0.01, `two 600×100 rows over 600×400 = 0.5, got ${r?.coverage}`);
  // The live black-box class: one thin row in a big panel → SPARSE (<0.4).
  const sparse = measurement(1, [panel, { ...rowA, h: 50 }]);
  const rs = readDominantPanel(sparse, "s1.hero", "#ffffff");
  assert(rs !== null && rs!.coverage < 0.4, `one 600×50 row = 0.125, got ${rs?.coverage}`);
});

await check("readDominantPanel: legacy fixtures (no parentIx anywhere) and panel-less pieces → null", () => {
  const legacyPanel = { ...el("s1.hero", 100, 100, 600, 400), bg: "rgb(255,255,255)" };
  assert(readDominantPanel(measurement(1, [legacyPanel]), "s1.hero") === null, "no ancestry → null (never a false 0)");
  const textOnly = { ...el("s1.copy", 100, 100, 600, 400), text: "words", parentIx: -1 };
  const withAncestry = { ...el("s1.copy", 100, 100, 100, 40), text: "x", parentIx: 0 };
  assert(readDominantPanel(measurement(1, [textOnly, withAncestry]), "s1.copy") === null, "no opaque panel-sized surface → null");
});

await check("readDominantPanel: edge treatment on the panel element propagates", () => {
  const panel = {
    ...el("s3.hero", 100, 100, 600, 400),
    bg: "rgb(255,255,255)", borderTopWidth: 1, borderColor: "rgb(220, 218, 214)",
  };
  const row = { ...el("s3.hero", 100, 100, 600, 60), text: "98%", parentIx: 0 };
  const r = readDominantPanel(measurement(3, [panel, row]), "s3.hero", "#ffffff");
  assert(r !== null && r!.edgeTreated, "bordered panel reads edge-treated");
});

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} SKIPPED (gitignored fixtures absent — unit coverage only)` : ""}`);
if (failed > 0) process.exitCode = 1;
