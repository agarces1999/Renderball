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

// ─── Eyebrow/kicker duplication (QA B3) ──────────────────────────────
//
// The per-scene editorial eyebrow (e.g. "THE CHALLENGE", "COMIENZA EL DÍA")
// should appear ONCE — as the headline kicker. When the agent ALSO pipes it
// into the BrandChrome category pill, the same tag shows twice in the frame.
// Given each scene's eyebrow text, flag any that appears ≥2 times in the code.
// Case-insensitive substring count, so the dash-prefixed kicker ("— THE
// CHALLENGE") and the bare chrome pill ("THE CHALLENGE") both match. Eyebrows
// are short uppercase tags unlikely to recur in body copy → low false-positive.
export const findDuplicatedEyebrows = (
  code: string,
  eyebrows: string[],
): string[] => {
  const hay = code.toLowerCase();
  const dup: string[] = [];
  for (const raw of eyebrows) {
    const e = (raw ?? "").trim();
    if (e.length < 3) continue; // skip trivial / empty tags
    const needle = e.toLowerCase();
    let count = 0;
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = hay.indexOf(needle, idx + needle.length);
    }
    if (count >= 2 && !dup.includes(e)) dup.push(e);
  }
  return dup;
};

// ─── Generic decorative-filler icons (QA D4, advisory) ───────────────
//
// <Sparkles> / <Sparkle> are the classic "ooh shiny" filler the agent drops
// next to unrelated content (a sparkle on "Structured trousers"). They carry
// almost no literal meaning, so their presence is worth a human glance.
// ADVISORY only — a magic / AI / quality brand may use them intentionally; the
// prompt's "icons must be literal" rule is the real behavioural fix.
export const findDecorativeFillerIcons = (code: string): number =>
  (code.match(/<Sparkles?\b/g) || []).length;

// ─── Display-font fidelity (QA C2) ───────────────────────────────────
//
// When the crawl resolved a REAL brand display font (not a curated fallback),
// the composition's FONT_DISPLAY constant should actually use it. If the agent
// set FONT_DISPLAY to some other family, the video is off-brand at the type
// level. Returns the resolved family when there's a mismatch, else null.
//
// Only fires when displayIsFallback === false — if the crawl had no real brand
// font, any reasonable display face the agent picked is legitimate, not an
// infidelity. Family match is normalized (lowercase, alphanumerics only) so
// `'"Cabinet Grotesk", sans-serif'` correctly contains `Cabinet Grotesk`.
const normFont = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const assessFontFidelity = (
  code: string,
  displayFamily: string | undefined,
  displayIsFallback: boolean,
): string | null => {
  if (displayIsFallback || !displayFamily) return null;
  const m = code.match(/FONT_DISPLAY\s*[:=]\s*([^\n;]+)/);
  if (!m) return null; // no FONT_DISPLAY constant → other gates handle it
  const declared = normFont(m[1]);
  const want = normFont(displayFamily);
  if (!want) return null;
  return declared.includes(want) ? null : displayFamily;
};

