//
// Tests for the pure helpers extracted into the shared quality loop (v16,
// task #205): cssAlphaOf, pieceSpanInCode, and the finding→piece routing in
// computeTargets. The orchestration (runQualityLoop) is validated end-to-end by
// the product-path build; these lock the deterministic building blocks that
// used to live inline in the dogfood spike.
//
import { cssAlphaOf, pieceSpanInCode, computeTargets, dropAccentsNearCanvas, type DensityProfile } from "./quality-loop";
import type { HeroWashoutFinding } from "./hero-contrast";
import type { AccentFillFinding } from "./accent-fill";
import type { RenderTruthFinding } from "./render-truth-gates";
import type { SceneVisionVerdict } from "./quality-loop";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("quality-loop (pure helpers)");

// ── cssAlphaOf ──────────────────────────────────────────────────────────────
check("cssAlphaOf: opaque hex → 1", () => {
  assert(cssAlphaOf("#ffffff") === 1, "hex should be opaque");
  assert(cssAlphaOf("  #abc  ") === 1, "trimmed hex should be opaque");
});
check("cssAlphaOf: rgb() → 1, rgba() → its alpha", () => {
  assert(cssAlphaOf("rgb(1,2,3)") === 1, "rgb has no alpha → 1");
  assert(cssAlphaOf("rgba(0,0,0,0.4)") === 0.4, "rgba alpha honored");
  assert(cssAlphaOf("rgba(0,0,0,0)") === 0, "fully transparent");
});
check("cssAlphaOf: unparseable → 0", () => {
  assert(cssAlphaOf("transparent") === 0, "keyword not parseable → 0");
  assert(cssAlphaOf("") === 0, "empty → 0");
});

// ── pieceSpanInCode ──────────────────────────────────────────────────────────
const asm = [
  `<div data-piece="s0.atmosphere" style={{}}>atmos</div>`,
  `<div data-piece="s0.hero" style={{}}><span>hero body</span></div>`,
  `<Chrome sceneIndex={0} />`,
].join("\n");
check("pieceSpanInCode: isolates a piece wrapper's span", () => {
  const span = pieceSpanInCode(asm, "s0.hero");
  assert(span !== null, "span found");
  const slice = asm.slice(span!.start, span!.end);
  assert(slice.includes("hero body"), "span contains the hero body");
  assert(!slice.includes("atmos"), "span excludes the previous piece");
  assert(!slice.includes("<Chrome"), "span stops before the Chrome mount");
});
check("pieceSpanInCode: missing piece → null", () => {
  assert(pieceSpanInCode(asm, "s9.hero") === null, "absent piece → null");
});

// ── computeTargets routing ────────────────────────────────────────────────────
const emptyProfile: DensityProfile = { scenes: [], distinctSignatures: 0, repeated: [], varietyPass: true };
const baseArgs = () => ({
  validPieceIds: new Set(["s0.hero", "s0.copy", "s0.atmosphere", "s1.hero"]),
  density: [],
  profile: emptyProfile,
  rtBlocking: [] as RenderTruthFinding[],
  washout: [] as HeroWashoutFinding[],
  accentFill: [] as AccentFillFinding[],
  edgeCropResidual: [],
  vision: [] as SceneVisionVerdict[],
  registers: ["split", "split"],
  pieceCache: new Map<string, string>(),
});

check("computeTargets: no findings → no targets", () => {
  const t = computeTargets(baseArgs());
  assert(t.size === 0, "clean → empty target map");
});

check("computeTargets: washout routes to its named hero", () => {
  const washout = [{
    scene: 0, pieceId: "s0.hero", detail: "washed out",
    repairInstruction: "lift the surface", stats: { spread: 10, stdDev: 5 },
  }] as unknown as HeroWashoutFinding[];
  const t = computeTargets({ ...baseArgs(), washout });
  assert(t.has("s0.hero"), "s0.hero targeted");
  assert(t.get("s0.hero")![0].includes("[hero-contrast/hero-washout]"), "carries the washout tag");
});

check("computeTargets (R4): a non-full-bleed barbell routes to the COPY slot", () => {
  const rtBlocking = [{ scene: 0, kind: "barbell", detail: "empty horizontal band ~40% of the frame" }] as unknown as RenderTruthFinding[];
  const t = computeTargets({ ...baseArgs(), rtBlocking, registers: ["split", "split"] });
  assert(t.has("s0.copy"), "barbell routed to the copy stack (row-arm/furnish own full-bleed voids)");
  assert(!t.has("s0.hero"), "barbell no longer routes a blocking regen to the hero");
  assert(t.get("s0.copy")![0].includes("[render-truth/barbell]"), "carries the barbell tag");
});

check("computeTargets: accent-fill routes to its piece", () => {
  const accentFill = [{
    scene: 1, pieceId: "s1.hero", detail: "accent slab",
    repairInstruction: "accent is punctuation",
  }] as unknown as AccentFillFinding[];
  const t = computeTargets({ ...baseArgs(), accentFill });
  assert(t.get("s1.hero")![0].includes("[accent-fill/accent-as-fill]"), "accent-fill routed");
});

