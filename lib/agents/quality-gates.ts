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

// ─── Brand-mark (logo glyph) count per hero mock (v11) ──────────────
//
// Dogfood cycle 2 s4 shipped a TRIPLE brand mark — chrome corner logo +
// a boxed wordmark in the hero's nav mock + a stray brand-initial glyph —
// and findDuplicateLogos passed it because the extra marks were DRAWN
// (text wordmarks/glyphs), not <Img> logo mounts. This counts every brand
// mark inside ONE element fragment (a hero body):
//   - <Img> logo mounts (the findDuplicateLogos pattern),
//   - JSX text nodes EXACTLY equal to the brand name (a drawn wordmark),
//   - single-character text nodes equal to the brand initial (a glyph
//     stand-in — "G" for Glossier).
// Exact-node matching keeps diegetic mentions (the brand name inside a URL
// bar or a longer label) out of the count. Chrome carries the sanctioned
// corner mark on every scene, so a hero carrying >1 of its own is overuse.
export const countBrandMarks = (fragment: string, brandName: string): number => {
  const word = (brandName ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}&-]/gu, "") ?? "";
  if (word.length < 2) return findDuplicateLogos(fragment);
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let count = findDuplicateLogos(fragment);
  count += (fragment.match(new RegExp(`>\\s*${esc}\\s*<`, "gi")) || []).length;
  const initial = word[0].toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  count += (fragment.match(new RegExp(`>\\s*${initial}\\s*<`, "g")) || []).length;
  return count;
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
  // across calls. Accepts BOTH attr forms the agents actually emit: the quoted
  // literal (data-throughline="slug") and the JSX expression referencing a
  // module const or template (data-throughline={THROUGHLINE_SLUG} /
  // ={`slug`}) — the parallel fills use the const form, which the old
  // literal-only regex silently missed (validation 2026-07-09: 4/4 scenes
  // tagged, counter reported 0).
  const tagRe =
    /<[a-zA-Z][\w.]*\b[^>]*?\bdata-throughline\s*=\s*(?:["']([\w-]+)["']|\{\s*(?:["'`]([\w-]+)["'`]|([A-Za-z_$][\w$]*))\s*\})[^>]*>/g;

  const groups = new Map<string, { left: number | null; top: number | null }[]>();
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(code)) !== null) {
    const slug = m[1] ?? m[2] ?? m[3]; // quoted attr | quoted-in-braces | const identifier
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

// ─── Deterministic throughline-DRIFT repair (no LLM) ─────────────────
//
// A drifted throughline is a pure reposition defect: the SAME motif element is
// tagged in ≥2 scenes but its px anchor jumped. The old fix re-emitted the
// WHOLE 5-scene composition (~260k tokens, ~12-15 min) — absurd for "one
// element is at the wrong x,y". This snaps every drifted occurrence to a single
// consistent anchor (the MEDIAN of the tag's own px positions, so outliers move
// toward where the majority already sit — minimal disruption) with a pure
// string edit. Zero tokens, milliseconds.
//
// Only tags that assessContinuity could MEASURE (inline `left`/`top` px on the
// tag itself) are moved — which is exactly the set that produces a drift
// finding, so coverage is total for the cases this repairs. Caller re-runs the
// structural/overflow gates and adopts only if not-worse (a move that pushes an
// element off-canvas or into a collision is discarded, falling back to the LLM
// retry). Returns the edited code + how many tags moved (0 ⇒ nothing to do).
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** Replace the first inline `left:`/`top:` numeric value in a single opening
 *  tag. Handles all forms the agents emit: `left: 120`, `left: 120px`,
 *  `left: "740px"` (the `px`/unit and quote are preserved). */
const setAnchor = (tag: string, prop: "left" | "top", value: number): string =>
  tag.replace(
    new RegExp("(\\b" + prop + ":\\s*[\"'`]?)(\\d+)(px)?", ""),
    `$1${value}$3`,
  );

export const repositionThroughline = (
  code: string,
  aspect: AspectRatio,
): { code: string; moved: number } => {
  const drifts = assessContinuity(code, aspect);
  if (drifts.length === 0) return { code, moved: 0 };

  // Per drifted slug, the target = median of its measured px positions.
  const target = new Map<string, { left: number | null; top: number | null }>();
  for (const d of drifts) {
    const lefts = d.positions.map((p) => p.left).filter((v): v is number => v != null);
    const tops = d.positions.map((p) => p.top).filter((v): v is number => v != null);
    target.set(d.slug, {
      left: lefts.length >= 2 ? median(lefts) : null,
      top: tops.length >= 2 ? median(tops) : null,
    });
  }

  // Same tag matcher assessContinuity uses. Rewrite each drifted slug's tags to
  // the slug's target anchor (only the axis with a target moves).
  const tagRe =
    /<[a-zA-Z][\w.]*\b[^>]*?\bdata-throughline\s*=\s*(?:["']([\w-]+)["']|\{\s*(?:["'`]([\w-]+)["'`]|([A-Za-z_$][\w$]*))\s*\})[^>]*>/g;
  let moved = 0;
  const out = code.replace(tagRe, (fullTag, q, tpl, ident) => {
    const slug = q ?? tpl ?? ident;
    const t = target.get(slug);
    if (!t) return fullTag; // this slug didn't drift
    let tag = fullTag;
    let changed = false;
    if (t.left != null && pxAnchor(fullTag, "left") != null && pxAnchor(fullTag, "left") !== t.left) {
      tag = setAnchor(tag, "left", t.left);
      changed = true;
    }
    if (t.top != null && pxAnchor(fullTag, "top") != null && pxAnchor(fullTag, "top") !== t.top) {
      tag = setAnchor(tag, "top", t.top);
      changed = true;
    }
    if (changed) moved++;
    return tag;
  });
  return { code: out, moved };
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
  // Both attr forms count: the quoted literal (data-throughline="slug") AND
  // the JSX expression referencing a module const or template literal
  // (data-throughline={THROUGHLINE_SLUG} / ={`slug`}). The parallel fills emit
  // the const form; the old literal-only regex reported tagged:0 on a build
  // whose every real scene carried the motif (validation 2026-07-09).
  const re =
    /\bdata-throughline\s*=\s*(?:["']([\w-]+)["']|\{\s*(?:["'`]([\w-]+)["'`]|([A-Za-z_$][\w$]*))\s*\})/g;
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const slug = m[1] ?? m[2] ?? m[3];
    counts.set(slug, (counts.get(slug) || 0) + 1);
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

// ─── Undefined JSX components (guaranteed render crash, A1) ──────────
//
// React's "Element type is invalid": a capitalized JSX tag whose identifier
// resolves to NEITHER a local definition NOR an import is `undefined` at
// runtime — the render white-screens. It compiles clean (esbuild doesn't
// resolve bindings), so only a binding-level scan catches it. The known
// instance class is hallucinated lucide brand icons (alias-repaired
// deterministically below), but the agent can just as easily render a
// component it never wrote (<HeroPanel /> with no `const HeroPanel`) — for
// which NO deterministic repair exists (we can't invent the component). This
// detector is the generic guard: the pipeline wires it as a structural gate,
// and whatever survives the retries lands in warnings.structural_unresolved
// with the SSR render gate as the last backstop.
//
// Favors false NEGATIVES hard (module philosophy — a false positive burns an
// Opus retry on a healthy file):
//   • strings + comments are blanked before scanning (a "<Foo>" in a label
//     or comment is not a render site),
//   • JSX member tags (<Foo.Bar>) are skipped entirely,
//   • generics never match: the char before `<` must not be an identifier
//     char (Array<Foo>, React.FC<Props>), the tag name must be followed by
//     whitespace / `/` / `>` (so `<T,` drops out), and `<T extends …>` is
//     explicitly skipped,
//   • type-only declarations (interface/type) count as definitions, so a
//     spaced type argument (`React.FC <Props>`) can't flag,
//   • any brace-block entry shaped like a binding counts as defined — this
//     resolves destructures in BOTH declarations (`const { Logo } = pack`)
//     and arrow params (`items.map(({ icon: Icon }) => <Icon/>)`), at the
//     cost of also swallowing object-LITERAL value refs (false-negative
//     direction only),
//   • runtime globals that legitimately follow a `<` comparison (Infinity,
//     Math, …) are allowlisted, and single-letter tags (generic-parameter
//     territory: `: <T>(t: T) => T`) are ignored.

