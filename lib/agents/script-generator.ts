import { castCall } from "../llm/cast-provider";
import { SCRIPT_GENERATOR_SYSTEM_PROMPT } from "./prompts/script-generator";
import {
  validateScript,
  normalizeScriptContent,
  backfillSceneRegisters,
  findUngroundedClaims,
  findUngroundedStageLabels,
  findTypeOnlyScenes,
  drawableVocabulary,
  containerVocabulary,
  interiorVocabulary,
  completeVisualConcept,
  dropEchoedCta,
} from "./schema-validator";
import { signatureWithLogoFallback, resolveCanvasPlan, brandShortName } from "../crawl/brand-identity";
import { formatDesignLanguage } from "../crawl/design-language";
import { ulid } from "../ulid";
import { type Usage, EMPTY_USAGE, addUsage } from "../usage";
import type { Script } from "../../src/schema";
import type { DesignLanguage } from "../../app/new/schema";

/**
 * The agent-facing brief. Mirrors actions.ts BriefInput but doesn't
 * import from app/ (which would tangle "use server" with library
 * code). Keep this contract in sync with the action's input shape.
 */
export type CreativityLevel = "literal" | "balanced" | "bold";

export interface AgentMoment {
  title: string;
  description: string;
  creativity: CreativityLevel;
}

export interface AgentFileRef {
  name: string;
  url: string;
  mime: string;
}

export interface AgentBrandFont {
  family: string;
  src: string;
  weight?: string;
  style?: string;
  format?: string;
}

export type AgentMotionSignal = "high" | "medium" | "low";

export interface AgentBrandExtract {
  /**
   * Colours the SITE named --brand/--primary/--accent. Carried because a
   * DECLARED colour earns the wider chromaticity band in pickSignatureColor:
   * a brand is allowed to be dark (slack aubergine, midnight navy), but only
   * when the site itself made the claim. A merely-frequent dark colour is a
   * background, which is the bug that band was written to stop.
   */
  named?: string[];

  url: string;
  title?: string;
  description?: string;
  og_image?: string;
  theme_color?: string;
  favicon?: string;
  apple_touch_icon?: string;
  logo_hd?: string;
  /** Dominant chromatic color from the logo SVG — signature fallback (QA G1). */
  logo_color?: string;
  /**
   * Vision-vetted confidence from the agentic logo finder (0-1). Must reach
   * pickLogo's trust path — without it a confident pick whose URL happens to
   * match a reject regex (e.g. contains "card"/"nav"/"share") is silently
   * nulled to the wordmark fallback.
   */
  logo_confidence?: number;
  headlines?: string[];
  body_excerpts?: string[];
  /** R4b (audit-3): the brand's on-page copy language — reinforces the hard
   *  copy-language directive so a non-English brand ships non-English copy. */
  site_lang?: string;
  page_images?: { src: string; alt?: string }[];
  fonts?: AgentBrandFont[];
  font_roles?: {
    display?: string;
    body?: string;
    mono?: string;
  };
  palette?: string[];
  /** The brand's actual page/canvas background color, sampled from its homepage — the canvas the scenes should sit on, distinct from the signature accent. */
  background_color?: string;
  motion_signal?: AgentMotionSignal;
  /** Live homepage screenshot URL (microlink) — representative page snapshot. */
  site_screenshot?: string;
  /** Structured design-language brief (composition / type-treatment / mood). */
  design_language?: DesignLanguage;
  ok: boolean;
}

/**
 * Pre-allocated image asset that the agent can reference by id.
 * Server builds this from uploaded files + crawled site assets.
 */
export interface PreallocatedAsset {
  id: string; // stable, predictable: upload_0, site_favicon, etc.
  url: string;
  mime: string;
  source: "upload" | "crawl";
  label: string; // human description for the agent ("uploaded logo.svg")
}

/**
 * Two modes for Agent 1:
 *
 * - PRE_STRUCTURED: the user wrote each moment in the wizard. We
 *   provide title + description + creativity per moment. The agent
 *   translates them verbatim (1:1 to scenes, scene labels = moment
 *   titles).
 *
 * - FREEFORM: the user wrote a single paragraph prompt. We tell the
 *   agent the total duration and the moment count. The agent picks
 *   purpose/CTA/per-moment content itself in the same pass that
 *   writes the rest of the script.
 *
 * Exactly one of {moments, freeform_prompt} should be populated.
 */
export interface AgentBrief {
  duration_seconds: number;
  /**
   * User's distribution choice from the wizard. Authoritative for
   * config.aspect_ratio + downstream viewing_context. When set, the
   * agent skips its keyword-guessing path and uses the user's pick.
   */
  distribution_format?: "mobile-feed" | "square" | "landscape";
  /**
   * Document kind (canvas pivot, docs/PIVOT.md). "deck" = static multi-page
   * presentation: the prompt drops all timing/motion asks, scene timings are
   * tiled as inert 5s stubs, and voiceover becomes presenter notes. Absent =
   * "video" (legacy behavior, unchanged).
   */
  kind?: "video" | "deck";
  moment_count: number;
  brand_kit_url?: string;
  brand_files?: AgentFileRef[];
  brand_extract?: AgentBrandExtract;
  preallocated_assets?: PreallocatedAsset[];
  /**
   * User-supplied verified claims (one per line). Agent 1 may repeat
   * these verbatim as factual stats; they count as a grounding source
   * alongside body_excerpts and brief.about for the hallucination
   * guardrail.
   */
  verified_claims?: string;

  // Pre-structured mode
  purpose?: string;
  moments?: AgentMoment[];
  cta?: string;

  // Freeform mode
  freeform_prompt?: string;
}

/** What a failed outline knows about its own failure. `evidence` carries the
 *  flagged scenes' actual prose so a diagnosis can read what was judged rather
 *  than re-deriving it. Diagnostic only — never shown to a user. */
export interface ScriptFailureEvidence {
  scene: number;
  label: string;
  visual_concept: string;
}

export type ScriptGenerationResult =
  | {
      ok: true;
      script: Script;
      usage: Usage;
      /**
       * Scene indexes whose visual_concept we finished deterministically rather
       * than failing the whole outline. Logged, and worth surfacing on the
       * review one day so the user knows which brief to look at first.
       */
      completedScenes?: number[];
    }
  | { ok: false; error: string; evidence?: ScriptFailureEvidence[] };

/**
 * The ONLY text a numeric claim in script copy may ground against (QA S5,
 * tightened): the user's freeform prompt / purpose, user-verified claims,
 * and the crawl's title / description / headlines / body_excerpts. NEVER the
 * script's own text — a fabricated stat must not be able to vouch for itself.
 * Exported so the claims audit (`scripts/claims-audit.mjs`) checks against the
 * exact same source set the gate uses.
 */
export const claimGroundingSources = (
  brief: Pick<
    AgentBrief,
    "freeform_prompt" | "purpose" | "verified_claims" | "brand_extract"
  >,
): string => {
  const be = brief.brand_extract;
  return [
    brief.freeform_prompt,
    brief.purpose,
    brief.verified_claims,
    be?.title,
    be?.description,
    ...(be?.headlines ?? []),
    ...(be?.body_excerpts ?? []),
  ]
    .filter(Boolean)
    .join(" \n ");
};

/**
 * The viewer-facing copy of every scene (headline / lede / caption / eyebrow /
 * bullets / meta values) joined into one string — the text the invented-claim
 * guard scans. Exported for the claims audit so reporting and the gate read
 * the same fields.
 */
export const sceneClaimCopy = (
  scenes: ReadonlyArray<{ content?: unknown }>,
): string =>
  scenes
    .map((sc) => {
      const c = (sc.content ?? {}) as Record<string, unknown>;
      const bullets = Array.isArray(c.bullets)
        ? (c.bullets as unknown[])
            .map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text || ""))
            .join(" ")
        : "";
      const meta = Array.isArray(c.meta)
        ? (c.meta as { value?: unknown }[]).map((m) => String(m?.value ?? "")).join(" ")
        : "";
      return [c.headline, c.lede, c.caption, c.eyebrow, bullets, meta]
        .filter(Boolean)
        .join(" ");
    })
    .join(" \n ");

/**
 * The claim copy split by grounding STRICTNESS. The claim surfaces (headline,
 * lede, eyebrow, bullets, meta stat-tiles) stay strict — an invented stat there
 * is a marketing claim. The CAPTION is descriptive set-dressing text under the
 * content ("checkout.store.com · SSL secured · $243.00 total"), so a plain
 * diegetic price there is exempt (see findUngroundedClaims exemptDiegeticPrices).
 * A token appearing in BOTH a strict field and the caption is still caught via
 * the strict pass.
 */
export const sceneClaimCopyByStrictness = (
  scenes: ReadonlyArray<{ content?: unknown }>,
): { strict: string; caption: string } => {
  const strictParts: string[] = [];
  const captionParts: string[] = [];
  for (const sc of scenes) {
    const c = (sc.content ?? {}) as Record<string, unknown>;
    const bullets = Array.isArray(c.bullets)
      ? (c.bullets as unknown[]).map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text || "")).join(" ")
      : "";
    const meta = Array.isArray(c.meta)
      ? (c.meta as { value?: unknown }[]).map((m) => String(m?.value ?? "")).join(" ")
      : "";
    strictParts.push([c.headline, c.lede, c.eyebrow, bullets, meta].filter(Boolean).join(" "));
    if (c.caption) captionParts.push(String(c.caption));
  }
  return { strict: strictParts.join(" \n "), caption: captionParts.join(" \n ") };
};

