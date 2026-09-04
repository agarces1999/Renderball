/**
 * Design-language card (RB_DESIGN_CARD; 10x program, 2026-09-04; default OFF).
 *
 * The author designs "on-brand" from a palette and font names. The crawl
 * already captures a screenshot of the brand's homepage, and a vision read of
 * it says what hex codes cannot — the Anthropic probe (same day) returned:
 * "pill corners only on CTAs, sharp elsewhere; heavy sans display over a
 * refined serif body; color as flat full-bleed bands; no shadows or
 * gradients; abstract cloud-like imagery in wide bands; never neon accents".
 * That card goes into the pack as retrieval — the author keeps every styling
 * decision (feed, never substitute).
 *
 * Read ONCE per screenshot URL and cached on disk (.data/design-cards); a
 * miss costs one Kimi vision call (~25-50s, ~$0.01) on a brand's first build.
 * Anything that fails yields no card — the build proceeds exactly as today.
 */
import crypto from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import { callZaiVision } from "../render/zai-vision";

export const designCardEnabled = (): boolean => (process.env.RB_DESIGN_CARD ?? "off") === "on";

const CARD_PROMPT = `This is a screenshot of a brand's homepage. Write a DESIGN-LANGUAGE CARD for a designer who must make presentation slides that feel unmistakably like this brand, but cannot see the site. 8-12 terse lines, each "Key: observation", covering: overall mood; density and whitespace; corner radii (sharp / soft / pill); type character (display weight, case, tracking, size contrast between headline and body); how the accent color is actually used (where it appears, how much); surface treatment (flat / gradients / glass / shadows / borders); imagery style (photography / 3D / illustration / abstract / product UI / none) and how much of the page it occupies; iconography style; motion or texture cues; one line on what NOT to do. Facts only, no praise, no preamble.`;

const cacheDir = (): string => path.join(process.cwd(), ".data", "design-cards");
const cachePath = (url: string): string => path.join(cacheDir(), `${crypto.createHash("sha1").update(url).digest("hex").slice(0, 16)}.txt`);

/** A card that reads as a card: several "Key: value" lines, nothing huge. */
const plausible = (text: string): boolean => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const keyed = lines.filter((l) => /^[A-Za-z][A-Za-z /&-]{1,30}:\s+\S/.test(l));
  return keyed.length >= 5 && text.length <= 3000;
};

export const readDesignCard = async (
  screenshotUrl: unknown,
  mark?: (line: string) => void,
): Promise<string | null> => {
  if (!designCardEnabled()) return null;
  if (typeof screenshotUrl !== "string" || !/^https?:\/\//.test(screenshotUrl)) {
    mark?.("skipped (no homepage screenshot in the crawl)");
    return null;
  }
  const file = cachePath(screenshotUrl);
  try {
    const cached = await fsp.readFile(file, "utf8");
    if (plausible(cached)) {
      mark?.("cached");
      return cached.trim();
    }
  } catch {
    /* miss */
  }
  const t0 = Date.now();
  try {
    const r = await callZaiVision(screenshotUrl, CARD_PROMPT, { timeoutMs: 120_000, maxTokens: 5000, stage: "design-card" });
    const text = (r.text ?? "").trim();
    if (!plausible(text)) {
      mark?.(`unusable reply (${text.length} chars) — no card`);
      return null;
    }
    await fsp.mkdir(cacheDir(), { recursive: true }).catch(() => {});
    await fsp.writeFile(file, text, "utf8").catch(() => {});
    mark?.(`read in ${((Date.now() - t0) / 1000).toFixed(0)}s (${text.split("\n").length} lines)`);
    return text;
  } catch (err) {
    mark?.(`failed (${String(err).slice(0, 80)}) — no card`);
    return null;
  }
};