/** Runtime globals a capitalized identifier after `<` may legitimately be. */
const JS_RUNTIME_GLOBALS = new Set([
  "Array", "BigInt", "Boolean", "Buffer", "Date", "Error", "Infinity", "Intl",
  "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "RangeError",
  "RegExp", "Set", "String", "Symbol", "TypeError", "URL", "URLSearchParams",
  "WeakMap", "WeakSet",
]);

/**
 * Blank string literals and comments (preserving length and the delimiter
 * chars) so the JSX / declaration scans never match inside copy text, CSS
 * template blocks, or commentary. A tiny state machine — regexes can't pair
 * quotes reliably (one apostrophe in a comment would swallow real code).
 * Known coarse spots, all biased toward false negatives: template-literal
 * `${}` interpolations are blanked with the string; an apostrophe in JSX text
 * blanks the rest of that line; regex literals aren't modeled (generated
 * compositions are static JSX + style objects and don't carry them).
 */
const blankStringsAndComments = (code: string): string => {
  const out = code.split("");
  type Mode = "code" | "sq" | "dq" | "tpl" | "line" | "block";
  let mode: Mode = "code";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (mode === "code") {
      if (ch === "'") mode = "sq";
      else if (ch === '"') mode = "dq";
      else if (ch === "`") mode = "tpl";
      else if (ch === "/" && next === "/") { mode = "line"; out[i] = " "; }
      else if (ch === "/" && next === "*") { mode = "block"; out[i] = " "; }
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") mode = "code";
      else out[i] = " ";
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") { out[i] = " "; out[i + 1] = " "; mode = "code"; i++; }
      else if (ch !== "\n") out[i] = " ";
      continue;
    }
    // String modes: keep the delimiters, blank the contents. A backslash
    // escapes the next char. Unterminated ' / " close at the newline
    // (defensive — generated code keeps them single-line).
    if (ch === "\\") {
      out[i] = " ";
      if (i + 1 < code.length) { out[i + 1] = " "; i++; }
      continue;
    }
    if (
      (mode === "sq" && ch === "'") ||
      (mode === "dq" && ch === '"') ||
      (mode === "tpl" && ch === "`")
    ) { mode = "code"; continue; }
    if ((mode === "sq" || mode === "dq") && ch === "\n") { mode = "code"; continue; }
    if (ch !== "\n") out[i] = " ";
  }
  return out.join("");
};

/**
 * Every capitalized JSX tag that resolves to neither a local definition nor
 * an imported name — each one is a guaranteed "Element type is invalid"
 * render crash. See the section comment above for the false-positive guards.
 */
export const findUndefinedJsxComponents = (code: string): string[] => {
  const src = blankStringsAndComments(code);
  const defined = new Set<string>();

  // 1) Imported bindings — every clause shape, multi-line included: default
  //    (`import React`), namespace (`* as Icons`), named (`{ A, B as C }`),
  //    mixed (`React, { useState }`), and `import type` (a type binding
  //    rendered as JSX is its own compile error; counting it only suppresses).
  const importRe = /\bimport\s+([^"']+?)\s*from\s*["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(src)) !== null) {
    const clause = im[1].replace(/^\s*type\s+/, "");
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const raw of named[1].split(",")) {
        const spec = raw.trim().replace(/^type\s+/, "");
        if (!spec) continue;
        const parts = spec.split(/\s+as\s+/);
        const local = (parts[1] ?? parts[0]).trim();
        if (local) defined.add(local);
      }
    }
    const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (ns) defined.add(ns[1]);
    const dflt = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (dflt) defined.add(dflt[1]);
  }

  // 2) Local declarations that create runtime bindings. Only capitalized
  //    names matter (JSX requires one). `const X = styled/forwardRef/memo(…)`
  //    all land here — the declared NAME is what counts, the RHS is
  //    irrelevant. interface/type/enum are included so a spaced type argument
  //    can never flag (false-negative direction).
  const declRe =
    /\b(?:const|let|var|function|class|enum|interface|type)\s+([A-Z][\w$]*)/g;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(src)) !== null) defined.add(dm[1]);

  // 3) Binding-shaped brace entries (`Name`, `key: Name`, `Name = default`) —
  //    catches const- AND param-destructures in one rule; also swallows
  //    object-literal value refs, which only ever causes false negatives.
  const braceRe = /\{([^{}]*)\}/g;
  let br: RegExpExecArray | null;
  while ((br = braceRe.exec(src)) !== null) {
    for (const raw of br[1].split(",")) {
      const entry = raw.trim();
      const renamed = entry.match(/^[\w$]+\s*:\s*([A-Z][\w$]*)$/);
      const shorthand = entry.match(/^([A-Z][\w$]*)(?:\s*=[^=].*)?$/);
      const hit = renamed ?? shorthand;
      if (hit) defined.add(hit[1]);
    }
  }

  // 4) Plain parameter-ish positions: a capitalized identifier right after
  //    `(`, `[` or `,` and right before `,` / `)` / `:` / `]` / `=` (not
  //    `==`). Catches the common `icons.map((Icon, i) => <Icon/>)` binding;
  //    also swallows call arguments and array members, which again only ever
  //    causes false negatives.
  const paramRe = /[[(,]\s*([A-Z][\w$]*)\s*(?=[,)\]:]|=(?!=))/g;
  let pr: RegExpExecArray | null;
  while ((pr = paramRe.exec(src)) !== null) defined.add(pr[1]);

  // 5) JSX scan: opening tags only (a closing tag implies an opening one).
  const out: string[] = [];
  const tagRe = /<([A-Z][\w$]*)(?=[\s/>])/g;
  let tg: RegExpExecArray | null;
  while ((tg = tagRe.exec(src)) !== null) {
    const name = tg[1];
    if (name.length < 2) continue; // single letters = generic-param territory
    // Identifier / member / closing-quote char before `<` = a type argument
    // or comparison (Array<Foo>, React.FC<Props>, "a" < B) — never a render
    // site. `>` and `(` and `{` etc. all stay legal JSX predecessors.
    const before = tg.index > 0 ? src[tg.index - 1] : " ";
    if (/[\w$.<"'\])]/.test(before)) continue;
    // `<T extends …>` — a .tsx arrow-function generic, not a tag.
    if (/^\s+extends\b/.test(src.slice(tg.index + 1 + name.length))) continue;
    if (defined.has(name) || JS_RUNTIME_GLOBALS.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
};

/**
 * Deterministic FIX for the subset of "undefined JSX components" that are real
 * lucide-react icons the agent USED but forgot to IMPORT — e.g. `<BadgeCheck/>`
 * rendered with no matching import ("BadgeCheck is not defined" → white screen at
 * render; this cost Coinbase a whole 98-min build, the same class as Figma's
 * earlier ORBIT_CURSORS but RECOVERABLE). Unlike an invented identifier or a
 * brand logo (which lucide doesn't have), a valid lucide icon has a mechanical
 * fix: splice it into the lucide-react import. `isLucideIcon` is INJECTED so the
 * splice logic is unit-testable without loading the 5,800-icon module; names that
 * aren't valid lucide icons are left untouched (the render gate + agent repair
 * stay the backstop for genuinely-invented components).
 */
export const addMissingLucideImports = (
  code: string,
  isLucideIcon: (name: string) => boolean,
): { code: string; added: string[] } => {
  const toAdd = Array.from(
    new Set(findUndefinedJsxComponents(code).filter(isLucideIcon)),
  );
  if (toAdd.length === 0) return { code, added: [] };
  const m = code.match(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/);
  if (m) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const merged = Array.from(new Set([...names, ...toAdd])).join(", ");
    return {
      code: code.replace(m[0], `import { ${merged} } from "lucide-react"`),
      added: toAdd,
    };
  }
  // No lucide import yet — insert one immediately after the first import line.
  const first = /^[ \t]*import\b.*$/m.exec(code);
  const line = `import { ${toAdd.join(", ")} } from "lucide-react";`;
  if (first) {
    const at = first.index + first[0].length;
    return { code: code.slice(0, at) + "\n" + line + code.slice(at), added: toAdd };
  }
  return { code: `${line}\n${code}`, added: toAdd };
};

/**
 * Render-safe net for genuinely-invented or mis-scoped CUSTOM components — the
 * backstop the render gate + agent repair are supposed to provide but sometimes
 * miss (a hallucinated `<Thumb>` that's never defined, or a `<DesignCard>` defined
 * inside one Section's body and referenced from another where it isn't in scope).
 * Left unfixed they throw at SSR and hard-fail the WHOLE build. This injects a
 * module-scope stub that renders nothing, so the build ships with that one element
 * dropped instead of crashing — the structural gate still surfaces the name for QA.
 * lucide names are handled by addMissingLucideImports and excluded here. Where a
 * component IS defined locally, that local shadows this module stub in its own
 * scope, so it still renders correctly there; the stub only covers the scopes that
 * lacked it.
 */
export const stubUndefinedComponents = (
  code: string,
  isLucideIcon: (name: string) => boolean,
): { code: string; stubbed: string[] } => {
  const undef = Array.from(
    new Set(findUndefinedJsxComponents(code).filter((n) => !isLucideIcon(n))),
  );
  if (undef.length === 0) return { code, stubbed: [] };
  const stubs =
    "\n\n/* auto-stubbed: undefined components render null so SSR can't hard-fail */\n" +
    undef.map((n) => `const ${n}: React.FC<any> = () => null;`).join("\n");
  // Insert after the LAST import STATEMENT. Multi-line aware — a line-based match
  // would land the stub in the MIDDLE of a multi-line `import { … } from "…"` and
  // break it (the real compositions have multi-line lucide imports).
  const importStmtRe = /import\b[\s\S]*?from\s*["'][^"']+["']\s*;?/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = importStmtRe.exec(code)) !== null) last = m;
  if (last) {
    const at = last.index + last[0].length;
    return { code: code.slice(0, at) + stubs + code.slice(at), stubbed: undef };
  }
  return { code: stubs.trimStart() + "\n" + code, stubbed: undef };
};

