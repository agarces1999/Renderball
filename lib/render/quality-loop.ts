/**
 * runQualityLoop — the SHARED quality gate loop (extracted from the dogfood
 * spike, cycle 8 / task #205).
 *
 * BOTH callers drive the same loop:
 *   • scripts/dogfood-spike.ts — the overnight validation vehicle (keeps its
 *     acceptance/gallery/report scaffolding; delegates the gate loop here).
 *   • lib/render/run-preview-build.ts — the PRODUCTION build path, under
 *     RB_BUILD_MODE=cast (castBuild → assemble → this loop instead of the
 *     monolithic buildAnimatedSections).
 *
 * The loop owns: the piece cache, the class-matched no-progress breaker, the
 * regen-feedback caching caller, and the FULL gate battery + deterministic
 * repairs — density, broken-image swap, edge-crop clamp, stray-fragment excise,
 * structural gates, logo-glyph count, render-truth, hero-washout + forced
 * surface lift (interior repaint), hero-underscale, skeleton bars, accent-fill,
 * occupancy, per-text-node contrast, and per-scene vision. Everything that
 * differs between the two callers (the LLM transport + budget, the vision
 * judge, timing/telemetry sinks, genDir persistence, sequence-vision) is
 * injected via hooks so the loop's behavior is identical under either.
 *
 * The inline-ness of this loop in the 3100-line spike was WHY production lagged
 * five gate-versions behind — see .data/dogfood/STATE.md, cycle-7 finding #6.
 */
import { promises as fs } from "fs";
import path from "path";
import { castBuild, forceHeroSurfaceLift, subtleSurfaceLift, type CastBuildResult } from "../agents/cast-build";
import { findBrokenRenderedImages, swapBrokenImagesForWordmark } from "./image-integrity";
import { castCall, type CastResult, type CastCall } from "../llm/cast-provider";
import type { CastEffort } from "../llm/cast-provider";
import type { Theme } from "../edit/piece-model";
import type { Script } from "../../src/schema";
import { stripCodeFence, verifyCompilable } from "../agents/code-extraction";
import { injectLogoSrc, brandWordmarkText } from "../agents/logo-inject";
import { finalizeUndefinedRefs, assessInvalidLucideImports, type UndefinedValueStub } from "../agents/finalize-refs";
import { measureScenes, summarizeBoxOverflow, type SceneMeasurement } from "./measure-scene";
import {
  findRenderTruthFailures,
  findEdgeCroppedPieces,
  planEdgeCropMoves,
  hexLuminance,
  findStrayFragments,
  exciseStrayFragment,
  findMotifClutter,
  exciseMotifClutter,
  type MotifClutterFinding,
  type EdgeCropFinding,
  type RenderTruthFinding,
  type RenderTruthKind,
  type SlotTerritory,
} from "./render-truth-gates";
import {
  assessOccupancy,
  CARD_INTERIOR_FLOOR,
  type OccupancyVoidFinding,
  type OccupancySceneStat,
  type CardOccupancyAdvisory,
} from "./occupancy";
import { liftWashedPaletteTokens } from "./palette-lift";
import { readManifest, writeManifest } from "../agents/lego-store";
import { commitGenDir } from "../edit/commit";
import {
  buildFurnishPanelJsx,
  injectFurnishIntoSection,
  furnishRectForBand,
  furnishRectForRowBand,
  pickFurnishSurface,
  furnishDecision,
  isRedundantWithPainted,
  fitRectToContent,
  FURNISH_INSET_PX,
} from "./void-furnish";
import {
  extractQuotedValues,
  placeholderTitleFromSubject,
  isDescriptorValueRow,
  themeFontFamilyNames,
  SCENE_META_LABEL_RX,
} from "../agents/cast-build";
import { CANVAS } from "../agents/layout-composer";
import {
  assessTextNodeContrast,
  type TextContrastFinding,
  type TextContrastStat,
} from "./text-contrast";
import { clampPieceOffsets } from "../agents/assemble";
import {
  assessDensity,
  renderSectionsForAnalysis,
  parseHtmlStructure,
  pieceStats,
  maxDomDepth,
  gradientSignatures,
  imgSrcs,
  DIEGETIC_MIN_ELEMENTS,
  DIEGETIC_MIN_TEXT_NODES,
  HERO_MIN_ELEMENTS,
  HERO_MIN_TEXT_NODES,
  DEPTH_FLOOR,
  MIN_GRADIENT_SIGNATURES,
  MAX_SCENES_PER_SIGNATURE,
  IMG_SRC_WHITELIST,
  type DensityFinding,
  type HtmlNode,
} from "./density-gates";
import {
  assessHeroWashout,
  HERO_UNDERSCALE_MIN_FRAC,
  HERO_HEALTHY_FRAC,
  heroPaintedFraction,
  findHeroUnderscale,
  readDominantPanel,
  type HeroContrastResult,
  type HeroLuminanceStats,
  type HeroWashoutFinding,
  type HeroWashoutNearMiss,
  type HeroUnderscaleFinding,
} from "./hero-contrast";
import { findSkeletonBars, type SkeletonBarFinding } from "./skeleton-bars";
import {
  findIconFontTextStacks,
  stripIconFontsFromTextStacks,
  findOrphanedFragments,
  findCrossPieceStatDup,
  findBrandMarkDefects,
  assessAccentedGlyphCoverage,
  ensureLatin1Fallback,
  type IconFontStackFinding,
  type OrphanedFragmentFinding,
  type StatDupFinding,
  type BrandMarkFinding,
  type AccentedGlyphFinding,
} from "./text-integrity";
import {
  assessAccentFill,
  type AccentFillFinding,
  type AccentFillResult,
} from "./accent-fill";
import { countBrandMarks } from "../agents/quality-gates";
import {
  findOverflowingElements,
  findDuplicateLogos,
  hasCornerLogoSuppression,
  findUndefinedJsxComponents,
  findUnboundCopy,
  bindLiteralCopyInPlace,
  stripChromeEyebrowEchoes,
  findPlaceholderData,
  findProvidedComponentRedefinitions,
  type AspectRatio,
} from "../agents/quality-gates";
import { sectionRanges } from "../agents/section-splice";
import { expandSpecMarkers } from "../pieces/expand";
import { pieceSpecEnabled } from "../pieces/prompt";
import { makeFontFetcher, inlineFontFaces } from "./font-inline";

// ─── shared types ────────────────────────────────────────────────────────────

/** v12 (#1): CLASS-MATCHED retry history — progress is judged on the finding
 *  class that targeted the piece, not a proxy metric. */
export type FailureClass =
  | "washout"
  | "render-truth"
  | "accent-fill"
  | "density"
  | "vision"
  // Audit-1 Medium #5: hero-underscale + occupancy-void are ONE judgment now —
  // "the hero owns a void frame". Merging them into a single breaker class stops
  // a small-hero-in-a-void scene from oscillating between the two classes every
  // round (which reset the no-progress tracker and burned the whole retry budget
  // without converging).
  | "hero-void"
  | "skeleton"
  | "text-contrast";

export interface StructuralFinding {
  scene: number;
  key: string;
  detail: string;
}

export interface SceneVisionVerdict {
  scene: number;
  ok: boolean;
  issues: string[];
  actionable: string[];
  severe: string[];
  error?: string;
}

export interface BrandTruthLite {
  name?: string;
  backgroundColor?: string;
  accent?: string;
  fonts?: string[];
}

export interface SceneDensityProfile {
  scene: number;
  ssrError?: string;
  bestDiegetic: { id: string; elements: number; textNodes: number } | null;
  diegeticPass: boolean;
  hero: { id: string; elements: number; textNodes: number } | null;
  heroPass: boolean;
  depth: number;
  depthPass: boolean;
  gradientSignatures: string[];
  badImgSrcs: string[];
  pieces: { id: string; elements: number; textNodes: number }[];
}

export interface DensityProfile {
  scenes: SceneDensityProfile[];
  distinctSignatures: number;
  repeated: { signature: string; scenes: number[] }[];
  varietyPass: boolean;
}

export interface EdgeCropEvent {
  round: number;
  pieceId: string;
  action: "clamped" | "clamp-skipped" | "clamp-refused-regen-routed" | "residual-after-clamp";
  detail: string;
}

/** v12 (#2): the washout gate→backstop closure ledger. */
export interface WashoutLiftEvent {
  round: number;
  pieceId: string;
  /** v16: "sparse-furnish-routed" = paint-lift REFUSED because the panel's
   *  interior is mostly empty (a dark coat on emptiness is a black filler box,
   *  the live-measured Notion defect) — routed to an AI furnish regen instead.
   *  "subtle-terminal" = post-loop floor: border+tint+shadow, never ink. */
  action: "forced-lift" | "lift-noop-regen-routed" | "sparse-furnish-routed" | "subtle-terminal";
  via: "paint-rewrite" | "root-override" | null;
  targetToken: string | null;
  interiorTextRepaints: number;
  before: { spread: number; std: number };
  after: { spread: number; std: number } | null;
  cleared: boolean | null;
  /** v16: a forced lift that manufactured blocking text-contrast inside the
   *  piece is rolled back (the invariant the lift claims, now enforced). */
  reverted?: boolean;
  revertReason?: string;
}

/** v12 (#4): broken rendered images swapped to the text wordmark. */
export interface ImgSwapEvent {
  round: number;
  scene: number;
  pieceId: string;
  src: string;
  via: string;
}

/** v15 (#4): stray accent fragments (crossing/isolated bars). */
export interface StrayFragmentEvent {
  round: number;
  scene: number;
  pieceId: string;
  form: "crossing" | "isolated";
  action: "clipped" | "removed" | "none";
  detail: string;
}

/** Motif clutter (ghost glyphs / floating brand pills on the decoration layers)
 *  excised deterministically from the assembled Composition. */
export interface MotifClutterEvent {
  round: number;
  scene: number;
  pieceId: string;
  form: "decorative-glyph" | "floating-brand-mark" | "floating-motif" | "protruding-motif";
  action: "blanked" | "stripped" | "none";
  detail: string;
}

/** cycle-9 P1: icon-font-in-a-text-role stripped from the assembled Composition. */
export interface IconFontStripEvent {
  round: number;
  site: string;
  family: string;
}

/** P3-C3: a blocking void that survived the loop, filled DETERMINISTICALLY with
 *  a brand furnish panel (the void-convergence guarantee) — or, when injection
 *  could not land, left flagged. */
export interface VoidFurnishEvent {
  scene: number;
  pieceId: string;
  runFracW: number;
  region: string;
  action: "furnished" | "furnished-residual" | "skipped" | "skipped-healthy-hero";
  detail: string;
}

/** cycle-10 P2: a text stack with no accented-glyph coverage, given a Latin-1
 *  fallback deterministically (the accented analogue of the icon-font strip). */
export interface AccentFallbackEvent {
  round: number;
  stack: string;
  added: string;
}

/** v13 (#5): bind-in-place ledger. */
export interface BindCopyEvent {
  round: number;
  scene: number;
  field: string;
  accessor: string;
  count: number;
}

export interface NoProgressEvent {
  pieceId: string;
  round: number;
  action: "escalated" | "accepted-and-flagged";
  cls: FailureClass;
  metric: string;
  finding?: string;
}

export interface CacheBustEvent {
  pieceId: string;
  reason: string;
}

export interface GateRoundReport {
  round: number;
  llmCallsThisRound: number;
  castTelemetry: CastBuildResult["telemetry"] | null;
  density: DensityFinding[];
  profile: DensityProfile;
  structural: StructuralFinding[];
  renderTruthAll: RenderTruthFinding[];
  renderTruthBlocking: RenderTruthFinding[];
  heroContrast: { stats: HeroLuminanceStats[]; findings: HeroWashoutFinding[]; errors: string[] };
  washoutNearMiss: HeroWashoutNearMiss[];
  heroUnderscale: HeroUnderscaleFinding[];
  skeletonBars: SkeletonBarFinding[];
  washoutsAtGate: number;
  washoutLifts: WashoutLiftEvent[];
  imgSwaps: ImgSwapEvent[];
  accentFill: { stats: AccentFillResult["stats"]; findings: AccentFillFinding[]; errors: string[] };
  edgeCrop: { initial: EdgeCropFinding[]; residual: EdgeCropFinding[] };
  occupancy: {
    stats: OccupancySceneStat[];
    findings: OccupancyVoidFinding[];
    cardAdvisories: CardOccupancyAdvisory[];
    errors: string[];
  };
  textContrast: {
    blocking: TextContrastFinding[];
    advisories: TextContrastFinding[];
    stats: TextContrastStat[];
    errors: string[];
  };
  strayFragments: StrayFragmentEvent[];
  /** cycle-9 P1: icon fonts stripped out of text stacks this round (deterministic). */
  iconFontStrips: IconFontStripEvent[];
  /** cycle-9 P1: measured orphaned copy fragments (blocking). */
  orphanedFragments: OrphanedFragmentFinding[];
  /** cycle-10 P1: cross-piece duplicate stat + numeric-format drift (blocking). */
  crossPieceStatDups: StatDupFinding[];
  /** cycle-10 P1: garbled / duplicate brand marks off-chrome (blocking). */
  brandMarkDefects: BrandMarkFinding[];
  /** cycle-10 P2: text stacks lacking accented-glyph coverage (auto-repaired). */
  accentedGlyphGaps: AccentedGlyphFinding[];
  vision: SceneVisionVerdict[];
  targets: { pieceId: string; feedback: string[] }[];
}

export interface Round0Report {
  passed: boolean;
  targets: string[];
  density: number;
  washoutsAtGate: number;
  washoutsLifted: number;
  washouts: number;
  accentFills: number;
  brokenImgs: number;
  edgeCropsInitial: number;
  edgeCropsClamped: number;
  edgeCropsResidual: number;
  heroUnderscale: number;
  washoutNearMiss: number;
  skeletonBarsAdvisory: number;
  skeletonBarsBlocking: number;
  occupancyVoidsBlocking: number;
  occupancyVoidsAdvisory: number;
  cardInteriorAdvisory: number;
  textContrastBlocking: number;
  textContrastAdvisory: number;
  strayFragments: number;
  iconFontStrips: number;
  orphanedFragments: number;
  crossPieceStatDups: number;
  brandMarkDefects: number;
  accentedGlyphGaps: number;
  structural: number;
  rtBlocking: number;
  visionSevereScenes: number[];
}

/** A minimal script shape the gate battery reads. */
export interface LoopScript {
  scenes: {
    register?: string;
    visual_concept?: string;
    content?: Record<string, unknown>;
    [k: string]: unknown;
  }[];
  config?: { aspect_ratio?: string; duration_seconds?: number };
  [k: string]: unknown;
}

/** The raw LLM transport the caching caller wraps. The spike passes a
 *  budgeted/fast-router adapter; production passes a cast-provider + spend
 *  adapter. Both return a CastResult. */
export type QualityLoopTransport = (args: {
  label: string;
  system: string;
  user: string;
  maxTokens: number;
  model: string | undefined;
  effort?: CastEffort;
  json?: boolean;
}) => Promise<CastResult>;

