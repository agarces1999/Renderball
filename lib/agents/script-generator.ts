import { getAnthropic, MODELS } from "../anthropic";
import { SCRIPT_GENERATOR_SYSTEM_PROMPT } from "./prompts/script-generator";
import {
  validateScript,
  findUngroundedClaims,
  findUngroundedStageLabels,
} from "./schema-validator";
import { signatureWithLogoFallback } from "../crawl/brand-identity";
import { formatDesignLanguage } from "../crawl/design-language";
import { ulid } from "../ulid";
import { type Usage, EMPTY_USAGE, usageOf, addUsage } from "../usage";
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
  headlines?: string[];
  body_excerpts?: string[];
  page_images?: { src: string; alt?: string }[];
  fonts?: AgentBrandFont[];
  font_roles?: {
    display?: string;
    body?: string;
    mono?: string;
  };
  palette?: string[];
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

export type ScriptGenerationResult =
  | { ok: true; script: Script; usage: Usage }
  | { ok: false; error: string };

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
): Promise<ScriptGenerationResult> => {
  let client;
  try {
    client = getAnthropic();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Anthropic client init failed.",
    };
  }

  const initialUserMessage = buildUserMessage(brief);
  type Msg = { role: "user" | "assistant"; content: string };
  const history: Msg[] = [{ role: "user", content: initialUserMessage }];

  let totalUsage = EMPTY_USAGE;
  let lastError = "Unknown error.";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      // Streaming, not messages.create: a 16k-token non-streaming Sonnet call
      // exceeds the SDK request timeout under load ("Request timed out" — the
      // exact reason the Opus design/animation calls were moved to streaming).
      // Richer brand context (e.g. liquiddeath.com's 8 headlines + body
      // excerpts) makes the generation long enough to trip it. .finalMessage()
      // returns the same Message shape, so downstream parsing is unchanged.
      response = await client.messages
        .stream({
          model: MODELS.scriptGenerator,
          max_tokens: 16000,
          system: [
            {
              type: "text",
              text: SCRIPT_GENERATOR_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: history,
        })
        .finalMessage();
    } catch (err) {
      return {
        ok: false,
        error: `Anthropic API error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    totalUsage = addUsage(totalUsage, usageOf(response.usage));

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      lastError = "No text content in Anthropic response.";
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

    const raw = textBlock.text.trim();
    const cleaned = stripCodeFence(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
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
    const validation = validateScript(withAssets);
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
        attempt < MAX_ATTEMPTS
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
      // Invented-claim guard (QA S5): reject stat-shaped numbers in the copy
      // that aren't grounded in the crawl/brief. Cheaper than catching it at the
      // design stage (E2 backstops it); the agent gets the exact tokens to fix.
      const sourceText = [
        brief.freeform_prompt,
        brief.purpose,
        brief.verified_claims,
        ...(brief.brand_extract?.body_excerpts ?? []),
      ]
        .filter(Boolean)
        .join(" \n ");
      const scriptCopy = validation.script.scenes
        .map((sc) => {
          const c = (sc as { content?: Record<string, unknown> }).content ?? {};
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
      const ungrounded = findUngroundedClaims(scriptCopy, sourceText);
      // QA G5: also catch a fabricated funding-stage label ("Series C" when the
      // brief only says "$250M funding round").
      const ungroundedStages = findUngroundedStageLabels(scriptCopy, sourceText);
      if (
        (ungrounded.length > 0 || ungroundedStages.length > 0) &&
        attempt < MAX_ATTEMPTS
      ) {
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
            `These numeric claims aren't supported by the brief or the crawled site content: ${ungrounded.join(", ")}. Replace each with qualitative copy (e.g. "$840M processed" → "billions processed") or remove it — never invent specific stats.`,
          );
        if (ungroundedStages.length > 0)
          msgs.push(
            `These funding-stage labels aren't stated anywhere in the brief or crawled content: ${ungroundedStages.join(", ")}. The brief mentions a raise but NOT the stage — drop the invented label (say "funding round" / "their raise"), never fabricate "Series C" or similar.`,
          );
        history.push({ role: "user", content: msgs.join("\n\n") });
        continue;
      }
      return {
        ok: true,
        script: validation.script,
        usage: totalUsage,
      };
    }

    // Validation failed — feed the exact error back and ask for a fix.
    lastError = validation.error;
    history.push({ role: "assistant", content: raw });
    history.push({
      role: "user",
      content: buildRetryMessage(validation.error, attempt),
    });
  }

  return {
    ok: false,
    error: `Schema validation failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`,
  };
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