// ─── Drawn-logo stand-in (the Supabase replica loophole, A1) ─────────
//
// When a REAL brand logo resolved, the sanctioned ways to render it are the
// injected LOGO_SRC const (<Img src={LOGO_SRC}>) or the short URL inlined
// verbatim. The loophole this closes: the agent rendered NEITHER and instead
// HAND-DREW a replica of the mark as a local SVG component — Supabase's
// two-arrow mark redrawn from memory as `<LogoMark>` with eyeballed paths
// and an approximated green, rendered 6× with an empty warnings.json. On
// screen it reads as the brand's logo but it is a fabrication; subtle
// path/color drift is exactly the broken-looking tier the structural gates
// exist for.
//
// Detector: a locally DEFINED component whose name says "I am the logo",
// whose body draws an inline <svg> (and mounts no <Img> — an
// <Img src={LOGO_SRC}> wrapper named LogoMark is the sanctioned pattern, not
// a stand-in), and which is actually RENDERED as a JSX tag. The pipeline
// only consults this when a real logo exists, so a wordmark-text component
// on a no-logo brand can never false-positive here.
const LOGO_STANDIN_NAME_RX = /logo|mark|wordmark|brandbolt/i;

export const findDrawnLogoStandIns = (code: string): string[] => {
  const out: string[] = [];
  const declRe = /\b(?:const|function|class)\s+([A-Z][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(code)) !== null) {
    const name = m[1];
    if (!LOGO_STANDIN_NAME_RX.test(name) || out.includes(name)) continue;
    // Body slice: from this declaration to the next top-level declaration
    // (optionally export-prefixed, at line start) or EOF. Crude but bounded —
    // the same slicing approach as the pipeline's per-section dead-air scan.
    const rest = code.slice(m.index + m[0].length);
    const end = rest.search(/\n(?:export\s+)?(?:const|function|class)\s+[A-Z$_]/);
    const body = end === -1 ? rest : rest.slice(0, end);
    if (!/<svg\b/i.test(body) || /<Img\b/.test(body)) continue; // not a DRAWN mark
    // Must actually be rendered somewhere to count as a stand-in on screen.
    if (new RegExp(`<${name}\\b`).test(code)) out.push(name);
  }
  return out;
};

/**
 * Detect redefinitions of PROVIDED scaffold components. BrandChrome ships as a
 * fixed file in every genDir (lib/render/build-wrapper.ts) precisely so the
 * agent can't mis-author the brand-mark choreography — the historical #1 retry
 * driver (duplicate logos, drawn stand-ins). An emitted `const BrandChrome =`
 * either shadows the provided one (import absent → all the old failure modes
 * return) or collides with the import (compile error). Both are structural.
 * Returns the redefined names found.
 */
export const findProvidedComponentRedefinitions = (
  code: string,
  provided: string[] = ["BrandChrome"],
): string[] =>
  provided.filter((name) =>
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(code),
  );

// ─── Scene-review taste gates (2026-06 scene-by-scene review) ────────
//
// Three deterministic detectors distilled from a scene-by-scene review of 3
// real builds (6+ instances each). All POLISH-tier: the pipeline folds them
// into the shared design/animation retry, never a structural block. Same
// module philosophy as everything above — favor false negatives hard; a
// false positive burns an Opus retry on healthy output.

/**
 * Minimal scene-timing shape for mapping Section{N} → scene duration.
 * Structural subset of the full schema Scene (start/end seconds required
 * there, optional here) so the module stays dependency-free. `content` is
 * the scene's copy manifest, typed `unknown` (narrowed at use) so the full
 * schema Scene assigns without coupling this module to its field list — the
 * dwell gate reads it to resolve expression-bound text ({c.lede}).
 */
export interface SceneTiming {
  start_seconds?: number;
  end_seconds?: number;
  start_frame?: number;
  end_frame?: number;
  content?: unknown;
}

/** Scene duration in seconds — mirrors pipeline's sceneDurationSeconds. */
const sceneSeconds = (s: SceneTiming): number => {
  if (typeof s.start_seconds === "number" && typeof s.end_seconds === "number") {
    return s.end_seconds - s.start_seconds;
  }
  if (typeof s.start_frame === "number" && typeof s.end_frame === "number") {
    return (s.end_frame - s.start_frame) / 30;
  }
  return 0;
};

/**
 * Slice Section{i}'s code: from the first `Section{i}` token to the next
 * `Section{i+1}` token (or EOF). The same crude-but-bounded approach as the
 * pipeline's per-section dead-air scan; `Section1\b` cannot eat `Section10`.
 */
const sectionSlice = (code: string, i: number): string | null => {
  const re = new RegExp(
    `(?:Section|Scene|Slide)${i}\\b[\\s\\S]*?(?=(?:Section|Scene|Slide)${i + 1}\\b|registerRoot|$)`,
    "i",
  );
  const m = code.match(re);
  return m ? m[0] : null;
};

/**
 * Mono captions / eyebrow chrome are EXEMPT from the body-text rules: wide
 * letter-spacing (≥0.12em), an uppercase transform, or a mono fontFamily all
 * mark deliberate small caption/meta type — chrome, not body copy. Used by
 * the size-floor and dwell detectors below; favors false negatives (any one
 * signal exempts the element).
 */