/**
 * Agent 1 — Script Generator.
 *
 * Takes a customer brief, returns a validated Script JSON.
 * Synchronous from the caller's perspective; internally takes 10-30s
 * for a typical 30-second video script.
 *
 * The system prompt is cached on Anthropic's side (~10k tokens stable).
 * The user message carries the per-brief context.
 *
 * Failure modes handled:
 *   • API error (auth, rate limit, network) → error string
 *   • Non-JSON response → error
 *   • Schema validation failure → error with location
 *
 * Not handled yet (Layer 1):
 *   • Auto-retry on validation failure with a "fix this and resubmit" turn
 *   • Streaming partial scripts to a preview surface
 */
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries

/**
 * Extra rounds granted ONLY when every remaining complaint is a scene-level
 * one that can be repaired in isolation.
 *
 * Measured across 56 outline runs: failures concentrate almost entirely in one
 * shape — a long prose brief at the maximum page count — where 9 of 12 runs
 * failed. That is arithmetic, not a bad prompt. Roughly 15% of real scenes land
 * at or under the drawable-noun floor, so on twelve scenes the chance that at
 * least one trips is about half PER ATTEMPT, and three attempts is simply not
 * many rolls when each roll must land twelve times at once.
 *
 * A repair is not a re-roll. It rewrites the one or two flagged scenes and
 * leaves the rest alone, so it is a fraction of the tokens and it cannot break
 * a scene that was already fine. Spending a few more of those beats handing
 * someone a wall of red after they waited a minute — the failure they see today
 * costs them everything, and this costs seconds.
 *
 * Guarded: only while the flagged set keeps CHANGING. A repair that returns the
 * same scenes with the same complaint twice is not converging, and the extra
 * rounds stop immediately.
 */
const MAX_REPAIR_ROUNDS = 3;

// ── LLM transport (provider-configurable) ───────────────────────────────────
//
// The parse / validate / repair loop below is TRANSPORT-AGNOSTIC: given the
// running message history it wants the model's text + token usage, and nothing
// else. Only THIS layer differs by provider, so a provider swap can never touch
// the SCRIPT_GENERATOR_SYSTEM_PROMPT, buildUserMessage, the richness/grounding/
// cold-open validators, or the MAX_ATTEMPTS feedback loop.
//
// FIREWORKS ONLY (founder call, 2026-07-23): script generation runs on
// GLM-5.2 via castCall against Fireworks — same model family as the whole
// build stack, faster serving, same list price. The legacy z.ai path (the
// [1113] balance single-point-of-failure) was removed outright; there is no
// provider switch anymore.

/** One repair-loop turn's message. */
export type ScriptMsg = { role: "user" | "assistant"; content: string };

/** A script-gen transport: given the running history, return the model's text
 *  and token usage. Injected in tests; production resolves it from the env. */
export type ScriptTransport = (
  history: ScriptMsg[],
) => Promise<{ text: string; usage: Usage }>;

export type ScriptProvider = "fireworks";

/** Which provider generates the script. Always fireworks — the z.ai path was
 *  removed 2026-07-23 (RB_SCRIPT_PROVIDER is ignored). */
export const resolveScriptProvider = (): ScriptProvider => "fireworks";

/** Fireworks model for script generation — the same GLM-5.2 Fast router the
 *  cast runs on. Override with RB_SCRIPT_MODEL. */
const fireworksScriptModel = (): string =>
  process.env.RB_SCRIPT_MODEL || "accounts/fireworks/routers/glm-5p2-fast";

/**
 * Flatten the repair loop's multi-turn history into castCall's single user
 * turn. First attempt = just the brief (byte-identical to the seed user
 * message). Retries fold the rejected output + the correction into ONE user
 * message so the fast model sees the same feedback the SDK path delivers as
 * separate turns.
 */
export const flattenHistoryToUser = (history: ScriptMsg[]): string =>
  history.length <= 1
    ? history[0]?.content ?? ""
    : history
        .map((m) =>
          m.role === "user"
            ? m.content
            : `--- Your previous response (rejected; see the correction below) ---\n${m.content}`,
        )
        .join("\n\n");

/**
 * Fireworks transport over castCall → GLM-5.2. `json:true` (the script is a
 * JSON contract — kills the fence/parse failure class at the decoder) and
 * bounded high-effort thinking for the taste work. castCall owns its own retry
 * ladder (429 / transport drops); the z.ai balance breaker does NOT apply here.
 * Exported so the transport wire is unit-testable in isolation.
 */
