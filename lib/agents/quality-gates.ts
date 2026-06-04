/**
 * Build-time quality gates on a generated Composition.tsx.
 *
 * Pure, dependency-free string checks — kept in their own module (not
 * pipeline.ts) so they're unit-testable without importing the agent /
 * render stack. Mirror the existing assess* gates in pipeline.ts; the
 * pipeline folds their output into the same single retry message as the
 * density / contrast / icon / dead-air gates.
 *
 * All three are COARSE v1 heuristics. They favor false negatives (miss a
 * real issue) over false positives (block a clean render), because a
 * false positive costs an extra Opus retry on good output. The prompt
 * rules are the primary mechanism; these gates are the backstop for the
 * obvious, machine-detectable failures the prompts have been shown to
 * leak (a 952px element on a 920-safe canvas; a logo rendered twice).
 */

export type AspectRatio = "16:9" | "9:16" | "1:1";

/** Full canvas pixel width per aspect (height not needed for these gates). */
const CANVAS_WIDTH: Record<AspectRatio, number> = {
  "16:9": 1920,
  "9:16": 1080,
  "1:1": 1080,
};

/**
 * Safe content width per aspect — the design prompt's explicit caps
 * (1760 / 920 / 920), NOT the margin math, because the prompt is what the
 * agent is told to honor. An element wider than this but narrower than the
 * full canvas is overflowing into the unsafe margin (the Vercel bug:
 * width 952 on a 920-safe 9:16 canvas).
 */
const SAFE_WIDTH: Record<AspectRatio, number> = {
  "16:9": 1760,
  "9:16": 920,
  "1:1": 920,
};

// ─── #6 Reading-time gate (coarse v1) ────────────────────────────────
//
// Text must become legible FAST (a short entrance) and then dwell so a
// human can read it. Decorative / looping animations are allowed to be
// slow. This gate flags TEXT elements (h1/h2/h3/p) whose ENTRANCE
// animation is slower than `maxSec` — the egregious "we spent 1.2s
// animating the headline in" case. It handles both inline animation
// shorthands and <style>-block class rules. Infinite/sustained loops are
// exempt (they're atmosphere, not entrances). Dwell-vs-scene-duration math
// is deliberately deferred to v2 (needs reliable section→scene mapping).

export interface SlowTextEntrance {
  selector: string; // the text tag or the class name that carries the animation
  name: string; // animation keyframes name
  duration: number; // seconds
  where: "inline" | "class";
}

const ENTRANCE_DECL =
  /([A-Za-z][\w-]*)\s+([\d.]+)s/; // "fadeRise 1.2s" → [, name, dur]

const firstAnimation = (
  value: string,
): { name: string; duration: number; infinite: boolean } | null => {
  // The shorthand may chain animations with commas; the entrance is the
  // first. Scope the `infinite` check to that first declaration only.
  const firstDecl = value.split(",")[0];
  const m = firstDecl.match(ENTRANCE_DECL);
  if (!m) return null;
  return {
    name: m[1],
    duration: parseFloat(m[2]),
    infinite: /\binfinite\b/i.test(firstDecl),
  };
};

