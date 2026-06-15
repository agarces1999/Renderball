import type { Script } from "../../src/schema";

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
const DIEGETIC_ELEMENT_RX =
  /\b(panels?|cards?|dashboards?|mock(?:up)?s?|diagrams?|charts?|graphs?|mesh|nodes?|grids?|tables?|browser|windows?|devices?|phones?|laptops?|screens?|interface|map|timeline|counter|trust[\s-]?bar|logos?|illustration|screenshots?|spinner|badges?|gauge|meter|tiles?|avatars?|photos?|images?|flow(?:chart)?|connectors?|sparkline|histogram|kpi|widgets?|popup|terminal|console|editor|rows?|product|constellation|waveform|dial|ledger|receipts?|invoices?|documents?)\b/i;
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

/** Case- and whitespace-insensitive equality for short copy strings. */
const sameCopy = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, " ") ===
  b.trim().toLowerCase().replace(/\s+/g, " ");

export const validateScript = (input: unknown): ValidationResult => {
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

    // cta — optional, primary required if present
    const cta = content.cta as Record<string, unknown> | undefined;
    if (cta !== undefined) {
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