export const fireworksScriptTransport: ScriptTransport = async (history) => {
  const r = await castCall({
    // Spend label set HERE rather than at the routes on purpose: this one line
    // attributes the production outline path, the dev route, AND the offline
    // lab harness (.data/outline-matrix/gen.mjs esbuild-bundles generateScript
    // directly). Those ~180 unlabelled lab generations were most of August's
    // $31.17 accounting gap.
    stage: "outline",
    // 300s, from 94 measured generations: median 79s, p95 185s, p99 463s. The
    // 120s default aborted roughly one in eight legitimate outlines and then
    // reported it as a provider error.
    timeoutMs: 300_000,
    system: SCRIPT_GENERATOR_SYSTEM_PROMPT,
    user: flattenHistoryToUser(history),
    maxTokens: 16000,
    effort: "high",
    json: true,
    model: fireworksScriptModel(),
  });
  return {
    text: r.text ?? "",
    usage: {
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
};

/** Options for generateScript. `transport` is a test seam — production resolves
 *  the transport from RB_SCRIPT_PROVIDER. */
export interface ScriptGenOptions {
  transport?: ScriptTransport;
}

/**
 * Run Agent 1 with auto-retry on validation failure.
 *
 * Same pattern as Stage 5.5 in PRODUCT.md: when the agent's output
 * doesn't pass our validator (bad JSON, schema mismatch, unreadable
 * text), feed the failure back as the next turn and let the agent
 * fix it. Up to 2 retries before giving up.
 *
 * The user just sees a longer "generating" spinner; they don't see
 * the retry loop. If we exhaust attempts, the final error surfaces
 * with the last failure reason.
 */
export const generateScript = async (
  brief: AgentBrief,
  briefId: string,
  opts?: ScriptGenOptions,
): Promise<ScriptGenerationResult> => {
  // Resolve the transport ONCE. Production generates via castCall on
  // Fireworks; tests inject `opts.transport` to drive the loop without a live
  // provider. (The legacy z.ai Anthropic-SDK path was removed 2026-07-23 —
  // the stack is Fireworks-only, founder call.)
  const transport: ScriptTransport = opts?.transport ?? fireworksScriptTransport;

  const initialUserMessage = buildUserMessage(brief);
  const history: ScriptMsg[] = [{ role: "user", content: initialUserMessage }];

  let totalUsage = EMPTY_USAGE;
  let lastError = "Unknown error.";
  /** Set when the next reply should be JUST the named scenes (see below). */
  let repair: { base: Record<string, unknown>; indexes: number[] } | null = null;
  /** The most recent parsed candidate, kept purely so a failure can show its work. */
  let lastCandidate: unknown = null;
  /** Extra repair rounds granted so far (see MAX_REPAIR_ROUNDS). */
  let repairRounds = 0;
  /** The previous round's flagged set, to detect a repair that is not converging. */
  let lastFlaggedKey = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS + repairRounds; attempt++) {
    let result: { text: string; usage: Usage };
    try {
      result = await transport(history);
    } catch (err) {
      // castCall owns the 429/5xx/network retry ladder, so anything surfacing
      // here is terminal for THIS ATTEMPT — which is what the comment always
      // said and what the code did not do: it returned, ending the whole
      // generation with attempts still unspent. Seen live as "cast HTTP 200:
      // unparseable response" killing a 12-page run on its first try. A
      // provider hiccup must cost one roll of the dice, not the user's deck.
      lastError = `Fireworks script-gen error: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[script] attempt ${attempt} transport error, retrying: ${lastError}`);
      if (attempt >= MAX_ATTEMPTS + repairRounds) {
        return { ok: false, error: lastError };
      }
      // Nothing was produced, so there is nothing to correct — just try again.
      continue;
    }

    totalUsage = addUsage(totalUsage, result.usage);

    const raw = result.text.trim();
    if (!raw) {
      lastError = "No text content in model response.";
      // Push placeholder assistant message + retry instruction.
      history.push({
        role: "assistant",
        content: "(no text)",
      });
      history.push({
        role: "user",
        content:
          "Your last response had no text content. Re-emit the Script JSON only. No prose, no fence.",
      });
      continue;
    }

    const cleaned = stripCodeFence(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
      // SCENE REPAIR: when the previous attempt asked for a few scenes rather
      // than a whole script, the model answers with just those scenes. Splice
      // them into the outline we already had instead of treating the reply as
      // a new script (which would fail "Missing top-level key: config").
      if (repair) {
        // A repair turn asked for JUST the flagged scenes, so the reply is a
        // bare array — which on its own is NOT a Script. Every branch here must
        // end with `parsed` being a whole Script object again.
        //
        // The unguarded version of this cost an outline outright: a reply whose
        // scene count did not match left the bare array in `parsed`, so the deck
        // became a headless list, every GOOD scene was thrown away, and the next
        // attempt was told to fix "Missing top-level key: config" — a defect the
        // model never produced and could not act on. Observed live, twice in six
        // runs. A repair that misses must cost nothing but the attempt.
        const base = structuredClone(repair.base) as { scenes: unknown[] };
        const fixed = Array.isArray(parsed)
          ? parsed
          : ((parsed as { scenes?: unknown[] } | null)?.scenes ?? null);

        if (Array.isArray(fixed) && fixed.length === repair.indexes.length) {
          // The expected shape: one replacement per flagged scene, in order.
          //
          // MERGE, never replace. A repair turn asks for one scene in
          // isolation, so the model answers with the part it was asked to fix
          // and readily drops structural fields it was not thinking about —
          // observed live as "scenes[0].start_seconds must be 0, got
          // undefined", a defect invented by the repair rather than found by
          // it. Anything the reply omits is inherited from the scene it
          // replaces, so a repair can only ever improve the scene.
          repair.indexes.forEach((sceneIdx, i) => {
            if (sceneIdx < 0 || sceneIdx >= base.scenes.length) return;
            const original = base.scenes[sceneIdx];
            const replacement = fixed[i];
            base.scenes[sceneIdx] =
              original && typeof original === "object" && replacement && typeof replacement === "object"
                ? { ...(original as object), ...(replacement as object) }
                : replacement;
          });
          parsed = base;
        } else if (Array.isArray(fixed) && fixed.length === base.scenes.length) {
          // The model re-emitted EVERY scene instead of the flagged ones. Not
          // what was asked, but unambiguous and safe to take wholesale.
          base.scenes = fixed;
          parsed = base;
        } else {
          // Unusable. Keep the base — its good scenes are still the best draft
          // we have — and let the ORIGINAL complaint drive the next correction
          // rather than a structural error invented by the failed repair.
          parsed = base;
        }
        repair = null;
      }
    } catch (err) {
      lastError = `Output was not valid JSON (${err instanceof Error ? err.message : String(err)}).`;
      history.push({ role: "assistant", content: raw });
      history.push({
        role: "user",
        content: `Your previous output was not valid JSON: ${lastError}. Emit ONLY the Script JSON object. No prose, no markdown fence.`,
      });
      continue;
    }

    const withIdentity = injectIdentity(parsed, brief, briefId);
    const withAssets = mergePreallocatedAssets(withIdentity, brief);
    // Strip prose-as-value KPI meta entries before validation so a value-less
    // stat tile (blank number slot) never reaches the design pass. Then
    // backfill any missing scene registers (GLM omits them sporadically, and
    // exemplar selection + the Design Agent's layout archetypes key on them).
    const normalized = backfillSceneRegisters(normalizeScriptContent(withAssets));
    // The NORMALISED candidate, not the raw parse. The last-resort completion
    // patches this object and re-validates it, and the raw parse has not been
    // through injectIdentity / asset merge / register backfill — so re-checking
    // it failed for reasons that had nothing to do with the thin scene, and the
    // salvage declined silently on every real run while passing every unit
    // test. Whatever was VALIDATED is what must be patched.
    lastCandidate = normalized;
    // Canvas pivot: the document kind is the BRIEF's choice — stamp it before
    // validation so deck-aware checks (and everything downstream) see it.
    stampDocumentKind(normalized, brief.kind);
    const validation = validateScript(normalized, {
      brandName: brandShortName(brief.brand_extract), // Audit-1 P0 #1 (SSOT — was raw title)
      deck: brief.kind === "deck",
    });
    if (validation.ok) {
      // Duration guard: the requested duration is authoritative. If the
      // agent collapsed the video (sizing scenes like ~1s animation beats),
      // reject and retry — never ship a 5s video for a 30s brief.
      const wantSec = brief.duration_seconds;
      const gotSec = validation.script.config.duration_seconds;
      if (
        typeof wantSec === "number" &&
        wantSec > 0 &&
        Math.abs(gotSec - wantSec) > 0.5 &&
        attempt < MAX_ATTEMPTS + repairRounds
      ) {
        lastError = `config.duration_seconds is ${gotSec}s but the brief requires ${wantSec}s.`;
        history.push({ role: "assistant", content: raw });
        history.push({
          role: "user",
          content: buildDurationRetryMessage(
            wantSec,
            gotSec,
            validation.script.scenes.length,
          ),
        });
        continue;
      }
      // Invented-claim guard (QA S5, tightened — the fabricated-38ms fix):
      // reject stat-shaped numbers in the copy that aren't grounded in the
      // allowed sources. Cheaper than catching it at the design stage (E2
      // backstops it) — and critical, because the design stage trusts script
      // content, so an invented stat that survives here is laundered into
      // "approved content" downstream. The agent gets the exact tokens to fix.
      const sourceText = claimGroundingSources(brief);
      const scriptCopy = sceneClaimCopy(validation.script.scenes);
      // Claim surfaces strict; captions tolerate plain diegetic prices (a
      // checkout total echoed under a mock is set dressing, not a proof stat) —
      // the Klarna full-pipe fix, so a valid rich script isn't blocked forcing
      // the model to strip a checkout figure it has no grounded alternative for.
      const { strict: strictCopy, caption: captionCopy } = sceneClaimCopyByStrictness(validation.script.scenes);
      const ungrounded = [
        ...findUngroundedClaims(strictCopy, sourceText),
        ...findUngroundedClaims(captionCopy, sourceText, { exemptDiegeticPrices: true }),
      ].filter((t, i, a) => a.indexOf(t) === i);
      // QA G5: also catch a fabricated funding-stage label ("Series C" when the
      // brief only says "$250M funding round").
      const ungroundedStages = findUngroundedStageLabels(scriptCopy, sourceText);
      // NO BUDGET LEFT AND STILL FABRICATED → FAIL. This guard used to read
      // `attempt < MAX`, so on the final attempt the whole block was skipped
      // and execution fell through to `return { ok: true }` — shipping the
      // invented number. The comment above says exactly why that is the worst
      // possible outcome: the design stage TRUSTS script content, so a stat
      // that survives here is laundered into "approved content" and then
      // printed on a page in somebody's investor deck. A failed generation
      // costs a retry; a fabricated statistic costs their credibility. Found by
      // a test asserting a made-up "38ms" could never reach a user.
      const fabricated = ungrounded.length > 0 || ungroundedStages.length > 0;
      if (fabricated && attempt >= MAX_ATTEMPTS + repairRounds) {
        return {
          ok: false,
          error: `Ungrounded numeric claims survived every attempt: ${[...ungrounded, ...ungroundedStages].join(", ")}`,
        };
      }
      if (fabricated) {
        lastError = [
          ungrounded.length > 0 ? `Ungrounded numeric claims: ${ungrounded.join(", ")}` : "",
          ungroundedStages.length > 0 ? `Ungrounded funding-stage labels: ${ungroundedStages.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ");
        history.push({ role: "assistant", content: raw });
        const msgs: string[] = [];
        if (ungrounded.length > 0)
          msgs.push(
            `These numeric claims are NOT grounded in any allowed source (the user's brief, verified claims, or the crawled site content): ${ungrounded.join(", ")}. For EACH of those exact tokens, either (a) replace it with qualitative copy (e.g. "38ms" → "in milliseconds", "$840M processed" → "billions processed"), or (b) replace it with a fact that appears VERBATIM in the crawled site content or verified claims — never invent specific stats, and never reuse the flagged number with a different unit. (The flagged tokens live in viewer-facing copy fields; plausible mock values inside a diegetic UI described in visual_concept are exempt set dressing — keep those concrete, never masked.)`,
          );
        if (ungroundedStages.length > 0)
          msgs.push(
            `These funding-stage labels aren't stated anywhere in the brief or crawled content: ${ungroundedStages.join(", ")}. The brief mentions a raise but NOT the stage — drop the invented label (say "funding round" / "their raise"), never fabricate "Series C" or similar.`,
          );
        history.push({ role: "user", content: msgs.join("\n\n") });
        continue;
      }
      // Visual-richness guard: every scene's visual_concept must specify a
      // concrete non-text/diegetic element — not a headline + ambient glow.
      // The "wall of type" failure (manifesto angle) originates HERE, in the
      // visual_concept, and the build faithfully renders it; this is the
      // cheapest stage to force a real visual per scene.
      const typeOnly = findTypeOnlyScenes(validation.script.scenes);
      if (typeOnly.length > 0 && attempt < MAX_ATTEMPTS + repairRounds) {
        lastError = `Type-only scenes (no diegetic visual): ${typeOnly.join(", ")}`;
        history.push({ role: "assistant", content: raw });
        history.push({
          role: "user",
          content: buildVisualRichnessRetryMessage(typeOnly),
        });
        continue;
      }
      return {
        ok: true,
        script: validation.script,
        usage: totalUsage,
      };
    }

    // Validation failed.
    //
    // REPAIR THE SCENES THAT MISSED, rather than asking for a whole new
    // outline. Measured over a 14-run matrix (2026-08-06): 3 failures, and
    // every one of them missed only ONE OR TWO scenes out of six or twelve —
    // "607 chars, 2 drawable nouns" where three are wanted, "1 interior
    // detail" where two are. Near misses, not bad outlines.
    //
    // Re-emitting the COMPLETE script (what this used to ask for) re-rolls
    // every scene on every attempt, so a twelve-scene outline needs all
    // twelve to land at once, three times running. That does not converge —
    // it reshuffles which scene misses, which is exactly what a founder hit:
    // three attempts, still one scene short, dead end after a paid minute.
    lastError = validation.error;
    // Both spellings. The validator says "Scene 4: visual_concept too thin"
    // for visual rules and "Section 5 content.headline is two sentences" for
    // copy rules — the SAME index, in two vocabularies. Matching only "Scene"
    // meant every copy failure skipped repair and re-rolled the whole deck,
    // which is how a one-line headline fix burned three attempts and failed a
    // 12-page outline. Boundary errors are excluded: they are a relationship
    // BETWEEN scenes, so rewriting one in isolation cannot fix them.
    const scenePattern = /\b(?:Scene|Section) (\d+)\b/g;
    const failedScenes = /boundary mismatch/i.test(validation.error)
      ? []
      : [...validation.error.matchAll(scenePattern)]
      .map((m) => Number(m[1]))
      .filter((n, i, a) => Number.isFinite(n) && a.indexOf(n) === i);
    const baseScenes = (parsed as { scenes?: unknown[] } | null)?.scenes;
    const repairable =
      failedScenes.length > 0 &&
      Array.isArray(baseScenes) &&
      baseScenes.length > 0 &&
      failedScenes.every((n) => n < baseScenes.length) &&
      // A minority. If most of the outline is wrong, the outline is wrong.
      failedScenes.length <= Math.max(1, Math.floor(baseScenes.length / 2));

    history.push({ role: "assistant", content: raw });
    if (repairable) {
      // Grant an extra round while the flagged set is still moving. Identical
      // complaints on identical scenes mean the model is stuck, and more of
      // the same would only spend the user's time.
      const flaggedKey = `${failedScenes.join(",")}|${validation.error.slice(0, 120)}`;
      if (
        attempt >= MAX_ATTEMPTS + repairRounds &&
        repairRounds < MAX_REPAIR_ROUNDS &&
        flaggedKey !== lastFlaggedKey
      ) {
        repairRounds++;
      }
      lastFlaggedKey = flaggedKey;
      repair = { base: parsed as Record<string, unknown>, indexes: failedScenes };
      history.push({
        role: "user",
        content: buildSceneRepairMessage(validation.error, failedScenes, baseScenes.length),
      });
    } else {
      history.push({
        role: "user",
        content: buildRetryMessage(validation.error, attempt),
      });
    }
  }

  // ── last resort: finish the outline rather than destroy it ────────────────
  //
  // Attempts are spent. But what is in hand at this point is almost always
  // ELEVEN good scenes and one that fell a noun or an interior short — and the
  // very next screen is the outline REVIEW, where the user reads and edits
  // every visual brief before a single page is designed.
  //
  // Measured across eight 14-run matrix passes: about one generation in seven
  // ended here, and every one of those users waited two minutes, paid for the
  // call, and got a wall of red they could do nothing with. A slightly generic
  // brief on one scene costs them one edit. That is the trade, and it is not
  // close.
  //
  // STRICTLY BOUNDED. It fires only when every remaining complaint is one of
  // the two SOFT scene rules — a thin visual_concept, or a container named
  // without its interior. Anything structural, anything about grounded claims,
  // anything about copy, and this does not run: those are wrong in ways a
  // generic clause cannot honestly fix, and shipping them would be worse than
  // failing.
  // A MISSING visual_concept counts as soft too. The model dropped the field
  // on one page out of twelve and took eleven good scenes down with it. There
  // is nothing to append to, but the scene still carries its own headline and
  // register — real content, not invention — so a concept can be composed from
  // what the page actually says.
  // NOTE THE COLON, or rather its absence. The richness rules say
  // "Scene 4: visual_concept too thin"; the missing-field rule says
  // "Scene 8 missing or empty visual_concept" with no colon at all. A pattern
  // that assumed the colon silently matched nothing and the repair never ran —
  // caught by a test that expected the salvage and watched it decline.
  // BOTH VOCABULARIES AGAIN — "Scene N:" for richness, "Scene N " with no
  // colon for the missing field, "Section N" for copy. Each of those spellings
  // has already cost a repair that silently never ran; there is no fourth
  // chance worth taking.
  const SOFT_ONLY = new RegExp(
    '^(?:Scene \\d+:? (?:visual_concept too thin|names "|missing or empty visual_concept)' +
      '|Section \\d+ content\\.cta\\.primary .* duplicates the headline)',
  );

  /** The soft scene indexes named by a validator error, or null if any complaint is not soft. */
  const softIndexes = (error: string): number[] | null => {
    const complaints = error.split("|").map((c) => c.trim()).filter(Boolean);
    if (complaints.length === 0 || !complaints.every((c) => SOFT_ONLY.test(c))) return null;
    return [...new Set(
      complaints
        .map((c) => Number(/^(?:Scene|Section) (\d+)[: ]/.exec(c)?.[1]))
        .filter((n) => Number.isFinite(n)),
    )];
  };

  // ITERATE. validateScript returns on the FIRST failing group, so a rule can
  // sit MASKED behind the one that was reported: patch the thin scene,
  // re-validate, and a cliché on a different scene — invisible until now —
  // fires instead. A single-shot salvage repaired the reported complaint and
  // then declined on the newly-revealed one, while the error shown to the user
  // still named the rule that had already been fixed. That is the whole reason
  // "a different rule each pass" looked like whack-a-mole: the labels were
  // misattributed. Keep going while every newly-surfaced complaint is still
  // soft and progress is being made.
  const MAX_SALVAGE_ROUNDS = 4;
  let candidate = lastCandidate as { scenes?: Record<string, unknown>[] } | null;
  let salvageError = lastError;
  let salvaged: Script | null = null;
  /** Why the salvage gave up, when that is truer than the complaint it started from. */
  let refusal: string | null = null;
  const completedAll = new Set<number>();

  for (let round = 0; round < MAX_SALVAGE_ROUNDS; round++) {
    const indexes = softIndexes(salvageError);
    if (!indexes || indexes.length === 0) break;
    if (!candidate || !Array.isArray(candidate.scenes) || candidate.scenes.length === 0) break;

    const patched = structuredClone(candidate) as { scenes: Record<string, unknown>[] };
    let completed = 0;

    // A call-to-action that merely repeats the headline is dropped HERE, at the
    // last resort, rather than pre-validation. Dropping it removes the whole
    // cta object (validateScript requires cta.primary whenever cta exists), and
    // 52 of the 292 stored decks pair an echoed primary with a real secondary —
    // a closing-slide URL. Doing it early deleted that link on the first
    // attempt for a defect the model usually fixes when asked. Here the model
    // has already been asked, twice, and a deck without its link beats no deck.
    if (/duplicates the headline/.test(salvageError)) {
      for (const i of indexes) {
        const scene = patched.scenes[i];
        const content = scene?.content;
        if (!content || typeof content !== "object") continue;
        const deEchoed = dropEchoedCta(content as Record<string, unknown>);
        if (deEchoed) {
          scene.content = deEchoed;
          completed++;
          completedAll.add(i);
        }
      }
      if (completed === indexes.length) {
        const rechecked = validateScript(patched, {
          brandName: brandShortName(brief.brand_extract),
          deck: brief.kind === "deck",
        });
        candidate = patched;
        if (rechecked.ok) {
          salvaged = rechecked.script;
          break;
        }
        if (rechecked.error === salvageError) break;
        salvageError = rechecked.error;
        continue;
      }
      break;
    }

    for (const i of indexes) {
      const scene = patched.scenes[i];
      if (!scene) continue;
      const existing = typeof scene.visual_concept === "string" ? scene.visual_concept.trim() : "";
      // Seed from the page's OWN headline when the field is missing entirely,
      // so the composed concept describes this page rather than any page.
      // completeVisualConcept refuses an empty string by design, and rightly:
      // it appends, it does not author.
      const headline =
        (scene.content as { headline?: unknown } | undefined)?.headline;
      const seed =
        existing ||
        (typeof headline === "string" && headline.trim()
          ? `The page carries the line "${headline.trim()}" as its hero.`
          : "");
      if (!seed) continue;
      const better = completeVisualConcept(
        seed,
        typeof scene.register === "string" ? scene.register : undefined,
      );
      if (better) {
        scene.visual_concept = better;
        completed++;
        completedAll.add(i);
      }
    }
    if (completed !== indexes.length) {
      console.warn(
        `[script] last-resort completion stopped: finished ${completed} of ${indexes.length} flagged scene(s) in round ${round + 1}`,
      );
      break;
    }

    const recheck = validateScript(patched, {
      brandName: brandShortName(brief.brand_extract),
      deck: brief.kind === "deck",
    });
    if (!recheck.ok) {
      // A DIFFERENT complaint than last round means progress — the masked rule
      // is now visible and may itself be soft. The same complaint twice means
      // the repair is not working, and another round would only repeat it.
      if (recheck.error === salvageError) {
        console.warn(`[script] last-resort completion stopped: no progress on "${recheck.error.slice(0, 120)}"`);
        break;
      }
      console.warn(`[script] last-resort completion round ${round + 1} revealed: ${recheck.error.slice(0, 160)}`);
      candidate = patched;
      salvageError = recheck.error;
      continue;
    }

    // validateScript is NOT the whole contract. Grounding and funding-stage
    // checks live in the loop AFTER it, so a salvage that only re-ran
    // validateScript would wave an invented statistic straight through.
    const salvageSource = claimGroundingSources(brief);
    const byStrictness = sceneClaimCopyByStrictness(recheck.script.scenes);
    const stillFabricated = [
      ...findUngroundedClaims(byStrictness.strict, salvageSource),
      ...findUngroundedClaims(byStrictness.caption, salvageSource, { exemptDiegeticPrices: true }),
      ...findUngroundedStageLabels(sceneClaimCopy(recheck.script.scenes), salvageSource),
    ];
    if (stillFabricated.length > 0) {
      // REPORT THIS, not the complaint we started from. Observed in a 14-run
      // pass: the salvage repaired a thin scene, revalidated clean, and was
      // then refused because the model had invented "12 seconds" — and the
      // user was shown the stale "only 1 interior detail" message, so the
      // route's actionable "those figures aren't in your brief" copy never
      // fired. A failure must name the reason it actually failed for.
      refusal = `Ungrounded numeric claims survived every attempt: ${stillFabricated.join(", ")}`;
      console.warn(`[script] last-resort completion refused: ungrounded claims ${stillFabricated.join(", ")}`);
      break;
    }
    salvaged = recheck.script;
    break;
  }

  if (salvaged) {
    const finished = [...completedAll].sort((a, b) => a - b);
    console.warn(
      `[script] completed ${finished.length} thin visual_concept(s) deterministically after ${MAX_ATTEMPTS + repairRounds} attempts rather than failing the outline (scenes ${finished.join(", ")})`,
    );
    return { ok: true, script: salvaged, usage: totalUsage, completedScenes: finished };
  }

  if (refusal) lastError = refusal;

  // Keep the EVIDENCE. A failure used to surface only the validator's
  // complaint ("2 drawable nouns"), never the prose it was counting, so every
  // investigation had to re-derive what the model actually wrote. The last
  // candidate's flagged scenes ride along; callers log it, users never see it.
  const flagged = [...lastError.matchAll(/\b(?:Scene|Section) (\d+)\b/g)].map((m) => Number(m[1]));
  const lastScenes = (lastCandidate as { scenes?: { label?: string; visual_concept?: string }[] } | null)?.scenes;
  const evidence =
    Array.isArray(lastScenes) && flagged.length
      ? flagged
          .filter((i) => i >= 0 && i < lastScenes.length)
          .map((i) => ({
            scene: i,
            label: lastScenes[i]?.label ?? "",
            visual_concept: lastScenes[i]?.visual_concept ?? "",
          }))
      : [];

  return {
    ok: false,
    error: `Schema validation failed after ${MAX_ATTEMPTS + repairRounds} attempts. Last error: ${lastError}`,
    evidence,
  };
};

const buildVisualRichnessRetryMessage = (sceneIndexes: number[]): string => {
  const list = sceneIndexes.map((i) => `scene ${i}`).join(", ");
  return [
    `${list} ${sceneIndexes.length === 1 ? "is" : "are"} type-only — the visual_concept is just a headline plus ambient decoration (ember / glow / hairline / gradient), with nothing to look at. A static check rejects this.`,
    "",
    "EVERY scene must build a substantial NON-TEXT / diegetic element, manifestos included. Rewrite the flagged scenes' visual_concept to specify a concrete visual: a product mock or the brand's real UI (use the crawled page_images), a dashboard / panel / browser window, a diagram or node graph, a chart or data-viz, a logo / trust-bar, a stat counter, an annotated illustration. 'Big headline + ember glow' is not a visual.",
    "",
    "Look at how a strong scene reads: not \"a single enormous manifesto line on a dark field\" but \"a beveled origination panel with PENDING/MANUAL/QUEUED rows beside the headline.\" Keep the copy; give each scene something to render.",
  ].join("\n");
};

const buildDurationRetryMessage = (
  want: number,
  got: number,
  sections: number,
): string => {
  const avg = (want / Math.max(1, sections)).toFixed(1);
  return [
    `Your output set config.duration_seconds = ${got}s, but the brief requires EXACTLY ${want}s. You collapsed the video — this is the #1 failure to avoid.`,
    "",
    `Fix it: set config.duration_seconds = ${want}, and re-tile ALL ${sections} sections to fill 0→${want} with no gaps (scenes[0].start_seconds = 0, last scene end_seconds = ${want}, adjacent boundaries match). That averages ~${avg}s per section — each section is a MOMENT that must land, not a ~1-second flash.`,
    "",
    `"Per beat" pacing (0.8–4s) describes how often motion fires INSIDE a section — it is NOT the length of a section. A fast-paced ${avg}s section still runs ${avg}s.`,
    "",
    "Re-emit the COMPLETE Script JSON. Output ONLY the JSON object. No prose, no fence.",
  ].join("\n");
};

/**
 * Ask for ONLY the scenes that missed.
 *
 * The reply is a bare JSON array, in the same order as the indexes given, and
 * the caller splices it back into the outline it already has. Keeping the rest
 * of the script untouched is the whole point: the scenes that passed were fine,
 * and re-rolling them is what stopped the old retry from ever converging.
 */
const buildSceneRepairMessage = (
  error: string,
  indexes: number[],
  totalScenes: number,
): string => {
  // Match BOTH vocabularies (see the caller): visual rules say "Scene 4:",
  // copy rules say "Section 5 content.headline". Filtering on "Scene" alone
  // produced a repair request that quoted no complaint at all.
  const per = error
    .split("|")
    .map((s) => s.trim())
    .filter((s) => indexes.some((i) => new RegExp(`^(?:Scene|Section) ${i}\\b`).test(s)));
  return [
    `${indexes.length} of your ${totalScenes} scenes fell short. Everything else is good and must NOT change.`,
    "",
    ...per.map((line) => `- ${line}`),
    "",
    `Re-emit ONLY those scenes — index ${indexes.join(", ")} — as a JSON ARRAY of scene objects, in that exact order.`,
    "Keep each scene's label, timing and content; the fix belongs in visual_concept.",
    "",
    "What the check is counting, so you can satisfy it deliberately:",
    // The counter is a CLOSED whitelist. Describing it as a category — "things
    // with edges", with examples and an ellipsis — is what produced 538- and
    // 602-character concepts that scored 2: the imagery was genuinely drawable,
    // just not in the set. Quote the set. It is generated from the matcher
    // itself, so it cannot drift out of date.
    "- CONCRETE DRAWABLE NOUNS. A literal word-match, NOT a judgement of vividness. Only these words count, and you need at least THREE DIFFERENT ones, spelled this way (plurals are fine):",
    `  ${drawableVocabulary().join(", ")}`,
    "  Imagery outside this list scores ZERO however vivid — \"a conveyor belt of invoices dropped into a tray\" counts ONE (invoice). Adjectives, moods, gradients and glows count nothing.",
    `  TRAP: ${containerVocabulary().join(" / ")} are CONTAINERS — each one you name needs >=2 things named INSIDE it, or it fails a different rule. Reaching three via non-container words (bar, sparkline, logo, badge, arrow, invoice, counter) is cheaper and safer.`,
    `- INTERIOR DETAIL: naming any of ${containerVocabulary().join(" / ")} promises an interior, and an unfurnished one FAILS. You have two ways out and both are fine: FURNISH it (name >=2 things drawn inside, AND THOSE ARE A CLOSED LIST TOO — only these count: ${interiorVocabulary().join(", ")}), or DROP THE WORD and say what is actually there with non-container nouns (bar, sparkline, logo, badge, arrow, invoice, counter). "approval cards showing a name, an amount and a status pill" counts ZERO interiors — name, amount and pill are not in that list. Say "rows with labels and values" and it counts two.`,
    "Length is not the problem: these scenes were already long. Add the missing OBJECTS.",
    "",
    "Output ONLY the JSON array. No prose, no fence.",
  ].join("\n");
};

const buildRetryMessage = (error: string, attemptNumber: number): string => {
  return [
    `Attempt ${attemptNumber} failed validation: ${error}`,
    "",
    "Fix the issue and re-emit the COMPLETE Script JSON. Common gotchas to recheck:",
    "- Every section has visual_concept (1-3 sentences of prose) AND content { texts, asset_ids }.",
    "- Every entry in content.texts has at least 2 readable letters/digits. No emoji-only, no symbol-only, no single-char strings.",
    "- Section labels equal the user's moment titles verbatim (pre-structured mode).",
    "- scenes tile [0, total_duration_seconds] exactly: first.start_seconds=0, last.end_seconds=total, adjacent boundaries match (decimal seconds ok).",
    "- Do NOT emit scene.elements[], scene.background, or scene.audio_cues — section spec uses visual_concept + content only.",
    "",
    "Output ONLY the JSON object. No prose, no fence.",
  ].join("\n");
};

const CREATIVITY_GUIDANCE: Record<CreativityLevel, string> = {
  literal:
    "Render the description as-written. Minimal visual embellishment in visual_concept. Conservative motion (fades, gentle translates, no spring). Keep atmosphere subtle.",
  balanced:
    "Honor the description's intent. Write a layered visual_concept with composition + motion + atmosphere. Brand-aligned color, considered choreography, restrained spectacle.",
  bold:
    "Take creative liberties on the visual metaphor. Lean into kinetic typography, spring scales, screen-shake on impact, layered background motion. The description sets intent; visual_concept sets the spectacle.",
};

const formatToAspect = (
  f: "mobile-feed" | "square" | "landscape" | undefined,
): "9:16" | "1:1" | "16:9" | null => {
  if (f === "mobile-feed") return "9:16";
  if (f === "square") return "1:1";
  if (f === "landscape") return "16:9";
  return null;
};

const formatToViewingContext = (
  f: "mobile-feed" | "square" | "landscape" | undefined,
): "mobile" | "desktop" | null => {
  if (f === "mobile-feed" || f === "square") return "mobile";
  if (f === "landscape") return "desktop";
  return null;
};

/**
 * The COMPUTED per-scene beat floor (retry audit class 6). The validator
 * (checkScriptRichness) rejects any scene whose latest timed beat lands under
 * 0.5× its duration — a rule the prompt states but the model measurably
 * cannot arithmetic on the fly (v5-v7: beat-coverage rejects on most first
 * attempts). This works the arithmetic FOR the model at the even split and
 * states the recompute rule for uneven boundaries. Exported for tests.
 */
export const beatFloorLines = (durationSeconds: number, momentCount: number): string[] => {
  const d = durationSeconds / Math.max(1, momentCount);
  const f = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
  const lines = [
    `BEAT-COVERAGE ARITHMETIC (computed for THIS brief — a validator rejects any scene under its floor):`,
    `- Rule: per scene, the LATEST timed beat you write ("at X.Xs" / "from X.Xs" — infinite-loop start times count) must be ≥0.5× that scene's duration D; target ≥0.6×D.`,
    `- At an even ${momentCount}-way split of ${durationSeconds}s, each scene runs D=${f(d)}s:`,
    ...Array.from({ length: momentCount }, (_, i) => {
      const start = d * i;
      const end = d * (i + 1);
      return `    Scene ${i} runs ${f(start)}-${f(end)}s (D=${f(d)}s): your latest timed beat must be ≥0.5×${f(d)} = ${f(d * 0.5)}s, target ≥0.6×${f(d)} = ${f(d * 0.6)}s.`;
    }),
    `- If you allocate time differently (you should — weight by content), REDO this arithmetic with YOUR D per scene BEFORE writing its Animations list, and write the absolute timestamps. Beats are scene-relative (each scene's clock starts at 0).`,
  ];
  return lines;
};

/** Inert per-slide timing stub for decks (canvas pivot): timings must exist
 *  for schema compatibility but are never shown or animated. 5s/slide keeps
 *  any deck of ≤12 slides under the validator's 60s duration cap. */
import { DECK_SECONDS_PER_SLIDE } from "./outline-scene-ops";
export { DECK_SECONDS_PER_SLIDE };

/** Deterministically stamp config.kind from the BRIEF (canvas pivot) — the
 *  document kind is the caller's choice, never trusted from model output. */
const stampDocumentKind = (input: unknown, kind?: "video" | "deck"): void => {
  if (!input || typeof input !== "object") return;
  const cfg = (input as { config?: unknown }).config;
  if (cfg && typeof cfg === "object") {
    (cfg as Record<string, unknown>).kind = kind ?? "video";
  }
};

export const buildUserMessage = (brief: AgentBrief): string => {
  const momentCount = brief.moment_count;
  // `?.length`, not truthiness: an EMPTY moments array means "the user gave me
  // no structure", exactly like an absent one — but `![]` is false, so the bare
  // check sent freeform briefs down the pre-structured branch. Blank documents
  // (lib/documents/blank-document.ts) carry `moments: []`, so every "generate
  // every page for me" run hit this: the brief was announced as PRE-STRUCTURED,
  // the moment list rendered empty, and the user's actual prompt was never
  // included. It generated a deck from nothing instead of failing. The
  // length-aware form below is already the idiom used further down this file.
  const isFreeform = !!brief.freeform_prompt && !brief.moments?.length;
  const isDeck = brief.kind === "deck";
  const deckDuration = momentCount * DECK_SECONDS_PER_SLIDE;
  const userAspect = formatToAspect(brief.distribution_format);
  const userViewing = formatToViewingContext(brief.distribution_format);

  const lines: string[] = [
    isFreeform
      ? "Generate a Script JSON from this FREEFORM brief. You decide the per-moment content."
      : "Generate a Script JSON from this PRE-STRUCTURED brief.",
    "",
    "Hard constraints you MUST honor:",
    ...(isDeck
      ? [
          "- This is a STATIC PRESENTATION DECK: each scene is one still SLIDE (a designed page), not an animated video. Nothing on a slide moves.",
          `- Timing fields are INERT schema metadata on a deck: SET config.duration_seconds = ${deckDuration} and tile the scenes exactly ${DECK_SECONDS_PER_SLIDE}s each — scenes[i].start_seconds = i×${DECK_SECONDS_PER_SLIDE}, scenes[i].end_seconds = (i+1)×${DECK_SECONDS_PER_SLIDE}. These numbers are never shown; write no OTHER timing anywhere.`,
        ]
      : [
          `- Total duration: EXACTLY ${brief.duration_seconds} seconds — AUTHORITATIVE. SET config.duration_seconds = ${brief.duration_seconds} and tile every scene across 0→${brief.duration_seconds}. Do NOT pick a shorter total. Do NOT collapse the video into a few seconds. "Per beat" pacing is motion density INSIDE a scene, not scene length.`,
        ]),
    ...(userAspect
      ? [
          `- Aspect ratio: ${userAspect}. The user picked this in the wizard. SET config.aspect_ratio = "${userAspect}". Do NOT override based on prompt keywords — the wizard is authoritative.`,
          `- Viewing context: ${userViewing}. ${userViewing === "mobile" ? "Viewers watch on phone screens; the Design Agent will use a larger body-text floor." : "Viewers watch on desktop; the Design Agent uses tighter typography."}`,
        ]
      : []),
    `- Section count: EXACTLY ${momentCount} ${isDeck ? "slides" : "sections"} — one per moment, in narrative order.`,
    ...(isDeck
      ? []
      : [
          `- Section boundaries: scenes[0].start_seconds === 0, scenes[N-1].end_seconds === ${brief.duration_seconds}, and scenes[i].end_seconds === scenes[i+1].start_seconds for all i. Times are in seconds (decimals allowed: 2.5, 3.2, etc.).`,
        ]),
    "",
    ...(isDeck
      ? [
          "Slide composition (static pages):",
          '- visual_concept = COMPOSITION ONLY: what is on the slide and how it is arranged — layout, hierarchy, the diegetic element and its interior specifics. Do NOT write an Animations list, motion verbs, or timed beats ("at 2.4s"). This is a still page; motion language is dead weight that degrades the design.',
          "",
        ]
      : [
          "Time allocation (your job — don't split evenly):",
          `- Distribute the ${brief.duration_seconds} seconds across the ${momentCount} sections by weight — that averages ~${(brief.duration_seconds / momentCount).toFixed(1)}s per section. Sections are MOMENTS that must land an idea, not 1-second flashes.`,
          `- WEIGHT signals: longer descriptions, more animation cues, bolder creativity, more on-screen content → more time. Intros, transitions, simple holds → less time.`,
          `- Floor: every section gets at least ${Math.min(3, Math.max(1, Math.floor(brief.duration_seconds / momentCount)))} seconds (a moment needs time to land). Ceiling: no section exceeds ${Math.floor(brief.duration_seconds * 0.5)} seconds (50% of total).`,
          `- ALL TIMING IN VISUAL_CONCEPT PROSE MUST BE IN SECONDS. Write "From Xs to Ys:" or "at 2.4s". Never reference frame counts.`,
          "",
          // Retry audit class 6: the beat-coverage rule lived in the prompt but the
          // model flubbed the per-scene arithmetic on every first attempt — so the
          // COMPUTED floor is injected here, worked per scene at the even split,
          // with the recompute rule for uneven boundaries.
          ...beatFloorLines(brief.duration_seconds, momentCount),
          "",
        ]),
  ];

  // Storyline-first directive (both modes). The single biggest lever on
  // richness: make the agent design a narrative spine and stage the
  // sections as moves within it, rather than emitting independent slides.
  lines.push(
    "Design the STORYLINE first (before any section):",
    "- Populate the top-level `narrative` spine: logline (who it's for / the tension / the transformation), arc (how tension builds and releases across the sections), and throughline (the recurring motif — an object, a phrase, a growing number, a tonal shift — that threads the sections into ONE story). PREFER a concrete object/shape/phrase motif over a pure color-wash; if the throughline involves color at all, it is the SIGNATURE BRAND COLOR named in the brand context — NEVER an off-brand or invented hue.",
    isFreeform
      ? "- Treat the prompt as raw material to DRAMATIZE into a story — find the protagonist, the tension, the turn, the payoff. Don't just chop it into labels."
      : "- The user wrote the moments; your job is to find the STORY across them — the arc connecting them and a throughline that makes them read as one narrative, not a list.",
    "- HEADLINE-READ TEST: the sections' headlines, read top to bottom in order, must progress like a story (each advancing toward the CTA), not enumerate features. Rewrite them until they do.",
    "- Each scene.description names that section's ROLE in the arc and its hand-off to the next section.",
    isDeck
      ? "- This is a story-driven PRESENTATION DECK — a sequence of still designed slides that read as ONE narrative. No motion, no camera / shot / footage language."
      : "- This is an animated FRONTEND (a story-driven web experience), never a video — no camera / shot / footage language.",
    "",
  );

  if (isFreeform) {
    lines.push("Brief (freeform — you fill in the section structure):");
    lines.push(`- The user's prompt: ${brief.freeform_prompt!.trim()}`);
    lines.push(
      `- Required output: exactly ${momentCount} sections. You pick the narrative SHAPE — transformation, revelation/build, walkthrough/journey, manifesto, or single-thread escalation (see the system prompt). Do NOT default to "intro → features → CTA".`,
    );
    lines.push(
      "- For each scene: pick a short label (2-6 words, like 'Brand Opening' or 'Solution Reveal'), write a 1-sentence INTENT in scene.description (what this moment accomplishes — NOT the on-screen text), pick a creativity level, assign a `register` (stat | quote | full-bleed | split | list | centered — varied across scenes, no two adjacent the same), and build the visual content.",
    );
    lines.push(
      "- The FINAL scene contains the CTA. Extract it from the prompt if stated; otherwise infer a sensible one for the use case.",
    );
    lines.push(
      "- Set config.tone from the prompt. Set config.pacing from the tone: cinematic / calm / premium / investor → slow; launch / product / walkthrough → medium; sale / promo / social → fast; unsure → medium. Do NOT default to fast. Pacing changes motion density inside scenes, NEVER the total duration.",
    );
    lines.push("");
  } else {
    lines.push("Brief (pre-structured by the user):");
    if (brief.purpose) lines.push(`- Purpose: ${brief.purpose}`);
    if (brief.cta)
      lines.push(`- CTA (appears in the FINAL scene only): ${brief.cta}`);
    lines.push("");
    lines.push(
      `Moments (each becomes one scene, in order; allocate time per the weighting rules above):`,
    );
    brief.moments!.forEach((m, i) => {
      const label = m.title || `Moment ${i + 1}`;
      lines.push(
        `  Scene ${i} — scene.label MUST equal "${label}" verbatim`,
      );
      lines.push(
        `    Creativity: ${m.creativity} — ${CREATIVITY_GUIDANCE[m.creativity]}`,
      );
      lines.push(
        `    User description (USE THIS VERBATIM in scene.description): ${m.description}`,
      );
    });
    lines.push("");
  }

  // Verified claims block — user-supplied real numbers/facts the agent
  // may repeat verbatim. Acts as the 3rd grounding source (alongside
  // body_excerpts and the brief itself) for the hallucination guardrail.
  if (brief.verified_claims && brief.verified_claims.trim().length > 0) {
    lines.push(
      "Verified claims (user-supplied — repeat VERBATIM when relevant; these are confirmed facts you may write as on-screen stats):",
    );
    for (const line of brief.verified_claims
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      lines.push(`  ✓ ${line}`);
    }
    lines.push(
      "These are SAFE to use as specific numbers in scene.content (headline, lede, bullets, meta values). Stat-shaped numbers (currency, %, multipliers like 10x, K/M/B counts, latency like 38ms, percentiles like p50) NOT in this list AND not in the crawled site copy may NOT be invented — the hallucination guardrail matches the FULL token (number + unit) and will fail Pass 1. The guardrail scans VIEWER-FACING copy fields only (headline, lede, bullets, caption, eyebrow, meta, cta) — plausible mock values INSIDE a diegetic UI described in visual_concept are set dressing and exempt; write those concrete, never masked.",
    );
    lines.push("");
  }

  // Brand context block
  const hasFiles = brief.brand_files && brief.brand_files.length > 0;
  const hasUrl = !!brief.brand_kit_url?.trim();
  const hasExtract = !!brief.brand_extract?.ok;
  if (hasFiles || hasUrl || hasExtract) {
    lines.push("Brand materials provided by the customer:");
    if (hasUrl) {
      lines.push(`  - Brand kit URL: ${brief.brand_kit_url!.trim()}`);
    }
    if (hasExtract) {
      const b = brief.brand_extract!;
      lines.push("  Crawled brand signals (USE these to ground type, color, voice):");
      if (b.title) lines.push(`    Site title: ${b.title}`);
      if (b.description) lines.push(`    Description: ${b.description}`);
      // Signature color (QA S3): the hue a viewer associates with the brand —
      // the most vivid palette member, theme_color preferred when chromatic.
      // The script agent used to be told "theme_color = primary accent, lean on
      // it", which let an off-brand hue leak into the throughline (Fuse's
      // throughline literally said "brand-orange" when Fuse is blue). Lead with
      // the signature instead so the script names the RIGHT color.
      const signature = signatureWithLogoFallback(b.palette ?? [], b.theme_color, b.logo_color, b.named);
      if (signature) {
        lines.push(
          `    SIGNATURE BRAND COLOR: ${signature}  ← the hue a viewer associates with this brand; THE accent to lean on (headlines, accent bars, glows) and the only color to name in the throughline. Never call a different/off-brand hue "the brand color".`,
        );
        if (b.theme_color && b.theme_color.trim().toLowerCase() !== signature.toLowerCase())
          lines.push(`    Theme color (meta tag): ${b.theme_color}  ← supporting only, not the lead`);
      } else if (b.theme_color) {
        // Monochrome brand (no chromatic signature) — keep the original guidance.
        lines.push(
          `    Theme color: ${b.theme_color}  ← primary brand accent; lean on this for headlines, accent bars, glows`,
        );
      }
      if (b.palette && b.palette.length > 0) {
        lines.push(
          `    Brand palette (sampled from the site's CSS, frequency-ranked, near-grays filtered): ${b.palette.join(", ")}`,
        );
        lines.push(
          `      → USE the full palette in visual_concepts: the SIGNATURE color leads, secondary accents + neutrals add depth. Mention specific hexes when the concept calls for them.`,
        );
      }
      if (b.fonts && b.fonts.length > 0) {
        const families = uniqueFontFamilies(b.fonts);
        lines.push(
          `    Brand fonts (from @font-face declarations on the site):`,
        );
        for (const f of b.fonts.slice(0, 8)) {
          const meta = [f.weight, f.style, f.format].filter(Boolean).join(" / ");
          lines.push(
            `      ${f.family}${meta ? ` (${meta})` : ""} → ${f.src}`,
          );
        }
        if (b.font_roles) {
          const r = b.font_roles;
          const roleLine = [
            r.display ? `display: ${r.display}` : null,
            r.body ? `body: ${r.body}` : null,
            r.mono ? `mono: ${r.mono}` : null,
          ]
            .filter(Boolean)
            .join(" | ");
          if (roleLine) {
            lines.push(
              `      Classified roles: ${roleLine} — route headlines to the display family, paragraphs/lede to body, URLs/code to mono.`,
            );
          }
        }
        lines.push(
          `      → POPULATE script.assets.fonts with the brand's fonts (id, family, weights array, src URL, format, fallback_chain). Use families [${families.slice(0, 3).join(", ")}] in TextContent.font_asset_id references instead of defaulting to Inter.`,
        );
      }
      if (b.motion_signal) {
        const motionGuide = {
          high: "high — site uses heavy choreography. Match it: dense per-scene animation, sustained background motion, multi-beat scene narratives.",
          medium:
            "medium — site uses moderate motion. Match it: confident entry animations, light sustained motion, atmospheric drift.",
          low: "low — site is restrained/static. Match it: clean fades and translates, minimal background motion, let typography lead.",
        }[b.motion_signal];
        lines.push(`    Motion signal: ${motionGuide}`);
      }
      // Design language read off the live homepage screenshot — the brand's
      // compositional feel (type treatment, layout, shape, imagery, mood). Use
      // it to keep the narrative + visual_concepts true to how the brand
      // actually presents itself, not a generic look.
      if (b.design_language) {
        const dl = formatDesignLanguage(b.design_language);
        if (dl) {
          lines.push("    Design language (from the homepage — match this feel):");
          lines.push(dl);
        }
      }
      // Canvas plan (QA 2026-07-08): the design pass ENFORCES this canvas via
      // its machine contract. A visual_concept that specifies a conflicting
      // backdrop ("dark ultra-premium" on a light brand — the Oura build) gets
      // overridden at design time and then reads as plan-infidelity to the
      // vision gate. Tell the storyteller the ground it is painting on.
      {
        const plan = resolveCanvasPlan(b);
        lines.push(
          `    Canvas (ENFORCED at design time — not a suggestion): every scene's background WILL be ${plan.background} (a ${plan.mode} canvas${plan.source === "crawl" ? ", sampled from the brand's site" : ", derived from the brand palette"}). Write every visual_concept to live on that canvas — never specify a conflicting backdrop. At most ONE deliberate contrast scene may invert it, and only when the concept demands it.`,
        );
      }
      // The script agent writes COPY + visual concepts; it references assets by
      // intent/id, never by raw URL (the design agent resolves URLs from the
      // brief). So never dump a raw asset URL into this prompt — a data: URL
      // logo can be huge (liquiddeath.com: a 28KB inline-svg) and bloats the
      // input + sends the model into slow/degenerate generation (~390s timeout).
      const assetRef = (u: string): string =>
        /^data:/i.test(u) || u.length > 150 ? "[available — the design agent places it]" : u;
      if (b.logo_hd) lines.push(`    HD logo (high-res, use this for opening/closing scenes): ${assetRef(b.logo_hd)}`);
      if (b.favicon) lines.push(`    Favicon (low-res; prefer logo above): ${assetRef(b.favicon)}`);
      if (b.apple_touch_icon && b.apple_touch_icon !== b.logo_hd)
        lines.push(`    Apple touch icon: ${assetRef(b.apple_touch_icon)}`);
      if (b.og_image) lines.push(`    OG image (hero image of the site): ${assetRef(b.og_image)}`);
      if (b.headlines && b.headlines.length > 0) {
        lines.push("    Headlines from the site (echo voice/tone — the brand's actual phrasing):");
        for (const h of b.headlines) lines.push(`      "${h}"`);
      }
      if (b.body_excerpts && b.body_excerpts.length > 0) {
        lines.push("    Body copy from the site (the brand's actual claims, features, value props):");
        for (const e of b.body_excerpts.slice(0, 8)) lines.push(`      "${e}"`);
        lines.push(
          `      → STICK TO THESE CLAIMS. Don't invent stats, prices, features, or product capabilities the brand doesn't actually advertise. When the video mentions a specific capability, draw from this list.`,
        );
      }
      if (b.page_images && b.page_images.length > 0) {
        lines.push("    Images found on the site (real product imagery you can mount):");
        for (const img of b.page_images.slice(0, 8)) {
          lines.push(`      ${img.alt ? `"${img.alt}" → ` : ""}${img.src}`);
        }
        lines.push(
          `      → These are real product screenshots/illustrations. Reference them by asset_id (\`site_img_0\`, \`site_img_1\`, etc.) in scene.content.asset_ids when visual_concept calls for a screenshot, product mockup, or brand illustration.`,
        );
      }
      // R4 (audit-3): bind the on-screen copy language to the brand's market. The
      // crawled copy above is echoed as "voice/tone" flavor, but nothing told the
      // model which LANGUAGE to write — so it followed the English worked examples
      // and shipped English headlines over a Spanish brand's mocks (Rappi). One
      // unconditional HARD directive, anchored to the copy already quoted above.
      //
      // The DIRECTION-FIELD CARVE-OUT is load-bearing, not politeness: the first
      // build of this directive failed script-gen outright on Rappi because the
      // model applied the language rule to `visual_concept` too, and every scene
      // validator that reads visual_concept is ENGLISH-vocabulary (CONTAINER_RX,
      // countInteriorSpecifics, drawable-noun count, motionGrams — schema-validator
      // .ts). visual_concept is an internal instruction to the design agent and is
      // never rendered, so it MUST stay English or the schema rejects every attempt.
      lines.push(
        `    LANGUAGE (HARD): write every viewer-facing COPY VALUE — headline, eyebrow, lede, bullets, caption, meta, cta, AND every diegetic mock label — in the SAME language as the site copy quoted above${
          b.site_lang ? ` (the brand's site language is "${b.site_lang}")` : ""
        }; a mixed-language video is broken, and the English worked examples elsewhere in this prompt illustrate STRUCTURE, not language.`,
      );
      lines.push(
        `      → This applies ONLY to on-screen copy values. \`visual_concept\`, the atmosphere/motion direction, and every other DIRECTION field stay in ENGLISH — they are internal instructions to the design agent, never rendered on screen, and writing them in another language breaks the downstream validators.`,
      );
    }
    if (hasFiles) {
      lines.push("  Uploaded files:");
      for (const f of brief.brand_files!) {
        lines.push(`    - ${f.name} (${f.mime}) → ${f.url}`);
      }
    }
  } else {
    lines.push(
      "Brand: none provided. Use Renderball defaults — Inter font, dark background #0A0A0A, accent #0891B2.",
    );
  }

  // Pre-allocated assets — the agent SHOULD reference these by id.
  if (brief.preallocated_assets && brief.preallocated_assets.length > 0) {
    lines.push("");
    lines.push(
      "Image assets available for you to reference by asset_id (THESE ARE REAL, USE THEM):",
    );
    for (const a of brief.preallocated_assets) {
      lines.push(
        `  asset_id: "${a.id}" → ${a.label} (${a.mime}) at ${a.url}`,
      );
    }
    lines.push(
      "  Place these in script.assets.images with the exact ids above, and reference them from image/logo elements via { type: 'image', asset_id: '<id>', ... } or { type: 'logo', asset_id: '<id>', ... }.",
    );
    lines.push(
      "  Use the logo (favicon or first uploaded image) at LEAST once — typically in the opening or closing scene. Use screenshots/og_image as background or supporting visuals where relevant.",
    );
  }
  lines.push("");
  lines.push("Your job:");
  lines.push(
    isDeck
      ? "- For each scene, write visual_concept (1-3 sentences specifying composition + atmosphere — static, NO motion), a `register` (one of stat | quote | full-bleed | split | list | centered), and the structured content fields. VARY the register across scenes — no two adjacent scenes share one, ≥3 distinct across the deck (see the system prompt's rule 10); this is what stops every slide looking like the same template."
      : "- For each scene, write visual_concept (1-3 sentences specifying composition + motion + atmosphere), a `register` (one of stat | quote | full-bleed | split | list | centered), and the structured content fields. VARY the register across scenes — no two adjacent scenes share one, ≥3 distinct across the video (see the system prompt's rule 10); this is what stops every scene looking like the same template.",
  );
  lines.push(
    "- Brainstorm 3-5 DISTINCT visual concepts per scene internally; pick the strongest; write it as visual_concept. Different metaphors, different compositions — not variations of the same idea.",
  );
  if (!isDeck) {
    lines.push(
      "- Decide per-scene duration so heavier moments get more screen time. Do not split evenly.",
    );
  }
  lines.push(
    "- The FINAL scene contains the CTA. Other scenes never repeat it.",
  );
  lines.push(
    isDeck
      ? "- Audio.voiceover.script: one concise PRESENTER NOTE per slide (what the presenter says while this slide is up), joined with spaces."
      : "- Audio.voiceover.script: one concise sentence per scene, joined with spaces, paced for natural speech at the scene's duration.",
  );
  lines.push(
    "- content.texts must contain READABLE strings (min 2 letters/digits). No emoji-only, no symbol-only, no single-char.",
  );
  lines.push(
    "- Reference at least one preallocated asset (favicon / logo / og_image) in at least one scene's content.asset_ids — typically opening or closing.",
  );
  lines.push(
    "- **scene.description**: populate for EVERY scene with a 1-sentence INTENT describing what the scene accomplishes — NOT the on-screen text. Three distinct things per scene: label (short tag), description (intent), visual_concept (visual approach), content.texts (verbatim words).",
  );
  lines.push(
    "- **DO NOT emit scene.elements[], scene.background, or scene.audio_cues.** V0.2 uses visual_concept + content only.",
  );
  if (!isFreeform) {
    lines.push(
      "- scene.label MUST be the verbatim moment title shown above. scene.description MUST be the user's moment description verbatim. visual_concept is YOUR creative choice — the chosen visual approach for the moment.",
    );
  }
  lines.push("");
  lines.push("Output the JSON object only. No prose, no fence.");
  return lines.join("\n");
};

const stripCodeFence = (s: string): string => {
  // Some models wrap output in ```json ... ``` despite instructions.
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return s;
};

const uniqueFontFamilies = (fonts: AgentBrandFont[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fonts) {
    const key = f.family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f.family);
  }
  return out;
};