check("computeTargets: severe copy-vision routes to the copy slot", () => {
  const vision: SceneVisionVerdict[] = [{
    scene: 0, ok: false, issues: ["headline unreadable"], actionable: ["headline unreadable"],
    severe: ["headline unreadable"],
  }];
  const t = computeTargets({ ...baseArgs(), vision });
  assert(t.has("s0.copy"), "headline severe → copy slot");
  assert(t.get("s0.copy")![0].startsWith("[vision]"), "vision tag");
});

check("P3-C2 #5: canvas-coherence on a FULL-BLEED scene routes to BOTH atmosphere and hero + names the brand token", () => {
  const rtBlocking = [{ scene: 0, kind: "canvas-coherence", detail: "scene 0 ships an OFF-BRAND canvas" }] as RenderTruthFinding[];
  const t = computeTargets({ ...baseArgs(), rtBlocking, registers: ["full-bleed", "split"], canvasBackground: "#15191e" });
  assert(t.has("s0.atmosphere") && t.has("s0.hero"), `both pieces targeted: ${[...t.keys()]}`);
  assert(t.get("s0.hero")!.some((l) => l.includes("#15191e") && /BANNED/.test(l)), "hero instruction names the brand token + bans the white full-canvas UI");
  assert(t.get("s0.atmosphere")!.some((l) => l.includes("#15191e")), "atmosphere instruction names the brand token");
});

check("P3-C2 #5: canvas-coherence on a NON-full-bleed scene routes to the atmosphere only", () => {
  const rtBlocking = [{ scene: 1, kind: "canvas-coherence", detail: "scene 1 ships an OFF-BRAND canvas" }] as RenderTruthFinding[];
  const t = computeTargets({ ...baseArgs(), validPieceIds: new Set(["s1.hero", "s1.atmosphere"]), rtBlocking, registers: ["split", "split"], canvasBackground: "#15191e" });
  assert(t.has("s1.atmosphere") && !t.has("s1.hero"), `atmosphere only: ${[...t.keys()]}`);
});

check("computeTargets: unknown piece falls back to the scene hero", () => {
  const washout = [{
    scene: 0, pieceId: "s0.nonexistent", detail: "x",
    repairInstruction: "y", stats: { spread: 1, stdDev: 1 },
  }] as unknown as HeroWashoutFinding[];
  const t = computeTargets({ ...baseArgs(), washout });
  assert(t.has("s0.hero") && !t.has("s0.nonexistent"), "invalid piece id → s0.hero fallback");
});

// ── dropAccentsNearCanvas (v16 #5 monochrome-luxury calibration) ──────────────
check("dropAccentsNearCanvas: signature accent == canvas is dropped", () => {
  // Superhuman: signature #421d25 accent ON a #421d25 aubergine canvas.
  const kept = dropAccentsNearCanvas(["#421d25"], "#421d25");
  assert(kept.length === 0, "accent identical to canvas → dropped");
});
check("dropAccentsNearCanvas: a loud accent on a distant canvas is kept", () => {
  // Tony's: red accent on cream canvas — huge distance, untouched.
  const kept = dropAccentsNearCanvas(["#e4002b"], "#fff4e0");
  assert(kept.length === 1 && kept[0] === "#e4002b", "distant accent survives");
});
check("dropAccentsNearCanvas: mixed vocab drops only the near-canvas tone", () => {
  const kept = dropAccentsNearCanvas(["#431e26", "#e4002b"], "#421d25");
  assert(!kept.includes("#431e26"), "near-canvas tone dropped");
  assert(kept.includes("#e4002b"), "real accent kept");
});
check("dropAccentsNearCanvas: unparseable canvas → no filtering", () => {
  const accents = ["#421d25"];
  assert(dropAccentsNearCanvas(accents, "not-a-hex").length === 1, "bad canvas → passthrough");
});
// cycle-9 P3: Tailscale light-minimal calibration — a LEGIT quiet/muted accent on
// a light off-white canvas is well past ΔRGB 24 and MUST survive (the threshold is
// tuned for near-identical monochrome tones only, never a real muted accent).
check("dropAccentsNearCanvas: a quiet muted accent on a light off-white canvas is kept", () => {
  // muted slate #6b7280 on off-white #f7f8fa — ΔRGB ≈ 229, far above the floor.
  const kept = dropAccentsNearCanvas(["#6b7280"], "#f7f8fa");
  assert(kept.length === 1 && kept[0] === "#6b7280", "quiet muted accent survives on a light canvas");
});
check("dropAccentsNearCanvas: only a near-canvas tint drops on a light palette", () => {
  // a soft #eef0f3 tint IS indistinguishable from #f7f8fa (ΔRGB ≈ 14) → dropped;
  // the visible muted accent #4b5563 (ΔRGB ≈ 250) → kept.
  const kept = dropAccentsNearCanvas(["#eef0f3", "#4b5563"], "#f7f8fa");
  assert(!kept.includes("#eef0f3"), "near-canvas tint dropped");
  assert(kept.includes("#4b5563"), "visible muted accent kept");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
