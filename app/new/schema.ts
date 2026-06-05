/**
 * Types shared between the client form and the server action.
 * Lives in its own file so both sides can import without dragging
 * "use server" semantics across boundaries.
 */

export type CreativityLevel = "literal" | "balanced" | "bold";

/**
 * Where the user plans to distribute the video. The user picks this in
 * the wizard and it deterministically drives:
 *   - aspect_ratio (mobile-feed → 9:16, square → 1:1, landscape → 16:9)
 *   - viewing_context (mobile-feed/square → mobile, landscape → desktop)
 *
 * viewing_context flows to the Design Agent's body-text floor: at mobile
 * sizes a 20px paragraph reads as ~7px on a 400-wide phone, so the
 * agent ramps up to ≥28px body / ≥36px lede / ≥80px headlines.
 *
 * Removes the "agent guesses from prompt keywords" heuristic that lived
 * in the script-generator prompt.
 */
export type DistributionFormat = "mobile-feed" | "square" | "landscape";

export type ViewingContext = "mobile" | "desktop";

export const DISTRIBUTION_FORMATS: Array<{
  value: DistributionFormat;
  label: string;
  caption: string;
  aspect: "9:16" | "1:1" | "16:9";
  viewing: ViewingContext;
  /** Where viewers actually see it — used in the wizard help text. */
  examples: string;
}> = [
  {
    value: "mobile-feed",
    label: "Mobile feed",
    caption: "Vertical, viewed on a phone",
    aspect: "9:16",
    viewing: "mobile",
    examples: "Instagram Reels, TikTok, Stories, YouTube Shorts",
  },
  {
    value: "square",
    label: "Square post",
    caption: "1:1, works in mobile feeds without cropping",
    aspect: "1:1",
    viewing: "mobile",
    examples: "Instagram feed, LinkedIn post, X timeline",
  },
  {
    value: "landscape",
    label: "Landscape",
    caption: "Wide, viewed mostly on desktop",
    aspect: "16:9",
    viewing: "desktop",
    examples: "YouTube, web embed, email, sales decks",
  },
];

export const aspectForFormat = (
  f: DistributionFormat,
): "9:16" | "1:1" | "16:9" =>
  DISTRIBUTION_FORMATS.find((d) => d.value === f)?.aspect ?? "16:9";

export const viewingContextForFormat = (
  f: DistributionFormat,
): ViewingContext =>
  DISTRIBUTION_FORMATS.find((d) => d.value === f)?.viewing ?? "desktop";

export interface MomentInput {
  title: string; // optional short label; may be ""
  description: string;
  creativity: CreativityLevel;
}

export interface UploadedFileRef {
  /** File name as uploaded — preserved for display + agent context. */
  name: string;
  /** Public URL the agent can reference, e.g. /uploads/<brief_id>/logo.png */
  url: string;
  /** MIME type (image/png, image/svg+xml, …). */
  mime: string;
  /** Size in bytes. */
  size: number;
  /**
   * True when the user designated this file as the brand's logo via the
   * "Upload your logo" prompt. The pipeline uses it as `logo_hd` when
   * the auto-discovery agent found no good candidate.
   */
  is_logo?: boolean;
}

/**
 * The brief the server receives. Exactly ONE generation mode applies:
 *   - manual:  user filled out per-moment descriptions in the wizard.
 *              `moments` is populated. Agent 1 translates them verbatim.
 *   - auto:    user gave a single freeform prompt. `freeform_prompt`
 *              + `moment_count` are populated. Agent 1 infers
 *              purpose/moments/CTA in one pass.
 *
 * Always required: duration_seconds. CTA is required for manual,
 * optional for auto (the agent extracts it from the prompt).
 */
export interface BriefInput {
  duration_seconds: number;
  /**
   * User's distribution choice from the wizard. Authoritative for
   * aspect_ratio and viewing_context downstream. Optional only for
   * back-compat with cached briefs — new submissions always set it.
   */
  distribution_format?: DistributionFormat;
  brand_kit_url?: string;
  brand_files?: UploadedFileRef[]; // resolved server-side
  /**
   * User-supplied real claims the agent is allowed to repeat verbatim —
   * one per line. Acts as the 3rd grounding source (alongside
   * body_excerpts and brief.about) for the hallucination guardrail.
   * Especially useful for JS-rendered/SPA brand sites where body_excerpts
   * is thin and the agent would otherwise have to write qualitative copy.
   * Examples: "$25M Series B", "100+ FIs", "92% automated decisioning".
   */
  verified_claims?: string;
  /**
   * User-picked palette role assignments. Overrides the frequency-ranked
   * auto-pick from `brand_extract.palette` for any role the user assigned.
   * Each value is a hex code from the crawled palette (the user picks
   * from swatches; can't invent colors). Roles not set fall back to the
   * auto-pick logic.
   */
  palette_roles?: {
    primary?: string;
    accent?: string;
    light?: string;
    dark?: string;
  };

  // Manual mode (per-moment, pre-structured)
  purpose?: string;
  moments?: MomentInput[];
  cta?: string;