/**
 * Make sure every pre-allocated asset id is present in the script's
 * assets.images manifest, even if the agent forgot to add it. The
 * Image renderer fails open (missing asset → magenta badge); this
 * eliminates that failure mode for any asset we already have a URL
 * for. Dedup by id.
 */
const mergePreallocatedAssets = (
  script: unknown,
  brief: AgentBrief,
): unknown => {
  if (typeof script !== "object" || script === null) return script;
  if (!brief.preallocated_assets || brief.preallocated_assets.length === 0)
    return script;

  const s = script as Record<string, unknown>;
  const assets =
    (s.assets as Record<string, unknown> | undefined) ?? {};
  const existingImages = Array.isArray(assets.images)
    ? (assets.images as Array<Record<string, unknown>>)
    : [];
  const existingIds = new Set(
    existingImages.map((a) => a.id as string).filter(Boolean),
  );

  const merged: Array<Record<string, unknown>> = [...existingImages];
  for (const a of brief.preallocated_assets) {
    if (existingIds.has(a.id)) continue;
    merged.push({
      id: a.id,
      src: a.url,
      width: 0, // unknown; renderer doesn't use these at draw time
      height: 0,
      format: mimeToFormat(a.mime),
      license_id: "lic_user_provided",
      alt_text: a.label,
    });
  }

  return {
    ...s,
    assets: {
      ...(typeof assets === "object" && assets !== null ? assets : {}),
      images: merged,
    },
  };
};

