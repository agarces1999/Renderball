import { getAnthropic, MODELS, BUILD_REASONING, BUILD_MAX_TOKENS } from "../anthropic";
import { DESIGN_AGENT_SYSTEM_PROMPT } from "./prompts/design-agent";
import { ANIMATION_AGENT_SYSTEM_PROMPT } from "./prompts/animation-agent";
import { stripCodeFence, verifyCompilable, repairCompile, elideDataUrisOutsideSection } from "./code-extraction";
import { extractSection, replaceSection, sectionRange } from "./section-splice";
import { exemplarPromptBlock } from "./exemplars";
import {
  densityFailuresByScene,
  overflowFailuresByScene,
  unboundFailuresByScene,
  fillFailuresByScene,
  groupByScene,
  sectionsAreSpliceable,
} from "./scene-scope";
import {
  contrastRatio,
  MIN_CONTRAST_RATIO,
  SEVERE_CONTRAST_RATIO,
} from "./contrast";
import { dimensionsForScript } from "../render/build-wrapper";
import { lucideIconNameSet, assessInvalidLucideImports } from "./finalize-refs";
import {
  findSlowTextEntrances,
  findOverflowingElements,
  findDuplicateLogos,
  findDuplicatedEyebrows,
  findDecorativeFillerIcons,
  assessFontFidelity,
  assessRegisterVariety,
  assessContinuity,
  assessThroughlinePresence,
  findRedundantCaptions,
  hasCornerLogoSuppression,
  findUndersizedText,
  findUndwelledText,
  findPlaceholderData,
  countAccentBorders,
  TEXT_FLOOR_P,
  TEXT_FLOOR_LI,
  repairInvalidLucideImports,
  addMissingLucideImports,
  stubUndefinedComponents,
  findUndefinedJsxComponents,
  findUnboundCopy,
  findDrawnLogoStandIns,
  findProvidedComponentRedefinitions,
  type AspectRatio,
} from "./quality-gates";
import { buildDesignConstraints } from "./design-constraints";
import { resolveBrandIdentity, resolveCanvasPlan, genericFor, type BrandIdentity } from "../crawl/brand-identity";
import { formatDesignLanguage } from "../crawl/design-language";
import { makeFontFetcher, inlineFontFaces } from "../render/font-inline";
import { makeImageProbe, repairBrokenImages } from "../render/image-integrity";
import { searchPexelsPhotos, searchPexelsVideos } from "../assets/sources/pexels";
import type { AssetSearchEntry } from "../assets/types";
import { type Usage, usageOf, addUsage, recordUsage, EMPTY_USAGE } from "../usage";
import type { Script } from "../../src/schema";
import type {
  AgentBrandExtract,
  AgentFileRef,
} from "./script-generator";

// LOGO_SRC ownership (strip the agent's declaration + inject the real const
// after the import block) lives in ./logo-inject so the multi-line-import
// handling is unit-tested in isolation.
import { injectLogoSrc } from "./logo-inject";

/**
 * Agent 2 — two-pass design + animation pipeline.
 *
 * Pass 1: Design Agent reads the script + brand context and emits a
 *         STATIC Composition.tsx — every element at its settled
 *         position, no animation imports. The framing is "code a
 *         presentation slide" so the model leans on its strong prior
 *         for great slide design (Linear / Vercel / Stripe / Notion).
 *
 * Pass 2: Animation Agent receives the static design + the script's
 *         multi-beat visual_concept frame ranges. It rewrites the file
 *         with useCurrentFrame / interpolate / spring / Sequence to
 *         add entry choreography, sustained motion, and beat reveals.
 *         The design is preserved — only motion is woven in.
 *
 * External interface (buildAnimatedSections + BuildResult) is
 * unchanged. Callers see one round-trip. Internally it's two LLM
 * calls and the intermediate static .tsx is exposed via
 * `result.designCode` for inspection / on-disk caching.
 */

export interface BuildInput {
  script: Script;
  brand_kit_url?: string;
  brand_extract?: AgentBrandExtract;
  /**
   * The LOCKED brand identity (one logo or wordmark, validated fonts),
   * resolved deterministically in code from brand_extract so the design
   * agent uses it verbatim instead of improvising assets from the raw dump.
   */
  brand_identity?: BrandIdentity;
  brand_files?: AgentFileRef[];
  /**
   * User-supplied verified numeric claims (one per line). Counted as
   * a source by the hallucination guardrail so the agent can repeat
   * these verbatim.
   */
  verified_claims?: string;
  /**
   * User-picked palette role assignments from the wizard step.
   * Authoritative over the frequency-ranked auto-pick when set.
   */
  palette_roles?: {
    primary?: string;
    accent?: string;
    light?: string;
    dark?: string;
  };
}

/**
 * Brief-shaped subset that callsites pass into buildAgentInputFromBrief.
 * Loose-typed to accept both StoredBrief (full app type) and the trimmed
 * brief shape carried on test/dev endpoints. Only the fields that flow
 * into BuildInput are required.
 */
export type BriefForBuild = {
  brand_kit_url?: string;
  brand_files?: {
    name: string;
    url: string;
    mime: string;
    is_logo?: boolean;
    is_font?: boolean;
    font_family?: string;
  }[];
  verified_claims?: string;
  palette_roles?: {
    primary?: string;
    accent?: string;
    light?: string;
    dark?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brand_extract?: any;
} | null | undefined;

/**
 * Single source of truth for building a `BuildInput` from a stored
 * brief + a script. Replaces ~25 lines of brand_extract field-mapping
 * that used to be duplicated across review/actions.ts, dev/render
 * route, preview/build route, and preview/regenerate-scene route.
 *
 * Whenever we add a new field to brand_extract, we now update ONE
 * place instead of four. `font_roles`, `logo_hd`, `body_excerpts`,
 * and `page_images` all went through "added everywhere except one
 * site" bugs during the V0.3 build — this kills the drift.
 */
export const buildAgentInputFromBrief = (
  brief: BriefForBuild,
  script: Script,
): BuildInput => {
  // User-uploaded logo (from the wizard "Upload your logo" prompt when
  // the auto-discovery agent returned NONE) takes precedence over the
  // crawled logo_hd. Without this the agent would either get nothing
  // or get a customer logo from the crawl.
  const userLogo = brief?.brand_files?.find((f) => f.is_logo);
  const crawledLogo = brief?.brand_extract?.ok
    ? brief.brand_extract.logo_hd
    : undefined;
  const effectiveLogoHd = userLogo?.url ?? crawledLogo;

  // User-uploaded brand font (brand-kit gate, optional): overrides the crawled
  // faces entirely — the user's licensed file is the identity truth, and using
  // it also stops us re-hosting a licensed webfont the crawl merely found.
  const userFont = brief?.brand_files?.find((f) => f.is_font && f.font_family);
  const effectiveFonts = userFont
    ? [{ family: userFont.font_family as string, src: userFont.url, weight: "400" }]
    : brief?.brand_extract?.ok
      ? brief.brand_extract.fonts
      : undefined;
  const effectiveFontRoles = userFont
    ? { display: userFont.font_family, body: userFont.font_family }
    : brief?.brand_extract?.ok
      ? brief.brand_extract.font_roles
      : undefined;

  // Resolve brand_extract once, then derive the LOCKED brand identity from
  // the SAME data the agent will see (one logo or wordmark + validated fonts).
  const be: AgentBrandExtract | undefined = brief?.brand_extract?.ok
    ? {
        url: brief.brand_extract.url,
        title: brief.brand_extract.title,
        description: brief.brand_extract.description,
        og_image: brief.brand_extract.og_image,
        theme_color: brief.brand_extract.theme_color,
        favicon: brief.brand_extract.favicon,
        apple_touch_icon: brief.brand_extract.apple_touch_icon,
        logo_hd: effectiveLogoHd,
        // Vision-vetted finder confidence — must reach pickLogo's trust path or
        // a confident pick whose URL matches a reject regex gets nulled to the
        // wordmark. A user-uploaded logo is definitionally trusted (1), and the
        // crawl's score must not apply to a file it never vetted.
        logo_confidence: userLogo ? 1 : brief.brand_extract.logo_confidence,
        // Signature fallback when the palette is achromatic (QA G1) — must reach
        // resolveBrandIdentity(be) below, so carry it through the mapping.
        logo_color: brief.brand_extract.logo_color,
        headlines: brief.brand_extract.headlines,
        body_excerpts: brief.brand_extract.body_excerpts,
        page_images: brief.brand_extract.page_images,
        fonts: effectiveFonts,
        font_roles: effectiveFontRoles,
        palette: brief.brand_extract.palette,
        // The brand's real canvas background (Fuse burgundy) — a hard constraint
        // for the Design Agent so it doesn't infer the canvas and default to
        // near-black. Distinct from the signature accent.
        background_color: brief.brand_extract.background_color,
        motion_signal: brief.brand_extract.motion_signal,
        site_screenshot: brief.brand_extract.site_screenshot,
        design_language: brief.brand_extract.design_language,
        ok: brief.brand_extract.ok,
      }
    : userLogo
      ? // Synthesize a minimal brand_extract so the user-uploaded logo
        // still reaches the agents even when no crawl happened. The user's
        // own file is definitionally trusted past the regex filters.
        { url: "", logo_hd: userLogo.url, logo_confidence: 1, ok: true }
      : undefined;

  return {
    script,
    brand_kit_url: brief?.brand_kit_url,
    brand_files: brief?.brand_files?.map((f) => ({
      name: f.name,
      url: f.url,
      mime: f.mime,
    })),
    verified_claims: brief?.verified_claims,
    palette_roles: brief?.palette_roles,
    brand_extract: be,
    // Let resolveBrandIdentity derive a CLEAN brand name (deriveBrandName picks
    // the brand segment of the title by hostname match) — don't pass the raw
    // page title, which becomes a junk wordmark ("AI-Powered … | Fuse").
    brand_identity: resolveBrandIdentity(be),
  };
};

/**
 * Soft warnings the pipeline surfaces back to the UI for the user's
 * awareness. These don't fail the build — the design ships — but the
 * review/preview page can show them as quality chips.
 */
export interface BuildWarnings {
  /** Numeric tokens in the design that don't appear in source corpus. */
  invented_claims?: string[];
  /** Color pairs whose WCAG contrast ratio is below 4.5:1 (body) or 3:1 (large). */
  low_contrast?: { fg: string; bg: string; ratio: number }[];
  /**
   * SEVERE contrast (<3:1) that survived the retry into the FINAL composition —
   * unreadable even for headlines. Distinct from low_contrast so the preview UI
   * / verifier can flag it loudly; should be rare after the structural gate.
   */
  low_contrast_severe?: { fg: string; bg: string; ratio: number }[];
  /** Scenes with numeric content.meta but no Recharts chart in the design. */
  missing_charts?: string[];
  /** Recurring throughline motifs whose anchor jumps >10% canvas between scenes. */
  throughline_drift?: { slug: string; axis: "x" | "y" | "both"; driftX: number; driftY: number; occurrences: number }[];
  /** Script has a narrative.throughline but the design carried it across too few scenes. */
  throughline_absent?: { throughline: string; tagged: number; scenes: number };
  /** Broken/invented image URLs the integrity pass repaired (swapped or neutralized). */
  images_repaired?: { replaced: number; neutralized: number };
  /** Brand logo still rendered at >1 site after the structural retry (count of sites). */
  duplicate_logo?: number;
  /** Per-scene editorial eyebrows that appear ≥2× (chrome echo of the kicker). */
  duplicate_eyebrow?: string[];
  /** Count of generic shine-filler icons (Sparkles/Sparkle) — advisory slop tell. */
  decorative_icons?: number;
  /** Composition leaves an empty lower band (content clustered at the top) — QA V1. */
  low_fill?: string;
  /** Scene captions that merely restate the headline or list already-shown asset names (QA V2). */
  redundant_caption?: { scene: number; caption: string; reason: string }[];
  /** Brand display font name when FONT_DISPLAY uses a different family. */
  font_infidelity?: string;
  /** Fewer than 3 distinct scene registers across the video → same-y layouts. */
  low_register_variety?: { distinct: number; total: number };
  /** Element widths that still cross the canvas edge after the structural retry. */
  overflow_crop?: number[];
  /** Body text below the size floor (<p> <24px / <li> <18px) — scene review #1. */
  undersized_text?: { tag: string; fontSize: number; floor: number }[];
  /** Text beats that land too late to be read before the scene ends — scene review #2. */
  undwelled_text?: { section: number; tag: string; landsAt: number; sceneDuration: number }[];
  /** Sections where the signature color borders >4 elements — scene review #3. */
  accent_overuse?: { section: number; count: number }[];
  /**
   * Structural gate failures (the crash / broken-looking tier) that survived
   * EVERY retry and the deterministic repairs — i.e. what actually shipped.
   * Entries are "gate_key: detail". A structural failure must never ship
   * silently: the Supabase build hand-drew a logo replica and shipped with an
   * empty warnings.json because nothing recorded the unresolved failure.
   */
  structural_unresolved?: string[];
}

export type BuildResult =
  | {
      ok: true;
      code: string;
      designCode: string;
      warnings?: BuildWarnings;
      /** Log of search_assets calls during the design pass (license-auditable). */
      asset_manifest?: AssetSearchEntry[];
      usage: Usage;
    }
  | {
      ok: false;
      error: string;
      stage?: "design" | "animation";
      /** Tokens already spent before the failure — real billed cost the
       *  caller must still record (a failed attempt is not a free attempt). */
      usage?: Usage;
    };

/**
 * Anthropic's SDK wraps fetch failures in `APIConnectionError` with the
 * message "Connection error." and the actual underlying problem (undici
 * TypeError, ECONNRESET, AbortError, ConnectTimeoutError, …) hidden in
 * `err.cause`. Sometimes cause itself has a cause (undici → cause →
 * Node-level errno). Walk the chain and surface everything so the
 * downstream error log is actually diagnostic instead of just saying
 * "Connection error."
 */
const formatAnthropicError = (err: unknown): string => {
  if (!err) return "unknown error";
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  parts.push(`${err.name}: ${err.message}`);
  // Walk err.cause up to 4 levels deep — enough for undici → fetch → errno.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = (err as Error & { cause?: unknown }).cause;
  let depth = 0;
  while (cursor && depth < 4) {
    if (cursor instanceof Error) {
      const code = (cursor as Error & { code?: string }).code;
      parts.push(`caused by ${cursor.name}${code ? `[${code}]` : ""}: ${cursor.message}`);
      cursor = (cursor as Error & { cause?: unknown }).cause;
    } else {
      parts.push(`caused by ${String(cursor).slice(0, 200)}`);
      cursor = undefined;
    }
    depth += 1;
  }
  return parts.join(" | ");
};

/**
 * Per-request timeout for Opus + 32k Composition calls. The SDK default
 * is 10 minutes — too tight for Opus streaming a full 32k-token file
 * when first-chunk latency stacks on top of generation time. 30 min is
 * generous but bounded; if a request needs more, something else is wrong.
 */
const COMPOSITION_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Transient errors on a long GLM build stream — retry the WHOLE call (a fresh
 * stream) on these:
 *   1. Connection drops mid-flight (ETIMEDOUT, terminated, ECONNRESET, socket
 *      hang up). The SDK can't resume a stream, so one blip killed a 38-minute
 *      build (feedback-loop iter 1: animation stage `read ETIMEDOUT`).
 *   2. z.ai SERVER-OVERLOAD (`overloaded_error`, HTTP 500 `[Operation failed]`).
 *      z.ai has overload spells where the server returns 500s for a few minutes;
 *      a fresh attempt usually lands (pass-2 lost figma+duolingo to this). This
 *      is the ONE class of API error that's transient — Anthropic's own SDK
 *      retries 500/overloaded by default.
 * Still NEVER retry the OTHER API errors (400 / truncation / auth) — those just
 * repeat. Keeps a momentary hiccup from nuking an expensive build, for the loop
 * AND for real users.
 */
const TRANSIENT_NET_RX =
  /ETIMEDOUT|ECONNRESET|terminated|socket hang up|EPIPE|ECONNREFUSED|fetch failed|network|aborted|overloaded|Operation failed/i;
const isTransientNetErr = (err: unknown): boolean => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const parts = [e?.message, e?.code, e?.cause?.message, e?.cause?.code, e?.cause?.cause?.code]
    .filter(Boolean)
    .join(" ");
  return TRANSIENT_NET_RX.test(parts) || TRANSIENT_NET_RX.test(String(err));
};
// Flatten a (possibly nested) fetch/undici error into its diagnostic chain —
// name:code:syscall:message at each `.cause` level. TELEMETRY: this is how we
// learn whether the transport dispatcher (lib/anthropic keepalive + bodyTimeout)
// actually reduces drops, and distinguish causes — a kernel `read ETIMEDOUT`
// (syscall=read, no UND_ERR_) vs undici's `UND_ERR_BODY_TIMEOUT` vs a reset.
const errChain = (err: unknown): string => {
  const out: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let e: any = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const parts = [e.name, e.code, e.syscall, e.message].filter(Boolean).join(":");
    if (parts) out.push(parts);
    e = e.cause;
  }
  return out.join(" <- ") || String(err);
};
// Stall ceiling: a stream whose connection dies SILENTLY (no data, no error)
// hangs `await fn()` forever. The retry ladder only sees THROWN errors, so
// convert a stall into one: race the call against a ceiling and word the error
// to match TRANSIENT_NET_RX so the existing retry logic re-attempts it. The
// ceiling is a SAFETY NET for infinite hangs, not a performance bound —
// healthy passes have been measured up to ~58 min under z.ai throttling, so
// the default sits well above that (a too-low ceiling kills a slow-but-alive
// stream and re-pays the whole pass). The orphaned promise is abandoned.
const STREAM_CEILING_MS =
  Math.max(5, Number(process.env.RB_STREAM_CEILING_MIN) || 75) * 60_000;
const withStallCeiling = <T>(label: string, p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `${label}: stream stalled — no completion after ${Math.round(STREAM_CEILING_MS / 60_000)}min (silent network drop, treated as transient)`,
            ),
          ),
        STREAM_CEILING_MS,
      );
      // Never keep the process alive just for the watchdog.
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

async function streamBuildCall<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    const t0 = Date.now();
    try {
      return await withStallCeiling(label, fn());
    } catch (err) {
      lastErr = err;
      const elapsedS = Math.round((Date.now() - t0) / 1000);
      const transient = isTransientNetErr(err);
      // Always log the full cause chain + elapsed so we can correlate drops with
      // the transport fix over time (the challenge's non-negotiable).
      console.warn(
        `[pipeline] ${label}: attempt ${i}/${attempts} failed after ${elapsedS}s — ${transient ? "TRANSIENT → retrying" : "non-transient → aborting"} | cause: ${errChain(err)}`,
      );
      // Ledger visibility: z.ai BILLS a stream that dies mid-generation (input
      // prefill + all tokens generated before the drop), but the error path
      // exposes no usage — so the cost ledger silently undercounted every
      // retried attempt (found reconciling against live billing). We can't know
      // the billed token count, so record a ZERO-usage marker (never a
      // fabricated estimate): the ledger stays a truthful floor, and these rows
      // show exactly where and how long unrecorded billed generation happened.
      void recordUsage({
        op: "failed-stream-attempt",
        model: MODELS.codingAgent,
        url: `${label} attempt ${i}/${attempts} died after ${elapsedS}s (billed by z.ai, tokens unreported)`,
        usage: EMPTY_USAGE,
        failed: true,
      });
      if (i === attempts || !transient) throw err;
    }
  }
  throw lastErr;
}

/**
 * One surgical compile-fix round-trip. A compile error in generated code (a
 * stray `>`, an unclosed tag, a truncated expression) is a MECHANICAL defect,
 * not a design problem — so instead of failing the build or paying a full
 * creative regeneration (~17 min on the slow build models), hand the model the
 * broken file + the EXACT esbuild error and ask for the corrected file back.
 *
 * Deliberately thinking-OFF: this is transcribe-and-patch, not composition.
 * There's nothing to reason about — find the one broken token, fix it, re-emit
 * verbatim. Omitting `thinking` keeps it fast (~10-30s) and cheap, and works on
 * both Opus 4.8 and the GLM interim model (an explicit {type:"disabled"} 400s
 * on some models, so we omit the param entirely). Streamed for parity with the
 * other Composition calls (a full file can exceed the SDK's 10-min sync ceiling).
 *
 * Returns the stripped corrected code (null if the call failed or produced no
 * usable file) and the call's usage — billed by the caller regardless of
 * outcome, since the tokens were spent either way. Paired with `repairCompile`
 * (code-extraction.ts), which owns the verify→fix→re-verify loop + attempt cap.
 */
