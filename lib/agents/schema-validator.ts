import type { ElementSpec, Scene, Script } from "../../src/schema";

/**
 * Minimal validator for Agent 1 output.
 *
 * Checks:
 *   • output is a JSON object
 *   • required top-level keys present
 *   • config.duration_seconds valid, fps=30
 *   • scenes tile [0, totalFrames] exactly
 *   • every scene has visual_concept and content
 *   • content.texts are readable (>=2 unicode letters/digits)
 *   • script-richness contract on the generation path (beat coverage,
 *     visual_concept floor, interior furnishing, atmosphere anti-copy)
 *     — see checkScriptRichness; stored scripts opt out via
 *     validateScript(input, { richness: false })
 *
 * The old element-level checks are gone — Scene no longer has
 * elements[]. Agent 2 produces the visual layer from visual_concept
 * + content freely.
 */

export type ValidationResult =
  | { ok: true; script: Script }
  | { ok: false; error: string };

const HEADLINE_MAX = 72;
const HEADLINE_TWO_SENTENCE_MIN = 44;

/**
 * QA S4: a hero headline must be ONE punchy clause. The old cap was 120 chars,
 * which let the agent cram a headline + subhead into the headline field (Fuse:
 * "Building takes years. Buying means losing control." — 50c, two sentences).
 * Flags paragraphs (>72c) and LONG two-sentence crams (a mid-headline sentence
 * break + more words on a headline >44c). Short stylistic two-beats ("Move fast.
 * Break things." 24c) pass. Returns the problem clause, or null if clean.
 */
export const headlineProblem = (headline: string): string | null => {
  const h = headline.trim();
  if (h.length > HEADLINE_MAX) {
    return `is ${h.length} chars; cap at ${HEADLINE_MAX}. Make headlines pop, not paragraphs.`;
  }
  if (h.length > HEADLINE_TWO_SENTENCE_MIN && /[.?!]\s+\p{L}/u.test(h)) {
    return `is two sentences ("${h}") — a hero headline is ONE clause. Move the second sentence into the lede.`;
  }
  return null;
};

/**
 * QA S5 (tightened — the fabricated-38ms fix): catch invented numeric claims
 * at the SCRIPT stage. The design stage's E2 gate backstops it, but this is
 * the earlier, cheaper catch — and the one that stops a fabricated stat from
 * reaching the design stage, where it would otherwise launder into "approved
 * script content" that downstream gates trust as a grounding source.
 *
 * Scope — conservative by design. Only STAT-SHAPED tokens are checked:
 * currency ($840M), percentages (99.8%), multipliers (10x), K/M/B counts
 * (2M users), precise time/latency claims (38ms, 30-second, 200 milliseconds),
 * and percentile markers (p50/p95/p99). Obviously-safe forms — bare integers,
 * years ("founded 2024"), scene counts, list ordinals, "3 weeks" — are never
 * flagged.
 *
 * Grounding — full-token, never digit-core. The original implementation
 * grounded a claim if its DIGITS appeared anywhere in the source, so
 * "30-second video" grounded "3x" and "founded in 2010" grounded "10x" —
 * exactly how a precise techy fabrication like Raycast's "38ms p50" (invented
 * by the model; the crawl only says "Think in milliseconds") could ride an
 * incidental digit. Now a claim grounds ONLY on a source number with the SAME
 * numeric value AND a compatible unit/suffix:
 *   38ms   grounds on "38 ms" / "38 milliseconds" — NOT on "38 extensions"
 *   99.8%  grounds on "99.8%" / "99.8 percent"    — NOT on a bare "99.8"
 *   $2.4M  grounds on "$2.4M" / "2.4 million"     — NOT on "2.4 rating"
 *   10x    grounds on "10x" / "10 times"          — NOT on "since 2010"
 *   p50    grounds on a literal "p50" only
 *
 * The source text is the brief's ALLOWED grounding set, assembled by the
 * caller: the user's freeform prompt / purpose, verified_claims, and the
 * crawl's title / description / headlines / body_excerpts. NEVER the script's
 * own text. Returns the ungrounded tokens (verbatim, for the retry message).
 */
const STAT_CLAIM_RX = new RegExp(
  [
    // currency, optional magnitude suffix: $840M, €99, $2.4 million, $10k+
    "[$€£]\\s?\\d[\\d,.]*\\s?(?:k|m|b|bn|mm|billion|million|thousand)?\\+?",
    // percent: 99.8%, 99.97 %
    "\\d[\\d,.]*\\s?%",
    // multiplier: 10x, 3×, 12 x
    "\\d[\\d,.]*\\s?(?:x\\b|×)",
    // precise time/latency: 38ms, 200 milliseconds, 30-second, 45 secs
    "\\d[\\d,.]*[\\s-]?(?:milliseconds?|millis|ms|seconds?|secs?)\\b",
    // percentile markers: p50, P95, p99.9
    "\\bp(?:50|75|90|95|99)(?:\\.\\d+)?\\b",
    // bare-count magnitude: 2M users, 10k, 1.5B
    "\\d[\\d,.]*\\s?(?:k|m|b|bn|mm|billion|million|thousand)\\+?\\b",
  ].join("|"),
  "gi",
);

/** Unit/suffix class a stat-shaped number carries. */
type StatUnit =
  | { kind: "percent" }
  | { kind: "multiplier" }
  | { kind: "time"; unit: "ms" | "s" }
  | { kind: "magnitude"; mag: "k" | "m" | "b" }
  | { kind: "currency-word" };

// Maps (not object literals) so prototype keys ("constructor") from wild
// source text can never produce a bogus lookup hit.
const MAG_UNITS = new Map<string, "k" | "m" | "b">([
  ["k", "k"], ["thousand", "k"], ["thousands", "k"],
  ["m", "m"], ["mm", "m"], ["million", "m"], ["millions", "m"],
  ["b", "b"], ["bn", "b"], ["billion", "b"], ["billions", "b"],
]);
const TIME_UNITS = new Map<string, "ms" | "s">([
  ["ms", "ms"], ["millis", "ms"], ["millisecond", "ms"], ["milliseconds", "ms"],
  ["s", "s"], ["sec", "s"], ["secs", "s"], ["second", "s"], ["seconds", "s"],
]);
const CURRENCY_WORDS = new Set(["usd", "eur", "gbp", "dollar", "dollars"]);

const classifyUnit = (raw: string | undefined): StatUnit | null => {
  if (!raw) return null;
  const u = raw.toLowerCase().replace(/^[\s-]+/, "").replace(/\+$/, "");
  if (!u) return null;
  if (u.startsWith("%") || u.startsWith("percent")) return { kind: "percent" };
  if (u === "x" || u === "×" || u === "times") return { kind: "multiplier" };
  const time = TIME_UNITS.get(u);
  if (time) return { kind: "time", unit: time };
  const mag = MAG_UNITS.get(u);
  if (mag) return { kind: "magnitude", mag };
  if (CURRENCY_WORDS.has(u)) return { kind: "currency-word" };
  return null;
};

type ParsedClaim =
  | { kind: "percentile"; key: string }
  | { kind: "stat"; value: number; unit: StatUnit | null; currency: boolean };