const isCaptionChrome = (styleBlock: string): boolean => {
  const ls = styleBlock.match(/letterSpacing:\s*["'`]?(-?[\d.]+)\s*em/);
  if (ls && parseFloat(ls[1]) >= 0.12) return true;
  if (/textTransform:\s*["'`]uppercase/i.test(styleBlock)) return true;
  // FONT_MONO constant, or any family whose FIRST stack entry says "mono"
  // ('"Geist Mono", monospace'). [^,}]* crosses the nested quote, stops at
  // the stack comma / object boundary.
  if (/fontFamily:\s*(?:FONT_MONO\b|["'`][^,}]*mono)/i.test(styleBlock)) return true;
  return false;
};

// ── #1 Text-size floors (scene review, polish) ───────────────────────
//
// Ledes / body <p> were repeatedly unreadable in rendered output (6+
// instances). Floors on a 1080p-height canvas: <p> ≥ 24px, <li> ≥ 18px.
// Mobile canvases have HIGHER prompt floors (28/36px) so the same floors
// stay conservative there too. Only fires on an INLINE numeric fontSize on
// the <p>/<li> itself — inherited/clamp()/var() sizes are skipped, and
// caption/meta chrome (see isCaptionChrome) is exempt. Favors false
// negatives.

export const TEXT_FLOOR_P = 24;
export const TEXT_FLOOR_LI = 18;

export interface UndersizedText {
  tag: "p" | "li";
  fontSize: number;
  floor: number;
}

export const findUndersizedText = (code: string): UndersizedText[] => {
  const out: UndersizedText[] = [];
  // Opening <p|li> tags carrying an inline style object. `[^>]*?` keeps the
  // match inside one tag; the style body allows one brace-nesting level
  // (template-literal ${} values) like assessContrast's scanner.
  const re =
    /<(p|li)\b[^>]*?style=\{\{([^{}]*?(?:\{[^{}]*\}[^{}]*?)*)\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const tag = m[1].toLowerCase() as "p" | "li";
    const block = m[2];
    const fs = block.match(/\bfontSize:\s*["'`]?(\d+(?:\.\d+)?)(?:px)?["'`]?/);
    if (!fs) continue; // no inline numeric size → inherited/unknown → skip
    const size = parseFloat(fs[1]);
    const floor = tag === "p" ? TEXT_FLOOR_P : TEXT_FLOOR_LI;
    if (size >= floor) continue;
    if (isCaptionChrome(block)) continue; // mono caption / chrome — exempt
    out.push({ tag, fontSize: size, floor });
  }
  return out;
};

// ── #2 Late-beat dwell (scene review, polish) ────────────────────────
//
// The dead-air rule pushes beats LATE, but nothing guaranteed reading time
// AFTER landing — a headline landed in the final 15% of a scene. For each
// text element with a finite entrance (delay D, duration d), flag when
// D + d + readTime > sceneDuration, with readTime ≈ max(1.2s, words×0.3s).
// Sections map to scenes by Section{N} index. Coarse + conservative: short
// scenes (<3s, matching the dead-air gate), infinite/atmosphere animations,
// caption chrome, and unanimated text are all skipped.
//
// Word counts come from the element's LITERAL children plus any
// expression-bound copy ({c.lede} / {script.scenes[N].content.lede})
// resolved against the script's scene content — see boundWordCount. An
// expression that doesn't resolve contributes 0 words, so readTime falls
// back to the 1.2s floor (false-negative direction).

export interface UndwelledText {
  section: number;
  tag: string;
  delay: number; // seconds
  duration: number; // seconds
  readTime: number; // seconds (max(1.2, words*0.3))
  landsAt: number; // delay + duration
  sceneDuration: number;
}

/** Tokens carrying a word character — "—" or "·" separators don't count. */
const stringWordCount = (s: string): number =>
  s.split(/\s+/).filter((w) => /\w/.test(w)).length;

/** Literal word count of an element's children (tags + JSX exprs stripped). */
const literalWordCount = (inner: string): number =>
  stringWordCount(inner.replace(/<[^>]*>/g, " ").replace(/\{[^{}]*\}/g, " "));

// Word count of expression-BOUND children — the blind spot that passed the
// archived Opus Tailscale build: every section binds copy via
// `const c = script.scenes[N].content` and renders `{c.lede}`, so the
// literal count was 0, readTime collapsed to the 1.2s floor, and three
// provably-late ledes (13-14 words landing ~4s into 5.5-6s scenes) shipped
// unflagged. Resolve those bindings against the script the gate already
// receives. The alias name AND scene index come from the section's own
// source (never assume `c`, never assume the section's loop index); the
// direct `script.scenes[N].content.X` form needs no alias. Anything that
// doesn't resolve to a string contributes 0 (false-negative direction).
const boundWordCount = (
  inner: string,
  sectionSrc: string,
  scenes: SceneTiming[],
): number => {
  const contentField = (n: number, key: string): unknown => {
    const c = scenes[n]?.content;
    return c && typeof c === "object"
      ? (c as Record<string, unknown>)[key]
      : undefined;
  };
  let words = 0;
  const exprRe = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = exprRe.exec(inner)) !== null) {
    const expr = m[1].trim();
    const direct = expr.match(
      /^script\.scenes\[(\d+)\](?:\?\.|\.)content(?:\?\.|\.)([A-Za-z_$][\w$]*)$/,
    );
    if (direct) {
      const v = contentField(parseInt(direct[1], 10), direct[2]);
      if (typeof v === "string") words += stringWordCount(v);
      continue;
    }
    const member = expr.match(/^([A-Za-z_$][\w$]*)(?:\?\.|\.)([A-Za-z_$][\w$]*)$/);
    if (!member) continue;
    // `$` is the only identifier char that's a regex metachar.
    const alias = member[1].replace(/\$/g, "\\$");
    const decl = sectionSrc.match(
      new RegExp(
        `\\b(?:const|let|var)\\s+${alias}\\s*=\\s*script\\.scenes\\[(\\d+)\\](?:\\?\\.|\\.)content\\b`,
      ),
    );
    if (!decl) continue;
    const v = contentField(parseInt(decl[1], 10), member[2]);
    if (typeof v === "string") words += stringWordCount(v);
  }
  return words;
};

/** A late-beat finding is only actionable when re-timing has real headroom.
 *  When the reading budget alone consumes more than this fraction of the
 *  scene, no meaningful earlier landing exists (the element is already at or
 *  near the floor) — that is a COPY-LENGTH condition owned by the script
 *  agent's lede caps, not a choreography defect the animation retry can fix. */
export const MAX_READ_FRACTION = 0.85;

export const findUndwelledText = (
  code: string,
  script: { scenes?: SceneTiming[] },
): UndwelledText[] => {
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const out: UndwelledText[] = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const T = sceneSeconds(scenes[i]);
    if (!T || T < 3) continue; // very short scenes — skip (matches dead-air)
    const section = sectionSlice(code, i);
    if (!section) continue;
    // Text elements with children (need the literal text for read time).
    const elRe = /<(h1|h2|h3|p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = elRe.exec(section)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = m[2];
      const inner = m[3];
      const anim = attrs.match(/animation:\s*["'`]([^"'`]+)/);
      if (!anim) continue; // unanimated text is visible from t=0 — fine
      // The entrance is the first comma-chained declaration. Blank paren
      // groups first so cubic-bezier(.2,.8,.2,1) / steps(20, end) commas
      // can't split a declaration mid-easing (they carry no `s` tokens).
      const firstDecl = anim[1].replace(/\([^)]*\)/g, "()").split(",")[0];
      // animation-fill-mode `forwards` OR `both`: both RETAIN the end state
      // after the run, so a `both` entrance dwells exactly like a `forwards`
      // one. The model emits `both` far more often than `forwards`, so
      // matching only `forwards` silently skipped most real text entrances.
      const fillMode = firstDecl.match(/\b(?:forwards|both)\b/);
      if (!fillMode) continue;
      const beforeFill = firstDecl.slice(0, fillMode.index);
      const times = [...beforeFill.matchAll(/(\d+(?:\.\d+)?)s\b/g)].map(
        (t) => parseFloat(t[1]),
      );
      if (times.length === 0) continue;
      // CSS shorthand: first time = duration; with ≥2 times the LAST one
      // before the fill-mode keyword is the delay (same parse as dead-air).
      const duration = times[0];
      const delay = times.length >= 2 ? times[times.length - 1] : 0;
      if (isCaptionChrome(attrs)) continue; // mono caption / chrome — exempt
      const words = literalWordCount(inner) + boundWordCount(inner, section, scenes);
      const readTime = Math.max(1.2, words * 0.3);
      const landsAt = delay + duration;
      if (landsAt + readTime <= T) continue;
      // Only a fixable-by-timing miss is a LATE-BEAT problem. When the reading
      // budget alone eats >85% of the scene (a 25-word lede in a 5s scene:
      // readTime 7.5s), "move this beat earlier" is unactionable — the
      // Duolingo FP rebuild fired on ledes already landing at 0.5s and would
      // have burned retries for nothing. Long copy is the script agent's
      // lede-length territory, not choreography's.
      if (readTime > T * MAX_READ_FRACTION) continue;
      out.push({
        section: i,
        tag,
        delay,
        duration,
        readTime: Math.round(readTime * 10) / 10,
        landsAt: Math.round(landsAt * 100) / 100,
        sceneDuration: T,
      });
    }
  }
  return out;
};

// ── #3 Accent-as-decoration (scene review, polish) ───────────────────
//
// The signature color outlining MANY containers (6 identical accent-bordered
// cards) instead of marking THE focal element. Count distinct elements (one
// inline style block = one element) per Section{N} whose border/borderColor
// uses the signature hex — directly, via a module-scope const bound to it, or
// via an object entry (PALETTE.accent). Flag a section only when the count
// EXCEEDS the cap (>4). Conservative: class-rule borders in <style> strings
// and box-shadow rings are invisible to it (false-negative direction).

export const ACCENT_BORDER_MAX_PER_SECTION = 4;

export interface AccentBorderOveruse {
  section: number;
  count: number;
}

export const countAccentBorders = (
  code: string,
  signature: string | null | undefined,
  maxPerSection = ACCENT_BORDER_MAX_PER_SECTION,
): AccentBorderOveruse[] => {
  const sig = (signature ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{3,8}$/.test(sig)) return []; // no/invalid signature → N/A
  // Tokens that mean "the signature color" in this file: the hex itself,
  // any module-scope const bound to it, and object entries (PALETTE.accent).
  const tokens: string[] = [sig];
  const constRe = new RegExp(
    `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*["'\`]${sig}["'\`]`,
    "gi",
  );
  let cm: RegExpExecArray | null;
  while ((cm = constRe.exec(code)) !== null) tokens.push(cm[1]);
  const objRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*)\}/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(code)) !== null) {
    const entryRe = new RegExp(
      `([A-Za-z_$][\\w$]*)\\s*:\\s*["'\`]${sig}["'\`]`,
      "gi",
    );
    let em: RegExpExecArray | null;
    while ((em = entryRe.exec(om[2])) !== null) {
      tokens.push(`${om[1]}.${em[1]}`);
    }
  }
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // A border declaration whose value references a signature token. The value
  // scan stops at `,`/`;`/`}` so it stays inside one declaration; `(?![\w$])`
  // keeps BRAND_ACCENT from matching BRAND_ACCENT_SOFT.
  const borderValRe = new RegExp(
    `\\bborder(?:Top|Right|Bottom|Left)?(?:Color)?\\s*:\\s*[^,;}]*(?:${escaped.join("|")})(?![\\w$])`,
    "i",
  );

  // Derive the section indices present in the code (no script needed).
  const indices = new Set<number>();
  const idxRe = /\bSection(\d+)\b/g;
  let sm: RegExpExecArray | null;
  while ((sm = idxRe.exec(code)) !== null) indices.add(parseInt(sm[1], 10));

  const out: AccentBorderOveruse[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const slice = sectionSlice(code, i);
    if (!slice) continue;
    let count = 0;
    // One inline style block = one element (allows one brace-nesting level
    // for template-literal ${TOKEN} values, like assessContrast).
    const styleRe = /style=\{\{([^{}]*?(?:\{[^{}]*\}[^{}]*?)*)\}\}/g;
    let sb: RegExpExecArray | null;
    while ((sb = styleRe.exec(slice)) !== null) {
      if (borderValRe.test(sb[1])) count += 1;
    }
    if (count > maxPerSection) out.push({ section: i, count });
  }
  return out;
};

// ─── Copy-binding contract (baked-in script copy, A/B review) ────────
//
// The design prompt mandates rendering the script's content fields via
// bindings (`const c = script.scenes[N].content` → `{c.headline}`), never
// retyped as literal JSX. Baked copy silently decouples the video from the
// script: a per-scene regen or script edit rewrites the JSON but the pixels
// keep the stale text (the Fable A/B build baked every field, including a
// two-tone "30," + "000" headline split). Per scene, per content field, this
// flags fields whose text VALUE provably appears as literal text in that
// scene's Section{N} source.
//
// Matching runs against a LITERAL-TEXT VIEW of the section: comments are
// stripped first (the compliant Opus build quotes copy in a comment — a
// raw substring scan false-positives on it), then `{…}` expressions and
// `<…>` tags are dropped, keeping only JSX text children and string-literal
// attribute values. Bound expressions can therefore never match. The view is
// then FUSED (whitespace removed, lowercased) so split treatments
// ("30,"+"000" across spans; "Zero-config <em>mesh network</em>") and
// re-cased literals (uppercase render of a lowercase eyebrow) still match.
//
// Favors false negatives (module philosophy): a field that appears NEITHER
// bound nor literal is not flagged (dropped/transformed copy is out of
// scope); fields shorter than 4 chars are skipped (a "Go" CTA matches
// everywhere); between-tag runs containing code-ish characters are discarded
// rather than risk matching identifiers derived from copy; numeric-only /
// letterless attribute values (path data, dash arrays) are discarded too.
// Invented diegetic mockup labels are text NOT in any content field, so they
// can never flag — attribute labels match whole-value only (a chrome
// category="Deployed · Live" must not flag a bound "Deployed" headline);
// child-text runs keep substring matching, the price of catching splits.

export interface UnboundCopy {
  scene: number;
  field: string;
  excerpt: string;
  /** Where the echo lives — child text or an attribute value. */
  site: "text" | "attribute";
  /** The literal as it actually appears in code (null if fused across tags). */
  found: string | null;
}

/**
 * Blank `//` and `/* *\/` comment CONTENTS while PRESERVING string literals —
 * the inverse emphasis of blankStringsAndComments above (which blanks both;
 * here attribute strings are signal, not noise). Same tiny state machine,
 * same documented coarse spots: an apostrophe in JSX text opens a pseudo
 * string until the newline (a same-line comment after it survives — rare,
 * and the expression-dropper still removes `{/* … *\/}` blocks wholesale).
 */
const stripComments = (code: string): string => {
  const out = code.split("");
  type Mode = "code" | "sq" | "dq" | "tpl" | "line" | "block";
  let mode: Mode = "code";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (mode === "code") {
      if (ch === "'") mode = "sq";
      else if (ch === '"') mode = "dq";
      else if (ch === "`") mode = "tpl";
      else if (ch === "/" && next === "/") { mode = "line"; out[i] = " "; }
      else if (ch === "/" && next === "*") { mode = "block"; out[i] = " "; }
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") mode = "code";
      else out[i] = " ";
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") { out[i] = " "; out[i + 1] = " "; mode = "code"; i++; }
      else if (ch !== "\n") out[i] = " ";
      continue;
    }
    // String modes: contents kept verbatim. Backslash escapes the next char;
    // unterminated ' / " close at the newline (JSX-text apostrophes).
    if (ch === "\\") { i++; continue; }
    if (
      (mode === "sq" && ch === "'") ||
      (mode === "dq" && ch === '"') ||
      (mode === "tpl" && ch === "`")
    ) { mode = "code"; continue; }
    if ((mode === "sq" || mode === "dq") && ch === "\n") mode = "code";
  }
  return out.join("");
};

/**
 * Attributes whose string values are never viewer-readable copy — URLs,
 * geometry, styling hooks. Excluding them keeps SVG path data / dash arrays /
 * asset URLs out of the literal view (a `d="M30,000…"` coordinate run must
 * not collide with a "30,000" headline). Copy smuggled into one of these
 * would be missed — false-negative direction.
 */
const NON_COPY_ATTRS = new Set([
  "src", "href", "xlinkHref", "d", "points", "viewBox", "xmlns", "transform",
  "style", "className", "class", "id", "key", "fill", "stroke",
  "strokeDasharray", "strokeLinecap", "strokeLinejoin", "fontFamily",
  "filter", "mask", "clipPath", "preserveAspectRatio", "alt", "type", "rel",
]);

/** Drop balanced `{…}` groups from a between-tag run; an unmatched `}` means
 *  the run's head was the tail of an expression opened before it — reset. */
const dropJsxExpressions = (gap: string): string => {
  let out = "";
  let depth = 0;
  for (const ch of gap) {
    if (ch === "{") { depth += 1; continue; }
    if (ch === "}") { if (depth > 0) depth -= 1; else out = ""; continue; }
    if (depth === 0) out += ch;
  }
  return out;
};

/**
 * The FUSED literal-text view of a section: comment-stripped, then reduced to
 * JSX text children + copy-bearing string-attribute values, lowercased, all
 * whitespace removed. Children runs concatenate directly (that's what catches
 * the split-span treatment); attribute runs are isolated by \u0001 sentinels
 * so they can never fuse with neighboring text AND so the matcher can demand
 * a whole attribute value EQUAL a field — substring is not enough; an
 * invented chrome label that merely contains one (category="Deployed · Live"
 * around a bound "Deployed" headline, archived Vercel build) is its own
 * text, not a retype. Between-tag runs that still
 * carry code-ish characters after expression-dropping (helper components
 * declared between JSX blocks, arrow-function residue from a coarse tag
 * match) are discarded whole — code identifiers derived from copy
 * ("configHellAnim") must not match a "Config hell" headline.
 */
const fusedLiteralText = (sectionSrc: string): string => {
  const src = stripComments(sectionSrc);
  const runs: string[] = [];
  const tagRe = /<\/?[A-Za-z][^<>]*>/g;
  let prevEnd = -1; // gaps before the first tag are component preamble — code
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    if (prevEnd >= 0) {
      const cleaned = dropJsxExpressions(src.slice(prevEnd, m.index));
      if (cleaned.trim() && !/[;=(){}<>"`]/.test(cleaned)) runs.push(cleaned);
    }
    const attrRe = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[0])) !== null) {
      const name = am[1];
      const value = am[2] ?? am[3] ?? "";
      if (NON_COPY_ATTRS.has(name) || name.startsWith("data-")) continue;
      if (!/[A-Za-z]/.test(value)) continue; // letterless = geometry/numeric
      runs.push(`\u0001${value}\u0001`);
    }
    prevEnd = m.index + m[0].length;
  }
  return runs.join("").toLowerCase().replace(/\s+/g, "");
};

/** The copy fields a viewer reads, per Scene.content (meta is out of scope —
 *  numeric KPI values legitimately recur in charts/tiles). Values shorter
 *  than 4 chars are skipped (a "Go" CTA would match everywhere). */
const contentCopyFields = (
  content: unknown,
): { field: string; value: string }[] => {
  if (!content || typeof content !== "object") return [];
  const c = content as Record<string, unknown>;
  const out: { field: string; value: string }[] = [];
  const push = (field: string, v: unknown) => {
    if (typeof v === "string" && v.trim().length >= 4) {
      out.push({ field, value: v.trim() });
    }
  };
  push("eyebrow", c.eyebrow);
  push("headline", c.headline);
  push("lede", c.lede);
  push("caption", c.caption);
  if (Array.isArray(c.bullets)) {
    c.bullets.forEach((b, i) => push(`bullets[${i}]`, b));
  }
  if (c.cta && typeof c.cta === "object") {
    push("cta.primary", (c.cta as Record<string, unknown>).primary);
    push("cta.secondary", (c.cta as Record<string, unknown>).secondary);
  }
  return out;
};

export const findUnboundCopy = (
  code: string,
  scenes: SceneTiming[],
): UnboundCopy[] => {
  const out: UnboundCopy[] = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const fields = contentCopyFields(scenes[i]?.content);
    if (fields.length === 0) continue;
    const section = sectionSlice(code, i);
    if (!section) continue; // no Section{N} mapping → skip (false negative)
    const view = fusedLiteralText(section);
    // Child text matches by SUBSTRING (split spans fuse across tags);
    // attribute values match WHOLE (sentinel-delimited) — a chrome label
    // that merely contains a short field value is not a retype.
    const childView = view.replace(/\u0001[^\u0001]*\u0001/g, "");
    for (const f of fields) {
      const needle = f.value.toLowerCase().replace(/\s+/g, "");
      const inText = childView.includes(needle);
      const inAttr = view.includes(`\u0001${needle}\u0001`);
      if (!inText && !inAttr) continue;
      // Recover the literal AS IT APPEARS so the repair message can describe
      // the real defect. Root-caused 2026-08-16: the message used to quote
      // the SCRIPT's casing ("THE PILOT") for a code literal ("The Pilot") —
      // the repair model searched for the quoted string, found nothing, saw
      // the field already bound, and correctly concluded there was nothing
      // to do. Every retry was futile BY CONSTRUCTION. A case-insensitive,
      // whitespace-flexible scan of the raw section finds the actual text;
      // a fused-across-tags split may still elude it (reported as such).
      const ciRe = new RegExp(
        f.value
          .split(/\s+/)
          .map((word) =>
            word
              .split("")
              .map((ch) =>
                /[a-zA-Z]/.test(ch)
                  ? `[${ch.toUpperCase()}${ch.toLowerCase()}]`
                  : ch.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"),
              )
              .join(""),
          )
          .join("\\s+"),
      );
      const found = ciRe.exec(section)?.[0] ?? null;
      out.push({
        scene: i,
        field: f.field,
        excerpt: f.value.length > 40 ? `${f.value.slice(0, 37)}…` : f.value,
        site: inText ? "text" : "attribute",
        found,
      });
    }
  }
  return out;
};