const buildUserMessage = (brief: AgentBrief): string => {
  const momentCount = brief.moment_count;
  const isFreeform = !!brief.freeform_prompt && !brief.moments;
  const userAspect = formatToAspect(brief.distribution_format);
  const userViewing = formatToViewingContext(brief.distribution_format);

  const lines: string[] = [
    isFreeform
      ? "Generate a Script JSON from this FREEFORM brief. You decide the per-moment content."
      : "Generate a Script JSON from this PRE-STRUCTURED brief.",
    "",
    "Hard constraints you MUST honor:",
    `- Total duration: EXACTLY ${brief.duration_seconds} seconds — AUTHORITATIVE. SET config.duration_seconds = ${brief.duration_seconds} and tile every scene across 0→${brief.duration_seconds}. Do NOT pick a shorter total. Do NOT collapse the video into a few seconds. "Per beat" pacing is motion density INSIDE a scene, not scene length.`,
    ...(userAspect
      ? [
          `- Aspect ratio: ${userAspect}. The user picked this in the wizard. SET config.aspect_ratio = "${userAspect}". Do NOT override based on prompt keywords — the wizard is authoritative.`,
          `- Viewing context: ${userViewing}. ${userViewing === "mobile" ? "Viewers watch on phone screens; the Design Agent will use a larger body-text floor." : "Viewers watch on desktop; the Design Agent uses tighter typography."}`,
        ]
      : []),
    `- Section count: EXACTLY ${momentCount} sections — one per moment, in narrative order.`,
    `- Section boundaries: scenes[0].start_seconds === 0, scenes[N-1].end_seconds === ${brief.duration_seconds}, and scenes[i].end_seconds === scenes[i+1].start_seconds for all i. Times are in seconds (decimals allowed: 2.5, 3.2, etc.).`,
    "",
    "Time allocation (your job — don't split evenly):",
    `- Distribute the ${brief.duration_seconds} seconds across the ${momentCount} sections by weight — that averages ~${(brief.duration_seconds / momentCount).toFixed(1)}s per section. Sections are MOMENTS that must land an idea, not 1-second flashes.`,
    `- WEIGHT signals: longer descriptions, more animation cues, bolder creativity, more on-screen content → more time. Intros, transitions, simple holds → less time.`,
    `- Floor: every section gets at least ${Math.min(3, Math.max(1, Math.floor(brief.duration_seconds / momentCount)))} seconds (a moment needs time to land). Ceiling: no section exceeds ${Math.floor(brief.duration_seconds * 0.5)} seconds (50% of total).`,
    `- ALL TIMING IN VISUAL_CONCEPT PROSE MUST BE IN SECONDS. Write "From Xs to Ys:" or "at 2.4s". Never reference frame counts.`,
    "",
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
    "- This is an animated FRONTEND (a story-driven web experience), never a video — no camera / shot / footage language.",
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
      "These are SAFE to use as specific numbers in scene.content (headline, lede, bullets, meta values). Numbers NOT in this list AND not in body_excerpts may NOT be invented — the hallucination guardrail will fail Pass 1.",
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
      const signature = signatureWithLogoFallback(b.palette ?? [], b.theme_color, b.logo_color);
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
    "- For each scene, write visual_concept (1-3 sentences specifying composition + motion + atmosphere), a `register` (one of stat | quote | full-bleed | split | list | centered), and the structured content fields. VARY the register across scenes — no two adjacent scenes share one, ≥3 distinct across the video (see the system prompt's rule 10); this is what stops every scene looking like the same template.",
  );
  lines.push(
    "- Brainstorm 3-5 DISTINCT visual concepts per scene internally; pick the strongest; write it as visual_concept. Different metaphors, different compositions — not variations of the same idea.",
  );
  lines.push(
    "- Decide per-scene duration so heavier moments get more screen time. Do not split evenly.",
  );
  lines.push(
    "- The FINAL scene contains the CTA. Other scenes never repeat it.",
  );
  lines.push(
    "- Audio.voiceover.script: one concise sentence per scene, joined with spaces, paced for natural speech at the scene's duration.",
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
