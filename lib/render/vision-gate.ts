/**
 * Render-truth vision gate (Phase 3) — the holistic readability/brand-fit layer
 * the deterministic gates can't cover.
 *
 * Deterministic gates (overflow) catch unambiguous correctness. But "the logos
 * are washed out," "this is a wall of type," "the canvas isn't the brand color,"
 * and "this just looks broken" are judgment calls a brittle pixel heuristic
 * false-positives on (proven in Phase 1 — the monochrome-logo contrast FP). So
 * those go to an Opus vision pass on the rendered screenshot, judged against the
 * brand truth.
 *
 * ADVISORY by default: findings are surfaced as warnings, not blockers, until
 * the false-positive rate is calibrated on real builds. The judge is injected
 * so the gate logic is unit-tested with a mock — no real vision spend.
 */
import { promises as fs } from "fs";

export interface VisionFinding {
  scene: number;
  issue: string;
}

/** Brand truth the rubric judges against. */
export interface BrandTruth {
  name?: string;
  /** The canvas/page background the brand actually uses (e.g. burgundy #440b12). */
  backgroundColor?: string;
  /** Signature accent (CTAs/emphasis). */
  accent?: string;
  /** Expected font families (e.g. a serif the brand uses for emphasis). */
  fonts?: string[];
}

/** A judge verdict for one scene frame. */
export interface VisionVerdict {
  ok: boolean;
  issues: string[];
}

/** Injected: judge one screenshot against the rubric. Returns issues found. */
export type VisionJudge = (
  screenshotPath: string,
  sceneIndex: number,
  rubric: string,
) => Promise<VisionVerdict>;

export const buildRubric = (brand: BrandTruth): string => {
  const lines = [
    "You are a brutally honest brand-video QA reviewer. This is ONE rendered scene of a 1920×1080 brand video.",
    "Judge ONLY what you can see. Report concrete, visible problems a viewer would notice — not nitpicks.",
    "Check:",
    brand.backgroundColor
      ? `- Canvas/background: the brand's real background is ${brand.backgroundColor}. Flag if the canvas is a clearly different color (e.g. near-black/navy when the brand is burgundy).`
      : "- Canvas/background: flag a generic dark/black canvas if it clearly clashes with the brand.",
    "- Readability: flag any text or logo that is washed out, low-contrast, or hard to read against its surface.",
    "- Wall-of-type: flag a scene that is essentially just large text with no substantial non-text/diegetic element.",
    brand.fonts && brand.fonts.length
      ? `- Fonts: the brand uses ${brand.fonts.join(", ")}. Flag if the type looks like a generic default that ignores the brand's faces (esp. a missing serif).`
      : "- Fonts: flag obviously off-brand/default typography.",
    "- Clipping/overflow: flag any element cut off at an edge (a deterministic gate also checks this; report if you still see it).",
    'Return ONLY JSON: {"ok": boolean, "issues": ["short, specific problem", ...]}. ok=true and issues:[] when the scene looks correct and on-brand. No prose.',
  ];
  return lines.join("\n");
};

/**
 * Run the vision gate over the per-scene screenshots. Returns findings (one per
 * issue). Best-effort: a judge error on a scene is skipped (advisory pass must
 * never break a build). Reuses one rubric across scenes.
 */
export const runVisionGate = async (
  scenes: { scene: number; screenshotPath?: string }[],
  brand: BrandTruth,
  judge: VisionJudge,
): Promise<VisionFinding[]> => {
  const rubric = buildRubric(brand);
  const out: VisionFinding[] = [];
  for (const s of scenes) {
    if (!s.screenshotPath) continue;
    try {
      const v = await judge(s.screenshotPath, s.scene, rubric);
      if (!v.ok) for (const issue of v.issues) out.push({ scene: s.scene, issue });
    } catch {
      // advisory — skip a scene whose judge call failed
    }
  }
  return out;
};

/** Parse the model's JSON verdict tolerantly (finds the first {...} object). */
export const parseVerdict = (text: string): VisionVerdict => {
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { ok: true, issues: [] };
    const o = JSON.parse(m[0]) as { ok?: unknown; issues?: unknown };
    const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === "string") : [];
    return { ok: o.ok === true && issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
};

/**
 * Build the real Opus-vision judge. Reads the PNG, sends it + the rubric to the
 * vision-capable model, parses the JSON verdict. `callVision` is injected (the
 * route passes an Anthropic-backed call) so this stays free of a hard SDK dep
 * here and unit-testable.
 */
export const makeVisionJudge = (
  callVision: (imageBase64: string, rubric: string) => Promise<string>,
): VisionJudge => {
  return async (screenshotPath, _sceneIndex, rubric) => {
    const buf = await fs.readFile(screenshotPath);
    const text = await callVision(buf.toString("base64"), rubric);
    return parseVerdict(text);
  };
};
