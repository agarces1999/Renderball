/**
 * Design-language analysis (crawl) — capture a real homepage screenshot and read
 * the brand's QUALITATIVE / COMPOSITIONAL design language off it.
 *
 * Deliberately NON-overlapping with the rest of the crawl:
 *   - palette (colors)          → extractPalette / vision-brand  (we have it)
 *   - fonts (@font-face names)  → extractFonts / classifyFontRoles (we have it)
 *   - motion (CSS keyframes)    → classifyMotion                 (we have it)
 * This pass adds the layer none of those capture: type TREATMENT (scale
 * contrast, weight, case — not family names), layout/composition patterns,
 * density/whitespace, shape language (corners/borders/elevation), imagery
 * style, and overall mood. The vision prompt is explicitly told NOT to restate
 * colors or font names so it never duplicates the existing signals.
 *
 * Image source: a microlink.io screenshot of the LIVE homepage (the og:image we
 * already crawl is usually an unrepresentative share card). Both steps are
 * best-effort and degrade gracefully — a failed screenshot falls back to the
 * og:image, and a failed analysis just returns undefined (the crawl never fails
 * on this).
 */
import { VISION_MODEL } from "../anthropic";
import { callZaiVision } from "../render/zai-vision";
import { type Usage } from "../usage";
import type { DesignLanguage } from "../../app/new/schema";

export type { DesignLanguage };

const isVisionSafe = (u?: string): u is string =>
  !!u && /^https?:\/\//i.test(u) && /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(u);

/**
 * Screenshot the live homepage via microlink.io (no dependency — a plain HTTPS
 * call). Returns a hosted PNG URL (vision-safe), or null on any failure so the
 * caller falls back to the og:image. `fetchImpl` is injectable for tests.
 */
export const captureSiteScreenshot = async (
  url: string | undefined,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> => {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const api =
    "https://api.microlink.io/?url=" +
    encodeURIComponent(url) +
    "&screenshot=true&meta=false&viewport.width=1440&viewport.height=900&waitUntil=networkidle2";
  try {
    const res = await doFetch(api, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      data?: { screenshot?: { url?: string } };
    };
    const shot = json?.data?.screenshot?.url;
    return json?.status === "success" && shot && /^https?:\/\//i.test(shot)
      ? shot
      : null;
  } catch {
    return null;
  }
};

const ANALYZE_PROMPT =
  "You are a brand design analyst. This is a screenshot of a brand's website. " +
  "Describe its DESIGN LANGUAGE — the compositional + stylistic feel, so another " +
  "designer could make new on-brand layouts. Return ONLY JSON (no prose) with EXACTLY " +
  "these keys, each a SHORT phrase:\n" +
  '{"ethos":"one line — the brand\'s design personality",' +
  '"typography":"type TREATMENT: scale contrast, weight range, case, tracking",' +
  '"layout":"composition patterns + density: centered/split/grid/editorial, tight vs airy",' +
  '"shape":"corner radius, borders, elevation/shadows, dividers",' +
  '"imagery":"photography vs illustration vs flat; any treatment",' +
  '"mood":["3-5","adjectives"]}\n' +
  "Do NOT mention specific colors/hex codes or font family NAMES — those are captured separately. " +
  "Focus on how the brand COMPOSES a page (hierarchy, spacing, shapes, imagery, tone).";

/**
 * Vision pass: read the structured DesignLanguage off a brand image (the
 * homepage screenshot, or the og:image as a fallback). Returns null on any
 * failure (no key, bad image, parse error) — advisory, never fatal.
 * `opts.onUsage` (when given) receives the resolved model + token usage of the
 * vision call so the crawl's cost lands in the usage log — fired per API call,
 * never when the image is skipped or the call fails.
 */
export const analyzeDesignLanguage = async (
  imageUrl: string | undefined,
  opts: {
    // The vision call, injected for tests. Default: native GLM-5V-Turbo. The old
    // Anthropic-compat SDK path silently DROPPED the image → the model analyzed
    // nothing (blind), so the design language was guessed, not seen. thinking is
    // disabled: on a terse extraction task the model otherwise burns the whole
    // token budget reasoning and returns empty content.
    visionCall?: (
      image: string,
      prompt: string,
    ) => Promise<{ text: string; usage: Usage }>;
    onUsage?: (model: string, usage: Usage) => void;
  } = {},
): Promise<DesignLanguage | null> => {
  if (!isVisionSafe(imageUrl)) return null;
  try {
    const visionCall =
      opts.visionCall ??
      ((image, prompt) =>
        callZaiVision(image, prompt, { disableThinking: true, maxTokens: 500, stage: "crawl" }));
    const { text, usage } = await visionCall(imageUrl, ANALYZE_PROMPT);
    opts.onUsage?.(VISION_MODEL, usage);
    if (!text) return null;
    return parseDesignLanguage(text);
  } catch {
    return null;
  }
};

/**
 * Render the design language as a compact prompt block — shared by the script +
 * design agents so they read the SAME direction. Returns "" when empty.
 */
export const formatDesignLanguage = (
  dl: DesignLanguage | undefined,
  indent = "    ",
): string => {
  if (!dl) return "";
  const rows: Array<[string, string]> = [
    ["Design ethos", dl.ethos],
    ["Type treatment", dl.typography],
    ["Layout / composition", dl.layout],
    ["Shape language", dl.shape],
    ["Imagery style", dl.imagery],
    ["Mood", (dl.mood ?? []).join(", ")],
  ];
  return rows
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${indent}${k}: ${v}`)
    .join("\n");
};

/** Robustly parse the model's JSON (tolerates code fences / surrounding prose). */
export const parseDesignLanguage = (raw: string): DesignLanguage | null => {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const str = (v: unknown): string =>
    typeof v === "string" ? v.trim().slice(0, 240) : "";
  const ethos = str(obj.ethos);
  const typography = str(obj.typography);
  const layout = str(obj.layout);
  const shape = str(obj.shape);
  const imagery = str(obj.imagery);
  const mood = Array.isArray(obj.mood)
    ? obj.mood.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, 5)
    : [];
  // Require at least the ethos + one substantive dimension to be useful.
  if (!ethos && !typography && !layout) return null;
  return { ethos, typography, layout, shape, imagery, mood };
};

/**
 * One-shot: screenshot the homepage (fallback to og:image) and analyze it.
 * Returns the image URL used + the design language, both possibly null/undefined.
 * Best-effort end-to-end — safe to call unconditionally in the crawl.
 */
export const extractDesignLanguage = async (
  url: string | undefined,
  ogImage: string | undefined,
  opts: {
    fetchImpl?: typeof fetch;
    visionCall?: (
      image: string,
      prompt: string,
    ) => Promise<{ text: string; usage: Usage }>;
    onUsage?: (model: string, usage: Usage) => void;
  } = {},
): Promise<{ site_screenshot?: string; design_language?: DesignLanguage }> => {
  const shot = await captureSiteScreenshot(url, opts);
  const image = shot ?? (isVisionSafe(ogImage) ? ogImage : undefined);
  if (!image) return {};
  const design_language = (await analyzeDesignLanguage(image, opts)) ?? undefined;
  return {
    ...(shot ? { site_screenshot: shot } : {}),
    ...(design_language ? { design_language } : {}),
  };
};
