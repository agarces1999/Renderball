/**
 * CAST ORCHESTRATOR — the element-cast build path on the Cerebras provider
 * (speed-quality pivot, 2026-07-14).
 *
 * Doctrine: elements generate INDEPENDENTLY and in parallel against
 * PRE-SETTLED contracts — correctness comes from construction, not
 * detect-and-retry. This module owns no cleverness of its own; it sequences
 * the modules that each make one defect class unrepresentable:
 *
 *   - layout-composer  settles every element's territory (bounds, content
 *     ownership, palette roles, declared overlaps) BEFORE any code exists,
 *     so two blind generators can never claim the same pixels.
 *   - cast-provider    is the transport (OpenAI-wire, tight token caps,
 *     effort dial — "think at the head, emit at the leaves").
 *   - normalize-element hue-locks every emitted color into the brand's
 *     vocabulary, so off-brand hues cannot ship.
 *   - assemble         re-inlines the bodies into the exact Composition.tsx
 *     contract the whole validated render stack consumes.
 *   - choreograph      compiles motion deterministically (zero tokens),
 *     pacing correct by construction.
 *
 * COMPOSITION CONSUMPTION (2026-07-16): when a scene carries a
 * SceneComposition blueprint (authored by composition-head.ts, attached as
 * scene.composition), element briefs LEAD with it — subject + verbatim
 * interior inventory + explicit copy ownership + motion beat — and the
 * generic checklist/archetype/menu text stays out. Spec presence also
 * OVERRIDES the connector keyword heuristic and strengthens the unowned-copy
 * guard's ownership inputs. Scenes without a composition build exactly as
 * before (back-compat by construction).
 *
 * On top of the sequencing, this module owns the DETERMINISTIC POST-PASSES
 * that close the four measured gpt-oss defect classes (cast spike run 1 +
 * parity audit, 2026-07-15) at zero tokens: `${keyframe}` interpolation
 * rewrite, canvas-scale self-positioning rebase, unowned-copy strip, and the
 * paint-time color-mutation (invert/hue-rotate) guard. Same doctrine as
 * normalize-element: rewrite the defect out, don't ask nicely and retry.
 *
 * Failure posture: an element that stays broken after ONE surgical repair is
 * substituted with a minimal safe placeholder and COUNTED — the build
 * completes degraded rather than dying, and telemetry reports it honestly.
 * A final composition that does not compile, by contrast, THROWS: that is an
 * orchestrator bug, never a runtime condition.
 */
import type { Script, ElementSpec } from "../../src/schema";
import type { Theme, SceneManifest, Piece } from "../edit/piece-model";
import { castCall, isFireworksModel, type CastEffort } from "../llm/cast-provider";
import { composeSceneLayout, CANVAS, type Aspect, type ElementSlot, type ScenePlan } from "./layout-composer";
import { normalizeElementColors, assessAccentPresence, hexToRgb, rgbToHsl, isNeutral } from "./normalize-element";
import { assembleComposition } from "./assemble";
import { applyChoreography } from "./choreograph";
import { stripCodeFence, verifyCompilable } from "./code-extraction";
import { AccountLimiter } from "./account-limiter";

// ─── Public contract ────────────────────────────────────────────────────────

export interface CastBuildInput {
  /** From the existing script agent — unchanged by the cast path. */
  script: Script;
  /** The frozen design system. The caller supplies it (head workload / stored
   *  theme); the orchestrator never derives one. */
  theme: Theme;
  /** Brand hex palette — the hue vocabulary normalize-element locks to. */
  palette: string[];
  /** Brand signature hex; drives the accent-presence check (detection only). */
  signatureAccent?: string;
  aspect: Aspect;
}

export interface CastBuildResult {
  /** Final Composition.tsx — assembled, choreographed, compile-verified. */
  code: string;
  /** The manifests the assembler consumed (piece ids, bounds, slugs). */
  scenes: SceneManifest[];
  telemetry: {
    /** Non-chrome slots that earned a generation call. */
    elements: number;
    /** Elements that ended as placeholders (broken through the one repair). */
    failures: number;
    /** Elements the ONE repair retry actually recovered. */
    repairs: number;
    /** Output tokens across every call, including failed + repair calls. */
    tokensOut: number;
    wallSeconds: number;
    /** Total off-brand color rewrites in shipped bodies ("what would have
     *  shipped off-brand"). */
    normalizedColors: number;
    /** Foreign fontFamily values rewritten to theme faces + root bindings
     *  injected ("what would have shipped off-face"). */
    fontRewrites: number;
    /** True when the ink guard neutralized a chromatic body-text color on the
     *  incoming theme (see neutralizeInk). */
    inkCorrected: boolean;
    /** Hero bodies whose primary panel was lifted to the theme's contrast
     *  token because every flat panel sat within ΔL<15 of the canvas
     *  (see ensureHeroSurfaceContrast — the deterministic washout backstop). */
    heroSurfaceCorrections: number;
    /** Meta-text segments (leaked reasoning prose rendered as JSX text nodes)
     *  stripped from shipped bodies (v11 — the cycle-2 s2 leak class). */
    metaTextStrips: number;
  };
  /**
   * Per-element outcome — which pieces shipped the MODEL's body (repaired or
   * not) and which shipped the PLACEHOLDER. Callers that cache emissions must
   * invalidate entries for failed pieces (acceptance v7 run-1 swap bug: a
   * syntax-valid but gate-failed emission stayed cached while the placeholder
   * shipped, so every later round regenerated against a body that never
   * rendered and re-measured the placeholder's byte-identical density).
   */
  elementOutcomes: { pieceId: string; failed: boolean; repaired: boolean }[];
}

// ─── Per-slot output ceilings ───────────────────────────────────────────────

/**
 * Honest per-slot output caps. Cerebras PRE-DEBITS max_completion_tokens
 * against the TPM bucket BEFORE generating (see cast-provider.ts) — a lazy
 * 40k cap on a 3k element starves the rest of the burst — so each slot gets
 * the measured shape of its workload and nothing more. The HERO cap is
 * PROVIDER-AWARE (see maxTokensFor): the pre-debit is real on Cerebras only.
 */
const MAX_TOKENS_BY_SLOT: Record<string, number> = {
  // 3500, not 2000 (acceptance v6 poisoned-cache postmortem, 2026-07-16):
  // working atmospheres measured 1563-1834 tok, but v6's s1/s2 atmospheres
  // truncated at EXACTLY 2000 (stop=length) and shipped as placeholders —
  // the cap was the whole failure. 3500 clears the measured shape ~2x.
  atmosphere: 3500, // gradient washes / glow / grain — compact
  connector: 3000, // the full-bleed SVG connector system (≥12 primitives)
  copy: 2500, // the editorial text stack
  throughline: 1500, // one small motif
};
/** The diegetic visual on CEREBRAS — the honest measured shape (~5.7k tok
 *  enriched-brief mocks, audit-matrix condition E) under a REAL pre-debit:
 *  Cerebras debits max_completion_tokens from the TPM bucket before
 *  generating, so an inflated cap starves the rest of the burst. */
export const HERO_MAX_TOKENS_CEREBRAS = 6000;
/** The hero cap on FIREWORKS (retry audit class 8): Fireworks has NO
 *  pre-debit — an unused ceiling costs nothing there — and v7 run 2 wasted
 *  37s truncating a rich hero at exactly 6000. 11000 covers the measured
 *  rich-hero + repair shape with honest headroom. Repairs share this cap. */
export const HERO_MAX_TOKENS_FIREWORKS = 11000;

export const maxTokensFor = (slotId: string, model?: string): number => {
  if (slotId === "hero") {
    const effective = model ?? process.env.RB_CAST_MODEL ?? "gpt-oss-120b";
    return isFireworksModel(effective) ? HERO_MAX_TOKENS_FIREWORKS : HERO_MAX_TOKENS_CEREBRAS;
  }
  return MAX_TOKENS_BY_SLOT[slotId] ?? 4000;
};

/**
 * Reasoning-effort routing, measured on gpt-oss (parity audit 2026-07-15):
 * effort MEDIUM is the sweet spot for DIEGETIC pieces — the enriched-brief
 * interior gain (3.3x) needs it. Effort HIGH is HARMFUL (≈80k reasoning chars,
 * broken markers) — never route anything there. LOW is fine for the
 * copy/atmosphere/throughline workloads ("think at the head, emit at the
 * leaves" — these leaves barely need to think).
 */
const EFFORT_BY_SLOT: Record<string, CastEffort> = {
  hero: "medium",
  connector: "medium",
};

/**
 * MIXED-CASTING MODEL ROUTING (acceptance v3 finding, 2026-07-16): the drawing
 * workloads (hero/connector — the diegetic visual + the SVG relationship
 * system) and the leaf workloads (copy/atmosphere/throughline) have different
 * craft profiles, so each side is independently overridable:
 *   hero/connector → RB_CAST_MODEL_HERO
 *   everything else → RB_CAST_MODEL_LEAVES
 * Both optional; undefined defers to the provider's own resolution
 * (RB_CAST_MODEL → gpt-oss-120b), so a single-model world is unchanged.
 */
export const modelFor = (kind: string): string | undefined =>
  (kind === "hero" || kind === "connector"
    ? process.env.RB_CAST_MODEL_HERO
    : process.env.RB_CAST_MODEL_LEAVES) || undefined;

/**
 * Effort routing is MODEL-aware (Cerebras dials differ per family, verified
 * acceptance v3 2026-07-16):
 *   - zai-glm-*: "none" is the ONLY valid off switch (graded low/medium are
 *     gpt-oss features; leaving effort unset lets GLM think expensively).
 *   - gemma-*:   no reasoning dial at all — the param must be OMITTED.
 *   - gpt-oss (and anything unrecognized): the measured medium/low slot
 *     routing above.
 * `model` is the per-call override; when absent the effective model is what
 * the provider will resolve (RB_CAST_MODEL → gpt-oss-120b).
 */
export const effortFor = (slotId: string, model?: string): CastEffort | undefined => {
  const effective = model ?? process.env.RB_CAST_MODEL ?? "gpt-oss-120b";
  // Any GLM lineage (Cerebras zai-glm-* OR Fireworks accounts/.../glm-5p2*):
  // elements run thinking-OFF — "none" maps to each provider's true off
  // switch in cast-provider (reasoning_effort:"none" / thinking:{disabled}).
  if (/(^|\/)(zai-)?glm-/.test(effective) || effective.includes("/glm-5p")) return "none";
  if (effective.startsWith("gemma-")) return undefined;
  return EFFORT_BY_SLOT[slotId] ?? "low";
};

// ─── Shared conventions ─────────────────────────────────────────────────────

/**
 * Mirrors pipeline.ts `slugify` — the slug the throughline presence/drift
 * gates count off `data-throughline`. Mirrored, not imported: pipeline.ts
 * pulls the SDK/store world and this module must stay a testable leaf (the
 * same reasoning layout-composer applies to CANVAS_DIMS).
 */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Palette-role → theme-const aliases. The composer speaks ROLES (canvas/ink/
 *  accent); the theme's palette keys are whatever const names the head emitted
 *  (BG, ACCENT, INK, …) — grammar carries the surface tokens explicitly. */
const ROLE_ALIASES: Record<string, string[]> = {
  canvas: ["bg", "canvas", "background"],
  ink: ["ink", "fg", "text"],
  accent: ["accent", "primary", "brand"],
};

/** Resolve a composer palette ROLE to the actual theme const NAME an element
 *  must paint with. grammar owns the surface tokens; the rest resolve by
 *  alias against the palette keys (exact match first, then substring),
 *  falling back to the first key so a sparse theme degrades, not dies. */
const tokenForRole = (theme: Theme, role: string): string => {
  if (role === "panelBg") return theme.grammar.panelBg;
  if (role === "hairline") return theme.grammar.hairline;
  const keys = Object.keys(theme.palette);
  for (const alias of ROLE_ALIASES[role] ?? [role.toLowerCase()]) {
    const hit =
      keys.find((k) => k.toLowerCase() === alias) ??
      keys.find((k) => k.toLowerCase().includes(alias));
    if (hit) return hit;
  }
  return keys[0];
};

