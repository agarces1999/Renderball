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