const mimeToFormat = (mime: string): "png" | "jpg" | "webp" | "svg" => {
  if (mime.includes("svg")) return "svg";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png"; // sane default, includes image/x-icon
};

const injectIdentity = (
  parsed: unknown,
  brief: AgentBrief,
  briefId: string,
): unknown => {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const p = parsed as Record<string, unknown>;

  // The Script schema's brief.about predates the moments redesign.
  // Synthesize a readable about-text for downstream consumers (QA
  // agent, gallery, etc.).
  let aboutSynthesized: string;
  if (brief.moments && brief.moments.length > 0) {
    aboutSynthesized = brief.moments
      .map(
        (m, i) =>
          `${i + 1}. ${m.title ? m.title + ": " : ""}${m.description}`,
      )
      .join("\n");
  } else {
    aboutSynthesized = brief.freeform_prompt ?? "";
  }

  // In freeform mode the agent picks purpose + cta — fall back to the
  // values it just produced in `p.brief` so we don't overwrite them.
  const agentBrief =
    typeof p.brief === "object" && p.brief !== null
      ? (p.brief as Record<string, unknown>)
      : {};
  const purpose =
    brief.purpose ?? (agentBrief.purpose as string | undefined) ?? "";
  const cta = brief.cta ?? (agentBrief.cta as string | undefined) ?? "";

  return {
    ...p,
    id: ulid(),
    customer_id: "local-dev",
    brand_kit_id: brief.brand_kit_url ? `bk_${briefId}` : null,
    created_at: new Date().toISOString(),
    schema_version: "1.0",
    brief: {
      purpose,
      about: aboutSynthesized,
      cta,
    },
    status: "draft",
  };
};
