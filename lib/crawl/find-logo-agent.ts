/**
 * Logo-discovery agent.
 *
 * The old heuristic-only logo discovery picked wrong logos consistently:
 *   - og:image was often a share-card screenshot, not a wordmark
 *   - first <img> in nav was sometimes a customer logo from a marquee
 *   - filename heuristics caught CFSB.png but not lowercase customer logos
 *
 * This agent evaluates ALL candidates with Claude Sonnet (vision) and
 * picks the one that's the brand's primary mark. If none of the
 * candidates are the brand's logo, the agent returns "NONE" and the
 * pipeline falls back to a wizard upload prompt.
 *
 * Candidates come from a wide net: Clearbit Logo API, common static
 * paths (/logo.svg, /logo.png), header/nav <img> tags, simple-icons
 * brand match, apple-touch-icon, favicon, og:image. The agent ALSO
 * has the Anthropic web_search tool available to find additional
 * candidates when the crawled set is weak.
 *
 * Latency: ~10-20s per logo discovery. Acceptable inside the
 * extractBrand call which the wizard already runs in the background
 * while the user types.
 */

import { getAnthropic, MODELS } from "../anthropic";

export interface LogoCandidate {
  url: string;
  source:
    | "clearbit"
    | "static-path"
    | "header-img"
    | "simple-icons"
    | "apple-touch"
    | "favicon"
    | "og-image";
  hint?: string;
}

export type LogoAgentResult =
  | { ok: true; url: string; source: string; rationale: string }
  | { ok: false; reason: string };

const SYSTEM_PROMPT = `You are a brand-logo identification expert.

Given a list of image candidates from a brand's website + meta tags, pick the ONE candidate that IS the brand's primary logo or wordmark — the asset you'd use on a launch video to represent the brand.

REJECT candidates that are:
- A different company's logo (customer marquee, partner grid, "as featured in" social proof)
- A generic share/OG image (full screenshots, hero/product photography, abstract gradients)
- A favicon-only asset when a higher-resolution version is available
- Stock illustrations / generic icons
- Screenshots of UI mockups

PREFER:
- Clearbit's logo (\`logo.clearbit.com/{domain}\`) — almost always correct for known brands
- Same-domain static paths like \`/logo.svg\`, \`/assets/logo.png\` — site authors explicitly put these there
- Wordmark / brand-mark SVGs in the site's <header> or <nav>
- simple-icons brand match when domain matches a popular brand
- apple-touch-icon as last resort (always brand but low-res, 180x180)

If you use the \`web_search\` tool, search for "{brand} logo png svg" or "{brand} brand assets" or "{brand} press kit logo." Prefer URLs from the brand's own domain or well-known press/brand-asset hosts.

OUTPUT (always JSON, never prose):
- If you find a clear winner: \`{"chosen_url": "https://...", "source": "clearbit|static-path|header-img|simple-icons|apple-touch|web-search", "rationale": "one-sentence why this is the brand's mark"}\`
- If NONE of the candidates are the brand's actual logo: \`{"chosen_url": null, "reason": "one-sentence why none qualify (e.g. 'all candidates are customer logos from the trusted-by grid')"}\`

Only the JSON object. No markdown fence, no prose, no commentary.`;

/**
 * Run the logo-discovery agent.
 *
 * Always returns within ~30s. Network failures, API errors, and parsing
 * errors all degrade to \`{ ok: false }\` — the caller falls back to
 * pure-heuristic discovery OR prompts the user to upload.
 */
export const findBrandLogo = async (
  brandHostname: string,
  brandTitle: string | undefined,
  candidates: LogoCandidate[],
): Promise<LogoAgentResult> => {
  if (candidates.length === 0) {
    return { ok: false, reason: "no candidates to evaluate" };
  }

  let client;
  try {
    client = getAnthropic();
  } catch (err) {
    return {
      ok: false,
      reason: `anthropic client init failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build the user message: text-list of candidates + each image as a
  // vision content block. Only URLs that look like images get embedded
  // as vision blocks (some candidates are static-path probes that may
  // 404 — those go in the text list only).
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "url"; url: string } };

  // Anthropic vision supports JPEG/PNG/GIF/WebP only. SVG, ICO, AVIF
  // return `image.source.base64.data: invalid format`. SVGs are common
  // candidates from header <img> + simple-icons (those are SVG strings
  // we encoded as data URLs above) — they go in the text list but not
  // as vision blocks. The model can still pick the URL by reading the
  // numbered text list.
  const isVisionSafeImage = (u: string): boolean =>
    /^data:image\/(jpeg|png|gif|webp);base64,/i.test(u) ||
    /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(u);

  const textIntro = [
    `Brand: ${brandTitle ?? brandHostname} (${brandHostname})`,
    "",
    "Candidates (numbered, then shown as images below):",
    ...candidates.map(
      (c, i) =>
        `  ${i + 1}. [${c.source}] ${c.url}${c.hint ? ` — ${c.hint}` : ""}`,
    ),
    "",
    "Pick the candidate (by URL) that's the brand's primary logo, OR return chosen_url:null with a reason if none qualify.",
  ].join("\n");

  const content: ContentBlock[] = [{ type: "text", text: textIntro }];
  // Cap at 8 vision blocks — Anthropic's per-message vision limit + cost control.
  for (const c of candidates.slice(0, 8)) {
    if (isVisionSafeImage(c.url)) {
      content.push({ type: "image", source: { type: "url", url: c.url } });
    }
  }

  let response;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      model: MODELS.logoAgent,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
      ],
    };
    response = await client.messages.create(params);
  } catch (err) {
    // web_search may not be available on all accounts — retry without tools.
    try {
      response = await client.messages.create({
        model: MODELS.logoAgent,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      });
    } catch (err2) {
      return {
        ok: false,
        reason: `logo agent API error: ${err2 instanceof Error ? err2.message : String(err2)} (initial attempt: ${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  // The model may stream tool_use blocks before the final text. We only
  // care about the LAST text block.
  const textBlock = [...response.content]
    .reverse()
    .find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { ok: false, reason: "agent returned no text content" };
  }

  // Strip any markdown fence the model might've emitted despite instructions.
  const raw = textBlock.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  let parsed: { chosen_url?: string | null; source?: string; rationale?: string; reason?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: `agent output wasn't valid JSON. First 200 chars: ${raw.slice(0, 200)}`,
    };
  }

  if (!parsed.chosen_url) {
    return {
      ok: false,
      reason: parsed.reason ?? "agent chose no candidate (no reason given)",
    };
  }

  // Validate the chosen URL is reachable (HEAD probe). If the agent
  // hallucinated a URL from web_search that 404s, we'd otherwise mount
  // a broken image. 3s timeout to keep latency bounded.
  try {
    const probe = await fetch(parsed.chosen_url, {
      method: "HEAD",
      signal: AbortSignal.timeout(3_000),
      redirect: "follow",
    });
    if (!probe.ok) {
      return {
        ok: false,
        reason: `chosen URL ${parsed.chosen_url} returned ${probe.status}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `chosen URL probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    url: parsed.chosen_url,
    source: parsed.source ?? "unknown",
    rationale: parsed.rationale ?? "",
  };
};
