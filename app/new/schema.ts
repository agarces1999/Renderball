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
  /** True when the user uploaded this as their brand webfont (brand-kit gate). */
  is_font?: boolean;
  /** Display name for the uploaded font family. */
  font_family?: string;
  /** User attested they hold the webfont license. */
  font_licensed?: boolean;
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

/**
 * Structured design-language brief read off a homepage screenshot (the
 * qualitative/compositional layer — NOT colors or font names, which are captured
 * by palette/fonts). Produced by lib/crawl/design-language.ts.
 */
export interface DesignLanguage {
  ethos: string; // one-line design personality
  typography: string; // type TREATMENT (scale contrast, weight, case) — not family names
  layout: string; // composition patterns + density
  shape: string; // corners, borders, elevation, dividers
  imagery: string; // photography vs illustration vs flat
  mood: string[]; // 3-5 adjectives
}

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
  /** Dominant chromatic color extracted from the logo SVG — the signature
   *  fallback when the palette is achromatic (QA G1). Hex, or undefined for a
   *  monochrome logo. */
  logo_color?: string;
  headlines?: string[]; // h1/h2/h3 text, deduped
  /** Body-copy excerpts (<p> + <li>) so Agent 1 can stick to the brand's actual claims. */
  body_excerpts?: string[];
  /** R4b (audit-3): the brand's on-page copy language — the `<html lang>` tag, or
   *  the dominant language of the crawled copy. Reinforces the script's hard
   *  copy-language directive so a Spanish brand ships Spanish (not English) mocks.
   *  Undefined when nothing is confidently detected (→ English default). */
  site_lang?: string;
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
  /** The brand's actual page/canvas background color, sampled by role from its homepage share image (Fuse burgundy #440b12) — the canvas scenes sit on, distinct from the signature accent (the CTA hue). Undefined when not confidently read. */
  background_color?: string;
  /** Heuristic: how motion-heavy the site's CSS is. Drives Agent 2's choreography density. */
  motion_signal?: BrandMotionSignal;
  /** Live homepage screenshot URL (microlink) — a representative page snapshot for vision/reference. */
  site_screenshot?: string;
  /** Structured design-language brief read off the homepage screenshot (composition / type-treatment / mood). */
  design_language?: DesignLanguage;
  /** Brand-truth integrity report computed at crawl time (v14): failover/parked
   *  detection, logo decode, accent sanity, photo verification. Build entries
   *  RE-run the preflight against cached extracts regardless — this field is
   *  the crawl-time snapshot, not the gate. Type-only import: no runtime cycle. */
  brand_truth?: import("../../lib/crawl/brand-truth").BrandTruthReport;
  fetched_at: string;
  ok: boolean;
  error?: string;
}