const surgicalCompileFix = async (
  client: ReturnType<typeof getAnthropic>,
  model: string,
  code: string,
  error: string,
): Promise<{ code: string | null; usage: Usage }> => {
  const userMessage = [
    `The TSX file below fails to compile. Fix ONLY the syntax error and re-emit the COMPLETE file.`,
    ``,
    `## Compiler error`,
    error,
    ``,
    `## File`,
    "```tsx",
    code,
    "```",
    ``,
    `Output the complete corrected file — same imports, same components, same copy, same styling, same layout. Every line MUST be identical EXCEPT the minimal change that fixes the compile error. Do NOT redesign, reformat, rename, or add/remove features. Output only the file, no commentary.`,
  ].join("\n");

  try {
    const resp = await client.messages
      .stream(
        {
          model,
          max_tokens: BUILD_MAX_TOKENS,
          // thinking omitted on purpose — see the doc comment.
          messages: [{ role: "user", content: userMessage }],
        },
        { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
      )
      .finalMessage();
    const text = resp.content.find((c: { type: string }) => c.type === "text");
    const fixed =
      text && text.type === "text" ? stripCodeFence(text.text.trim()) : null;
    // Guard against a non-file response (refusal / prose) slipping through.
    const usable =
      fixed && fixed.includes("import") && fixed.includes("export")
        ? fixed
        : null;
    return { code: usable, usage: usageOf(resp.usage) };
  } catch (err) {
    console.warn(
      "[pipeline] surgicalCompileFix call failed:",
      err instanceof Error ? err.message : err,
    );
    return { code: null, usage: EMPTY_USAGE };
  }
};

/**
 * Surgical RENDER-error fix for ONE section. The composition PARSES (it passed
 * the compile gate) but a scene THROWS at render — almost always an unguarded
 * access to an OPTIONAL content field (content fields are per-scene, so a scene
 * without a `cta` crashes on `c.cta.primary`). Hand the model just that section
 * + the runtime error and ask for the crash-safe version of the SAME section,
 * re-emitting only it. thinking-off (this is a mechanical guard fix). Returns
 * the corrected section block (or null) + usage. Paired with section-splice so
 * the rest of the composition is byte-preserved.
 */
const surgicalRenderFix = async (
  client: ReturnType<typeof getAnthropic>,
  model: string,
  sectionCode: string,
  sceneIndex: number,
  errorMsg: string,
): Promise<{ block: string | null; usage: Usage }> => {
  const sectionName = `Section${sceneIndex}`;
  const userMessage = [
    `The React component below (\`${sectionName}\` from a Remotion composition) THROWS at render with:`,
    ``,
    errorMsg,
    ``,
    `This is a RUNTIME crash, not a syntax error. Diagnose from the error message which class it is and fix THAT:`,
    ``,
    `(A) "Cannot read properties of undefined/null (reading 'X')" — an UNGUARDED access to an OPTIONAL content field. A scene's \`content\` may omit any field, so \`c.cta.primary\`, \`c.bullets.map(...)\`, \`c.meta[0].value\` throw when that field is absent. Fix: optional-chain it (\`c.cta?.primary\`) and/or wrap the element in a guard (\`{c.cta?.primary && ( … )}\`).`,
    ``,
    `(B) "<NAME> is not defined" (a ReferenceError) — the code REFERENCES an identifier (a const, array, or helper, e.g. ORBIT_CURSORS) that is never declared anywhere in this section. The model invented a name and used it without defining it. Fix: DEFINE it at the top of the component with a concrete literal whose shape matches how it's used (e.g. \`const ORBIT_CURSORS = [{...}, {...}];\` if it's \`.map\`ped), preserving the intended visual — OR, if it isn't essential, remove the element that uses it. Prefer defining it so the design is kept.`,
    ``,
    `Do NOT remove content that IS present; only make the scene render without throwing.`,
    ``,
    `## ${sectionName}`,
    "```tsx",
    sectionCode,
    "```",
    ``,
    `Re-emit ONLY the corrected \`export const ${sectionName} = …\` component — same design, copy, layout, and animations, just crash-safe. No other sections, no imports, no prose.`,
  ].join("\n");

  try {
    const resp = await client.messages
      .stream(
        {
          model,
          max_tokens: BUILD_MAX_TOKENS,
          // thinking-off: a guard fix is mechanical, not a design decision.
          messages: [{ role: "user", content: userMessage }],
        },
        { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
      )
      .finalMessage();
    const text = resp.content.find((c: { type: string }) => c.type === "text");
    const raw = text && text.type === "text" ? stripCodeFence(text.text.trim()) : "";
    // Isolate the one section even if the model wraps prose/extra around it.
    const block = raw ? extractSection(raw, sceneIndex) : null;
    return { block, usage: usageOf(resp.usage) };
  } catch (err) {
    console.warn(
      `[pipeline] surgicalRenderFix(${sectionName}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return { block: null, usage: EMPTY_USAGE };
  }
};

/**
 * Render-error auto-repair (the SSR-gate analogue of #2's compile repair).
 * Given the full composition + the per-scene render errors the SSR gate found,
 * surgically fix each throwing section (guard the undefined access) and splice
 * it back. Only per-scene errors (scene ≥ 0) are section-localizable; file-level
 * errors (scene -1: missing/compile/eval) are left for the caller to hard-fail.
 * Returns the (possibly) repaired code, the scenes it touched, and usage. The
 * caller re-runs the SSR gate to confirm — a fix that didn't take just fails
 * the gate again, exactly as today, so this can only help.
 */
export const repairSceneRenderErrors = async (
  fullCode: string,
  errors: { scene: number; error: string }[],
): Promise<{ code: string; repaired: number[]; usage: Usage }> => {
  let client: ReturnType<typeof getAnthropic>;
  try {
    client = getAnthropic();
  } catch {
    return { code: fullCode, repaired: [], usage: EMPTY_USAGE };
  }
  let code = fullCode;
  let usage = EMPTY_USAGE;
  const repaired: number[] = [];
  // One fix attempt per distinct failing scene (deduped). Bounded by scene count.
  const scenes = [...new Set(errors.filter((e) => e.scene >= 0).map((e) => e.scene))];
  for (const scene of scenes) {
    const block = extractSection(code, scene);
    if (!block) continue;
    const err = errors.find((e) => e.scene === scene)?.error ?? "render error";
    const fix = await surgicalRenderFix(client, MODELS.codingAgentBuild, block, scene, err);
    usage = addUsage(usage, fix.usage); // billed either way
    if (!fix.block) continue;
    const spliced = replaceSection(code, scene, fix.block);
    if (spliced) {
      code = spliced;
      repaired.push(scene);
    }
  }
  return { code, repaired, usage };
};

/**
 * Scoped per-scene design regen (#1). Regenerate ONLY the `Section{index}`
 * component of an existing (static) composition, fixing the localized quality-
 * gate failures handed in via `fixMessages`, and return just that section's
 * block for the caller to splice back in.
 *
 * This is the cost lever behind per-scene retries: a whole-composition retry
 * re-emits every scene (output tokens — the dominant build cost — scale with
 * the whole file), whereas this asks the model to emit ONE section. Several of
 * these run in parallel, so wall-clock is one section's generation, not N.
 * The model gets the full file as READ-ONLY context (so the regenerated scene
 * stays consistent with the shared fonts/palette/chrome) but is told to output
 * only the one export; `extractSection` then isolates that block even if the
 * model over-emits. Returns null when the call fails or the section can't be
 * recovered — the caller falls back to a whole-composition retry.
 */
const regenerateSectionBlock = async (
  client: ReturnType<typeof getAnthropic>,
  model: string,
  input: BuildInput,
  baseCode: string,
  sceneIndex: number,
  fixMessages: string[],
  mode: "design" | "animation" = "design",
): Promise<{ block: string | null; usage: Usage }> => {
  const scene = input.script.scenes[sceneIndex];
  if (!scene) return { block: null, usage: EMPTY_USAGE };
  const sectionName = `Section${sceneIndex}`;
  const dims = dimensionsForScript(input.script);
  const aspect = input.script.config?.aspect_ratio ?? "16:9";
  const viewingContext: "mobile" | "desktop" =
    aspect === "16:9" ? "desktop" : "mobile";
  // Base64 data-URIs outside the target section are read-only waste — elide
  // (the target section itself is preserved verbatim: the model re-emits it).
  const baseContext = elideDataUrisOutsideSection(baseCode, sectionRange, sceneIndex);

  const userMessage =
    mode === "animation"
      ? [
          `You are fixing the MOTION of ONE section in an existing animated Composition.tsx. Re-emit ONLY the \`export const ${sectionName}\` component with the animation issues below fixed — keep its design, copy, and layout exactly as-is; change only CSS @keyframes / animation / animation-delay / transition.`,
          ``,
          `## Animation issues to fix in ${sectionName}`,
          ...fixMessages.map((m) => `- ${m}`),
          ``,
          `## Scene brief`,
          `${sectionName} runs for ${roundTo(sceneDurationSeconds(scene), 2)}s. Distribute finite (forwards) beats across the timeline — the latest must land at ≥60% of the duration. Text entrances stay fast (headline ≤0.4s, body ≤0.5s); late beats are decorative.`,
          scene.visual_concept ? `Animations list (from visual_concept):\n${scene.visual_concept}` : "",
          ``,
          `## Full Composition.tsx (READ-ONLY context — do not re-emit any of it except ${sectionName})`,
          "```tsx",
          baseContext,
          "```",
          ``,
          `Output ONLY the corrected \`export const ${sectionName} = …\` component (with its local <style>/@keyframes if it has them). No imports, no module consts, no other sections, no prose.`,
        ]
      : [
          `You are fixing ONE section of an existing static Composition.tsx. Re-emit ONLY the \`export const ${sectionName}\` component with the issues below fixed — nothing else.`,
          ``,
          `## Issues to fix in ${sectionName}`,
          ...fixMessages.map((m) => `- ${m}`),
          ``,
          `## Scene brief`,
          `Label: "${scene.label}"`,
          scene.description ? `Story role: ${scene.description}` : "",
          scene.visual_concept ? `Visual concept:\n> ${scene.visual_concept}` : "",
          ``,
          `## Canvas`,
          `- Aspect ratio: ${aspect} (${viewingContext}), surface ${dims.width}×${dims.height}`,
          `- Keep text sizes + fontFamily consistent with the rest of the file; reuse the file's existing module consts (PALETTE, FONT_*, keyframes) and components — do NOT redefine them.`,
          ``,
          `## Full Composition.tsx (READ-ONLY context — do not re-emit any of it except ${sectionName})`,
          "```tsx",
          baseContext,
          "```",
          ``,
          `Output ONLY the corrected \`export const ${sectionName} = …\` component. No imports, no module consts, no other sections, no prose.`,
        ];
  const content = userMessage.filter((l) => l.length > 0).join("\n");

  try {
    const resp = await client.messages
      .stream(
        {
          model,
          max_tokens: BUILD_MAX_TOKENS,
          // Reasoning is a real design/motion decision even for a scoped fix —
          // the win is the small OUTPUT (one section) + scene isolation.
          ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
          system: [
            {
              type: "text",
              text:
                mode === "animation"
                  ? ANIMATION_AGENT_SYSTEM_PROMPT
                  : DESIGN_AGENT_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content }],
        },
        { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
      )
      .finalMessage();
    const text = resp.content.find((c: { type: string }) => c.type === "text");
    const raw = text && text.type === "text" ? stripCodeFence(text.text.trim()) : "";
    // Isolate the one section even if the model emitted extra context.
    const block = raw ? extractSection(raw, sceneIndex) : null;
    return { block, usage: usageOf(resp.usage) };
  } catch (err) {
    console.warn(
      `[pipeline] regenerateSectionBlock(${sectionName}, ${mode}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return { block: null, usage: EMPTY_USAGE };
  }
};

/**
 * Re-run the Design + Choreography passes for a SINGLE scene without
 * touching the others. Used by the preview-page "Regenerate scene N"
 * button — the user iterates on one moment at a time at ~1/Nth the
 * cost of rebuilding the whole composition.
 *
 * Both passes emit ONLY the `Section{N}` block (the full file rides along as
 * read-only context, with base64 data-URIs elided outside the target section)
 * and the caller splices it back — module consts, imports, and every other
 * Section stay byte-identical BY CONSTRUCTION, and output tokens (the dominant
 * regen cost + latency) drop from a full ~18k-token file re-emission per pass
 * to one ~3-4k-token section. Returns ok:false when the section can't be
 * isolated or spliced; callers (repair ladder / regen button) surface it.
 */
export const regenerateScene = async (
  rawInput: BuildInput,
  existingCode: string,
  sceneIndex: number,
  instruction?: string,
): Promise<BuildResult> => {
  // Same read-time sanitization as buildAnimatedSections — old cached
  // brand_extract values get filtered before the agents see them.
  const input: BuildInput = {
    ...rawInput,
    brand_extract: sanitizeBrandExtract(rawInput.brand_extract),
  };
  let client: ReturnType<typeof getAnthropic>;
  try {
    client = getAnthropic();
  } catch (err) {
    return {
      ok: false,
      error: `Anthropic client init failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const scene = input.script.scenes[sceneIndex];
  if (!scene) {
    return {
      ok: false,
      error: `Scene index ${sceneIndex} out of range (script has ${input.script.scenes.length} scenes)`,
    };
  }

  const sectionName = `Section${sceneIndex}`;
  const dims = dimensionsForScript(input.script);
  const aspect = input.script.config?.aspect_ratio ?? "16:9";
  const viewingContext: "mobile" | "desktop" =
    aspect === "16:9" ? "desktop" : "mobile";

  // ─── Pass 1 (single-section EMISSION + splice) ───────────────────
  // The model re-emits ONLY Section{N}; replaceSection splices it back, so every
  // other section / module const / import is byte-identical BY CONSTRUCTION (the
  // old full-file re-emission merely *requested* byte-identity — and cost ~18k
  // output tokens per pass to re-print unchanged code, the dominant regen cost).
  // Long base64 data-URIs are elided from the read-only context outside the
  // target section (a composition can be >90% inlined-image base64).
  const designContext = elideDataUrisOutsideSection(existingCode, sectionRange, sceneIndex);
  const designUserMessage = [
    `You are regenerating ONE Section component inside an existing Composition.tsx.`,
    ``,
    `## What to change`,
    `Replace ${sectionName} (scene index ${sceneIndex}, "${scene.label}", duration ${roundTo(sceneDurationSeconds(scene), 2)}s). Re-emit ONLY the \`export const ${sectionName} = …\` component — the rest of the file is READ-ONLY context and is preserved verbatim by the caller.`,
    ``,
    `## Canvas`,
    `- Aspect ratio: ${aspect}`,
    `- Viewing context: ${viewingContext}${viewingContext === "mobile" ? " (mobile floors: lede ≥36px, paragraphs ≥28px, captions/meta ≥22px, headlines ≥80px)" : ""}`,
    `- Surface: ${dims.width}×${dims.height}`,
    `- IMPORTANT: keep text sizes in ${sectionName} consistent with the rest of the file — don't shrink body type below the floor. Reuse the file's existing module consts (PALETTE, FONT_*, LOGO_SRC, keyframes) and components — do NOT redefine them, do NOT invent new ones.`,
    ``,
    `## Scene brief`,
    `Label: "${scene.label}"`,
    scene.description ? `Story role: ${scene.description}` : "",
    scene.visual_concept ? `Visual concept:\n> ${scene.visual_concept}` : "",
    input.script.narrative?.throughline
      ? `Keep this section on-story — the throughline running through the whole piece is: ${input.script.narrative.throughline}`
      : "",
    instruction ? `\nUser direction: ${instruction}` : "",
    ``,
    `## Existing Composition.tsx (READ-ONLY context — do not re-emit any of it except ${sectionName})`,
    "```tsx",
    designContext,
    "```",
    ``,
    `Output ONLY the replacement \`export const ${sectionName} = …\` component. No imports, no module consts, no other sections, no prose.`,
  ]
    .filter((l) => l.length > 0)
    .join("\n");

  let designResponse;
  try {
    designResponse = await streamBuildCall("design pass", () => client.messages.stream(
      {
        // Streaming required: max_tokens=32k × Opus could exceed the
        // SDK's 10-minute non-streaming threshold. finalMessage() returns
        // the same Message shape as messages.create().
        model: MODELS.codingAgent,
        max_tokens: BUILD_MAX_TOKENS,
        // GLM (z.ai) reasoning control — NOT Anthropic's adaptive (which z.ai
        // ignores → empty/truncated output). thinking.type ∈ enabled|disabled;
        // depth via reasoning_effort. "max" per z.ai's coding recommendation.
        ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
        system: [
          {
            type: "text",
            text: DESIGN_AGENT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: designUserMessage }],
      },
      { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
    ).finalMessage());
  } catch (err) {
    return {
      ok: false,
      stage: "design",
      error: `Design Agent API error: ${formatAnthropicError(err)}`,
    };
  }

  const designText = designResponse.content.find((c: { type: string }) => c.type === "text");
  if (!designText || designText.type !== "text") {
    return {
      ok: false,
      stage: "design",
      error: "Design Agent returned no text content.",
    };
  }
  // Isolate the one section (tolerates over-emission) and splice it into the
  // existing file — everything outside Section{N} is byte-preserved.
  const designBlock = extractSection(stripCodeFence(designText.text.trim()), sceneIndex);
  if (!designBlock) {
    return {
      ok: false,
      stage: "design",
      error: `Design Agent response did not contain an isolable ${sectionName} block.`,
    };
  }
  const designCode = replaceSection(existingCode, sceneIndex, designBlock);
  if (!designCode) {
    return {
      ok: false,
      stage: "design",
      error: `Could not splice ${sectionName} into the existing composition (section boundaries not found).`,
    };
  }

  // ─── Pass 2 (single-section EMISSION + splice, animation) ────────
  const animationContext = elideDataUrisOutsideSection(designCode, sectionRange, sceneIndex);
  const animationUserMessage = [
    `Add CSS animations to ${sectionName} in the Composition.tsx below. Use ONLY CSS @keyframes / animation / animation-delay / transition. Re-emit ONLY the animated \`export const ${sectionName} = …\` component (with its local <style>/@keyframes) — the rest of the file is READ-ONLY context and is preserved verbatim by the caller.`,
    ``,
    `## Scene brief`,
    `${sectionName} runs for ${roundTo(sceneDurationSeconds(scene), 2)}s.`,
    scene.visual_concept
      ? `Animations list (from visual_concept):\n${scene.visual_concept}`
      : "",
    `Latest finite animation-delay in ${sectionName} MUST be ≥${(sceneDurationSeconds(scene) * 0.6).toFixed(2)}s (60% of duration). Distribute events across the full timeline — no front-loading.`,
    ``,
    `## Full Composition.tsx (READ-ONLY context — do not re-emit any of it except ${sectionName})`,
    "```tsx",
    animationContext,
    "```",
    ``,
    `Output ONLY the animated \`export const ${sectionName} = …\` component. No imports, no module consts, no other sections, no prose.`,
  ]
    .filter((l) => l.length > 0)
    .join("\n");

  let animationResponse;
  try {
    animationResponse = await streamBuildCall("animation pass", () => client.messages.stream(
      {
        model: MODELS.codingAgent,
        max_tokens: BUILD_MAX_TOKENS,
        // GLM (z.ai) reasoning control — NOT Anthropic's adaptive (which z.ai
        // ignores → empty/truncated output). thinking.type ∈ enabled|disabled;
        // depth via reasoning_effort. "max" per z.ai's coding recommendation.
        ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
        system: [
          {
            type: "text",
            text: ANIMATION_AGENT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: animationUserMessage }],
      },
      { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
    ).finalMessage());
  } catch (err) {
    return {
      ok: false,
      stage: "animation",
      error: `Animation Agent API error: ${formatAnthropicError(err)}`,
    };
  }

  const animationText = animationResponse.content.find(
    (c: { type: string }) => c.type === "text",
  );
  if (!animationText || animationText.type !== "text") {
    return {
      ok: false,
      stage: "animation",
      error: "Animation Agent returned no text content.",
    };
  }
  const animBlock = extractSection(stripCodeFence(animationText.text.trim()), sceneIndex);
  if (!animBlock) {
    return {
      ok: false,
      stage: "animation",
      error: `Animation Agent response did not contain an isolable ${sectionName} block.`,
    };
  }
  const splicedFinal = replaceSection(designCode, sceneIndex, animBlock);
  if (!splicedFinal) {
    return {
      ok: false,
      stage: "animation",
      error: `Could not splice animated ${sectionName} into the composition.`,
    };
  }
  let finalCode = splicedFinal;

  if (!finalCode.includes("import") || !finalCode.includes("export")) {
    return {
      ok: false,
      stage: "animation",
      error: `Spliced composition doesn't look like a TS file. First 300 chars: ${finalCode.slice(0, 300)}`,
    };
  }

  // Surgical compile-repair (#2) — same as the full build path. A mechanical
  // syntax defect gets a fast, thinking-off "fix only this" patch + re-verify
  // (≤2 attempts) before the hard gate below fails the regen. Run on the raw
  // composition, before logo/image/font finalize, so the fixer never reproduces
  // the inlined font data: URLs.
  let regenUsage = addUsage(
    usageOf(designResponse.usage),
    usageOf(animationResponse.usage),
  );
  const regenCompileRepair = await repairCompile(
    finalCode,
    verifyCompilable,
    async (c, e) => {
      const r = await surgicalCompileFix(client, MODELS.codingAgent, c, e);
      regenUsage = addUsage(regenUsage, r.usage); // billed either way
      return r.code;
    },
  );
  finalCode = regenCompileRepair.code;
  if (regenCompileRepair.attempts > 0) {
    console.warn(
      `[pipeline] regen surgical compile-repair: ${regenCompileRepair.attempts} attempt(s), ${
        regenCompileRepair.error ? "still failing" : "fixed"
      }`,
    );
  }

  // Substitute the brand-logo sentinel with the real logo URL. When the logo is
  // a long data: URL (an inline-svg mark), the design agent is handed the short
  // LOGO_SENTINEL token instead — an LLM can't reliably reproduce ~3KB of base64
  // in <Img src>, so it copies the token and we bake the real URL in here. data:
  // URLs are self-contained, so they render in both the preview iframe and the
  // Remotion render with no base-URL needed. Done before warnings so the gates
  // see the real composition.
  // Finalize: inject the brand LOGO_SRC + guarantee no broken/invented image URL
  // ships (same pass as the main build). Scene-regen has no search_assets log,
  // so the replacement pool is the crawled page images + og.
  const logoSrc = input.brand_identity?.logo?.url;
  let finalCodeOut = injectLogoSrc(finalCode, logoSrc);
  let designCodeOut = injectLogoSrc(designCode, logoSrc);
  const imagePool = [
    ...(input.brand_extract?.page_images ?? []).map((p) => p.src),
    ...(input.brand_extract?.og_image ? [input.brand_extract.og_image] : []),
  ].filter((u): u is string => typeof u === "string" && u.length > 0);
  const probe = makeImageProbe();
  finalCodeOut = (await repairBrokenImages(finalCodeOut, imagePool, probe)).code;
  designCodeOut = (await repairBrokenImages(designCodeOut, imagePool, probe)).code;

  // Inline brand @font-face fonts as same-origin data: URLs (same as the full
  // build path) — a regenerated scene reuses the file's shared BRAND_FONTS_CSS,
  // so its fonts must load cross-origin-free in the preview + MP4 too.
  const fetchFont = makeFontFetcher();
  finalCodeOut = (await inlineFontFaces(finalCodeOut, fetchFont)).code;
  designCodeOut = (await inlineFontFaces(designCodeOut, fetchFont)).code;

  // Final deterministic lucide-react safety net (same as the main build path):
  // ADD missing valid-icon imports (<BadgeCheck/> used but not imported → render
  // crash), then NEUTRALIZE invalid ones (brand logos that don't exist in lucide).
  {
    const lucide = await lucideIconNameSet();
    const isIcon = (n: string) => lucide.has(n);
    finalCodeOut = addMissingLucideImports(finalCodeOut, isIcon).code;
    designCodeOut = addMissingLucideImports(designCodeOut, isIcon).code;
    // Render-safe net for genuinely-invented / mis-scoped custom components (a
    // hallucinated <Thumb>, or a Section-local <DesignCard> referenced elsewhere):
    // stub them to null so SSR can't hard-fail the whole build. Better a dropped
    // element than a broken build; the structural gate still surfaces the names.
    const stubF = stubUndefinedComponents(finalCodeOut, isIcon);
    finalCodeOut = stubF.code;
    designCodeOut = stubUndefinedComponents(designCodeOut, isIcon).code;
    if (stubF.stubbed.length)
      console.warn(`[pipeline] stubbed undefined component(s): ${stubF.stubbed.join(", ")}`);
  }
  finalCodeOut = repairInvalidLucideImports(finalCodeOut, assessInvalidLucideImports(finalCodeOut));
  designCodeOut = repairInvalidLucideImports(designCodeOut, assessInvalidLucideImports(designCodeOut));

  // Build soft warnings — quality signals surfaced to the user but
  // not blocking the build. The strict gates (density, dead-air,
  // hallucination) already ran above.
  const warnings = buildBuildWarnings(finalCodeOut, input);

  // Hard syntax gate (see buildAnimatedSections) — never ship a scene-regen
  // that can't parse. ok:true === "this compiles."
  const compileErr = await verifyCompilable(finalCodeOut);
  if (compileErr) {
    console.error("[pipeline] regen composition failed to compile:", compileErr);
    return {
      ok: false,
      stage: "animation",
      error: `Regenerated Composition.tsx does not compile: ${compileErr}`,
    };
  }

  return {
    ok: true,
    code: finalCodeOut,
    designCode: designCodeOut,
    warnings,
    usage: regenUsage,
  };
};

export const buildAnimatedSections = async (
  rawInput: BuildInput,
  options?: { skipRetries?: boolean },
): Promise<BuildResult> => {
  const skipRetries = options?.skipRetries === true;
  // Re-apply customer-logo / partner-grid filters at READ time so old
  // briefs cached before F2 landed get clean data without re-crawl.
  const input: BuildInput = {
    ...rawInput,
    brand_extract: sanitizeBrandExtract(rawInput.brand_extract),
  };
  let client: ReturnType<typeof getAnthropic>;
  try {
    client = getAnthropic();
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Anthropic client init failed.",
    };
  }

  // ─── Pass 1 — Design Agent (with one retry on quality-gate failure) ─
  const designUserMessage = buildDesignUserMessage(input);
  const referenceImages = buildDesignReferenceImages(input);

  // First-turn content: reference-image blocks (vision-grounded taste prior
  // from the brand's actual site) followed by the structured text prompt.
  // Retry turns drop images and use plain strings — the model already saw
  // the references in turn 0; sending them again would burn tokens.
  type AnthropicContentBlock =
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "url"; url: string };
      };
  const firstUserContent: AnthropicContentBlock[] = [
    ...referenceImages,
    { type: "text", text: designUserMessage },
  ];

  // ─── search_assets tool (Phase 1: free, commercial-safe stock photos) ──
  // The design agent calls this when a scene's visual_concept needs a REAL
  // photo (a jacket, a city, dewy skin) instead of an abstract CSS shape.
  // Pexels URLs are public HTTPS, so baking the chosen URL into the comp
  // works in BOTH preview and MP4 (preview === MP4 via the same URL). Every
  // call is logged for license auditability. If the agent calls NO tool
  // (non-asset builds), the loop returns on round 0 exactly as before.
  const assetSearchLog: AssetSearchEntry[] = [];
  const aspect = input.script.config?.aspect_ratio;
  const defaultOrientation =
    aspect === "9:16" ? "portrait" : aspect === "1:1" ? "square" : "landscape";

  const SEARCH_ASSETS_TOOL = {
    name: "search_assets",
    description:
      "Search a free, commercial-safe stock library (Pexels) for a REAL photo to place in a scene. Use it when a scene's visual_concept calls for real imagery a CSS shape can't convey (a product, a place, a person, a texture, a mood). Do NOT use it for icons (use lucide-react), brand logos (use the locked brand identity / simple-icons), or charts (use recharts). Returns candidate photos with URLs you place via <Img src=\"...\">. If it returns no results, fall back to a CSS/illustration treatment — never leave a broken image.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Concrete, visual search terms, e.g. 'weathered leather jacket cuff' or 'granite mountain ridgeline at dusk'.",
        },
        type: {
          type: "string",
          enum: ["photo", "video", "lottie"],
          description:
            "photo = a still image (default). video = a short b-roll clip for a moving background (atmosphere/lifestyle), used sparingly as a backdrop. lottie = a vector micro-animation (loaders, success checks, abstract loops) — note: auto-search isn't wired yet, so for decorative motion prefer the SVG animated-primitive catalog (license-free).",
        },
        orientation: {
          type: "string",
          enum: ["landscape", "portrait", "square"],
          description: "Match the canvas; defaults to the video's aspect if omitted.",
        },
      },
      required: ["query"],
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSearchAssets = async (toolInput: any): Promise<string> => {
    const query = typeof toolInput?.query === "string" ? toolInput.query.trim() : "";
    if (!query) return JSON.stringify({ results: [], note: "query required" });
    const orientation = toolInput?.orientation ?? defaultOrientation;
    const assetType =
      toolInput?.type === "video"
        ? "video"
        : toolInput?.type === "lottie"
          ? "lottie"
          : "photo";
    // Lottie auto-search has no commercial-safe source wired yet (LottieFiles
    // needs a key + per-asset license vetting). Steer to license-free options.
    if (assetType === "lottie") {
      assetSearchLog.push({ query, type: "lottie", candidates: [] });
      return JSON.stringify({
        results: [],
        note: "Lottie auto-search isn't configured (no commercial-safe source wired). For decorative motion, build an SVG animated primitive from the catalog (license-free). The render supports <Lottie src=\"<url>\" /> if you have a specific commercial-safe Lottie JSON URL.",
      });
    }
    try {
      const cands =
        assetType === "video"
          ? await searchPexelsVideos(query, { orientation, perPage: 4 })
          : await searchPexelsPhotos(query, { orientation, perPage: 5 });
      assetSearchLog.push({
        query,
        type: assetType,
        candidates: cands.map((c) => ({
          url: c.fullUrl,
          width: c.width,
          height: c.height,
          license: c.license,
          attribution: c.attribution,
        })),
      });
      if (cands.length === 0) {
        return JSON.stringify({
          results: [],
          note: `No ${assetType}s found — fall back to a CSS/illustration treatment for this scene.`,
        });
      }
      const instruction =
        assetType === "video"
          ? 'Pick the ONE that best fits. Import { Video } from "./Video" and place it as a BACKGROUND layer: <Video src="<url>" style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }} />, with a scrim/gradient + your text and brand chrome layered ON TOP. It is muted + looped automatically. License is commercial-safe.'
          : 'Pick the ONE that best fits the scene and place it with <Img src="<url>" />. License is commercial-safe; no attribution needed.';
      return JSON.stringify({
        results: cands.map((c) => ({
          url: c.fullUrl,
          w: c.width,
          h: c.height,
          by: c.attribution,
          ...(c.durationS ? { durationS: c.durationS } : {}),
        })),
        instruction,
      });
    } catch (err) {
      // Source down / missing key → tell the agent to fall back; never crash.
      return JSON.stringify({
        results: [],
        note: `Asset search unavailable (${err instanceof Error ? err.message : "error"}). Fall back to a CSS/illustration treatment.`,
      });
    }
  };

  const runDesign = async (
    messages: {
      role: "user" | "assistant";
      content: string | AnthropicContentBlock[];
    }[],
  ) => {
    // Streaming required for Opus + max_tokens=32k (potential >10min). Now a
    // tool-use loop: the agent may call search_assets; we resolve, feed the
    // results back, and continue until it emits the final composition text.
    // Bounded so a photo-heavy brand that over-searches can't run away: after
    // MAX_TOOL_ROUNDS tool rounds we DROP the tools to force text, then allow a
    // few nudges to coax the actual .tsx out. CRITICAL: this must NEVER throw —
    // a runaway tool loop degrades to best-effort code (the gates catch bad
    // output), it does NOT kill the build. (Iter 5 Duolingo died here: a nudge
    // landed on the final round and fell off the old `for round <= MAX` loop
    // into a `throw "tool loop exceeded max rounds"`.) Each stream call is
    // wrapped in streamBuildCall so a transient z.ai drop mid-design is retried.
    const convo = [...messages];
    const MAX_TOOL_ROUNDS = 8;
    const MAX_NUDGES = 2;
    const HARD_CAP = MAX_TOOL_ROUNDS + MAX_NUDGES + 2;
    let toolRounds = 0;
    let nudges = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastResp: any = null;
    for (let turn = 0; turn < HARD_CAP; turn++) {
      const withTools = toolRounds < MAX_TOOL_ROUNDS; // drop tools after the cap to force text
      const resp = await streamBuildCall("design pass", () =>
        client.messages.stream(
          {
            // Design Pass 1 AND its retry (same runDesign helper). Opus for
            // composition taste + density on the commit-to-MP4 path.
            model: MODELS.codingAgentBuild,
            max_tokens: BUILD_MAX_TOKENS,
            // Reasoning ON: the design pass juggles ~15 machine-checked
            // constraints; letting the model reason before emitting is the
            // cheapest first-pass-compliance lever (fewer gate retries).
            ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
            system: [
              {
                type: "text",
                text: DESIGN_AGENT_SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
              },
            ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(withTools ? { tools: [SEARCH_ASSETS_TOOL] as any } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: convo as any,
          },
          { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
        ).finalMessage(),
      );
      lastResp = resp;

      if (resp.stop_reason !== "tool_use") {
        // GLM (z.ai) sometimes ENDS THE TURN with a short "…now writing the
        // Composition.tsx" preamble instead of emitting the code (an agentic
        // narrate-then-stop). If the final text isn't actually code, nudge it
        // to emit the file and continue (bounded), rather than returning prose
        // that fails the "doesn't look like a TS file" check downstream.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txt = (resp.content as any[]).find((c: { type: string }) => c.type === "text")?.text ?? "";
        const looksLikeCode = txt.includes("import") && txt.includes("export");
        if (!looksLikeCode && nudges < MAX_NUDGES) {
          nudges++;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          convo.push({ role: "assistant", content: resp.content as any });
          convo.push({
            role: "user",
            content:
              "Output the COMPLETE Composition.tsx now — the entire file, starting at the first `import` and ending at the last `export const Section`. No preamble, no explanation, no prose, no markdown fence. Emit ONLY the .tsx source.",
          });
          continue;
        }
        return resp; // code ready (or out of nudges — return best effort)
      }

      // tool_use. If tools weren't offered this round (post-cap) but the model
      // emitted tool_use anyway, nudge toward text instead of dropping the result.
      if (!withTools) {
        if (nudges < MAX_NUDGES) {
          nudges++;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          convo.push({ role: "assistant", content: resp.content as any });
          convo.push({
            role: "user",
            content:
              "Stop searching for assets — you've reached the search limit. Output the COMPLETE Composition.tsx NOW using the assets you already have (or SVG/illustration fallbacks). Start at the first `import`, end at the last `export const Section`. ONLY the .tsx source.",
          });
          continue;
        }
        return resp;
      }

      toolRounds++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolUses = (resp.content as any[]).filter((c) => c.type === "tool_use");
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: await handleSearchAssets(tu.input),
        })),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      convo.push({ role: "assistant", content: resp.content as any });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      convo.push({ role: "user", content: toolResults as any });
    }
    // Hard cap reached — return best effort rather than throwing. A build that
    // proceeds to the gates beats a design-stage crash.
    console.warn("[pipeline] design tool loop hit hard cap — returning best-effort response");
    return lastResp; // always assigned — the loop runs >= 1 iteration before here
  };

  // Tokens spent by work that DOESN'T replace `designResponse` (the scoped
  // per-scene regens + every parallel per-scene fill splice into designCode
  // rather than swapping the response), accumulated here and folded into the
  // build's billed usage at return.
  let extraDesignUsage: Usage = EMPTY_USAGE;

  // ─── Design content: monolithic whole-file pass, or parallel scaffold+fills ─
  // Default is parallel (the 5× win); RB_BUILD_MODE=monolithic is the fallback.
  // Both paths produce the SAME two things — `designResponse` (usage anchor) and
  // a validated whole-file `designCode` — then hand off to the gate loop below
  // UNCHANGED. The assembled parallel file is byte-structurally identical to a
  // monolithic one ([imports+consts] + Section0..N-1 + Generated).
  const buildMode: "monolithic" | "parallel" =
    process.env.RB_BUILD_MODE === "monolithic" ? "monolithic" : "parallel";
  let designResponse: Awaited<ReturnType<typeof runDesign>>;
  let designCode: string;

  const runMonolithicDesign = async (): Promise<
    | { ok: true; response: Awaited<ReturnType<typeof runDesign>>; code: string }
    | { ok: false; result: BuildResult }
  > => {
    let response: Awaited<ReturnType<typeof runDesign>>;
    try {
      response = await runDesign([{ role: "user", content: firstUserContent }]);
    } catch (err) {
      return {
        ok: false,
        result: { ok: false, stage: "design", error: `Design Agent API error: ${formatAnthropicError(err)}` },
      };
    }
    const text = response.content.find((c: { type: string }) => c.type === "text");
    if (!text || text.type !== "text") {
      return {
        ok: false,
        result: { ok: false, stage: "design", error: "Design Agent returned no text content.", usage: usageOf(response.usage) },
      };
    }
    const code = stripCodeFence(text.text.trim());
    if (!code.includes("import") || !code.includes("export")) {
      return {
        ok: false,
        result: {
          ok: false,
          stage: "design",
          error: `Design Agent output doesn't look like a TS file. First 300 chars: ${code.slice(0, 300)}`,
          usage: usageOf(response.usage),
        },
      };
    }
    return { ok: true, response, code };
  };

  if (buildMode === "monolithic") {
    const mono = await runMonolithicDesign();
    if (!mono.ok) return mono.result;
    designResponse = mono.response;
    designCode = mono.code;
  } else {
    // Parallel: one scaffold pass (shared design system + stub Sections), then
    // N concurrent per-scene fills spliced in. Falls back to a whole-file
    // monolithic pass in-process if the scaffold isn't spliceable — never ships
    // stubs.
    const sceneCount = input.script.scenes.length;
    let scaffoldResponse: Awaited<ReturnType<typeof runDesign>>;
    try {
      scaffoldResponse = await runDesign([
        {
          role: "user",
          content: [...referenceImages, { type: "text", text: buildScaffoldUserMessage(input) }],
        },
      ]);
    } catch (err) {
      return { ok: false, stage: "design", error: `Scaffold pass API error: ${formatAnthropicError(err)}` };
    }
    const scaffoldText = scaffoldResponse.content.find((c: { type: string }) => c.type === "text");
    const scaffoldCode =
      scaffoldText && scaffoldText.type === "text" ? stripCodeFence(scaffoldText.text.trim()) : "";
    const scaffoldSpliceable =
      scaffoldCode.includes("import") &&
      scaffoldCode.includes("export") &&
      sectionsAreSpliceable(scaffoldCode, sceneCount);

    if (!scaffoldSpliceable) {
      // Don't ship stubs — degrade explicitly to a whole-file monolithic pass.
      console.warn(
        `[pipeline] parallel scaffold not spliceable (need contiguous Section0..${sceneCount - 1} + Generated) — falling back to monolithic design pass`,
      );
      const mono = await runMonolithicDesign();
      if (!mono.ok) return mono.result;
      designResponse = mono.response;
      designCode = mono.code;
      extraDesignUsage = addUsage(extraDesignUsage, usageOf(scaffoldResponse.usage)); // bank the wasted scaffold tokens
    } else {
      designResponse = scaffoldResponse; // usage anchor = the scaffold call
      const narr = input.script.narrative;
      const fillCtx = {
        throughlineSlug: slugify(narr?.throughline ?? ""),
        anchor: throughlineAnchorFor(input.script.config?.aspect_ratio ?? "16:9"),
      };
      const cap = Math.max(1, Number(process.env.RB_SCENE_CONCURRENCY) || 5);
      const sceneIndices = input.script.scenes.map((_, i) => i);
      const settled = await mapWithConcurrency(sceneIndices, cap, (i) =>
        fillSectionBlock(client, MODELS.codingAgentBuild, input, scaffoldCode, i, fillCtx),
      );
      let assembled = scaffoldCode;
      const fillWarnings: string[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "fulfilled") {
          extraDesignUsage = addUsage(extraDesignUsage, r.value.usage);
          if (r.value.block) {
            const next = replaceSection(assembled, i, r.value.block);
            if (next) assembled = next;
            else fillWarnings.push(`scene ${i}: fill produced but did not splice — kept blank stub`);
          } else {
            fillWarnings.push(`scene ${i}: fill returned no section — kept blank stub`);
          }
        } else {
          fillWarnings.push(`scene ${i}: fill threw — kept blank stub`);
        }
      }
      designCode = assembled;
      if (fillWarnings.length > 0) {
        // Blank stubs will trip density/fill gates → the scoped design retry
        // (STAGE 5) regenerates them, so this is a soft signal, not a failure.
        console.warn(`[pipeline] parallel fills incomplete: ${fillWarnings.join("; ")}`);
      }
    }
  }

  // Quality gate: count headlines / paragraphs / SVGs per section. If
  // the output is sparse, retry once with a specific failure message.
  // STRUCTURAL failures (crash / broken-looking — invented claims, severe
  // contrast, invalid icons, undefined JSX tags, crops, logo defects) are
  // assessed by assessStructuralGates so the SAME sweep re-runs on every
  // retry's output and on the final shipped code. They used to be one-shot
  // inline checks against attempt 0 only — which is how the Supabase build
  // shipped a hand-drawn logo replica with an empty warnings.json.
  let gateReport = assessDesignDensity(designCode, input.script);
  let structural = assessStructuralGates(designCode, input);
  // Contrast scan, MINOR tier (QA B1): pairs below the 4.5:1 body floor but
  // readable for large text stay a polish-level nudge (the agent may keep a
  // 3.2:1 headline). The SEVERE (<3:1) tier — unreadable even for headlines —
  // is structural and lives in assessStructuralGates. assessContrast doesn't
  // expose per-finding fontSize, so the minor tier accepts some false
  // positives on big headlines.
  const contrastFindings = assessContrast(designCode);
  const contrastFailure =
    contrastFindings.length > 0
      ? `Contrast failures (${contrastFindings.length} text-on-background pair(s) below WCAG 4.5:1 — text will be hard to read):\n${contrastFindings
          .slice(0, 8)
          .map(
            (f) =>
              `  • ${f.fg} on ${f.bg} = ${f.ratio.toFixed(2)}:1  (need ≥4.5:1 for body, ≥3:1 for large headlines ≥48px)`,
          )
          .join("\n")}${contrastFindings.length > 8 ? `\n  ...and ${contrastFindings.length - 8} more` : ""}\nFix: for each failing pair, either darken the foreground OR lighten the background. Reach for opposite-luminance palette roles (light text on dark bg, dark text on light bg) — never accent-on-primary unless they're a high-contrast pair. If the failing element is a large headline (≥48px), 3:1 is acceptable and you can leave it.`
      : null;

  // Aspect for the geometry-aware polish gates below (drift + vertical fill).
  const gateAspect = (input.script.config?.aspect_ratio ?? "16:9") as AspectRatio;

  // Throughline-presence guard (polish). The script's narrative.throughline
  // names the connective motif; the design agent must instantiate it as ONE
  // recurring `data-throughline`-tagged element carried + evolved across
  // scenes. When it's absent (the Fuse failure: 0 tags → scenes read as
  // disconnected facts), force a retry to carry it. Only fires when the
  // script HAS a throughline and there are ≥3 scenes.
  const throughlinePresence = assessThroughlinePresence(designCode, input.script);
  const throughlineFailure = throughlinePresence?.message ?? null;

  // Throughline-DRIFT guard (QA B4). assessContinuity surfaces any tagged motif
  // whose numeric-px anchor drifts >10% of the canvas as an advisory warning. A
  // LARGE drift — a clear teleport (the LD-pre "tallboy" jumped ~800px) — is a
  // real continuity break that undercuts the "one continuous object" story, so
  // promote just that high-confidence tier to a polish retry. The check is coarse
  // (numeric px only; transform/%-centered motifs are invisible to it), so gate
  // ONLY the unambiguous cases to avoid false-positive retries.
  const SEVERE_DRIFT_PX = 280;
  const severeDrift = assessContinuity(designCode, gateAspect).filter(
    (d) => Math.max(d.driftX, d.driftY) >= SEVERE_DRIFT_PX,
  );
  const driftFailure =
    severeDrift.length > 0
      ? `Throughline motif TELEPORTS between scenes — ${severeDrift
          .map((d) => `"${d.slug}" jumps ${Math.max(d.driftX, d.driftY)}px (${d.axis})`)
          .join("; ")}. The recurring data-throughline element MUST hold a stable anchor (≈same left/top) across scenes so it reads as ONE continuous object that evolves — not one that jumps on every cut. Keep its position consistent; animate its FORM/content, not its anchor.`
      : null;

  // Uncharted-numbers guard (QA E1). A scene carrying ≥2 numeric meta values but
  // no recharts import is rendering data as flat text — the HIGH-confidence tier
  // of the missing_charts warning, so promote just that to a polish retry. (The
  // looser "chart-friendly concept" tier stays advisory: forcing a chart onto a
  // vague concept is its own slop.)
  const unchartedNumericScene =
    !/from\s+["']recharts["']/.test(designCode) &&
    input.script.scenes.some((scene) => {
      const c = (scene as { content?: Record<string, unknown> }).content ?? {};
      const meta = Array.isArray(c.meta) ? (c.meta as { value?: unknown }[]) : [];
      return meta.filter((m) => looksLikeNumber(m?.value)).length >= 2;
    });
  const chartFailure = unchartedNumericScene
    ? `Numeric data rendered as flat text — a scene has ≥2 numeric meta stats but the file imports no \`recharts\` chart. Render those numbers as a recharts chart (Bar/Line/Pie) or a bordered KPI-tile cluster — never a plain text row. Charts/tiles are how a deck makes numbers legible.`
    : null;

  // Display-font fidelity (QA C2). When the crawl resolved a REAL brand display
  // font (not a curated fallback), the comp's FONT_DISPLAY must actually use it.
  const displayFont = input.brand_identity?.fonts?.display;
  const fontMismatch = assessFontFidelity(
    designCode,
    displayFont?.family,
    displayFont?.fallback ?? true,
  );
  const fontFailure = fontMismatch
    ? `Off-brand display font — the brand's display typeface is "${fontMismatch}", but FONT_DISPLAY is set to a different family. Set FONT_DISPLAY to "${fontMismatch}" (load it via @font-face / Google Fonts as instructed) so headlines render in the brand's actual face.`
    : null;

  // Vertical-fill guard (QA V1, polish). Catches the unambiguous "empty lower
  // band" case — content all clustered in the top with nothing anchored to the
  // lower third (corgi scene-0: content stopped at ~53% of height). Conservative
  // (favors false-negatives like the drift gate): only fires on an absolute
  // top-cluster with no flex distribution / bottom anchor / tall element.
  // PER-SCENE: the file-level check passes if ANY scene fills the height, so a
  // single tall scene masks every other scene's empty lower band (PayPal: scene
  // 0 filled the frame, hiding the empty bottoms of scenes 1/2/4). Judge each
  // Section block on its own so a per-scene under-fill actually fires the retry.
  const fillScenes = fillFailuresByScene(designCode, input.script.scenes ?? [], gateAspect);
  const fillFailure = fillScenes.length
    ? fillScenes.map((f) => `Scene ${f.scene}: ${f.message}`).join("\n")
    : null;

  // Text-size floors (scene review #1, polish). Ledes/body <p> below 24px and
  // <li> below 18px were repeatedly unreadable in rendered output. The
  // detector exempts mono captions / eyebrow chrome and skips inherited
  // sizes — favors false negatives.
  const undersized = findUndersizedText(designCode);
  const undersizedFailure =
    undersized.length > 0
      ? `Unreadable body type — ${undersized.length} text element(s) below the size floor: ${undersized
          .slice(0, 6)
          .map((u) => `<${u.tag}> at ${u.fontSize}px (floor ${u.floor}px)`)
          .join("; ")}${undersized.length > 6 ? "; …" : ""}. Set every lede/body <p> to ≥${TEXT_FLOOR_P}px and every <li> to ≥${TEXT_FLOOR_LI}px. Small caption/meta text belongs in mono/uppercase chrome styling (letterSpacing ≥0.12em), never in an undersized body tag.`
      : null;

  // Accent-as-decoration (scene review #3, polish). The signature color must
  // mark THE focal element of a scene; outlining many containers with it (6
  // identical accent-bordered cards) reads as decoration, not emphasis. Flags
  // a section only when >4 elements carry a signature-colored border.
  const accentOveruse = countAccentBorders(
    designCode,
    input.brand_identity?.signature,
  );
  const accentFailure =
    accentOveruse.length > 0
      ? `Signature color used as decoration — ${accentOveruse
          .map((a) => `Section${a.section} has ${a.count} elements with signature-colored borders`)
          .join("; ")} (max 4 per section). The signature hue marks THE focal element: keep the accent border on the single element the eye should land on, give the other containers neutral hairlines, and let hierarchy (size, weight, light) do the rest.`
      : null;

  // Split the gate by class. STRUCTURAL failures (a crash, a cropped
  // element, a duplicated/fabricated logo) make the output look broken to
  // anyone watching, so they MUST be fixed even on the fast preview path —
  // the preview is exactly what the user judges quality from. SUBJECTIVE
  // failures (density, borderline contrast, throughline) are polish: worth
  // a retry on the strict MP4 path, skipped on preview so first-shot
  // iteration stays fast. Budgets: polish gets ONE shared retry (a single
  // Opus pass paid total — a structural fix carries the polish fixes along
  // for free); STRUCTURAL failures get a SECOND, structural-only retry below
  // when the shared retry's output still fails the sweep (total budget 2).
  // Whatever still fails after that ships best-of-attempts and is recorded
  // in warnings.structural_unresolved — never silently.
  const includePolish = !skipRetries;
  let polishFailure =
    includePolish &&
    (!gateReport.ok ||
      contrastFailure ||
      throughlineFailure ||
      driftFailure ||
      chartFailure ||
      fontFailure ||
      fillFailure ||
      undersizedFailure ||
      accentFailure);

  // ─── SCOPED per-scene retry fast-path (#1) ─────────────────────────────
  // When the ONLY failures are scene-localizable (sparse density, off-canvas
  // crop, baked-in copy), regenerate just the offending Section{N} blocks in
  // parallel and splice them back — instead of re-emitting the whole
  // composition (output tokens, the dominant build cost, scale with the file).
  // A non-localizable failure (contrast, throughline, invented claims, logo
  // defects, fonts, …) present anywhere disqualifies the fast-path, so we fall
  // straight through to the whole-comp retry below. The spliced result is
  // re-compiled + re-gated and only adopted if it doesn't regress, so a bad
  // splice or an unhelpful regen costs nothing but the (cheap) scoped calls.
  {
    const scopeScenes = input.script.scenes ?? [];
    const scopeAspect = (input.script.config?.aspect_ratio ?? "16:9") as AspectRatio;
    const LOCALIZABLE_KEYS = new Set(["unbound_copy", "overflow_crop"]);
    const nonLocalizablePolish =
      includePolish &&
      !!(
        contrastFailure ||
        throughlineFailure ||
        driftFailure ||
        chartFailure ||
        fontFailure ||
        fillFailure ||
        undersizedFailure ||
        accentFailure
      );
    const nonLocalizableStructural = structural.failures.some(
      (f) => !LOCALIZABLE_KEYS.has(f.key),
    );
    const densityFails = includePolish && !gateReport.ok;
    const overflowFails = structural.failures.some((f) => f.key === "overflow_crop");
    const unboundFails = structural.failures.some((f) => f.key === "unbound_copy");

    const densityScoped = densityFails
      ? densityFailuresByScene(designCode, scopeScenes)
      : [];
    const overflowScoped = overflowFails
      ? overflowFailuresByScene(designCode, scopeAspect)
      : [];
    const unboundScoped = unboundFails
      ? unboundFailuresByScene(designCode, scopeScenes)
      : [];

    // Every failing localizable gate must attribute to at least one scene; if a
    // crop/literal lives outside any Section block we can't scope it → fall back.
    const localizationComplete =
      (!densityFails || densityScoped.length > 0) &&
      (!overflowFails || overflowScoped.length > 0) &&
      (!unboundFails || unboundScoped.length > 0);

    const grouped = groupByScene(densityScoped, overflowScoped, unboundScoped);
    const canScope =
      grouped.length > 0 &&
      !nonLocalizablePolish &&
      !nonLocalizableStructural &&
      localizationComplete &&
      sectionsAreSpliceable(designCode, scopeScenes.length);

    if (canScope) {
      console.warn(
        `[pipeline] scoped retry: regenerating ${grouped.length} scene(s) [${grouped
          .map((g) => g.scene)
          .join(", ")}] instead of the whole composition`,
      );
      const results = await Promise.all(
        grouped.map(({ scene, messages }) =>
          regenerateSectionBlock(
            client,
            MODELS.codingAgentBuild,
            input,
            designCode,
            scene,
            messages,
          ).then((r) => ({ scene, ...r })),
        ),
      );
      let spliced = designCode;
      let anySpliced = false;
      for (const r of results) {
        extraDesignUsage = addUsage(extraDesignUsage, r.usage); // billed either way
        if (!r.block) continue;
        const next = replaceSection(spliced, r.scene, r.block);
        if (next) {
          spliced = next;
          anySpliced = true;
        }
      }
      // Adopt only if the spliced file COMPILES and doesn't regress the gates.
      if (anySpliced && (await verifyCompilable(spliced)) === null) {
        const reStructural = assessStructuralGates(spliced, input);
        const reDensity = assessDesignDensity(spliced, input.script);
        const notWorse =
          reStructural.failures.length <= structural.failures.length &&
          reStructural.severeContrastCount <= structural.severeContrastCount &&
          reStructural.inventedClaimCount <= structural.inventedClaimCount;
        if (notWorse) {
          designCode = spliced;
          structural = reStructural;
          gateReport = reDensity;
          // Recompute the whole-comp guard: the non-localizable polish flags
          // were already clean (canScope required it), so only density moves.
          polishFailure =
            includePolish &&
            (!gateReport.ok ||
              contrastFailure ||
              throughlineFailure ||
              driftFailure ||
              chartFailure ||
              fontFailure ||
              fillFailure ||
              undersizedFailure ||
              accentFailure);
          if (structural.failures.length === 0 && (!includePolish || gateReport.ok)) {
            console.warn("[pipeline] scoped retry cleared all gates — skipping whole-comp retry");
          } else {
            console.warn("[pipeline] scoped retry improved but gaps remain — whole-comp retry follows");
          }
        } else {
          console.warn("[pipeline] scoped retry regressed a gate; discarding, falling back to whole-comp");
        }
      } else if (anySpliced) {
        console.warn("[pipeline] scoped retry produced non-compiling splice; falling back to whole-comp");
      }
    }
  }

  if (structural.failures.length > 0 || polishFailure) {
    const retryMessage = [
      includePolish && !gateReport.ok
        ? `Your previous output failed the density check: ${gateReport.error}`
        : null,
      // Structural failures are always sent, regardless of path.
      ...structural.failures.map((f) => f.message),
      includePolish ? contrastFailure : null,
      includePolish ? throughlineFailure : null,
      includePolish ? driftFailure : null,
      includePolish ? chartFailure : null,
      includePolish ? fontFailure : null,
      includePolish ? fillFailure : null,
      includePolish ? undersizedFailure : null,
      includePolish ? accentFailure : null,
      "",
      "Re-emit the COMPLETE Composition.tsx file with these issues fixed. The full content-mapping discipline still applies — render EVERY content field present in each section's input (eyebrow, headline, lede, bullets, caption, meta, cta, illustration):",
      "  • eyebrow → an <h6> or styled <div> with uppercase tracking-wide text above the headline",
      "  • headline → an <h1> or <h2> in display weight",
      "  • lede → a <p> beneath the headline with body-size opacity-0.85",
      "  • bullets → a real <ul> with one <li> per bullet, brand-accent dot/dash markers. <div> columns are REJECTED — must be semantic <li>.",
      "  • caption → small <span> or <div> under primary content",
      "  • meta → a footer grid of label/value pairs",
      "  • illustration → an inline <svg> matching the intent (use the SVG Illustration Library)",
      "",
      "Sparse design rejected. Density of copy + illustration AND legible contrast are non-negotiable.",
    ]
      .filter((l) => l !== null)
      .join("\n");

    try {
      designResponse = await runDesign([
        { role: "user", content: designUserMessage },
        { role: "assistant", content: designCode },
        { role: "user", content: retryMessage },
      ]);
    } catch (err) {
      // Retry failed — proceed with original output rather than fail the render.
      console.warn(
        "[pipeline] Design retry failed; proceeding with original output:",
        err instanceof Error ? err.message : err,
      );
    }
    const retryText = designResponse.content.find((c: { type: string }) => c.type === "text");
    if (retryText && retryText.type === "text") {
      const retryCode = stripCodeFence(retryText.text.trim());
      // RE-ASSESS the structural sweep on the retry's output — a retry chased
      // for polish can newly INTRODUCE a structural defect (the Supabase
      // build's retry dropped LOGO_SRC for a hand-drawn replica).
      const retryStructural = assessStructuralGates(retryCode, input);
      if (
        retryCode.includes("import") &&
        retryCode.includes("export") &&
        // On the strict path the retry must also clear density; on preview
        // we only forced a structural fix, so accept any valid re-emit —
        // don't reject a logo/crop fix just for being a touch sparse.
        (skipRetries || assessDesignDensity(retryCode, input.script).ok) &&
        // Never accept a retry that made the structural floor WORSE than the
        // original: fewer-or-equal failed gates, severe (<3:1) contrast pairs
        // not increased (QA B1), and no ADDED invented numeric claims (E2).
        retryStructural.failures.length <= structural.failures.length &&
        retryStructural.severeContrastCount <= structural.severeContrastCount &&
        retryStructural.inventedClaimCount <= structural.inventedClaimCount
      ) {
        designCode = retryCode;
        structural = retryStructural;
      } else {
        // Retry didn't pass either. Use the better of the two by raw element count.
        // (Both are rendered; we just go with what we have.)
        console.warn(
          "[pipeline] Design retry also failed density check; proceeding with best available.",
        );
      }
    }
  }

  // STRUCTURAL floor, second chance. If the best code so far STILL fails any
  // structural gate (the shared retry didn't comply, or it was spent chasing
  // polish), run ONE structural-only retry — total structural budget 2 Opus
  // passes; polish stays at 1. Past this point whatever remains ships
  // best-of-attempts and is recorded in warnings.structural_unresolved.
  if (structural.failures.length > 0) {
    const structuralRetryMessage = [
      ...structural.failures.map((f) => f.message),
      "",
      "Re-emit the COMPLETE Composition.tsx file with these STRUCTURAL issues fixed. Change only what the fixes above require — keep the design, copy, layout, and every other section otherwise intact.",
    ].join("\n");
    try {
      const structuralResponse = await runDesign([
        { role: "user", content: designUserMessage },
        { role: "assistant", content: designCode },
        { role: "user", content: structuralRetryMessage },
      ]);
      const structuralText = structuralResponse.content.find(
        (c: { type: string }) => c.type === "text",
      );
      if (structuralText && structuralText.type === "text") {
        const structuralCode = stripCodeFence(structuralText.text.trim());
        const reassessed = assessStructuralGates(structuralCode, input);
        if (
          structuralCode.includes("import") &&
          structuralCode.includes("export") &&
          // Best-of-attempts: take this pass only when it strictly clears
          // structural gates without regressing the per-finding counts.
          reassessed.failures.length < structural.failures.length &&
          reassessed.severeContrastCount <= structural.severeContrastCount &&
          reassessed.inventedClaimCount <= structural.inventedClaimCount
        ) {
          designCode = structuralCode;
          structural = reassessed;
          designResponse = structuralResponse; // usage accounting follows the kept pass
        } else {
          console.warn(
            "[pipeline] Structural retry didn't improve; keeping best available.",
          );
        }
      }
    } catch (err) {
      console.warn(
        "[pipeline] Structural retry failed; proceeding with best available:",
        err instanceof Error ? err.message : err,
      );
    }
    if (structural.failures.length > 0) {
      // Budget exhausted with structural failures remaining — ship best-of-
      // attempts, but LOUDLY: buildBuildWarnings re-assesses the final code
      // and records what survived under warnings.structural_unresolved.
      console.warn(
        "[pipeline] structural gate(s) unresolved after retries:",
        structural.failures.map((f) => f.key).join(", "),
      );
    }
  }

  // ─── Pass 2 — Animation Agent ──────────────────────────────────────
  const animationUserMessage = buildAnimationUserMessage(input, designCode);

  let animationResponse;
  try {
    animationResponse = await streamBuildCall("animation pass", () => client.messages.stream(
      {
        // Choreography Pass 2 on the build path. Opus for animation
        // taste + dead-air pacing. Streaming required (Opus + 32k tokens).
        model: MODELS.codingAgentBuild,
        max_tokens: BUILD_MAX_TOKENS,
        // GLM (z.ai) reasoning control — NOT Anthropic's adaptive (which z.ai
        // ignores → empty/truncated output). thinking.type ∈ enabled|disabled;
        // depth via reasoning_effort. "max" per z.ai's coding recommendation.
        ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
        system: [
          {
            type: "text",
            text: ANIMATION_AGENT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: animationUserMessage }],
      },
      { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
    ).finalMessage());
  } catch (err) {
    return {
      ok: false,
      stage: "animation",
      error: `Animation Agent API error: ${formatAnthropicError(err)}`,
      // The design pass already spent real tokens — surface them.
      // extraDesignUsage holds the parallel path's N per-scene fills; omitting
      // it here would under-bill the whole design stage on a parallel build.
      usage: addUsage(usageOf(designResponse.usage), extraDesignUsage),
    };
  }

  const animationText = animationResponse.content.find(
    (c: { type: string }) => c.type === "text",
  );
  if (!animationText || animationText.type !== "text") {
    return {
      ok: false,
      stage: "animation",
      error: "Animation Agent returned no text content.",
      usage: addUsage(
        addUsage(usageOf(designResponse.usage), extraDesignUsage),
        usageOf(animationResponse.usage),
      ),
    };
  }
  let finalCode = stripCodeFence(animationText.text.trim());

  if (!finalCode.includes("import") || !finalCode.includes("export")) {
    return {
      ok: false,
      stage: "animation",
      error: `Animation Agent output doesn't look like a TS file. First 300 chars: ${finalCode.slice(0, 300)}`,
      usage: addUsage(
        addUsage(usageOf(designResponse.usage), extraDesignUsage),
        usageOf(animationResponse.usage),
      ),
    };
  }

  // Dead-air quality gate: scan finite (forwards) animations per section.
  // If the latest delay in a section is < 60% of the section's duration,
  // the section will freeze for the remaining time. Retry once with a
  // pointed failure message naming the offending sections.
  const deadAirReport = assessDeadAir(finalCode, input.script);
  // Reading-time gate (coarse v1): text must become legible fast so viewers
  // can read it. Flags text elements with a slow ENTRANCE animation (>1.0s).
  // Slow animation belongs on decoration, which can run while the text is
  // already readable — never on the text itself.
  const slowText = findSlowTextEntrances(finalCode);
  const readTimeFailure =
    slowText.length > 0
      ? `Reading-time problem — ${slowText.length} text element(s) use a slow ENTRANCE animation (>1.0s): ${slowText
          .slice(0, 6)
          .map((s) => `${s.name} ${s.duration}s on ${s.selector}`)
          .join(
            "; ",
          )}. Text must become legible FAST so the viewer can read it — headline entrances ≤0.4s, body ≤0.5s — then stay settled and static to be read. Speed up these text entrances. Long / slow animation belongs on DECORATIVE elements (icons, illustrations, atmosphere), which can run concurrently while the text is already readable; never on the text itself.`
      : null;
  // Late-beat dwell gate (scene review #2): the dead-air rule pushes beats
  // late, but a text element that LANDS late must still leave reading time —
  // delay + duration + max(1.2s, words×0.3s) must fit inside the scene (a
  // headline that settled in the final 15% of a scene was unreadable). The
  // detector skips short scenes, infinite loops, and caption chrome.
  const undwelled = findUndwelledText(finalCode, input.script);
  const dwellFailure =
    undwelled.length > 0
      ? `Late-beat dwell problem — ${undwelled.length} text element(s) land too late to be read: ${undwelled
          .slice(0, 6)
          .map(
            (u) =>
              `Section${u.section} <${u.tag}> settles at ${u.landsAt}s of a ${u.sceneDuration.toFixed(1)}s scene but needs ~${u.readTime}s of reading time`,
          )
          .join(
            "; ",
          )}. Every text element must finish entering with its reading time left: animation-delay + duration + max(1.2s, words × 0.3s) must fit inside the scene. Move these text beats earlier, and let DECORATIVE elements (accent bars, glows, chart draws, background shifts) carry the late beats the dead-air rule asks for.`
      : null;
  let animationUsage = usageOf(animationResponse.usage);

  // ─── SCOPED animation retry fast-path (#1) ─────────────────────────────
  // Dead-air and late-beat dwell are per-scene problems. When those are the
  // only animation failures (reading-time / slow-text is NOT scene-attributable
  // → it disqualifies the fast-path), re-pace just the offending Section{N}
  // blocks in parallel and splice them back, instead of re-emitting the whole
  // composition. Re-compiled + re-gated before adoption, with the whole-comp
  // retry below as the fallback — identical safety model to the design pass.
  let scopedAnimationCleared = false;
  if (!skipRetries && !readTimeFailure && (!deadAirReport.ok || dwellFailure)) {
    const deadAirScenes = deadAirReport.ok ? [] : deadAirReport.failures;
    const dwellScenes = undwelled.map((u) => ({
      scene: u.section,
      message: `Late-beat dwell — <${u.tag}> lands at ${u.landsAt}s of a ${u.sceneDuration.toFixed(
        1,
      )}s scene but needs ~${u.readTime}s of reading time. Pull this text beat earlier so animation-delay + duration + reading-time fits inside the scene; carry any required late beats with DECORATIVE finite motion (accent bar, glow, chart draw, gradient deepen), never a paragraph landing at the end.`,
    }));
    const grouped = groupByScene(deadAirScenes, dwellScenes);
    if (
      grouped.length > 0 &&
      sectionsAreSpliceable(finalCode, input.script.scenes.length)
    ) {
      console.warn(
        `[pipeline] scoped animation retry: re-pacing ${grouped.length} scene(s) [${grouped
          .map((g) => g.scene)
          .join(", ")}] instead of the whole composition`,
      );
      const results = await Promise.all(
        grouped.map(({ scene, messages }) =>
          regenerateSectionBlock(
            client,
            MODELS.codingAgentBuild,
            input,
            finalCode,
            scene,
            messages,
            "animation",
          ).then((r) => ({ scene, ...r })),
        ),
      );
      let spliced = finalCode;
      let anySpliced = false;
      for (const r of results) {
        animationUsage = addUsage(animationUsage, r.usage);
        if (!r.block) continue;
        const next = replaceSection(spliced, r.scene, r.block);
        if (next) {
          spliced = next;
          anySpliced = true;
        }
      }
      if (anySpliced && (await verifyCompilable(spliced)) === null) {
        const reDead = assessDeadAir(spliced, input.script);
        const reDwell = findUndwelledText(spliced, input.script);
        const deadNotWorse =
          reDead.ok ||
          (!deadAirReport.ok && reDead.failures.length <= deadAirReport.failures.length);
        if (deadNotWorse && reDwell.length <= undwelled.length) {
          finalCode = spliced;
          scopedAnimationCleared = reDead.ok && reDwell.length === 0;
          console.warn(
            scopedAnimationCleared
              ? "[pipeline] scoped animation retry cleared dead-air/dwell — skipping whole-comp retry"
              : "[pipeline] scoped animation retry improved but gaps remain — whole-comp retry follows",
          );
        } else {
          console.warn(
            "[pipeline] scoped animation retry regressed a gate; discarding, falling back to whole-comp",
          );
        }
      } else if (anySpliced) {
        console.warn(
          "[pipeline] scoped animation retry produced non-compiling splice; falling back to whole-comp",
        );
      }
    }
  }

  if (
    !scopedAnimationCleared &&
    (!deadAirReport.ok || readTimeFailure || dwellFailure) &&
    !skipRetries
  ) {
    const retryMessage = [
      deadAirReport.ok
        ? null
        : `Your previous output has dead-air problems: ${deadAirReport.error}`,
      readTimeFailure,
      dwellFailure,
      "",
      "Re-emit the COMPLETE Composition.tsx with these fixes. Three rules:",
      "",
      "1) DEAD AIR (if flagged above): for each named section, ADD 1-3 finite (forwards) animations whose `animation-delay` lands at ≥60% of the section's duration — a headline color shift, an accent bar extending, a caption fading in, a CTA pill scale-in, a logo glow pulse, a background gradient deepening. Infinite-loop atmosphere does NOT count; only finite forwards beats carry information.",
      "",
      "2) READING TIME (if flagged above): shorten the entrance animation on every flagged text element so it is legible fast (headline ≤0.4s, body ≤0.5s), then let it sit settled. Move any slow/long motion onto decorative elements that run concurrently — do not make the viewer wait through a long text animation to read the words.",
      "",
      "3) LATE-BEAT DWELL (if flagged above): a text element's delay + duration + max(1.2s, words × 0.3s) must fit inside its scene's duration. Pull every flagged text beat earlier in the timeline, and satisfy rule 1's late-beat requirement with DECORATIVE finite beats (accent bar extend, glow, chart draw, gradient deepen) or a ≤3-word flourish — never a paragraph landing at the end of the scene.",
      "",
      "These ENRICH the design — they don't contradict the existing entries.",
    ].join("\n");
    try {
      const retryResponse = await client.messages
        .stream(
          {
            // Dead-air retry on the build path. Opus.
            // Streamed: Opus + 32k max_tokens can exceed the SDK's 10-minute
            // non-streaming threshold.
            model: MODELS.codingAgentBuild,
            max_tokens: BUILD_MAX_TOKENS,
            // GLM (z.ai) reasoning control — NOT Anthropic's adaptive (which z.ai
        // ignores → empty/truncated output). thinking.type ∈ enabled|disabled;
        // depth via reasoning_effort. "max" per z.ai's coding recommendation.
        ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
            system: [
              {
                type: "text",
                text: ANIMATION_AGENT_SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [
              { role: "user", content: animationUserMessage },
              { role: "assistant", content: finalCode },
              { role: "user", content: retryMessage },
            ],
          },
          { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
        )
        .finalMessage();
      const retryText = retryResponse.content.find((c: { type: string }) => c.type === "text");
      if (retryText && retryText.type === "text") {
        const retryCode = stripCodeFence(retryText.text.trim());
        if (
          retryCode.includes("import") &&
          retryCode.includes("export") &&
          assessDeadAir(retryCode, input.script).ok &&
          // Never accept a retry that made the dwell problem WORSE — the
          // dead-air fix must not push text beats past their reading window.
          findUndwelledText(retryCode, input.script).length <= undwelled.length
        ) {
          finalCode = retryCode;
          // ACCUMULATE — don't overwrite. animationUsage already holds the
          // initial animation pass (line ~1532) plus any scoped per-scene
          // regen tokens spent above; clobbering it here would silently drop
          // the scoped tokens from the billed usage (adversarial-review find).
          animationUsage = addUsage(animationUsage, usageOf(retryResponse.usage));
        } else {
          console.warn(
            "[pipeline] Dead-air retry didn't pass either; keeping best available.",
          );
        }
      }
    } catch (err) {
      console.warn(
        "[pipeline] Dead-air retry failed; proceeding with original output:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Surgical compile-repair (#2). A compile error here is MECHANICAL — a stray
  // char, an unclosed tag, a truncated expression — not a design defect. Rather
  // than fail the build (the old behavior at the hard gate below), feed the
  // exact esbuild error to a fast, thinking-off "fix only this" call and
  // re-verify, up to 2 attempts. Done HERE, on the raw composition, BEFORE
  // logo-inject / image-repair / font-inline run — so the fixer never has to
  // reproduce the multi-KB inlined font data: URLs (truncation risk) and the
  // corrected file flows through the same finalize passes as a clean one.
  const compileRepair = await repairCompile(
    finalCode,
    verifyCompilable,
    async (c, e) => {
      const r = await surgicalCompileFix(client, MODELS.codingAgentBuild, c, e);
      animationUsage = addUsage(animationUsage, r.usage); // billed either way
      return r.code;
    },
    // 3 attempts (default is 2): slack (iter 10) lost a 58-min build to a syntax
    // error the 2-attempt repair couldn't recover. A surgical compile-fix is
    // stochastic + cheap (~one GLM call) vs re-running the whole build, so give
    // it one more shot before hard-failing.
    3,
  );
  finalCode = compileRepair.code;
  if (compileRepair.attempts > 0) {
    console.warn(
      `[pipeline] surgical compile-repair: ${compileRepair.attempts} attempt(s), ${
        compileRepair.error ? "still failing" : "fixed"
      }`,
    );
  }

  // Finalize the composition (applies to BOTH the animated + design comps, so
  // preview and MP4 stay identical):
  //   1. inject the brand LOGO_SRC const (so a long data: logo never has to be
  //      reproduced by either agent),
  //   2. GUARANTEE no broken/invented image URL ships — validate every image
  //      URL and swap dead ones to a real search_assets photo (or neutralize).
  const logoSrc = input.brand_identity?.logo?.url;
  let finalCodeOut = injectLogoSrc(finalCode, logoSrc);
  let designCodeOut = injectLogoSrc(designCode, logoSrc);
  const imagePool = [
    ...assetSearchLog.flatMap((e) => e.candidates.map((c) => c.url)),
    ...(input.brand_extract?.page_images ?? []).map((p) => p.src),
    ...(input.brand_extract?.og_image ? [input.brand_extract.og_image] : []),
  ].filter((u): u is string => typeof u === "string" && u.length > 0);
  const probe = makeImageProbe();
  const finalRepair = await repairBrokenImages(finalCodeOut, imagePool, probe);
  const designRepair = await repairBrokenImages(designCodeOut, imagePool, probe);
  finalCodeOut = finalRepair.code;
  designCodeOut = designRepair.code;
  if (finalRepair.replaced.length || finalRepair.neutralized.length) {
    console.warn(
      "[pipeline] image-integrity repaired:",
      JSON.stringify({
        replaced: finalRepair.replaced,
        neutralized: finalRepair.neutralized,
      }),
    );
  }

  // 3. Inline brand @font-face fonts as same-origin data: URLs. A hot-linked
  //    cross-origin font src fails CORS in BOTH the preview iframe and the
  //    Remotion render (corgi.insure's CDN sends no Access-Control-Allow-Origin),
  //    so the brand display face silently falls back to the generic. Downloading
  //    the bytes once and baking them in fixes both contexts at build time.
  const fetchFont = makeFontFetcher();
  const finalFonts = await inlineFontFaces(finalCodeOut, fetchFont);
  const designFonts = await inlineFontFaces(designCodeOut, fetchFont);
  finalCodeOut = finalFonts.code;
  designCodeOut = designFonts.code;

  // Final deterministic safety net for lucide-react. Two complementary repairs:
  // (1) ADD missing imports — a valid icon used but never imported (<BadgeCheck/>
  //     → "BadgeCheck is not defined" white screen; cost Coinbase a full build).
  // (2) NEUTRALIZE invalid imports — brand logos like Slack/Github that don't
  //     exist in lucide → undefined component → "Element type is invalid".
  // Add-then-neutralize so the import line is complete before we strip bad names.
  {
    const lucide = await lucideIconNameSet();
    const isIcon = (n: string) => lucide.has(n);
    const af = addMissingLucideImports(finalCodeOut, isIcon);
    const ad = addMissingLucideImports(designCodeOut, isIcon);
    finalCodeOut = af.code;
    designCodeOut = ad.code;
    const added = Array.from(new Set([...af.added, ...ad.added]));
    if (added.length) console.warn("[pipeline] auto-imported missing lucide icons:", added.join(", "));
  }
  finalCodeOut = repairInvalidLucideImports(finalCodeOut, assessInvalidLucideImports(finalCodeOut));
  designCodeOut = repairInvalidLucideImports(designCodeOut, assessInvalidLucideImports(designCodeOut));
  if (finalFonts.inlined.length || finalFonts.failed.length) {
    console.warn(
      "[pipeline] font-inline:",
      JSON.stringify({ inlined: finalFonts.inlined.length, failed: finalFonts.failed }),
    );
  }

  const warnings = buildBuildWarnings(finalCodeOut, input);
  if (finalRepair.replaced.length || finalRepair.neutralized.length) {
    warnings.images_repaired = {
      replaced: finalRepair.replaced.length,
      neutralized: finalRepair.neutralized.length,
    };
  }
  if (warnings.structural_unresolved && warnings.structural_unresolved.length > 0) {
    // Loud server-side trace to pair with the persisted warnings.json entry.
    console.warn(
      "[pipeline] structural gates unresolved at ship:",
      JSON.stringify(warnings.structural_unresolved),
    );
  }

  // Hard syntax gate — ok:true must mean "this Composition compiles." Without
  // it, a malformed file (leaked prose, truncation) was written to disk and
  // the build reported success; only the iframe/MP4 esbuild later surfaced the
  // error. stripCodeFence should keep this from ever firing; it is the
  // deterministic backstop that makes the false-positive impossible.
  const compileErr = await verifyCompilable(finalCodeOut);
  if (compileErr) {
    console.error("[pipeline] composition failed to compile:", compileErr);
    return {
      ok: false,
      stage: "animation",
      error: `Generated Composition.tsx does not compile: ${compileErr}`,
      // Both passes + scoped per-scene regens + retries (animationUsage) billed.
      usage: addUsage(
        addUsage(usageOf(designResponse.usage), extraDesignUsage),
        animationUsage,
      ),
    };
  }

  return {
    ok: true,
    code: finalCodeOut,
    designCode: designCodeOut,
    warnings,
    asset_manifest: assetSearchLog.length > 0 ? assetSearchLog : undefined,
    usage: addUsage(
      addUsage(usageOf(designResponse.usage), extraDesignUsage),
      animationUsage,
    ),
  };
};

// ─── Brand-extract sanitization (read-time logo / image filters) ─────

/**
 * Heuristic — does this URL look like a customer/partner logo rather
 * than the brand's own mark? Matches:
 *   - Filenames starting with 2-6 uppercase letters then ._-
 *     (CFSB.png, KLA-logo.svg, IBM_mark.webp)
 *   - URLs with /customer/ /clients/ /partners/ /trusted-by/
 *     /logo-grid/ /logo-cloud/ path fragments
 *
 * Used as a read-time filter on cached brand_extract data so users
 * don't have to re-crawl to benefit from the F2 fix.
 */
const looksLikeCustomerLogo = (url: string): boolean => {
  if (!url) return false;
  // Path-level signals.
  if (
    /\/(customers?|clients?|partners?|trusted[-_]?by|logos?[-_]?(grid|cloud)|integrations?|case[-_]?stud)\b/i.test(
      url,
    )
  ) {
    return true;
  }
  // Filename-level signals.
  const filename = url.split("/").pop() ?? "";
  if (/^[A-Z]{2,6}[._-]/.test(filename)) return true; // CFSB.png, KLA-logo.svg
  if (/_[A-Z]{2,6}\.(png|svg|webp|jpg|jpeg)(\?|$)/.test(filename)) return true; // x_CFSB.png
  return false;
};

/**
 * Re-apply the customer-logo / partner-grid filters on a brand_extract
 * BEFORE handing it to the agents. This makes old briefs (cached
 * before the F2 fix landed) automatically get clean data without
 * forcing the user to re-crawl. Pure function, idempotent.
 */
const sanitizeBrandExtract = <T extends AgentBrandExtract | undefined>(
  brand_extract: T,
): T => {
  if (!brand_extract) return brand_extract;
  const out = { ...brand_extract } as AgentBrandExtract;

  // logo_hd — null it out if it looks like a customer logo. The fallback
  // chain (favicon → apple_touch_icon → og_image) is still surfaced so
  // the agent has a brand asset to mount.
  if (out.logo_hd && looksLikeCustomerLogo(out.logo_hd)) {
    out.logo_hd = undefined;
  }

  // page_images — filter out customer-logo entries, keep the rest.
  if (out.page_images && out.page_images.length > 0) {
    out.page_images = out.page_images.filter(
      (p) => !looksLikeCustomerLogo(p.src ?? ""),
    );
  }

  return out as T;
};

// ─── User-message builders ─────────────────────────────────────────────

/**
 * Build a list of brand-reference image blocks for the Design Agent's
 * first turn. Vision input from the brand's actual site (og:image,
 * page images, HD logo) gives the agent a TASTE PRIOR — without it,
 * the agent is designing in the dark from text prompts.
 *
 * Cap: 4 images. Anthropic accepts URL sources directly; we don't
 * download or proxy. Skips when brand_extract is missing or URLs are
 * relative (must be absolute http(s)).
 */
const buildDesignReferenceImages = (
  input: BuildInput,
): { type: "image"; source: { type: "url"; url: string } }[] => {
  const blocks: { type: "image"; source: { type: "url"; url: string } }[] = [];
  const b = input.brand_extract;
  if (!b || !b.ok) return blocks;

  // Anthropic vision accepts JPEG, PNG, GIF, WebP. SVG / ICO / AVIF /
  // HEIF all return `image.source.base64.data: The file format is
  // invalid or unsupported`. Filter by extension before sending.
  //
  // The URL must also be HTTPS: the API rejects http:// with a 400
  // ("Only HTTPS URLs are supported.") that fails the ENTIRE request —
  // one http image from a crawl took out a whole build (Tony's
  // Chocolonely). Require https (not https?) and drop the rest.
  const isVisionSafeImageUrl = (u?: string): u is string => {
    if (typeof u !== "string" || !/^https:\/\//i.test(u)) return false;
    return /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(u);
  };

  // Order: site_screenshot (a REAL homepage render — the most representative
  // brand-page snapshot, better than the share-card og:image) → og_image →
  // logo_hd (brand mark) → first page_images (real product imagery). Cap at 4.
  const candidates: string[] = [];
  if (isVisionSafeImageUrl(b.site_screenshot)) candidates.push(b.site_screenshot);
  if (isVisionSafeImageUrl(b.og_image) && !candidates.includes(b.og_image))
    candidates.push(b.og_image);
  if (isVisionSafeImageUrl(b.logo_hd) && !candidates.includes(b.logo_hd))
    candidates.push(b.logo_hd);
  if (b.page_images) {
    for (const p of b.page_images) {
      if (
        isVisionSafeImageUrl(p.src) &&
        !candidates.includes(p.src)
      ) {
        candidates.push(p.src);
      }
      if (candidates.length >= 4) break;
    }
  }

  for (const url of candidates.slice(0, 4)) {
    blocks.push({ type: "image", source: { type: "url", url } });
  }
  return blocks;
};

// Structured copy → named render slots. Extracted so the monolithic design
// brief AND each parallel per-scene fill (fillSectionBlock) emit byte-identical
// copy instructions — one source of truth for how a scene's content is framed.
export const buildSceneCopyLines = (
  content: Script["scenes"][number]["content"],
): string[] => {
  const c = content ?? {};
  const lines: string[] = [];
  lines.push("Copy to render (use the exact strings, render each field as its own visual slot):");
  if (c.eyebrow) lines.push(`  • eyebrow:    "${c.eyebrow}"  → small uppercase label, brand-accent color, top of content`);
  if (c.headline) lines.push(`  • headline:   "${c.headline}"  → hero text, large display weight, central`);
  if (c.lede) lines.push(`  • lede:        "${c.lede}"  → supporting paragraph beneath the headline, body-text size, opacity ~0.85`);
  if (c.bullets && c.bullets.length > 0) {
    lines.push(`  • bullets (${c.bullets.length}): render as a list with brand-accent markers`);
    for (const b of c.bullets) lines.push(`      - "${b}"`);
  }
  if (c.caption) lines.push(`  • caption:     "${c.caption}"  → small support text under primary content`);
  if (c.meta && c.meta.length > 0) {
    lines.push(`  • meta (${c.meta.length}): render as a key-value footer grid with hairline rule on top`);
    for (const m of c.meta) lines.push(`      - ${m.label}: ${m.value}`);
  }
  if (c.cta) {
    lines.push(`  • cta.primary:  "${c.cta.primary}"  → prominent call-to-action`);
    if (c.cta.secondary) lines.push(`  • cta.secondary: "${c.cta.secondary}"  → smaller, beneath the primary`);
  }
  if (c.illustration) {
    lines.push(`  • illustration: "${c.illustration}"  → render an inline SVG matching this intent (see the SVG Illustration Library in your system prompt)`);
  }
  // Back-compat: if a legacy texts[] array is present without headline, surface it as a hint.
  if (!c.headline && c.texts && c.texts.length > 0) {
    lines.push(`  • (legacy) texts: ${JSON.stringify(c.texts)}`);
  }
  if (c.asset_ids && c.asset_ids.length > 0) {
    lines.push(`  • asset_ids (mount via <Img>): ${JSON.stringify(c.asset_ids)}`);
  }
  return lines;
};

const buildDesignUserMessage = (input: BuildInput): string => {
  // Surface the script in a web-vocabulary form: per-section briefs in
  // seconds. Pass 1 builds a static React section per entry.
  const sectionsInSeconds = input.script.scenes.map((s, i) => ({
    index: i,
    label: s.label,
    description: s.description,
    duration_seconds: roundTo(sceneDurationSeconds(s), 2),
    visual_concept: s.visual_concept ?? "",
    content: s.content ?? { texts: [], asset_ids: [] },
  }));

  const dims = dimensionsForScript(input.script);
  const aspect = input.script.config?.aspect_ratio ?? "16:9";
  const orientation =
    aspect === "9:16"
      ? "PORTRAIT (vertical)"
      : aspect === "1:1"
        ? "SQUARE"
        : "LANDSCAPE";
  const safeMarginPx = aspect === "16:9" ? 80 : 64;
  const safeW = dims.width - 2 * safeMarginPx;
  const safeH = dims.height - 2 * safeMarginPx;
  // viewing_context controls the body-text floor. Mobile aspects
  // (9:16, 1:1) push body floor to 28px so a paragraph rendered into
  // 1080×1920 stays readable on a 400-wide phone (~28/1080 × 400 ≈
  // 10px effective, vs ~7px effective for the legacy 20px floor).
  const viewingContext: "mobile" | "desktop" =
    aspect === "16:9" ? "desktop" : "mobile";
  const textFloorSummary =
    viewingContext === "mobile"
      ? "Mobile viewers see this on a phone — body floors are larger: lede ≥36px, paragraphs ≥28px, captions/meta ≥22px, headlines ≥80px. A 20px paragraph on a 1080-wide canvas reads as ~7px on a 400-wide phone — that's the bug to avoid."
      : "Desktop viewers — tight typography is fine: lede ~20-22px, paragraphs 18-22px, captions 13-15px, headlines 80-160px.";
  const compositionGuidance =
    aspect === "9:16"
      ? `Vertical stack layout. Headlines wrap to 2-3 lines at fontSize 80-120px lineHeight 1.05. Three-panel concepts MUST stack top-to-bottom (full-width rows), NOT side-by-side. Top third: logo + eyebrow + headline. Middle third: primary content stacked vertically. Bottom third: lede + CTA.`
      : aspect === "1:1"
        ? `Centered, symmetric composition. Single-focus per section — pick ONE hero element, not three. Headlines 80-100px.`
        : `Horizontal layouts work — split panels, side-by-side trios, dashboards. Headlines 100-160px display weight.`;

  // Narrative spine (Agent 1's story design). When present, surface it
  // so these sections read as ONE story, not N independent slides — the
  // Design Agent carries the throughline motif and the arc's tonal
  // progression across sections (e.g. cold/gray opener → warm/brand-color
  // closer). Optional: older scripts have no narrative.
  const narr = input.script.narrative;
  const narrativeLines: string[] = narr
    ? [
        "## Narrative (these sections tell ONE story — design them as a sequence, not islands)",
        narr.logline ? `- Story: ${narr.logline}` : "",
        narr.arc ? `- Arc across the sections: ${narr.arc}` : "",
        narr.throughline
          ? `- Throughline (REQUIRED — this is the connective tissue): ${narr.throughline}\n  → Instantiate this as ONE concrete recurring visual element (translate the idea into something you can draw — a shape, an object, a motif). Render it in MOST sections, let it EVOLVE along the arc (it transforms / opens / grows / connects, it does not reset to a fresh thing each cut), keep its on-canvas anchor stable, and wrap it in \`<div data-throughline="<same-slug>">\` (SAME slug) in every section it appears. Without this the sections read as disconnected facts, not one story.`
          : "",
        "- Reflect the arc's progression in the composition: let early-section tone and later-section tone differ (e.g. cramped/cool → open/brand-warm) so the sequence visibly builds. Recurring motifs should evolve, not reset, between sections.",
        "",
      ].filter((l) => l.length > 0)
    : [];

  const lines: string[] = [
    "Design the React sections for this brief. STATIC — no animation, no motion code. Pure layout, typography, decorative chrome. You are building beautiful animated-website sections; another developer will add motion later.",
    "",
    "## Canvas",
    `- Aspect ratio: **${aspect} ${orientation}**.`,
    `- Viewing context: **${viewingContext}**. ${textFloorSummary}`,
    `- Total surface: **${dims.width}×${dims.height} pixels**.`,
    `- Safe area: keep all primary content inside ${safeW}×${safeH} (inset ${safeMarginPx}px from every edge). Decorative elements may bleed past, primary content cannot.`,
    `- Composition guidance: ${compositionGuidance}`,
    "",
    ...narrativeLines,
    "## Sections to design",
    `Each section becomes one Section{N} React component (0-indexed). All sections render into the same ${dims.width}×${dims.height} surface (${aspect} ${orientation}).`,
    "",
  ];
  for (const s of sectionsInSeconds) {
    lines.push(`### Section${s.index} — \"${s.label}\" (${s.duration_seconds}s)`);
    if (s.description) lines.push(`Intent: ${s.description}`);
    if (s.visual_concept) {
      lines.push(`Visual concept:`);
      lines.push(`> ${s.visual_concept}`);
    }
    // Structured copy — render each field as a named slot the agent must place.
    lines.push(...buildSceneCopyLines(s.content));
    lines.push("");
  }
  // Flat, agent-facing view of the asset manifest. We deliberately
  // surface only the fields an agent needs (id + URL) and embed a
  // copy-paste-ready usage snippet so the model resolves correctly.
  // (script.assets.images is an Array at runtime — not a dict — so the
  // agent's code MUST use .find().)
  // Filter out cached customer-logo URLs at read time — the brief
  // may have site_logo / site_img_N pointing at someone else's brand
  // (Fuse case: CFSB.png cached as site_logo). The sanitizer above
  // handles brand_extract.* but the script's own assets list needs the
  // same treatment so the agent doesn't mount a customer logo.
  const assetImages = (input.script.assets?.images ?? [])
    .filter((a) => !looksLikeCustomerLogo(a.src ?? ""))
    .map((a) => ({
      id: a.id,
      src: a.src,
    }));
  if (assetImages.length > 0) {
    lines.push("## Image assets");
    lines.push("Image asset URLs you may reference via `<Img src={...}>`:");
    for (const a of assetImages) {
      lines.push(`  - id="${a.id}"  →  ${a.src}`);
    }
    lines.push("");
    lines.push("**The simplest usage: paste the URL directly.**");
    lines.push("```tsx");
    lines.push(`<Img src="${assetImages[0].src}" style={{ width: 72, height: 72 }} />`);
    lines.push("```");
    lines.push("Don't write `script.assets.images.someId` — `images` is an Array, not an object. Use the literal URL.");
    lines.push("");
  }
  appendBrandContext(lines, input);
  // Golden-scene exemplars (QUALITY-ARCHITECTURE.md #1): 1-2 gate-clean worked
  // examples keyed to this script's dominant registers — imitation beats prose
  // rules for structural quality. Placed BEFORE the machine contract so the
  // contract stays the last, most salient thing. RB_EXEMPLARS=off kills it.
  const exemplarBlock = exemplarPromptBlock(input.script.scenes.map((s) => s.register));
  if (exemplarBlock) {
    lines.push("");
    lines.push(exemplarBlock);
  }

  // The machine contract LAST so it's the most salient thing before emission —
  // a compact restatement, as data, of exactly what the static gates reject.
  // Models comply far better with local, checkable constraints than with the
  // same rules as prose mid-system-prompt (measured ~50% retry rate without).
  lines.push("");
  // Canvas plan is ALWAYS derived (crawl bg → palette inference → white): the
  // old `background_color`-only wiring silently disarmed the constraint AND the
  // brightness gate whenever the crawl missed it (the Duolingo inversion).
  const canvasPlan = resolveCanvasPlan(input.brand_extract);
  lines.push(
    buildDesignConstraints(aspect, {
      hasLogo: !!input.brand_identity?.logo,
      backgroundColor: canvasPlan.background,
      backgroundInferred: canvasPlan.source !== "crawl",
      signatureAccent: input.brand_identity?.signature,
    }),
  );
  lines.push("");
  lines.push(
    "Output the complete static Composition.tsx file. Export one `Section{N}` named component per section above (numbering matches the input). Each Section is self-contained with its own `<style>` block for brand fonts. Top-level `export const Generated` lists them as siblings — used for preview only. Every element at its settled position. Density: 6-10 distinct visual elements per section minimum.",
  );
  return lines.join("\n");
};

// ─── Parallel per-scene build (RB_BUILD_MODE=parallel) ──────────────────────
//
// The monolithic path has ONE design call emit the whole Composition.tsx. The
// parallel path splits that: a SCAFFOLD call establishes the shared design
// system ONCE with full cross-scene context (module consts + storyboard + stub
// Sections), then N concurrent fills each write one real Section against the
// scaffold as read-only context. Wall-time collapses from (design+animation
// over the whole file) to (scaffold + slowest single scene). Cross-scene
// coherence survives because the scaffold PINS palette/fonts/chrome + the
// throughline slug & anchor, and every fill is told them.

// Bounded-concurrency map: at most `cap` calls of `fn` in flight. A throwing
// item settles to {status:"rejected"} — it never rejects the batch, so one bad
// scene can't kill a parallel build. Order-preserving (results[i]).
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  cap: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const width = Math.max(1, Math.min(cap, items.length));
  await Promise.all(Array.from({ length: width }, () => runner()));
  return results;
};

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// A canonical on-canvas anchor for the recurring throughline motif. Every
// isolated fill pins its motif near this point so the cross-scene drift gate
// (SEVERE_DRIFT_PX=280) passes even though scenes are generated blind to each
// other. Right-of-center, vertically centered — clear of left-aligned headlines.
export const throughlineAnchorFor = (aspect: string): { left: number; top: number } => {
  if (aspect === "9:16") return { left: 540, top: 1280 };
  if (aspect === "1:1") return { left: 620, top: 600 };
  return { left: 1360, top: 540 };
};

export const buildScaffoldUserMessage = (input: BuildInput): string => {
  const sectionsInSeconds = input.script.scenes.map((s, i) => ({
    index: i,
    label: s.label,
    description: s.description,
    register: s.register,
    duration_seconds: roundTo(sceneDurationSeconds(s), 2),
    visual_concept: s.visual_concept ?? "",
  }));
  const dims = dimensionsForScript(input.script);
  const aspect = input.script.config?.aspect_ratio ?? "16:9";
  const orientation =
    aspect === "9:16" ? "PORTRAIT (vertical)" : aspect === "1:1" ? "SQUARE" : "LANDSCAPE";
  const n = sectionsInSeconds.length;
  const narr = input.script.narrative;
  const throughlineSlug = slugify(narr?.throughline ?? "");
  const anchor = throughlineAnchorFor(aspect);

  const lines: string[] = [
    "Build the SCAFFOLD for a static Composition.tsx — the SHARED FOUNDATION every scene sits on, NOT the scene bodies. Another step fills each scene in separately.",
    "",
    "## Canvas",
    `- Aspect ratio: **${aspect} ${orientation}**, surface **${dims.width}×${dims.height} pixels**.`,
    "",
  ];
  if (narr) {
    lines.push(
      "## Narrative (these sections tell ONE story — design the shared system to serve the whole arc)",
    );
    if (narr.logline) lines.push(`- Story: ${narr.logline}`);
    if (narr.arc) lines.push(`- Arc: ${narr.arc}`);
    if (narr.throughline) {
      lines.push(`- Throughline (REQUIRED connective tissue): ${narr.throughline}`);
      lines.push(
        `  → Instantiate it as ONE concrete recurring visual motif. Every scene renders it wrapped in \`<div data-throughline="${throughlineSlug}">\` (this exact slug), anchored near (left ${anchor.left}px, top ${anchor.top}px). Define shared \`@keyframes\` for it HERE so all scenes animate it consistently.`,
      );
    }
    lines.push("");
  }
  // Storyboard — enough per-scene info to plan the shared type/color system and
  // any real-photo asset searches; NOT the copy (that goes to each fill).
  lines.push(
    "## Storyboard (plan the shared system to serve ALL of these — do NOT write their bodies)",
  );
  for (const s of sectionsInSeconds) {
    lines.push(
      `### Section${s.index} — "${s.label}" (${s.duration_seconds}s)${s.register ? ` · ${s.register}` : ""}`,
    );
    if (s.description) lines.push(`Intent: ${s.description}`);
    if (s.visual_concept) lines.push(`Beat: ${s.visual_concept}`);
  }
  lines.push("");
  appendBrandContext(lines, input);
  lines.push("");
  const canvasPlan = resolveCanvasPlan(input.brand_extract);
  lines.push(
    buildDesignConstraints(aspect, {
      hasLogo: !!input.brand_identity?.logo,
      backgroundColor: canvasPlan.background,
      backgroundInferred: canvasPlan.source !== "crawl",
      signatureAccent: input.brand_identity?.signature,
    }),
  );
  lines.push("");
  lines.push(
    [
      "Output the complete SCAFFOLD Composition.tsx now — the shared foundation ONLY:",
      "1. All `import`s, the `interface Script`, and EVERY module-scope const the sections share: PALETTE, FONT_DISPLAY/FONT_BODY/FONT_MONO, the brand `@font-face` CSS, shared `@keyframes` (incl. the throughline motif's), SECTION_FRAME, shared helper components, and the configured BrandChrome wrapper. This is the ONLY place module scope may be declared.",
      '2. If a scene\'s beat needs a REAL stock photo (not a CSS shape), call search_assets NOW and declare the chosen URL as a module const (e.g. `const S2_PHOTO = "https://...";`) so that scene\'s fill can place it.',
      `3. A STUB for EVERY section, numbered contiguously 0..${n - 1}, EXACTLY: \`export const Section{N}: React.FC<{ script: Script }> = () => <div style={{ ...SECTION_FRAME }} />;\` — no real content; each is filled in separately.`,
      "4. End with `export const Generated` listing every Section as siblings (required as the final block boundary).",
      `Emit ONLY the .tsx source. All ${n} numbered stubs (Section0..Section${n - 1}) AND the trailing \`export const Generated\` MUST be present, or the build cannot assemble.`,
    ].join("\n"),
  );
  return lines.join("\n");
};

// Fill ONE section into the scaffold. Mirrors regenerateSectionBlock's stream +
// splice, but the prompt CREATES the section from the scene brief (rather than
// fixing an existing one). The scaffold rides along as read-only context so the
// fill reuses its module consts; the fill declares every new local INSIDE the
// Section body (anything above `export const Section{N}` is dropped on splice).
const fillSectionBlock = async (
  client: ReturnType<typeof getAnthropic>,
  model: string,
  input: BuildInput,
  scaffoldCode: string,
  sceneIndex: number,
  ctx: { throughlineSlug: string; anchor: { left: number; top: number } },
): Promise<{ block: string | null; usage: Usage }> => {
  const scene = input.script.scenes[sceneIndex];
  if (!scene) return { block: null, usage: EMPTY_USAGE };
  const sectionName = `Section${sceneIndex}`;
  const dims = dimensionsForScript(input.script);
  const aspect = input.script.config?.aspect_ratio ?? "16:9";
  const viewingContext: "mobile" | "desktop" = aspect === "16:9" ? "desktop" : "mobile";
  const baseContext = elideDataUrisOutsideSection(scaffoldCode, sectionRange, sceneIndex);
  const canvasPlan = resolveCanvasPlan(input.brand_extract);
  const constraints = buildDesignConstraints(aspect, {
    hasLogo: !!input.brand_identity?.logo,
    backgroundColor: canvasPlan.background,
    backgroundInferred: canvasPlan.source !== "crawl",
    signatureAccent: input.brand_identity?.signature,
  });
  const exemplar = exemplarPromptBlock(scene.register ? [scene.register] : []);
  const userMessage = [
    `You are writing ONE section of a static Composition.tsx whose shared foundation (imports, PALETTE, FONT_*, @keyframes, BrandChrome, helper components) ALREADY EXISTS below. Replace the placeholder stub for ${sectionName} with the real, richly-designed section. STATIC — no animation code; layout, typography, and decorative chrome only.`,
    ``,
    `## Scene brief`,
    `Label: "${scene.label}" — runs ${roundTo(sceneDurationSeconds(scene), 2)}s`,
    scene.description ? `Story role: ${scene.description}` : "",
    scene.visual_concept ? `Visual concept:\n> ${scene.visual_concept}` : "",
    ``,
    ...buildSceneCopyLines(scene.content),
    ``,
    `## Continuity`,
    ctx.throughlineSlug
      ? `Render the story's recurring motif wrapped in \`<div data-throughline="${ctx.throughlineSlug}">\`, its center anchored near (left ${ctx.anchor.left}px, top ${ctx.anchor.top}px) so it reads continuous with the other scenes. Reuse the shared @keyframes the scaffold defined for it.`
      : `Keep composition, palette, and type consistent with the shared design system.`,
    ``,
    `## Canvas + rules`,
    `- Aspect ${aspect} (${viewingContext}), surface ${dims.width}×${dims.height}. Density: 6-10 distinct visual elements minimum.`,
    `- REUSE the file's module consts + helpers (PALETTE, FONT_*, @keyframes, BrandChrome, SECTION_FRAME). Define every NEW local — data arrays, sub-components, scene-only @keyframes in a local <style> — INSIDE the ${sectionName} body. Do NOT declare any module-scope symbol: everything above \`export const ${sectionName}\` is discarded when your section is spliced in.`,
    constraints,
    exemplar ?? "",
    ``,
    `## Full scaffold Composition.tsx (READ-ONLY context — emit ONLY ${sectionName})`,
    "```tsx",
    baseContext,
    "```",
    ``,
    `Output ONLY the \`export const ${sectionName} = …\` component. No imports, no module consts, no other sections, no prose.`,
  ]
    .filter((l) => l.length > 0)
    .join("\n");

  try {
    const resp = await client.messages
      .stream(
        {
          model,
          max_tokens: BUILD_MAX_TOKENS,
          ...BUILD_REASONING, // GLM thinking:enabled + reasoning_effort (lib/anthropic)
          system: [
            {
              type: "text",
              text: DESIGN_AGENT_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userMessage }],
        },
        { timeout: COMPOSITION_REQUEST_TIMEOUT_MS },
      )
      .finalMessage();
    const text = resp.content.find((c: { type: string }) => c.type === "text");
    const raw = text && text.type === "text" ? stripCodeFence(text.text.trim()) : "";
    const block = raw ? extractSection(raw, sceneIndex) : null;
    return { block, usage: usageOf(resp.usage) };
  } catch (err) {
    console.warn(
      `[pipeline] fillSectionBlock(${sectionName}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return { block: null, usage: EMPTY_USAGE };
  }
};

const buildAnimationUserMessage = (
  input: BuildInput,
  designCode: string,
): string => {
  // The script is already seconds-native; just slice the per-section info.
  const sectionsInSeconds = input.script.scenes.map((s, i) => ({
    index: i,
    label: s.label,
    description: s.description,
    duration_seconds: roundTo(sceneDurationSeconds(s), 2),
    visual_concept: s.visual_concept ?? "",
  }));

  const lines: string[] = [
    "Add CSS animations to this designed React component. Use ONLY CSS @keyframes / animation / animation-delay / transition. NO JavaScript timing primitives. NO Remotion imports.",
    "",
    "## Sections to choreograph",
    "Each section is a React component you must preserve and augment with CSS animations.",
    "",
  ];
  for (const s of sectionsInSeconds) {
    lines.push(`### Section${s.index} — \"${s.label}\" (${s.duration_seconds}s)`);
    if (s.description) lines.push(`Intent: ${s.description}`);
    if (s.visual_concept) {
      lines.push(`How it animates over time:`);
      lines.push(`> ${s.visual_concept}`);
    }
    lines.push("");
  }

  lines.push("## The designed component (preserve everything; add CSS animations)");
  lines.push("```tsx");
  lines.push(designCode);
  lines.push("```");
  lines.push("");
  appendBrandContext(lines, input);
  lines.push(
    "Output the FINAL Composition.tsx with CSS animations woven in. Each Section{N} preserved as a named export. Each Section's local <style> block extended with @keyframes. Element styles augmented with `animation: name duration delay easing forwards`. Initial states set inline so the animation transitions FROM hidden TO settled. Use `forwards` fill-mode so elements stay at their final state.",
  );
  return lines.join("\n");
};

const roundTo = (n: number, digits: number): number => {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
};

const appendBrandContext = (
  lines: string[],
  input: BuildInput,
): void => {
  const hasBrand =
    !!input.brand_kit_url ||
    !!input.brand_extract?.ok ||
    (input.brand_files && input.brand_files.length > 0);
  if (!hasBrand) return;

  lines.push("## Brand context");
  if (input.brand_kit_url) lines.push(`- Website: ${input.brand_kit_url}`);

  // LOCKED identity — resolved deterministically in code. The agent MUST use
  // these verbatim instead of picking its own logo/font from the raw lists
  // below (which is how a search-icon SVG became the "logo" and an icon font
  // forced a Georgia fallback). The raw lists that follow are reference only.
  const id = input.brand_identity;
  if (id) {
    lines.push("");
    lines.push(
      "### ⚠️ LOCKED brand identity — use VERBATIM (do NOT invent a URL, pick an SVG icon, or substitute a font)",
    );
    if (id.logo) {
      const place =
        id.logo.onLight && id.logo.onDark
          ? "luminance unknown → place it on a small contrasting chip/plate so it never disappears into the scene background"
          : id.logo.onDark && !id.logo.onLight
            ? "this is a LIGHT/white logo → only place it on a DARK background, NEVER on a light one (it would vanish)"
            : "this is a DARK/colored logo → only place it on a LIGHT background, NEVER on a dark one";
      // A short normal URL the agent can copy verbatim. A long/data: URL (an
      // inline-svg mark, ~3KB of base64) is NOT reproducible by an LLM, so have
      // it REFERENCE the injected constant LOGO_SRC instead of inlining the URL.
      const longOrData =
        id.logo.url.startsWith("data:") || id.logo.url.length > 300;
      if (longOrData) {
        lines.push(
          `- LOGO: render the brand logo with <Img src={LOGO_SRC} ... /> EXACTLY ONCE, inside BrandChrome only. \`LOGO_SRC\` is a module-scope string constant that ALREADY EXISTS (injected at build time, guaranteed defined). Just reference it. Do NOT \`declare const LOGO_SRC\`, do NOT define it, do NOT add a \`typeof LOGO_SRC\` fallback, do NOT inline the URL, and do NOT render the logo in any individual scene (no opening/CTA logo) — BrandChrome is the single logo site.`,
        );
      } else {
        lines.push(`- LOGO (the ONLY brand-logo image; use this exact URL): ${id.logo.url}`);
      }
      lines.push(
        `    Placement: ${place}. Do NOT use any other image as the logo, do NOT use a page URL as an <img src>, do NOT grab a UI/search SVG.`,
      );
    } else {
      lines.push(
        `- NO usable logo was found. Do NOT render a logo <Img> and do NOT invent a URL. Render the brand WORDMARK as styled text: "${id.wordmark.text}" set in FONT_DISPLAY.`,
      );
    }
    const fontLine = (
      label: string,
      ff: { family: string; src?: string; fallback: boolean; generic: string },
    ) => {
      const load = ff.src
        ? `@font-face it from ${ff.src}`
        : ff.fallback
          ? `load "${ff.family}" from Google Fonts (the brand's own face had no usable web file)`
          : "system font";
      lines.push(`    const ${label} = '"${ff.family}", ${ff.generic}'; // ${load}`);
    };
    lines.push("  Use these FONT_* constants verbatim (the raw font list below is reference only):");
    fontLine("FONT_DISPLAY", id.fonts.display);
    fontLine("FONT_BODY", id.fonts.body);
    if (id.fonts.mono) fontLine("FONT_MONO", id.fonts.mono);
    lines.push("");
  }

  if (input.brand_extract?.ok) {
    const b = input.brand_extract;
    if (b.title) lines.push(`- Site title: ${b.title}`);
    if (b.description) lines.push(`- Description: ${b.description}`);
    if (b.theme_color) lines.push(`- Theme color: ${b.theme_color}`);
    if (b.palette && b.palette.length > 0) {
      // Lead with the brand's SIGNATURE color so the brand hue is prominent
      // instead of buried under a dark neutral (the Fuse-maroon / Tony's-brown
      // failure). When the user explicitly picked colors in the wizard, that
      // block below is authoritative, so skip the auto signature framing.
      const sig = input.brand_identity?.signature;
      const userPickedColor = !!(
        input.palette_roles?.primary || input.palette_roles?.accent
      );
      if (sig && !userPickedColor) {
        lines.push(
          `- SIGNATURE BRAND COLOR: ${sig} — the hue a viewer associates with this brand. It MUST be visually prominent and RECUR across scenes: as a dominant color field, the primary accent (headline em-words, key surfaces, CTAs), or both. NEVER let a dark/neutral color (near-black, a deep shade) dominate the frame while the signature color is absent or shrunk to a tiny detail — that is the #1 brand-fidelity failure.`,
        );
        lines.push(
          `- Supporting palette (neutrals = structure for backgrounds / text / surfaces, NOT the brand's lead hue): ${b.palette.join(", ")}`,
        );
      } else if (input.brand_identity?.signature_missing && !userPickedColor) {
        // The brand is genuinely achromatic (currentColor logo + no saturated
        // palette entry, post-rescue). Grey-by-accident reads broken; grey-by-
        // design reads premium — make the agent commit to the latter.
        lines.push(
          `- NO SIGNATURE BRAND COLOR EXISTS: this brand is deliberately monochrome (palette: ${b.palette.join(", ")}). Commit to a HIGH-CRAFT MONOCHROME treatment — carry hierarchy with type scale, weight, spacing, and luminance contrast (near-white on near-black), not hue. Do NOT invent an accent color the brand doesn't own. Make the restraint look intentional: strong tonal separation between surfaces, crisp hairlines, one bright neutral (near-white) doing the work an accent would.`,
        );
      } else {
        lines.push(
          `- Brand palette (use ALL, not just one): ${b.palette.join(", ")}`,
        );
      }
    }
    // User-picked palette roles override the auto-pick. When set, the
    // Design Agent MUST use the user's choice for PALETTE.primary etc
    // instead of inferring from frequency ranking.
    if (input.palette_roles) {
      const r = input.palette_roles;
      const parts: string[] = [];
      if (r.primary) parts.push(`primary (section backgrounds): ${r.primary}`);
      if (r.accent) parts.push(`accent (highlights, italic-em color, buttons): ${r.accent}`);
      if (r.light) parts.push(`light (text on dark bg): ${r.light}`);
      if (r.dark) parts.push(`dark (text on light bg): ${r.dark}`);
      if (parts.length > 0) {
        lines.push(
          `- USER-PICKED palette roles (AUTHORITATIVE — use these exact hex codes in PALETTE):`,
        );
        for (const p of parts) lines.push(`    ${p}`);
        lines.push(
          `  Override any frequency-ranked guess; the user explicitly assigned these roles in the wizard.`,
        );
      }
    }
    if (b.fonts && b.fonts.length > 0) {
      lines.push(`- Brand fonts (load via @font-face inside Generated):`);
      for (const f of b.fonts.slice(0, 6)) {
        const meta = [f.weight, f.style, f.format].filter(Boolean).join(" / ");
        lines.push(`    ${f.family}${meta ? ` (${meta})` : ""} → ${f.src}`);
      }
      if (b.font_roles) {
        const r = b.font_roles;
        // The LOCKED identity block above already emits authoritative FONT_*
        // constants WITH the correct CSS generic per role (genericFor). Re-emitting
        // them here — the way this block used to, hardcoding `serif` for EVERY
        // display family — gave the agent a second, contradictory instruction and
        // is exactly why a SANS display face (corgi's f37Bolton) shipped with a
        // `serif` fallback. So only surface FONT_* constants on the no-identity
        // fallback path, and derive each generic instead of guessing `serif`.
        if (!id) {
          const parts: string[] = [];
          if (r.display) parts.push(`FONT_DISPLAY = '"${r.display}", ${genericFor(r.display)}'`);
          if (r.body) parts.push(`FONT_BODY = '"${r.body}", ${genericFor(r.body)}'`);
          if (r.mono) parts.push(`FONT_MONO = '"${r.mono}", ${genericFor(r.mono)}'`);
          if (parts.length > 0) {
            lines.push(
              `    Font role classification (crawler heuristic — use these as your FONT_* constants):`,
            );
            for (const p of parts) lines.push(`      const ${p};`);
          }
        }
        if (r.display || r.body || r.mono) {
          lines.push(
            `    → Route fontFamily by element: display for h1/h2/h3, body for p/lede/bullets, mono for URLs/code/diegetic-UI text.`,
          );
        }
      }
    }
    if (b.motion_signal) lines.push(`- Motion signal: ${b.motion_signal}`);
    if (b.design_language) {
      const dl = formatDesignLanguage(b.design_language, "    ");
      if (dl) {
        lines.push(
          `- Design language (read off the brand's homepage — the reference image above shows it). MATCH this compositional feel — type treatment, layout rhythm, shape language, imagery, mood — instead of a generic look:`,
        );
        lines.push(dl);
      }
    }
    if (b.logo_hd) {
      lines.push(`- HD logo URL (preferred for visible logo mounts): ${b.logo_hd}`);
    }
    if (b.headlines && b.headlines.length > 0) {
      lines.push(`- Site headlines (tone reference):`);
      for (const h of b.headlines) lines.push(`    "${h}"`);
    }
    if (b.body_excerpts && b.body_excerpts.length > 0) {
      lines.push(`- Body copy from the site (the brand's actual claims):`);
      for (const e of b.body_excerpts.slice(0, 6)) lines.push(`    "${e}"`);
    }
  }
  if (input.brand_files && input.brand_files.length > 0) {
    lines.push(`- Uploaded files:`);
    for (const f of input.brand_files) {
      lines.push(`    ${f.name} (${f.mime}) → ${f.url}`);
    }
  }
  lines.push("");
};

// lucideIconNameSet + assessInvalidLucideImports (+ the INVALID_LUCIDE_BRANDS
// denylist) now live in ./finalize-refs — the canonical undefined-reference net,
// shared with the M2 element editor. Imported at the top of this file.

/**
 * STRUCTURAL gate sweep — the crash / broken-looking tier, distinct from
 * polish (density, minor contrast, throughline, …). One reusable assessment
 * so the pipeline runs the SAME checks on the original design output, on
 * each retry's output, and on the final shipped code. These used to be
 * inline one-shot checks against attempt 0 only: a retry that still failed —
 * or newly INTRODUCED — a structural defect shipped best-effort with no
 * record (the Supabase build hand-drew a <LogoMark> replica of a real,
 * confidently-resolved logo and shipped with an empty warnings.json).
 *
 * Each failure carries the full retry instruction (`message`, folded into
 * the design-retry prompt) and a short user-facing `summary` recorded under
 * warnings.structural_unresolved when it survives every retry.
 */
interface StructuralFailure {
  key:
    | "invented_claims"
    | "severe_contrast"
    | "invalid_lucide_imports"
    | "undefined_jsx_components"
    | "unbound_copy"
    | "overflow_crop"
    | "duplicate_logo"
    | "fabricated_logo"
    | "logo_not_rendered"
    | "provided_component_redefined"
    | "placeholder_data";
  message: string;
  summary: string;
}

interface StructuralReport {
  failures: StructuralFailure[];
  /** Per-finding severity counts, for never-accept-a-worse-retry checks. */
  severeContrastCount: number;
  inventedClaimCount: number;
}

const assessStructuralGates = (
  code: string,
  input: BuildInput,
): StructuralReport => {
  const failures: StructuralFailure[] = [];

  // PROVIDED-component contract: BrandChrome ships as a fixed file in every
  // genDir (build-wrapper.ts). An emitted redefinition either shadows it (the
  // historical duplicate/drawn-logo failure modes return) or collides with the
  // import at compile time — both structural.
  const redefined = findProvidedComponentRedefinitions(code);
  if (redefined.length > 0) {
    failures.push({
      key: "provided_component_redefined",
      message: `${redefined.join(", ")} is a PROVIDED component — \`import { BrandChrome } from "./BrandChrome"\` and configure it via props (variant/logoSrc/wordmark/ink/accent/fonts). DELETE your own definition; re-creating provided components is rejected.`,
      summary: redefined.join(", "),
    });
  }

  // Placeholder data (QA 2026-07-06): masked prices ("$•••.00"), "$—" values,
  // bare "Loading"/"TBD" labels read as a broken, half-loaded product on a
  // rendered frame. STRUCTURAL — a viewer instantly clocks it.
  const placeholders = findPlaceholderData(code);
  if (placeholders.length > 0) {
    failures.push({
      key: "placeholder_data",
      message: `Placeholder/unresolved data found on screen — every price, stat, and label must be a CONCRETE literal: ${placeholders
        .slice(0, 6)
        .map((p) => `${p.section >= 0 ? `Section${p.section} ` : ""}${p.token} (…${p.context}…)`)
        .join("; ")}${placeholders.length > 6 ? "; …" : ""}. Replace each masked/stub value with a specific diegetic literal (e.g. "$•••.00" → "$128.00", "Loading" → the actual resolved content).`,
      summary: placeholders.slice(0, 4).map((p) => p.token).join(", "),
    });
  }

  // Invented numeric claims are a TRUST/correctness failure — fabricated
  // stats like "30 days"/"00X" must not ship, so block, don't warn (QA E2).
  const invented = findInventedClaims(
    code,
    input.script,
    input.script?.brief?.about ?? input.script?.brief?.purpose,
    input.brand_extract?.body_excerpts,
    input.verified_claims,
  );
  if (invented.length > 0) {
    failures.push({
      key: "invented_claims",
      message: `Invented numeric claims found on screen (not in body_excerpts or script): ${invented.slice(0, 6).join(", ")}${invented.length > 6 ? ", …" : ""}. Replace each with qualitative copy (e.g. "$2.4M" → "substantial fees"), or omit the claim entirely.`,
      summary: invented.slice(0, 6).join(", "),
    });
  }

  // SEVERE contrast (<3:1, QA B1): unreadable even for large headlines
  // (WCAG's large-text floor is 3:1) — white-on-orange at 2.1:1 must never
  // ship. The minor 3:1–4.5:1 tier stays a polish nudge in the caller.
  const severeContrast = assessContrast(code).filter(
    (f) => f.ratio < SEVERE_CONTRAST_RATIO,
  );
  if (severeContrast.length > 0) {
    failures.push({
      key: "severe_contrast",
      message: `UNREADABLE contrast — ${severeContrast.length} pair(s) below ${SEVERE_CONTRAST_RATIO}:1. These FAIL even for large headlines and MUST be changed, not left:\n${severeContrast
        .slice(0, 8)
        .map((f) => `  • color ${f.fg} on background ${f.bg} = ${f.ratio.toFixed(2)}:1`)
        .join("\n")}\nFix each with an OPPOSITE-luminance pairing: near-white text on a dark/saturated surface, or the darkest palette ink on a light/accent surface. NEVER white (or a light tint) on a mid-tone accent like orange/lime/cyan, and never accent-on-accent.`,
      summary: `${severeContrast.length} text pair(s) below ${SEVERE_CONTRAST_RATIO}:1`,
    });
  }

  // Icon-import guard. lucide-react has NO brand/company logos; the agent
  // sometimes imports a brand name (Slack, Figma, Trello, …), which resolves
  // to `undefined` at runtime → "Element type is invalid" white screen. It
  // compiles cleanly, so only this check catches it. Brand logos → simple-icons.
  const badIcons = assessInvalidLucideImports(code);
  if (badIcons.length > 0) {
    failures.push({
      key: "invalid_lucide_imports",
      message: `Invalid lucide-react imports — ${badIcons.join(", ")} are brand/company logos that DO NOT EXIST in lucide-react and will crash the render (undefined component, white screen). lucide-react has ZERO brand logos. Remove each: use a neutral Lucide icon (Square, LayoutGrid, AppWindow, MessageSquare, FileText) for a generic tool, OR import a real brand logo from simple-icons (e.g. import { siSlack } from "simple-icons/icons"). Never import a company/product name from lucide-react.`,
      summary: badIcons.join(", "),
    });
  }

  // Undefined-JSX guard — the GENERIC "Element type is invalid" catch: any
  // capitalized tag resolving to neither a local definition nor an import is
  // a guaranteed render crash. Unlike the lucide denylist above there is NO
  // deterministic repair (we can't invent the missing component), so a
  // surviving failure lands in warnings.structural_unresolved with the SSR
  // render gate as the last backstop.
  const undefinedTags = findUndefinedJsxComponents(code);
  if (undefinedTags.length > 0) {
    failures.push({
      key: "undefined_jsx_components",
      message: `Undefined JSX component(s) — <${undefinedTags.join(">, <")}> are rendered but never defined in this file and never imported. Each resolves to \`undefined\` at runtime → React throws "Element type is invalid" → the whole render is a white screen. For each tag: define the component in this file, import it from a real module, or replace the tag with an existing element. Every capitalized JSX tag MUST resolve to a definition or an import.`,
      summary: undefinedTags.map((t) => `<${t}>`).join(", "),
    });
  }

  // Copy-binding contract. Every content field a viewer reads must be
  // RENDERED from the script (const c = script.scenes[N].content →
  // {c.headline}), never retyped as literal JSX — baked copy decouples the
  // video from the script, so a per-scene regen or script edit rewrites the
  // JSON while the pixels keep the stale text (the Fable A/B build baked all
  // its fields, including a two-tone "30," + "000" headline split). The
  // detector matches field values against a comment-stripped, tag/expression-
  // stripped literal-text view, so bound expressions and code comments never
  // false-positive.
  const unbound = findUnboundCopy(code, input.script.scenes ?? []);
  if (unbound.length > 0) {
    failures.push({
      key: "unbound_copy",
      message: `Baked-in script copy — ${unbound.length} content field(s) are retyped as literal JSX instead of rendered from the script: ${unbound
        .slice(0, 6)
        .map((u) => `scene ${u.scene} ${u.field} ("${u.excerpt}")`)
        .join(", ")}${unbound.length > 6 ? ", …" : ""}. The script is the single source of copy — an edited or regenerated script must flow into the video with NO code change. In each section bind the scene's content ONCE (\`const c = script.scenes[N].content\`) and render every field as an expression: {c.headline}, {c.lede}, {c.bullets.map(...)}, {c.cta.primary}. Styling (uppercase, two-tone color, emphasis) is CSS on the wrapper (textTransform, color, spans around the BOUND expression) — never retype, split, or re-case the text itself. Invented diegetic labels inside UI mockups (text not in any content field) are fine and need no binding.`,
      summary: `${unbound.length} field(s) baked as literals: ${unbound
        .slice(0, 4)
        .map((u) => `scene ${u.scene} ${u.field}`)
        .join(", ")}${unbound.length > 4 ? ", …" : ""}`,
    });
  }

  // Overflow guard (geometry-aware). Flags elements whose real geometry
  // crops at the canvas edge — wider than the canvas, or left-anchored so
  // left+width spills past the right edge (the Vercel "popup cropped on the
  // right border" bug). Centered wide elements are NOT flagged (they keep
  // symmetric margins). Detectable, so retry rather than ship.
  const gateAspect = (input.script.config?.aspect_ratio ?? "16:9") as AspectRatio;
  const overflows = findOverflowingElements(code, gateAspect);
  if (overflows.length > 0) {
    const safeForAspect = gateAspect === "16:9" ? 1760 : 920;
    failures.push({
      key: "overflow_crop",
      message: `Off-canvas crop — element(s) with width ${overflows.join(", ")}px cross the ${gateAspect} canvas edge (their right edge spills past the frame, or they're wider than the canvas), so they get cropped. Cap every PRIMARY element (cards, UI mocks, content blocks) at ≤${safeForAspect}px and keep left+width inside the frame; only decorative/atmosphere layers may bleed past.`,
      summary: `width ${overflows.join(", ")}px crosses the ${gateAspect} canvas edge`,
    });
  }

  // Duplicate-logo guard. BrandChrome renders the brand logo on every scene;
  // a scene rendering its OWN logo too = two logos in the same corner (the
  // Notion CTA bug). >1 logo <Img> site means a scene added one. QA V4: the
  // sanctioned logo-led CTA/opening pattern has 2 logo SITES (chrome + hero)
  // but renders ONE per frame because that scene passes showCornerLogo=false
  // to suppress the chrome mark — don't false-flag it (and waste a retry).
  const logoCount = findDuplicateLogos(code);
  if (logoCount > 1 && !hasCornerLogoSuppression(code)) {
    failures.push({
      key: "duplicate_logo",
      message: `Duplicate brand logo — the brand logo image appears at ${logoCount} places in the file. BrandChrome already renders the logo on every scene; individual scenes (including the opening and CTA) must NOT render their own brand logo. EITHER remove the scene-level logo <Img>s, OR (for a deliberate logo-led CTA/opening) keep ONE hero logo and pass \`showCornerLogo={false}\` to BrandChrome on that scene so the corner mark is suppressed — exactly one logo per frame.`,
      summary: `logo rendered at ${logoCount} sites`,
    });
  }

  // Fabricated-logo guard. When the brand identity resolved NO real logo,
  // the brand mark MUST be the wordmark text — not a drawn substitute. This
  // catches the exact regression where the agent invents a mark and labels
  // it the brand's logo (Fuse's "two offset squares" logo-mark). Narrow
  // trigger (no real logo AND the code calls something a logo/brand-mark) →
  // low false-positive.
  const noRealLogo = input.brand_identity ? !input.brand_identity.logo : false;
  if (noRealLogo && /\b(logo[-\s]?mark|brand[-\s]?mark)\b/i.test(code)) {
    failures.push({
      key: "fabricated_logo",
      message: `No real logo exists for this brand — the brand mark MUST be the WORDMARK "${input.brand_identity?.wordmark?.text ?? ""}" rendered as styled text in BrandChrome. Your output references a drawn logo/brand-mark. Remove any INVENTED mark (geometric shapes, monogram, "two squares", abstract glyph) and render the wordmark text instead. Never fabricate a logo, and never make a drawn mark the throughline.`,
      summary: "invented logo/brand-mark for a brand with no real logo",
    });
  }

  // Logo-NOT-rendered guard. The mirror of the fabrication gate: a REAL,
  // confident logo was resolved but the agent rendered neither the injected
  // LOGO_SRC const nor the URL itself (short logo URLs are inlined directly,
  // so the url also counts as sanctioned). Two failure shapes:
  //   • the brand NAME shipped as text in place of the mark (Liquid Death:
  //     the skull logo, discovered @0.95, shipped as "LIQUID DEATH" text);
  //   • a HAND-DRAWN replica of the mark shipped as a local SVG component
  //     (Supabase: <LogoMark> with eyeballed paths + an approximated green,
  //     rendered 6× — looks like the logo on screen, is a fabrication).
  const realLogoUrl = input.brand_identity?.logo?.url;
  if (realLogoUrl && !code.includes("LOGO_SRC")) {
    const drawn = findDrawnLogoStandIns(code);
    if (!code.includes(realLogoUrl) || drawn.length > 0) {
      const drawnNote =
        drawn.length > 0
          ? ` You defined and rendered <${drawn.join(">, <")}> — a hand-drawn REPLICA of the logo. A redrawn mark is a fabrication (paths and colors eyeballed by a model drift off-brand); DELETE the drawn component(s).`
          : "";
      failures.push({
        key: "logo_not_rendered",
        message: `The brand logo was NOT rendered — you fell back to text/omitted it.${drawnNote} A real brand logo IS provided. Render it EXACTLY ONCE in BrandChrome as <Img src={LOGO_SRC} style={{ height: 28, width: "auto" }} />. \`LOGO_SRC\` is a module-scope string constant injected at build time — reference it, do NOT declare it, do NOT inline a URL. Do NOT render the brand NAME as text in place of the logo image.`,
        summary:
          drawn.length > 0
            ? `real logo replaced by hand-drawn <${drawn.join(">, <")}>`
            : "real logo missing — text/omitted fallback",
      });
    }
  }

  return {
    failures,
    severeContrastCount: severeContrast.length,
    inventedClaimCount: invented.length,
  };
};

/**
 * Density check on the Design Agent's output. Counts the JSX elements that
 * carry information (headlines, paragraphs, SVGs) and compares against the
 * structured content fields the script provided. If the agent rendered a
 * section but skipped half its content slots, retry the pass.
 *
 * Crude — we're regex-counting JSX tags. False positives are cheap (one
 * extra API call); false negatives just mean we accept thin output. This
 * gate is a guardrail, not a contract.
 */
const assessDesignDensity = (
  code: string,
  script: Script,
): { ok: true } | { ok: false; error: string } => {
  // Count tags across the WHOLE file (we don't try to scope per-section
  // because the agent's component naming varies). The thresholds are
  // computed as totals based on what the script actually provided.
  const counts = {
    headline: (code.match(/<h[123]\b/gi) ?? []).length,
    paragraph: (code.match(/<p\b/gi) ?? []).length,
    svg: (code.match(/<svg\b/gi) ?? []).length,
    img: (code.match(/<Img\b/gi) ?? []).length,
    listItem: (code.match(/<li\b/gi) ?? []).length,
    // Text-bearing element tags. Used to compute the font-coverage ratio.
    textElements: (code.match(/<(h[1-6]|p|span)\b/gi) ?? []).length,
    fontFamilyDecls: (code.match(/fontFamily\s*:/gi) ?? []).length,
    // <em> tags for italic-accent emphasis (deck signature move).
    italicAccents: (code.match(/<em\b/gi) ?? []).length,
    // lucide-react imports — surface in the gate for visibility (no fail).
    lucideImports: (code.match(/from\s+["']lucide-react["']/g) ?? []).length,
    // recharts imports — used to detect when real charts are present.
    rechartsImports: (code.match(/from\s+["']recharts["']/g) ?? []).length,
    // simple-icons brand logos.
    simpleIconsImports: (code.match(/from\s+["']simple-icons[/"']/g) ?? [])
      .length,
  };
  void counts.lucideImports;
  void counts.simpleIconsImports;

  // Sum the content fields across all sections.
  const expected = {
    headlines: 0,
    ledes: 0,
    bullets: 0,
    illustrations: 0,
    imgs: 0,
  };
  for (const s of script.scenes ?? []) {
    const c = (s as { content?: Record<string, unknown> }).content ?? {};
    if (typeof c.headline === "string" && c.headline) expected.headlines += 1;
    if (typeof c.lede === "string" && c.lede) expected.ledes += 1;
    if (Array.isArray(c.bullets) && c.bullets.length > 0)
      expected.bullets += c.bullets.length;
    if (typeof c.illustration === "string" && c.illustration)
      expected.illustrations += 1;
    if (Array.isArray(c.asset_ids) && c.asset_ids.length > 0)
      expected.imgs += c.asset_ids.length;
  }

  const failures: string[] = [];

  // Each section's content.headline → at least one <h1>/<h2>/<h3>
  if (expected.headlines > 0 && counts.headline < expected.headlines) {
    failures.push(
      `expected ${expected.headlines} headline element(s); found ${counts.headline} <h1/h2/h3> tags`,
    );
  }
  // Each content.lede → at least one <p>
  if (expected.ledes > 0 && counts.paragraph < expected.ledes) {
    failures.push(
      `expected ${expected.ledes} lede paragraph(s) as <p>; found ${counts.paragraph} <p> tags`,
    );
  }
  // Bullets → require literal <li> tags. The previous "accept <p> as
  // fallback" version let the agent drop bullets entirely without
  // failing the gate. Render-evidence (Fuse Scene 1) confirmed 0 <li>
  // + 0 <ul> when 3 bullets were specified. Tighten the rule.
  if (expected.bullets > 0) {
    const bulletCarriers = counts.listItem; // STRICT — only <li> counts.
    void counts.paragraph; // keep linter happy; paragraph is no longer a bullet carrier
    if (bulletCarriers < expected.bullets) {
      failures.push(
        `expected ${expected.bullets} bullet item(s); found ${counts.listItem} <li> tags`,
      );
    }
  }
  // Illustrations → at least one <svg> per section that asked for one
  if (expected.illustrations > 0 && counts.svg < expected.illustrations) {
    failures.push(
      `expected ${expected.illustrations} inline SVG illustration(s); found ${counts.svg} <svg> tags`,
    );
  }
  // Asset_ids → at least one <Img> per asset referenced
  if (expected.imgs > 0 && counts.img < expected.imgs) {
    failures.push(
      `expected ${expected.imgs} <Img> mount(s); found ${counts.img}`,
    );
  }

  // Italic-accent emphasis is RATIONED, not required (QA D1). Forcing ≥1 <em>
  // per headline produced the "same outfit every scene" tell — an italicized
  // word on literally every hero, across every brand. The design prompt now
  // rations the move to 1-2 scenes and varies the emphasis device on the rest,
  // so a headline that stands clean is no longer a failure. (Over-use is a
  // taste/sameness issue surfaced as a warning, not a build-blocking failure.)

  // Brand-font coverage: when fonts are provided, at least 80% of text-bearing
  // elements should reference a brand font. Counts fontFamily declarations
  // vs (h*/p/span) element count.
  // We don't know which fontFamily values reference brand fonts vs system-ui
  // — this is a heuristic, false-positive-friendly.
  const hasBrandFonts = !!(
    (script as Script).assets?.fonts && (script as Script).assets.fonts.length > 0
  );
  if (hasBrandFonts && counts.textElements >= 3) {
    const ratio = counts.fontFamilyDecls / counts.textElements;
    if (ratio < 0.6) {
      failures.push(
        `brand fonts provided but only ${counts.fontFamilyDecls} fontFamily declarations across ${counts.textElements} text elements (${Math.round(ratio * 100)}% — need ≥60%). Every <h*>, <p>, <span> with text should explicitly set fontFamily to a brand font.`,
      );
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, error: failures.join("; ") };
};

/**
 * Quality gate — dead-air detection on the final (post-Pass-2) code.
 *
 * For each Section{N} component, scans all finite animations (those with
 * `forwards` fill-mode) and computes the latest animation-delay. If the
 * latest finite delay is < 60% of the section's duration, the section
 * will freeze for the remaining time — viewers see a static frame.
 *
 * Infinite-loop animations don't count: they're atmosphere, not
 * information beats. We only care about explicit beats that introduce
 * or move new content.
 *
 * Returns ok:true if all sections have ≥60% delay coverage. Returns
 * ok:false with a per-section breakdown otherwise.
 */
export const assessDeadAir = (
  code: string,
  script: Script,
):
  | { ok: true }
  | { ok: false; error: string; failures: { scene: number; message: string }[] } => {
  const failures: { scene: number; message: string }[] = [];

  for (let i = 0; i < script.scenes.length; i += 1) {
    const scene = script.scenes[i];
    const duration = sceneDurationSeconds(scene);
    if (!duration || duration < 3) continue; // very short sections — skip

    // Extract the Section{i} component body. We look for `Section${i}` or
    // similar naming and grab content up to the next top-level `export`.
    // Crude — if the agent inlines all sections together we still scan the
    // whole file once at the end. False-positives are cheap (one retry).
    const sectionPattern = new RegExp(
      `(?:Section|Scene|Slide)${i}\\b[\\s\\S]*?(?=(?:Section|Scene|Slide)${i + 1}\\b|registerRoot|$)`,
      "i",
    );
    const sectionMatch = code.match(sectionPattern);
    const sectionCode = sectionMatch ? sectionMatch[0] : code;

    // Find EVERY `animation:` shorthand — quoted inline JSX styles AND unquoted
    // declarations inside <style> CSS blocks. The original quoted-only regex was
    // blind to className-based choreography, so `finiteCount === 0` silently
    // skipped those sections as "all-infinite" — 10/10 scenes in the
    // Duolingo/Klarna QA shipped 2-3s pixel-frozen tails through that hole.
    // Shorthand grammar: name duration [timing] [delay] [count] [fill].
    const animDeclRx = /animation:\s*(?:["`]([^"`]+)["`]|([^;"`\n}]+))/g;
    let latestFiniteEnd = 0; // delay + duration of the LAST-ending finite beat
    let finiteCount = 0;
    let hasAmbient = false; // any infinite animation = the frame is never frozen
    let match;
    while ((match = animDeclRx.exec(sectionCode)) !== null) {
      const decls = (match[1] ?? match[2] ?? "").split(",");
      for (const decl of decls) {
        if (/\binfinite\b/.test(decl)) {
          hasAmbient = true;
          continue;
        }
        if (!/\bforwards\b/.test(decl)) continue;
        const beforeForwards = decl.split(/\bforwards\b/)[0];
        const timeTokens = [...beforeForwards.matchAll(/(\d+(?:\.\d+)?)s\b/g)];
        if (timeTokens.length === 0) continue;
        // 1 token = duration only (delay 0). 2+ tokens = duration first, delay last.
        const dur = parseFloat(timeTokens[0][1]);
        const delay = timeTokens.length >= 2 ? parseFloat(timeTokens[timeTokens.length - 1][1]) : 0;
        latestFiniteEnd = Math.max(latestFiniteEnd, delay + dur);
        finiteCount += 1;
      }
    }

    // A section with ambient (infinite) motion is never a frozen frame — the
    // failure mode is NO ambient AND every finite beat finished early. Judge
    // the latest beat's END against 75% of the duration: entrances front-load
    // (correct, text must land early per the dwell gate) but then SOMETHING
    // must carry the tail — an ambient loop or a late decorative beat.
    if (hasAmbient) continue;
    const requiredEnd = duration * 0.75;
    if (finiteCount === 0 || latestFiniteEnd < requiredEnd) {
      const observed = finiteCount === 0 ? "no parseable animation beats" : `last beat ends at ${latestFiniteEnd.toFixed(2)}s`;
      failures.push({
        scene: i,
        message: `Section${i} ("${scene.label}", ${duration.toFixed(1)}s): ${observed} and there is NO ambient (infinite) animation — the scene renders as a frozen still for its tail (need coverage to ≥${requiredEnd.toFixed(2)}s). Fix BOTH ways: (1) add at least one subtle infinite ambient loop that runs the whole scene (a breathing glow, drifting atmosphere, a slow float on the hero mock); (2) land a late DECORATIVE finite beat (accent bar draw, chart fill, gradient deepen) in the final third. Keep text beats early — decoration carries the tail.`,
      });
    }
  }

  if (failures.length === 0) return { ok: true };
  return { ok: false, error: failures.map((f) => f.message).join(" | "), failures };
};

/**
 * Hallucination guardrail — scan Design Agent output for invented
 * numeric claims (dollars, percentages, timeframes, counts) that
 * don't appear in source material (body_excerpts + brief.about +
 * the script's own content fields).
 *
 * Returns a list of suspicious tokens. The pipeline can surface
 * these as a retry message ("you wrote $2.4M but no source mentions
 * it") OR as a soft warning on the review UI.
 *
 * Limitations:
 * - Regex-based; doesn't understand semantic equivalence (catches
 *   "$2.4M" if source only says "$1M-$3M").
 * - Skips obviously-decorative tokens (Loan #00X, $•••).
 * - Skips tokens inside diegetic mock UI labels that look generic.
 */
const NUMERIC_CLAIM_RX =
  /(\$[0-9]+(?:\.[0-9]+)?\s*[KMBkmb]?(?:illion)?\b|\b[0-9]+(?:\.[0-9]+)?\s*(?:%|percent)\b|\b[0-9]+(?:\.[0-9]+)?\s*(?:days?|weeks?|months?|years?|hours?|minutes?)\b|\b[0-9]+(?:\.[0-9]+)?[xX]\b|\b[0-9]{2,}\+\s*(?:customers?|institutions?|banks?|users?|companies|brands?|teams?|partners?)\b)/g;

/**
 * Aggregate soft warnings into a single payload returned with the
 * BuildResult. Currently collects: invented numeric claims (from the
 * hallucination guardrail) + low-contrast color pairings.
 */
const buildBuildWarnings = (
  code: string,
  input: BuildInput,
): BuildWarnings => {
  const out: BuildWarnings = {};
  const invented = findInventedClaims(
    code,
    input.script,
    input.script?.brief?.about ?? input.script?.brief?.purpose,
    input.brand_extract?.body_excerpts,
    input.verified_claims,
  );
  if (invented.length > 0) out.invented_claims = invented;
  const contrastFindings = assessContrast(code);
  if (contrastFindings.length > 0) {
    const toEntry = (f: { fg: string; bg: string; ratio: number }) => ({
      fg: f.fg,
      bg: f.bg,
      ratio: Math.round(f.ratio * 10) / 10,
    });
    out.low_contrast = contrastFindings.slice(0, 8).map(toEntry);
    // SEVERE (<3:1) pairs that survived into the final composition — flag them
    // distinctly so they're loud (they should be rare after the B1 gate).
    const severe = contrastFindings.filter(
      (f) => f.ratio < SEVERE_CONTRAST_RATIO,
    );
    if (severe.length > 0) out.low_contrast_severe = severe.slice(0, 8).map(toEntry);
  }
  const missingCharts = findMissingCharts(code, input.script);
  if (missingCharts.length > 0) out.missing_charts = missingCharts;
  // Advisory spatial-continuity check: recurring data-throughline motifs
  // that teleport between scenes. Surfaced as a chip, never a retry (coarse).
  const gateAspect = (input.script.config?.aspect_ratio ?? "16:9") as AspectRatio;
  // Vertical fill (QA V1) — surface a persistent empty-lower-band so the user
  // sees it even when the one retry didn't resolve it.
  const fillMisses = fillFailuresByScene(code, input.script.scenes ?? [], gateAspect);
  if (fillMisses.length)
    out.low_fill = fillMisses.map((f) => `Scene ${f.scene}: ${f.message}`).join("\n");
  const drift = assessContinuity(code, gateAspect);
  if (drift.length > 0) {
    out.throughline_drift = drift.slice(0, 6).map((d) => ({
      slug: d.slug,
      axis: d.axis,
      driftX: d.driftX,
      driftY: d.driftY,
      occurrences: d.occurrences,
    }));
  }
  // Throughline-PRESENCE: the script defined a connective motif but the design
  // carried it across too few scenes (the Fuse failure). Reported even after
  // the single retry, so the user sees "story didn't cohere" rather than us
  // silently shipping N disconnected scenes.
  const absence = assessThroughlinePresence(code, input.script);
  if (absence) {
    out.throughline_absent = {
      throughline: absence.throughline,
      tagged: absence.tagged,
      scenes: absence.scenes,
    };
  }
  // Residual structural defects. The Pass-1 structural retry SHOULD have
  // fixed these, but a single retry doesn't always make the agent comply
  // (e.g. it keeps a big opening-scene logo alongside BrandChrome). Rather
  // than silently shipping the defect, report what survived — the retry
  // tries to fix; this reports what's left so the user can per-scene-regen.
  const residualLogos = findDuplicateLogos(code);
  // QA V4: a logo-led CTA/opening with showCornerLogo={false} legitimately has 2
  // logo SITES but 1 per frame — don't report it as a duplicate (it isn't one).
  if (residualLogos > 1 && !hasCornerLogoSuppression(code)) out.duplicate_logo = residualLogos;
  // Eyebrow/kicker duplication (B3): the per-scene editorial tag echoed in the
  // chrome shows the same label twice. Gather each scene's eyebrow and flag any
  // that appear ≥2× in the composition.
  const sceneEyebrows = (
    (input.script.scenes ?? []) as Array<{ content?: Record<string, unknown> }>
  )
    .map((s) => s.content?.eyebrow)
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  const dupEyebrows = findDuplicatedEyebrows(code, sceneEyebrows);
  if (dupEyebrows.length > 0) out.duplicate_eyebrow = dupEyebrows;
  // Generic decorative-filler icons (QA D4) — advisory; flags Sparkles/Sparkle.
  const fillerIcons = findDecorativeFillerIcons(code);
  if (fillerIcons > 0) out.decorative_icons = fillerIcons;
  // Redundant captions (QA V2) — advisory; a caption that restates the headline
  // or lists the names already shown by the scene's logos/images.
  const redundantCaps = findRedundantCaptions(input.script);
  if (redundantCaps.length > 0) out.redundant_caption = redundantCaps;
  // Display-font fidelity (QA C2) — flags when FONT_DISPLAY isn't the brand face.
  const dispFont = input.brand_identity?.fonts?.display;
  const fontMiss = assessFontFidelity(code, dispFont?.family, dispFont?.fallback ?? true);
  if (fontMiss) out.font_infidelity = fontMiss;
  // Register variety (QA D3) — measures whether the script's scenes use ≥3
  // distinct layout registers (same-y layouts otherwise). Surfaced for review.
  const regVariety = assessRegisterVariety(
    (input.script.scenes ?? []).map(
      (s) => (s as { register?: string }).register,
    ),
  );
  if (regVariety) out.low_register_variety = regVariety;
  const residualOverflow = findOverflowingElements(code, gateAspect);
  if (residualOverflow.length > 0) out.overflow_crop = residualOverflow;
  // Scene-review taste gates (polish tier) — report whatever survived the
  // shared retry so the user sees it rather than us shipping it silently.
  const undersizedLeft = findUndersizedText(code);
  if (undersizedLeft.length > 0) out.undersized_text = undersizedLeft.slice(0, 8);
  const undwelledLeft = findUndwelledText(code, input.script);
  if (undwelledLeft.length > 0) {
    out.undwelled_text = undwelledLeft.slice(0, 8).map((u) => ({
      section: u.section,
      tag: u.tag,
      landsAt: u.landsAt,
      sceneDuration: u.sceneDuration,
    }));
  }
  const accentLeft = countAccentBorders(code, input.brand_identity?.signature);
  if (accentLeft.length > 0) out.accent_overuse = accentLeft;
  // A1: the structural floor, re-assessed on the SHIPPED code (this runs
  // after the deterministic repairs, so a lucide alias-fix clears its gate).
  // Whatever the retries could not fix is recorded here — a structural
  // failure must never ship silently (the Supabase drawn-logo build shipped
  // with an empty warnings.json).
  const structuralLeft = assessStructuralGates(code, input);
  if (structuralLeft.failures.length > 0) {
    out.structural_unresolved = structuralLeft.failures.map(
      (f) => `${f.key}: ${f.summary}`,
    );
  }
  return out;
};

/**
 * If a scene's content.meta carries 2+ numeric values OR its
 * visual_concept mentions chart-friendly keywords (growth, trend,
 * over time, percentage, distribution), AND the design has zero
 * Recharts imports, surface a warning. Recharts is installed and
 * supported — falling back to abstract bars is a quality regression.
 */
const CHART_KEYWORDS_RX =
  /\b(growth|trend|over[\s-]?time|distribution|percentage|breakdown|conversion|funnel|year[-_]?over[-_]?year|month[-_]?over[-_]?month|before[\s\/]+after|metrics? over|chart|graph)\b/i;

const looksLikeNumber = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  // $1.2M, 240, 47%, 2.4x, $58,000, 99.97
  return /^\s*\$?\s*[0-9]+(?:[\.,][0-9]+)*\s*(?:[KMBkmb]|%|x|×|million|billion)?\s*$/.test(
    v,
  );
};

const findMissingCharts = (code: string, script: Script): string[] => {
  const hasChart = /from\s+["']recharts["']/.test(code);
  if (hasChart) return [];
  const flagged: string[] = [];
  for (const scene of script.scenes) {
    const c = (scene as { content?: Record<string, unknown> }).content ?? {};
    const meta = Array.isArray(c.meta)
      ? (c.meta as { value?: unknown }[])
      : [];
    const numericMetaCount = meta.filter((m) => looksLikeNumber(m?.value))
      .length;
    const conceptHint =
      typeof scene.visual_concept === "string" &&
      CHART_KEYWORDS_RX.test(scene.visual_concept);
    if (numericMetaCount >= 2 || conceptHint) {
      flagged.push(
        `${scene.label || `scene_${flagged.length}`}: ${numericMetaCount >= 2 ? `${numericMetaCount} numeric meta values` : "chart-friendly concept"}`,
      );
    }
  }
  return flagged;
};

/**
 * Contrast checker — scan the Design Agent's output for adjacent
 * `color:` / `background:` declarations on the same element style
 * block, compute WCAG contrast ratio, return warnings for low-contrast
 * text pairings.
 *
 * Soft signal (doesn't fail Pass 1) surfaced to the user via the
 * review/preview UI. Caveats:
 * - Only catches hex literals; misses palette tokens like `PALETTE.cyan`.
 *   We resolve PALETTE.* references by scanning the const declaration at
 *   the top of the file for `cyan: "#0072ce"` etc.
 * - Treats opacity as a darkening factor (multiplies the foreground's
 *   relative luminance vs the background's).
 * - WCAG body threshold: 4.5:1. Large-text threshold: 3:1.
 */
const HEX_RX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;

const resolveHex = (raw: string): string | null => {
  const m = raw.match(HEX_RX);
  if (!m) return null;
  let hex = m[0].slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex.toLowerCase()}`;
};


/**
 * Build a map of `PALETTE.cyan` → `#0072ce` etc by scanning module-scope
 * object-literal `const PALETTE = { ... }` declarations.
 */
const extractPaletteMap = (code: string): Record<string, string> => {
  const map: Record<string, string> = {};
  const paletteBlock = code.match(/const\s+PALETTE\s*=\s*\{([\s\S]*?)\}\s*;?/);
  if (!paletteBlock) return map;
  const entries = paletteBlock[1].matchAll(
    /(\w+)\s*:\s*["'`]?(#[0-9a-fA-F]{3,6})["'`]?/g,
  );
  for (const e of entries) {
    map[e[1]] = resolveHex(e[2]) ?? e[2];
  }
  return map;
};

interface ContrastFinding {
  fg: string;
  bg: string;
  ratio: number;
  snippet: string;
}

const assessContrast = (code: string): ContrastFinding[] => {
  const findings: ContrastFinding[] = [];
  const palette = extractPaletteMap(code);
  const resolveToken = (raw: string): string | null => {
    const trimmed = raw.trim().replace(/["'`]/g, "");
    const direct = resolveHex(trimmed);
    if (direct) return direct;
    // PALETTE.cyan → palette["cyan"]
    const palMatch = trimmed.match(/PALETTE\.(\w+)/);
    if (palMatch && palette[palMatch[1]]) return palette[palMatch[1]];
    return null;
  };

  // Find every inline `style={{ ... }}` block; within each, locate
  // `color:` and `background:`/`backgroundColor:` declarations.
  const styleBlocks = code.matchAll(/style=\{\{([^{}]*?(?:\{[^{}]*\}[^{}]*?)*)\}\}/g);
  for (const sb of styleBlocks) {
    const block = sb[1];
    const colorMatch = block.match(/\bcolor\s*:\s*([^,}]+)/);
    const bgMatch = block.match(/\b(?:background|backgroundColor)\s*:\s*([^,}]+)/);
    if (!colorMatch || !bgMatch) continue;
    const fg = resolveToken(colorMatch[1]);
    // For background, skip if it's a gradient — we can't reason about
    // gradient backgrounds easily. Only act on solid hex values.
    const bgRaw = bgMatch[1].trim();
    if (/gradient|rgba?\(|url\(/i.test(bgRaw)) continue;
    const bg = resolveToken(bgRaw);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < MIN_CONTRAST_RATIO) {
      const snippet = (sb[0] || "").slice(0, 200).replace(/\s+/g, " ");
      findings.push({ fg, bg, ratio, snippet });
    }
  }
  return findings;
};

const findInventedClaims = (
  designCode: string,
  script: Script,
  briefAbout: string | undefined,
  bodyExcerpts: string[] | undefined,
  verifiedClaims: string | undefined,
): string[] => {
  // Strip strings that are inside JSX expressions and CSS values —
  // we only care about JSX text content the viewer sees on screen.
  // Crude: extract text between `>...<` boundaries.
  const visibleText = Array.from(designCode.matchAll(/>([^<>{}]+)</g))
    .map((m) => m[1].trim())
    .filter((s) => s.length > 0)
    .join(" • ");

  // Build the source corpus: every text the agent is allowed to repeat.
  const sourceCorpus = [
    briefAbout ?? "",
    verifiedClaims ?? "",
    ...(bodyExcerpts ?? []),
    ...script.scenes.flatMap((s) => {
      const c = s.content ?? {};
      const fields: string[] = [];
      if (typeof c.headline === "string") fields.push(c.headline);
      if (typeof c.lede === "string") fields.push(c.lede);
      if (typeof c.eyebrow === "string") fields.push(c.eyebrow);
      if (typeof c.caption === "string") fields.push(c.caption);
      if (Array.isArray(c.bullets)) fields.push(...(c.bullets as string[]));
      if (Array.isArray(c.meta)) {
        for (const m of c.meta as { label?: string; value?: string }[]) {
          if (m?.label) fields.push(m.label);
          if (m?.value) fields.push(m.value);
        }
      }
      if (c.cta && typeof c.cta === "object") {
        const cta = c.cta as { primary?: string; secondary?: string };
        if (cta.primary) fields.push(cta.primary);
        if (cta.secondary) fields.push(cta.secondary);
      }
      return fields;
    }),
  ]
    .join(" • ")
    .toLowerCase();

  const suspicious: string[] = [];
  const seenInSource = (token: string): boolean => {
    // Loose match: normalize whitespace + lowercase.
    const norm = token.toLowerCase().replace(/\s+/g, " ");
    if (sourceCorpus.includes(norm)) return true;
    // Strip currency suffix variations ($1M ↔ $1 million).
    const stripped = norm.replace(/\s*(million|billion)/g, "");
    if (sourceCorpus.includes(stripped)) return true;
    // Strip the dollar sign.
    if (sourceCorpus.includes(norm.replace(/\$/g, ""))) return true;
    return false;
  };

  for (const match of visibleText.matchAll(NUMERIC_CLAIM_RX)) {
    const token = match[0].trim();
    // Skip obviously decorative tokens.
    if (/[•·\.]{3,}/.test(token)) continue;
    if (/Loan #|Order #|Member #|Account #|Ticket #/i.test(token)) continue;
    if (!seenInSource(token)) {
      // Dedupe.
      if (!suspicious.includes(token)) suspicious.push(token);
    }
  }
  return suspicious;
};

/**
 * Section duration in seconds. Reads start_seconds/end_seconds first;
 * falls back to start_frame/end_frame / 30 for any legacy scripts on
 * disk that predate the migration.
 */
const sceneDurationSeconds = (s: Script["scenes"][number]): number => {
  if (typeof s.start_seconds === "number" && typeof s.end_seconds === "number") {
    return s.end_seconds - s.start_seconds;
  }
  if (typeof s.start_frame === "number" && typeof s.end_frame === "number") {
    return (s.end_frame - s.start_frame) / 30;
  }
  return 0;
};