// Gate threshold 1.0s: a hard backstop for egregious slow text entrances
// (verified against real output — normal entrances run 0.4-0.8s; the bad
// cases were 1.2-1.8s letterSettle/fadeRise). The PROMPT targets ≤0.4-0.5s;
// this gate only retries when text is clearly over-animated.
export const findSlowTextEntrances = (
  code: string,
  maxSec = 1.0,
): SlowTextEntrance[] => {
  const out: SlowTextEntrance[] = [];

  // 1) Inline: <h1 ... animation: "fadeRise 1.2s ease 0.6s forwards" ...>
  const inlineRe =
    /<(h1|h2|h3|p)\b[^>]*?animation:\s*["'`]?([^"'`;}]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(code)) !== null) {
    const tag = m[1];
    const anim = firstAnimation(m[2]);
    if (anim && !anim.infinite && anim.duration > maxSec) {
      out.push({ selector: tag, name: anim.name, duration: anim.duration, where: "inline" });
    }
  }

  // 2) Class rule: .headline { ... animation: fadeRise 1.2s ... }  applied
  //    to a text tag <h1 className="... headline ...">.
  const classRuleRe = /\.([\w-]+)\s*\{[^}]*?animation:\s*([^;}]+)[;}]/gi;
  const textClasses = new Set<string>();
  const textTagClassRe = /<(?:h1|h2|h3|p)\b[^>]*class(?:Name)?=["'`]([^"'`]+)["'`]/gi;
  let tc: RegExpExecArray | null;
  while ((tc = textTagClassRe.exec(code)) !== null) {
    tc[1].split(/\s+/).forEach((c) => c && textClasses.add(c));
  }
  let cr: RegExpExecArray | null;
  while ((cr = classRuleRe.exec(code)) !== null) {
    const cls = cr[1];
    if (!textClasses.has(cls)) continue;
    const anim = firstAnimation(cr[2]);
    if (anim && !anim.infinite && anim.duration > maxSec) {
      out.push({ selector: "." + cls, name: anim.name, duration: anim.duration, where: "class" });
    }
  }

  return out;
};

// ─── #4 Overflow / crop gate (geometry-aware) ────────────────────────
//
// Flags elements that ACTUALLY get cropped by the canvas edge — not merely
// "wide" ones. The naive width-only check (flag any width in the unsafe
// band) false-positives on a wide-but-CENTERED element: a 1000px box at
// `left: "50%"` + `translate(-50%,-50%)` on a 1080 canvas has 40px margins
// each side and never crops (this exact case shipped clean in the Vercel
// pilot yet tripped the old gate). So we parse each inline style block and
// judge the real geometry:
//   • width ≥ canvas width (non-full-bleed) → crops both edges → flag
//   • width within (safe, canvas) AND left-anchored so left+width > canvas
//     → right edge spills past the canvas → flag (the real "popup cropped
//     on the right border" bug)
//   • a negative `right:` offset → pushed off the right edge → flag
//   • centered (left:50% + translate(±50%)) and width < canvas → safe, skip
//   • width === canvas width, or "100%"/auto → intentional full-bleed, skip
// Favors false negatives (the module philosophy): an ambiguous wide element
// with no measurable anchor is NOT flagged — better to miss one than to
// burn an Opus retry on a layout that's actually fine.

export const findOverflowingElements = (
  code: string,
  aspect: AspectRatio,
): number[] => {
  const canvasW = CANVAS_WIDTH[aspect];
  const safeW = SAFE_WIDTH[aspect];
  const out = new Set<number>();

  // Walk each inline style object so width is judged together with its
  // anchor. `[^{}]*` keeps each match to one flat style object (normal
  // inline styles don't nest braces).
  const styleRe = /style=\{\{([^{}]*)\}\}/g;
  let s: RegExpExecArray | null;
  while ((s = styleRe.exec(code)) !== null) {
    const block = s[1];
    const wm = block.match(/\bwidth:\s*["']?(\d{3,4})(?:px)?["']?/);
    if (!wm) continue; // no numeric px width ("100%", auto, var(...)) → skip
    const w = parseInt(wm[1], 10);

    if (w <= safeW || w === canvasW) continue; // within safe band, or full-bleed

    // Centered elements are symmetric, so they clip (w − canvas)/2 per side.
    // A small over-bleed is intentional (atmospheric glows, background washes
    // sized past the frame on purpose — e.g. a centered 1100px radial glow on
    // a 1080 canvas clips 10px a side). Only flag a centered element when it's
    // >10% wider than the canvas (>5% clipped per side = real content loss).
    const centered =
      /\bleft:\s*["']?50%/.test(block) &&
      /translate(?:X)?\(\s*-?50%/.test(block);
    if (centered) {
      if (w > canvasW * 1.1) out.add(w);
      continue;
    }

    if (w > canvasW) {
      out.add(w); // non-centered + wider than the canvas → crops off an edge
      continue;
    }
    // w is in the (safe, canvas) band, non-centered — depends on the anchor.

    const lm = block.match(/\bleft:\s*["']?(-?\d{1,4})(?:px)?["']?/);
    if (lm) {
      if (parseInt(lm[1], 10) + w > canvasW) out.add(w); // right edge spills
      continue;
    }
    const rm = block.match(/\bright:\s*["']?(-?\d{1,4})(?:px)?["']?/);
    if (rm && parseInt(rm[1], 10) < 0) out.add(w); // negative right → off-edge
    // else: wide, unanchored, ambiguous → favor false negative, don't flag
  }
  return [...out].sort((a, b) => b - a);
};

// ─── #3 Duplicate-logo gate ──────────────────────────────────────────
//
// BrandChrome renders the brand logo once (in its definition). If a scene
// ALSO renders the logo, the logo image appears at >1 source site → two
// logos on screen (the Notion CTA bug). Count <Img> sites whose src
// references a logo (const name or URL containing "logo").

export const findDuplicateLogos = (code: string): number => {
  const re = /<Img\b[^>]*\bsrc=\{?\s*["'`]?[^}"'`>\s]*logo[^}"'`>\s]*/gi;
  return (code.match(re) || []).length;
};