/**
 * CHROME-ECHO ENFORCEMENT (root-caused 2026-08-16). The design prompt's own
 * rule: category "is a STABLE context label … NEVER the scene's editorial
 * eyebrow" — yet the observed survivor family is exactly `<Chrome
 * category="The Pilot" />` echoing scene 1's eyebrow "THE PILOT" in a
 * different casing. The echo goes stale the moment the eyebrow is edited,
 * the exact-match binder can't touch attributes, and the repair model was
 * told a casing it couldn't find. This enforces the documented rule
 * deterministically: drop the echoing prop. Guarded on the prop being
 * DECLARED OPTIONAL in the same file (`category?:`), so removal type-checks
 * and the component's own absent-prop rendering handles the rest.
 */
export const stripChromeEyebrowEchoes = (
  code: string,
  scenes: SceneTiming[],
): { code: string; stripped: { scene: number; value: string }[] } => {
  const stripped: { scene: number; value: string }[] = [];
  if (!/category\?\s*:/.test(code)) return { code, stripped };
  let out = code;
  for (let i = 0; i < scenes.length; i += 1) {
    const eyebrow = (scenes[i]?.content as { eyebrow?: unknown } | undefined)?.eyebrow;
    if (typeof eyebrow !== "string" || eyebrow.trim().length === 0) continue;
    const flat = eyebrow.toLowerCase().replace(/\s+/g, "");
    const sectionRe = new RegExp(
      `(?:Section|Scene|Slide)${i}\\b[\\s\\S]*?(?=(?:Section|Scene|Slide)${i + 1}\\b|registerRoot|$)`,
      "i",
    );
    const m = sectionRe.exec(out);
    if (!m) continue;
    let section = m[0];
    section = section.replace(/\s+category="([^"]*)"/g, (full, val: string) => {
      if (val.toLowerCase().replace(/\s+/g, "") !== flat) return full;
      stripped.push({ scene: i, value: val });
      return "";
    });
    out = out.slice(0, m.index) + section + out.slice(m.index + m[0].length);
  }
  return { code: out, stripped };
};