export interface QualityLoopConfig {
  /** castBuild's input — script (with blueprints), theme, palette, aspect. */
  castInput: {
    script: Script;
    theme: Theme;
    palette: string[];
    signatureAccent?: string;
    aspect: "16:9" | "9:16" | "1:1";
  };
  /** The gate battery reads the loose script shape (registers, concepts, content). */
  script: LoopScript;
  genDir: string;
  brand: string;
  logoSrc: string | undefined;
  /** Always-derived canvas (resolveCanvasPlan().background) — never raw bg. */
  canvasBackground: string;
  /** Accent vocabulary for accent-fill + stray-fragment probing. */
  accentHexes: string[];
  brandTruth: BrandTruthLite;
  /** Per-scene registers (script.scenes[].register), for register-aware routing. */
  registers: (string | undefined)[];
  maxRetryRounds: number;
  blockingKinds: RenderTruthKind[];
  edgeClampMarginPx: number;
  /** call.model fallback for the caching caller (spike: fast router; prod: undefined). */
  defaultCastModel?: string;
}

export interface QualityLoopHooks {
  /** Raw LLM transport (budget/logging live in the caller's adapter). */
  transport: QualityLoopTransport;
  /** Per-scene vision round. Omit to skip vision entirely. */
  runPerSceneVision?: (
    measurements: SceneMeasurement[],
    script: LoopScript,
    brandTruth: BrandTruthLite,
  ) => Promise<SceneVisionVerdict[]>;
  /** Write the shim set + script.json into genDir ONCE. */
  ensureGenDir: () => Promise<void>;
  /** Persist the current Composition.tsx into genDir (called every rewrite). */
  writeComposition: (code: string) => Promise<void>;
  /** True → the loop stops spending and ships with residual findings (honest). */
  shouldStopForBudget: () => boolean;
  /** Advisory sequence notes threaded into every regen prompt; read fresh. */
  getSequenceNotes?: () => string[];
  /** Called after each round's gate battery — the spike pushes gateRounds,
   *  fires the detached sequence judge, updates timing, and re-writes the report. */
  onRoundComplete?: (r: {
    gateRound: GateRoundReport;
    round: number;
    measurements: SceneMeasurement[];
    finalCode: string;
    round0: Round0Report | null;
  }) => void | Promise<void>;
  /** Per-round finalize telemetry (fonts inlined, refs stubbed, copy bound). */
  onFinalize?: (round: number, info: Record<string, unknown>) => void;
  /** Cache-replay ledger rows (the spike routes them into its call log). */
  onCacheReplay?: (row: { label: string; kind: string }) => void;
  /** Timing wrapper; defaults to a pass-through. */
  phase?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Font fetcher for inlineFontFaces; defaults to makeFontFetcher(). */
  fetchFont?: ReturnType<typeof makeFontFetcher>;
}

export interface QualityLoopResult {
  finalCode: string;
  finalMeasurements: SceneMeasurement[];
  gateRounds: GateRoundReport[];
  roundTelemetry: CastBuildResult["telemetry"][];
  round0: Round0Report | null;
  rounds: number;
  castResult: CastBuildResult | null;
  profile: DensityProfile | null;
  finalContrast: HeroContrastResult | null;
  finalAccentFill: AccentFillResult | null;
  pieceCache: Map<string, string>;
  events: {
    edgeCropEvents: EdgeCropEvent[];
    washoutLiftEvents: WashoutLiftEvent[];
    imgSwapEvents: ImgSwapEvent[];
    strayFragmentEvents: StrayFragmentEvent[];
    motifClutterEvents: MotifClutterEvent[];
    iconFontStripEvents: IconFontStripEvent[];
    accentFallbackEvents: AccentFallbackEvent[];
    bindCopyEvents: BindCopyEvent[];
    noProgressEvents: NoProgressEvent[];
    cacheBustEvents: CacheBustEvent[];
    voidFurnishEvents: VoidFurnishEvent[];
  };
  finalize: Record<string, unknown>;
  /** Set when castBuild threw on a round (the loop breaks and ships nothing new). */
  castRoundError?: { round: number; error: string };
}

// ─── constants ───────────────────────────────────────────────────────────────

const PIECE_ID_RX = /\bs\d+\.(?:hero|copy|atmosphere|connector|throughline)\b/g;
const VISION_COPY_RX = /\b(head(?:line)?|lede|bullet|caption|copy|paragraph|typograph|font|wall of type|text\b)/i;
const VISION_ATMOS_RX = /\b(background|canvas|atmosphere|glow|gradient|vignette|grain|wash)\b/i;
const ESCALATION_MARK = "[NO-PROGRESS ESCALATION]";

// ─── pure helpers (moved verbatim from the spike) ────────────────────────────

/** Parse #rgb / #rrggbb → [r,g,b], else null. */
const hexToRgb = (hex: string): [number, number, number] | null => {
  const h = (hex ?? "").replace("#", "").trim();
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};

/**
 * v16 (#5): accent-fill calibration for monochrome-luxury palettes. A signature
 * accent that sits within ΔRGB of the canvas tone (Superhuman's #421d25 accent
 * ON a #421d25 aubergine canvas — cycle-7 finding) is NOT "accent as fill": a
 * flat rect of it is visually indistinguishable from the canvas, so probing for
 * it FP-flags a legitimate brand surface. Drop such near-canvas hexes from the
 * accent-fill probe vocabulary. Loud multicolor brands (Tony's red on cream) are
 * untouched — the distance is large. Threshold 24 of a 441 max only catches
 * near-identical tones (the monochrome case), never a real punctuation accent.
 */
export const ACCENT_CANVAS_DE_FLOOR = 24;
export const dropAccentsNearCanvas = (
  accentHexes: string[],
  canvasBg: string,
  threshold = ACCENT_CANVAS_DE_FLOOR,
): string[] => {
  const c = hexToRgb(canvasBg);
  if (!c) return accentHexes;
  return accentHexes.filter((a) => {
    const r = hexToRgb(a);
    if (!r) return true; // unparseable stays; assessAccentFill ignores it anyway
    const d = Math.sqrt((r[0] - c[0]) ** 2 + (r[1] - c[1]) ** 2 + (r[2] - c[2]) ** 2);
    return d >= threshold;
  });
};

/** Alpha of a css rgb()/rgba() color (opaque hex/rgb → 1; unparseable → 0). */
export const cssAlphaOf = (color: string): number => {
  if (/^#/.test(color?.trim() ?? "")) return 1;
  const m = /rgba?\(([^)]+)\)/.exec(color || "");
  if (!m) return 0;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  return p.length >= 4 ? (Number.isNaN(p[3]) ? 1 : p[3]) : 1;
};

/** The span of ONE piece's wrapper + own body inside the ASSEMBLED composition:
 *  from its `data-piece` wrapper's opening `<div` to just before the NEXT
 *  data-piece wrapper or the Section's <Chrome mount. Used by the v12 forced
 *  washout lift to rewrite a hero's paints in-place without re-assembling. */
export const pieceSpanInCode = (code: string, pieceId: string): { start: number; end: number } | null => {
  const marker = `data-piece=${JSON.stringify(pieceId)}`;
  const at = code.indexOf(marker);
  if (at === -1) return null;
  const start = code.lastIndexOf("<div", at);
  if (start === -1) return null;
  const nextMarker = code.indexOf("data-piece=", at + marker.length);
  const nextChrome = code.indexOf("<Chrome sceneIndex=", at + marker.length);
  let end = code.length;
  if (nextMarker !== -1) {
    const wrapperOpen = code.lastIndexOf("<div", nextMarker);
    end = wrapperOpen > start ? wrapperOpen : nextMarker;
  }
  if (nextChrome !== -1 && nextChrome < end) end = nextChrome;
  return { start, end };
};

export const buildDensityProfile = (code: string, script: unknown): DensityProfile => {
  const renders = renderSectionsForAnalysis(code, script);
  const scenes: SceneDensityProfile[] = [];
  const bySig = new Map<string, number[]>();
  for (const r of renders) {
    if (r.html == null) {
      scenes.push({ scene: r.scene, ssrError: r.error, bestDiegetic: null, diegeticPass: false, hero: null, heroPass: false, depth: 0, depthPass: false, gradientSignatures: [], badImgSrcs: [], pieces: [] });
      continue;
    }
    const roots: (HtmlNode | string)[] = parseHtmlStructure(r.html);
    const pieces = pieceStats(roots);
    const diegetics = pieces.filter((p) => p.kind === "diegetic");
    const best = diegetics.slice().sort((a, b) => b.elements + b.textNodes * 2 - (a.elements + a.textNodes * 2))[0] ?? null;
    const heroes = pieces.filter((p) => p.id.endsWith(".hero"));
    const hero = heroes[0] ?? null;
    const sigs = [...gradientSignatures(roots)];
    for (const sig of sigs) bySig.set(sig, [...(bySig.get(sig) ?? []), r.scene]);
    scenes.push({
      scene: r.scene,
      bestDiegetic: best ? { id: best.id, elements: best.elements, textNodes: best.textNodes } : null,
      diegeticPass: !!diegetics.find((p) => p.elements >= DIEGETIC_MIN_ELEMENTS && p.textNodes >= DIEGETIC_MIN_TEXT_NODES),
      hero: hero ? { id: hero.id, elements: hero.elements, textNodes: hero.textNodes } : null,
      heroPass: heroes.length === 0 || heroes.every((h) => h.elements >= HERO_MIN_ELEMENTS && h.textNodes >= HERO_MIN_TEXT_NODES),
      depth: maxDomDepth(roots),
      depthPass: maxDomDepth(roots) >= DEPTH_FLOOR,
      gradientSignatures: sigs,
      badImgSrcs: imgSrcs(roots).filter((src) => !IMG_SRC_WHITELIST.test(src)),
      pieces: pieces.map((p) => ({ id: p.id, elements: p.elements, textNodes: p.textNodes })),
    });
  }
  const repeated = [...bySig.entries()]
    .filter(([, list]) => new Set(list).size > MAX_SCENES_PER_SIGNATURE)
    .map(([signature, list]) => ({ signature, scenes: [...new Set(list)].sort((a, b) => a - b) }));
  return {
    scenes: scenes.sort((a, b) => a.scene - b.scene),
    distinctSignatures: bySig.size,
    repeated,
    varietyPass: bySig.size >= MIN_GRADIENT_SIGNATURES && repeated.length === 0,
  };
};

