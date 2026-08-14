/**
 * Icon generation — the two-step pipeline (founder, 2026-08-14): a diffusion
 * image steered hard toward "one flat mark on a plain field", then
 * background removal into a transparent PNG the canvas can place anywhere.
 *
 * Model: SSD-1B (see ICON_MODEL in image-provider — fastest of the callable
 * four, cleanest isolated marks on the 2026-08-14 side-by-side). Icons are
 * always generated SQUARE at the model's native 1024: a mark is roughly
 * square whatever box it lands in, and the caller places it objectFit:
 * "contain" — generating wide/tall just buys more background to remove.
 *
 * The style scaffold wraps the user's words rather than replacing them: the
 * user says WHAT ("a rocket", "a shield with a checkmark"), the scaffold
 * pins HOW (flat, minimal, centered, plain field) — the same division the
 * probe used to get clean marks out of all three candidates.
 */
import { imageCall, ICON_MODEL } from "../llm/image-provider";
import { removeBackground } from "./remove-background";

export const iconPrompt = (subject: string): string =>
  `a single flat icon of ${subject.trim()}, minimal vector style, bold simple shapes, centered, isolated on a plain pure white background, nothing else in frame`;

export const ICON_NEGATIVE_PROMPT =
  "background scenery, frame, border, circle backdrop, gradient background, shadow, texture, photo, 3d render, text, watermark";

export interface GeneratedIcon {
  /** Transparent, content-trimmed PNG. */
  png: Buffer;
  model: string;
  /** Share of pixels the removal claimed — logged as a quality signal. */
  removedRatio: number;
}

export const generateIconPng = async (
  subject: string,
  opts?: { signal?: AbortSignal },
): Promise<GeneratedIcon> => {
  const img = await imageCall({
    prompt: iconPrompt(subject),
    negativePrompt: ICON_NEGATIVE_PROMPT,
    cfgScale: 8,
    width: 1024,
    height: 1024,
    model: ICON_MODEL(),
    stage: "generate-icon",
    signal: opts?.signal,
  });
  const { png, removedRatio } = await removeBackground(img.png);
  return { png, model: img.model, removedRatio };
};