const parseClaim = (token: string): ParsedClaim | null => {
  const t = token.trim();
  if (/^p\d/i.test(t)) return { kind: "percentile", key: t.toLowerCase() };
  const num = t.match(/\d[\d,]*(?:\.\d+)?/);
  if (!num) return null;
  const value = Number.parseFloat(num[0].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return {
    kind: "stat",
    value,
    unit: classifyUnit(t.slice((num.index ?? 0) + num[0].length)),
    currency: /^[$€£]/.test(t),
  };
};

/**
 * Every number in the source with its money-prefix and the unit-ish word that
 * follows it. The lookbehind keeps partial-number matches out ("2024" never
 * yields a "20" entry), so digit-substring cross-grounding is impossible.
 */
type SourceNumber = { value: number; unit: StatUnit | null; currency: boolean };
const SOURCE_NUM_RX = /([$€£])?\s?(?<![\d.,])(\d[\d,]*(?:\.\d+)?)[\s-]?([a-z%×]+)?/gi;
const PERCENTILE_RX = /\bp(?:50|75|90|95|99)(?:\.\d+)?\b/gi;

const indexSourceNumbers = (sourceText: string): SourceNumber[] => {
  const out: SourceNumber[] = [];
  for (const m of sourceText.matchAll(SOURCE_NUM_RX)) {
    const value = Number.parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    out.push({ value, unit: classifyUnit(m[3]), currency: !!m[1] });
  }
  return out;
};

const isGrounded = (
  claim: ParsedClaim,
  nums: SourceNumber[],
  percentiles: Set<string>,
): boolean => {
  if (claim.kind === "percentile") return percentiles.has(claim.key);
  for (const e of nums) {
    if (e.value !== claim.value) continue;
    const cu = claim.unit;
    if (!cu) {
      // Currency claim with no magnitude ($99): needs money context in source.
      if (claim.currency && (e.currency || e.unit?.kind === "currency-word"))
        return true;
      continue;
    }
    const su = e.unit;
    if (!su) continue; // full-token rule: a bare source number grounds nothing
    if (cu.kind === "percent" && su.kind === "percent") return true;
    if (cu.kind === "multiplier" && su.kind === "multiplier") return true;
    if (cu.kind === "time" && su.kind === "time" && su.unit === cu.unit) return true;
    if (cu.kind === "magnitude" && su.kind === "magnitude" && su.mag === cu.mag)
      return true;
  }
  return false;
};

/**
 * All stat-shaped numeric tokens in `text` (verbatim, deduped, in order).
 * Exported for the claims audit (`scripts/claims-audit.mjs`) and tests, so
 * reporting and the gate share ONE definition of "stat-shaped".
 */
export const extractStatClaims = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(STAT_CLAIM_RX)) {
    const token = m[0].trim().replace(/[.,]+$/, "");
    if (!/\d/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
};

/**
 * A PLAIN currency amount ($243.00, $60.75, €18.50) with no magnitude suffix
 * is a DIEGETIC PRICE — a cart total, an installment, a product price — not a
 * marketing proof-stat. The invented-claim gate exists to catch fabricated
 * SCALE claims (magnitude currency "$840M", percentages, latencies, "10x",
 * funding stages); a plain price is a different class. But WHERE it appears
 * matters: a price in a HEADLINE/lede/bullet/meta is still a claim surface and
 * stays strict ("Save $18.50 every order" is a marketing claim). Only in a
 * descriptive CAPTION — set-dressing text under the content (the reference S0
 * caption is "checkout.store.com · SSL secured") — is a plain price exempt.
 * That is the Klarna full-pipe fix: a generated checkout scene re-invents its
 * own "$243.00" total and echoes it in the caption; the gate used to flag it
 * and burn repair rounds forcing the model to strip a value it had no grounded
 * alternative for. The exemption is opt-in (default strict) and NEVER weakens
 * the scale guard: a magnitude suffix keeps its unit and still flows through
 * grounding, and the ceiling rejects a spelled-out scale figure ("$5,000,000").
 */
export const DIEGETIC_PRICE_CEILING = 1_000_000;
export const isDiegeticPrice = (claim: ParsedClaim): boolean =>
  claim.kind === "stat" &&
  claim.currency &&
  claim.unit === null &&
  claim.value < DIEGETIC_PRICE_CEILING;

export const findUngroundedClaims = (
  scriptText: string,
  sourceText: string,
  opts: { exemptDiegeticPrices?: boolean } = {},
): string[] => {
  const nums = indexSourceNumbers(sourceText);
  const percentiles = new Set(
    Array.from(sourceText.matchAll(PERCENTILE_RX), (m) => m[0].toLowerCase()),
  );
  const out: string[] = [];
  for (const token of extractStatClaims(scriptText)) {
    const claim = parseClaim(token);
    if (!claim) continue;
    if (opts.exemptDiegeticPrices && isDiegeticPrice(claim)) continue;
    if (isGrounded(claim, nums, percentiles)) continue;
    out.push(token);
  }
  return out;
};

/**
 * QA G5: catch a fabricated FUNDING STAGE label at the script stage. A brief
 * that says "$250M funding round" does NOT state the stage — yet the script
 * agent labeled corgi's raise "Series C" out of thin air, a specific factual
 * claim nobody supplied. Like findUngroundedClaims this is deliberately narrow:
 * it ONLY matches distinctive stage labels (Series A–K, pre-seed, seed/angel/
 * growth/bridge/mezzanine round), so ordinary copy is never touched. A stage is
 * grounded if it appears in the source text. Returns the ungrounded labels.
 */
const STAGE_LABEL_RX =
  /\bseries\s+[a-k]\b|\bpre-?seed\b|\bseed\s+round\b|\bangel\s+round\b|\bgrowth\s+round\b|\bbridge\s+round\b|\bmezzanine\s+round\b/gi;

export const findUngroundedStageLabels = (
  scriptText: string,
  sourceText: string,
): string[] => {
  const src = sourceText.toLowerCase().replace(/[\s-]/g, "");
  const out: string[] = [];
  for (const m of scriptText.matchAll(STAGE_LABEL_RX)) {
    const token = m[0].trim().replace(/\s+/g, " ");
    const norm = token.toLowerCase().replace(/[\s-]/g, "");
    if (src.includes(norm)) continue; // grounded — the stage is actually stated
    if (!out.some((t) => t.toLowerCase() === token.toLowerCase())) out.push(token);
  }
  return out;
};

// Diegetic vocabulary — concrete non-text visual elements a scene can build,
// aligned with the design-agent's diegetic-primitive vocabulary. A scene whose
// visual_concept names NONE of these is "type-only": a headline/line plus
// ambient decoration (ember, glow, hairline, gradient, grain, light ray) and
// nothing to look at. That's the wall-of-type failure — written into the
// visual_concept at script time and faithfully rendered by the build, so the
// cheapest place to stop it is here. Decoration-only nouns are deliberately
// absent. Word-boundary, case-insensitive; generous on purpose (false-negative
// direction — when unsure, a scene PASSES).
// (Kept as a source string so the richness contract below can extend the same
// vocabulary without duplicating it.)
const DIEGETIC_ELEMENT_SOURCE =
  "panels?|cards?|dashboards?|mock(?:up)?s?|diagrams?|charts?|graphs?|mesh|nodes?|grids?|tables?|browser|windows?|devices?|phones?|laptops?|screens?|interface|map|timeline|counter|trust[\\s-]?bar|logos?|illustration|screenshots?|spinner|badges?|gauge|meter|tiles?|avatars?|photos?|images?|flow(?:chart)?|connectors?|sparkline|histogram|kpi|widgets?|popup|terminal|console|editor|rows?|product|constellation|waveform|dial|ledger|receipts?|invoices?|documents?";
const DIEGETIC_ELEMENT_RX = new RegExp(`\\b(${DIEGETIC_ELEMENT_SOURCE})\\b`, "i");
const DIEGETIC_UI_RX = /\bUI\b/; // the acronym specifically, not "build"/"guide"

/**
 * Scenes whose visual_concept is type-only — a headline plus ambient decoration
 * with no concrete non-text/diegetic element. Returns the flagged scene indices
 * so the script-gen retry can demand a real visual per scene (manifestos
 * included). Empty visual_concept is NOT flagged (false-negative direction).
 */
export const findTypeOnlyScenes = (
  scenes: { visual_concept?: unknown }[],
): number[] => {
  const out: number[] = [];
  scenes.forEach((sc, i) => {
    const vc =
      sc && typeof sc.visual_concept === "string" ? sc.visual_concept : "";
    if (!vc.trim()) return;
    if (DIEGETIC_ELEMENT_RX.test(vc) || DIEGETIC_UI_RX.test(vc)) return;
    out.push(i);
  });
  return out;
};

// ─── Script-richness contract (machine-checked) ──────────────────────────
//
// Bake-off evidence (gpt-oss on the full production prompt, 2026-07): the
// model met EVERY rule backed by a static validator and missed EVERY richness
// norm enforced only by prose — 44% of the reference's visual_concept mass,
// latest beats landing at 0-17% of scene duration (vs the prompt's ≥60% ask),
// and the prompt's own fallback atmosphere ("glow pulse + drifting dots")
// copied near-verbatim into all 5 scenes (→ monotone videos). The mechanism
// fast models demonstrably respond to is the one validateScript already
// drives: static check → verbatim error → one repair call. These four checks
// turn the richness norms into that contract. All regex/string level; every
// error ≤200 chars, actionable, naming the scene. Calibrated so the reference
// script (src/generated/01KXEAF0SNT0RR079Z1SJZ1KWZ) passes every check:
// beats 58-75%, 870-1237 chars, 4-9 drawable nouns, 3-6 interiors, no shared
// atmosphere phrase.
//
// BACK-COMPAT: the contract applies to NEWLY GENERATED scripts only — see
// ValidateScriptOptions.richness. Stored scripts predate it.

/** Latest explicit beat must reach this fraction of the scene's duration.
 *  The prompt asks for ≥60%; the enforced floor is 50% (the reference's
 *  tightest scene lands at 58%, and 50% still rejects the thin failure mode's
 *  8-33% by a wide margin). */
export const BEAT_COVERAGE_MIN_FRACTION = 0.5;
/** Scenes shorter than this are exempt from beat coverage (matches the
 *  pipeline dead-air gate's skip). */
export const BEAT_COVERAGE_MIN_SCENE_SECONDS = 3;
export const VISUAL_CONCEPT_MIN_CHARS = 120;
export const VISUAL_CONCEPT_MIN_NOUNS = 3;
/** A container (mock/window/panel/card/dashboard/browser) must name at least
 *  this many interior specifics. */
export const FURNISHING_MIN_INTERIORS = 2;
/** An atmosphere phrase shared by this many scenes is a copy-paste reject. */
export const ATMOS_COPY_MIN_SCENES = 3;
const ATMOS_NGRAM_WORDS = 4;

/**
 * Explicit timed beats in visual_concept prose: "at 2.3s" / "from 3.8s"
 * (the exact idiom the prompt mandates — "ALL TIMING ... IN SECONDS. Write
 * 'From Xs to Ys:' or 'at 2.4s'"). Same seconds-token parse as the pipeline
 * dead-air scan (`(\d+(?:\.\d+)?)s\b`), scoped to at/from so durations
 * ("duration 0.8s", "over 0.6s"), staggers ("0.15s stagger") and cycle
 * lengths ("(4s cycle)") never count as beats. Infinite-loop START times DO
 * count — "glow loops infinite from 3s" is a timed motion event a viewer
 * sees fire at 3s (this is also what the reference's tail beats are).
 */
const BEAT_TIME_RX = /\b(?:at|from)\s+(\d+(?:\.\d+)?)\s*s\b/gi;

/** Largest explicit beat timestamp in a visual_concept (0 when none parse). */
export const latestExplicitBeat = (visualConcept: string): number => {
  let latest = 0;
  for (const m of visualConcept.matchAll(BEAT_TIME_RX)) {
    latest = Math.max(latest, Number.parseFloat(m[1]));
  }
  return latest;
};

// Drawable-noun vocabulary for the visual_concept floor = the diegetic set
// plus concrete sub-element nouns (a wordmark, an accent bar, a CTA pill...)
// that are legitimately drawable but too small to count as a scene's diegetic
// anchor in findTypeOnlyScenes. Pure-decoration nouns (glow, ember, gradient)
// stay excluded so the floor measures things to LOOK AT.
const EXTRA_DRAWABLE_SOURCE =
  "wordmarks?|bars?|dots?|buttons?|pills?|toasts?|modals?|lines?|hairlines?|dividers?|bubbles?|check(?:mark)?s?|icons?|favicons?|labels?|fields?|sidebars?|toolbars?|titlebars?|tooltips?|cursors?|chips?|arrows?|rings?|tabs?|lists?";
const DRAWABLE_NOUN_RX = new RegExp(
  `\\b(${DIEGETIC_ELEMENT_SOURCE}|${EXTRA_DRAWABLE_SOURCE})\\b`,
  "gi",
);

// v13 (cycle-4 Oatly, CONFIRMED brand-contract defect): the drawable lexicon
// above is UI-biased (panel/chart/mock/button). A type-poster brand's
// legitimate concepts — oversized numerals, ransom-note type blocks, stamps,
// scribbles — scored "2 drawable nouns" at 1000+ chars, burned 2 script
// attempts + 2 surgicals, and the floor then FORCED weak stage-card mocks
// onto scenes whose right answer was typographic. On the registers whose
// idiom is typographic (quote / centered / full-bleed), TYPOGRAPHIC drawables
// additionally count toward the floor. The floor itself is unchanged, and the
// UI vocabulary still counts on every register — this widens what counts as
// "a thing to look at" only where type IS the artwork.
export const TYPE_POSTER_REGISTERS: ReadonlySet<string> = new Set([
  "quote",
  "centered",
  "full-bleed",
]);
const TYPO_DRAWABLE_SOURCE =
  "numerals?|lockups?|letterforms?|glyphs?|monograms?|stickers?|stamps?|scribbles?|underlines?|strikethroughs?|ransom[\\s-]?notes?|type\\s?blocks?|posters?|headline\\s?blocks?|mastheads?|marquees?|speech\\s?bubbles?|torn[\\s-]?paper|ampersands?|asterisks?|quotation\\s?marks?|exclamation\\s?(?:marks?|points?)|slashes?|brackets?|punctuation";
const TYPO_DRAWABLE_NOUN_RX = new RegExp(
  `\\b(${DIEGETIC_ELEMENT_SOURCE}|${EXTRA_DRAWABLE_SOURCE}|${TYPO_DRAWABLE_SOURCE})\\b`,
  "gi",
);

/** Naive singular so "cards"/"card" count once ("mesh"/"glass" unaffected). */
const singularize = (w: string): string =>
  w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

/**
 * Distinct concrete drawable nouns named in a visual_concept. When `register`
 * is a type-poster register (quote / centered / full-bleed), typographic
 * drawables (oversized numeral, stacked wordmark, ransom-note type block,
 * sticker, stamp, scribble, type lockup, poster headline...) count too.
 */
export const countDrawableNouns = (
  visualConcept: string,
  register?: string,
): number => {
  const rx =
    register && TYPE_POSTER_REGISTERS.has(register)
      ? TYPO_DRAWABLE_NOUN_RX
      : DRAWABLE_NOUN_RX;
  const seen = new Set<string>();
  for (const m of visualConcept.matchAll(rx)) {
    seen.add(singularize(m[0].toLowerCase().replace(/[\s-]+/g, " ")));
  }
  return seen.size;
};

// Containers that promise a UI interior. A visual_concept that names one and
// then furnishes it with nothing is the "bare container" failure — the build
// renders empty chrome (or worse, delegates the interior to a site_img_*
// asset, which renders blank).
const CONTAINER_SOURCE = "mock(?:up)?s?|windows?|panels?|cards?|dashboards?|browsers?";
const CONTAINER_RX = new RegExp(`\\b(?:${CONTAINER_SOURCE})\\b`, "i");
// The container phrase to quote verbatim in the error: one preceding word +
// the container run ("three window mockups", "a bare dashboard").
const CONTAINER_PHRASE_RX = new RegExp(
  `(?:\\S+\\s+)?(?:${CONTAINER_SOURCE})(?:[\\s-](?:${CONTAINER_SOURCE}))?\\b`,
  "i",
);
// Interior specifics — the things DRAWN INSIDE a container. Text-slot names
// (headline/lede/caption) are deliberately absent: they appear in nearly
// every concept and would neuter the check.
const INTERIOR_SOURCE =
  "rows?|labell?ed|labels?|values?|tabs?|feeds?|charts?|graphs?|avatars?|favicons?|fields?|columns?|cells?|buttons?|badges?|check(?:mark)?s?|toggles?|icons?|logos?|menus?|sidebars?|toolbars?|title\\s?bars?|headers?|footers?|nav|url\\s?bar|status\\s?bar|toasts?|modals?|inputs?|cursors?|timestamps?|metrics?|sparklines?|records?|titles?";
const INTERIOR_RX = new RegExp(`\\b(${INTERIOR_SOURCE})\\b`, "gi");

/** Distinct interior specifics named in a visual_concept. */
export const countInteriorSpecifics = (visualConcept: string): number => {
  const seen = new Set<string>();
  for (const m of visualConcept.matchAll(INTERIOR_RX)) {
    seen.add(singularize(m[0].toLowerCase().replace(/\s+/g, " ")));
  }
  return seen.size;
};

// Atmosphere anti-copy: normalized word 4-grams mined from motion clauses
// (clauses mentioning infinite/loop — the sustained-ambience idiom). A gram
// shared by ≥3 scenes is the "glow pulse + drifting dots" copy-paste
// signature. Normalization strips hex colors and numbers so "(4s cycle)" vs
// "(3s cycle)" can't hide a copied phrase; unit leftovers (s/ms/px/deg/x/em)
// are dropped so they don't fabricate junk grams.
//
// MOTION-MECHANICS VOCAB (retry root-cause audit, 2026-07-16 — class 2): the
// prompt MANDATES the loop idiom ("≥2 infinite-loop sustained motions",
// "loops infinite (Ns cycle)"), so its canonical scaffold syntax — infinite/
// loop/cycle/breathe/drift/opacity/scale/sin/from/at/duration/ease — is
// PROMPT-REQUIRED plumbing, not authored content. Counting it made obedience
// look like plagiarism: run 2's TERMINAL reference fallback was the gram
// "breathes infinite loop scale" — three different scenes each writing the
// mandated idiom correctly. These tokens are dropped before grams form, so
// 4-grams compare CONTENT words only ("faint radial glow behind" copied
// across 3 scenes still fails; "drift infinite with sin" no longer can).
const ATMOS_UNIT_TOKENS = new Set([
  "s", "ms", "px", "x", "deg", "em",
  // motion-mechanics scaffold (prompt-mandated loop idiom)
  "infinite", "loop", "loops", "looping", "cycle", "opacity", "scale",
  "breathe", "breathes", "breathing", "drift", "drifts", "sin",
  "from", "at", "duration", "ease",
]);

const motionGrams = (visualConcept: string): Set<string> => {
  const grams = new Set<string>();
  // Clause split: semicolons, newlines, or sentence-final periods. Periods
  // inside decimals ("2.3s") are followed by digits, not whitespace → kept.
  for (const clause of visualConcept.split(/[;\n]|\.(?=\s|$)/)) {
    if (!/\b(?:infinite|loops?|looping)\b/i.test(clause)) continue;
    const tokens = clause
      .replace(/#[0-9a-f]{3,8}\b/gi, " ")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0 && !ATMOS_UNIT_TOKENS.has(t));
    for (let i = 0; i + ATMOS_NGRAM_WORDS <= tokens.length; i++) {
      grams.add(tokens.slice(i, i + ATMOS_NGRAM_WORDS).join(" "));
    }
  }
  return grams;
};

/** Minimal structural scene shape the richness contract reads. */
export interface RichnessSceneInput {
  start_seconds?: unknown;
  end_seconds?: unknown;
  visual_concept?: unknown;
  /** Scene register — widens the drawable vocabulary on type-poster registers
   *  (quote / centered / full-bleed). Optional: absent = UI vocabulary only. */
  register?: unknown;
}

/**
 * The four richness checks. Returns one error per finding (each ≤200 chars,
 * naming the scene); empty array = the script meets the contract. Consumed by
 * validateScript on the generation path so failures drive the existing
 * repair-retry loop verbatim. Non-string / missing visual_concepts are
 * skipped (structural validation owns those errors).
 */
export const checkScriptRichness = (scenes: RichnessSceneInput[]): string[] => {
  const errors: string[] = [];
  const gramScenes = new Map<string, number[]>();

  scenes.forEach((sc, i) => {
    const vc = typeof sc.visual_concept === "string" ? sc.visual_concept : "";
    if (!vc.trim()) return;

    // 1) Beat coverage — the latest explicit beat must reach ≥50% of the
    //    scene. This is where the thin failure mode lives (beats at 8-33%).
    const dur =
      typeof sc.start_seconds === "number" && typeof sc.end_seconds === "number"
        ? sc.end_seconds - sc.start_seconds
        : 0;
    if (dur >= BEAT_COVERAGE_MIN_SCENE_SECONDS) {
      const latest = latestExplicitBeat(vc);
      if (latest < dur * BEAT_COVERAGE_MIN_FRACTION) {
        const pct = Math.round((latest / dur) * 100);
        errors.push(
          `Scene ${i}: latest timed beat ${latest}s = ${pct}% of its ${dur}s — beats must reach ≥${Math.round(BEAT_COVERAGE_MIN_FRACTION * 100)}% of scene duration. Add late explicit beats (e.g. "accent bar extends at ${(dur * 0.7).toFixed(1)}s").`,
        );
      }
    }

    // 2) visual_concept floor — enough prose AND enough drawable things.
    //    Register-aware (v13): on quote/centered/full-bleed the typographic
    //    vocabulary counts too — floor value unchanged.
    const register = typeof sc.register === "string" ? sc.register : undefined;
    const typeRegister = !!register && TYPE_POSTER_REGISTERS.has(register);
    const chars = vc.trim().length;
    const nouns = countDrawableNouns(vc, register);
    if (chars < VISUAL_CONCEPT_MIN_CHARS || nouns < VISUAL_CONCEPT_MIN_NOUNS) {
      const vocabHint = typeRegister
        ? "(panel, chart, logo, bar — or, on this register, typographic artifacts: oversized numeral, type lockup, sticker, stamp, scribble...)"
        : "(panel, chart, logo, bar, mock, button...)";
      errors.push(
        `Scene ${i}: visual_concept too thin (${chars} chars, ${nouns} drawable nouns) — need ≥${VISUAL_CONCEPT_MIN_CHARS} chars AND ≥${VISUAL_CONCEPT_MIN_NOUNS} concrete drawable elements ${vocabHint}.`,
      );
    }

    // 3) Interior furnishing — a named container needs ≥2 interior specifics.
    if (CONTAINER_RX.test(vc)) {
      const interiors = countInteriorSpecifics(vc);
      if (interiors < FURNISHING_MIN_INTERIORS) {
        const phrase = (vc.match(CONTAINER_PHRASE_RX)?.[0] ?? "container")
          .trim()
          .slice(0, 40);
        errors.push(
          `Scene ${i}: names "${phrase}" but only ${interiors} interior detail(s) — a container must name ≥${FURNISHING_MIN_INTERIORS} specifics drawn inside it (rows, labels, values, tabs, feed, chart, avatar...).`,
        );
      }
    }

    // 4) Collect atmosphere grams for the cross-scene anti-copy pass.
    for (const g of motionGrams(vc)) {
      const list = gramScenes.get(g);
      if (list) list.push(i);
      else gramScenes.set(g, [i]);
    }
  });

  // Atmosphere anti-copy — quote the most widely shared phrase.
  let worst: { gram: string; scenes: number[] } | null = null;
  for (const [gram, list] of gramScenes) {
    if (list.length >= ATMOS_COPY_MIN_SCENES && (!worst || list.length > worst.scenes.length)) {
      worst = { gram, scenes: list };
    }
  }
  if (worst) {
    errors.push(
      `Scenes ${worst.scenes.join(", ")} share the same atmosphere phrase ("${worst.gram}") — give each scene motion tied to a named element of THAT scene, not copy-paste ambience.`,
    );
  }

  return errors;
};

// ─── Cold-open + anti-cliché voice (frame-authoring, 2026-07-17) ─────────────
//
// The 3-critic diagnosis found the reference wins on COPY VOICE as much as
// composition: it cold-opens on the reader's TENSION ("You know the feeling")
// while the cast opened on the brand name ("Klarna") over benefit-cliché ledes
// ("A smarter way to pay … all in one place"). The prompt now HARD-bans a
// brand-led opener and the fintech/marketing cliché family; these arms are the
// machine backstop, in the same static-check → verbatim-error → repair mechanism
// the richness contract uses. Generation-path only (validateScript richness).

/** The banned benefit-cliché family (verbatim, per the frame-authoring plan).
 *  Any of these in a headline or lede is generic marketing filler that reads as
 *  "AI slop" — the reference never uses one. Case-insensitive; no /g so .test()
 *  stays stateless. */
export const BANNED_CLICHE_RX =
  /\ba smarter way to\b|\ball in one place\b|\btreated right\b|\bstay on top of your money\b|\bshop with confidence\b|\beverything you need\b/i;

/** Normalize a string for brand-name containment (lowercase, collapse
 *  non-alphanumerics to single spaces). */
const normalizeForBrand = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Cold-open + voice checks. Returns one ≤200-char error per finding (naming the
 * scene), shaped for the generation repair loop:
 *   - the SCENE-0 headline must state the reader's TENSION, never the brand name
 *     (a brand-led opener is banned; move the brand mark to the corner/close).
 *   - no headline, lede, eyebrow, or caption may carry a banned benefit cliché
 *     (the eyebrow/caption were the escape hatch a benefit cliché slipped
 *     through in the frame-authoring dogfood).
 * `brandName` is optional — the brand-opener check is skipped without it.
 */
export const checkColdOpenVoice = (
  scenes: { content?: unknown }[],
  brandName?: string,
): string[] => {
  const out: string[] = [];
  const headlineOf = (sc: { content?: unknown }): string => {
    const c = (sc?.content ?? {}) as Record<string, unknown>;
    return typeof c.headline === "string" ? c.headline : "";
  };
  const ledeOf = (sc: { content?: unknown }): string => {
    const c = (sc?.content ?? {}) as Record<string, unknown>;
    return typeof c.lede === "string" ? c.lede : "";
  };
  const fieldOf = (sc: { content?: unknown }, field: string): string => {
    const c = (sc?.content ?? {}) as Record<string, unknown>;
    return typeof c[field] === "string" ? (c[field] as string) : "";
  };

  // Scene-0 brand-led opener — the reference's biggest voice tell.
  const brand = (brandName ?? "").trim();
  if (brand.length >= 3 && scenes.length > 0) {
    const h0 = normalizeForBrand(headlineOf(scenes[0]));
    const b = normalizeForBrand(brand);
    // Contained as a standalone token-run (word-bounded on both sides).
    const contained = b.length > 0 && new RegExp(`(^| )${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(h0);
    if (contained) {
      out.push(
        `Scene 0 headline names the brand ("${headlineOf(scenes[0]).trim().slice(0, 40)}") — a scene-0 opener must state the READER'S TENSION (the feeling/friction of the status quo), never the brand name. Move the brand mark to the corner or the closing scene, and open on the tension.`,
      );
    }
  }

  // Banned benefit clichés in any headline, lede, eyebrow, or caption (report
  // EVERY hit — a lede can stack several, and the repair prompt should name
  // them all). The eyebrow was the escape hatch: the frame-authoring dogfood
  // shipped scene 4's eyebrow "YOUR MONEY, TREATED RIGHT" — the exact
  // "[X] treated right" cliché — because the check only read headline+lede.
  const clicheG = new RegExp(BANNED_CLICHE_RX.source, "gi");
  scenes.forEach((sc, i) => {
    for (const [field, text] of [
      ["headline", headlineOf(sc)],
      ["lede", ledeOf(sc)],
      ["eyebrow", fieldOf(sc, "eyebrow")],
      ["caption", fieldOf(sc, "caption")],
    ] as const) {
      clicheG.lastIndex = 0;
      const seen = new Set<string>();
      for (const m of text.matchAll(clicheG)) {
        const phrase = m[0].toLowerCase();
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        out.push(
          `Scene ${i} ${field} uses the banned cliché "${m[0]}" ("${text.trim().slice(0, 48)}") — write concrete, second-person, present-tense copy about THIS reader's moment, not generic marketing filler.`,
        );
      }
    }
  });

  return out;
};

// ─── Composition contract (cast-doctrine blueprint checks) ───────────────
//
// The thinking head authors a per-scene SceneComposition (src/schema.ts:
// ElementSpec/SceneComposition) — what each element IS and the concrete
// inventory it must visibly contain — and the fast emitter transcribes it.
// The acceptance run showed why this must be MACHINE-checked before any
// element generates: the emitter copied template examples verbatim ("Deal
// won — $12,400" CRM rows appeared in a Duolingo language app) and
// duplicated copy across elements; the audit showed models obey checked
// rules and ignore prose. checkSceneComposition turns richness into that
// checkable contract: closed roles, hero inventories of ≥6 concrete items,
// no template-example leaks, exclusive copy ownership (including the 4b
// cross-check: an interior item may not retype copy another element owns),
// a per-scene atmosphere, and motion tied to named content. Every error is ≤200 chars,
// names the scene + element role, and is written for the verbatim-error
// repair loop. Scenes WITHOUT a composition are skipped — the head authors
// compositions; this validates what it authored, nothing else.

/** The closed role vocabulary for composition elements. */
export const COMPOSITION_ROLES = [
  "hero",
  "copy",
  "atmosphere",
  "connector",
  "throughline",
] as const;
const ROLE_SET = new Set<string>(COMPOSITION_ROLES);
const ROLES_HINT = COMPOSITION_ROLES.join("|");

/** A hero element must name at least this many interior items. */
export const HERO_INTERIOR_MIN = 6;
/** …of which at least this many must carry quoted text or a concrete value
 *  (retry root-cause audit, class 1: every hero blueprint with ≥2 quoted-text
 *  interior items rendered past the density floor; text-free logo/CTA-bookend
 *  specs produced the hollow scene-0/4 heroes that dominated gate-round
 *  spend). Diegetic micro-copy — chips, timestamps, labels, values — NOT the
 *  words of any copy field an element ownsCopy. */
export const HERO_TEXT_ITEMS_MIN = 4;
/** composition.atmosphere must be at least this many words. */
export const ATMOSPHERE_MIN_WORDS = 6;
/** Motion must quote a token of at least this length from the element's OWN interior. */
export const MOTION_TOKEN_MIN_LEN = 4;
/** Owned-copy text participates in the interior-duplication cross-check only
 *  when long enough to be unambiguous: ≥ this many words OR ≥ this many chars
 *  (short generic fragments like "Today" would false-positive on every
 *  timestamp; a real CTA/headline clears one of the floors). */
export const INTERIOR_COPY_MIN_WORDS = 4;
export const INTERIOR_COPY_MIN_CHARS = 12;

/**
 * Known template-example values that have leaked into real builds (audit +
 * acceptance evidence: the fast emitter transcribed the prompt's CRM example
 * rows — "Deal won — $12,400", "Acme Corp", "Sarah Chen" — into a Duolingo
 * language app). An interior item containing one is a verbatim template
 * copy, never a real value for the brand. Case-insensitive; deliberately no
 * /g so .test() stays stateless in loops. Extend whenever a new leak ships.
 */
export const TEMPLATE_LEAK_RX = new RegExp(
  [
    "\\$12,400",
    "\\$8,300",
    "\\bacme corp\\b",
    "\\bbeta llc\\b",
    "\\bgamma inc\\b",
    "\\bdeal won\\b",
    "\\bsarah chen\\b",
    "\\b47 deals\\b",
    "\\b152 users\\b",
    "\\b3\\.8 rating\\b",
    "john\\.doe@example\\.com",
    "\\bjohn doe\\b",
  ].join("|"),
  "i",
);

/**
 * Generic-filler vocabulary: an interior item whose meaning is carried by
 * these words ("some data rows", "sample content") names nothing the emitter
 * can draw. A digit or a quoted value anchors concreteness and overrides it
 * ("XP bar 340/500" passes on the digits).
 */
export const GENERIC_FILLER_RX =
  /\b(some|various|placeholder|sample|example|generic|content|items?|data|stuff|elements?)\b/i;

/**
 * Masked/unresolved mock values in ANY interior item (v9, the grounding
 * carve-out's flip side): plausible diegetic values are ENCOURAGED set
 * dressing, but a masked value ("$— — —", "•••", "$X,XXX") ships on screen
 * as a broken half-loaded product. Mirrors quality-gates' placeholder-data
 * lint at the BLUEPRINT stage — the cheapest place to stop it. Kept /i-only
 * (no /g) so .test() stays stateless in loops.
 */
export const MASKED_VALUE_RX =
  /[•●]{2,}|[—–]\s?[—–]|\$\s?[—–]|\$\s?X{1,3}(?![A-Za-z])|\bX{1,3}(?:,X{3})+\b|\bXX+\s?%/i;

/**
 * The over-compliance word (v9, retry evidence: v8 authored "headline
 * placeholder element" interiors — the word itself tripped the filler check
 * and, when it survives, ships verbatim on screen). Any element's interior.
 */
export const PLACEHOLDER_WORD_RX = /\bplaceholder\b/i;

// ── Hero surface-contrast mirror (v9 — the washout class at the HEAD) ──────
// The render-side hero-washout gate (lib/render/hero-contrast.ts) fires when a
// hero's painted region has neither luminance spread nor variance — measured
// dark-plum-on-dark-plum on 3/5 v8 heroes, the last gate-round driver. The
// prompt now demands one interior item NAME a contrasting surface tone; this
// static mirror enforces it BOTH directions off the RESOLVED canvas luminance
// (R7 — canvasBackground): a DARK canvas (L<0.35) demands ≥1 light/high-luminance
// hero interior surface; a LIGHT canvas (L>0.7) demands ≥1 dark/saturated one.
// R7 DELETED the DARK/LIGHT_CANVAS_RX keyword regexes on the atmosphere prose —
// they were Klarna-plum-overfit and failed OPEN on a warm/olive dark canvas whose
// prose didn't say "dark". A mid-tone canvas, or a caller that supplies no canvas
// hex, demands neither (the arm is inert rather than guessing from prose).

/** Light-surface cue words in a hero interior item. */
export const LIGHT_SURFACE_RX =
  /\b(?:white|off-white|light|pale|cream|ivory|bright|luminous|frosted|silver|snow|paper|bone|chalk|high-luminance|high-contrast)\b/i;

/** Dark/saturated-surface cue words in a hero interior item — the light-canvas
 *  arm's counterpart to LIGHT_SURFACE_RX. */
export const DARK_SURFACE_RX =
  /\b(?:dark|black|near-black|charcoal|ink|espresso|midnight|noir|obsidian|onyx|graphite|slate|deep|saturated|jet|carbon|cocoa|mahogany|plum)\b/i;

/** Rec.709 luminance (0-1) of a #hex token, or null when unparseable. */
const hexLuminance = (hex: string): number | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** An interior item names a light surface: cue word, or a light hex (L≥0.7). */
export const namesLightSurface = (item: string): boolean => {
  if (LIGHT_SURFACE_RX.test(item)) return true;
  for (const m of item.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const l = hexLuminance(m[0].slice(0, 7));
    if (l !== null && l >= 0.7) return true;
  }
  return false;
};

/** An interior item names a dark/saturated contrasting surface: cue word, or
 *  a dark hex (L≤0.35) — the light-canvas arm's mirror of namesLightSurface. */
export const namesDarkSurface = (item: string): boolean => {
  if (DARK_SURFACE_RX.test(item)) return true;
  for (const m of item.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const l = hexLuminance(m[0].slice(0, 7));
    if (l !== null && l <= 0.35) return true;
  }
  return false;
};

/** A quoted literal value inside an item ("streak flame '7'"). */
const QUOTED_VALUE_RX = /["'“”‘’][^"'“”‘’]*["'“”‘’]/;
// Glue words that can't serve as the "specific noun" of a ≥3-word item.
const GLUE_WORDS = new Set([
  "a", "an", "the", "of", "with", "and", "or", "for", "in", "on", "at",
  "to", "by", "from", "into", "onto", "over", "under", "its", "their",
  "his", "her", "that", "this",
]);

/** Truncate an authored string for quoting inside a ≤200-char error. */
const truncateForError = (s: string, max = 40): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * Why a hero interior item is not concrete. "generic" = generic-filler
 * vocabulary with nothing anchoring it; "vague" = too short / no specific
 * noun. null = concrete: a digit, a quoted value, or ≥3 words with at least
 * one non-generic non-glue word.
 */
const heroItemProblem = (item: string): "generic" | "vague" | null => {
  const t = item.trim();
  if (/\d/.test(t) || QUOTED_VALUE_RX.test(t)) return null;
  if (GENERIC_FILLER_RX.test(t)) return "generic";
  const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const hasSpecificWord = words.some((w) => {
    const core = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    return core.length >= 3 && !GLUE_WORDS.has(core) && !GENERIC_FILLER_RX.test(core);
  });
  return words.length >= 3 && hasSpecificWord ? null : "vague";
};

/** lowercase, strip hex colors + digits, collapse whitespace — the atmosphere identity. */
const normalizeAtmosphere = (s: string): string =>
  s
    .toLowerCase()
    .replace(/#[0-9a-f]{3,8}\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** ≥MOTION_TOKEN_MIN_LEN-char alphanumeric runs, lowercased. */
const MOTION_TOKEN_RX = new RegExp(`[\\p{L}\\p{N}]{${MOTION_TOKEN_MIN_LEN},}`, "gu");
const interiorTokens = (item: string): string[] =>
  Array.from(item.matchAll(MOTION_TOKEN_RX), (m) => m[0].toLowerCase());

/** Loosely-typed element for defensive reads of head-authored JSON. */
type RawElement = Partial<ElementSpec> & Record<string, unknown>;

const stringInterior = (el: RawElement): string[] =>
  Array.isArray(el?.interior)
    ? (el.interior as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

// ── Frame-authoring contract (2026-07-17) ───────────────────────────────────
// The composition head now COMPOSES THE WHOLE FRAME: per element a focalRank +
// pixel bounds, per scene a negativeSpace plan and a singularity budget. These
// checks validate what the head authored so a bad frame (dead void, corner-
// cluster, off-canvas crop, duplicate brand mark) is repaired at the HEAD (one
// thinking-on repair round) instead of shipping. Mirrors CANVAS in
// layout-composer / measure-scene (mirrored, not imported, to keep the
// validator's dependency surface at src/schema only).

export type CompAspect = "16:9" | "9:16" | "1:1";
const COMP_CANVAS: Record<CompAspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

/** Roles whose bounds compose the frame and are CONSUMED by layout-composer —
 *  the content elements. atmosphere is full-bleed; throughline is pinned to the
 *  cross-scene anchor (it legitimately overlaps the hero) and connector is a
 *  full-bleed relationship layer — both are placed deterministically, NOT from
 *  head bounds, so they are exempt from the frame bounds/disjointness checks. */
const PLACED_ROLES = new Set(["hero", "copy"]);
/** A budget owner names a role, the corner chrome lockup, or nothing. */
const BUDGET_OWNER_EXTRA = new Set(["chrome", "none"]);
/** The focalRank-1 element's center must sit within this fraction of the
 *  canvas half-extent of the optical center (not corner-jammed). */
export const FOCAL_CENTER_X_FRAC = 0.32;
export const FOCAL_CENTER_Y_FRAC = 0.34;
/** Two content bounds may overlap by at most this fraction of the smaller
 *  element's area before it reads as an undeclared collision. */
export const BOUNDS_OVERLAP_MAX_FRAC = 0.1;
/** A near-full-canvas element (a full-bleed hero) covers ≥ this fraction of
 *  the canvas; copy-over-it is the one legal overlap. */
export const FULL_CANVAS_FRAC = 0.85;
export const NEGATIVE_SPACE_MIN_WORDS = 4;

/**
 * FRAME-FILL FLOORS (P3-C3 void prevention). The head cannot author a scene
 * whose primary content (hero + copy, plus any full-bleed layer) covers too
 * little of the frame — a small focal object in a big canvas is the
 * marooned-card-in-a-void composition the render-side furnish then has to
 * rescue. Register-aware: "filling" registers (split/list/full-bleed) must fill
 * more; a "stat" scene legitimately breathes around a giant number; the default
 * (centered/quote) sits between. Calibrated on the real dogfood composition.json
 * bounds (grid-sampled hero+copy union coverage, step 24 — the exact runtime
 * metric): PASS Brex s2 53% (reference-grade) / s3 56% / s1 62% / Deel s1 62% /
 * s2 85% / s3 51% / s4 47% AND the clean frameGood test fixture (38%); CATCH the
 * genuinely marooned Brex s4 (30%, centered — the real hollow void that shipped).
 * (Deel s0 39.7% sits just above the clean fixture and is left to the render-side
 * furnish — the default floor cannot separate 39.7% from a 38% clean frame.) */
export const FILL_COVERAGE_FLOOR_FILLING = 0.45; // split / list
// Low #7: a stat scene breathes MOST around its giant number, so its floor must
// be the gentlest — it was 0.35, ABOVE the default 0.34, contradicting the
// "stat breathes most" comment. Now strictly below the default.
export const FILL_COVERAGE_FLOOR_STAT = 0.32; // stat — a big number breathes most
export const FILL_COVERAGE_FLOOR_DEFAULT = 0.34; // centered / quote / unknown
/** On a FILLING register (split/list), no canvas half may be left near-empty —
 *  an authored empty half is a split-void. (Centered/quote/stat legitimately
 *  weight the middle, so the empty-half advisory does not apply to them.) */
export const FILL_EMPTY_HALF_FLOOR = 0.12;
/** C8 #2: the BLOCKING both-columns floor — a split/list whose LEFT or RIGHT half
 *  carries less than this is an ABANDONED HALF (the head clustered the mock AND
 *  the copy on one side) and re-authors at the head, upstream of the render
 *  furnish. Set WELL below the advisory floor: the rect-union metric is
 *  anti-monotone for TOTAL coverage (a dense compact mock reads sparse — #6's
 *  reason for demoting the coverage floor to advisory) but it CANNOT make an
 *  authored-empty half read full, so an empty-HALF signal is reliable to BLOCK on.
 *  A legit asymmetric split (a slim copy column ~17% of its half, a centered list
 *  whose rows reach into both halves ~27%) clears it comfortably; only a half the
 *  head left essentially bare (< 8%) blocks. */
export const FILL_EMPTY_HALF_BLOCK_FLOOR = 0.08;
// Audit-1 High #3 edit (1): FILLING registers MIRROR the render occupancy gate.
// full-bleed is REMOVED — the render barbell/occupancy gate owns a full-bleed
// scene's voids (occupancy exempts full-bleed entirely), so the head must not
// ALSO police them (the contradiction where the head demanded a full-bleed fill
// the render side deliberately left to barbell).
const FILLING_REGISTERS = new Set(["split", "list"]);

interface RawBounds { x: number; y: number; w: number; h: number }
const readBounds = (el: RawElement): RawBounds | null => {
  const b = (el as { bounds?: unknown }).bounds;
  if (!b || typeof b !== "object") return null;
  const bb = b as Record<string, unknown>;
  const nums = ["x", "y", "w", "h"].map((k) => bb[k]);
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  return { x: bb.x as number, y: bb.y as number, w: bb.w as number, h: bb.h as number };
};

const rectArea = (b: RawBounds): number => Math.max(0, b.w) * Math.max(0, b.h);
const overlapArea = (a: RawBounds, b: RawBounds): number => {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
};

const inRect = (b: RawBounds, gx: number, gy: number): boolean =>
  gx >= b.x && gx < b.x + b.w && gy >= b.y && gy < b.y + b.h;

/** Grid-sampled union coverage of a set of rects over the canvas (0..1),
 *  handling overlaps correctly (an area union, not a naive sum). Optional
 *  half constraint measures only one half of the frame. */
const gridCoverage = (
  boxes: RawBounds[],
  W: number,
  H: number,
  half?: "L" | "R" | "T" | "B",
  step = 24,
): number => {
  let filled = 0;
  let total = 0;
  for (let gx = step / 2; gx < W; gx += step) {
    if (half === "L" && gx >= W / 2) continue;
    if (half === "R" && gx < W / 2) continue;
    for (let gy = step / 2; gy < H; gy += step) {
      if (half === "T" && gy >= H / 2) continue;
      if (half === "B" && gy < H / 2) continue;
      total++;
      if (boxes.some((b) => inRect(b, gx, gy))) filled++;
    }
  }
  return total > 0 ? filled / total : 0;
};

/** A composition is "frame-authored" when it carries ANY of the frame fields —
 *  the signal that the head composed the frame (vs a legacy/stored blueprint,
 *  which skips these checks so the pre-frame-authoring contract still loads). */
const isFrameAuthored = (comp: { negativeSpace?: unknown; budget?: unknown; elements?: unknown }): boolean => {
  if (comp.negativeSpace !== undefined || comp.budget !== undefined) return true;
  const els = Array.isArray(comp.elements) ? (comp.elements as RawElement[]) : [];
  return els.some((e) => e?.bounds !== undefined || (e as { focalRank?: unknown })?.focalRank !== undefined);
};

/**
 * The frame-composition checks for ONE frame-authored scene: bounds present +
 * in-canvas per placed element, focalRank hierarchy (exactly one rank-1, near
 * optical center), pairwise disjointness (unless a full-bleed treatment),
 * negativeSpace present, and the singularity budget satisfied. Returns ≤200-char
 * errors shaped for the head's verbatim-error repair loop.
 */
const frameCompositionErrors = (
  i: number,
  comp: { elements: RawElement[]; negativeSpace?: unknown; budget?: unknown },
  content: Record<string, unknown>,
  canvas: { w: number; h: number },
  elName: (el: RawElement, j: number) => string,
  register?: string,
): string[] => {
  const out: string[] = [];
  const { w: W, h: H } = canvas;
  const elements = comp.elements;
  const placed = elements
    .map((el, j) => ({ el, j, bounds: readBounds(el), role: typeof el?.role === "string" ? el.role : "" }))
    .filter((e) => PLACED_ROLES.has(e.role));

  // 1) BOUNDS present + inside the canvas for every placed (non-atmosphere) element.
  for (const p of placed) {
    if (!p.bounds) {
      out.push(
        `Scene ${i} ${elName(p.el, p.j)}: missing pixel bounds — every non-atmosphere element needs bounds { x, y, w, h } on the ${W}×${H} canvas so the frame is composed, not corner-clustered.`,
      );
      continue;
    }
    const { x, y, w, h } = p.bounds;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > W || y + h > H) {
      out.push(
        `Scene ${i} ${elName(p.el, p.j)}: bounds ${JSON.stringify(p.bounds)} escape the ${W}×${H} canvas (or have non-positive size) — keep every element fully on-canvas with a margin from the edges.`,
      );
    }
  }

  // 2) FOCAL RANK — exactly one rank-1, and it sits near optical center. Low #9:
  //    the uniqueness check inspects the SAME set the prompt permits to carry a
  //    focalRank — EVERY non-atmosphere element (connector/throughline included),
  //    not just hero/copy — so a second rank-1 on a throughline can't slip past.
  const rankable = elements
    .map((el, j) => ({ el, j, bounds: readBounds(el), role: typeof el?.role === "string" ? el.role : "" }))
    .filter((e) => e.role !== "" && e.role !== "atmosphere");
  const rank1 = rankable.filter((p) => Number((p.el as { focalRank?: unknown }).focalRank) === 1);
  if (rank1.length === 0) {
    out.push(
      `Scene ${i}: no element has focalRank 1 — one element must be the dominant focal object (focalRank 1), large and near the ${Math.round(W / 2)},${Math.round(H / 2)} optical center.`,
    );
  } else if (rank1.length > 1) {
    out.push(
      `Scene ${i}: ${rank1.length} elements claim focalRank 1 (${rank1.map((p) => elName(p.el, p.j)).join(", ")}) — exactly ONE element is the dominant focal object; rank the rest 2, 3, …`,
    );
  } else {
    const b = rank1[0].bounds;
    if (b) {
      const ccx = b.x + b.w / 2;
      const ccy = b.y + b.h / 2;
      if (Math.abs(ccx - W / 2) > FOCAL_CENTER_X_FRAC * W || Math.abs(ccy - H / 2) > FOCAL_CENTER_Y_FRAC * H) {
        out.push(
          `Scene ${i} ${elName(rank1[0].el, rank1[0].j)}: the focalRank-1 object's center (${Math.round(ccx)},${Math.round(ccy)}) is corner-shoved — place the dominant focal object near the optical center (${Math.round(W / 2)},${Math.round(H / 2)}), not against an edge.`,
        );
      }
    }
  }

  // 3) DISJOINTNESS — the CONSUMED hero and copy (the first of each role, the
  //    pair layout-composer actually places from head bounds) must not overlap,
  //    unless the hero is a near-full-canvas treatment (the full-bleed hero the
  //    copy sits over). Scoped to that pair: extra copy elements feed the same
  //    single copy slot, and the throughline/connector overlays overlap the
  //    hero by design — checking every pair mislabels those legal overlaps.
  const firstHero = placed.find((p) => p.role === "hero" && p.bounds);
  const firstCopy = placed.find((p) => p.role === "copy" && p.bounds);
  if (firstHero?.bounds && firstCopy?.bounds) {
    const ov = overlapArea(firstHero.bounds, firstCopy.bounds);
    const heroFullBleed = rectArea(firstHero.bounds) >= FULL_CANVAS_FRAC * W * H;
    const smaller = Math.min(rectArea(firstHero.bounds), rectArea(firstCopy.bounds));
    if (ov > 0 && !heroFullBleed && smaller > 0 && ov / smaller > BOUNDS_OVERLAP_MAX_FRAC) {
      out.push(
        `Scene ${i}: ${elName(firstHero.el, firstHero.j)} and ${elName(firstCopy.el, firstCopy.j)} bounds overlap (${Math.round((ov / smaller) * 100)}% of the smaller) — the hero and copy must sit in disjoint territory (a collision ships as interleaved, unreadable content).`,
      );
    }
  }

  // 3b) THROUGHLINE ON-CONTENT — the recurring motif must sit ON the focal
  //     object, not float pinned in the frame's negative space. A small
  //     throughline/connector whose bounds overlap NEITHER the hero NOR the copy
  //     is disconnected clutter — the render gate strips it, and stripping a
  //     floating motif can empty the scene into a void (the P3-C1 Fuse s3
  //     defect). Full-bleed connectors (a frame-spanning relationship SVG) are
  //     exempt — they legitimately own the whole canvas.
  const heroBoundsForMotif = firstHero?.bounds ?? null;
  if (heroBoundsForMotif) {
    const motifs = elements
      .map((el, j) => ({ el, j, bounds: readBounds(el), role: typeof el?.role === "string" ? el.role : "" }))
      .filter((e) => (e.role === "throughline" || e.role === "connector") && e.bounds);
    const copyBoundsForMotif = firstCopy?.bounds ?? null;
    for (const mtf of motifs) {
      const b = mtf.bounds!;
      if (rectArea(b) >= FULL_CANVAS_FRAC * W * H) continue; // full-bleed relationship layer — exempt
      const onHero = overlapArea(b, heroBoundsForMotif) > 0;
      const onCopy = copyBoundsForMotif ? overlapArea(b, copyBoundsForMotif) > 0 : false;
      if (!onHero && !onCopy) {
        out.push(
          `Scene ${i} ${elName(mtf.el, mtf.j)}: the ${mtf.role} motif's bounds ${JSON.stringify(b)} float in negative space, overlapping neither the hero nor the copy — place the recurring motif ON the focal object (inside/overlapping the hero's bounds, a chip in the mock or a marker on the chart), never pinned in the void where it gets stripped and empties the frame.`,
        );
      }
    }
  }

  // 3c) SPLIT/LIST BOTH-COLUMNS (C8 #2) — a split (or two-column list) PROMISES a
  //     filled second region: BOTH the left and right canvas halves must carry real
  //     content (hero/copy bounds). A half the head authors near-EMPTY is the
  //     Deel-s1 / Flexport-s1 abandoned-half class the render furnish then has to
  //     rescue — re-author it at the head so both columns ship carried. Scoped to
  //     the L/R axis (a split's promised columns) at FILL_EMPTY_HALF_BLOCK_FLOOR,
  //     well below the advisory floor, so a legit asymmetric split passes and only a
  //     genuinely abandoned half blocks. (Unlike #6's TOTAL-coverage floor — which
  //     is anti-monotone with pixel truth — an authored-empty HALF cannot read full,
  //     so it is a reliable blocking signal.) Only runs once the hero has bounds.
  if (register === "split" || register === "list") {
    const contentBoxes = placed.filter((p) => p.bounds).map((p) => p.bounds!);
    if (contentBoxes.length > 0 && placed.some((p) => p.role === "hero" && p.bounds)) {
      const covL = gridCoverage(contentBoxes, W, H, "L");
      const covR = gridCoverage(contentBoxes, W, H, "R");
      const bare =
        covL < FILL_EMPTY_HALF_BLOCK_FLOOR
          ? (["left", covL] as const)
          : covR < FILL_EMPTY_HALF_BLOCK_FLOOR
            ? (["right", covR] as const)
            : null;
      if (bare) {
        out.push(
          `Scene ${i}: the ${bare[0]} half of the frame carries almost no content (${Math.round(bare[1] * 100)}% covered) on a ${register} scene — a ${register} MUST place a substantive element in BOTH the left and right halves (the mock/hero column and the copy column on DIFFERENT sides). Move the copy (or a second mock/panel/rows) into the ${bare[0]} half so neither column ships abandoned.`,
        );
      }
    }
  }

  // 4) NEGATIVE SPACE — a composed plan, not an afterthought.
  const neg = comp.negativeSpace;
  if (typeof neg !== "string" || neg.trim().split(/\s+/).filter(Boolean).length < NEGATIVE_SPACE_MIN_WORDS) {
    out.push(
      `Scene ${i}: negativeSpace is required (≥${NEGATIVE_SPACE_MIN_WORDS} words) — name WHERE the deliberate emptiness lives so the frame breathes around its focal object.`,
    );
  }

  // 5) SINGULARITY BUDGET — one brand mark + one CTA, each owned by a real element.
  const budget = comp.budget as { brandMark?: unknown; cta?: unknown } | undefined;
  const roles = new Set(placed.map((p) => p.role));
  const ownerValid = (v: unknown): boolean =>
    typeof v === "string" && (BUDGET_OWNER_EXTRA.has(v) || roles.has(v));
  if (!budget || typeof budget !== "object") {
    out.push(
      `Scene ${i}: budget is required — { brandMark, cta } naming the ONE element that owns the single brand mark and the ONE that owns the single CTA (a role, "chrome", or "none").`,
    );
  } else {
    if (!ownerValid(budget.brandMark)) {
      out.push(
        `Scene ${i}: budget.brandMark "${truncateForError(String(budget.brandMark), 20)}" must name a scene element role, "chrome", or "none" — exactly one element owns the single brand mark.`,
      );
    }
    if (!ownerValid(budget.cta)) {
      out.push(
        `Scene ${i}: budget.cta "${truncateForError(String(budget.cta), 20)}" must name a scene element role, "chrome", or "none" — exactly one element owns the single CTA.`,
      );
    } else if (content.cta != null && budget.cta === "none") {
      out.push(
        `Scene ${i}: budget.cta is "none" but the scene defines a CTA — name the element that owns it (usually "copy").`,
      );
    }
  }

  // 6) FRAME FILL — Audit-1 High #3 edit (1): DEMOTED to ADVISORY. The rect-union
  //    coverage metric is ANTI-monotone with pixel truth (occupancy.ts:12-19), so
  //    blocking on it burned a head thinking round on an unreliable signal while
  //    the render-side occupancy gate + deterministic furnish are the real void
  //    authority. The coverage / empty-half checks now live in the non-blocking
  //    frameFillAdvisories() below — surfaced, never blocking, never re-authored.

  return out;
};

/**
 * FRAME-FILL ADVISORIES (Audit-1 High #3 edit (1)) — the coverage + empty-half
 * smell check, ADVISORY ONLY (rect-union is anti-monotone with pixel truth, so
 * it must never block or burn a head thinking round). Registers MIRROR the render
 * occupancy gate: full-bleed is exempt (barbell/occupancy owns its voids); split
 * / list are the filling registers; stat breathes most (gentlest floor). Returned
 * separately from checkSceneComposition so the head validate loop never re-authors
 * on it — the render-side furnish is the terminal void arbiter.
 */
export const frameFillAdvisories = (
  scenes: Scene[],
  opts: { aspect?: CompAspect } = {},
): string[] => {
  const canvas = COMP_CANVAS[opts.aspect ?? "16:9"] ?? COMP_CANVAS["16:9"];
  const { w: W, h: H } = canvas;
  const out: string[] = [];
  scenes.forEach((scene, i) => {
    const comp = scene?.composition as { elements?: unknown } | undefined;
    if (!comp || typeof comp !== "object" || !Array.isArray(comp.elements)) return;
    const register = typeof scene?.register === "string" ? scene.register : "";
    if (register === "full-bleed") return; // barbell/occupancy owns full-bleed voids
    const elements = comp.elements as RawElement[];
    const placed = elements
      .map((el, j) => ({ el, j, bounds: readBounds(el), role: typeof el?.role === "string" ? el.role : "" }))
      .filter((e) => PLACED_ROLES.has(e.role));
    if (!placed.some((p) => p.role === "hero" && p.bounds)) return;
    const fillBoxes = placed.filter((p) => p.bounds).map((p) => p.bounds!);
    for (const el of elements) {
      const b = readBounds(el);
      const role = typeof el?.role === "string" ? el.role : "";
      if (b && !PLACED_ROLES.has(role) && rectArea(b) >= FULL_CANVAS_FRAC * W * H) fillBoxes.push(b);
    }
    if (fillBoxes.length === 0) return;
    const covFloor = FILLING_REGISTERS.has(register)
      ? FILL_COVERAGE_FLOOR_FILLING
      : register === "stat"
        ? FILL_COVERAGE_FLOOR_STAT
        : FILL_COVERAGE_FLOOR_DEFAULT;
    const cov = gridCoverage(fillBoxes, W, H);
    if (cov < covFloor) {
      out.push(
        `ADVISORY — Scene ${i}: authored content covers only ${Math.round(cov * 100)}% of the ${W}×${H} frame ` +
          `(gentle floor ${Math.round(covFloor * 100)}% for a ${register || "centered"} scene) — the focal object may read ` +
          `as marooned in a void. Prefer enlarging the hero and/or placing a substantive subordinate element (a secondary ` +
          `panel, a copy stack, a footer meta strip). Non-blocking: the render-side furnish will fill any residual void.`,
      );
    }
    if (FILLING_REGISTERS.has(register)) {
      const halves: Array<["L" | "R" | "T" | "B", string]> = [
        ["L", "left"],
        ["R", "right"],
        ["T", "top"],
        ["B", "bottom"],
      ];
      const empty = halves.find(([h]) => gridCoverage(fillBoxes, W, H, h) < FILL_EMPTY_HALF_FLOOR);
      if (empty) {
        out.push(
          `ADVISORY — Scene ${i}: the ${empty[1]} half of the frame is authored near-EMPTY (a ${register} scene wants both ` +
            `sides carried) — consider giving that half a real element (the opposite column's mock/rows/tiles, a supporting ` +
            `panel). Non-blocking: the render-side furnish backfills a residual void.`,
        );
      }
    }
  });
  return out;
};

/**
 * The composition contract. Returns one error per finding (each ≤200 chars,
 * naming the scene and element role, actionable for the verbatim-error
 * repair loop); empty array = every composed scene meets the contract.
 * Scenes without a `composition` field are skipped. `opts.aspect` sets the
 * canvas the frame-authoring bounds checks validate against (default 16:9).
 */
export const checkSceneComposition = (
  scenes: Scene[],
  opts: { aspect?: CompAspect; canvasBackground?: string } = {},
): string[] => {
  const canvas = COMP_CANVAS[opts.aspect ?? "16:9"] ?? COMP_CANVAS["16:9"];
  // Medium #6: the hero surface-contrast mirror keys off the RESOLVED canvas
  // luminance (the same brand canvas the render paints), NOT a dark/light KEYWORD
  // regex on the atmosphere prose. The keyword regex fails OPEN on a warm/olive
  // dark canvas whose atmosphere text doesn't say "dark" (Klarna-plum overfit).
  // dark ⇒ L<0.35, light ⇒ L>0.7; a mid-tone canvas demands neither. Falls back
  // to the prose keywords only when no canvas hex is supplied (legacy callers).
  const canvasL = opts.canvasBackground ? hexLuminance(opts.canvasBackground) : null;
  const canvasIsDark = canvasL !== null ? canvasL < 0.35 : null;
  const canvasIsLight = canvasL !== null ? canvasL > 0.7 : null;
  const errors: string[] = [];
  // Normalized atmosphere per scene index (null = uncomposed/unusable) so
  // the variety check compares LITERAL neighbours only.
  const atmosNorm: (string | null)[] = [];

  scenes.forEach((scene, i) => {
    atmosNorm[i] = null;
    const comp = scene?.composition;
    if (!comp || typeof comp !== "object") return; // head hasn't composed this scene

    const content = (scene.content ?? {}) as Record<string, unknown>;

    // 5) ATMOSPHERE — required, ≥6 words, distinct from the previous scene's.
    const atmosphere = (comp as { atmosphere?: unknown }).atmosphere;
    if (typeof atmosphere !== "string" || !atmosphere.trim()) {
      errors.push(
        `Scene ${i}: composition.atmosphere is required — ≥${ATMOSPHERE_MIN_WORDS} words describing THIS scene's own ambient treatment.`,
      );
    } else {
      const words = atmosphere.trim().split(/\s+/).length;
      if (words < ATMOSPHERE_MIN_WORDS) {
        errors.push(
          `Scene ${i}: composition.atmosphere is ${words} word(s) — need ≥${ATMOSPHERE_MIN_WORDS} words describing THIS scene's own ambient treatment.`,
        );
      }
      const norm = normalizeAtmosphere(atmosphere);
      if (norm && atmosNorm[i - 1] === norm) {
        errors.push(
          `Scenes ${i - 1} and ${i}: same atmosphere ("${truncateForError(norm, 48)}") — adjacent scenes need distinct ambient treatments.`,
        );
      }
      atmosNorm[i] = norm || null;
    }

    const rawElements = (comp as { elements?: unknown }).elements;
    if (!Array.isArray(rawElements) || rawElements.length === 0) {
      errors.push(
        `Scene ${i}: composition.elements must be a non-empty array of element specs (roles: ${ROLES_HINT}).`,
      );
      return;
    }
    const elements = rawElements as RawElement[];
    // Display name for errors: the authored role when present, else the index.
    const elName = (el: RawElement, j: number): string =>
      typeof el?.role === "string" && el.role.trim()
        ? truncateForError(el.role.trim(), 16)
        : `element ${j}`;

    // 1) ROLES — closed set; ≥1 hero and ≥1 copy per composed scene.
    let heroCount = 0;
    let copyCount = 0;
    elements.forEach((el, j) => {
      const role = el?.role;
      if (typeof role !== "string" || !ROLE_SET.has(role)) {
        errors.push(
          `Scene ${i} element ${j}: role "${truncateForError(String(role), 20)}" invalid — must be one of ${ROLES_HINT}.`,
        );
        return;
      }
      if (role === "hero") heroCount++;
      else if (role === "copy") copyCount++;
    });
    if (heroCount === 0) {
      errors.push(
        `Scene ${i}: composition has no hero element — every composed scene needs ≥1 element with role "hero" carrying its main visual.`,
      );
    }
    if (copyCount === 0) {
      errors.push(
        `Scene ${i}: composition has no copy element — every composed scene needs ≥1 element with role "copy" owning its on-screen text.`,
      );
    }

    // 2) HERO INVENTORY — ≥6 interior items, each concrete.
    // 3) TEMPLATE-LEAK + MASKED-VALUE + PLACEHOLDER-WORD GUARDS — every
    //    element's interior.
    // 2b) HERO SURFACE CONTRAST (v9; v10 canvas-agnostic) — the static mirror
    //     of the render-side hero-washout gate, BOTH directions: a dark
    //     atmosphere demands ≥1 light/high-luminance surface item; a light
    //     atmosphere (Glossier pale pink) demands ≥1 dark/saturated one. The
    //     dark reading wins when both vocabularies match.
    // R7 (audit-2): the surface arm keys ONLY on the resolved canvas luminance —
    // the prose keyword fallback is deleted. No canvas hex ⇒ both null ⇒ inert.
    const atmosphereReadsDark = canvasIsDark === true;
    const atmosphereReadsLight = canvasIsLight === true;
    elements.forEach((el, j) => {
      const interior = stringInterior(el);
      if (el?.role === "hero") {
        if (interior.length < HERO_INTERIOR_MIN) {
          errors.push(
            `Scene ${i} hero: ${interior.length} interior item(s) — a hero needs ≥${HERO_INTERIOR_MIN} concrete interior items, real values authored for this brand and scene.`,
          );
        }
        // Bookend-hero density contract (retry audit class 1): the interior
        // must SAY things — ≥4 items carrying quoted text or a concrete
        // value. Text-free logo/CTA-bookend inventories render hollow.
        const textBearing = interior.filter(
          (item) => /\d/.test(item) || QUOTED_VALUE_RX.test(item),
        ).length;
        if (textBearing < HERO_TEXT_ITEMS_MIN) {
          errors.push(
            `Scene ${i} hero: only ${textBearing} of ${interior.length} interior item(s) carry quoted text or a concrete value — a hero needs ≥${HERO_TEXT_ITEMS_MIN} text-bearing items (chips, timestamps, labels, values with real micro-copy).`,
          );
        }
        if (atmosphereReadsDark && interior.length > 0 && !interior.some(namesLightSurface)) {
          errors.push(
            `Scene ${i} hero: atmosphere reads dark but no interior item names a light/high-contrast surface — add one item naming the hero's primary panel tone (e.g. a crisp off-white panel surface).`,
          );
        }
        if (atmosphereReadsLight && interior.length > 0 && !interior.some(namesDarkSurface)) {
          errors.push(
            `Scene ${i} hero: atmosphere reads light but no interior item names a dark/saturated contrasting surface — add one item naming the hero's primary panel tone (e.g. a deep ink panel on the pale canvas).`,
          );
        }
        for (const item of interior) {
          const problem = heroItemProblem(item);
          if (problem === "generic") {
            errors.push(
              `Scene ${i} hero: interior item "${truncateForError(item)}" is generic filler — name the real thing with a real value ("XP bar 340/500", not "some data rows").`,
            );
          } else if (problem === "vague") {
            errors.push(
              `Scene ${i} hero: interior item "${truncateForError(item)}" is not concrete — give it a digit, a quoted value, or ≥3 words naming a specific thing.`,
            );
          }
        }
      }
      for (const item of interior) {
        if (TEMPLATE_LEAK_RX.test(item)) {
          errors.push(
            `Scene ${i} ${elName(el, j)}: interior item "${truncateForError(item)}" is a template example value — author real values for THIS brand.`,
          );
        }
        if (MASKED_VALUE_RX.test(item)) {
          errors.push(
            `Scene ${i} ${elName(el, j)}: interior item "${truncateForError(item)}" carries a masked value — mock-UI set dressing must be a plausible concrete value ("$18.50", never "$— — —"/"•••"/"$X,XXX").`,
          );
        } else if (PLACEHOLDER_WORD_RX.test(item)) {
          errors.push(
            `Scene ${i} ${elName(el, j)}: interior item "${truncateForError(item)}" contains the word "placeholder" — describe the widget concretely ("headline set in display type"), never as a placeholder.`,
          );
        }
      }
    });

    // 4) OWNERSHIP — ownsCopy fields exist in content, are exclusive, and
    //    collectively cover the headline.
    const owners = new Map<string, string[]>();
    elements.forEach((el, j) => {
      if (!Array.isArray(el?.ownsCopy)) return;
      const name = elName(el, j);
      for (const field of el.ownsCopy as unknown[]) {
        if (typeof field !== "string") continue;
        if (content[field] === undefined || content[field] === null) {
          errors.push(
            `Scene ${i} ${name}: ownsCopy field "${truncateForError(field, 24)}" is not in scene.content — own only fields the scene actually defines.`,
          );
          continue;
        }
        const list = owners.get(field);
        if (list) list.push(name);
        else owners.set(field, [name]);
      }
    });
    for (const [field, list] of owners) {
      if (list.length > 1) {
        errors.push(
          `Scene ${i}: content field "${truncateForError(field, 24)}" owned by ${list.length} elements (${truncateForError(list.join(", "), 40)}) — each field needs exactly one owner.`,
        );
      }
    }
    if (!owners.has("headline")) {
      errors.push(
        `Scene ${i}: no element owns "headline" — ownsCopy must collectively cover the headline (give it to the copy element).`,
      );
    }

    // 4b) INTERIOR-COPY CROSS-CHECK — no element's interior[] item may
    //     contain copy text another element ownsCopy (case-insensitive
    //     substring; only values ≥INTERIOR_COPY_MIN_WORDS words or
    //     ≥INTERIOR_COPY_MIN_CHARS chars participate). Acceptance v6: the
    //     head authored the copy-owned "Get the app" CTA verbatim inside
    //     s4's hero interior, so the CTA painted TWICE — ownership was
    //     exclusive on paper while the interior inventory forked the text.
    const copyValuesFor = (field: string): string[] => {
      const v = content[field];
      if (typeof v === "string") return [v];
      if (Array.isArray(v)) {
        return v.flatMap((item) =>
          typeof item === "string"
            ? [item]
            : item && typeof item === "object"
              ? Object.values(item).filter((s): s is string => typeof s === "string")
              : [],
        );
      }
      if (v && typeof v === "object") {
        return Object.values(v).filter((s): s is string => typeof s === "string");
      }
      return [];
    };
    const unambiguousCopy = (t: string): boolean =>
      t.split(/\s+/).filter(Boolean).length >= INTERIOR_COPY_MIN_WORDS ||
      t.length >= INTERIOR_COPY_MIN_CHARS;
    elements.forEach((ownerEl, ownerIdx) => {
      if (!Array.isArray(ownerEl?.ownsCopy)) return;
      const ownerName = elName(ownerEl, ownerIdx);
      for (const field of ownerEl.ownsCopy as unknown[]) {
        if (typeof field !== "string") continue;
        for (const raw of copyValuesFor(field)) {
          const value = raw.trim();
          if (!value || !unambiguousCopy(value)) continue;
          const needle = value.toLowerCase();
          elements.forEach((el, j) => {
            if (j === ownerIdx) return;
            const hit = stringInterior(el).find((item) => item.toLowerCase().includes(needle));
            if (hit) {
              errors.push(
                `Scene ${i} ${elName(el, j)}: interior item "${truncateForError(hit)}" retypes copy owned by ${ownerName} ("${truncateForError(value, 32)}") — interiors must not duplicate another element's copy.`,
              );
            }
          });
        }
      }
    });

    // 6) MOTION — at least one element's motion quotes its OWN interior.
    const motionTied = elements.some((el) => {
      if (typeof el?.motion !== "string" || !el.motion.trim()) return false;
      const motion = el.motion.toLowerCase();
      return stringInterior(el).some((item) =>
        interiorTokens(item).some((t) => motion.includes(t)),
      );
    });
    if (!motionTied) {
      errors.push(
        `Scene ${i}: no element's motion references its own interior — tie one motion beat to a ≥${MOTION_TOKEN_MIN_LEN}-char token from that element's interior items.`,
      );
    }

    // 7) FRAME COMPOSITION (frame-authoring) — bounds/focalRank/negativeSpace/
    //    budget, validated only when the head actually composed the frame (a
    //    legacy blueprint carrying none of these fields is left to the
    //    pre-frame-authoring contract above).
    if (isFrameAuthored(comp as { negativeSpace?: unknown; budget?: unknown; elements?: unknown })) {
      errors.push(
        ...frameCompositionErrors(
          i,
          comp as unknown as { elements: RawElement[]; negativeSpace?: unknown; budget?: unknown },
          content,
          canvas,
          elName,
          typeof scene?.register === "string" ? scene.register : undefined,
        ),
      );
    }
  });

  return errors;
};

// ── Ungrounded mock-value deny-list (v10 — dogfood cycle 1) ─────────────────
// The mock-value carve-out lets blueprints author plausible diegetic set
// dressing (prices, balances, timestamps inside a fake UI). Cycle 1 showed the
// model INVENTING fact-shaped values under that cover: an "EST 2024" badge
// (the brand is EST 2017 — copy in the SAME video says so) and a "20% OFF"
// promo chip. Both classes state a checkable brand FACT (founding date, an
// active promotion), so they are only allowed when the token appears in a
// grounding source. Deliberately NARROW: exactly these two regex classes —
// the carve-out stays open for genuinely diegetic values.

export const UNGROUNDED_MOCK_VALUE_CLASSES: {
  rx: RegExp;
  label: string;
  /** What must appear in a grounding source for the token to pass. The EST
   *  badge grounds on its YEAR ("Founded in 2017" grounds "EST 2017" — the
   *  badge phrasing is the designer's, the fact is the year); a promo grounds
   *  on the literal offer. */
  groundKey: (token: string) => string;
}[] = [
  {
    rx: /\bEST\.?\s*(?:19|20)\d{2}\b/gi,
    label: "founding-date badge",
    groundKey: (t) => /(?:19|20)\d{2}/.exec(t)?.[0] ?? t,
  },
  { rx: /\b\d{1,2}\s*%\s*OFF\b/gi, label: "promo discount", groundKey: (t) => t },
];

const normalizeForGrounding = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Fact-shaped mock values in composed scenes' interior/subject strings that no
 * grounding source states. Returns one ≤200-char error per hit, shaped for
 * the head's verbatim-error repair loop. Scenes without compositions skip.
 */
export const findUngroundedMockValues = (scenes: Scene[], groundingText: string): string[] => {
  const errors: string[] = [];
  const grounded = normalizeForGrounding(groundingText);
  scenes.forEach((scene, i) => {
    const comp = scene?.composition;
    if (!comp || typeof comp !== "object") return;
    const rawElements = (comp as { elements?: unknown }).elements;
    if (!Array.isArray(rawElements)) return;
    (rawElements as RawElement[]).forEach((el, j) => {
      const name =
        typeof el?.role === "string" && el.role.trim() ? truncateForError(el.role.trim(), 16) : `element ${j}`;
      const strings = [
        ...stringInterior(el),
        ...(typeof el?.subject === "string" ? [el.subject] : []),
      ];
      for (const item of strings) {
        for (const cls of UNGROUNDED_MOCK_VALUE_CLASSES) {
          cls.rx.lastIndex = 0;
          for (const m of item.matchAll(cls.rx)) {
            const token = m[0];
            if (grounded.includes(normalizeForGrounding(cls.groundKey(token)))) continue;
            errors.push(
              `Scene ${i} ${name}: "${truncateForError(token, 24)}" (in "${truncateForError(item, 36)}") is a ${cls.label} no grounding source states — mock set dressing must never invent brand facts; drop it or use the real value.`,
            );
          }
        }
      }
    });
  });
  return errors;
};

/** Case- and whitespace-insensitive equality for short copy strings. */
const sameCopy = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, " ") ===
  b.trim().toLowerCase().replace(/\s+/g, " ");

// A `meta` value is the BIG number in a KPI tile (or a terse footer datum). It
// must be short — a stat ("$1.4T", "99.99%", "135+") or a short datum ("Series
// B", "Mar 2025", "Jane Doe"). GLM sometimes files a DESCRIPTION into `value`
// instead ({label:"Volume", value:"in payments volume processed in 2025"}),
// which renders a KPI tile with a blank number slot. A value that is a phrase
// (too many words / too long) is malformed regardless of brand.
const META_VALUE_MAX_WORDS = 4;
const META_VALUE_MAX_CHARS = 32;
const metaValueIsTerse = (value: string): boolean => {
  const v = value.trim();
  if (!v) return false;
  if (v.length > META_VALUE_MAX_CHARS) return false;
  return v.split(/\s+/).filter(Boolean).length <= META_VALUE_MAX_WORDS;
};

/**
 * Pre-validation content normalizer (pure — returns a cloned object, never
 * mutates input). Strips `content.meta` entries whose `value` is prose rather
 * than a terse stat/datum, so a value-less KPI tile (blank number slot) never
 * reaches the design pass. If a scene's meta empties out, the `meta` key is
 * removed so the design renders no tile grid at all (better than an empty one).
 * Any shape it doesn't recognise is left untouched — validateScript owns shape
 * errors; this only prunes well-formed-but-prose meta values.
 */
export const normalizeScriptContent = (input: unknown): unknown => {
  if (!input || typeof input !== "object") return input;
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.scenes)) return input;
  let changed = false;
  const dropped: string[] = [];
  const scenes = root.scenes.map((sc) => {
    if (!sc || typeof sc !== "object") return sc;
    const scene = sc as Record<string, unknown>;
    const content = scene.content;
    if (!content || typeof content !== "object") return sc;
    const c = content as Record<string, unknown>;
    if (!Array.isArray(c.meta)) return sc;
    const kept = c.meta.filter((m) => {
      // Leave malformed shapes for validateScript to reject; only judge well-
      // formed {label,value} string pairs here.
      if (!m || typeof m !== "object") return true;
      const mm = m as Record<string, unknown>;
      if (typeof mm.value !== "string") return true;
      const ok = metaValueIsTerse(mm.value);
      if (!ok) dropped.push(mm.value);
      return ok;
    });
    if (kept.length === c.meta.length) return sc;
    changed = true;
    const nextContent: Record<string, unknown> = { ...c };
    if (kept.length === 0) delete nextContent.meta;
    else nextContent.meta = kept;
    return { ...scene, content: nextContent };
  });
  if (!changed) return input;
  console.warn(
    `[script] normalized meta: dropped ${dropped.length} prose-as-value KPI entr${dropped.length === 1 ? "y" : "ies"} (${dropped
      .map((d) => `"${d}"`)
      .join(", ")})`,
  );
  return { ...root, scenes };
};

