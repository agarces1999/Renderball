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

export const findUngroundedClaims = (
  scriptText: string,
  sourceText: string,
): string[] => {
  const nums = indexSourceNumbers(sourceText);
  const percentiles = new Set(
    Array.from(sourceText.matchAll(PERCENTILE_RX), (m) => m[0].toLowerCase()),
  );
  const out: string[] = [];
  for (const token of extractStatClaims(scriptText)) {
    const claim = parseClaim(token);
    if (!claim) continue;
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

/** Naive singular so "cards"/"card" count once ("mesh"/"glass" unaffected). */
const singularize = (w: string): string =>
  w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

/** Distinct concrete drawable nouns named in a visual_concept. */
export const countDrawableNouns = (visualConcept: string): number => {
  const seen = new Set<string>();
  for (const m of visualConcept.matchAll(DRAWABLE_NOUN_RX)) {
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
const ATMOS_UNIT_TOKENS = new Set(["s", "ms", "px", "x", "deg", "em"]);

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
    const chars = vc.trim().length;
    const nouns = countDrawableNouns(vc);
    if (chars < VISUAL_CONCEPT_MIN_CHARS || nouns < VISUAL_CONCEPT_MIN_NOUNS) {
      errors.push(
        `Scene ${i}: visual_concept too thin (${chars} chars, ${nouns} drawable nouns) — need ≥${VISUAL_CONCEPT_MIN_CHARS} chars AND ≥${VISUAL_CONCEPT_MIN_NOUNS} concrete drawable elements (panel, chart, logo, bar, mock, button...).`,
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

/**
 * The composition contract. Returns one error per finding (each ≤200 chars,
 * naming the scene and element role, actionable for the verbatim-error
 * repair loop); empty array = every composed scene meets the contract.
 * Scenes without a `composition` field are skipped.
 */
export const checkSceneComposition = (scenes: Scene[]): string[] => {
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
    // 3) TEMPLATE-LEAK GUARD — every element's interior.
    elements.forEach((el, j) => {
      const interior = stringInterior(el);
      if (el?.role === "hero") {
        if (interior.length < HERO_INTERIOR_MIN) {
          errors.push(
            `Scene ${i} hero: ${interior.length} interior item(s) — a hero needs ≥${HERO_INTERIOR_MIN} concrete interior items, real values authored for this brand and scene.`,
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
    } else if (!isReadableText(headline.trim())) {
      return {
        ok: false,
        error: `Section ${idx} content.headline "${headline}" is not readable. Must contain at least 2 letters/digits.`,
      };
    } else {
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
    const richness = checkScriptRichness(scenes as RichnessSceneInput[]);
    if (richness.length > 0) {
      return { ok: false, error: richness.join(" | ") };
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