// ─── #2 Spatial-continuity gate (coarse v1, ADVISORY) ────────────────
//
// A motif that recurs across scenes (tagged `data-throughline="<slug>"`)
// should hold a stable anchor — roughly the same position scene to scene —
// so it reads as one continuous object instead of an element that
// teleports on every hard cut (the Notion popup: centered → right →
// centered). This gate groups tagged elements by slug and flags any slug
// whose numeric px anchor drifts more than ~10% of the canvas between its
// occurrences (matching the design-agent prompt rule).
//
// ADVISORY, not retry-forcing. This is the COARSEST gate: it only sees
// numeric px `left`/`top`. Percentage- or transform-based centering
// (`left: "50%"`) is invisible to it, so it under-reports heavily by
// design — a finding is surfaced as a build warning for a human to
// eyeball, and does NOT on its own burn an Opus retry (a false positive
// there is expensive; a missed jump is cheap). Favors false negatives.

const CANVAS_HEIGHT: Record<AspectRatio, number> = {
  "16:9": 1080,
  "9:16": 1920,
  "1:1": 1080,
};

// Fraction of the canvas a recurring anchor may drift before it reads as a
// teleport rather than a deliberate nudge. Mirrors the prompt's "~10%".
const DRIFT_FRACTION = 0.1;

export interface ThroughlineDrift {
  slug: string; // the data-throughline identity
  occurrences: number; // tagged elements carrying this slug (≈ scenes it appears in)
  measured: number; // how many had a comparable numeric px anchor on the flagged axis
  driftX: number; // px span between min/max left
  driftY: number; // px span between min/max top
  axis: "x" | "y" | "both";
  positions: { left: number | null; top: number | null }[];
}

// numeric px only — explicitly ignore "<n>%" (not comparable to px) and
// anything non-numeric. Fresh regex per call (no shared lastIndex state).
const pxAnchor = (tag: string, prop: "left" | "top"): number | null => {
  const m = tag.match(new RegExp("\\b" + prop + ":\\s*[\"'`]?(\\d+)(px|%)?"));
  if (!m) return null;
  if (m[2] === "%") return null; // percentage anchor — can't compare to px
  return parseInt(m[1], 10);
};

export const assessContinuity = (
  code: string,
  aspect: AspectRatio,
): ThroughlineDrift[] => {
  const thresholdX = CANVAS_WIDTH[aspect] * DRIFT_FRACTION;
  const thresholdY = CANVAS_HEIGHT[aspect] * DRIFT_FRACTION;

  // Match each opening tag that carries data-throughline; capture the slug.
  // `[^>]` can't cross a `>`, so each match is exactly one opening tag (even
  // multi-line). Defined inside the fn so its `g`-flag lastIndex never bleeds
  // across calls.
  const tagRe =
    /<[a-zA-Z][\w.]*\b[^>]*?\bdata-throughline\s*=\s*["']([\w-]+)["'][^>]*>/g;

  const groups = new Map<string, { left: number | null; top: number | null }[]>();
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(code)) !== null) {
    const slug = m[1];
    const tag = m[0];
    const arr = groups.get(slug) || [];
    arr.push({ left: pxAnchor(tag, "left"), top: pxAnchor(tag, "top") });
    groups.set(slug, arr);
  }

  const out: ThroughlineDrift[] = [];
  for (const [slug, positions] of groups) {
    if (positions.length < 2) continue; // used once → nothing to compare
    const lefts = positions.map((p) => p.left).filter((v): v is number => v != null);
    const tops = positions.map((p) => p.top).filter((v): v is number => v != null);
    const driftX = lefts.length >= 2 ? Math.max(...lefts) - Math.min(...lefts) : 0;
    const driftY = tops.length >= 2 ? Math.max(...tops) - Math.min(...tops) : 0;
    const overX = driftX > thresholdX;
    const overY = driftY > thresholdY;
    if (!overX && !overY) continue;
    out.push({
      slug,
      occurrences: positions.length,
      measured: overX ? lefts.length : tops.length,
      driftX: Math.round(driftX),
      driftY: Math.round(driftY),
      axis: overX && overY ? "both" : overX ? "x" : "y",
      positions,
    });
  }
  return out;
};