export const runStructuralGates = (composition: string, script: LoopScript): StructuralFinding[] => {
  const out: StructuralFinding[] = [];
  const ranges = sectionRanges(composition);
  const scenesContaining = (needle: string): number[] =>
    ranges.filter((r) => composition.slice(r.start, r.end).includes(needle)).map((r) => r.index);
  const attributed = (needle: string): number[] => {
    const hits = scenesContaining(needle);
    return hits.length > 0 ? hits : [-1];
  };
  for (const name of findProvidedComponentRedefinitions(composition)) {
    for (const scene of attributed(`const ${name}`))
      out.push({ scene, key: "provided_component_redefined", detail: `${name} is a PROVIDED component — re-creating provided components is rejected.` });
  }
  for (const p of findPlaceholderData(composition)) {
    out.push({ scene: p.section, key: "placeholder_data", detail: `Placeholder/unresolved data on screen: ${p.token} (…${p.context}…). Every price, stat, and label must be a CONCRETE literal.` });
  }
  for (const icon of assessInvalidLucideImports(composition)) {
    for (const scene of attributed(`<${icon}`))
      out.push({ scene, key: "invalid_lucide_imports", detail: `Invalid lucide-react import — ${icon} does not exist in lucide-react and will crash the render.` });
  }
  for (const tag of findUndefinedJsxComponents(composition)) {
    for (const scene of attributed(`<${tag}`))
      out.push({ scene, key: "undefined_jsx_components", detail: `Undefined JSX component <${tag}> — resolves to undefined at runtime → white screen.` });
  }
  for (const u of findUnboundCopy(composition, (script.scenes ?? []) as never)) {
    out.push({ scene: u.scene, key: "unbound_copy", detail: `Baked-in script copy — scene ${u.scene} ${u.field} ("${u.excerpt}") is retyped as literal JSX instead of bound via c.${u.field}.` });
  }
  const aspect = (script.config?.aspect_ratio ?? "16:9") as AspectRatio;
  for (const w of findOverflowingElements(composition, aspect)) {
    for (const scene of attributed(String(w)))
      out.push({ scene, key: "overflow_crop", detail: `Off-canvas crop — element with width ${w}px crosses the ${aspect} canvas edge.` });
  }
  const logoCount = findDuplicateLogos(composition);
  if (logoCount > 1 && !hasCornerLogoSuppression(composition)) {
    const re = /<Img\b[^>]*\bsrc=\{?\s*["'`]?[^}"'`>\s]*logo/i;
    const hits = ranges.filter((r) => re.test(composition.slice(r.start, r.end))).map((r) => r.index);
    for (const scene of hits.length > 0 ? hits : [-1])
      out.push({ scene, key: "duplicate_logo", detail: `Duplicate brand logo — the logo image appears at ${logoCount} sites; Chrome already carries the brand mark on every scene.` });
  }
  return out;
};

export const computeTargets = (args: {
  validPieceIds: Set<string>;
  density: DensityFinding[];
  profile: DensityProfile;
  rtBlocking: RenderTruthFinding[];
  washout: HeroWashoutFinding[];
  accentFill: AccentFillFinding[];
  edgeCropResidual: EdgeCropFinding[];
  vision: SceneVisionVerdict[];
  underscale?: HeroUnderscaleFinding[];
  skeletonBlocking?: SkeletonBarFinding[];
  occupancyVoids?: OccupancyVoidFinding[];
  textContrastBlocking?: TextContrastFinding[];
  registers?: (string | undefined)[];
  /** Brand canvas token (#rrggbb) — named in the canvas-coherence repair so the
   *  head is forced onto the exact brand background (P3-C2 #5). */
  canvasBackground?: string;
  /** Pieces that compile-broke / shipped a placeholder this round. Audit-1 High
   *  #3: their occupancy-void does NOT route a regen (regen can't fix a hero GLM
   *  keeps breaking) — the deterministic post-loop furnish owns it. */
  castFailedPieces?: Set<string>;
  /** Piece bodies, for the density/img-src owner lookup. */
  pieceCache: Map<string, string>;
}): Map<string, string[]> => {
  const { validPieceIds, density, profile, rtBlocking, washout, accentFill, edgeCropResidual, vision, underscale, skeletonBlocking, occupancyVoids, textContrastBlocking, registers, canvasBackground, castFailedPieces, pieceCache } = args;
  const targets = new Map<string, string[]>();
  const add = (pieceId: string, sceneFallback: number, feedback: string): void => {
    let id = pieceId;
    if (!validPieceIds.has(id)) id = `s${sceneFallback}.hero`;
    if (!validPieceIds.has(id)) return;
    targets.set(id, [...(targets.get(id) ?? []), feedback]);
  };

  const measureErrorScenes = new Map<number, string[]>();
  for (const f of density) {
    if (f.kind === "density-measure-error" && f.scene >= 0) {
      measureErrorScenes.set(f.scene, [...(measureErrorScenes.get(f.scene) ?? []), `${f.detail}`]);
    }
  }
  for (const f of rtBlocking) {
    if (f.kind === "measure-error" && f.scene >= 0) {
      measureErrorScenes.set(f.scene, [...(measureErrorScenes.get(f.scene) ?? []), `${f.detail}`]);
    }
  }
  for (const [scene, details] of measureErrorScenes) {
    const scenePieces = [...validPieceIds].filter((id) => id.startsWith(`s${scene}.`));
    const feedback = [
      `[render-truth/measure-error → FULL SCENE RE-CAST] scene ${scene} failed to render ENTIRELY: ${[...new Set(details)].join(" · ")}.`,
      `The assembled Section${scene} component threw at render time, so every element in this scene is being regenerated (yours included — the defect may live in any of them).`,
      `Re-emit this element as fully SELF-CONTAINED, render-safe JSX: define inline (inside this element) every array/object you index; never index a possibly-undefined value (no data[0] on data that might not exist); no references to variables this element does not itself define (beyond the provided design-system consts and components); balanced tags; valid inline styles.`,
    ].join("\n");
    for (const id of scenePieces) add(id, scene, feedback);
  }

  for (const f of density) {
    if (f.kind === "thin-diegetic" || f.kind === "shallow-dom") {
      add(`s${f.scene}.hero`, f.scene, `[density/${f.kind}] ${f.detail}\n${f.repairInstruction}`);
    } else if (f.kind === "thin-hero") {
      const named = /"(s\d+\.[^"]*hero)"/.exec(f.detail)?.[1];
      add(named ?? `s${f.scene}.hero`, f.scene, `[density/thin-hero] ${f.detail}\n${f.repairInstruction}`);
    } else if (f.kind === "img-src") {
      const badTokens = [...f.detail.matchAll(/"([^"]{1,60})"/g)].map((m) => m[1]);
      let owner: string | null = null;
      for (const [pieceId, body] of pieceCache) {
        if (!pieceId.startsWith(`s${f.scene}.`)) continue;
        if (badTokens.some((t) => body.includes(t))) { owner = pieceId; break; }
      }
      add(owner ?? `s${f.scene}.hero`, f.scene, `[density/img-src] ${f.detail}\n${f.repairInstruction}`);
    }
  }
  const monotony = density.filter((f) => f.kind === "atmosphere-monotony");
  if (monotony.length > 0) {
    const scenesToVary = new Set<number>();
    for (const rep of profile.repeated) for (const s of rep.scenes.slice(MAX_SCENES_PER_SIGNATURE)) scenesToVary.add(s);
    if (scenesToVary.size === 0 && profile.distinctSignatures < MIN_GRADIENT_SIGNATURES) {
      scenesToVary.add(1);
      scenesToVary.add(3);
    }
    const fb = monotony.map((f) => `[density/atmosphere-monotony] ${f.detail}\n${f.repairInstruction}`).join("\n");
    for (const s of scenesToVary) {
      add(`s${s}.atmosphere`, s, `${fb}\nTHIS scene (${s}) must get a visibly DIFFERENT atmospheric treatment from the other scenes — change the gradient geometry (type, origin, angle, stops), not the brand colors.`);
    }
  }
  for (const f of washout) {
    add(f.pieceId, f.scene, `[hero-contrast/hero-washout] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of underscale ?? []) {
    add(f.pieceId, f.scene, `[hero-scale/hero-underscale] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of skeletonBlocking ?? []) {
    add(f.pieceId, f.scene, `[structural/skeleton_bars] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of occupancyVoids ?? []) {
    // Audit-1 High #3: skip the regen for a compile-broken/placeholder hero — a
    // regen can't fix a hero the model keeps breaking; the deterministic furnish
    // fills its void post-loop. Non-failed heroes still get the regen route.
    if (castFailedPieces?.has(f.pieceId)) continue;
    add(f.pieceId, f.scene, `[occupancy/occupancy-void] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of textContrastBlocking ?? []) {
    add(f.pieceId, f.scene, `[text-contrast/text-contrast] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of accentFill) {
    add(f.pieceId, f.scene, `[accent-fill/accent-as-fill] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of edgeCropResidual) {
    add(f.pieceId, f.scene, `[render-truth/piece-edge-crop] ${f.detail}\n${f.repairInstruction}`);
  }
  for (const f of rtBlocking) {
    if (f.kind === "measure-error" || f.scene < 0) continue;
    const named = (f.detail.match(PIECE_ID_RX) ?? []).filter((id) => !/\.chrome$/.test(id));
    if (named.length > 0) {
      for (const id of new Set(named)) {
        let fb = `[render-truth/${f.kind}] ${f.detail}`;
        if (f.kind === "cross-piece-overlap") {
          if (/\.hero$/.test(id)) {
            fb += `\nYOUR ROLE IN THE FIX (${id}): your mock must NOT own the full canvas — keep EVERY row, label, and panel strictly inside your own wrapper (width/height 100% max, overflow hidden). Content extending under the neighboring copy column is the defect; shrink or crop the shell so the copy column is untouched canvas.`;
          } else if (/\.copy$/.test(id)) {
            fb += `\nYOUR ROLE IN THE FIX (${id}): set the ENTIRE copy stack on ONE opaque panel — a solid palette-token surface (contrasting the canvas) with real padding behind every line — so the column owns a readable surface whatever sits behind it; keep all text inside your wrapper.`;
          }
        }
        add(id, f.scene, fb);
      }
    } else if (f.kind === "barbell") {
      // R4 (audit-2): full-bleed barbell is filtered to advisory before this point
      // (the row-arm/furnish own full-bleed bands), so any barbell that reaches
      // here is a non-full-bleed scene — route it to the copy stack.
      add(`s${f.scene}.copy`, f.scene, `[render-truth/barbell] ${f.detail}`);
    } else if (f.kind === "canvas-coherence" || f.kind === "canvas-brightness") {
      // Canvas-wash defects: the atmosphere owns the full-bleed canvas. P3-C2 #5
      // (Brex s0): when the HERO is full-bleed it IS the canvas — it shipped a
      // pure-white full-canvas "before" UI that covered the (dark) atmosphere, so
      // repainting only the atmosphere never converged. Route BOTH pieces and
      // force the brand canvas token, banning the full-canvas light UI outright.
      const register = registers?.[f.scene];
      const forceCanvas =
        `\nMANDATORY (this scene ships an OFF-BRAND canvas): the full-bleed background MUST be the brand canvas ${canvasBackground} exactly — NOT a lighter tint, NOT white, NOT a neutral near-black. Do not fabricate a different tone.`;
      add(`s${f.scene}.atmosphere`, f.scene, `[render-truth/${f.kind}] ${f.detail}${forceCanvas}`);
      if (register === "full-bleed") {
        add(
          `s${f.scene}.hero`,
          f.scene,
          `[render-truth/${f.kind}] ${f.detail}${forceCanvas}\nYOUR ROLE (full-bleed hero = the canvas): a full-canvas LIGHT product UI ("before" draft/dashboard) painted over the whole frame is BANNED — it makes the scene read as a different, off-brand video. Set your outermost surface to the brand canvas ${canvasBackground} and render the tension in COLD GRAYS / muted brand-palette ink ON that dark canvas (a dim receipt card, faded rows, an inert button) — never a bright white sheet filling the frame.`,
        );
      }
    } else {
      // everything else routes to the hero.
      add(`s${f.scene}.hero`, f.scene, `[render-truth/${f.kind}] ${f.detail}`);
    }
  }
  for (const v of vision) {
    for (const issue of v.severe) {
      const slot = VISION_COPY_RX.test(issue) && !/mock|dashboard|window|panel|chart/i.test(issue)
        ? "copy"
        : VISION_ATMOS_RX.test(issue) && !/mock|dashboard|window|panel|chart|logo|image/i.test(issue)
          ? "atmosphere"
          : "hero";
      add(`s${v.scene}.${slot}`, v.scene, `[vision] ${issue}`);
    }
  }
  return targets;
};

// ─── the loop ────────────────────────────────────────────────────────────────

const passthroughPhase = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

/**
 * Drive castBuild + the gate battery + deterministic repairs + the class-matched
 * no-progress breaker + the retry ladder to convergence (or the round/budget
 * ceiling). Returns the gated composition + full telemetry; every caller-specific
 * concern (transport, vision, timing, persistence, sequence) is injected.
 */
export async function runQualityLoop(
  config: QualityLoopConfig,
  hooks: QualityLoopHooks,
): Promise<QualityLoopResult> {
  const phase = hooks.phase ?? passthroughPhase;
  const log = hooks.log ?? ((m: string) => console.log(m));
  const warn = hooks.warn ?? ((m: string) => console.warn(m));
  const fetchFont = hooks.fetchFont ?? makeFontFetcher();
  const { genDir, brand: BRAND, canvasBackground, accentHexes, brandTruth, script } = config;
  const theme = config.castInput.theme;
  const sceneRegisters = config.registers;

  // ── loop-owned state ──────────────────────────────────────────────────────
  const pieceCache = new Map<string, string>();
  let pieceTargets = new Map<string, string[]>();
  let castRoundLabel = "cast-r0";
  const cacheBustEvents: CacheBustEvent[] = [];
  const noProgressEvents: NoProgressEvent[] = [];
  const washoutLiftEvents: WashoutLiftEvent[] = [];
  const imgSwapEvents: ImgSwapEvent[] = [];
  const strayFragmentEvents: StrayFragmentEvent[] = [];
  const motifClutterEvents: MotifClutterEvent[] = [];
  const iconFontStripEvents: IconFontStripEvent[] = [];
  const accentFallbackEvents: AccentFallbackEvent[] = [];
  const voidFurnishEvents: VoidFurnishEvent[] = [];
  const bindCopyEvents: BindCopyEvent[] = [];
  const edgeCropEvents: EdgeCropEvent[] = [];
  const regenHistory = new Map<string, { cls: FailureClass; value: number; aux: number; escalated: boolean }>();
  // P3-C2 #5: canvas-coherence gets exactly ONE convergence round past the
  // budget when it is the only class left — a frame on the wrong canvas must
  // converge, not ship flagged.
  let coherenceBonusUsed = false;

  const gateRounds: GateRoundReport[] = [];
  const roundTelemetry: CastBuildResult["telemetry"][] = [];
  const finalize: Record<string, unknown> = {};
  let profile: DensityProfile | null = null;
  let finalMeasurements: SceneMeasurement[] = [];
  let finalContrast: HeroContrastResult | null = null;
  let finalAccentFill: AccentFillResult | null = null;
  let round0: Round0Report | null = null;

  const sequenceNotesBlock = (): string[] => {
    const notes = hooks.getSequenceNotes?.() ?? [];
    return notes.length === 0
      ? []
      : [
          ``,
          `════ SEQUENCE NOTES TO AVOID (advisory — a video-wide judge flagged these across ALL scenes) ════`,
          ...notes.map((n) => `- ${n}`),
          `Do not repeat these video-wide patterns in your rebuild (vary the archetype/atmosphere rather than restaging the same composition).`,
        ];
  };

  const verifyFragmentCheap = (body: string): Promise<string | null> =>
    verifyCompilable(`const __CastPiece = () => (\n<div>\n${body}\n</div>\n);`);

  // ── caching + feedback caller for castBuild ───────────────────────────────
  const cachingCaller: typeof castCall = async (call) => {
    // The cast path always sends a single-turn `user` prompt (the optional
    // multi-turn `messages` form is the build-client shim's, never used here).
    const userText = call.user ?? "";
    const pieceId = /piece id "([^"]+)"/.exec(userText)?.[1] ?? "?";
    const feedback = pieceTargets.get(pieceId);
    let cached = pieceCache.get(pieceId);
    const isRepair = userText.includes("Your previous attempt failed");
    const isTransportRepair = isRepair && userText.includes("(the call itself failed)");
    if (isTransportRepair && cached !== undefined) {
      hooks.onCacheReplay?.({ label: `${castRoundLabel}:${pieceId}:transport-repair-replayed-cache`, kind: "cached-replay" });
      warn(`  [cache] ${pieceId}: repair caused by a failed CALL, not a failed body — cached emission replayed, entry kept`);
      return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "cached-replay" };
    }
    if (isRepair && cached !== undefined) {
      pieceCache.delete(pieceId);
      cached = undefined;
      cacheBustEvents.push({ pieceId, reason: "repair call — cached emission failed cast-build's full element gate; entry busted" });
      warn(`  [cache-bust] ${pieceId}: cached emission disproven by a repair call — model hit fresh`);
    }
    if (!feedback && !isRepair && cached !== undefined) {
      hooks.onCacheReplay?.({ label: `${castRoundLabel}:${pieceId}`, kind: "cached-replay" });
      return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "cached-replay" };
    }
    const escalated = !!feedback && feedback[0].startsWith(ESCALATION_MARK);
    const user = feedback
      ? escalated
        ? [
            userText,
            ``,
            `════ NO-PROGRESS ESCALATION ════`,
            ...feedback,
            ...sequenceNotesBlock(),
            ``,
            `Ignore everything you produced for this element before — do NOT emit a variant of it. Re-emit this element FRESH from the brief above: the blueprint inventory is authoritative and every named item must be visibly present, nested inside real structure.`,
            `Output ONLY component code — NEVER narrate your reasoning, plan, or these findings as rendered text nodes (a deterministic gate rejects any element whose text nodes speak about wrappers, QA findings, or px coordinates).`,
          ].join("\n")
        : [
            userText,
            ``,
            `════ YOUR PREVIOUS VERSION FAILED PRODUCTION QA ════`,
            `The production gates measured your previous version of THIS element on the rendered frame and found these defects. Rebuild the element fixing EVERY finding while honoring the brief above:`,
            ...feedback.map((f) => `- ${f}`),
            ...sequenceNotesBlock(),
            ``,
            `--- YOUR PREVIOUS VERSION ---`,
            (cached ?? "(none survived)").slice(0, 6000),
            ``,
            `Emit ONLY the corrected JSX for this element.`,
            `Output ONLY component code — NEVER narrate your reasoning, plan, or these findings as rendered text nodes (a deterministic gate rejects any element whose text nodes speak about wrappers, QA findings, or px coordinates).`,
          ].join("\n")
      : userText;
    try {
      const label = `${castRoundLabel}:${pieceId}${feedback ? (escalated ? ":escalation" : ":regen") : ""}${isRepair ? ":repair" : ""}`;
      const res = await hooks.transport({
        label,
        system: call.system,
        user,
        maxTokens: call.maxTokens,
        model: call.model ?? config.defaultCastModel,
        ...(call.effort ? { effort: call.effort } : {}),
      });
      const stripped = stripCodeFence(res.text);
      const sane =
        res.stopReason !== "length" &&
        stripped.trim().length >= 8 &&
        stripped.includes("<") &&
        !/^\s*(?:import|export)\b/.test(stripped);
      if (sane && (await verifyFragmentCheap(stripped)) === null) {
        pieceCache.set(pieceId, stripped);
      } else if (res.text) {
        cacheBustEvents.push({ pieceId, reason: `emission not cache-worthy (stop=${res.stopReason}, sane=${sane}) — entry NOT populated` });
      }
      return res;
    } catch (e) {
      if (feedback && cached !== undefined) {
        hooks.onCacheReplay?.({ label: `${castRoundLabel}:${pieceId}:regen-failed-kept-previous`, kind: "regen-failed" });
        warn(`  [retry] ${pieceId}: regen call failed (${e instanceof Error ? e.message.split("\n")[0] : e}) — previous body kept`);
        return { text: cached, thinking: "", inputTokens: 0, outputTokens: 0, seconds: 0, stopReason: "regen-failed-replayed-previous" };
      }
      throw e;
    }
  };

  const castInput = config.castInput;
  let castResult: CastBuildResult | null = null;
  let finalCode = "";
  let round = 0;
  let genDirReady = false;
  let castRoundError: { round: number; error: string } | undefined;
  // Repair #4 stubs from this round's finalize — routed to a regen of the
  // owning piece(s) below, so a stubbed (empty-rendering) region converges to
  // real data instead of quietly shipping.
  let valueStubbedThisRound: UndefinedValueStub[] = [];

  while (true) {
    castRoundLabel = `cast-r${round}`;
    try {
      castResult = await phase(`cast-r${round}`, () => castBuild(castInput, { caller: cachingCaller }));
    } catch (e) {
      warn(`  castBuild THREW on round ${round}: ${e instanceof Error ? e.message : e}`);
      castRoundError = { round, error: e instanceof Error ? e.message : String(e) };
      pieceTargets = new Map();
      break;
    }
    pieceTargets = new Map();
    roundTelemetry.push(castResult.telemetry);
    for (const o of castResult.elementOutcomes) {
      if (o.failed && pieceCache.has(o.pieceId)) {
        pieceCache.delete(o.pieceId);
        cacheBustEvents.push({ pieceId: o.pieceId, reason: "element gate failed through repair — placeholder shipped; cached emission disproven" });
        warn(`  [cache-bust] ${o.pieceId}: placeholder shipped — stale emission evicted`);
      }
    }
    log(
      `  cast r${round}: ${castResult.telemetry.elements} elements · ${castResult.telemetry.repairs} repairs · ${castResult.telemetry.failures} placeholders · ` +
        `${castResult.telemetry.tokensOut} tok out · ${castResult.telemetry.normalizedColors} hue-locked · ${castResult.telemetry.heroSurfaceCorrections} hero-surface lift(s) · ` +
        `${castResult.telemetry.metaTextStrips} meta-text strip(s) · ${castResult.telemetry.wallSeconds}s`,
    );
    // P4b capacity budgets — the fire rate this layer is judged on. Logged on
    // its own line so it stays greppable in a build log.
    log(
      `  cast r${round} budgets: ${castResult.telemetry.fontsCalibrated} face(s) calibrated / ${castResult.telemetry.fontsEstimated} estimated · ` +
        `${castResult.telemetry.budgetsCalibrated} element budget(s) measured / ${castResult.telemetry.budgetsEstimated} estimated · ` +
        `${castResult.telemetry.overflowRejections} copy-overflow rejection(s), ${castResult.telemetry.overflowRepaired} repaired`,
    );

    finalCode = await phase(`finalize-r${round}`, async () => {
      // No clean corner logo (app-icon-only / no logo) → the wordmark text is
      // the corner mark (never a blank silhouetted square). When a real logo
      // renders, the corner stays image-only (wordmark undefined).
      const cornerWordmark = config.logoSrc ? undefined : brandWordmarkText(config.brand);
      let code = injectLogoSrc(castResult!.code, config.logoSrc, cornerWordmark);
      const fonts = await inlineFontFaces(code, fetchFont);
      code = fonts.code;
      const fin = await finalizeUndefinedRefs(code, { script });
      valueStubbedThisRound = fin.valueStubbed;
      if (fin.valueStubbed.length > 0) {
        warn(
          `  [finalize] undefined VALUE identifier(s) stubbed: [${fin.valueStubbed.map((v) => `${v.name} (s${v.scenes.join(",s")})`).join(", ")}] — a piece referenced data it never defined (the scene would have thrown at render); stubbed to render empty + routed to a regen of the owning piece`,
        );
      }
      if (pieceSpecEnabled()) {
        const spec = expandSpecMarkers(fin.code);
        if (spec.expanded > 0) {
          fin.code = spec.code;
          warn(`  [piece-spec] expanded ${spec.expanded} marker(s) pre-repair`);
        }
      }
      const bind = bindLiteralCopyInPlace(fin.code, script.scenes as never);
      for (const b of bind.bound) bindCopyEvents.push({ round, ...b });
      // Chrome-echo enforcement, same reasoning as the pipeline path — the
      // design contract forbids the category badge echoing the eyebrow.
      const chromeStrip = stripChromeEyebrowEchoes(bind.code, script.scenes as never);
      if (chromeStrip.stripped.length > 0) {
        log(
          `  [chrome-echo] dropped ${chromeStrip.stripped.length} category badge(s) echoing a scene eyebrow [${chromeStrip.stripped.map((x) => `s${x.scene}`).join(", ")}]`,
        );
      }
      if (bind.bound.length > 0) {
        log(
          `  [bind-in-place] ${bind.bound.reduce((n, b) => n + b.count, 0)} literal copy mount(s) → bound refs [${bind.bound.map((b) => `s${b.scene}.${b.field}`).join(", ")}]`,
        );
      }
      const info = { logoInjected: Boolean(config.logoSrc), fontsInlined: fonts.inlined.length, fontsFailed: fonts.failed, added: fin.added, stubbed: fin.stubbed, neutralized: fin.neutralized, valueStubbed: fin.valueStubbed, copyBound: bind.bound.reduce((n, b) => n + b.count, 0) };
      finalize[`r${round}`] = info;
      hooks.onFinalize?.(round, info);
      return chromeStrip.code;
    });

    // cycle-9 P1 (arm 1): ICON-FONT-IN-A-TEXT-ROLE. An icon/symbol webfont
    // leading a text stack (Tony's swiper-icons in FONT_DISPLAY+FONT_BODY —
    // cycle-8 P0) renders copy as fragments while the DOM text stays full, so
    // no measured gate sees it. Detect it on the assembled source and strip it
    // DETERMINISTICALLY (zero tokens) before measuring — the crawl-theme fix
    // stops it at the source; this is the belt-and-suspenders that also catches
    // an icon font reaching the code any other way (inline fontFamily, a mock).
    const iconFontStacks = findIconFontTextStacks(finalCode);
    if (iconFontStacks.length > 0) {
      const strip = stripIconFontsFromTextStacks(finalCode);
      for (const s of strip.stripped) iconFontStripEvents.push({ round, site: s.site, family: s.family });
      if (strip.stripped.length > 0) {
        finalCode = strip.code;
        for (const [pid, body] of pieceCache) {
          const s2 = stripIconFontsFromTextStacks(body);
          if (s2.stripped.length > 0) pieceCache.set(pid, s2.code);
        }
        warn(
          `  [icon-font] stripped icon/symbol font(s) from ${strip.stripped.length} text stack(s) [${[...new Set(strip.stripped.map((s) => `${s.site}:${s.family}`))].join(", ")}] — copy now renders in a letterform font (deterministic, zero tokens)`,
        );
      }
    }

    // cycle-10 P2: SPANISH / ACCENTED-GLYPH coverage. When the copy carries
    // á/é/í/ó/ú/ñ/ü/¿/¡ and a TEXT stack has no family that can render a
    // diacritic, the glyph silently drops. DETERMINISTICALLY append a Latin-1-safe
    // generic so per-glyph fallback always covers it (the accented analogue of the
    // icon-font strip). The finding fires (telemetry) even when auto-repaired.
    const accentCopyText = JSON.stringify((script.scenes ?? []).map((s) => s.content ?? {}));
    const accentedGlyphGaps = assessAccentedGlyphCoverage({
      code: finalCode,
      copyText: accentCopyText,
      fontFaceCss: theme.fonts.fontFaceCss,
    });
    if (accentedGlyphGaps.length > 0) {
      const fix = ensureLatin1Fallback(finalCode);
      if (fix.appended.length > 0) {
        finalCode = fix.code;
        for (const a of fix.appended) accentFallbackEvents.push({ round, stack: a.stack, added: a.added });
        warn(
          `  [accented-glyph] ${accentedGlyphGaps.length} text stack(s) lacked accented coverage [${accentedGlyphGaps.map((g) => `${g.stack}:${g.missingChars.join("")}`).join(", ")}] — appended a Latin-1-safe generic (deterministic, zero tokens)`,
        );
      }
    }

    // cycle-10 P1 (arm 3): CROSS-PIECE STAT DEDUP + numeric-format drift. The
    // cycle-9 s4 class no gate caught — a hero counter ("30000") + a copy binding
    // ("30,000") restating the SAME figure across two pieces (both invisible to
    // the measured text layer: a ::after counter and a bound value). Read straight
    // off the assembled source, resolving bindings against the script content.
    const crossPieceStatDups = findCrossPieceStatDup(finalCode, (script.scenes ?? []) as { content?: Record<string, unknown> }[]);
    if (crossPieceStatDups.length > 0) {
      log(
        `  cross-piece-stat-dup: ${crossPieceStatDups.length} [${crossPieceStatDups.map((f) => `s${f.scene}:"${f.forms.join("/")}"×${f.pieces.length}${f.formatDrift ? "(drift)" : ""}`).join(", ")}]`,
      );
    }

    // cycle-10 P1 (arm 3b): GARBLED / DUPLICATE BRAND MARK. >1 brand lockup across
    // a scene's non-chrome pieces (the s4 "IY INELLIN" garble + a correct lockup),
    // or a text-node wordmark scrambled vs the known brand name.
    const brandMarkDefects = findBrandMarkDefects(finalCode, BRAND, themeFontFamilyNames(theme));
    if (brandMarkDefects.length > 0) {
      log(
        `  brand-mark: ${brandMarkDefects.length} [${brandMarkDefects.map((f) => `s${f.scene}:${f.kind}${f.garbledText ? ` "${f.garbledText}"` : ` ×${f.pieces.length}`}`).join(", ")}]`,
      );
    }

    if (!genDirReady) {
      await hooks.ensureGenDir();
      genDirReady = true;
    }
    await hooks.writeComposition(finalCode);
    // RB_ALLOCATE telemetry artifact: the allocator's per-scene decision
    // record, persisted next to the gen artifacts (and by fullpipe next to
    // composition.json) so future dry runs can diff plan vs allocation.
    // Overwritten per round — the LAST cast round is the one that ships.
    if (castResult.allocations && castResult.allocations.length > 0) {
      await fs
        .writeFile(path.join(genDir, "allocated.json"), JSON.stringify(castResult.allocations, null, 2), "utf8")
        .catch((e) => warn(`  allocated.json not persisted: ${e instanceof Error ? e.message : e}`));
    }

    // (a) density gates — blocking, including the per-hero floor.
    const density = await phase(`density-r${round}`, async () => assessDensity(finalCode, script));
    profile = buildDensityProfile(finalCode, script);
    log(`  density: ${density.length} blocking finding(s) [${density.map((f) => f.kind).join(", ") || "clean"}] · distinct sigs ${profile.distinctSignatures} · depths [${profile.scenes.map((s) => s.depth).join(", ")}]`);

    // (b) measure, then the v10 piece-edge-crop arm.
    let measurements = await phase(`measure-r${round}`, () => measureScenes(genDir, script, genDir));

    // Declared-box telemetry (Bug 2). Sizes the "a declared height does not
    // clip" problem with real numbers instead of inference: how many pieces
    // painted past their own box this round, and by how much. Reported whether
    // or not RB_ENFORCE_BOX is on — measuring must not require enabling the fix.
    // The per-piece detail lives in genDir/rects-scene-N.json.
    log(`  ${summarizeBoxOverflow(measurements).line}`);

    // v12 (#4): BROKEN-IMAGE swap — measured naturalWidth === 0.
    const brokenImgs = findBrokenRenderedImages(measurements);
    if (brokenImgs.length > 0) {
      const srcs = brokenImgs.map((b) => b.src);
      const swap = swapBrokenImagesForWordmark(finalCode, srcs, BRAND);
      for (const b of brokenImgs) {
        const via = swap.swapped.find((s) => s.src === b.src)?.via ?? "unswappable";
        imgSwapEvents.push({ round, scene: b.scene, pieceId: b.pieceId, src: b.src.slice(0, 120), via });
        warn(
          `  [img-broken] scene ${b.scene} ${b.pieceId || "(chrome)"}: <img> decoded naturalWidth=0 (src …${b.src.slice(-48)}) — ${
            via === "unswappable" ? "no swappable mount found (finding ships)" : `swapped to the "${BRAND}" text wordmark (${via})`
          }`,
        );
      }
      if (swap.swapped.length > 0) {
        finalCode = swap.code;
        await hooks.writeComposition(finalCode);
        for (const [pid, cachedBody] of pieceCache) {
          const s2 = swapBrokenImagesForWordmark(cachedBody, srcs, BRAND, { constSource: finalCode });
          if (s2.swapped.length > 0) pieceCache.set(pid, s2.code);
        }
        measurements = await phase(`measure-imgswap-r${round}`, () => measureScenes(genDir, script, genDir));
      }
    }

    const edgeCropInitial = measurements.flatMap((m) => findEdgeCroppedPieces(m));
    let edgeCropResidual: EdgeCropFinding[] = [];
    if (edgeCropInitial.length > 0) {
      const canvasDims = { w: measurements[0]?.width ?? 1920, h: measurements[0]?.height ?? 1080 };
      const slotTerritories: SlotTerritory[] = castResult.scenes.flatMap((s) =>
        s.pieces.map((p) => ({
          pieceId: p.id,
          scene: s.scene,
          kind: p.kind,
          bounds: { x: p.bounds.x, y: p.bounds.y, w: p.bounds.w, h: p.bounds.h },
        })),
      );
      const plan = planEdgeCropMoves(edgeCropInitial, slotTerritories, canvasDims, config.edgeClampMarginPx);
      for (const r of plan.regens) {
        edgeCropEvents.push({ round, pieceId: r.pieceId, action: "clamp-refused-regen-routed", detail: `${r.reason}: ${r.detail}` });
        warn(`  [edge-crop] ${r.pieceId}: clamp REFUSED (${r.reason}) — routed directly to regen`);
      }
      const clamp = clampPieceOffsets(finalCode, plan.moves);
      for (const a of clamp.applied) {
        edgeCropEvents.push({ round, pieceId: a.pieceId, action: "clamped", detail: `wrapper ${a.from.left},${a.from.top} → ${a.to.left},${a.to.top}` });
        log(`  [edge-crop] ${a.pieceId}: wrapper clamped ${a.from.left},${a.from.top} → ${a.to.left},${a.to.top} (deterministic, zero tokens)`);
      }
      for (const s of clamp.skipped) {
        edgeCropEvents.push({ round, pieceId: s.pieceId, action: "clamp-skipped", detail: s.reason });
        warn(`  [edge-crop] ${s.pieceId}: clamp skipped — ${s.reason}`);
      }
      if (clamp.applied.length > 0) {
        finalCode = clamp.code;
        await hooks.writeComposition(finalCode);
        measurements = await phase(`measure-clamped-r${round}`, () => measureScenes(genDir, script, genDir));
      }
      edgeCropResidual = measurements.flatMap((m) => findEdgeCroppedPieces(m));
      for (const r of plan.regens) {
        const residual = edgeCropResidual.find((f) => f.pieceId === r.pieceId);
        if (residual) {
          residual.detail = `${residual.detail} Clamp refused: ${r.detail}.`;
          residual.repairInstruction = r.repairInstruction;
        }
      }
      for (const f of edgeCropResidual) {
        edgeCropEvents.push({ round, pieceId: f.pieceId, action: "residual-after-clamp", detail: f.detail });
      }
      log(
        `  edge-crop: ${edgeCropInitial.length} initial [${edgeCropInitial.map((f) => `${f.pieceId}:${f.edge}+${f.overflowPx}px`).join(", ")}] · ` +
          `${clamp.applied.length} clamped · ${plan.regens.length} clamp-refused → regen · ${edgeCropResidual.length} residual${edgeCropResidual.length ? ` [${edgeCropResidual.map((f) => f.pieceId).join(", ")}] → routed to regen` : ""}`,
      );
    }
    finalMeasurements = measurements;

    // (b6) v15 (#4): STRAY MOTIF FRAGMENTS.
    let strayExcised = 0;
    for (const m of measurements) {
      for (const f of findStrayFragments(m, accentHexes)) {
        const body = pieceCache.get(f.pieceId);
        const repair = body ? exciseStrayFragment(body, f, theme.palette) : { code: "", action: "none" as const, detail: "piece body not cached" };
        if (body && repair.action !== "none") {
          pieceCache.set(f.pieceId, repair.code);
          const span = pieceSpanInCode(finalCode, f.pieceId);
          if (span) {
            const spanRepair = exciseStrayFragment(finalCode.slice(span.start, span.end), f, theme.palette);
            if (spanRepair.action !== "none") {
              finalCode = finalCode.slice(0, span.start) + spanRepair.code + finalCode.slice(span.end);
              strayExcised += 1;
            }
          }
          strayFragmentEvents.push({ round, scene: f.scene, pieceId: f.pieceId, form: f.form, action: repair.action, detail: `${f.detail} → ${repair.detail}` });
        } else {
          strayFragmentEvents.push({ round, scene: f.scene, pieceId: f.pieceId, form: f.form, action: "none", detail: `${f.detail} (${repair.detail})` });
        }
      }
    }
    const strayThisRound = strayFragmentEvents.filter((e) => e.round === round);
    if (strayThisRound.length > 0) {
      if (strayExcised > 0) await hooks.writeComposition(finalCode);
      log(`  stray-fragments: ${strayThisRound.length} [${strayThisRound.map((e) => `${e.pieceId}:${e.form}→${e.action}`).join(", ")}]`);
    }

    // (b6b) MOTIF CLUTTER: ghost glyphs / floating brand pills on the decoration
    // layers (atmosphere + *.throughline/*.connector) that defeat the head's
    // budget{brandMark:1} — grouped per piece, excised deterministically
    // (throughline pill → blank the piece; atmosphere glyphs → strip them).
    let motifExcised = 0;
    for (const m of measurements) {
      const owner = (script.scenes?.[m.scene] as { composition?: { budget?: { brandMark?: unknown } } } | undefined)
        ?.composition?.budget?.brandMark;
      const findings = findMotifClutter(m, {
        brandName: BRAND,
        brandMarkOwner: typeof owner === "string" ? owner : undefined,
      });
      const byPiece = new Map<string, MotifClutterFinding[]>();
      for (const f of findings) byPiece.set(f.pieceId, [...(byPiece.get(f.pieceId) ?? []), f]);
      for (const [pieceId, group] of byPiece) {
        const span = pieceSpanInCode(finalCode, pieceId);
        const repair = span
          ? exciseMotifClutter(finalCode.slice(span.start, span.end), group, { brandName: BRAND })
          : { code: "", action: "none" as const, detail: "piece span not found" };
        if (span && repair.action !== "none") {
          finalCode = finalCode.slice(0, span.start) + repair.code + finalCode.slice(span.end);
          if (pieceCache.has(pieceId)) {
            const cached = exciseMotifClutter(pieceCache.get(pieceId)!, group, { brandName: BRAND });
            if (cached.action !== "none") pieceCache.set(pieceId, cached.code);
          }
          motifExcised += 1;
        }
        motifClutterEvents.push({ round, scene: group[0].scene, pieceId, form: group[0].form, action: repair.action, detail: `${group[0].detail} → ${repair.detail}` });
      }
    }
    const motifThisRound = motifClutterEvents.filter((e) => e.round === round);
    if (motifThisRound.length > 0) {
      if (motifExcised > 0) await hooks.writeComposition(finalCode);
      log(`  motif-clutter: ${motifThisRound.length} [${motifThisRound.map((e) => `${e.pieceId}:${e.form}→${e.action}`).join(", ")}]`);
    }

    // Structural gates read the (possibly clamped/excised) final code.
    const structural = runStructuralGates(finalCode, script);
    for (const e of strayThisRound.filter((e) => e.action === "none")) {
      structural.push({ scene: e.scene, key: "stray_fragment", detail: e.detail });
    }
    // cycle-10 P1: cross-piece stat dedup + brand-mark defects (source-based).
    for (const f of crossPieceStatDups) {
      structural.push({ scene: f.scene, key: f.duplicated ? "cross_piece_stat_dup" : "stat_format_drift", detail: f.detail });
    }
    for (const f of brandMarkDefects) {
      const key =
        f.kind === "garbled-brand-mark" ? "garbled_brand_mark"
        : f.kind === "fake-brand-mark" ? "fake_brand_mark"
        : "duplicate_brand_mark";
      structural.push({ scene: f.scene, key, detail: f.detail });
    }
    // v11 (#5) logo-glyph count.
    for (const [pieceId, body] of pieceCache) {
      if (!/\.hero$/.test(pieceId)) continue;
      const marks = countBrandMarks(body, BRAND);
      if (marks > 1) {
        const scene = Number(/^s(\d+)\./.exec(pieceId)?.[1] ?? -1);
        structural.push({
          scene,
          key: "logo_glyph_count",
          detail: `${pieceId} carries ${marks} brand marks (drawn wordmarks/initial glyphs/logo mounts) — the chrome already carries the corner mark; a hero mock shows the brand at most once.`,
        });
      }
    }
    // v12 (#4): broken rendered images structural finding.
    for (const ev of imgSwapEvents.filter((e) => e.round === round)) {
      structural.push({
        scene: ev.scene,
        key: "img_broken",
        detail: `broken <img> (decoded naturalWidth 0) in ${ev.pieceId || "(chrome)"} — src …${ev.src.slice(-60)}; ${
          ev.via === "unswappable" ? "NO swappable mount found" : `swapped deterministically to the "${BRAND}" text wordmark (${ev.via})`
        }.`,
      });
    }
    const rt = await phase(`render-truth-r${round}`, () =>
      findRenderTruthFailures(measurements, {
        brandBackground: canvasBackground,
        blockingKinds: config.blockingKinds,
        registers: sceneRegisters,
        brandName: BRAND,
      }),
    );
    // R4 (audit-2): the full-bleed barbell is ADVISORY, not blocking. On a
    // full-bleed scene the occupancy full-bleed ROW arm + the deterministic
    // furnish own the abandoned top/bottom band; leaving barbell blocking too
    // routed a regen the full-bleed hero can't satisfy AND double-counted the same
    // defect (the audit-2 full-bleed split-brain — three postures for one
    // register). Demote it so the row-arm/furnish is the single owner.
    rt.blocking = rt.blocking.filter(
      (f) => !(f.kind === "barbell" && sceneRegisters[f.scene] === "full-bleed"),
    );

    // (b2) hero-washout.
    const contrastRaw = await phase(`hero-contrast-r${round}`, () => assessHeroWashout(measurements, { canvasBackground }));
    log(
      `  hero-contrast: ${contrastRaw.stats.length} hero region(s) sampled · ${contrastRaw.findings.length} washout(s)` +
        `${contrastRaw.findings.length ? ` [${contrastRaw.findings.map((f) => f.pieceId).join(", ")}]` : ""}` +
        `${contrastRaw.errors.length ? ` · errors: ${contrastRaw.errors.join(" | ")}` : ""}`,
    );

    // v12 (#2): GATE→BACKSTOP CLOSURE — force the surface lift with MEASURED colors.
    let contrast = contrastRaw;
    /** v16: pieces whose washout routed to a furnish regen — they carry a
     *  complete instruction and must NOT receive the "repaint DARKER" append
     *  (the two would contradict; the founder's rule-contradiction class). */
    const sparseFurnishRouted = new Set<string>();
    /** v16: pre-lift state for the revert guard (span text + cached body). */
    const preLiftState = new Map<string, { span: string; cached: string | undefined }>();
    if (contrastRaw.findings.length > 0) {
      let anyLifted = false;
      for (const f of contrastRaw.findings) {
        const m = measurements.find((mm) => mm.scene === f.scene);
        // v16 SPARSITY TRIAGE — live evidence (Notion alloc2 A/B): the forced
        // ink-lift on a mostly-EMPTY white panel converts invisible emptiness
        // into a black monolith, and the spread re-measure then REWARDS it.
        // A sparse panel's washout is an emptiness defect: only the model can
        // fill it, so route it to a furnish regen and refuse the paint.
        const panelReading = m ? readDominantPanel(m, f.pieceId, canvasBackground) : null;
        if (panelReading && panelReading.coverage < CARD_INTERIOR_FLOOR) {
          sparseFurnishRouted.add(f.pieceId);
          washoutLiftEvents.push({
            round,
            pieceId: f.pieceId,
            action: "sparse-furnish-routed",
            via: null,
            targetToken: null,
            interiorTextRepaints: 0,
            before: { spread: f.stats.spread, std: f.stats.stdDev },
            after: null,
            cleared: null,
          });
          warn(
            `  [washout-lift] ${f.pieceId}: panel interior only ${(panelReading.coverage * 100).toFixed(0)}% furnished — ` +
              `paint-lift REFUSED (a dark coat on an empty panel is a black filler box, not a repair); routing to a FURNISH regen`,
          );
          f.repairInstruction =
            `This panel is washed out AND its interior is only ${(panelReading.coverage * 100).toFixed(0)}% furnished — ` +
            `the real defect is EMPTINESS. A dark repaint is FORBIDDEN here: it would manufacture a black filler box. ` +
            `Regenerate so the panel EARNS its ${panelReading.panel.w}×${panelReading.panel.h} footprint, one of: ` +
            `(a) FILL the interior with real content in this scene's world — rows with concrete values, meta lines, chips, ` +
            `a chart strip; real micro-copy, comfortably covering >${Math.round(CARD_INTERIOR_FLOOR * 100)}% of the panel; ` +
            `(b) SHRINK the panel to hug the content it actually has (a small clean card beats a big empty slab); or ` +
            `(c) REMOVE the backdrop panel and let the content sit directly on the canvas. ` +
            `Make the surface visible the light-UI way — a hairline border, a soft shadow, a subtle tint — ` +
            `never a giant dark slab.`;
          continue;
        }
        let panelColor: string | undefined;
        let bestArea = 0;
        for (const e of m?.elements ?? []) {
          if (e.piece !== f.pieceId || e.opacity <= 0.05) continue;
          if (cssAlphaOf(e.bg) < 0.5) continue;
          const area = e.w * e.h;
          if (area > bestArea) {
            bestArea = area;
            panelColor = e.bg;
          }
        }
        const liftCtx = { measuredPanelColor: panelColor, canvasColor: canvasBackground };
        const span = pieceSpanInCode(finalCode, f.pieceId);
        const spanLift = span ? forceHeroSurfaceLift(finalCode.slice(span.start, span.end), theme, liftCtx) : null;
        if (span && spanLift?.lifted) {
          preLiftState.set(f.pieceId, { span: finalCode.slice(span.start, span.end), cached: pieceCache.get(f.pieceId) });
          finalCode = finalCode.slice(0, span.start) + spanLift.code + finalCode.slice(span.end);
          anyLifted = true;
          washoutLiftEvents.push({
            round,
            pieceId: f.pieceId,
            action: "forced-lift",
            via: spanLift.via,
            targetToken: spanLift.targetToken,
            interiorTextRepaints: spanLift.interiorTextRepaints,
            before: { spread: f.stats.spread, std: f.stats.stdDev },
            after: null,
            cleared: null,
          });
          warn(
            `  [washout-lift] ${f.pieceId}: FORCED surface lift (${spanLift.via} → ${spanLift.targetToken ?? spanLift.targetHex}) — measured spread ${f.stats.spread}/std ${f.stats.stdDev}, panel ${panelColor ?? "(none opaque)"}` +
              `${spanLift.interiorTextRepaints > 0 ? ` · ${spanLift.interiorTextRepaints} interior text node(s) recolored (ghost-proofing)` : ""}`,
          );
          const cached = pieceCache.get(f.pieceId);
          if (cached) {
            const bodyLift = forceHeroSurfaceLift(cached, theme, liftCtx);
            if (bodyLift.lifted) pieceCache.set(f.pieceId, bodyLift.code);
          }
        } else {
          washoutLiftEvents.push({
            round,
            pieceId: f.pieceId,
            action: "lift-noop-regen-routed",
            via: null,
            targetToken: null,
            interiorTextRepaints: 0,
            before: { spread: f.stats.spread, std: f.stats.stdDev },
            after: null,
            cleared: null,
          });
          warn(`  [washout-lift] ${f.pieceId}: lift unavailable (${span ? "no liftable paint/root" : "piece span not found"}) — routing to regen with an explicit direction`);
        }
      }
      if (anyLifted) {
        await hooks.writeComposition(finalCode);
        measurements = await phase(`measure-washout-lift-r${round}`, () => measureScenes(genDir, script, genDir));
        finalMeasurements = measurements;
        contrast = await phase(`hero-contrast-relift-r${round}`, () => assessHeroWashout(measurements, { canvasBackground }));
        for (const ev of washoutLiftEvents.filter((e) => e.round === round && e.action === "forced-lift")) {
          const st = contrast.stats.find((s) => s.pieceId === ev.pieceId);
          ev.after = st ? { spread: st.spread, std: st.stdDev } : null;
          ev.cleared = !contrast.findings.some((ff) => ff.pieceId === ev.pieceId);
          log(`  [washout-lift] ${ev.pieceId}: re-measured spread ${st?.spread ?? "?"}/std ${st?.stdDev ?? "?"} — ${ev.cleared ? "CLEARED (zero tokens)" : "residual → regen"}`);
        }
        // v16 REVERT GUARD — enforce the invariant the lift's own comments
        // claim ("a lift never creates a text-contrast finding"; live run2-s1
        // shipped 1.04:1 labels three rounds straight because repaint can't
        // reach template-literal/class/inherited colors). A lifted piece that
        // now carries blocking text-contrast rolls back; the washout then
        // routes to a regen with the explicit direction instead of shipping
        // "accepted and flagged".
        let anyReverted = false;
        for (const ev of washoutLiftEvents.filter((e) => e.round === round && e.action === "forced-lift")) {
          const pre = preLiftState.get(ev.pieceId);
          const fnd = contrastRaw.findings.find((ff) => ff.pieceId === ev.pieceId);
          const m2 = fnd ? measurements.find((mm) => mm.scene === fnd.scene) : undefined;
          if (!pre || !m2) continue;
          let scoped: TextContrastFinding[] = [];
          try {
            const tc = await assessTextNodeContrast([m2]);
            scoped = tc.findings.filter((x) => x.pieceId === ev.pieceId && x.blocking);
          } catch {
            continue;
          }
          if (scoped.length === 0) continue;
          const span2 = pieceSpanInCode(finalCode, ev.pieceId);
          if (!span2) continue;
          finalCode = finalCode.slice(0, span2.start) + pre.span + finalCode.slice(span2.end);
          if (pre.cached !== undefined) pieceCache.set(ev.pieceId, pre.cached);
          else pieceCache.delete(ev.pieceId);
          const worst = Math.min(...scoped.map((x) => x.ratio));
          ev.reverted = true;
          ev.cleared = false;
          ev.revertReason = `lift left ${scoped.length} blocking text-contrast node(s) (worst ${worst}:1) inside the piece`;
          anyReverted = true;
          warn(
            `  [washout-lift] ${ev.pieceId}: REVERTED — ${ev.revertReason}; the washout routes to a regen with the explicit direction instead`,
          );
        }
        if (anyReverted) {
          await hooks.writeComposition(finalCode);
          measurements = await phase(`measure-washout-revert-r${round}`, () => measureScenes(genDir, script, genDir));
          finalMeasurements = measurements;
          contrast = await phase(`hero-contrast-rerevert-r${round}`, () => assessHeroWashout(measurements, { canvasBackground }));
        }
      }
      // v16: sparse-routed pieces keep their furnish instruction across
      // re-assessments (fresh finding objects) and are EXCLUDED from the
      // DARKER append below — a dark repaint is exactly what their
      // instruction forbids, and two contradicting directions in one prompt
      // is the failure class this fix exists to close.
      for (const ff of contrast.findings) {
        if (!sparseFurnishRouted.has(ff.pieceId)) continue;
        const orig = contrastRaw.findings.find((x) => x.pieceId === ff.pieceId);
        if (orig) ff.repairInstruction = orig.repairInstruction;
      }
      const canvasLum = hexLuminance(canvasBackground);
      const lightCanvas = canvasLum !== null && canvasLum > 0.5;
      for (const f of contrast.findings) {
        if (sparseFurnishRouted.has(f.pieceId)) continue;
        f.repairInstruction +=
          ` EXPLICIT DIRECTION: the scene canvas ${canvasBackground} is ${lightCanvas ? "LIGHT" : "DARK"} — repaint your primary panel/surface decisively ${lightCanvas ? "DARKER" : "LIGHTER"} than the canvas (a flat, opaque, high-|ΔL| surface), never another near-canvas tone.`;
      }
    }
    finalContrast = contrast;
    if (contrast.advisories.length > 0) {
      log(`  washout-near-miss (advisory): [${contrast.advisories.map((a) => `${a.pieceId} sp${a.stats.spread}/sd${a.stats.stdDev}`).join(", ")}]`);
    }

    // (b2b) v13 (#2): hero-underscale.
    const underscale = findHeroUnderscale(measurements, sceneRegisters);
    log(
      `  hero-underscale: ${underscale.length} finding(s)` +
        `${underscale.length ? ` [${underscale.map((f) => `${f.pieceId} painted ${(f.paintedFrac * 100).toFixed(2)}% < ${HERO_UNDERSCALE_MIN_FRAC * 100}%`).join(", ")}]` : ""}`,
    );

    // (b2c) v13 (#4): skeleton-bar detector.
    const skeletonBars = measurements.flatMap((m) => findSkeletonBars(m));
    for (const f of skeletonBars) {
      structural.push({ scene: f.scene, key: "skeleton_bars", detail: f.detail });
    }
    if (skeletonBars.length > 0) {
      log(`  skeleton-bars: [${skeletonBars.map((f) => `${f.pieceId} ${f.rows} row(s)/${f.bars} bars${f.blocking ? " BLOCKING" : ""}`).join(", ")}]`);
    }

    // (b3) accent-as-fill (v10). v16 (#5): drop any signature accent that IS the
    // canvas tone (monochrome-luxury FP — Superhuman) before probing, so a
    // legitimate brand surface isn't flagged as an accent slab.
    const probeAccents = dropAccentsNearCanvas(accentHexes, canvasBackground);
    if (probeAccents.length < accentHexes.length) {
      log(`  accent-fill: dropped ${accentHexes.length - probeAccents.length} near-canvas accent(s) from the probe vocabulary (monochrome-luxury calibration, ΔRGB<${ACCENT_CANVAS_DE_FLOOR} vs ${canvasBackground})`);
    }
    const accentFill = await phase(`accent-fill-r${round}`, () => assessAccentFill(measurements, probeAccents, { registers: sceneRegisters }));
    finalAccentFill = accentFill;
    log(
      `  accent-fill: ${accentFill.stats.length} hero region(s) probed vs [${accentHexes.join(", ")}] · ` +
        `largest-rect fracs [${accentFill.stats.map((s) => `${s.pieceId} ${(s.largestRectFrac * 100).toFixed(1)}%`).join(", ") || "none"}] · ` +
        `${accentFill.findings.length} accent-as-fill${accentFill.findings.length ? ` [${accentFill.findings.map((f) => f.pieceId).join(", ")}]` : ""}` +
        `${accentFill.errors.length ? ` · errors: ${accentFill.errors.join(" | ")}` : ""}`,
    );

    // (b4) v15 (#1): OCCUPANCY BUDGET.
    const occupancy = await phase(`occupancy-r${round}`, () => assessOccupancy(measurements, sceneRegisters));
    const occupancyBlocking = occupancy.findings.filter((f) => f.blocking);
    for (const f of occupancy.findings.filter((f) => !f.blocking)) {
      structural.push({ scene: f.scene, key: "occupancy_void_advisory", detail: f.detail });
    }
    for (const c of occupancy.cardAdvisories) {
      structural.push({ scene: c.scene, key: "card_interior_occupancy", detail: c.detail });
    }
    log(
      `  occupancy: ${occupancy.stats.length} scene(s) sampled · ${occupancy.findings.length} void(s)` +
        `${occupancy.findings.length ? ` [${occupancy.findings.map((f) => `${f.pieceId} ${(f.runFracW * 100).toFixed(0)}%${f.blocking ? " BLOCK" : " adv"}`).join(", ")}]` : ""}` +
        ` · ${occupancy.cardAdvisories.length} card-interior advisory` +
        `${occupancy.errors.length ? ` · errors: ${occupancy.errors.join(" | ")}` : ""}`,
    );

    // (b5) v15 (#2): PER-TEXT-NODE CONTRAST.
    const textContrast = await phase(`text-contrast-r${round}`, () => assessTextNodeContrast(measurements));
    for (const a of textContrast.advisories) {
      structural.push({ scene: a.scene, key: "text_contrast_advisory", detail: a.detail });
    }
    log(
      `  text-contrast: ${textContrast.stats.length} node(s) under ceiling · ${textContrast.findings.length} blocking` +
        `${textContrast.findings.length ? ` [${textContrast.findings.map((f) => `${f.pieceId} ${f.ratio.toFixed(2)}:1`).join(", ")}]` : ""}` +
        ` · ${textContrast.advisories.length} advisory` +
        `${textContrast.errors.length ? ` · errors: ${textContrast.errors.join(" | ")}` : ""}`,
    );

    // (b6b) DETERMINISTIC PALETTE CONTRAST LIFT — 0 tokens, no model call.
    // The advisory band (2.5–4.5) had no repair of its own: its findings "ride along
    // on regens", so dim text on an otherwise-clean scene shipped dim. Founder report
    // 2026-08-22 ("the element on the right is bad on visibility") was a node at 4.3,
    // seen and shipped. Darkening a colour to a contrast target is arithmetic, so it
    // happens here instead of costing a regen. The guard in palette-lift.ts re-scores
    // EVERY measured node using the token — a global edit for a local failure is only
    // allowed when nothing else regresses.
    if (textContrast.inkSamples.length > 0) {
      try {
        const lifts = await liftWashedPaletteTokens(genDir, textContrast.inkSamples, {
          readManifest: (g) => readManifest(g) as Promise<{ preamble: string }>,
          writeManifest: (g, m) => writeManifest(g, m),
          commit: (g, msg) => commitGenDir(g, msg, { checkRender: true }),
        });
        for (const e of lifts) {
          if (e.applied) {
            log(
              `  [palette-lift] ${e.token}: ${e.from} → ${e.to} — ${e.improved} node(s) improved, ` +
                `${e.unchanged} unchanged, none regressed`,
            );
          } else if (e.to) {
            // Name the hex even on refusal: a regen aiming at a number beats one told
            // to "make it darker", which is how this band kept shipping dim.
            log(`  [palette-lift] ${e.token}: REFUSED (${e.reason}) — a regen should target ${e.to}`);
          }
        }
      } catch (err) {
        // A colour polish must never take a build down.
        warn(`  [palette-lift] skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

    // (b7) cycle-9 P1 (arm 2): ORPHANED COPY FRAGMENTS — a copy node rendered as
    // a lone char / value-less label-colon / dotted initials (a bind/emit
    // truncation). Blocking; routed to the owning copy piece for a fresh regen.
    const orphanedFragments = measurements.flatMap((m) => findOrphanedFragments(m));
    if (orphanedFragments.length > 0) {
      for (const f of orphanedFragments) {
        structural.push({ scene: f.scene, key: "orphaned_fragment", detail: f.detail });
      }
      log(
        `  orphaned-fragments: ${orphanedFragments.length} [${orphanedFragments.map((f) => `${f.pieceId}:"${f.text}"`).join(", ")}]`,
      );
    }

    // (c) per-scene vision.
    const vision = hooks.runPerSceneVision
      ? await phase(`vision-r${round}`, () => hooks.runPerSceneVision!(measurements, script, brandTruth))
      : [];

    const validPieceIds = new Set(castResult.scenes.flatMap((s) => s.pieces.filter((p) => p.kind !== "chrome").map((p) => p.id)));
    // Audit-1 High #3 edit (3): heroes that compile-broke / shipped a placeholder
    // this round (the deterministic fallback) — a REGEN can't help them (GLM keeps
    // breaking the same complex hero), so their void routes straight to the
    // post-loop deterministic FURNISH instead of thrashing a regen that never
    // converges (the audit's central void-non-convergence finding).
    const castFailedPieces = new Set(
      castResult.elementOutcomes.filter((o) => o.failed).map((o) => o.pieceId),
    );
    const targets = computeTargets({
      validPieceIds,
      density,
      profile,
      rtBlocking: rt.blocking,
      washout: contrast.findings,
      accentFill: accentFill.findings,
      edgeCropResidual,
      vision,
      underscale,
      skeletonBlocking: skeletonBars.filter((f) => f.blocking),
      occupancyVoids: occupancyBlocking,
      textContrastBlocking: textContrast.findings,
      registers: sceneRegisters,
      canvasBackground,
      castFailedPieces,
      pieceCache,
    });
    for (const a of contrast.advisories) {
      const existing = targets.get(a.pieceId);
      if (existing) existing.push(`[advisory/washout-near-miss] ${a.advisory}`);
    }
    for (const f of occupancy.findings.filter((f) => !f.blocking)) {
      targets.get(f.pieceId)?.push(`[advisory/occupancy-void] ${f.repairInstruction}`);
    }
    for (const c of occupancy.cardAdvisories) {
      targets.get(c.pieceId)?.push(`[advisory/card-interior] ${c.advisory}`);
    }
    for (const a of textContrast.advisories) {
      targets.get(a.pieceId)?.push(`[advisory/text-contrast] ${a.repairInstruction}`);
    }
    // cycle-9 P1 (arm 2): orphaned fragments are BLOCKING — route each to its
    // owning copy piece (falls back to s{scene}.copy → s{scene}.hero via `add`).
    for (const f of orphanedFragments) {
      let id = f.pieceId;
      if (!validPieceIds.has(id)) id = `s${f.scene}.copy`;
      if (!validPieceIds.has(id)) id = `s${f.scene}.hero`;
      if (!validPieceIds.has(id)) continue;
      targets.set(id, [...(targets.get(id) ?? []), `[text-integrity/orphaned-fragment] ${f.detail}\n${f.repairInstruction}`]);
    }
    // cycle-10 P1 (arm 3): route the REDUNDANT piece of each cross-piece stat dup
    // (and the drifting piece of a format-drift) to regen. Falls back copy→hero.
    for (const f of crossPieceStatDups) {
      const routeTo = [...(f.redundantPieces.length ? f.redundantPieces : [f.primaryPiece])];
      for (let id of routeTo) {
        if (!validPieceIds.has(id)) id = `s${f.scene}.copy`;
        if (!validPieceIds.has(id)) id = `s${f.scene}.hero`;
        if (!validPieceIds.has(id)) continue;
        targets.set(id, [...(targets.get(id) ?? []), `[text-integrity/cross-piece-stat-dup] ${f.detail}\n${f.repairInstruction}`]);
      }
    }
    // cycle-10 P1 (arm 3b): route the redundant/garbled brand mark to regen.
    for (const f of brandMarkDefects) {
      let id = f.pieceId;
      if (!validPieceIds.has(id)) id = `s${f.scene}.copy`;
      if (!validPieceIds.has(id)) id = `s${f.scene}.hero`;
      if (!validPieceIds.has(id)) continue;
      targets.set(id, [...(targets.get(id) ?? []), `[text-integrity/${f.kind}] ${f.detail}\n${f.repairInstruction}`]);
    }
    // Repair #4 (finalize-refs): an undefined VALUE identifier was stubbed this
    // round — the scene RENDERS now (empty where the data should be) instead of
    // throwing, but the stub is a bridge, not a pass. Route a regen to the
    // piece(s) whose body actually references the identifier (word-boundary
    // match, restricted to the erroring scenes); fall back to the scene's hero.
    for (const v of valueStubbedThisRound) {
      const wordRx = new RegExp(`(?<![\\w$])${v.name.replace(/\$/g, "\\$")}(?![\\w$])`);
      for (const scene of v.scenes) {
        if (scene < 0) continue;
        const owners = [...pieceCache.entries()]
          .filter(([id, body]) => id.startsWith(`s${scene}.`) && validPieceIds.has(id) && wordRx.test(body))
          .map(([id]) => id);
        const routeTo = owners.length > 0 ? owners : validPieceIds.has(`s${scene}.hero`) ? [`s${scene}.hero`] : [];
        for (const id of routeTo) {
          targets.set(id, [
            ...(targets.get(id) ?? []),
            `[finalize/undefined-value-ref] Your element's JSX references \`${v.name}\`, but \`${v.name}\` is not defined ANYWHERE — not inside your element, not in the provided design-system consts. At render time this threw \`ReferenceError: ${v.name} is not defined\` and blanked the ENTIRE scene; a deterministic pass stubbed \`${v.name}\` to an empty value so the scene renders, leaving the region it should populate EMPTY.\nRe-emit this element defining EVERY array/object it maps or indexes INLINE, inside the element itself, with concrete literal data — e.g. \`{[{...}, {...}].map((row, i) => ...)}\` — never a bare reference to data that is not in scope.`,
          ]);
        }
      }
    }

    const gateRound: GateRoundReport = {
      round,
      llmCallsThisRound: 0, // caller-owned counter; the spike patches this via onRoundComplete
      castTelemetry: castResult.telemetry,
      density,
      profile,
      structural,
      renderTruthAll: rt.findings,
      renderTruthBlocking: rt.blocking,
      heroContrast: { stats: contrast.stats, findings: contrast.findings, errors: contrast.errors },
      washoutNearMiss: contrast.advisories,
      heroUnderscale: underscale,
      skeletonBars,
      washoutsAtGate: contrastRaw.findings.length,
      washoutLifts: washoutLiftEvents.filter((e) => e.round === round),
      imgSwaps: imgSwapEvents.filter((e) => e.round === round),
      accentFill: { stats: accentFill.stats, findings: accentFill.findings, errors: accentFill.errors },
      edgeCrop: { initial: edgeCropInitial, residual: edgeCropResidual },
      occupancy: {
        stats: occupancy.stats,
        findings: occupancy.findings,
        cardAdvisories: occupancy.cardAdvisories,
        errors: occupancy.errors,
      },
      textContrast: {
        blocking: textContrast.findings,
        advisories: textContrast.advisories,
        stats: textContrast.stats,
        errors: textContrast.errors,
      },
      strayFragments: strayFragmentEvents.filter((e) => e.round === round),
      iconFontStrips: iconFontStripEvents.filter((e) => e.round === round),
      orphanedFragments,
      crossPieceStatDups,
      brandMarkDefects,
      accentedGlyphGaps,
      vision,
      targets: [...targets.entries()].map(([pieceId, feedback]) => ({ pieceId, feedback })),
    };
    gateRounds.push(gateRound);

    if (round === 0) {
      round0 = {
        passed: targets.size === 0,
        targets: [...targets.keys()],
        density: density.length,
        washoutsAtGate: contrastRaw.findings.length,
        washoutsLifted: washoutLiftEvents.filter((e) => e.round === 0 && e.action === "forced-lift").length,
        washouts: contrast.findings.length,
        accentFills: accentFill.findings.length,
        brokenImgs: imgSwapEvents.filter((e) => e.round === 0).length,
        edgeCropsInitial: edgeCropInitial.length,
        edgeCropsClamped: edgeCropEvents.filter((e) => e.round === 0 && e.action === "clamped").length,
        edgeCropsResidual: edgeCropResidual.length,
        heroUnderscale: underscale.length,
        washoutNearMiss: contrast.advisories.length,
        skeletonBarsAdvisory: skeletonBars.filter((f) => !f.blocking).length,
        skeletonBarsBlocking: skeletonBars.filter((f) => f.blocking).length,
        occupancyVoidsBlocking: occupancyBlocking.length,
        occupancyVoidsAdvisory: occupancy.findings.filter((f) => !f.blocking).length,
        cardInteriorAdvisory: occupancy.cardAdvisories.length,
        textContrastBlocking: textContrast.findings.length,
        textContrastAdvisory: textContrast.advisories.length,
        strayFragments: strayFragmentEvents.filter((e) => e.round === 0).length,
        iconFontStrips: iconFontStripEvents.filter((e) => e.round === 0).length,
        orphanedFragments: orphanedFragments.length,
        crossPieceStatDups: crossPieceStatDups.length,
        brandMarkDefects: brandMarkDefects.length,
        accentedGlyphGaps: accentedGlyphGaps.length,
        structural: structural.length,
        rtBlocking: rt.blocking.length,
        visionSevereScenes: vision.filter((v) => v.severe.length > 0).map((v) => v.scene),
      };
      log(
        targets.size === 0
          ? "  ★★★ ROUND 0 PASSED — every blocking gate clean on the first cast"
          : `  ROUND 0 FAILED — ${targets.size} retry target(s): [${[...targets.keys()].join(", ")}]`,
      );
    }

    await hooks.onRoundComplete?.({ gateRound, round, measurements, finalCode, round0: round === 0 ? round0 : null });

    log(
      `  round ${round}: density ${density.length} · washout ${contrastRaw.findings.length}→${contrast.findings.length} residual (${washoutLiftEvents.filter((e) => e.round === round && e.action === "forced-lift").length} forced lift(s), ${washoutLiftEvents.filter((e) => e.round === round && e.action === "sparse-furnish-routed").length} sparse→furnish, ${washoutLiftEvents.filter((e) => e.round === round && e.reverted).length} reverted) · near-miss ${contrast.advisories.length} · ` +
        `underscale ${underscale.length} · skeleton ${skeletonBars.length} · accent-fill ${accentFill.findings.length} · ` +
        `occupancy ${occupancyBlocking.length} block/${occupancy.findings.filter((f) => !f.blocking).length} adv/${occupancy.cardAdvisories.length} card · ` +
        `text-contrast ${textContrast.findings.length} block/${textContrast.advisories.length} adv · stray ${strayThisRound.length} · ` +
        `edge-crop ${edgeCropInitial.length}→${edgeCropResidual.length} residual · structural ${structural.length} · render-truth ${rt.findings.length} (${rt.blocking.length} blocking${rt.blocking.length ? ` [${rt.blocking.map((f) => `s${f.scene}:${f.kind}`).join(", ")}]` : ""}) · ` +
        `vision actionable ${vision.reduce((n, v) => n + v.actionable.length, 0)} (severe on [${vision.filter((v) => v.severe.length).map((v) => v.scene).join(", ")}]) · ` +
        `retry targets [${[...targets.keys()].join(", ") || "none"}]`,
    );

    if (targets.size === 0) {
      log(`  all scene-scoped blocking gates clean — done after round ${round}`);
      break;
    }

    // v12 (#1): CLASS-MATCHED NO-PROGRESS BREAKER.
    const densityMetricOf = (pieceId: string): { value: number; aux: number } => {
      const sceneIdx = Number(/^s(\d+)\./.exec(pieceId)?.[1] ?? -1);
      const st = profile?.scenes.find((s) => s.scene === sceneIdx)?.pieces.find((pp) => pp.id === pieceId);
      return { value: st?.elements ?? 0, aux: st?.textNodes ?? 0 };
    };
    const classMetricOf = (
      pieceId: string,
      feedback: string[],
    ): { cls: FailureClass; value: number; aux: number; metric: string } => {
      const joined = feedback.join("\n");
      if (joined.includes("[hero-contrast/hero-washout]")) {
        const st = contrast.stats.find((s) => s.pieceId === pieceId);
        return { cls: "washout", value: st?.spread ?? 0, aux: st?.stdDev ?? 0, metric: `spread ${st?.spread ?? 0}/std ${st?.stdDev ?? 0}` };
      }
      if (joined.includes("[render-truth/")) {
        const sceneIdx = Number(/^s(\d+)\./.exec(pieceId)?.[1] ?? -1);
        let count =
          rt.blocking.filter((f) => f.detail.includes(pieceId)).length +
          edgeCropResidual.filter((f) => f.pieceId === pieceId).length;
        if (count === 0) {
          count = rt.blocking.filter((f) => f.scene === sceneIdx && !(f.detail.match(PIECE_ID_RX) ?? []).length).length;
        }
        return { cls: "render-truth", value: count, aux: 0, metric: `${count} blocking render-truth finding(s) on this piece` };
      }
      if (joined.includes("[accent-fill/")) {
        const st = accentFill.stats.find((s) => s.pieceId === pieceId);
        const frac = Math.round((st?.largestRectFrac ?? 0) * 1000) / 10;
        return { cls: "accent-fill", value: frac, aux: 0, metric: `largest accent rect ${frac}% of piece` };
      }
      // Audit-1 Medium #5: hero-underscale AND occupancy-void are ONE class —
      // both mean "the hero owns a void frame". value = void-run % (want it to
      // shrink), aux = painted-union % (want it to grow); either improving is
      // progress. One class = the breaker sees continuous no-progress instead of
      // resetting each round as the defect flips names.
      if (joined.includes("[hero-scale/") || joined.includes("[occupancy/")) {
        const u = underscale.find((x) => x.pieceId === pieceId);
        const o = occupancyBlocking.find((x) => x.pieceId === pieceId);
        const voidPct = Math.round((o?.runFracW ?? 0) * 1000) / 10;
        const paintedPct = Math.round((u?.paintedFrac ?? 0) * 1000) / 10;
        return { cls: "hero-void", value: voidPct, aux: paintedPct, metric: `void ${voidPct}% / painted ${paintedPct}% of frame` };
      }
      if (joined.includes("[structural/skeleton_bars]")) {
        const f = skeletonBars.find((s) => s.pieceId === pieceId);
        return { cls: "skeleton", value: f?.bars ?? 0, aux: f?.rows ?? 0, metric: `${f?.bars ?? 0} skeleton bar(s) in ${f?.rows ?? 0} row(s)` };
      }
      if (joined.includes("[text-contrast/")) {
        const f = textContrast.findings.filter((t) => t.pieceId === pieceId).sort((a, b) => a.ratio - b.ratio)[0];
        const r = Math.round((f?.ratio ?? 0) * 100) / 100;
        return { cls: "text-contrast", value: r, aux: 0, metric: `worst text contrast ${r}:1` };
      }
      const d = densityMetricOf(pieceId);
      const cls: FailureClass = joined.includes("[density/") ? "density" : "vision";
      return { cls, value: d.value, aux: d.aux, metric: `${d.value}el/${d.aux}tx` };
    };
    const isClassProgress = (
      cls: FailureClass,
      prev: { value: number; aux: number },
      cur: { value: number; aux: number },
    ): boolean => {
      switch (cls) {
        case "washout":
          return cur.value > prev.value + 4 || cur.aux > prev.aux + 2;
        case "render-truth":
          return cur.value < prev.value;
        case "accent-fill":
          return cur.value < prev.value - 2;
        case "hero-void":
          // progress when the void shrinks OR the painted area grows.
          return cur.value < prev.value - 1 || cur.aux > prev.aux + 1;
        case "skeleton":
          return cur.value < prev.value || cur.aux < prev.aux;
        case "text-contrast":
          return cur.value > prev.value + 0.3;
        default:
          return cur.value > prev.value || cur.aux > prev.aux;
      }
    };
    for (const [pieceId, feedback] of [...targets.entries()]) {
      const cur = classMetricOf(pieceId, feedback);
      const prev = regenHistory.get(pieceId);
      if (!prev) {
        regenHistory.set(pieceId, { cls: cur.cls, value: cur.value, aux: cur.aux, escalated: false });
        continue;
      }
      if (prev.cls !== cur.cls) {
        log(`  [no-progress] ${pieceId}: failure class moved ${prev.cls} → ${cur.cls} (the ${prev.cls} defect was fixed) — regen continues on the new class`);
        regenHistory.set(pieceId, { cls: cur.cls, value: cur.value, aux: cur.aux, escalated: prev.escalated });
        continue;
      }
      if (isClassProgress(cur.cls, prev, cur)) {
        regenHistory.set(pieceId, { cls: cur.cls, value: cur.value, aux: cur.aux, escalated: prev.escalated });
        continue;
      }
      if (!prev.escalated) {
        pieceCache.delete(pieceId);
        cacheBustEvents.push({ pieceId, reason: `no-progress escalation (${cur.cls}) — cached emission evicted for a FRESH re-emission` });
        targets.set(pieceId, [
          `${ESCALATION_MARK} two consecutive rounds measured this piece failing the SAME class — ${cur.cls} (${cur.metric}, unmoved) — a repaired variant of the previous approach is NOT working.`,
          `The previous round's failures, verbatim:`,
          ...feedback,
        ]);
        noProgressEvents.push({ pieceId, round, action: "escalated", cls: cur.cls, metric: cur.metric });
        regenHistory.set(pieceId, { cls: cur.cls, value: cur.value, aux: cur.aux, escalated: true });
        warn(`  [no-progress] ${pieceId}: ${cur.cls} unmoved (${cur.metric}) — ESCALATED to a fresh full emission (cache busted, blueprint authoritative)`);
      } else {
        targets.delete(pieceId);
        noProgressEvents.push({
          pieceId,
          round,
          action: "accepted-and-flagged",
          cls: cur.cls,
          metric: cur.metric,
          finding: feedback[0]?.slice(0, 220),
        });
        warn(`  [no-progress] ${pieceId}: escalation did not move ${cur.cls} (${cur.metric}) — ACCEPTED AND FLAGGED (residual finding ships honestly in the report)`);
      }
    }
    if (targets.size === 0) {
      log(`  every remaining target was accept-and-flagged by the no-progress breaker — done after round ${round}`);
      break;
    }
    if (round >= config.maxRetryRounds) {
      // P3-C2 #5: grant the canvas-coherence class ONE extra round when it is
      // the ONLY thing left — every remaining target's feedback is exclusively
      // a canvas-coherence/brightness tag. Its repair (repaint the full-bleed
      // canvas onto the brand token) is deterministic-shaped and lands quickly.
      // Every [bracket-tag] in the feedback (e.g. "render-truth/canvas-coherence",
      // "hero-contrast/hero-washout", "vision") — the FULL inner so a co-occurring
      // non-coherence class is never mistaken for coherence-only.
      const bracketTags = (fb: string[]): string[] =>
        fb.flatMap((line) => [...line.matchAll(/\[([^\]]+)\]/g)].map((mm) => mm[1]));
      const isCoherenceTag = (t: string): boolean =>
        t === "render-truth/canvas-coherence" || t === "render-truth/canvas-brightness";
      const onlyCoherenceLeft =
        targets.size > 0 &&
        [...targets.values()].every((fb) => {
          const tags = bracketTags(fb);
          return tags.length > 0 && tags.every(isCoherenceTag);
        });
      if (onlyCoherenceLeft && !coherenceBonusUsed) {
        coherenceBonusUsed = true;
        warn(`  [canvas-coherence] budget spent but only canvas-coherence targets remain [${[...targets.keys()].join(", ")}] — granting ONE extra convergence round (a frame on the wrong canvas must converge, not ship flagged)`);
      } else {
        warn(`  targets remain [${[...targets.keys()].join(", ")}] but the ${config.maxRetryRounds}-round retry budget is spent — shipping with residual findings (honest)`);
        break;
      }
    }
    if (hooks.shouldStopForBudget()) {
      warn(`  budget ceiling reached — shipping with residual findings (honest)`);
      break;
    }
    pieceTargets = targets;
    round += 1;
  }

  // FINAL motif-clutter pass: the per-round excision runs on that round's
  // pre-excision measurements, so a layout that only settles on the LAST round
  // (a regenerated hero shrinking away from the pinned throughline anchor) can
  // leave a ghost glyph / floating motif pill in the shipped frame. Re-measure
  // the final code once and excise against THAT, so the shipped composition and
  // finalMeasurements agree with what actually renders.
  {
    const finalMotif = await measureScenes(genDir, script, genDir);
    let excised = 0;
    for (const mm of finalMotif) {
      const owner = (script.scenes?.[mm.scene] as { composition?: { budget?: { brandMark?: unknown } } } | undefined)?.composition?.budget?.brandMark;
      const findings = findMotifClutter(mm, { brandName: BRAND, brandMarkOwner: typeof owner === "string" ? owner : undefined });
      const byPiece = new Map<string, MotifClutterFinding[]>();
      for (const f of findings) byPiece.set(f.pieceId, [...(byPiece.get(f.pieceId) ?? []), f]);
      for (const [pieceId, group] of byPiece) {
        const span = pieceSpanInCode(finalCode, pieceId);
        if (!span) continue;
        const repair = exciseMotifClutter(finalCode.slice(span.start, span.end), group, { brandName: BRAND });
        if (repair.action === "none") continue;
        finalCode = finalCode.slice(0, span.start) + repair.code + finalCode.slice(span.end);
        if (pieceCache.has(pieceId)) {
          const cached = exciseMotifClutter(pieceCache.get(pieceId)!, group, { brandName: BRAND });
          if (cached.action !== "none") pieceCache.set(pieceId, cached.code);
        }
        excised += 1;
        motifClutterEvents.push({ round: round + 1, scene: group[0].scene, pieceId, form: group[0].form, action: repair.action, detail: `[final pass] ${group[0].detail} → ${repair.detail}` });
      }
    }
    if (excised > 0) {
      await hooks.writeComposition(finalCode);
      log(`  motif-clutter [final pass]: excised ${excised} — re-measuring`);
      finalMeasurements = await measureScenes(genDir, script, genDir);
    }

    // v16 SUBTLE TERMINAL — the floor under the furnish-regen path: a piece
    // whose washout is STILL unresolved after the loop AND whose panel is
    // still sparse ships with a visible boundary (hairline border + soft
    // shadow + a few-percent tint) — NEVER the ink paint-over (that terminal
    // manufactured the live "black box built to fill space" class). Zero
    // tokens; honest-small beats big-and-black. Skipped entirely when the
    // last round ended washout-clean.
    if (finalContrast && finalContrast.findings.length > 0) {
      const termContrast = await assessHeroWashout(finalMeasurements, { canvasBackground });
      let subtleLifted = 0;
      for (const f of termContrast.findings) {
        const m3 = finalMeasurements.find((mm) => mm.scene === f.scene);
        const reading = m3 ? readDominantPanel(m3, f.pieceId, canvasBackground) : null;
        if (!reading || reading.coverage >= CARD_INTERIOR_FLOOR) continue;
        const span = pieceSpanInCode(finalCode, f.pieceId);
        if (!span) continue;
        const lift = subtleSurfaceLift(finalCode.slice(span.start, span.end), theme, { canvasColor: canvasBackground });
        if (!lift.lifted) continue;
        finalCode = finalCode.slice(0, span.start) + lift.code + finalCode.slice(span.end);
        if (pieceCache.has(f.pieceId)) {
          const cachedLift = subtleSurfaceLift(pieceCache.get(f.pieceId)!, theme, { canvasColor: canvasBackground });
          if (cachedLift.lifted) pieceCache.set(f.pieceId, cachedLift.code);
        }
        subtleLifted += 1;
        washoutLiftEvents.push({
          round: round + 1,
          pieceId: f.pieceId,
          action: "subtle-terminal",
          via: lift.via,
          targetToken: null,
          interiorTextRepaints: 0,
          before: { spread: f.stats.spread, std: f.stats.stdDev },
          after: null,
          cleared: null,
        });
        warn(
          `  [washout-lift] ${f.pieceId} [final pass]: residual SPARSE washout — subtle boundary applied (border+tint+shadow, ${lift.targetHex}); never the ink paint-over`,
        );
      }
      if (subtleLifted > 0) {
        await hooks.writeComposition(finalCode);
        log(`  washout [final pass]: ${subtleLifted} subtle terminal(s) — re-measuring`);
        finalMeasurements = await measureScenes(genDir, script, genDir);
      }
    }

    // DETERMINISTIC VOID FURNISH — a best-effort NET, not a guarantee (audit-3:
    // the "furnish converges / a void can no longer ship" claim was false; the
    // honest terminal on a content-starved void is the accepted-and-flagged
    // residual below). Furnish attempts EVERY flagged void — blocking, severe, OR
    // advisory, regardless of register — filling the band with a brand-consistent
    // panel from the scene's own values when real content is available, and
    // declining when the only content is a redundant restatement. It does NOT own
    // composition-class voids (empty half, occlusion, marooned hero): those need a
    // bound moved, which only a scene-scoped HEAD re-author can do.
    const postOcc = await assessOccupancy(finalMeasurements, sceneRegisters);
    // R4 (audit-2): ONE furnish panel per scene — dedup the surviving voids by
    // scene, keeping the widest run (the void most worth filling). The 5-arm mesh
    // used to stamp a panel per finding; the rebalanced contract furnishes at most
    // one, and only when the hero is genuinely hollow.
    const survivingVoids = [...postOcc.findings]
      .sort((a, b) => b.runFracW - a.runFracW)
      .filter((f, _i, arr) => arr.findIndex((g) => g.scene === f.scene) === arr.indexOf(f));
    if (survivingVoids.length > 0) {
      const canvas = CANVAS[config.castInput.aspect] ?? CANVAS["16:9"];
      const surfaceHex = pickFurnishSurface(Object.values(theme.palette), canvasBackground);
      const accentHex = accentHexes.find((h) => /^#[0-9a-fA-F]{3,8}$/.test(h)) ?? surfaceHex;
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const collectContentStrings = (content: Record<string, unknown>): string[] => {
        const out: string[] = [];
        for (const [field, v] of Object.entries(content)) {
          if (field === "headline") continue; // already rendered by copy
          if (typeof v === "string" && v.trim().length >= 3) out.push(v.trim());
          else if (Array.isArray(v)) {
            for (const item of v) {
              if (typeof item === "string" && item.trim().length >= 3) out.push(item.trim());
              else if (item && typeof item === "object") {
                for (const s of Object.values(item)) if (typeof s === "string" && s.trim().length >= 3) out.push(s.trim());
              }
            }
          }
        }
        return out;
      };
      let anyInjected = false;
      for (const f of survivingVoids) {
        const scene = f.scene;
        // R4 + C8 #1: REGISTER-AWARE HERO-HEALTH GATE. A hero painting above the
        // health floor owns its frame — the air around it is INTENTIONAL negative
        // space, furnish suppressed (the audit-2 debug-box-beside-a-healthy-hero
        // defect) — ONLY on registers whose air is deliberate (centered/quote/
        // full-bleed). On a SPLIT/LIST — registers that PROMISE a filled second
        // region — a healthy hero on ONE side does NOT license an abandoned OTHER
        // side: a void ≥ FURNISH_ABANDONMENT_FRAC is the Flexport-s1 / Deel-s1
        // abandoned-half class and furnishes the VOID BAND regardless of hero health.
        const measurement = finalMeasurements.find((m) => m.scene === scene);
        const heroFrac = measurement ? heroPaintedFraction(measurement) : 1;
        const heroHollow = heroFrac < HERO_HEALTHY_FRAC;
        const register = sceneRegisters?.[scene];
        const decision = furnishDecision(heroHollow, register, f.runFracW, f.region);
        if (decision === "skip-healthy") {
          voidFurnishEvents.push({ scene, pieceId: f.pieceId, runFracW: f.runFracW, region: f.region, action: "skipped-healthy-hero", detail: `${(f.runFracW * 100).toFixed(0)}% ${f.region} void beside a HEALTHY ${register ?? "?"} hero (painted ${(heroFrac * 100).toFixed(0)}% ≥ ${(HERO_HEALTHY_FRAC * 100).toFixed(0)}%) — intentional negative space, furnish suppressed (R4/C8)` });
          log(`  [void-furnish] scene ${scene}: hero healthy (${(heroFrac * 100).toFixed(0)}% painted, ${register ?? "?"}) — ${(f.runFracW * 100).toFixed(0)}% void left as intentional negative space (no furnish)`);
          continue;
        }
        const abandonedHalf = decision === "furnish-abandoned";
        const comp = config.castInput.script.scenes[scene]?.composition as
          | { elements?: { role?: string; subject?: string; interior?: string[]; bounds?: { x: number; y: number; w: number; h: number } }[] }
          | undefined;
        const els = Array.isArray(comp?.elements) ? comp!.elements! : [];
        const heroEl = els.find((e) => e.role === "hero");
        // R3: content dedup. Never duplicate strings ALREADY PAINTED on screen (the
        // Mailchimp redundant-label box). Prefer NON-hero interior + eyebrow/caption/
        // meta; the hero's own inventory is admissible ONLY because the hero is
        // hollow (nothing of it is on screen to duplicate).
        const paintedRaw = (measurement?.elements ?? [])
          .map((e) => (e.text ?? "").trim())
          .filter((t) => t.length >= 3);
        const paintedOnScreen = new Set(paintedRaw.map((t) => norm(t)).filter((t) => t.length >= 3));
        const content = (script.scenes?.[scene]?.content ?? {}) as Record<string, unknown>;
        const preferred = [content.eyebrow, content.caption, content.meta]
          .filter((v): v is string => typeof v === "string" && v.trim().length >= 2)
          .map((v) => v.trim());
        const nonHeroInterior = extractQuotedValues(
          els.filter((e) => e.role !== "hero").flatMap((e) => (Array.isArray(e.interior) ? e.interior : [])),
        );
        const heroInterior = extractQuotedValues(Array.isArray(heroEl?.interior) ? heroEl!.interior! : []);
        // C9 #1: filter furnish candidates to non-redundant, non-junk rows.
        //  (a) PREFIX/SUBSTRING-aware dedup vs painted strings (a truncated lede
        //      "…And c" is caught even though it ≠ the full painted lede);
        //  (b) reject raw blueprint widget descriptors on VALUE rows ("code-window");
        //  (c) drop scene-meta chrome captions ("SCENE 01 / 06", "payments.js · …").
        const dedup = (arr: string[]): string[] => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const v of arr) {
            const k = norm(v);
            if (k.length < 2 || seen.has(k)) continue;
            if (SCENE_META_LABEL_RX.test(v) || isDescriptorValueRow(v)) continue;
            if (paintedOnScreen.has(k) || isRedundantWithPainted(v, paintedRaw)) continue;
            seen.add(k);
            out.push(v);
          }
          return out;
        };
        // Admit the hero's OWN inventory only when the hero is HOLLOW (nothing of
        // it is painted to duplicate). On an abandoned-half furnish (C8 #1) the hero
        // IS on screen — its strings belong to the opposite column, not this card —
        // so the card is built from eyebrow/caption/meta + non-hero interior only.
        let values = dedup([...preferred, ...nonHeroInterior, ...(heroHollow ? heroInterior : [])]);
        if (values.length < 2) {
          values = dedup([...values, ...collectContentStrings(content), BRAND]);
        }
        // R3: if there is still no non-redundant content to render, DON'T furnish —
        // a stamped panel of duplicate labels is worse than the void.
        if (values.length < 2) {
          voidFurnishEvents.push({ scene, pieceId: f.pieceId, runFracW: f.runFracW, region: f.region, action: "skipped", detail: `${f.detail} (no non-redundant content → residual flagged rather than a duplicate box)` });
          warn(`  [void-furnish] scene ${scene}: ${abandonedHalf ? "abandoned half" : "hollow hero"} but no non-redundant content to furnish — residual ships FLAGGED (honest)`);
          continue;
        }
        // Title the panel from the hero subject only when FILLING a hollow hero's
        // bounds; an abandoned-half card is a supporting panel, not a re-titled hero.
        const title = heroHollow ? placeholderTitleFromSubject(heroEl?.subject) : undefined;
        // R4: a HOLLOW hero → FILL its own authored bounds (scale-to-fill where the
        // hero should be) over stamping an adjacent panel. An ABANDONED-HALF furnish
        // (C8 #1, healthy hero) must NOT paint the hero's bounds — the hero is
        // already there — so it furnishes the detected VOID BAND (the empty column/
        // row band the split/list left abandoned) instead.
        const heroBounds = heroEl?.bounds;
        const heroRect =
          heroHollow && heroBounds && heroBounds.w >= 200 && heroBounds.h >= 140
            ? {
                x: Math.max(FURNISH_INSET_PX, heroBounds.x),
                y: Math.max(FURNISH_INSET_PX, heroBounds.y),
                w: Math.min(heroBounds.w, canvas.w - 2 * FURNISH_INSET_PX),
                h: Math.min(heroBounds.h, canvas.h - 2 * FURNISH_INSET_PX),
              }
            : null;
        const bandRect =
          f.axis === "row" && f.rowBand
            ? furnishRectForRowBand(f.rowBand, canvas)
            : furnishRectForBand(f.band, canvas);
        // C9 #1c: size an abandoned/side void-band panel to its actual content (a
        // SHORT panel, not a tall mostly-empty dark box — the Razorpay-s1 defect).
        // A hollow-hero FILL keeps the hero's authored bounds.
        const rect =
          heroRect ??
          (bandRect ? fitRectToContent(bandRect, Math.min(values.length, 8), false, canvas.h) : null);
        if (!rect || values.length < 1) {
          voidFurnishEvents.push({ scene, pieceId: f.pieceId, runFracW: f.runFracW, region: f.region, action: "skipped", detail: `${f.detail} (no furnishable rect/values → residual flagged)` });
          warn(`  [void-furnish] scene ${scene}: ${(f.runFracW * 100).toFixed(0)}% void unfurnishable (rect=${!!rect}, values=${values.length}) — residual ships FLAGGED (honest)`);
          continue;
        }
        const panel = buildFurnishPanelJsx({
          pieceId: `s${scene}.furnish`,
          rect,
          values,
          title,
          surfaceHex,
          accentHex,
          fontDisplay: theme.fonts.display,
          fontBody: theme.fonts.body,
        });
        const inj = injectFurnishIntoSection(finalCode, scene, panel);
        if (inj.injected) {
          finalCode = inj.code;
          anyInjected = true;
          const cause = abandonedHalf ? `abandoned ${register} half` : `hollow hero ${(heroFrac * 100).toFixed(0)}%`;
          voidFurnishEvents.push({ scene, pieceId: `s${scene}.furnish`, runFracW: f.runFracW, region: f.region, action: "furnished", detail: `${(f.runFracW * 100).toFixed(0)}% ${f.region} void (${cause}) → deterministic furnish panel (${values.length} items)` });
          log(`  [void-furnish] scene ${scene}: ${cause} → filled ${(f.runFracW * 100).toFixed(0)}% ${f.region} void with a ${values.length}-item brand panel (deterministic — no regen)`);
        } else {
          voidFurnishEvents.push({ scene, pieceId: f.pieceId, runFracW: f.runFracW, region: f.region, action: "skipped", detail: `${f.detail} (section anchor absent → residual flagged)` });
          warn(`  [void-furnish] scene ${scene}: could not locate Section${scene} anchor — residual ships FLAGGED (honest)`);
        }
      }
      if (anyInjected) {
        await hooks.writeComposition(finalCode);
        finalMeasurements = await measureScenes(genDir, script, genDir);
        // Confirm the fill CONVERGED the void; mark any still-blocking as residual.
        const confirmOcc = await assessOccupancy(finalMeasurements, sceneRegisters);
        // Any still-flagged void (blocking OR advisory) in a furnished scene = the
        // fill didn't converge → mark residual (honest). Mirrors the widened filter.
        const stillVoid = new Set(confirmOcc.findings.map((v) => v.scene));
        for (const ev of voidFurnishEvents.filter((e) => e.action === "furnished")) {
          if (stillVoid.has(ev.scene)) {
            ev.action = "furnished-residual";
            warn(`  [void-furnish] scene ${ev.scene}: panel injected but occupancy still flags a void — residual ships FLAGGED (honest)`);
          } else {
            log(`  [void-furnish] scene ${ev.scene}: void CONVERGED (occupancy clean after deterministic fill)`);
          }
        }
      }
    }
  }

  return {
    finalCode,
    finalMeasurements,
    gateRounds,
    roundTelemetry,
    round0,
    rounds: round,
    castResult,
    profile,
    finalContrast,
    finalAccentFill,
    pieceCache,
    events: { edgeCropEvents, washoutLiftEvents, imgSwapEvents, strayFragmentEvents, motifClutterEvents, iconFontStripEvents, accentFallbackEvents, bindCopyEvents, noProgressEvents, cacheBustEvents, voidFurnishEvents },
    finalize,
    ...(castRoundError ? { castRoundError } : {}),
  };
}
