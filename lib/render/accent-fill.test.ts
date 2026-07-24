//
// Tests for the accent-as-fill gate — the sensor that makes "brand accent used
// as a giant panel fill" a measurable, blocking defect instead of a taste
// opinion. Two layers:
//
//   1. REAL fixtures: archived scene PNGs on disk, sampled at the hero bounds
//      the builds actually measured (regions pinned from each run's
//      build-report.json finalContrast stats — the same measure pass that
//      produced the PNGs):
//        MUST FAIL — dogfood cycle-1 Liquid Death s3.hero
//          (.data/dogfood/cycle1-liquiddeath/frames/scene3.png, 864×640 @
//          1056,220, accent #00ff00) — the flat green slab.
//        MUST PASS — cycle-1 s1.hero (accent as punctuation only) and the v8
//          Klarna heroes (.data/acceptance8/v8/scene{0,1,3,4}.png, accent
//          #7a5ea6).
//
//   2. Unit fixtures: accent-spec filtering (neutral accents skipped, bad hex
//      dropped), empty-input postures, and the finding contract.
//
import { existsSync } from "fs";
import path from "path";
import {
  assessAccentFill,
  accentSpecs,
  ACCENT_FILL_MAX_FRAC,
  NEUTRAL_ACCENT_CHROMA,
  type AccentFillResult,
} from "./accent-fill";
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

console.log("accent-fill");

const el = (piece: string, x: number, y: number, w: number, h: number): MeasuredElement => ({
  tag: "div", x, y, w, h,
  color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)", text: "", isImg: false,
  fontSize: 16, opacity: 1, piece, pieceKind: "diegetic",
  onOpaqueSurface: false, coveredAtCenter: false,
});

const measurement = (scene: number, elements: MeasuredElement[], screenshotPath?: string): SceneMeasurement => ({
  scene, width: 1920, height: 1080, elements, ...(screenshotPath ? { screenshotPath } : {}),
});

// ── unit: accent-spec filtering ──────────────────────────────────────────────

await check("accentSpecs: neutral accents and unparseable hexes are skipped; saturated hexes judged", () => {
  const specs = accentSpecs(["#00ff00", "#808080", "not-a-hex", "#7a5ea6", "#f0f"]);
  const hexes = specs.map((s) => s.hex);
  assert(hexes.includes("#00ff00") && hexes.includes("#7a5ea6") && hexes.includes("#f0f"), `saturated accents kept: ${hexes.join(",")}`);
  assert(!hexes.includes("#808080"), "a neutral 'accent' cannot be hue-matched — skipped");
  assert(!hexes.includes("not-a-hex"), "bad hex dropped");
  const green = specs.find((s) => s.hex === "#00ff00")!;
  assert(Math.abs(green.hue - 120) < 1 && green.chroma === 255, `green spec sane: hue ${green.hue}, chroma ${green.chroma}`);
  assert(green.chroma >= NEUTRAL_ACCENT_CHROMA, "kept accents clear the neutral floor");
});

await check("no judgeable accent / no heroes / no screenshot → empty result, no fabricated findings", async () => {
  const m = measurement(0, [el("s0.hero", 100, 100, 400, 300)]);
  const noAccent = await assessAccentFill([m], ["#888888"]);
  assert(noAccent.stats.length === 0 && noAccent.findings.length === 0 && noAccent.errors.length === 0, "neutral-only accents → nothing to probe");
  const noShot = await assessAccentFill([m], ["#00ff00"]);
  assert(noShot.stats.length === 0 && noShot.findings.length === 0, "no screenshot → scene skipped");
});

// ── real fixtures ────────────────────────────────────────────────────────────
// Region provenance: each run's build-report.json finalContrast.stats — the
// exact hero-region unions the build's own measure pass computed for these PNGs.

const C1 = path.join(process.cwd(), ".data/dogfood/cycle1-liquiddeath/frames");
const V8 = path.join(process.cwd(), ".data/acceptance8/v8");