// ─── bind-in-place (v13 #5, the twice-deferred editor lever) ───────────────
//
// Cycle 1: 16 unbound_copy structurals; cycle 4: 21 — copy retyped as literal
// JSX instead of bound through `c.<field>`. The literals render fine today but
// the launch editor edits CONTENT (script.scenes[i].content); a literal mount
// silently keeps the stale string. This transform converts literal copy text
// in the ASSEMBLED composition to bound references.
//
// Safety posture — the transform is a RENDER NO-OP by construction:
//   • Only whole JSX child-text nodes that EXACTLY equal a content field's
//     value are bound (surrounding whitespace preserved verbatim). A split
//     retype ("Come as you are<span>.</span>") never matches — skipped.
//   • Attribute values are never touched (pattern anchored between > and <).
//   • Every assembled Section declares `const c = script.scenes[k].content`
//     (assemble.ts), so `{c.<field>}` is in scope anywhere in the section and
//     renders the IDENTICAL string.
//   • Idempotent: once bound, the literal is gone; a re-run finds nothing.
//   • Ownership: the v11 unowned-copy strip/reject machinery removes foreign
//     retypes at cast time, so literals surviving to the assembled code are
//     the OWNING piece's own mounts — binding them is the owned-field case.

export interface BoundCopyEvent {
  scene: number;
  field: string;
  accessor: string;
  count: number;
}

