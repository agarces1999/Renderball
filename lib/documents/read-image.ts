import { VISION_MODEL } from "../anthropic";
import { callZaiVision } from "../render/zai-vision";
import { assertZaiAvailable, noteZaiError, noteZaiSuccess } from "../zai-breaker";
import { type Usage } from "../usage";
import { tidy } from "./extract-text";

/**
 * Read the words off an attached PNG / JPEG / GIF / WebP — a screenshot of an
 * old slide, a photo of a whiteboard, a competitor's one-pager — so they can
 * become part of the brief.
 *
 * THIS IS THE ONLY ATTACHMENT PATH THAT SPENDS ANYTHING. Every sibling reader
 * (extract-text, read-svg, read-xlsx, read-csv) is deterministic and free
 * because the words are already in the bytes. A raster image has no words in
 * it — only pixels — so this one has to ask a model, and everything below is
 * about keeping that call bounded, honest, and impossible to fail rudely.
 *
 * ROUTING (CLAUDE.md, non-negotiable): images go through callZaiVision and
 * nowhere else. The transport that came before it was an Anthropic-compat
 * proxy that silently DROPPED image blocks — the model saw no picture,
 * answered anyway, and the entire vision layer was blind for weeks without a
 * single error. There is one image wire in this repo on purpose.
 */

export type ImageReadResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The vision call, injected so tests never make a live paid one.
 *
 * Shape follows lib/agents/script-generator.ts's `transport` seam and matches
 * the `visionCall` option already used by lib/crawl/vision-brand.ts: given the
 * image and the prompt, return the model's text plus token usage.
 */
export type ImageVisionTransport = (
  image: string,
  prompt: string,
) => Promise<{ text: string; usage: Usage }>;

export interface ReadImageOptions {
  transport?: ImageVisionTransport;
  /** Fired only when a call was actually made, so the spend can be logged. */
  onUsage?: (model: string, usage: Usage) => void;
}

// ── what we can send ────────────────────────────────────────────────────────

/**
 * Fireworks' documented ceiling for a vision request: "Total base64-encoded
 * images must be less than 10MB" (docs.fireworks.ai/guides/querying-vision-
 * language-models, checked 2026-08-07). Note it bounds the ENCODED bytes, not
 * the file on disk — base64 costs a third more — so a 9 MB photo that sails
 * through the route's 10 MB gate arrives here as 12 MB on the wire.
 */
export const VISION_BASE64_LIMIT = 10 * 1024 * 1024;

/**
 * 7 MiB of file → 9,786,712 base64 bytes, which is under the limit whether the
 * provider means 10 * 1024 * 1024 or a round 10,000,000, and leaves ~700 KB of
 * headroom for the prompt and the JSON envelope around it. Pinned by a test, so
 * raising this number without redoing the arithmetic goes red.
 */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

/** Encoded length of n bytes of base64 — 4 characters per 3-byte group. */
export const base64Bytes = (n: number): number => Math.ceil(n / 3) * 4;

/**
 * WHY OVERSIZED IMAGES ARE REFUSED RATHER THAN SHRUNK: shrinking pixels needs a
 * real image codec, and this path is deliberately kept free of native image
 * processing — it runs on whatever bytes a stranger uploads, on the request
 * path, before anything has been paid for. The band where this actually bites
 * is narrow: the attach route already caps uploads at 10 MB
 * (app/api/documents/attach/route.ts), so only 7-10 MB files land here, and the
 * refusal below tells the user exactly what to do about it. If we later decide
 * a downscale is worth the native module, sharp is already a project dependency
 * and lib/render/thumbnail.ts shows the lazy-import shape to copy.
 */
const TOO_BIG =
  "That image is too big to read — images need to be under 7 MB. Resize it or take a smaller screenshot and attach it again, or paste the words into the brief.";