  // Auto mode (freeform single-pass)
  freeform_prompt?: string;
  moment_count?: number;
}

/**
 * The wizard form's data shape *before* files are uploaded. Files
 * live in browser memory; the server action persists them and produces
 * UploadedFileRef[] which then lands in BriefInput.brand_files.
 */
export interface ClientBriefDraft {
  purpose: string;
  duration_seconds: number;
  distribution_format: DistributionFormat;
  moments: MomentInput[];
  cta: string;
  brand_kit_url: string;
  /** One claim per line; surfaced in the wizard as a multi-line textarea. */
  verified_claims: string;
  /** Hex codes (from the crawled palette) the user assigned to brand roles. */
  palette_roles: {
    primary?: string;
    accent?: string;
    light?: string;
    dark?: string;
  };
}

export const CREATIVITY_LABELS: Record<
  CreativityLevel,
  { label: string; hint: string }
> = {
  literal: {
    label: "Literal",
    hint: "Stick to my words. Minimal embellishment.",
  },
  balanced: {
    label: "Balanced",
    hint: "Add visual taste — but don't invent content.",
  },
  bold: {
    label: "Bold",
    hint: "Take creative liberties. Surprise me.",
  },
};

// ─── Duration ↔ moment count rule ────────────────────────────────────
//
// A 1.5-second moment is unparseable — no time to land an idea. We
// enforce a 5-sec-per-moment floor so users can't ask the agent to
// jam ten moments into a 15-second video. The agent then redistributes
// frames within that budget based on each moment's weight.

export const SECONDS_PER_MOMENT_FLOOR = 5;
export const MOMENT_COUNT_ABSOLUTE_MAX = 10;

export const maxMomentsForDuration = (durationSeconds: number): number => {
  const byDuration = Math.floor(durationSeconds / SECONDS_PER_MOMENT_FLOOR);
  return Math.max(1, Math.min(byDuration, MOMENT_COUNT_ABSOLUTE_MAX));
};

export const momentCountChips = (durationSeconds: number): number[] => {
  const max = maxMomentsForDuration(durationSeconds);
  const all = [2, 3, 4, 5, 6, 8, 10];
  const filtered = all.filter((n) => n <= max);
  // Always make 1 available when max is 1 (tiny videos).
  return max === 1 ? [1] : filtered;
};

// ─── Setup agent output (DEPRECATED) ────────────────────────────────
//
// The Setup Agent has been merged into Agent 1 (Script Generator).
// Agent 1 now handles both freeform and pre-structured input in a
// single pass, eliminating the two-agent handoff. This type stays
// around briefly for backwards compatibility but should not be used
// by new code.

export interface SetupOutput {
  purpose: string;
  duration_seconds: number;
  moments: MomentInput[];
  cta: string;
}

// ─── Brand extract from website crawl ────────────────────────────────
//
// Fired when the user enters a URL on the intro_website step. The
// crawl runs server-side (no CORS), pulls meta tags, then sits in
// state until the Setup Agent runs on intro_prompt — at which point
// the extract is passed in as real brand context.

export interface BrandFont {
  family: string;
  src: string;
  weight?: string;
  style?: string;
  format?: string;
}

export type BrandMotionSignal = "high" | "medium" | "low";

export interface BrandExtract {
  url: string; // normalized
  title?: string;
  description?: string;
  og_image?: string;
  theme_color?: string;
  favicon?: string;
  apple_touch_icon?: string;
  /** High-resolution brand logo discovered via <img>/static-path probe/Clearbit fallback. Distinct from favicon. */
  logo_hd?: string;
  /** Confidence (0-1) the logo agent assigned to logo_hd. <0.6 → wizard nudges a manual upload. */
  logo_confidence?: number;
  /** Where logo_hd came from: inline-svg | static-path | header-img | css-bg | clearbit | simple-icons | web-search | apple-touch | favicon. */
  logo_source?: string;
  headlines?: string[]; // h1/h2/h3 text, deduped
  /** Body-copy excerpts (<p> + <li>) so Agent 1 can stick to the brand's actual claims. */
  body_excerpts?: string[];
  /** Page <img> URLs (excluding favicon/og) so the agents can mount real product imagery. */
  page_images?: { src: string; alt?: string }[];
  /** @font-face declarations found in inline + linked CSS. May include multiple weights/styles per family. */
  fonts?: BrandFont[];
  /** Heuristic classification of crawled fonts by role: display (large headlines, usually serif), body (paragraphs/lede), mono (URLs/code/diegetic UI). Allows the Design Agent to route fontFamily by element semantics. */
  font_roles?: {
    display?: string;
    body?: string;
    mono?: string;
  };
  /** Top brand colors (hex), ranked by frequency, near-grays filtered out. theme_color (if present) is prepended. */
  palette?: string[];
  /** Heuristic: how motion-heavy the site's CSS is. Drives Agent 2's choreography density. */
  motion_signal?: BrandMotionSignal;
  fetched_at: string;
  ok: boolean;
  error?: string;
}