const ACCESSOR_OK_RX = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;

const accessorForField = (field: string): string | null => {
  // bullets[2] / cta.primary / headline are all valid member chains under c.
  const acc = `c.${field}`;
  return ACCESSOR_OK_RX.test(acc) ? acc : null;
};

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Inline wrapper tags whose adjacent siblings legitimately concatenate into one
// copy string ("Worn Wear<span>·</span>Repair, reuse…" — the cycle-5 residual
// class). Block-level tags never participate: a split across <div>s is layout,
// not a retype of one field.
const INLINE_SPLIT_TAGS = "span|em|strong|b|i";

/**
 * Bind a SPLIT retype: a run of raw text + adjacent inline siblings whose
 * texts concatenate (whitespace-insensitively, case-exactly) to `value`.
 * Each aligned segment becomes `{<accessor>.slice(a, b)}` over the VALUE's
 * character positions — a render no-op by construction (the segment renders
 * the identical characters; inter-segment whitespace was already collapsed by
 * JSX, so slicing around it changes nothing). Conservative: any segment that
 * fails to align contiguously (whitespace-only gaps allowed) skips the run.
 */
const bindSplitSpanRuns = (
  section: string,
  value: string,
  accessor: string,
): { section: string; count: number } => {
  // A candidate run: `>` + optional raw text + 1..4 inline elements with
  // text-only children, optionally separated by raw text, ending at a tag.
  // Open tags allow braces in ATTRIBUTES (`style={{…}}` separators are the
  // observed shape) — inner text must stay expression-free for alignment.
  const runRe = new RegExp(
    `(?<![=\\-])>([^<>{}]*)((?:<(?:${INLINE_SPLIT_TAGS})\\b[^<>]*>[^<>{}]*</(?:${INLINE_SPLIT_TAGS})>[^<>{}]*){1,4})(?=</?[A-Za-z])`,
    "g",
  );
  let count = 0;
  const out = section.replace(runRe, (full: string) => {
    // Parse the run (minus the leading `>`) into ordered raw-text / tag parts.
    const body = full.slice(1);
    const partRe = new RegExp(
      `(<(?:${INLINE_SPLIT_TAGS})\\b[^<>]*>)([^<>{}]*)(</(?:${INLINE_SPLIT_TAGS})>)`,
      "g",
    );
    type Seg = { kind: "text" | "inner"; raw: string; open?: string; close?: string };
    const segs: Seg[] = [];
    let last = 0;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(body)) !== null) {
      if (pm.index > last) segs.push({ kind: "text", raw: body.slice(last, pm.index) });
      segs.push({ kind: "inner", raw: pm[2], open: pm[1], close: pm[3] });
      last = pm.index + pm[0].length;
    }
    if (last < body.length) segs.push({ kind: "text", raw: body.slice(last) });

    // Align every non-whitespace segment against VALUE with a cursor walk.
    // Gaps in VALUE between segments must be whitespace-only (the separators
    // JSX already collapses between sibling elements).
    type Span = { a: number; b: number; trailPunct?: string };
    // v15 (#6): the FINAL content segment may carry ONE appended trailing
    // punctuation char that the owned field lacks (the cycle-6 residual: a
    // headline split into 2 spans rendering "built for you." bound to a field
    // "…built for you"). We align that segment MINUS the punct, but ONLY when
    // it consumes to VALUE's end, and re-emit the punct as a literal after the
    // slice (identical glyphs render).
    const TRAIL_PUNCT_RX = /^(.*\S)([.,!?;:])$/;
    let cursor = 0;
    let alignedCount = 0;
    const spans: (Span | null)[] = segs.map((s) => {
      const core = s.raw.trim();
      if (core.length === 0) return null; // whitespace-only — preserved verbatim
      const idx = value.indexOf(core, cursor);
      if (idx >= cursor && value.slice(cursor, idx).trim() === "") {
        cursor = idx + core.length;
        alignedCount += 1;
        return { a: idx, b: cursor };
      }
      const pm2 = TRAIL_PUNCT_RX.exec(core);
      if (pm2) {
        const core2 = pm2[1];
        const idx2 = value.indexOf(core2, cursor);
        if (idx2 >= cursor && value.slice(cursor, idx2).trim() === "" && idx2 + core2.length === value.length) {
          cursor = value.length;
          alignedCount += 1;
          return { a: idx2, b: cursor, trailPunct: pm2[2] };
        }
      }
      return { a: -1, b: -1 };
    });
    const misaligned = spans.some((s) => s !== null && s.a === -1);
    // Demand: full coverage of the value, ≥2 aligned segments (a single
    // segment is the whole-node case, handled by the exact-match pass).
    if (misaligned || alignedCount < 2 || value.slice(cursor).trim() !== "") return full;

    count += 1;
    const bindOne = (raw: string, span: Span): string => {
      const lead = raw.slice(0, raw.length - raw.trimStart().length);
      const trail = raw.slice(raw.trimEnd().length);
      return `${lead}{${accessor}.slice(${span.a}, ${span.b})}${span.trailPunct ?? ""}${trail}`;
    };
    const rebuilt = segs
      .map((s, si) => {
        const span = spans[si];
        if (s.kind === "text") return span ? bindOne(s.raw, span) : s.raw;
        return `${s.open}${span ? bindOne(s.raw, span) : s.raw}${s.close}`;
      })
      .join("");
    return `>${rebuilt}`;
  });
  return { section: out, count };
};

/**
 * Bind literal copy retypes in the assembled composition to `c.<field>`
 * references. Returns the transformed code + a ledger of what bound. Pure and
 * conservative: any value containing JSX-structural characters, and any
 * occurrence that is not a whole child-text node (or an alignable split-span
 * run / exact re-case), is skipped.
 *
 * v14 extensions (the cycle-5 residual classes):
 *   • whole-node whitespace now spans NEWLINES — `>\n  Value\n</h1>` binds
 *     (JSX collapses that whitespace identically around `{c.field}`);
 *   • re-case forms bind through an exact transform — a literal that equals
 *     value.toUpperCase() binds as `{c.field.toUpperCase()}` (same glyphs
 *     render; the editor still propagates). Title-case and composed labels
 *     ("Field Recordings · In the Wild" around an "IN THE WILD" eyebrow)
 *     stay skipped — no expression reproduces them, and a composed label is
 *     the piece's own text, not a retype;
 *   • split-span runs bind via slice expressions (bindSplitSpanRuns above).
 */