/**
 * Magic numbers, because the extension lies. A .png that is really a PDF, or a
 * screenshot someone renamed, must get a message about what it IS rather than a
 * model call that fails strangely.
 *
 * Deliberately a copy of the four raster rows in lib/uploads.ts's
 * detectUploadMime rather than an import of it: that module reaches into R2/S3
 * and accepts fonts, PDFs and SVGs, none of which can be sent down a vision
 * wire. This list is closed on purpose — the mime it returns is the one written
 * into the data: URL, so a format we cannot name is a format we must not send.
 */
const sniffImageMime = (buf: Buffer): string | null => {
  const at = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);
  if (at(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0x47, 0x49, 0x46, 0x38)) return "image/gif"; // GIF8
  if (
    at(0x52, 0x49, 0x46, 0x46) && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) {
    return "image/webp";
  }
  return null;
};

/** Enough of a peek to recognise the formats that have their own advice. */
const looksLikePdf = (buf: Buffer): boolean =>
  buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

const looksLikeSvg = (buf: Buffer): boolean =>
  /^\s*(?:<\?xml|<svg)/i.test(buf.subarray(0, 200).toString("utf8").replace(/^﻿/, ""));

// ── the prompt ──────────────────────────────────────────────────────────────

/**
 * The output goes straight into the user's brief box, where they read and edit
 * it before anything expensive runs. So it has to be prose a person would
 * actually paste — not JSON, not a description of the design, and above all not
 * a plausible reconstruction. A model that invents a bullet point here writes it
 * into someone's deck three steps later, with nobody left who can tell it was
 * never on the whiteboard.
 *
 * The NO TEXT sentinel exists because "I can't see any text" and "" and a
 * paragraph apologising are three different answers to the same situation, and
 * only one of them is easy to detect.
 */
export const IMAGE_READ_PROMPT = [
  "Read this image and write out everything a person can actually read in it, as plain prose they could paste into a document brief.",
  "Include every heading, sub-heading, body sentence, label, caption and number, in the order they appear on the page, with the wording exactly as written.",
  "If the image contains a chart, diagram, table or screenshot, add ONE line saying what it shows, after that region's text.",
  "Write ONLY what is visible. Do not guess at words that are cut off, blurred or too small to read. Do not describe colours, fonts or layout. Do not add commentary or headings of your own. Do not invent anything that is not in the image.",
  "If there is no readable text anywhere in the image, reply with exactly: NO TEXT",
  "Reply with the text itself — no JSON, no markdown, no preamble.",
].join("\n");

/**
 * Kimi K2.6 is a thinking model, and this is a terse extraction task — exactly
 * the shape that burns the whole budget reasoning and returns empty content
 * (measured on the probe in CLAUDE.md: 294 thinking tokens vs 46 with it off).
 * disableThinking is zai-vision's existing mechanism for that; there is not a
 * second one and there must not be.
 */
const MAX_OUTPUT_TOKENS = 1500; // ~1100 words — more text than fits on a slide

/**
 * Shorter than zai-vision's 60s default: a person is sitting in front of the
 * brief box watching a spinner. A minute of nothing is worse than a sentence at
 * 45s telling them to paste the text in.
 */
const READ_TIMEOUT_MS = 45_000;

// ── refusals, all of which name a way forward ───────────────────────────────

const NOT_AN_IMAGE =
  "That file isn't an image we can read. Attach a PNG, JPEG, GIF or WebP — or paste the words into the brief.";

const IS_PDF =
  "That's a PDF, not an image. Open it, copy the text and paste it into the brief — or screenshot the page you want and attach the screenshot.";

const IS_SVG =
  "That's an SVG. Attach it with the .svg name and we'll read the words straight out of it, no picture needed.";

/**
 * The breaker's own ZaiUnavailableError.friendly is not reused here: it still
 * says "Video generation is temporarily unavailable", which is pre-pivot
 * wording (CLAUDE.md, 2026-07-23) and reads as nonsense next to a deck brief.
 * The half of it worth keeping is the reassurance that nothing was charged.
 */