// ─── Deterministic post-passes ──────────────────────────────────────────────
// Each pass makes one MEASURED gpt-oss element defect unrepresentable, at zero
// tokens, before the fragment gate runs. Exported for tests.

/**
 * (a) Keyframe-interpolation rewrite. gpt-oss generalizes the palette-const
 * pattern to the shared @keyframes names and emits
 * `animation: \`${fadeRise} 0.6s …\`` — a JS identifier interpolation. It
 * PASSES esbuild (the fragment gate binds no identifiers) but throws
 * ReferenceError the moment a Section renders, killing every scene — 54 hits
 * in cast-spike run 1 (scripts/cast-spike.ts, where this rewrite was proven
 * spike-side). `${name}` → the literal CSS name, for every name declared in
 * the theme's shared keyframes or in the body itself.
 */
export const rewriteKeyframeInterpolations = (
  body: string,
  themeKeyframes: string,
): { code: string; rewrites: number } => {
  const names = new Set<string>();
  for (const src of [themeKeyframes, body]) {
    for (const m of src.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) names.add(m[1]);
  }
  let rewrites = 0;
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue; // hyphenated names can't be `${}` refs
    body = body.replace(new RegExp(`\\$\\{\\s*${n}\\s*\\}`, "g"), () => {
      rewrites++;
      return n;
    });
  }
  return { code: body, rewrites };
};

/**
 * (b) Self-positioning strip. The contract says the WRAPPER owns placement —
 * an element that absolutely positions its own root at CANVAS coordinates
 * (left/top too large to be a local offset inside its own w×h wrapper) gets
 * double-offset and paints outside its slot. Rebase such a root to the
 * wrapper origin; the wrapper (assemble.ts) already sits at the slot's canvas
 * position. Local offsets (left/top within the wrapper's extent) pass through.
 */