export const bindLiteralCopyInPlace = (
  code: string,
  scenes: SceneTiming[],
): { code: string; bound: BoundCopyEvent[] } => {
  let out = code;
  const bound: BoundCopyEvent[] = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const fields = contentCopyFields(scenes[i]?.content);
    if (fields.length === 0) continue;
    const sectionRe = new RegExp(
      `(?:Section|Scene|Slide)${i}\\b[\\s\\S]*?(?=(?:Section|Scene|Slide)${i + 1}\\b|registerRoot|$)`,
      "i",
    );
    const m = sectionRe.exec(out);
    if (!m) continue;
    let section = m[0];
    for (const f of fields) {
      if (/[<>{}\\]/.test(f.value) || /&[a-z#]+;/i.test(f.value)) continue; // JSX-structural / entity text — skip
      const accessor = accessorForField(f.field);
      if (!accessor) continue;
      // The literal→expression pairs this field can bind through, each an
      // exact render no-op: the value itself, and its whole-string case
      // transforms when they differ (re-case retypes, conservatively).
      const variants: { literal: string; expr: string }[] = [
        { literal: f.value, expr: accessor },
      ];
      const upper = f.value.toUpperCase();
      const lower = f.value.toLowerCase();
      if (upper !== f.value) variants.push({ literal: upper, expr: `${accessor}.toUpperCase()` });
      if (lower !== f.value) variants.push({ literal: lower, expr: `${accessor}.toLowerCase()` });
      let count = 0;
      for (const v of variants) {
        // Whole child-text node: `>` (not an arrow's) + whitespace (INCLUDING
        // newlines — the indented-block form) + the exact literal + whitespace
        // + a real tag open/close. Whitespace kept verbatim.
        const nodeRe = new RegExp(
          `(?<![=\\-])>([ \\t\\r\\n]*)${escapeRx(v.literal)}([ \\t\\r\\n]*)(?=</?[A-Za-z])`,
          "g",
        );
        section = section.replace(nodeRe, (_full, ws1: string, ws2: string) => {
          count += 1;
          return `>${ws1}{${v.expr}}${ws2}`;
        });
      }
      /**
       * TRANSFORM-NORMALIZED rung (the survivor family, root-caused
       * 2026-08-16). The agent echoes a field in a DIFFERENT casing than the
       * script ("The Reframe" for THE REFRAME) inside an element that
       * normalizes case anyway (textTransform: "uppercase" | "lowercase").
       * Under that transform the literal and the bound field RENDER
       * IDENTICALLY, so binding is still a pixel no-op — but the exact-match
       * variants above can never see it, the LLM repair was told the
       * script's casing and couldn't find it, and the flag shipped on every
       * such build. Guard: the opening tag itself must declare the
       * normalizing transform, and the text must equal the field
       * case-insensitively with whitespace EXACT.
       */
      {
        const ciLiteral = f.value
          .split("")
          .map((ch) => (/[a-zA-Z]/.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : escapeRx(ch)))
          .join("");
        const normRe = new RegExp(
          `(<[a-zA-Z][^<>]*textTransform:\\s*"(?:uppercase|lowercase)"[^<>]*>)([ \\t\\r\\n]*)${ciLiteral}([ \\t\\r\\n]*)(?=</?[A-Za-z])`,
          "g",
        );
        section = section.replace(normRe, (full, tag: string, ws1: string, ws2: string) => {
          // The exact rungs above already bound identical-cased text; anything
          // still matching here is a case-variant under a normalizing wrapper.
          count += 1;
          return `${tag}${ws1}{${accessor}}${ws2}`;
        });
      }
      // Split-span retypes (case-exact): adjacent inline siblings that
      // concatenate to the owned field bind through slice expressions.
      const split = bindSplitSpanRuns(section, f.value, accessor);
      section = split.section;
      count += split.count;
      if (count > 0) bound.push({ scene: i, field: f.field, accessor, count });
    }
    out = out.slice(0, m.index) + section + out.slice(m.index + m[0].length);
  }
  return { code: out, bound };
};

/**
 * Deterministically neutralize invalid `lucide-react` imports so a hallucinated
 * icon can't crash the render. The agent sometimes imports brand logos
 * (`Slack`, `Github`, `Figma`) that DON'T exist in lucide-react → the binding is
 * `undefined` → React throws "Element type is invalid" (white screen). The
 * structural icon gate already detects this and retries once, but a structural
 * failure ships best-effort — so a non-compliant retry would still ship a
 * guaranteed crash. This is the guarantee that runs last: rewrite each invalid
 * import specifier to alias a real neutral icon (`Square`), keeping the SAME
 * local identifier so every JSX and array usage keeps resolving — and leaving
 * string literals (e.g. a "Slack · #product" label) untouched.
 *
 * Pure + idempotent. `invalidNames` are the offending EXPORT names the caller's
 * detector flagged (e.g. ["Slack", "Github"]). No-op when empty or no import.
 */
export const repairInvalidLucideImports = (
  code: string,
  invalidNames: string[],
): string => {
  if (invalidNames.length === 0) return code;
  const bad = new Set(invalidNames);
  return code.replace(
    /import\s*\{([^}]*)\}\s*from\s*(["'])lucide-react\2/,
    (full: string, inner: string, q: string) => {
      const kept: string[] = [];
      const aliased: string[] = [];
      for (const raw of inner.split(",")) {
        const spec = raw.trim();
        if (!spec) continue;
        const [exp, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
        if (bad.has(exp)) {
          // Keep the local identifier; point it at a real icon.
          aliased.push(`Square as ${local || exp}`);
        } else {
          kept.push(spec);
        }
      }
      if (aliased.length === 0) return full; // nothing actually invalid here
      return `import { ${[...kept, ...aliased].join(", ")} } from ${q}lucide-react${q}`;
    },
  );
};

// ── placeholder-data lint (QA 2026-07-06: Klarna shipped "$•••.00" / "Loading") ──
//
// The design agent sometimes emits masked or unresolved values instead of
// concrete diegetic data — masked prices ("$•••.00"), value-less dashes
// ("$—"), a bare "Loading" label, "TBD"/"lorem" stubs. On a rendered frame
// these read as a broken, half-loaded product, not design. STRUCTURAL: a
// viewer instantly clocks it. Precision notes: a single "•"/"·" is a legal
// separator (kept); an ellipsis in copy is fine; "Loading" only fires as a
// standalone rendered word (JSX text or a quoted string value), not as a
// substring (e.g. "LoadingScreen" identifier).

export interface PlaceholderHit {
  /** 0-based Section index the hit sits in (-1 when unattributable). */
  section: number;
  token: string;
  /** Short surrounding excerpt for the retry message. */
  context: string;
}

const PLACEHOLDER_PATTERNS: { rx: RegExp; label: string }[] = [
  { rx: /[•●]{2,}/g, label: "masked value (bullet run)" },
  { rx: /\$\s*[—–]/g, label: "value-less price ($—)" },
  { rx: /(?:\d\s*\/\s*\d\s*·\s*)?\$\s*[—–xX]{1,3}(?![\w])/g, label: "masked installment ($—)" },
  { rx: />\s*(Loading|Loading\.{3}|TBD|lorem ipsum|N\/A)\s*</gi, label: "unresolved label" },
  { rx: /["'`](Loading|TBD)["'`]\s*[,}\]]/g, label: "unresolved value literal" },
  { rx: /\bXX%|\b\?\?\?/g, label: "stub metric" },
];

/** 0-based section index for a character offset, from Section{N} markers. */
const sectionAt = (code: string, offset: number): number => {
  let section = -1;
  const rx = /export\s+const\s+Section(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(code)) !== null) {
    if (m.index > offset) break;
    section = parseInt(m[1], 10);
  }
  return section;
};

export const findPlaceholderData = (code: string): PlaceholderHit[] => {
  const hits: PlaceholderHit[] = [];
  for (const { rx, label } of PLACEHOLDER_PATTERNS) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(code)) !== null) {
      const start = Math.max(0, m.index - 28);
      hits.push({
        section: sectionAt(code, m.index),
        token: `${label}: "${m[0].trim()}"`,
        context: code.slice(start, m.index + m[0].length + 20).replace(/\s+/g, " "),
      });
      if (hits.length >= 24) return hits; // cap — enough to fail loudly
    }
  }
  return hits;
};