const PROVIDER_DOWN =
  "We can't read images at the moment — the service that does it is having trouble. Nothing was charged. Paste the words into the brief, or attach the image again in a few minutes.";

const READ_FAILED =
  "That image couldn't be read — the attempt timed out or came back empty. Nothing was charged. Try attaching it again, or paste the words into the brief.";

const NO_WORDS =
  "There are no readable words in that image — it may be a photo, a logo, or too blurry to read. Paste the words into the brief, or attach a sharper screenshot.";

/** The model's way of saying the picture has no words in it. */
const isNoTextSentinel = (text: string): boolean =>
  text.replace(/[^a-z ]/gi, " ").replace(/\s+/g, " ").trim().toUpperCase() === "NO TEXT";

/**
 * Read the readable content of an attached image.
 *
 * Never throws and never surfaces a raw provider error: every failure is a
 * sentence a person can act on. The only outcomes are text worth pasting into
 * a brief, or an explanation with a route forward.
 *
 * @param filename is NOT trusted to say what the file is — the format comes
 * from the magic bytes above. It is accepted so this reader has the same shape
 * as extractText(buf, filename) at the router, and is otherwise unused: it is
 * attacker-controlled, and refusal text is shown back to the user.
 */
export const readImage = async (
  buf: Buffer,
  filename: string,
  opts: ReadImageOptions = {},
): Promise<ImageReadResult> => {
  void filename;

  const mime = sniffImageMime(buf);
  if (!mime) {
    if (looksLikePdf(buf)) return { ok: false, reason: IS_PDF };
    if (looksLikeSvg(buf)) return { ok: false, reason: IS_SVG };
    return { ok: false, reason: NOT_AN_IMAGE };
  }

  // Size BEFORE the call, always: an oversized image that fails at the provider
  // has already cost the upload, the wait, and — depending on where it fails —
  // the input tokens.
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: TOO_BIG };

  // Gate the spend on the breaker, which exists because a dry provider account
  // has taken all generation down twice (lib/zai-breaker.ts). The sibling vision
  // callers skip this — they are best-effort background reads inside a build
  // that has already checked. This one is a user-initiated spend entrypoint,
  // which is precisely what the breaker's contract says to gate.
  try {
    assertZaiAvailable();
  } catch {
    return { ok: false, reason: PROVIDER_DOWN };
  }

  // The data: URL is built HERE, with the sniffed mime, rather than handing
  // callZaiVision raw base64: that helper labels bare base64 as image/png
  // unconditionally (zai-vision.ts), so a JPEG or WebP would go out claiming to
  // be a PNG. It passes a full data:/http(s) URL through untouched, which is the
  // documented way to send bytes and the only way to name them correctly.
  const image = `data:${mime};base64,${buf.toString("base64")}`;

  const transport: ImageVisionTransport =
    opts.transport ??
    ((img, prompt) =>
      callZaiVision(img, prompt, {
        disableThinking: true,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: READ_TIMEOUT_MS,
      }));

  let raw: string;
  try {
    const result = await transport(image, IMAGE_READ_PROMPT);
    noteZaiSuccess(); // closes a half-open breaker when this call was its probe
    opts.onUsage?.(VISION_MODEL, result.usage);
    raw = result.text ?? "";
  } catch (err) {
    // An account-dry error trips the circuit for everyone, so the next person
    // fails fast and free instead of waiting 45s for the same answer.
    return { ok: false, reason: noteZaiError(err) ? PROVIDER_DOWN : READ_FAILED };
  }

  const text = tidy(raw);
  // No length clamp: MAX_OUTPUT_TOKENS is the real bound, and it caps this an
  // order of magnitude below MAX_EXTRACTED_CHARS. A clamp here would be a branch
  // that can never run.
  if (!text || isNoTextSentinel(text)) return { ok: false, reason: NO_WORDS };

  return { ok: true, text };
};