const FIXTURES: {
  key: number; pieceId: string; png: string; accent: string;
  x: number; y: number; w: number; h: number; expect: "fill" | "pass";
}[] = [
  // Liquid Death cycle 1 — accent #00ff00.
  { key: 0, pieceId: "s3.hero", png: path.join(C1, "scene3.png"), accent: "#00ff00", x: 1056, y: 220, w: 864, h: 640, expect: "fill" },
  { key: 1, pieceId: "s1.hero", png: path.join(C1, "scene1.png"), accent: "#00ff00", x: 360, y: 600, w: 800, h: 240, expect: "pass" },
  // v8 Klarna — accent #7a5ea6 (purple as glow/chip punctuation, never a slab).
  { key: 2, pieceId: "s0.hero", png: path.join(V8, "scene0.png"), accent: "#7a5ea6", x: 555, y: 699, w: 805, h: 381, expect: "pass" },
  { key: 3, pieceId: "s1.hero", png: path.join(V8, "scene1.png"), accent: "#7a5ea6", x: 1056, y: 220, w: 768, h: 640, expect: "pass" },
  { key: 4, pieceId: "s3.hero", png: path.join(V8, "scene3.png"), accent: "#7a5ea6", x: 1020, y: 270, w: 841, h: 540, expect: "pass" },
  { key: 5, pieceId: "s4.hero", png: path.join(V8, "scene4.png"), accent: "#7a5ea6", x: 0, y: 0, w: 1920, h: 1080, expect: "pass" },
];

const results = new Map<number, AccentFillResult>();
const ALL_PNGS = FIXTURES.map((f) => f.png);

await checkWithFixtures("real PNGs sample cleanly at the pinned hero bounds", ALL_PNGS, async () => {
  for (const f of FIXTURES) {
    const m = measurement(f.key, [el(f.pieceId, f.x, f.y, f.w, f.h)], f.png);
    const r = await assessAccentFill([m], [f.accent]);
    assert(r.errors.length === 0, `${f.png}: sampling errors: ${r.errors.join(" | ")}`);
    assert(r.stats.length === 1, `${f.png}: one region's stats expected, got ${r.stats.length}`);
    results.set(f.key, r);
  }
});

await checkWithFixtures("cycle-1 Liquid Death s3.hero (the flat #00ff00 slab) FIRES accent-as-fill", ALL_PNGS, () => {
  const r = results.get(0);
  assert(!!r, "fixture did not sample");
  assert(r!.findings.length === 1, `exactly one finding, got ${r!.findings.length}`);
  const f = r!.findings[0];
  assert(f.kind === "accent-as-fill" && f.blocking === true, "kind + blocking");
  assert(f.pieceId === "s3.hero" && f.detail.includes(`"s3.hero"`), `finding names the hero: ${f.detail}`);
  assert(f.stats.largestRectFrac > ACCENT_FILL_MAX_FRAC, `over the ceiling: ${f.stats.largestRectFrac}`);
  // The slab is nearly half the region — comfortably above the ceiling, so the
  // calibration has real margin, not a knife-edge pass.
  assert(f.stats.largestRectFrac > 0.38, `slab measures ~0.44 of the region with margin, got ${f.stats.largestRectFrac}`);
  assert(/punctuation/i.test(f.repairInstruction) && f.repairInstruction.includes("s3.hero"), "repair instruction: accent is punctuation, targets the piece");
});

await checkWithFixtures("cycle-1 s1.hero + all four v8 Klarna heroes PASS (accent stays punctuation)", ALL_PNGS, () => {
  for (const f of FIXTURES.filter((x) => x.expect === "pass")) {
    const r = results.get(f.key)!;
    assert(r.findings.length === 0, `${f.png.split("/").slice(-2).join("/")} ${f.pieceId} must pass, fired: ${r.findings[0]?.detail}`);
    const s = r.stats[0];
    // Margin check: passing heroes sit clearly under the ceiling, not at it.
    assert(s.largestRectFrac < ACCENT_FILL_MAX_FRAC * 0.75, `${f.pieceId}: comfortable margin under the ceiling, got ${s.largestRectFrac}`);
  }
});

await checkWithFixtures("finding contract: measured numbers + region + rect geometry are reported", ALL_PNGS, () => {
  const r = results.get(0)!;
  const s = r.findings[0].stats;
  assert(s.region.w === 864 && s.region.h === 640, "region carried through");
  assert(s.rect.w > 100 && s.rect.h > 100, `slab rect is a real rectangle: ${JSON.stringify(s.rect)}`);
  assert(s.rect.x >= s.region.x && s.rect.y >= s.region.y, "rect sits inside the region (canvas coords)");
  assert(s.coverageFrac >= s.largestRectFrac - 0.001, "coverage ≥ largest-rect fraction");
  assert(/\d/.test(r.findings[0].detail) && r.findings[0].detail.includes("%"), "humanized detail with measured percentages");
});

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} SKIPPED (gitignored fixtures absent — unit coverage only)` : ""}`);
if (failed > 0) process.exitCode = 1;