const SCENE_REGISTERS = ["stat", "quote", "full-bleed", "split", "list", "centered"] as const;

/**
 * Backfill missing/invalid scene registers. GLM sometimes omits `register`
 * wholesale (Duolingo shipped 5×null while Loom got all five) and everything
 * downstream keyed on it then silently no-ops: exemplar selection injects
 * nothing, the Design Agent loses its per-scene layout archetype, and
 * register-variety reads 0 distinct. Deterministic content heuristic, then a
 * no-two-adjacent-same nudge — same rule the script prompt states.
 */
export const backfillSceneRegisters = (input: unknown): unknown => {
  if (!input || typeof input !== "object") return input;
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.scenes)) return input;
  const sceneList: unknown[] = root.scenes;
  const isValid = (r: unknown): r is (typeof SCENE_REGISTERS)[number] =>
    typeof r === "string" && (SCENE_REGISTERS as readonly string[]).includes(r);
  const missing = sceneList.filter(
    (sc) => sc && typeof sc === "object" && !isValid((sc as Record<string, unknown>).register),
  ).length;
  if (missing === 0) return input;

  const infer = (scene: Record<string, unknown>, index: number, last: number): string => {
    const c = (scene.content ?? {}) as Record<string, unknown>;
    const headline = typeof c.headline === "string" ? c.headline : "";
    const meta = Array.isArray(c.meta) ? c.meta : [];
    const bullets = Array.isArray(c.bullets) ? c.bullets : [];
    const numericMeta = meta.some(
      (m) => m && typeof m === "object" && /\d/.test(String((m as Record<string, unknown>).value ?? "")),
    );
    if (bullets.length >= 3) return "list";
    if (numericMeta && /\d/.test(headline)) return "stat";
    if (/^["'“].*["'”]$/.test(headline.trim())) return "quote";
    if (index === 0) return "full-bleed";
    if (index === last) return "centered";
    return "split";
  };

  const registers: string[] = sceneList.map((sc, i) => {
    const scene = (sc ?? {}) as Record<string, unknown>;
    return isValid(scene.register) ? scene.register : infer(scene, i, sceneList.length - 1);
  });
  // No two adjacent the same: nudge later duplicates to a register unused by
  // either neighbor (prefer one not yet used anywhere for variety).
  for (let i = 1; i < registers.length; i++) {
    if (registers[i] !== registers[i - 1]) continue;
    const next = registers[i + 1];
    const candidate =
      SCENE_REGISTERS.find((r) => !registers.includes(r) && r !== registers[i - 1] && r !== next) ??
      SCENE_REGISTERS.find((r) => r !== registers[i - 1] && r !== next);
    if (candidate) registers[i] = candidate;
  }
  console.warn(`[script] backfilled register for ${missing}/${registers.length} scene(s): ${registers.join(", ")}`);
  return {
    ...root,
    scenes: sceneList.map((sc, i) =>
      sc && typeof sc === "object" ? { ...(sc as Record<string, unknown>), register: registers[i] } : sc,
    ),
  };
};

export interface ValidateScriptOptions {
  /**
   * Script-richness contract (beat coverage / visual_concept floor /
   * interior furnishing / atmosphere anti-copy — see checkScriptRichness).
   * ON by default: validateScript's production caller is the generation
   * repair loop (lib/agents/script-generator.ts), where a failure feeds
   * back as a verbatim error for one repair call, so default-on means
   * "generation path only". The contract applies to NEWLY GENERATED
   * scripts — any loader validating a STORED script must pass
   * `{ richness: false }` (stored scripts predate the contract and must
   * keep loading).
   */
  richness?: boolean;
  /**
   * Brand name for the cold-open check (checkColdOpenVoice): a scene-0 headline
   * that names the brand is a brand-led opener and is rejected. Optional — the
   * brand-opener arm is skipped without it (the cliché arm still runs). Only
   * consulted on the richness (generation) path.
   */
  brandName?: string;
}

export const validateScript = (
  input: unknown,
  opts: ValidateScriptOptions = {},
): ValidationResult => {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Output is not a JSON object." };
  }
  const s = input as Record<string, unknown>;

  // Top-level required keys
  for (const key of ["config", "brief", "assets", "scenes"]) {
    if (!(key in s)) {
      return { ok: false, error: `Missing top-level key: ${key}` };
    }
  }

  // Config sanity
  const config = s.config as Record<string, unknown>;
  if (typeof config.duration_seconds !== "number" || config.duration_seconds <= 0) {
    return { ok: false, error: "config.duration_seconds must be a positive number." };
  }
  // Hard cap matches BriefForm.DURATION_MAX. Keeps cost predictable
  // and gives the dead-air pacing rules a duration they can satisfy.
  if (config.duration_seconds > 60) {
    return {
      ok: false,
      error: `config.duration_seconds is ${config.duration_seconds}s — exceeds the 60s cap. Reduce duration or split into a follow-up video.`,
    };
  }
  if (!["16:9", "9:16", "1:1"].includes(config.aspect_ratio as string)) {
    return {
      ok: false,
      error: `config.aspect_ratio must be one of "16:9" | "9:16" | "1:1", got ${String(config.aspect_ratio)}`,
    };
  }

  const totalSeconds = config.duration_seconds as number;

  // Narrative spine — OPTIONAL. We never fail on absence (back-compat
  // with pre-narrative scripts), but if the agent emits it, the shape
  // must be sane so the Design Agent can rely on it downstream.
  const narrative = s.narrative;
  if (narrative !== undefined && narrative !== null) {
    if (typeof narrative !== "object") {
      return {
        ok: false,
        error: "narrative must be an object with { logline, arc, throughline? } when present.",
      };
    }
    const n = narrative as Record<string, unknown>;
    if (typeof n.logline !== "string" || !n.logline.trim()) {
      return {
        ok: false,
        error: "narrative.logline must be a non-empty string (one sentence: who it's for, the tension, the transformation).",
      };
    }
    if (typeof n.arc !== "string" || !n.arc.trim()) {
      return {
        ok: false,
        error: "narrative.arc must be a non-empty string describing how the story moves across the sections.",
      };
    }
    if (n.throughline !== undefined && typeof n.throughline !== "string") {
      return { ok: false, error: "narrative.throughline must be a string when present." };
    }
  }

  // Uncertainty decisions — OPTIONAL (absence = the brief was unambiguous).
  // When emitted, each must be answerable: a question, 2-4 options, and the
  // first option is the working assumption the build proceeds on.
  const decisions = s.decisions;
  if (decisions !== undefined && decisions !== null) {
    if (!Array.isArray(decisions)) {
      return { ok: false, error: "decisions must be an array when present." };
    }
    if (decisions.length > 3) {
      return { ok: false, error: "decisions: at most 3 — surface only genuinely consequential choices." };
    }
    const seenIds = new Set<string>();
    for (let i = 0; i < decisions.length; i++) {
      const d = decisions[i] as Record<string, unknown>;
      if (typeof d !== "object" || d === null) {
        return { ok: false, error: `decisions[${i}] must be an object.` };
      }
      if (typeof d.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.id)) {
        return { ok: false, error: `decisions[${i}].id must be a kebab-case slug.` };
      }
      if (seenIds.has(d.id)) {
        return { ok: false, error: `decisions[${i}].id "${d.id}" is duplicated.` };
      }
      seenIds.add(d.id);
      if (typeof d.question !== "string" || !d.question.trim()) {
        return { ok: false, error: `decisions[${i}].question must be a non-empty string.` };
      }
      if (d.context !== undefined && typeof d.context !== "string") {
        return { ok: false, error: `decisions[${i}].context must be a string when present.` };
      }
      if (
        !Array.isArray(d.options) ||
        d.options.length < 2 ||
        d.options.length > 4 ||
        d.options.some((o) => typeof o !== "string" || !o.trim())
      ) {
        return { ok: false, error: `decisions[${i}].options must be 2-4 non-empty strings (first = working assumption).` };
      }
      if (d.resolved !== undefined && typeof d.resolved !== "string") {
        return { ok: false, error: `decisions[${i}].resolved must be a string when present.` };
      }
    }
  }

  // Scenes must tile [0, totalSeconds]
  const scenes = s.scenes as unknown;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: "scenes must be a non-empty array." };
  }
  const firstScene = scenes[0] as Record<string, unknown>;
  if (firstScene.start_seconds !== 0) {
    return {
      ok: false,
      error: `scenes[0].start_seconds must be 0, got ${String(firstScene.start_seconds)}`,
    };
  }
  const lastScene = scenes[scenes.length - 1] as Record<string, unknown>;
  if (!approxEqual(lastScene.end_seconds as number, totalSeconds)) {
    return {
      ok: false,
      error: `scenes[${scenes.length - 1}].end_seconds must equal ${totalSeconds} (the brief duration), got ${String(lastScene.end_seconds)}`,
    };
  }
  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1] as Record<string, unknown>;
    const cur = scenes[i] as Record<string, unknown>;
    if (!approxEqual(prev.end_seconds as number, cur.start_seconds as number)) {
      return {
        ok: false,
        error: `Section boundary mismatch at index ${i}: previous end_seconds=${String(prev.end_seconds)} but current start_seconds=${String(cur.start_seconds)}.`,
      };
    }
  }

  // Each scene must have visual_concept and content
  for (const [idx, raw] of (scenes as Record<string, unknown>[]).entries()) {
    const scene = raw;
    if (typeof scene.visual_concept !== "string" || !scene.visual_concept.trim()) {
      return {
        ok: false,
        error: `Scene ${idx} missing or empty visual_concept. Every scene needs a 1-2 sentence visual_concept describing the chosen visual approach.`,
      };
    }
    if (typeof scene.label !== "string" || !scene.label.trim()) {
      return {
        ok: false,
        error: `Scene ${idx} missing or empty label.`,
      };
    }
    const content = scene.content as Record<string, unknown> | undefined;
    if (!content || typeof content !== "object") {
      return {
        ok: false,
        error: `Section ${idx} missing content. Provide the structured content fields (headline + optional eyebrow / lede / bullets / meta / caption / cta / illustration / asset_ids).`,
      };
    }

    // headline — required, readable, length-capped
    const headline = content.headline;
    if (typeof headline !== "string" || !headline.trim()) {
      // Legacy fallback: if texts[0] is present and readable, accept it.
      const legacy = Array.isArray(content.texts) && typeof (content.texts as unknown[])[0] === "string"
        ? ((content.texts as unknown[])[0] as string)
        : "";
      if (!legacy) {
        return {
          ok: false,
          error: `Section ${idx} missing required content.headline. Every section needs a hero text string (the main thing the viewer reads).`,
        };
      }
    } else if (!isReadableText(headline.trim()) && !STAT_HEADLINE_RX.test(headline.trim())) {
      // STAT_HEADLINE_RX (retry audit class 5): the 'stat' register MANDATES
      // bare-numeral headlines (src/schema.ts SceneRegister — "one massive
      // number/metric") and the prompt's own worked examples model them
      // ("30%", "24", "2x") — so a pure-numeral headline like "4" is valid
      // by design, while emoji/symbol-only headlines still fail.
      return {
        ok: false,
        error: `Section ${idx} content.headline "${headline}" is not readable. Must contain at least 2 letters/digits (a pure numeral like "24" or "3x" is allowed for stat scenes).`,
      };
    } else if (isReadableText(headline.trim())) {
      const problem = headlineProblem(headline);
      if (problem) {
        return { ok: false, error: `Section ${idx} content.headline ${problem}` };
      }
    }

    // lede — optional, length-capped
    const lede = content.lede;
    if (lede !== undefined) {
      if (typeof lede !== "string") {
        return { ok: false, error: `Section ${idx} content.lede must be a string.` };
      }
      if (lede.trim() && !isReadableText(lede.trim())) {
        return { ok: false, error: `Section ${idx} content.lede is not readable.` };
      }
      if (lede.length > 280) {
        return { ok: false, error: `Section ${idx} content.lede is ${lede.length} chars; cap at 280. Keep ledes to 1-2 sentences.` };
      }
    }

    // bullets — optional, array of strings, each readable + length-capped
    const bullets = content.bullets;
    if (bullets !== undefined) {
      if (!Array.isArray(bullets)) {
        return { ok: false, error: `Section ${idx} content.bullets must be an array of strings.` };
      }
      for (const [i, b] of bullets.entries()) {
        if (typeof b !== "string") {
          return { ok: false, error: `Section ${idx} content.bullets[${i}] must be a string.` };
        }
        if (!isReadableText(b.trim())) {
          return { ok: false, error: `Section ${idx} content.bullets[${i}] "${b}" is not readable.` };
        }
        if (b.length > 120) {
          return { ok: false, error: `Section ${idx} content.bullets[${i}] is ${b.length} chars; cap at 120.` };
        }
      }
    }

    // caption — optional, length-capped
    const caption = content.caption;
    if (caption !== undefined) {
      if (typeof caption !== "string") {
        return { ok: false, error: `Section ${idx} content.caption must be a string.` };
      }
      if (caption.trim() && !isReadableText(caption.trim())) {
        return { ok: false, error: `Section ${idx} content.caption is not readable.` };
      }
      if (caption.length > 140) {
        return { ok: false, error: `Section ${idx} content.caption is ${caption.length} chars; cap at 140.` };
      }
    }

    // meta — optional, array of {label, value}
    const meta = content.meta;
    if (meta !== undefined) {
      if (!Array.isArray(meta)) {
        return { ok: false, error: `Section ${idx} content.meta must be an array of {label,value} pairs.` };
      }
      for (const [i, m] of meta.entries()) {
        if (!m || typeof m !== "object") {
          return { ok: false, error: `Section ${idx} content.meta[${i}] must be a {label,value} object.` };
        }
        const mm = m as Record<string, unknown>;
        if (typeof mm.label !== "string" || typeof mm.value !== "string") {
          return { ok: false, error: `Section ${idx} content.meta[${i}] needs string label + value.` };
        }
      }
    }

    // cta — optional, primary required if present. Treat null as absent: GLM
    // sometimes emits `"cta": null`, and `null !== undefined` is true while
    // `typeof null === "object"` — so the old `!== undefined` guard fell through
    // to `cta.primary` and threw "Cannot read properties of null (reading
    // 'primary')", 500ing the generate. `!= null` catches null AND undefined.
    const cta = content.cta as Record<string, unknown> | null | undefined;
    if (cta != null) {
      if (typeof cta !== "object") {
        return { ok: false, error: `Section ${idx} content.cta must be an object with { primary, secondary? }.` };
      }
      if (typeof cta.primary !== "string" || !cta.primary.trim()) {
        return { ok: false, error: `Section ${idx} content.cta.primary required when cta is set.` };
      }
      // The CTA pill is an ACTION surface — it must carry a verb, not echo the
      // headline. A pill that repeats the hero line wastes the one place the
      // viewer is told what to DO. (Shipped twice unguarded — Tailscale, then
      // Ramp's "See how Ramp works" as BOTH the hero headline and the button.)
      if (typeof headline === "string" && sameCopy(cta.primary, headline)) {
        return {
          ok: false,
          error: `Section ${idx} content.cta.primary "${cta.primary}" duplicates the headline. The CTA must be a distinct action label — a verb the viewer acts on ("Get a demo", "Start free", "Book a walkthrough") — not an echo of the hero line.`,
        };
      }
    }

    // illustration — optional, must be a non-empty string if present
    const illustration = content.illustration;
    if (illustration !== undefined) {
      if (typeof illustration !== "string" || !illustration.trim()) {
        return { ok: false, error: `Section ${idx} content.illustration must be a non-empty string identifier.` };
      }
    }

    // Legacy texts[] — still validate if present (back-compat)
    const texts = content.texts;
    if (texts !== undefined) {
      if (!Array.isArray(texts)) {
        return { ok: false, error: `Section ${idx} content.texts (legacy) must be an array of strings.` };
      }
      for (const [i, t] of texts.entries()) {
        if (typeof t !== "string") {
          return { ok: false, error: `Section ${idx} content.texts[${i}] must be a string.` };
        }
        if (!isReadableText(t.trim())) {
          return { ok: false, error: `Section ${idx} content.texts[${i}] "${t}" is not readable.` };
        }
      }
    }

    // asset_ids — required (array, possibly empty)
    const assetIds = content.asset_ids;
    if (!Array.isArray(assetIds)) {
      return {
        ok: false,
        error: `Section ${idx} content.asset_ids must be an array of strings (use [] if none).`,
      };
    }
  }

  // Richness contract — LAST, so structural errors surface first and the
  // repair call always works against a structurally sound script. Skipped
  // for stored scripts via opts.richness === false (back-compat).
  if (opts.richness !== false) {
    // Archetype variety (v9 — the sequence judge's standing finding since v6:
    // "4 consecutive split layouts"): no register may run 3+ scenes in a row.
    // Generation-path only (register is a generation-era field; stored scripts
    // opt out with the rest of the richness contract). backfillSceneRegisters'
    // no-two-adjacent nudge means backfilled scripts pass by construction.
    const regs = (scenes as Record<string, unknown>[]).map((sc) =>
      typeof sc.register === "string" ? sc.register : "",
    );
    for (let i = 2; i < regs.length; i++) {
      if (regs[i] && regs[i] === regs[i - 1] && regs[i] === regs[i - 2]) {
        return {
          ok: false,
          error: `Scenes ${i - 2}-${i} all use register "${regs[i]}" — no register may appear 3+ times in a row. Reassign at least one of them (stat | quote | full-bleed | split | list | centered) and keep its visual_concept consistent with the new register.`,
        };
      }
    }
    const richness = checkScriptRichness(scenes as RichnessSceneInput[]);
    if (richness.length > 0) {
      return { ok: false, error: richness.join(" | ") };
    }
    // Cold-open + anti-cliché voice (frame-authoring): scene-0 opens on the
    // reader's tension (brand name banned as an opener), no benefit clichés.
    const voice = checkColdOpenVoice(
      scenes as { content?: unknown }[],
      opts.brandName,
    );
    if (voice.length > 0) {
      return { ok: false, error: voice.join(" | ") };
    }
  }

  return { ok: true, script: input as Script };
};

/**
 * Two seconds-values count as the same boundary if they're within 0.001s
 * of each other. Allows for floating-point round-trip noise from the
 * agent (e.g., 2.6666666 vs 8/3).
 */
const approxEqual = (a: number, b: number): boolean => Math.abs(a - b) < 0.001;

/**
 * A pure-numeral stat headline ("4", "24", "30%", "3x", "10×", "135+") — the
 * shape the 'stat' register mandates. isReadableText demands ≥2 letters/digits,
 * which rejected the single-digit class ("4") on every attempt (retry audit
 * class 5: a recurring schema/prompt-vs-validator self-contradiction).
 */
const STAT_HEADLINE_RX = /^\p{N}+[%x×+]?$/u;

/**
 * Returns true if `text` is something a viewer can read.
 *
 * Heuristic: at least two characters that are letters or digits
 * (Unicode letter/number classes). Emojis, single bars, decorative
 * symbols all fail this check.
 */
const isReadableText = (text: string): boolean => {
  if (text.length < 2) return false;
  const readable = text.match(/[\p{L}\p{N}]/gu);
  return (readable?.length ?? 0) >= 2;
};