export const stripCanvasSelfPositioning = (
  body: string,
  bounds: { w: number; h: number },
): { code: string; stripped: boolean } => {
  const start = body.indexOf("<");
  if (start === -1) return { code: body, stripped: false };
  // Find the root tag's closing ">" with a brace/quote-aware scan — style
  // expressions legally contain ">" (arrow fns, comparisons).
  let depth = 0;
  let quote: string | null = null;
  let tagEnd = -1;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) {
      tagEnd = i;
      break;
    }
  }
  if (tagEnd === -1) return { code: body, stripped: false };
  const rootTag = body.slice(start, tagEnd);
  if (!/position\s*:\s*["'`]absolute["'`]/.test(rootTag)) return { code: body, stripped: false };
  const num = (prop: string): number | null => {
    const m = new RegExp(`\\b${prop}\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)(?:px)?"?`).exec(rootTag);
    return m ? Number(m[1]) : null;
  };
  const left = num("left");
  const top = num("top");
  // Canvas-scale: an offset no local child could have inside this wrapper.
  const canvasScale = (left !== null && left > bounds.w) || (top !== null && top > bounds.h);
  if (!canvasScale) return { code: body, stripped: false };
  const rebased = rootTag
    .replace(/\bleft\s*:\s*"?-?\d+(?:\.\d+)?(?:px)?"?/, "left: 0")
    .replace(/\btop\s*:\s*"?-?\d+(?:\.\d+)?(?:px)?"?/, "top: 0");
  return { code: body.slice(0, start) + rebased + body.slice(tagEnd), stripped: true };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * (c) Unowned-copy guard. Content-field ownership lives in the SLOT (layout
 * composer invariant d): a piece that renders another element's copy verbatim
 * forks the text — it paints twice, and a later content edit updates only the
 * owner. Where the offense is a text node EXACTLY equal to the unowned value
 * (the measured form — bare or a quoted string expression), strip it
 * deterministically; anything subtler stays in `residual` for the caller to
 * route to the surgical-repair retry with a verbatim error.
 */
export const stripUnownedCopy = (
  body: string,
  unownedValues: string[],
): { code: string; stripped: string[]; residual: string[] } => {
  const stripped: string[] = [];
  const residual: string[] = [];
  for (const value of unownedValues) {
    const v = value.trim();
    if (!v) continue;
    // v11: also match the value minus trailing punctuation, case-insensitively
    // (dogfood cycle 2 s4: the hero retyped "Come as you are" with the period
    // in a nested accent span — the exact-value node never existed — and the
    // eyebrow retyped in a different case). The variant strips/rejects the
    // SAME theft the exact form was built for; a case-different exact-length
    // retype is still the owner's copy painted twice.
    const bare = v.replace(/[.!?…:,;]+$/u, "").trim();
    const variants = [...new Set([v, bare].filter((x) => x.length >= 3))];
    const present = (src: string): boolean =>
      variants.some((x) => new RegExp(escapeRegExp(x), "i").test(src));
    if (!present(body)) continue;
    let next = body;
    for (const x of variants) {
      const esc = escapeRegExp(x);
      next = next
        .replace(new RegExp(`>\\s*${esc}\\s*<`, "gi"), "><") // >VALUE<
        .replace(new RegExp(`>\\s*\\{\\s*(["'\`])${esc}\\1\\s*\\}\\s*<`, "gi"), "><"); // >{"VALUE"}<
    }
    if (next !== body) {
      stripped.push(v);
      body = next;
    }
    if (present(body)) residual.push(v);
  }
  return { code: body, stripped, residual };
};

/**
 * (d) Paint-time color-mutation guard. `filter: invert(…)` / `hue-rotate(…)`
 * flip brand colors AFTER the hue-lock has run — the emitted hexes read
 * on-brand to normalize-element while painting off-brand pixels, invisibly to
 * the whole color stack. Strip those declarations; benign filters
 * (blur/drop-shadow/…) survive untouched.
 */
const MUTATING_FILTER = /(?:invert|hue-rotate)\s*\(/i;

export const stripColorMutationFilters = (body: string): { code: string; stripped: number } => {
  let stripped = 0;
  // Style-object form: filter: "…" / WebkitFilter: '…' / backdropFilter: `…`.
  // The optional trailing comma is consumed; a leftover trailing comma on the
  // previous prop is legal TSX either way.
  let out = body.replace(
    /\b(?:filter|WebkitFilter|backdropFilter)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)\s*,?/g,
    (m, val: string) => {
      if (!MUTATING_FILTER.test(val)) return m;
      stripped++;
      return "";
    },
  );
  // CSS-string form (inside appended keyframes / style strings).
  out = out.replace(
    /(?:-webkit-|backdrop-)?filter\s*:\s*[^;{}"'`\n]*(?:invert|hue-rotate)\s*\([^;{}]*;?/gi,
    () => {
      stripped++;
      return "";
    },
  );
  return { code: out, stripped };
};

/**
 * (d5) Masked bullet-run strip (v10 — dogfood cycle 1: one "●●●" run leaked
 * into s3's mock footer and shipped as the structural placeholder_data class).
 * A run of 2+ bullet glyphs is the masked-value signature the placeholder
 * lint rejects (quality-gates `[•●]{2,}`); a SINGLE bullet is legitimate UI
 * chrome (separators, kebab dots, list markers). Collapse every run to one
 * bullet deterministically at cast time — zero tokens, no repair round.
 */
export const stripMaskedValueRuns = (body: string): { code: string; stripped: number } => {
  let stripped = 0;
  const code = body.replace(/[•●]{2,}/g, () => {
    stripped++;
    return "•";
  });
  return { code, stripped };
};

/**
 * (d6) META-TEXT LEAK detector + strip (v11 — dogfood cycle 2, worst defect).
 * A regen emitted its chain-of-reasoning ("Looking at the QA findings: the
 * headline text … My wrapper is 720px wide starting at x=120 … I cap content
 * width at ~480px") as VISIBLE JSX text nodes. It compiled (prose is a legal
 * JSX text child), PADDED the density metrics, and vision called the scene
 * clean — so the only reliable arm is deterministic and PRE-RENDER, at the
 * element gate.
 *
 * Detection is vocabulary + structure on the piece's rendered TEXT SEGMENTS
 * (leading prose before the first tag, and `>text<` runs between tags —
 * expressions/attributes/strings are masked by the walk, so style values and
 * CSS never false-fire):
 *   - VOCABULARY: self-referential repair speech — "QA findings", "my
 *     wrapper", piece-id tokens (s2.hero), coordinate math prose ("720px
 *     wide", "at x=120"), first-person planning verbs ("I cap", "I
 *     constrain"), "previous attempt/version", "max-width" as prose.
 *   - STRUCTURE: a sentence-length segment (>120 chars) carrying px
 *     coordinates or first-person planning language — reasoning prose is
 *     long; brand copy that long never talks in px or plans in first person.
 * Repair posture: STRIP flagged segments deterministically (zero tokens).
 * Only a body whose flagged prose dominates its text (the emission IS the
 * reasoning) rejects to the surgical repair — a fresh emission beats
 * surgery on a husk. Calibrated on the cycle-2 s2 leak (MUST fire) and every
 * prior clean build (MUST pass) — see cast-build.test.ts.
 */
export interface JsxTextSegment {
  start: number;
  end: number;
  text: string;
}

/** JSX text runs of a fragment: leading text before the first tag plus
 *  between-tag runs, split on `{…}` expressions, with strings inside
 *  tags/expressions quote-masked. Segments with <3 letters are dropped. */
export const extractJsxTextSegments = (body: string): JsxTextSegment[] => {
  const segs: JsxTextSegment[] = [];
  let depth = 0; // brace depth (JSX expressions / style objects)
  let quote: string | null = null;
  let inTag = false;
  let segStart = 0;
  const flush = (end: number): void => {
    if (end <= segStart) return;
    const text = body.slice(segStart, end);
    if (/[A-Za-z]{3,}/.test(text)) segs.push({ start: segStart, end, text });
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (inTag || depth > 0) {
      // Block comments ({/* … */} and /* … */ inside style objects) skip
      // whole: a prose apostrophe inside a comment ("the scene's glow")
      // would otherwise open quote mode and desync the walk.
      if (ch === "/" && body[i + 1] === "*") {
        const close = body.indexOf("*/", i + 2);
        i = close === -1 ? body.length : close + 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0 && !inTag) segStart = i + 1; // expression closed — resume text
      } else if (ch === ">" && depth === 0 && inTag) {
        inTag = false;
        segStart = i + 1;
      }
      continue;
    }
    // Text territory (outside tags, outside expressions). Quotes here are
    // prose apostrophes, never string delimiters.
    if (ch === "<") {
      flush(i);
      inTag = true;
    } else if (ch === "{") {
      flush(i);
      depth = 1;
    }
  }
  flush(body.length);
  return segs;
};

/** Self-referential repair vocabulary — any hit in a rendered text segment is
 *  meta-text by construction (no brand copy speaks piece-ids or wrapper px). */
export const META_TEXT_VOCAB_RX =
  /\bQA (?:finding|gate|feedback)|\bmy wrapper\b|\bthe wrapper (?:is|was|ends|starts|owns)\b|\bprevious (?:attempt|version|output)\b|\bblocking finding|\bs\d+\.(?:hero|copy|atmosphere|connector|throughline)\b|\bdata-content-path\b|\b\d+px (?:wide|tall|high)\b|\bat x=-?\d+|\bat y=-?\d+|\b[xy]=-?\d+(?:px)?\b|\bI (?:cap|capped|constrain|clamp|reposition|re-?emit|shift|shrink|reduce)\b|\bLooking at the (?:QA|findings?|brief|blueprint)\b|\bmax-width\b|\boverlapping the (?:panel|slot|column)\b/;

const META_TEXT_STRUCT_MIN_CHARS = 120;
const META_PX_COORD_RX = /\b\d+(?:\.\d+)?px\b|\b[xy]\s*=\s*-?\d+/;
const META_FIRST_PERSON_RX = /(?:^|[^\w])(?:I|my|we|our)(?:$|[^\w])/;
const META_PLANNING_RX =
  /\b(?:cap|caps|capped|constrain(?:s|ed)?|clamp(?:s|ed)?|reposition(?:s|ed)?|resiz(?:e|es|ed)|shift(?:s|ed)?|shrink(?:s)?|reduc(?:e|es|ed)|overlap(?:s|ped|ping)?|exceed(?:s|ed)?|wrapper|bounds|width|coordinates?)\b/i;

/** Is this rendered text segment self-referential build/repair prose? */
export const isMetaTextSegment = (text: string): boolean => {
  const t = text.trim();
  if (t.length < 3) return false;
  if (META_TEXT_VOCAB_RX.test(t)) return true;
  return (
    t.length > META_TEXT_STRUCT_MIN_CHARS &&
    (META_PX_COORD_RX.test(t) || (META_FIRST_PERSON_RX.test(t) && META_PLANNING_RX.test(t)))
  );
};

/** Fraction above which flagged prose DOMINATES the body's rendered text —
 *  the emission is the reasoning; reject for a fresh emission over surgery. */
export const META_TEXT_REJECT_FRAC = 0.4;

export const stripMetaText = (
  body: string,
): { code: string; stripped: string[]; reject: boolean } => {
  const segs = extractJsxTextSegments(body);
  const flagged = segs.filter((s) => isMetaTextSegment(s.text));
  if (flagged.length === 0) return { code: body, stripped: [], reject: false };
  const totalTextLen = segs.reduce((n, s) => n + s.text.trim().length, 0);
  const flaggedLen = flagged.reduce((n, s) => n + s.text.trim().length, 0);
  const reject = totalTextLen > 0 && flaggedLen / totalTextLen > META_TEXT_REJECT_FRAC;
  let code = body;
  for (const s of [...flagged].reverse()) {
    code = code.slice(0, s.start) + code.slice(s.end);
  }
  return { code, stripped: flagged.map((s) => s.text.trim().slice(0, 160)), reject };
};

/**
 * (d2) PRE-RENDER hero density gate (retry audit class 1). The hollow-bookend
 * hero class (scene 0/4 logo/CTA bookends measuring 1el/0tx post-render) was
 * the single largest retry sink: each one cost a full render+vision gate
 * round (44-100s) when the emission itself already proved the hollowness.
 * This computes the density probe's ARITHMETIC (element descendants +
 * non-empty text nodes — density-gates.ts countElementDescendants/
 * countTextNodes) statically on the emitted JSX, so a hollow hero fails
 * INSIDE the cast round and triggers the existing ~10s surgical repair.
 *
 * Counting rules (string-aware, brace-tolerant):
 *   - elements: every `<Tag` open outside string literals (closing tags
 *     excluded); tags inside map callbacks / conditionals count once.
 *   - text: JSX text runs between tags (string contents masked first so
 *     `>`/`<` inside style strings cannot fabricate runs), plus `{c.*}`
 *     bindings, plus quoted-literal child expressions (`{"$18.50"}`), plus
 *     the items of quoted-string ARRAYS when the body maps over data (the
 *     rows-from-an-array idiom).
 * The estimate UNDER-counts SSR truth for mapped content (each item counts
 * once, not per render) — conservative-safe on rich bodies, and still an
 * order of magnitude above the hollow class (1el/0tx vs the ≥15el/≥4tx bar).
 */
export const PRE_RENDER_HERO_MIN_ELEMENTS = 15;
export const PRE_RENDER_HERO_MIN_TEXT = 4;

export const staticJsxDensity = (body: string): { elements: number; textNodes: number } => {
  // String-masked copy: literal contents → spaces (offsets preserved) so tag
  // and text scans can't be fooled by `<`/`>` inside strings.
  let masked = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") { masked += "  "; i++; continue; }
      if (ch === quote) { quote = null; masked += ch; continue; }
      masked += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    masked += ch;
  }
  // Open tags only — `</` closings and `<` comparisons never match `<Letter`.
  const elements = (masked.match(/<[A-Za-z]/g) ?? []).length;
  let textNodes = 0;
  // JSX text runs between tags (no braces/tags inside the run).
  for (const m of masked.matchAll(/>([^<>{}]+)</g)) {
    if (/[\p{L}\p{N}]{2,}/u.test(m[1])) textNodes++;
  }
  // {c.*} bindings — each is a rendered text node.
  textNodes += (body.match(/\{\s*c\.[A-Za-z]/g) ?? []).length;
  // Quoted-literal child expressions: {"Ships Thursday"} / {'62%'} / {`…`}.
  for (const m of body.matchAll(/\{\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1\s*\}/g)) {
    if (/[\p{L}\p{N}]{2,}/u.test(m[2])) textNodes++;
  }
  // Data-array strings rendered via .map(…): count each word-bearing item.
  if (/\.map\s*\(/.test(body)) {
    for (const arr of body.matchAll(/\[\s*(?:["'][^"'\n]{0,120}["']\s*,\s*)+["'][^"'\n]{0,120}["']\s*\]/g)) {
      for (const s of arr[0].matchAll(/["']([^"'\n]*)["']/g)) {
        if (/[\p{L}\p{N}]{2,}/u.test(s[1])) textNodes++;
      }
    }
  }
  return { elements, textNodes };
};

/**
 * (d3) PRE-RENDER img-src gate + asset-id substitution (retry audit class 1,
 * img-src arm). The render-time whitelist (density-gates clause d) caught raw
 * asset ids like "site_img_0" only AFTER a full render round; here the same
 * whitelist runs on the emission, and KNOWN asset ids are SUBSTITUTED with
 * their crawled URLs from the script manifest at zero tokens — the model
 * naming a real asset by id is correct behavior, not a defect. Unknown
 * non-fetchable srcs remain a gate failure (→ the in-round repair). Only
 * quoted-string src forms are judged; expression srcs (src={LOGO_SRC}) are
 * bindings the assembler/injectLogoSrc owns.
 */
export const FETCHABLE_SRC_RX = /^(https?:|data:|\/)/;

export const substituteImgAssetIds = (
  body: string,
  imagesById: Map<string, string>,
): { code: string; substituted: string[]; bad: string[] } => {
  const substituted: string[] = [];
  const bad: string[] = [];
  const resolve = (raw: string): string | null => {
    if (FETCHABLE_SRC_RX.test(raw)) return null; // already fetchable
    const url = imagesById.get(raw);
    if (url && FETCHABLE_SRC_RX.test(url)) {
      substituted.push(raw);
      return url;
    }
    if (!bad.includes(raw)) bad.push(raw);
    return null;
  };
  // src="X" / src='X'
  let code = body.replace(/(\bsrc=)("([^"]*)"|'([^']*)')/g, (m, pre: string, _q: string, d?: string, s?: string) => {
    const url = resolve(d ?? s ?? "");
    return url === null ? m : `${pre}${JSON.stringify(url)}`;
  });
  // src={"X"} / src={'X'} / src={`X`}
  code = code.replace(/(\bsrc=\{\s*)(["'`])([^"'`]*)\2(\s*\})/g, (m, pre: string, _q: string, raw: string, post: string) => {
    const url = resolve(raw);
    return url === null ? m : `${pre}${JSON.stringify(url)}${post}`;
  });
  return { code, substituted, bad };
};

/**
 * (e) Font-binding normalizer. Acceptance v3 measured the defect this closes:
 * zai-glm-4.7 DRAWS confidently but does not BIND fonts — text ships with
 * generic serif/system stacks (or no fontFamily at all) instead of the theme's
 * locked brand faces. Prompt-level asking already failed; this pass rewrites
 * the defect out deterministically:
 *   - any style-object `fontFamily:` whose value is NOT a theme reference
 *     (a FONT_DISPLAY/FONT_BODY/FONT_MONO const, or a stack that matches one
 *     of the theme's stacks IN FULL — every family, not just the primary) is
 *     replaced. A stack whose PRIMARY is a theme family but whose tail is
 *     foreign ('"Klarna Sans", serif') rewrites to the matching FONT_* const:
 *     acceptance v6's scene-3 payment UI shipped fallback SERIF because only
 *     the primary family was checked and the foreign tail rendered when the
 *     face lost the load race. A fully-foreign stack rewrites FONT_DISPLAY
 *     when the element reads as display type (fontSize ≥ 40px in the same
 *     style object, or an h1-h6 tag), FONT_BODY otherwise. Mono therefore
 *     survives ONLY where the theme's dataFont face is actually referenced —
 *     a foreign "Menlo, monospace" is a foreign face like any other.
 *   - `font-family:` declarations inside CSS strings get the same test; the
 *     rewrite target there is the matching theme STACK (a JS const can't be
 *     referenced from inside a literal CSS string) — the theme stack whose
 *     primary the value names, else the body stack.
 *   - a copy/hero piece with NO font binding anywhere gets one injected at the
 *     piece ROOT (FONT_DISPLAY when the root itself is display-sized/heading,
 *     else FONT_BODY) so its whole subtree inherits a theme face.
 * Brace/quote-aware like the passes above; pure and idempotent.
 */
const FONT_CONST_RE = /\bFONT_(?:DISPLAY|BODY|MONO)\b/;
const DISPLAY_SIZE_PX = 40;
const HEADING_TAG_RE = /^h[1-6]$/i;

/** Primary family of a CSS stack: '"Cabinet Grotesk", sans-serif' → "cabinet grotesk". */
const primaryFamily = (stack: string): string =>
  (stack.split(",")[0] ?? "").replace(/["'`]/g, "").trim().toLowerCase();

/** Full-stack identity: every family, unquoted/lowercased/order-preserved.
 *  '"Klarna Sans", serif' → "klarna sans, serif". The v6 defect lived in
 *  comparing primaries only — a theme primary with a foreign tail passed. */
const normalizeStack = (stack: string): string =>
  stack
    .split(",")
    .map((f) => f.replace(/["'`]/g, "").trim().toLowerCase())
    .filter(Boolean)
    .join(", ");

/** Strip one layer of JS string/template quoting off an expression source. */
const unquoteExpr = (expr: string): string => {
  const t = expr.trim();
  const q = t[0];
  return (q === '"' || q === "'" || q === "`") && t.endsWith(q) ? t.slice(1, -1) : t;
};

export const normalizeFontBindings = (
  body: string,
  theme: Theme,
  slotId: string,
): { code: string; rewrites: number; injected: boolean } => {
  /** [const name, primary family, full normalized stack, raw stack] per face. */
  const faces = [
    ["FONT_DISPLAY", theme.fonts.display] as const,
    ["FONT_BODY", theme.fonts.body] as const,
    ["FONT_MONO", theme.fonts.mono] as const,
  ].map(([constName, stack]) => ({
    constName,
    stack,
    primary: primaryFamily(stack),
    full: normalizeStack(stack),
  }));
  /** A theme value is a BARE FONT_* const reference (or a template literal
   *  interpolating one), or a string literal matching a FULL theme stack —
   *  every family, not just the primary (the v6 serif-fallback defect).
   *  A QUOTED const name — fontFamily: "FONT_BODY", which the fast tier
   *  emits — is NOT a theme value: it paints a literal font family named
   *  FONT_BODY, which no browser has, so text falls to default SERIF
   *  (measured: acceptance v7 run 1 shipped serif copy stacks on 3 scenes). */
  const isThemeValue = (expr: string): boolean => {
    const t = expr.trim();
    const q = t[0];
    const quoted = (q === '"' || q === "'" || q === "`") && t.endsWith(q) && t.length >= 2;
    if (!quoted) return FONT_CONST_RE.test(t) || faces.some((f) => f.full && f.full === normalizeStack(t));
    const content = t.slice(1, -1);
    if (q === "`" && /\$\{[^}]*FONT_(?:DISPLAY|BODY|MONO)[^}]*\}/.test(content)) return true;
    return faces.some((f) => f.full && f.full === normalizeStack(content));
  };
  /** Exactly a FONT_* const name once unquoted → rewrite to the BARE const. */
  const QUOTED_CONST_RE = /^FONT_(?:DISPLAY|BODY|MONO)$/;
  /** The theme face a non-theme value NAMES by its primary family (a theme
   *  primary with a foreign tail) — the rewrite keeps the authored face and
   *  fixes only the stack. undefined = fully foreign, heuristics decide. */
  const faceForPrimary = (expr: string) => faces.find((f) => f.primary && f.primary === primaryFamily(unquoteExpr(expr)));

  let rewrites = 0;
  const edits: { start: number; end: number; text: string }[] = [];

  // Style-object form: walk every style={{ … }} block brace/quote-aware.
  const styleRe = /style=\{\{/g;
  for (let m = styleRe.exec(body); m; m = styleRe.exec(body)) {
    const open = m.index + "style={".length; // the object's own "{"
    let depth = 0;
    let quote: string | null = null;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) continue;
    const obj = body.slice(open, close + 1);

    const famKey = /\bfontFamily\s*:\s*/.exec(obj);
    if (!famKey) continue;
    // Value expression: scan to the "," or "}" that closes it at depth 0.
    const vStart = famKey.index + famKey[0].length;
    let vEnd = -1;
    let vDepth = 0;
    let vQuote: string | null = null;
    for (let i = vStart; i < obj.length; i++) {
      const ch = obj[i];
      if (vQuote) {
        if (ch === "\\") i++;
        else if (ch === vQuote) vQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { vQuote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") vDepth++;
      else if (ch === ")" || ch === "]") vDepth--;
      else if (ch === "}") {
        if (vDepth === 0) { vEnd = i; break; }
        vDepth--;
      } else if (ch === "," && vDepth === 0) { vEnd = i; break; }
    }
    if (vEnd === -1) continue;
    // Leave trailing whitespace (the pad before a closing "}") outside the edit.
    while (vEnd > vStart && /\s/.test(obj[vEnd - 1])) vEnd--;
    const value = obj.slice(vStart, vEnd);
    if (isThemeValue(value)) continue;

    // Precedence: a QUOTED const name unquotes to the bare const (the face
    // was authored, only the quoting is wrong); a theme primary with a
    // foreign tail keeps its authored face (only the stack is normalized);
    // fully-foreign values fall to the heuristics: display type when the
    // SAME style object sizes ≥ 40px, or the owning tag is heading-ish
    // (nearest "<tag" before the style attribute).
    const quotedConst = QUOTED_CONST_RE.exec(unquoteExpr(value).trim())?.[0];
    const named = faceForPrimary(value);
    const sizeM = /\bfontSize\s*:\s*["'`]?(\d+(?:\.\d+)?)/.exec(obj);
    const tagM = /<([A-Za-z][A-Za-z0-9]*)[^<]*$/.exec(body.slice(0, m.index));
    const wantsDisplay =
      (sizeM ? Number(sizeM[1]) >= DISPLAY_SIZE_PX : false) ||
      (tagM ? HEADING_TAG_RE.test(tagM[1]) : false);
    edits.push({
      start: open + vStart,
      end: open + vEnd,
      text: quotedConst ?? (named ? named.constName : wantsDisplay ? "FONT_DISPLAY" : "FONT_BODY"),
    });
    rewrites++;
  }
  let code = body;
  for (const e of edits.reverse()) code = code.slice(0, e.start) + e.text + code.slice(e.end);

  // CSS-string form (appended keyframes / <style> template strings). A
  // `${FONT_*}` interpolation builds the stack from the const — theme value.
  // A bare/quoted const NAME in literal CSS ("font-family: FONT_BODY") names
  // no real font → rewrite to that face's full stack. A theme primary with a
  // foreign tail rewrites to THAT face's full stack (no JS const inside a
  // literal CSS string); fully foreign → the body stack.
  code = code.replace(/font-family\s*:\s*((?:\$\{[^}]*\}|[^;{}\n])+)/gi, (whole, val: string) => {
    const v = val.trim();
    if (/\$\{[^}]*FONT_(?:DISPLAY|BODY|MONO)[^}]*\}/.test(v)) return whole;
    if (faces.some((f) => f.full && f.full === normalizeStack(v))) return whole;
    rewrites++;
    const nameM = /^["'`]?(FONT_(?:DISPLAY|BODY|MONO))["'`]?$/.exec(v);
    const face = nameM ? faces.find((f) => f.constName === nameM[1]) : faceForPrimary(v);
    return `font-family: ${face?.stack ?? theme.fonts.body}`;
  });

  // Root injection: a copy/hero piece with NO binding anywhere inherits a
  // theme face from its own root instead of whatever the render host defaults.
  let injected = false;
  if (
    (slotId === "copy" || slotId === "hero") &&
    !/\bfontFamily\s*:/.test(code) &&
    !/font-family\s*:/i.test(code)
  ) {
    const start = code.indexOf("<");
    if (start !== -1) {
      let depth = 0;
      let quote: string | null = null;
      let tagEnd = -1;
      for (let i = start; i < code.length; i++) {
        const ch = code[i];
        if (quote) {
          if (ch === "\\") i++;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ">" && depth === 0) { tagEnd = i; break; }
      }
      const nameM = /^<([A-Za-z][A-Za-z0-9.]*)/.exec(code.slice(start));
      if (tagEnd !== -1 && nameM) {
        const rootTag = code.slice(start, tagEnd);
        const rootSize = /\bfontSize\s*:\s*["'`]?(\d+(?:\.\d+)?)/.exec(rootTag);
        const face =
          (rootSize ? Number(rootSize[1]) >= DISPLAY_SIZE_PX : false) || HEADING_TAG_RE.test(nameM[1])
            ? "FONT_DISPLAY"
            : "FONT_BODY";
        const styleAt = rootTag.search(/style=\{\{/);
        if (styleAt !== -1) {
          const at = start + styleAt + "style={{".length;
          code = `${code.slice(0, at)} fontFamily: ${face},${code.slice(at)}`;
        } else {
          const at = start + nameM[0].length;
          code = `${code.slice(0, at)} style={{ fontFamily: ${face} }}${code.slice(at)}`;
        }
        injected = true;
      }
    }
  }
  return { code, rewrites, injected };
};

/**
 * (f) Ink guard. Acceptance v2 measured the defect: the design-system head
 * emitted ink=#57cc02 (Duolingo streak-green) as the BODY-TEXT color, so every
 * element painted copy green BY CONTRACT — no element-level pass can fix a
 * poisoned theme. Ink must read as text: neutral (isNeutral — the shared
 * normalize-element policy) or dark enough to read as near-black
 * (l ≤ INK_DARK_L covers legitimate near-black brand navies like #10141c that
 * carry a nominal hue). A chromatic mid-lightness ink is overridden to the
 * near-black #1a1a1a class. Pure — returns a NEW theme, never mutates; only
 * hex inks are judged (the theme heads emit hex; an exotic rgba ink passes
 * through unjudged rather than misjudged). castBuild applies this on entry and
 * telemetry counts it.
 */
const INK_ALIASES = ["ink", "fg", "text"];
const INK_DARK_L = 0.18;
const NEUTRAL_INK = "#1a1a1a";

export const neutralizeInk = (theme: Theme): { theme: Theme; corrected: boolean } => {
  const keys = Object.keys(theme.palette);
  let inkKey: string | undefined;
  for (const alias of INK_ALIASES) {
    inkKey =
      keys.find((k) => k.toLowerCase() === alias) ??
      keys.find((k) => k.toLowerCase().includes(alias));
    if (inkKey) break;
  }
  if (!inkKey) return { theme, corrected: false };
  const rgb = hexToRgb((theme.palette[inkKey] ?? "").trim());
  if (!rgb) return { theme, corrected: false };
  const hsl = rgbToHsl(...rgb);
  if (isNeutral(hsl) || hsl.l <= INK_DARK_L) return { theme, corrected: false };
  return {
    theme: { ...theme, palette: { ...theme.palette, [inkKey]: NEUTRAL_INK } },
    corrected: true,
  };
};

/**
 * (g) Hero surface-contrast backstop (v9 — the washout class, deterministic
 * arm). The render-side hero-washout gate (lib/render/hero-contrast.ts) fires
 * when a hero's painted region has neither luminance spread nor variance —
 * v8's last gate-round driver was heroes painting EVERY panel within a few
 * luminance points of the canvas (dark-plum-on-dark-plum, spread 12 vs floor
 * 45). The head prompt + blueprint validator now demand a contrasting surface;
 * this pass is the neutralizeInk-spirit backstop for what still slips through.
 *
 * v10 — AREA-WEIGHTED (dogfood cycle 1: the v9 "one contrasting paint
 * anywhere → no-op" rule let s0.hero ship a washout because a single tiny
 * contrasting chip existed while every big panel sat in the canvas tone). The
 * contrasting paint must now carry ≥ HERO_SURFACE_MIN_CONTRAST_FRAC of the
 * hero's painted panel weight:
 *   - when EVERY resolvable paint has parseable px dims (bare-numeric
 *     `width:`/`height:` in its own style object), weight = area;
 *   - otherwise weight = paint count (flex/percent/unspecified sizes are not
 *     statically convertible to px — counting is the honest fallback).
 * Under the floor, the LARGEST canvas-toned panel (by parsed area, else the
 * first) is rewritten to the theme's most canvas-contrasting palette token —
 * canvas-agnostic BOTH directions by construction: the target maximizes
 * |ΔL(token, canvas)|, so a dark canvas lifts to the light token and a light
 * canvas (Glossier pale pink) drops to the darkest/saturated token.
 *
 * Judgment is deliberately conservative: only style-object `background:` /
 * `backgroundColor:` values that are a quoted hex or a bare palette const are
 * resolvable; gradients/rgba/derived values are unjudgeable statically and
 * make the pass a no-op (never a guess).
 */
export const HERO_SURFACE_MIN_DELTA_L = 15;
/** Contrasting paint must carry at least this fraction of the hero's painted
 *  panel weight (area when parseable, count otherwise). */
export const HERO_SURFACE_MIN_CONTRAST_FRAC = 0.25;

/** Rec.709 luminance (0-255) of a hex color, or null when unparseable. */
const luminance709 = (hex: string): number | null => {
  const rgb = hexToRgb(hex.trim());
  if (!rgb) return null;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
};

export const ensureHeroSurfaceContrast = (
  body: string,
  theme: Theme,
): { code: string; corrected: boolean } => {
  const canvasHex = theme.palette[tokenForRole(theme, "canvas")];
  const canvasL = canvasHex ? luminance709(canvasHex) : null;
  if (canvasL === null) return { code: body, corrected: false };

  // The rewrite target: the palette token most luminance-distant from the
  // canvas (WHITE-class on a dark canvas, near-black on a light one). A
  // mono-luminance palette (best delta under the floor) disables the pass.
  let target: { name: string; hex: string; delta: number } | null = null;
  for (const [name, hex] of Object.entries(theme.palette)) {
    const l = luminance709(hex);
    if (l === null) continue;
    const delta = Math.abs(l - canvasL);
    if (!target || delta > target.delta) target = { name, hex, delta };
  }
  if (!target || target.delta < HERO_SURFACE_MIN_DELTA_L) return { code: body, corrected: false };

  // Parseable panel area: bare-numeric width/height px inside the paint's own
  // style object (the nearest `{{ … }}` span). Quoted/percent/flex sizes are
  // not statically convertible — those paints carry no area (count fallback).
  const areaOfStyleSpan = (at: number): number | null => {
    const open = body.lastIndexOf("{{", at);
    if (open === -1) return null;
    const close = body.indexOf("}}", at);
    if (close === -1) return null;
    const span = body.slice(open, close);
    const w = /\bwidth\s*:\s*(\d+(?:\.\d+)?)(?![\d.%\w])/.exec(span);
    const h = /\bheight\s*:\s*(\d+(?:\.\d+)?)(?![\d.%\w])/.exec(span);
    if (!w || !h) return null;
    return Number(w[1]) * Number(h[1]);
  };

  // Every statically-resolvable flat background paint in the body.
  const paintRx =
    /(\b(?:background|backgroundColor)\s*:\s*)("#[0-9a-fA-F]{3,8}"|'#[0-9a-fA-F]{3,8}'|[A-Z][A-Z0-9_]{2,})/g;
  const paints: { start: number; end: number; raw: string; l: number; area: number | null }[] = [];
  for (let m = paintRx.exec(body); m; m = paintRx.exec(body)) {
    const raw = m[2];
    const l = raw.startsWith('"') || raw.startsWith("'")
      ? luminance709(raw.slice(1, -1))
      : raw in theme.palette
        ? luminance709(theme.palette[raw])
        : null;
    if (l === null) continue; // unresolvable (foreign const, bad hex) — unjudged
    paints.push({ start: m.index + m[1].length, end: m.index + m[0].length, raw, l, area: areaOfStyleSpan(m.index) });
  }
  if (paints.length === 0) return { code: body, corrected: false };

  // Area-weighted contrast share (v10): a contrasting paint only clears the
  // pass when it carries real weight, not merely exists somewhere.
  const contrasting = paints.filter((p) => Math.abs(p.l - canvasL) >= HERO_SURFACE_MIN_DELTA_L);
  if (contrasting.length > 0) {
    const everyAreaKnown = paints.every((p) => p.area !== null);
    const frac = everyAreaKnown
      ? contrasting.reduce((n, p) => n + (p.area ?? 0), 0) /
        Math.max(1, paints.reduce((n, p) => n + (p.area ?? 0), 0))
      : contrasting.length / paints.length;
    if (frac >= HERO_SURFACE_MIN_CONTRAST_FRAC) return { code: body, corrected: false };
  }

  // Contrast is absent or under-weighted — lift the LARGEST canvas-toned
  // panel (by parsed area, else the first) to the contrast token, in the same
  // value form it was authored.
  const canvasToned = paints.filter((p) => Math.abs(p.l - canvasL) < HERO_SURFACE_MIN_DELTA_L);
  if (canvasToned.length === 0) return { code: body, corrected: false };
  let lift = canvasToned[0];
  for (const p of canvasToned) {
    if (p.area !== null && (lift.area === null || p.area > lift.area)) lift = p;
  }
  const replacement = lift.raw.startsWith('"') || lift.raw.startsWith("'")
    ? JSON.stringify(target.hex)
    : target.name;
  return {
    code: body.slice(0, lift.start) + replacement + body.slice(lift.end),
    corrected: true,
  };
};

// ─── The element system prompt ──────────────────────────────────────────────

/**
 * One shared system prompt for every element call — adapted from the bake-off
 * harness (scripts/model-bakeoff.mjs ELEMENT_SYSTEM) and tightened for
 * production:
 *   - the WRAPPER owns placement (the bake-off asked elements to self-position;
 *     under assemble.ts each body is inlined into a positioned wrapper div),
 *   - data-content-path values match choreograph.ts `fieldsOf` exactly
 *     (bullets.0, meta.0.value, cta.primary) — those are the selectors the
 *     deterministic motion rules target,
 *   - copy binds through `c` so text edits stay LLM-free (piece-model doctrine).
 */
const buildElementSystem = (theme: Theme): string => {
  const paletteLines = Object.entries(theme.palette)
    .map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`)
    .join("\n");
  const keyframeNames = [...theme.keyframes.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)].map(
    (m) => m[1],
  );
  const g = theme.grammar;
  return [
    `You CREATE one element ("piece") of an animated brand-video scene from a brief.`,
    `The scene's shared design system is already in scope as module consts. Emit ONLY the JSX for this ONE element.`,
    `HARD RULES:`,
    `- Output ONLY JSX — no imports, no exports, no prose, no markdown fence, nothing at module scope.`,
    `- Output ONLY component code — NEVER narrate your reasoning, plan, QA analysis, or coordinate math as text: any first-person or layout-math sentence in a JSX text node ships VISIBLY on the frame and is rejected by a deterministic gate. Every text node is the artwork's own copy.`,
    `- Your JSX is inlined into a positioned wrapper div at the exact BOUNDS in the brief. FILL the wrapper (width/height 100%; text flows inside its max width). NEVER position yourself with canvas coordinates — the wrapper owns placement.`,
    `- Paint ONLY with the palette roles the brief grants, via the const names below. Never invent colors — off-vocabulary hues are rewritten.`,
    `- The brand accent is PUNCTUATION — chips, rules, badges, highlights, small buttons, data moments. NEVER paint a panel, card background, or any large region with the accent: a deterministic gate rejects any element where one flat accent-colored rectangle dominates the piece.`,
    `- Copy renders VERBATIM from the \`c\` binding (this scene's content object): {c.headline}, {c.bullets[0]}, … Tag every copy node with the exact data-content-path the brief gives it. Never invent numbers or claims IN COPY. Interior mock-UI values (prices, balances, timestamps inside the product you draw) are diegetic set dressing — render them concrete and plausible, NEVER masked ("$— — —", "•••", "$X,XXX" are rejected as broken half-loaded UI).`,
    `- CSS animation only, using ONLY the shared @keyframes names listed below${keyframeNames.length ? "" : " (none exist — emit static; the choreographer adds motion)"}. No Remotion hooks, no Math.random, no undefined components.`,
    `- Follow the design grammar: radii ${JSON.stringify(g.radiusScale)}, ${g.strokeWeight}px hairlines via ${g.hairline}, surfaces via ${g.panelBg}, shadow "${g.shadowRecipe}", ${g.dataFont === "mono" ? "FONT_MONO" : "FONT_BODY"} for data.`,
    `- Rich, production-grade, dense — an element of a premium brand video.`,
    `- Valid TSX that compiles when inlined as a JSX child.`,
    `IN SCOPE: the palette consts below; FONT_DISPLAY / FONT_BODY / FONT_MONO; GRAMMAR (frozen); lastWordAccent(text, color); <Img>; \`c\` (scene content).`,
    `PALETTE CONSTS:`,
    paletteLines,
    keyframeNames.length ? `SHARED @keyframes: ${keyframeNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

// ─── Enriched brief blocks ──────────────────────────────────────────────────
// Ported from scripts/audit-matrix.ts's ENRICHED prompt (conditions D/E) — the
// live experiment measured this taste stack 3.3x-ing mock-interior density on
// gpt-oss, and reference-grade scenes run up to 87 interior elements. Adapted
// per element kind: diegetic briefs carry the interior checklist + the
// no-placeholder contract + register→archetype guidance; atmosphere briefs
// carry the menu + a variety directive; copy briefs stay LEAN on purpose (the
// copy stack was never the thin part, and brief tokens are input cost).

const NO_PLACEHOLDER_DATA = `NO PLACEHOLDER DATA — every price, stat, metric, label, and timestamp is a CONCRETE literal value (invented-but-specific diegetic detail is ENCOURAGED: "$128.00", "Meeting booked · 2:30 PM", "1,204 contacts"). Masked or unresolved values — "$•••.00", "XX%", "Loading", "TBD", lorem, blank grey slab-bars standing in for text — are REJECTED; they render as a broken half-loaded product.`;

const MOCK_INTERIOR_CHECKLIST = [
  `MOCK INTERIOR (the empty-container rule): a mock (app window, browser, dashboard, phone, terminal) with an empty or sparse interior is REJECTED. Ship at least 15 labeled interior elements, including at least 4 concrete text values — realistic labels/values/timestamps — drawn from this vocabulary (all plain divs/spans/SVG):`,
  `- window/browser header: traffic-light dots + URL/title bar with a REAL address`,
  `- sidebar nav: 4-6 icon+label rows, ONE active (accent left-rail or fill)`,
  `- filled data rows: ≥3 rows of name + value + status chip ("Renewal — Acme Corp · $12,400 · Won")`,
  `- KPI tiles: number + label + delta ("47 deals · +12% WoW"), 2-4 tiles in a row`,
  `- a small chart: 5-8 bars or a sparkline as divs/SVG, with 2-3 axis/series labels`,
  `- activity feed / inbox lines: avatar-initial circle + one-line message + timestamp`,
  `- status pills (Live/Pending/Won), tabs with one active, toggles, kanban columns with 2-3 cards, table with header + 4-6 rows, timeline dots, funnel bars`,
  `Interior mock text is diegetic chrome: 11-16px is correct there (realism over legibility inside the prop).`,
  NO_PLACEHOLDER_DATA,
].join("\n");

/** Register→archetype guidance, adapted to the HERO element's role in the
 *  scene shape (the scene-level map lives in the audit-matrix enrichment). */
const REGISTER_ARCHETYPE: Record<string, string> = {
  stat: `Register "stat" → the scene is a KPI hero (ONE massive metric in the copy column); you are its SUPPORTING structure: a radial gauge / sparkline / delta chips / a labeled baseline rule — substantive, never a bare card marooned in space.`,
  list: `Register "list" → the copy column is a REAL list; you are its diegetic echo: a dashboard/table/kanban mock whose filled rows mirror the list's subject matter.`,
  split: `Register "split" → asymmetric split; you are the substantive diegetic prop opposite the copy: a full product mock (browser/app window) with a real interior, commanding your whole slot.`,
  quote: `Register "quote" → a manifesto pull-quote scene; stay quiet and compositional — a modest chart/motif band that never competes with the words.`,
  "full-bleed": `Register "full-bleed" → you ARE the canvas: an edge-to-edge treatment (dashboard wall, oversized mock, immersive field) the copy sits on top of; design the full frame.`,
  centered: `Register "centered" → centered editorial; you are a wide band beneath the copy: a horizontal mock strip, timeline, or labeled chart.`,
};

export const ATMOSPHERE_MENU = [
  "orbital rings (thin concentric ellipses, slow rotation)",
  "floating embers (small accent dots drifting upward at varied speeds)",
  "faint vertical light rays",
  "vignette glow (dark edges, luminous center)",
  "parallax bands (wide translucent diagonal bands drifting at different speeds)",
  "film grain",
  "multi-stop gradient backdrop",
  "slow linear-gradient shimmer sweep",
] as const;

/**
 * Deterministic per-scene atmosphere variety: rotate the menu by scene index
 * so adjacent scenes are STEERED toward different combinations. The reference
 * bar is 8 distinct gradient signatures video-wide; near-identical washes on
 * every scene was a measured cast defect.
 */
export const atmosphereDirective = (sceneIndex: number, register: string): string => {
  const n = ATMOSPHERE_MENU.length;
  const lean = [0, 1, 2].map((k) => ATMOSPHERE_MENU[(sceneIndex * 3 + k) % n]);
  return [
    `ATMOSPHERE MENU — build 2-3 layers from: ${ATMOSPHERE_MENU.join(" · ")}.`,
    `VARIETY (scene ${sceneIndex}, register ${register}): adjacent scenes must NOT reuse the same combination — this scene leans toward: ${lean.join(" · ")}. Match the register's energy: tension/chaos beats scatter and dissonate; resolution beats order and converge.`,
    `Include ≥2 infinite-loop animations on decorative layers (gradient pulse 4s, drift 9-11s, shimmer 8s) so the scene never freezes after entry.`,
  ].join("\n");
};

// ─── The SVG connector layer ────────────────────────────────────────────────
// Reference-grade scenes tie relationship concepts together with SVG connector
// SYSTEMS (~69 primitives in the reference's chaos scene); raw cast scenes had
// none. Scenes whose visual_concept speaks in relationships earn a dedicated
// full-bleed decorative piece painted between atmosphere and content.

const CONNECTOR_CONCEPT_RE = /\b(?:connect|network|flow|scatter|link|converg|chaos)/i;

/** Does this scene's visual concept imply a relationship system? */
export const wantsConnector = (visualConcept: unknown): boolean =>
  typeof visualConcept === "string" && CONNECTOR_CONCEPT_RE.test(visualConcept);

/** The connector's synthetic slot. Kind "atmosphere" on purpose: the assembler
 *  emits it full-bleed with pointerEvents none — no layout-composer changes.
 *  Same numeric z as the base layer but later in paint order, so it sits above
 *  the atmosphere wash and below all z≥1 content. */
const connectorSlot = (aspect: Aspect): ElementSlot => {
  const { w, h } = CANVAS[aspect];
  return {
    id: "connector",
    kind: "atmosphere",
    bounds: { x: 0, y: 0, w, h, z: 0 },
    contentFields: [],
    paletteRoles: ["hairline", "accent"],
    allowedOverlaps: [],
  };
};

// ─── Element briefs ─────────────────────────────────────────────────────────

type SceneContent = Script["scenes"][number]["content"];

/** The copy fields an element owns, as brief lines carrying the VERBATIM
 *  values + the choreograph-consistent data-content-path for each. */
const copyLines = (content: SceneContent | undefined, owned: string[]): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const scalar = (field: string) => {
    const v = c[field];
    if (owned.includes(field) && typeof v === "string" && v.trim()) {
      out.push(`${field}: ${JSON.stringify(v)} (data-content-path="${field}")`);
    }
  };
  scalar("eyebrow");
  scalar("headline");
  scalar("lede");
  if (owned.includes("bullets") && Array.isArray(c.bullets)) {
    c.bullets.forEach((b, i) => out.push(`bullets.${i}: ${JSON.stringify(b)} (data-content-path="bullets.${i}")`));
  }
  scalar("caption");
  if (owned.includes("meta") && Array.isArray(c.meta)) {
    (c.meta as Array<{ label?: string; value?: string }>).forEach((m, i) =>
      out.push(`meta.${i}: label ${JSON.stringify(m?.label ?? "")}, value ${JSON.stringify(m?.value ?? "")} (tag the value data-content-path="meta.${i}.value")`),
    );
  }
  if (owned.includes("cta") && c.cta && typeof c.cta === "object") {
    const cta = c.cta as { primary?: string; secondary?: string };
    if (cta.primary) out.push(`cta.primary: ${JSON.stringify(cta.primary)} (data-content-path="cta.primary")`);
    if (cta.secondary) out.push(`cta.secondary: ${JSON.stringify(cta.secondary)} (data-content-path="cta.secondary")`);
  }
  if (owned.includes("texts") && Array.isArray(c.texts)) {
    // Deprecated legacy field — still rendered so nothing is orphaned.
    c.texts.forEach((t, i) => out.push(`texts.${i}: ${JSON.stringify(t)} (data-content-path="texts.${i}")`));
  }
  return out;
};

/** Residual-REJECTION floor for unowned copy. A short single-token value —
 *  the brand name "Klarna" as a one-word headline — appears legitimately
 *  inside a hero mock's wordmark, URL bar, and chrome, so rejecting the
 *  element on its mere presence is a guaranteed false positive (measured:
 *  acceptance v7 run 1 placeholdered s0.hero THREE rounds running on it,
 *  shipping a washout). Exact-node STRIPPING still applies to every value;
 *  only unambiguous copy (≥2 words or ≥12 chars) can reject an element —
 *  and never a bare-domain value (v11: "glossier.com" belongs in a mock's
 *  URL bar and diegetic footer; stripping exact nodes is enough there). */
export const UNOWNED_REJECT_MIN_WORDS = 2;
export const UNOWNED_REJECT_MIN_CHARS = 12;
export const isUrlLikeValue = (v: string): boolean =>
  /^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(v.trim());
export const isRejectableUnownedCopy = (v: string): boolean => {
  const t = v.trim();
  if (isUrlLikeValue(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= UNOWNED_REJECT_MIN_WORDS || t.length >= UNOWNED_REJECT_MIN_CHARS;
};

/** The unowned-value subset whose RESIDUALS may reject an element: the
 *  distinctive editorial fields (headline/lede/bullets/cta.primary). The
 *  v11-widened fields (eyebrow/caption/cta.secondary) are strip-only —
 *  eyebrows are short generic phrases ("THE RANGE") that legitimately occur
 *  embedded in diegetic mock text, so their residuals never reject. */
export const rejectableUnownedCopyValues = (
  content: SceneContent | undefined,
  owned: string[],
): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const field of ["headline", "lede"]) {
    const v = c[field];
    if (!owned.includes(field) && typeof v === "string" && v.trim()) out.push(v.trim());
  }
  if (!owned.includes("bullets") && Array.isArray(c.bullets)) {
    for (const bItem of c.bullets) if (typeof bItem === "string" && bItem.trim()) out.push(bItem.trim());
  }
  if (!owned.includes("cta") && c.cta && typeof c.cta === "object") {
    const cta = c.cta as { primary?: string };
    if (typeof cta.primary === "string" && cta.primary.trim()) out.push(cta.primary.trim());
  }
  return out;
};

/** The scene copy VALUES a slot does NOT own. v11 widens coverage beyond
 *  headline/lede/bullets to eyebrow/caption/cta (dogfood cycle 2: s4's hero
 *  retyped the headline AND the CTA — the CTA sailed through because cta was
 *  never in this list). These are what the unowned-copy guard hunts for in
 *  the slot's generated body: ownership lives in the slot's contentFields /
 *  the composition's ownsCopy. */
export const unownedCopyValues = (content: SceneContent | undefined, owned: string[]): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const field of ["headline", "lede", "eyebrow", "caption"]) {
    const v = c[field];
    if (!owned.includes(field) && typeof v === "string" && v.trim()) out.push(v.trim());
  }
  if (!owned.includes("bullets") && Array.isArray(c.bullets)) {
    for (const bItem of c.bullets) if (typeof bItem === "string" && bItem.trim()) out.push(bItem.trim());
  }
  if (!owned.includes("cta") && c.cta && typeof c.cta === "object") {
    const cta = c.cta as { primary?: string; secondary?: string };
    if (typeof cta.primary === "string" && cta.primary.trim()) out.push(cta.primary.trim());
    if (typeof cta.secondary === "string" && cta.secondary.trim()) out.push(cta.secondary.trim());
  }
  return out;
};

// ─── Unowned-copy BINDING check (v11) ───────────────────────────────────────
// Dogfood cycle 2 s4: the hero RETYPED the headline + CTA inside its dark
// panel — duplicated copy on the frame. stripUnownedCopy sees literal VALUES;
// it is blind to `{c.<field>}` BINDINGS (the binding renders the owner's text
// verbatim at runtime with no literal to match). Ownership truth is ownsCopy
// (composition) / slot.contentFields (fallback) — a piece referencing a copy
// binding it does not own forks the copy by construction. Exact binding
// child-expressions strip deterministically; residual references (attributes,
// template interpolations) reject to the in-round repair.

/** Top-level copy fields whose bindings the guard polices. */
export const COPY_BINDING_FIELDS = ["eyebrow", "headline", "lede", "bullets", "caption", "meta", "cta", "texts"] as const;

/** The copy fields (present in this scene's content) a slot does NOT own —
 *  the binding-guard's hunt list. */
export const unownedBindingFields = (content: SceneContent | undefined, owned: string[]): string[] => {
  const c = (content ?? {}) as Record<string, unknown>;
  return COPY_BINDING_FIELDS.filter((f) => c[f] !== undefined && c[f] !== null && !owned.includes(f));
};

/** Does this expression reference the `c.<field>` binding (c.field, c?.field,
 *  c["field"], c.field[0], c.field.map…)? */
const bindingRxFor = (field: string): RegExp =>
  new RegExp(`\\bc\\s*(?:\\.|\\?\\.)\\s*${field}\\b|\\bc\\s*\\[\\s*["'\`]${field}["'\`]\\s*\\]`);

/**
 * Strip JSX child expressions that reference unowned copy bindings; report
 * fields whose references survive (non-child positions) as residual. A child
 * expression is a balanced `{…}` span sitting in text position (between `>`
 * and `<`), e.g. `{c.headline}` or `{lastWordAccent(c.headline, ACCENT)}`.
 */
export const stripUnownedBindings = (
  body: string,
  fields: string[],
): { code: string; stripped: string[]; residual: string[] } => {
  const hunted = fields.filter((f) => bindingRxFor(f).test(body));
  if (hunted.length === 0) return { code: body, stripped: [], residual: [] };

  // Balanced child-expression spans: `{…}` whose preceding non-space char is
  // `>` and following non-space char is `<` — pure text-position expressions.
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue;
    const before = body.slice(0, i).replace(/\s+$/, "");
    if (!before.endsWith(">")) continue;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let j = i; j < body.length; j++) {
      const ch = body[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    const after = body.slice(end + 1).replace(/^\s+/, "");
    if (!after.startsWith("<")) continue;
    spans.push({ start: i, end: end + 1 });
    i = end;
  }

  const strippedFields = new Set<string>();
  let code = body;
  for (const span of [...spans].reverse()) {
    const expr = code.slice(span.start, span.end);
    const hits = hunted.filter((f) => bindingRxFor(f).test(expr));
    if (hits.length === 0) continue;
    for (const f of hits) strippedFields.add(f);
    code = code.slice(0, span.start) + code.slice(span.end);
  }
  const residual = hunted.filter((f) => bindingRxFor(f).test(code));
  return { code, stripped: [...strippedFields], residual };
};

// ─── Composition-blueprint consumption ──────────────────────────────────────
// The thinking head (composition-head.ts) authors a per-scene SceneComposition
// — what each element IS + its interior inventory with REAL brand/scene
// values. When a scene carries one, briefs LEAD with that blueprint and the
// generic checklist/archetype text stays out (the head already did the
// inventing; the leaves transcribe). Scenes without a composition keep the
// generic-brief path unchanged — back-compat by construction.

type CastScene = Script["scenes"][number];

/** Map a spec element to its cast slot by role — roles are the slot ids
 *  (hero/copy/atmosphere/connector/throughline), so the mapping is a find. */
const specForSlot = (scene: CastScene | undefined, slotId: string): ElementSpec | undefined =>
  scene?.composition?.elements.find((e) => e.role === slotId);

/**
 * The copy fields an element OWNS, for both its brief and the unowned-copy
 * guard. With a composition present the spec is the ownership source of
 * truth: `ownsCopy` is explicit and exclusive, so a hero spec that owns
 * nothing makes ALL copy values unowned for the hero — stronger guard inputs
 * than slot.contentFields (which never carried copy fields for the hero
 * anyway, but DID let an under-specified world be ambiguous). Fields NO spec
 * claims fall back to their slot owner, so an incomplete composition can
 * never strip the headline out of the copy element that structurally owns it.
 */
const ownedCopyFields = (scene: CastScene | undefined, slot: ElementSlot): string[] => {
  const comp = scene?.composition;
  if (!comp) return slot.contentFields;
  const owned = new Set(specForSlot(scene, slot.id)?.ownsCopy ?? []);
  const claimed = new Set(comp.elements.flatMap((e) => e.ownsCopy ?? []));
  for (const f of slot.contentFields) if (!claimed.has(f)) owned.add(f);
  return [...owned];
};

/**
 * The blueprint lead for a composed element: subject + the verbatim interior
 * inventory + owned-copy render instructions + the motion beat. Transcription
 * doctrine (src/schema.ts ElementSpec): the head authored these values for
 * THIS brand and scene — the element furnishes what the spec names, never
 * template examples.
 */
const blueprintLines = (spec: ElementSpec, content: SceneContent | undefined, owned: string[]): string[] => {
  const lines: string[] = [
    `BLUEPRINT (authored by the composition head — TRANSCRIBE it, do not re-invent):`,
    `This element IS: ${spec.subject}`,
  ];
  if (spec.interior.length > 0) {
    lines.push(
      `TRANSCRIBE this interior inventory — every item below must be visibly present, verbatim values:`,
      ...spec.interior.map((item) => `- ${item}`),
      `The inventory is the FLOOR, not the ceiling: furnish supporting chrome in the same diegetic register, but every named value ships verbatim — never substituted, never rounded.`,
    );
  }
  const copy = copyLines(content, owned);
  if (copy.length > 0) {
    lines.push(
      `COPY THIS ELEMENT OWNS — render each field VERBATIM from the \`c\` binding, tagged with its data-content-path:`,
      ...copy,
    );
  } else {
    lines.push(
      `This element owns NO scene copy — the headline/lede/bullets belong to other elements; render none of that text.`,
    );
  }
  if (spec.motion) lines.push(`MOTION BEAT (sustained, tied to the named interior item): ${spec.motion}`);
  return lines;
};

/**
 * One element's brief: ONLY what that element owns — its role, its wrapper
 * geometry, the content-field values it renders, the palette roles it may
 * paint with (mapped to real const names), and the motif description when it
 * IS the throughline. Scene intent + register ride along for flavor; nothing
 * about any OTHER element leaks in (independence is the contract).
 */
const elementBrief = (args: {
  theme: Theme;
  script: Script;
  sceneIndex: number;
  register: string;
  slot: ElementSlot;
  pieceId: string;
  throughline: string;
}): string => {
  const { theme, script, sceneIndex, register, slot, pieceId, throughline } = args;
  const scene = script.scenes[sceneIndex];
  const spec = specForSlot(scene, slot.id);
  const owned = ownedCopyFields(scene, slot);
  const b = slot.bounds;
  const lines: string[] = [
    `CREATE this element — scene ${sceneIndex} ("${scene.label}", register ${register}), piece id "${pieceId}", kind "${slot.kind}".`,
    `Scene intent: ${scene.description ?? scene.label}`,
    `Visual concept (this element's role within it): ${String(scene.visual_concept ?? "").slice(0, 600)}`,
    `BOUNDS: your wrapper is ${b.w}×${b.h}px at canvas (${b.x},${b.y})${slot.kind === "text" ? " — width is a MAX, height flows" : ""}. Fill it.`,
    `PALETTE ROLES you may paint with: ${slot.paletteRoles.map((r) => `${r} → ${tokenForRole(theme, r)}`).join(", ")}.`,
  ];

  // Composed scenes: the brief LEADS with the head's blueprint. The generic
  // checklist/archetype/menu text below is the FALLBACK for un-composed scenes.
  if (spec) lines.push(...blueprintLines(spec, scene.content, owned));

  if (slot.id === "atmosphere") {
    lines.push(
      `Full-bleed decorative BASE layer (z0) under all content: gradient washes, glow, grain. The accent role may appear at LOW ALPHA only (a glow, never a fill). No text, no UI.`,
    );
    if (scene.composition) {
      lines.push(
        `ATMOSPHERE TREATMENT (authored for THIS scene — adjacent scenes carry different treatments): ${scene.composition.atmosphere}`,
        `Include ≥2 infinite-loop animations on decorative layers (gradient pulse 4s, drift 9-11s, shimmer 8s) so the scene never freezes after entry.`,
      );
    } else {
      lines.push(atmosphereDirective(sceneIndex, register));
    }
  } else if (slot.id === "connector") {
    lines.push(
      `Full-bleed decorative CONNECTOR layer between the atmosphere and the content: ONE inline SVG relationship system (root <svg viewBox="0 0 ${b.w} ${b.h}" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>) that ties this scene's concept together visually.`,
      `Requirements: at least 12 SVG primitives; dashed connector paths (strokeDasharray) linking node positions; small node marks (circles/rects) at path endpoints and junctions; curved paths over straight lines where they read better.`,
      spec
        ? `Derive the topology FROM the blueprint above — the subject and inventory name the system.`
        : `Derive the topology FROM the visual concept above (scattered chaos → tangled crossing paths; convergence → paths meeting at a hub; flow → a directed left-to-right run).`,
      `Paint structure with the hairline role, accent SPARINGLY (1-3 focal paths/nodes). Keep the center-of-frame copy zone visually calm. No text, no UI — this layer is connective tissue, not content.`,
    );
  } else if (slot.id === "copy") {
    if (spec) {
      lines.push(`ONE flow column, top to bottom — render EXACTLY the owned fields in the blueprint above, each tagged with its data-content-path.`);
    } else {
      lines.push(`The scene's editorial text stack — ONE flow column, top to bottom, each field tagged:`, ...copyLines(scene.content, owned));
    }
  } else if (slot.id === "throughline") {
    lines.push(
      `This element IS the story's throughline motif: ${JSON.stringify(throughline)}. It recurs at this exact anchor in EVERY scene and must read as ONE continuous object that evolves along the arc — never a fresh object per cut. The wrapper already carries the data-throughline tag and the pinned anchor; render only the motif itself.`,
    );
  } else {
    // hero — the diegetic visual. Composed: the blueprint above IS the visual
    // (subject + inventory); asset mounting stays contractual either way.
    // Un-composed: it renders its owned visual fields when the scene brings
    // them, otherwise it INVENTS the visual from the concept, steered by the
    // generic taste stack (the composer keeps the slot either way).
    const c = scene.content ?? ({} as SceneContent);
    if (slot.contentFields.includes("illustration") && c.illustration) {
      lines.push(`Illustration intent: ${JSON.stringify(c.illustration)} — draw it as inline SVG.`);
    }
    if (slot.contentFields.includes("asset_ids") && Array.isArray(c.asset_ids) && c.asset_ids.length > 0) {
      const imagesById = new Map((script.assets?.images ?? []).map((img) => [img.id, img]));
      for (const id of c.asset_ids) {
        const img = imagesById.get(id);
        if (img) lines.push(`Image ${id}: mount with <Img src=${JSON.stringify(img.src)} /> (${img.width}×${img.height}${img.alt_text ? `, ${img.alt_text}` : ""}).`);
      }
    }
    if (!spec) {
      if (slot.contentFields.length === 0) {
        lines.push(`No visual fields given — invent the diegetic visual (a browser mock, chart, panel, KPI cluster…) from the visual concept above.`);
      }
      const archetype = REGISTER_ARCHETYPE[register];
      if (archetype) lines.push(archetype);
      lines.push(MOCK_INTERIOR_CHECKLIST);
    }
  }

  lines.push("", "Emit ONLY the JSX for THIS element.");
  return lines.join("\n");
};

// ─── Fragment verification + placeholder ────────────────────────────────────

/**
 * FRAGMENT-VERIFICATION CHOICE: wrap the body the same way assemble.ts will —
 * a JSX child inside a wrapper div, inside a component arrow body — and run
 * `verifyCompilable` on THAT harness, per element. Chosen over compile-checking
 * the assembled scene per result because it is cheaper (one ~1ms esbuild
 * transform per element instead of re-assembling N times) and equally sound
 * for the defect class a syntax gate can catch (truncation, unbalanced tags,
 * leaked prose): esbuild's transform binds no identifiers either way, and any
 * fragment that parses in this child position parses identically inside
 * assemble's wrapper. It also localizes the compiler error to the one element,
 * which is exactly what the repair prompt needs to quote. The assembled whole
 * still gets a final `verifyCompilable` before return as the backstop.
 */
const verifyFragment = (body: string): Promise<string | null> =>
  verifyCompilable(`const __CastPiece = () => (\n<div>\n${body}\n</div>\n);`);

/**
 * Degraded-but-shippable substitute for an element that stayed broken through
 * its repair: a neutral surface in the theme's own grammar — or, when the
 * element owns the headline, the headline itself (the one piece of content a
 * scene cannot silently lose). Referenced consts (FONT_DISPLAY + the theme
 * tokens) are always emitted by the assembler, so the placeholder compiles by
 * construction.
 */
const placeholderBody = (theme: Theme, slot: ElementSlot): string =>
  slot.contentFields.includes("headline")
    ? `<div data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 56, fontWeight: 600, lineHeight: 1.1, color: ${tokenForRole(theme, "ink")} }}>{c.headline}</div>`
    : `<div style={{ width: "100%", height: "100%", borderRadius: 12, background: ${theme.grammar.panelBg}, border: "1px solid", borderColor: ${theme.grammar.hairline} }} />`;

// ─── The orchestrator ───────────────────────────────────────────────────────

interface ElementJob {
  sceneIndex: number;
  slot: ElementSlot;
  pieceId: string;
  brief: string;
}

interface ElementOutcome {
  pieceId: string;
  body: string;
  outputTokens: number;
  repaired: boolean;
  failed: boolean;
  colorRewrites: number;
  fontRewrites: number;
  heroSurfaceCorrected: boolean;
  /** Meta-text segments (leaked reasoning prose) stripped from the shipped body. */
  metaTextStrips: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Drive one full element-cast build: settle contracts, fire every element
 * call in parallel through a semaphore, hue-lock + verify each body (one
 * surgical repair, then placeholder), assemble, choreograph, compile-verify.
 *
 * `opts.caller` is dependency injection for tests (canned bodies, no network);
 * production uses the real `castCall`. `opts.concurrency` is the burst width —
 * a per-build FIFO semaphore (AccountLimiter, the tested pattern) sized for
 * Cerebras. Deliberately NOT `fillLimiter`: that singleton is sized for the
 * z.ai account ceiling and would strangle a Cerebras burst.
 */
export const castBuild = async (
  input: CastBuildInput,
  opts?: { caller?: typeof castCall; concurrency?: number },
): Promise<CastBuildResult> => {
  const t0 = Date.now();
  const { script, palette, aspect } = input;
  if (Object.keys(input.theme.palette).length === 0) {
    throw new Error("cast-build: theme.palette is empty — nothing for elements to paint with");
  }
  // Ink guard on ENTRY: a poisoned theme (chromatic body-text color) poisons
  // every element by contract — corrected before anything reads the theme.
  const inkGuard = neutralizeInk(input.theme);
  const theme = inkGuard.theme;
  if (inkGuard.corrected) {
    console.warn(`[cast-build] chromatic ink neutralized to ${NEUTRAL_INK} (theme ink was not a readable text color)`);
  }
  const caller = opts?.caller ?? castCall;
  const width = Math.max(1, Math.floor(opts?.concurrency ?? (Number(process.env.RB_CAST_CONCURRENCY) || 14)));
  const limiter = new AccountLimiter(width);

  // ── 1. Settle the contracts: one deterministic plan per scene ────────────
  // Every scene carries the motif when the script has one: the choreographer's
  // match cut needs it visible at t=0 in EVERY scene, and the presence gate
  // needs a ≥60% majority — all-scenes satisfies both by construction, and the
  // composer keeps the slot clear of copy/chrome at every register × aspect.
  const throughline = script.narrative?.throughline?.trim() ?? "";
  const hasThroughline = throughline.length > 0;
  const slug = slugify(throughline);

  const plans = script.scenes.map((scene) =>
    composeSceneLayout({ register: scene.register, content: scene.content }, aspect, { hasThroughline }),
  );

  // Connector casting. A scene WITH a composition is decided by the head:
  // it carries the connector iff the spec cast one (spec presence OVERRIDES
  // the keyword heuristic — the head sees the whole story; the regex sees one
  // string). Un-composed scenes keep the heuristic: relationship concepts earn
  // the SVG connector layer, and when nothing does, ONE mid-video scene still
  // gets it (reference-grade builds always carry at least one connector
  // system) — unless the head composed that mid scene and cast none, in which
  // case that IS the decision.
  const connectorScenes = new Set<number>(
    script.scenes.flatMap((scene, i) => {
      if (scene.composition) return specForSlot(scene, "connector") ? [i] : [];
      return wantsConnector(scene.visual_concept) ? [i] : [];
    }),
  );
  if (connectorScenes.size === 0 && script.scenes.length > 0) {
    const mid = Math.floor(script.scenes.length / 2);
    if (!script.scenes[mid]?.composition) connectorScenes.add(mid);
  }
  /** The composer's slots + the synthetic connector slot, in paint order
   *  (connector directly after the base atmosphere layer). */
  const slotsFor = (plan: ScenePlan, i: number): ElementSlot[] => {
    if (!connectorScenes.has(i)) return plan.elements;
    const slots = [...plan.elements];
    slots.splice(1, 0, connectorSlot(aspect));
    return slots;
  };

  const scenes: SceneManifest[] = plans.map((plan, i) => ({
    scene: i,
    background: tokenForRole(theme, "canvas"),
    pieces: slotsFor(plan, i).map(
      (slot): Piece => ({
        id: `s${i}.${slot.id}`, // the Piece id convention (see ElementSlot.id)
        kind: slot.kind,
        // Virtual path — cast bodies stay in-memory (the resolver below); this
        // is the manifest slot a future decompose-to-disk step will fill.
        file: `scene${i}/${slot.id}.tsx`,
        bounds: slot.bounds,
        ...(slot.kind === "text" ? { contentRef: `scenes[${i}].content` } : {}),
        ...(slot.id === "throughline" ? { throughlineSlug: slug } : {}),
      }),
    ),
  }));

  // ── 2. Element briefs — chrome earns NO call (Section emits Chrome itself,
  //       see assemble.ts) ──────────────────────────────────────────────────
  const system = buildElementSystem(theme);
  const jobs: ElementJob[] = plans.flatMap((plan, i) =>
    slotsFor(plan, i)
      .filter((slot) => slot.kind !== "chrome")
      .map((slot) => ({
        sceneIndex: i,
        slot,
        pieceId: `s${i}.${slot.id}`,
        brief: elementBrief({ theme, script, sceneIndex: i, register: plan.register, slot, pieceId: `s${i}.${slot.id}`, throughline }),
      })),
  );

  // ── 3+4. Fire ALL calls through the semaphore; per result: extract →
  //         hue-lock → fragment-verify → one repair → placeholder ──────────
  // Known image assets by id — the pre-render img gate substitutes these for
  // raw asset-id srcs (site_logo, site_og_image, site_img_N…) at zero tokens.
  const imagesById = new Map<string, string>(
    (script.assets?.images ?? []).map((img) => [img.id, img.src]),
  );

  const runElement = async (job: ElementJob): Promise<ElementOutcome> => {
    let tokens = 0;
    const model = modelFor(job.slot.id);
    const effort = effortFor(job.slot.id, model);
    // Verbatim copy this element does NOT own. Ownership lives in the slot —
    // and when the scene carries a composition, the spec's explicit ownsCopy
    // is the stronger source of truth (see ownedCopyFields).
    const jobContent = script.scenes[job.sceneIndex]?.content;
    const jobOwned = ownedCopyFields(script.scenes[job.sceneIndex], job.slot);
    const unowned = unownedCopyValues(jobContent, jobOwned);
    const unownedRejectable = new Set(rejectableUnownedCopyValues(jobContent, jobOwned));
    const unownedBindings = unownedBindingFields(jobContent, jobOwned);

    // One attempt: call, extract, deterministic post-passes, hue-lock,
    // syntax-verify. A transport throw (castCall retries internally first) is
    // treated like a broken result — the build completes degraded rather than
    // dying on one element.
    const attempt = async (
      user: string,
    ): Promise<
      | { ok: true; body: string; rewrites: number; fontRewrites: number; heroSurface: boolean; metaStrips: number }
      | { ok: false; raw: string; error: string }
    > => {
      let text: string;
      try {
        const res = await caller({ system, user, maxTokens: maxTokensFor(job.slot.id, model), effort, model });
        tokens += res.outputTokens;
        text = res.text;
      } catch (err) {
        return { ok: false, raw: "", error: err instanceof Error ? err.message : String(err) };
      }
      const raw = stripCodeFence(text);
      if (raw.length < 8 || !raw.includes("<") || /^\s*(?:import|export)\b/.test(raw)) {
        return { ok: false, raw, error: "output is not a JSX fragment (empty, no markup, or a module)" };
      }
      // (d6) META-TEXT LEAK gate (v11): self-referential repair prose rendered
      // as JSX text nodes strips deterministically; a body DOMINATED by its
      // own reasoning rejects for a fresh emission.
      const meta = stripMetaText(raw);
      if (meta.reject) {
        return {
          ok: false,
          raw,
          error:
            `element rendered its own reasoning/QA analysis as visible text (${meta.stripped
              .slice(0, 2)
              .map((s) => JSON.stringify(s.slice(0, 90)))
              .join(", ")}…) — output ONLY component code; NEVER narrate reasoning, coordinate math, or QA findings as text nodes`,
        };
      }
      if (meta.stripped.length > 0) {
        console.warn(
          `[cast-build] ${job.pieceId}: ${meta.stripped.length} meta-text segment(s) stripped (leaked reasoning prose: ${JSON.stringify(meta.stripped[0].slice(0, 80))})`,
        );
      }
      // Deterministic post-passes — each closes a measured defect class at
      // zero tokens (see the pass docs above), BEFORE the fragment gate.
      let body = rewriteKeyframeInterpolations(meta.code, theme.keyframes).code;
      body = stripCanvasSelfPositioning(body, job.slot.bounds).code;
      body = stripColorMutationFilters(body).code;
      // (d5) masked bullet-runs ("●●●") collapse to a single bullet — the
      // placeholder-data class stripped deterministically at cast time.
      body = stripMaskedValueRuns(body).code;
      // (d3) img-src gate: known asset ids substitute deterministically;
      // unknown non-fetchable srcs fail here (in-round repair) instead of at
      // the post-render whitelist a full gate round later.
      const imgs = substituteImgAssetIds(body, imagesById);
      body = imgs.code;
      if (imgs.bad.length > 0) {
        return {
          ok: false,
          raw,
          error:
            `non-fetchable <Img> src(s): ${imgs.bad.map((b) => JSON.stringify(b === "" ? "(empty)" : b)).join(", ")} — ` +
            `only https:/data://-rooted srcs render (raw asset ids resolve to a blank rectangle). ` +
            `Use the asset URLs given in the brief, or draw the visual as styled DOM instead of an <Img>`,
        };
      }
      const fonts = normalizeFontBindings(body, theme, job.slot.id);
      body = fonts.code;
      const { code: locked, changes } = normalizeElementColors(body, palette);
      // Unowned-copy guard: exact text nodes strip deterministically inside
      // stripUnownedCopy; anything subtler routes to the surgical repair with
      // a verbatim error naming the stolen copy. Only UNAMBIGUOUS copy can
      // reject (isRejectableUnownedCopy) — a bare brand-name token inside a
      // mock's own chrome is diegetic, not theft.
      const guard = stripUnownedCopy(locked, unowned);
      const rejectable = guard.residual.filter((v) => unownedRejectable.has(v) && isRejectableUnownedCopy(v));
      if (rejectable.length > 0) {
        return {
          ok: false,
          raw,
          error: `element renders copy it does not own: ${rejectable.map((v) => JSON.stringify(v)).join(", ")} — those fields belong to another element (ownership is fixed by the layout contract); remove that text entirely`,
        };
      }
      // (v11) Unowned-copy BINDING check: `{c.<field>}` references for fields
      // this element does not own render the owner's text twice at runtime —
      // exact child expressions strip deterministically; residual references
      // reject to the in-round repair.
      const bindGuard = stripUnownedBindings(guard.code, unownedBindings);
      if (bindGuard.residual.length > 0) {
        return {
          ok: false,
          raw,
          error:
            `element binds scene copy it does not own: ${bindGuard.residual.map((f) => `c.${f}`).join(", ")} — ` +
            `those content fields belong to another element (ownership is fixed by the layout contract); ` +
            `remove every reference to them (render your OWN diegetic values instead)`,
        };
      }
      if (bindGuard.stripped.length > 0) {
        console.warn(
          `[cast-build] ${job.pieceId}: unowned copy binding(s) stripped: ${bindGuard.stripped.map((f) => `c.${f}`).join(", ")}`,
        );
      }
      // (d2) PRE-RENDER hero density gate: the hollow-bookend class fails
      // inside the cast round (~10s repair) instead of a 44-100s render+
      // vision gate round. Measured on the stripped/normalized body so
      // stolen copy can't pad the count.
      let finalBody = bindGuard.code;
      let heroSurface = false;
      if (job.slot.id === "hero") {
        const density = staticJsxDensity(bindGuard.code);
        if (density.elements < PRE_RENDER_HERO_MIN_ELEMENTS || density.textNodes < PRE_RENDER_HERO_MIN_TEXT) {
          return {
            ok: false,
            raw,
            error:
              `hero interior too thin: statically measured ~${density.elements} element(s) / ~${density.textNodes} text value(s) — ` +
              `the hero floor is ≥${PRE_RENDER_HERO_MIN_ELEMENTS} nested elements AND ≥${PRE_RENDER_HERO_MIN_TEXT} concrete visible text values ` +
              `(rows, chips, labels, timestamps, values that belong to the product). Rebuild this element as a real product ` +
              `artifact with a furnished interior — every inventory item in the brief visibly present, plus supporting diegetic chrome`,
          };
        }
        // (g) Surface-contrast backstop: a hero whose every flat panel sits in
        // the canvas's own luminance band ships a washout — lift the primary
        // panel to the theme's contrast token deterministically (zero tokens)
        // instead of paying a render+vision gate round to discover it.
        const surface = ensureHeroSurfaceContrast(bindGuard.code, theme);
        if (surface.corrected) {
          finalBody = surface.code;
          heroSurface = true;
          console.warn(
            `[cast-build] ${job.pieceId}: hero panels all within ΔL<${HERO_SURFACE_MIN_DELTA_L} of the canvas — primary panel lifted to the theme's contrast token`,
          );
        }
      }
      const compileErr = await verifyFragment(finalBody);
      if (compileErr) return { ok: false, raw, error: compileErr };
      return {
        ok: true,
        body: finalBody,
        rewrites: changes.reduce((n, ch) => n + ch.count, 0),
        fontRewrites: fonts.rewrites + (fonts.injected ? 1 : 0),
        heroSurface,
        metaStrips: meta.stripped.length,
      };
    };

    const first = await attempt(job.brief);
    if (first.ok) {
      return { pieceId: job.pieceId, body: first.body, outputTokens: tokens, repaired: false, failed: false, colorRewrites: first.rewrites, fontRewrites: first.fontRewrites, heroSurfaceCorrected: first.heroSurface, metaTextStrips: first.metaStrips };
    }

    // ONE surgical repair: the same brief + the broken output + the exact
    // error. A syntax failure is mechanical, not creative — one pointed retry
    // recovers most of them (repairCompile doctrine, code-extraction.ts).
    const second = await attempt(
      [
        job.brief,
        "",
        "Your previous attempt failed:",
        first.raw ? `--- previous attempt ---\n${first.raw}` : "(the call itself failed)",
        `--- error ---\n${first.error}`,
        "Emit corrected JSX only — output ONLY component code; never narrate your reasoning, plan, or coordinate math as rendered text nodes.",
      ].join("\n"),
    );
    if (second.ok) {
      return { pieceId: job.pieceId, body: second.body, outputTokens: tokens, repaired: true, failed: false, colorRewrites: second.rewrites, fontRewrites: second.fontRewrites, heroSurfaceCorrected: second.heroSurface, metaTextStrips: second.metaStrips };
    }

    console.warn(`[cast-build] ${job.pieceId}: broken through repair — shipping placeholder (${second.error.slice(0, 120)})`);
    return { pieceId: job.pieceId, body: placeholderBody(theme, job.slot), outputTokens: tokens, repaired: false, failed: true, colorRewrites: 0, fontRewrites: 0, heroSurfaceCorrected: false, metaTextStrips: 0 };
  };

  const outcomes = await Promise.all(jobs.map((job) => limiter.with(() => runElement(job))));
  const bodies = new Map(outcomes.map((o) => [o.pieceId, o.body]));

  // ── 5. Assemble → choreograph (motion is a compile step, invoked exactly
  //       like pipeline.ts's parallel branch) → final compile gate ─────────
  const assembled = assembleComposition({ theme, scenes, pieceBody: (p) => bodies.get(p.id) ?? "<div />" });
  // CastBuildInput carries no brand_extract, so the motion signal is the
  // pipeline's own fallback: "medium".
  const code = applyChoreography(assembled, script, "medium");

  const finalErr = await verifyCompilable(code);
  if (finalErr) {
    // Every body was fragment-verified and the assembler is deterministic —
    // reaching here is an orchestrator bug, never a runtime condition.
    throw new Error(`cast-build: assembled composition does not compile: ${finalErr}`);
  }

  // Accent PRESENCE is the complement of hue-locking (normalize-element.ts):
  // all-neutral output sails through the lock. Detection only — log loudly,
  // let the vision gate / caller decide what absence costs.
  const accent = assessAccentPresence(code, palette, input.signatureAccent);
  if (!accent.present) {
    console.warn(`[cast-build] brand accent hue ${accent.accentHue?.toFixed(0)}° absent from the final composition`);
  }

  return {
    code,
    scenes,
    telemetry: {
      elements: jobs.length,
      failures: outcomes.filter((o) => o.failed).length,
      repairs: outcomes.filter((o) => o.repaired).length,
      tokensOut: outcomes.reduce((n, o) => n + o.outputTokens, 0),
      wallSeconds: round2((Date.now() - t0) / 1000),
      normalizedColors: outcomes.reduce((n, o) => n + o.colorRewrites, 0),
      fontRewrites: outcomes.reduce((n, o) => n + o.fontRewrites, 0),
      inkCorrected: inkGuard.corrected,
      heroSurfaceCorrections: outcomes.filter((o) => o.heroSurfaceCorrected).length,
      metaTextStrips: outcomes.reduce((n, o) => n + o.metaTextStrips, 0),
    },
    elementOutcomes: outcomes.map((o) => ({ pieceId: o.pieceId, failed: o.failed, repaired: o.repaired })),
  };
};