// ─── Register variety (QA D3) ────────────────────────────────────────
//
// Each scene carries a `register` (stat | quote | full-bleed | split | list |
// centered) and the script-gen rule is "≥3 distinct across the video" — that's
// what stops every scene looking like the same template. This MEASURES whether
// the generated script actually complied. Returns {distinct,total} when a video
// of ≥3 scenes has fewer than 3 distinct registers, else null. (Registers are a
// script-generator decision, so this surfaces as a warning, not a build retry —
// the build can't reassign them; a script regen can.)
export const assessRegisterVariety = (
  registers: (string | undefined | null)[],
): { distinct: number; total: number } | null => {
  const total = registers.length;
  if (total < 3) return null; // too few scenes to demand variety
  const distinct = new Set(
    registers
      .map((r) => (r ?? "").trim().toLowerCase())
      .filter((r) => r.length > 0),
  ).size;
  return distinct < 3 ? { distinct, total } : null;
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

// ─── #1 Throughline-PRESENCE gate (retry-forcing, polish-tier) ───────
//
// assessContinuity (above) checks an EXISTING recurring tag for positional
// DRIFT. This checks the opposite, more common failure: the throughline is
// never instantiated at all. The script's `narrative.throughline` names the
// connective motif that should thread the scenes into one story; the design
// agent is told to render it as ONE concrete recurring element, carried (and
// evolved) across scenes and tagged `data-throughline="<slug>"`. When the
// agent instead composes every scene independently (the Fuse failure: 0 tags),
// the piece reads as N disconnected facts rather than one story.
//
// This gate fires only when the story HAS a throughline AND there are enough
// scenes for connective tissue to mean anything (≥3), and the dominant tagged
// slug appears in fewer than a majority of them. Returns a retry message
// (folded into the single Design retry) or null when satisfied / N/A.

// Count occurrences of each data-throughline slug across the whole file.
// Fresh regex per call (no shared lastIndex). Tolerant of attribute order.
const countThroughlineSlugs = (code: string): Map<string, number> => {
  const re = /\bdata-throughline\s*=\s*["']([\w-]+)["']/g;
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
};

export interface ThroughlineAbsence {
  throughline: string; // the script's connective motif text
  tagged: number; // occurrences of the dominant data-throughline slug
  scenes: number; // total scene count
  bar: number; // how many scenes the anchor needed to appear in
  message: string; // retry instruction (folded into the single Design retry)
}

export const assessThroughlinePresence = (
  code: string,
  script: { scenes?: unknown[]; narrative?: { throughline?: string } },
): ThroughlineAbsence | null => {
  const throughline = script.narrative?.throughline?.trim();
  const sceneCount = Array.isArray(script.scenes) ? script.scenes.length : 0;
  // Only meaningful when the story HAS a throughline and there are enough
  // scenes for "connective tissue" to read (a 1-2 scene piece can't thread).
  if (!throughline || sceneCount < 3) return null;

  const counts = countThroughlineSlugs(code);
  const dominant = counts.size > 0 ? Math.max(...counts.values()) : 0;

  // The anchor should appear in a MAJORITY of scenes to read as a thread.
  // Bar: ceil(60% of scenes), floor 2. 3→2, 4→3, 5→3, 6→4. Raw occurrence
  // count over-counts a twice-in-one-scene anchor — that bias is toward NOT
  // firing (safe direction; favors false negatives like the drift gate).
  const bar = Math.max(2, Math.ceil(sceneCount * 0.6));
  if (dominant >= bar) return null;

  const message = [
    `Throughline not carried — the story's connective motif is: "${throughline}".`,
    `Your composition instantiates it as a recurring tagged element in only ${dominant} of ${sceneCount} scenes (need ≥${bar}). As-is the scenes read as ${sceneCount} disconnected facts, not one continuous story — the #1 quality complaint.`,
    `Fix: choose ONE concrete visual element that embodies that throughline (translate the idea into something you can actually draw — a shape, an object, a recurring motif), render it in at least ${bar} scenes, and let it EVOLVE along the arc (it transforms / opens / grows / connects scene to scene — it does NOT reset to a fresh thing each cut). Wrap it in \`<div data-throughline="<same-slug>">\` in every scene it appears, using the SAME slug each time, and keep its on-canvas anchor stable (it can grow or gain detail, but it must not hop sides between scenes).`,
  ].join("\n");

  return { throughline, tagged: dominant, scenes: sceneCount, bar, message };
};

// ── Redundant caption (QA V2) ────────────────────────────────────────────────
export interface RedundantCaption {
  scene: number;
  caption: string;
  reason: "echoes-headline" | "lists-shown-assets";
}

const normCaptionText = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/**
 * QA V2: flag a scene `caption` that adds nothing — it merely restates the
 * headline, or lists the names already shown by the scene's logos/images
 * (corgi: a "Artisan · AthenaHQ · Bland · Deel · Slash" caption sitting right
 * under the row of those same customer LOGOS). Duplicate text reads as a layout
 * bug. Operates on the SCRIPT (caption/headline + the alt_texts of the scene's
 * referenced assets), so it's deterministic and code-shape-independent.
 * Conservative — only fires on a clear echo or a majority-name match.
 */
export const findRedundantCaptions = (script: {
  scenes?: Array<{
    content?: { caption?: string; headline?: string; asset_ids?: string[] };
  }>;
  assets?: { images?: Array<{ id?: string; alt_text?: string }> };
}): RedundantCaption[] => {
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const altById = new Map<string, string>();
  for (const img of script.assets?.images ?? []) {
    if (img?.id && img.alt_text) altById.set(img.id, normCaptionText(img.alt_text));
  }

  const out: RedundantCaption[] = [];
  scenes.forEach((sc, i) => {
    const c = sc?.content ?? {};
    const caption = (c.caption ?? "").trim();
    const cap = normCaptionText(caption);
    if (!cap) return;

    // (a) echoes the headline (normalized equality or one containing the other)
    const head = normCaptionText(c.headline ?? "");
    if (
      head &&
      (cap === head ||
        (head.length > 6 && cap.includes(head)) ||
        (cap.length > 6 && head.includes(cap)))
    ) {
      out.push({ scene: i, caption, reason: "echoes-headline" });
      return;
    }

    // (b) lists the names already shown as the scene's logos/images
    const alts = (Array.isArray(c.asset_ids) ? c.asset_ids : [])
      .map((id) => altById.get(id))
      .filter((a): a is string => !!a);
    if (alts.length >= 2) {
      const matched = alts.filter((alt) => cap.includes(alt)).length;
      if (matched >= Math.max(2, Math.ceil(alts.length * 0.6))) {
        out.push({ scene: i, caption, reason: "lists-shown-assets" });
      }
    }
  });
  return out;
};

// ── Sanctioned hero-logo suppression (QA V4) ─────────────────────────────────
/**
 * The duplicate-logo gate counts logo <Img> SITES in the code. The sanctioned
 * "logo-led CTA/opening" pattern legitimately has TWO sites — BrandChrome's mark
 * plus a hero logo — but renders only ONE per frame because that scene passes
 * `showCornerLogo={false}` to suppress the chrome mark. Detect that opt-out so
 * the gate doesn't false-positive (and waste a retry) on the correct pattern.
 */
export const hasCornerLogoSuppression = (code: string): boolean =>
  /\bshowCornerLogo\s*=\s*\{?\s*false\s*\}?/.test(code);

// ── Vertical fill (QA V1) ────────────────────────────────────────────────────
/**
 * QA V1: catch the "empty lower band" failure — a composition whose content all
 * clusters in the top of the frame with nothing anchored to the lower third (the
 * corgi scene-0 case: content stopped at ~53% of height). Deliberately
 * CONSERVATIVE / favors false-negatives (like the drift + throughline gates): it
 * only fires on an unambiguous ABSOLUTE-positioned top-cluster, and bails the
 * moment there's any signal the layout fills vertically — a flex distribution
 * (`space-between`/`flex-end`), a `bottom:` anchor, a tall element, or an element
 * positioned past ~58%. Flex-centered/distributed under-fill is left to the
 * prompt (not reliably detectable from static code without rendered geometry).
 */
export const assessVerticalFill = (
  code: string,
  aspect: AspectRatio,
): string | null => {
  const H = aspect === "9:16" ? 1920 : 1080;
  // Any vertical-distribution or bottom-anchor signal → the lower band is in use.
  // Match BOTH the JS style-object form (`justifyContent: "space-between"`, what
  // the comps actually emit) AND the CSS form (`justify-content: space-between`).
  if (/justify-?content\s*:\s*["']?\s*(space-between|flex-end|space-around|space-evenly)/i.test(code)) return null;
  if (/\bbottom\s*:\s*\d/.test(code)) return null;
  // A tall element (≥45% of H) spans the band on its own.
  const heights = [...code.matchAll(/\bheight:\s*(\d{3,4})\b/g)].map((m) => Number(m[1]));
  if (heights.some((h) => h >= H * 0.45)) return null;
  // Explicit absolute tops (ignore the top:0 full-bleed background layers).
  const tops = [...code.matchAll(/\btop:\s*(\d{2,4})\b/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  if (tops.length < 5) return null; // not enough positioned elements to judge
  const threshold = Math.round(H * 0.58);
  if (Math.max(...tops) >= threshold) return null; // something reaches the lower band
  const lowerPin = Math.round(H * 0.7);
  return (
    `Empty lower band — every positioned element starts in the top ${Math.round((threshold / H) * 100)}% ` +
    `of the ${H}px-tall canvas (lowest top is ${Math.max(...tops)}px) with nothing anchored to the lower third. ` +
    `Distribute the composition top-to-bottom: pin a real footer row (CTA, meta key-values, a chart axis, a ` +
    `caption cluster) to ~${lowerPin}-${Math.round(H * 0.83)}px, or scale the hero so content spans the frame. ` +
    `A thin progress bar at the very bottom edge does NOT count as filling the lower third.`
  );
};
