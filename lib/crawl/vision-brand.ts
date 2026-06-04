/**
 * Vision-based brand palette extraction.
 *
 * Why: CSS-frequency palette extraction picks up a site builder's DEFAULT
 * template colors (Webflow ships a big default stylesheet whose link-blue
 * #3898ec / grays out-count the brand's real colors). For fusefinance.com the
 * crawl returned Webflow blue when the brand is actually deep maroon + orange.
 *
 * A vision pass reads the brand's ACTUAL colors off its hero/share image —
 * what renders, not what's in the polluted CSS. Uses the cheap vision-capable
 * model (Haiku). Best-effort: returns [] on any failure so the caller keeps
 * the CSS palette.
 */

import { getAnthropic, MODELS } from "../anthropic";

const HEX_RX = /#[0-9a-fA-F]{6}\b/g;

const isVisionSafe = (u?: string): u is string =>
  typeof u === "string" &&
  /^https:\/\//i.test(u) &&
  /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(u);

/**
 * Read a brand's real color palette (hex) off its hero/share image.
 * Returns 0 colors on any failure (caller falls back to the CSS palette).
 */
export const extractPaletteFromImage = async (
  imageUrl: string | undefined,
  opts: { client?: ReturnType<typeof getAnthropic>; model?: string } = {},
): Promise<string[]> => {
  if (!isVisionSafe(imageUrl)) return [];
  try {
    const client = opts.client ?? getAnthropic();
    const resp = await client.messages.create({
      model: opts.model ?? MODELS.qaAgent, // Haiku — vision-capable, cheap
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { type: "image", source: { type: "url", url: imageUrl } } as any,
            {
              type: "text",
              text:
                "This is a brand's website hero / share image. Extract the brand's ACTUAL color palette as hex codes: the dominant background, the main text color, the signature accent, and 1-2 supporting colors. Order by importance (the dominant brand/background color first, the accent second). Ignore photographic colors (skin, sky) — focus on the brand's deliberate UI colors. Return ONLY a JSON array of 4-6 lowercase hex strings, e.g. [\"#4a0e0e\",\"#ff6a2b\",\"#ffffff\"]. No prose.",
            },
          ],
        },
      ],
    });
    const text = resp.content.find((c) => c.type === "text");
    if (!text || text.type !== "text") return [];
    const hexes = (text.text.match(HEX_RX) || []).map((h) => h.toLowerCase());
    // dedupe, preserve order, cap
    return [...new Set(hexes)].slice(0, 6);
  } catch {
    return []; // best-effort — keep the CSS palette on any failure
  }
};
