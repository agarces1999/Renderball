/**
 * Logo-discovery agent — persistent, "no empty hands".
 *
 * The brand's real mark is found by inspecting ON-PAGE candidates with native
 * vision (GLM-5V-Turbo) in a single multi-image pick. It is mandated NOT to
 * return a fabricated mark, a screenshot, or a customer logo — a real logo, or
 * nothing (→ the resolver renders a clean wordmark, never an invented mark).
 *
 * Candidates come from a wide net (inline <svg>, CSS background, header <img>,
 * static /logo.* paths, Clearbit, simple-icons, apple-touch, og, favicon). Two
 * upgrades over the old one-shot pick:
 *   - SVG candidates are RASTERIZED to PNG (vision rejects raw SVG), so the
 *     agent actually SEES the inline nav mark — the Fuse miss.
 *   - Each previewed candidate is decoded (sharp) for dimensions; large ~square
 *     images are flagged as likely screenshots/share-cards so the agent doesn't
 *     mistake the homepage screenshot for the logo.
 *
 * Transport: the old Anthropic-compat SDK path silently DROPPED image blocks →
 * the agent was BLIND and picked by text/source heuristics only. All candidate
 * previews now go through the NATIVE GLM-5V-Turbo endpoint (callZaiVision, which
 * accepts an ARRAY of base64 PNGs for one multi-image pick) so the model truly
 * SEES every candidate. No web search (z.ai has none) — the deterministic floor
 * below handles the no-pick case.
 *
 * Latency: ~10-25s (one vision call). Runs inside extractBrand which the wizard
 * fires in the background while the user types.
 */

import { VISION_MODEL } from "../anthropic";
import { type Usage } from "../usage";
import { callZaiVision } from "../render/zai-vision";
import { safeFetch } from "./ssrf-guard";

export interface LogoCandidate {
  url: string;
  source:
    | "inline-svg"
    | "css-bg"
    | "clearbit"
    | "static-path"
    | "header-img"
    | "simple-icons"
    | "apple-touch"
    | "favicon"
    | "og-image"
    | "web-search";
  hint?: string;
}

export type LogoAgentResult =
  | { ok: true; url: string; source: string; confidence: number; rationale: string }
  | { ok: false; reason: string };

// Source → base confidence prior. The brand's own on-page files rank highest;
// generic share/icon assets rank low. Vision + dimensions nudge from here.
const SOURCE_PRIOR: Record<LogoCandidate["source"], number> = {
  "inline-svg": 0.9,
  "static-path": 0.85,
  "simple-icons": 0.8,
  "header-img": 0.78,
  "css-bg": 0.72,
  "web-search": 0.7,
  clearbit: 0.68,
  "apple-touch": 0.5,
  favicon: 0.32,
  "og-image": 0.25,
};

const SYSTEM_PROMPT = `You are a brand-logo identification expert.

Given image candidates from a brand's website + meta tags, pick the ONE candidate that IS the brand's primary logo or wordmark — the asset you'd put on a launch video to represent the brand. If none qualify, return null.

HARD REJECTS — never return any of these as the logo:
- A screenshot of the website / a hero or product photo / a UI mockup — EVEN IF it shows the brand name. A logo is a compact mark or wordmark, not a picture of the page. Candidates flagged "LARGE, likely a screenshot" are almost never the logo.
- A different company's logo (customer marquee, partner grid, "as featured in").
- A generic share/OG card or an abstract gradient.
- A favicon when a higher-resolution mark is available.

PREFER (in this order):
- An inline <svg> mark from the site's <header>/<nav> (the brand's own rendered logo). Between a WIDE wordmark and a tiny square icon, choose the wordmark — a small square is usually an app-icon/favicon, not the primary logo (the dimension note on each candidate tells you which is which).
- A same-origin static file: /logo.svg, /assets/logo.png, a header <img> whose path says "logo".
- A simple-icons brand match, or Clearbit's logo, for well-known brands.
- apple-touch-icon ONLY as a low-res last resort (and never if it's actually a screenshot).

The candidates are numbered (1-based) and their previews are shown in the SAME order. If none of the on-page candidates is the brand's clean mark, return null — do not invent or fabricate a logo.

OUTPUT (always JSON, never prose):
- To pick a candidate: {"chosen_index": <the candidate's 1-based NUMBER from the list>, "rationale":"one sentence"}. Use the index number — NEVER paste a long data: URL back (it will be truncated).
- If none qualify: {"chosen_index": null, "reason":"one sentence"}
Only the JSON object. No markdown fence, no commentary.`;

const RASTER_RX = /\.(jpe?g|png|gif|webp)(\?|#|$)/i;

interface PreparedCandidate {
  cand: LogoCandidate;
  visionPng?: string; // base64 PNG, vision-safe (SVG rasterized, raster re-encoded)
  width?: number;
  height?: number;
  note: string; // dimension/shape annotation for the text list
}

/**
 * Fetch/rasterize a candidate to a vision-safe PNG + read its dimensions.
 * Best-effort: returns a text-only PreparedCandidate when sharp/fetch fails so
 * the candidate still appears in the list (the agent can pick it by URL).
 */
const prepareCandidate = async (
  cand: LogoCandidate,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharp: any,
  userAgent: string,
): Promise<PreparedCandidate> => {
  try {
    const isSvg =
      cand.url.startsWith("data:image/svg") ||
      /\.svg(\?|#|$)/i.test(cand.url) ||
      cand.source === "inline-svg";
    let raw: Buffer | null = null;

    if (cand.url.startsWith("data:")) {
      raw = Buffer.from(cand.url.split(",")[1] ?? "", "base64");
    } else if (isSvg || RASTER_RX.test(cand.url)) {
      const r = await safeFetch(cand.url, {
        signal: AbortSignal.timeout(4500),
        headers: { "User-Agent": userAgent },
        redirect: "follow",
      });
      if (!r.ok) return { cand, note: "unreachable" };
      raw = Buffer.from(await r.arrayBuffer());
    } else {
      return { cand, note: "no preview (non-image URL)" };
    }
    if (!sharp || !raw) return { cand, note: "no preview" };

    // Read true dimensions from the original bytes.
    const pipeline = isSvg ? sharp(raw, { density: 200 }) : sharp(raw);
    const meta = await pipeline.metadata().catch(() => null);
    const width = meta?.width;
    const height = meta?.height;
    // Make the vision preview legible: marks frequently use fill="currentColor"
    // (renders BLACK on transparent → invisible to the model, which then waffles
    // and returns null). Force a dark fill and flatten onto white so the agent
    // reliably SEES the mark. (Affects only the preview the agent reviews, not
    // the stored logo_hd.)
    const rasterBytes =
      isSvg && raw
        ? Buffer.from(raw.toString("utf8").replace(/currentColor/gi, "#111827"))
        : raw;
    const visionBuf = await sharp(rasterBytes, isSvg ? { density: 200 } : {})
      .flatten({ background: "#ffffff" })
      .resize(384, 384, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    let note = width && height ? `${width}x${height}px` : "unknown size";
    if (width && height) {
      const aspect = width / height;
      if (width >= 900 && height >= 600 && aspect > 0.55 && aspect < 2.2) {
        note += " — LARGE, likely a screenshot/share-card, NOT a logo";
      } else if (aspect >= 1.4) {
        note += " — wide, logo/wordmark-shaped";
      } else if (Math.abs(aspect - 1) < 0.2 && Math.max(width, height) <= 256) {
        note += " — small square (icon/favicon)";
      }
    }
    return { cand, visionPng: visionBuf.toString("base64"), width, height, note };
  } catch {
    return { cand, note: "decode failed" };
  }
};

// Confidence from the (real) source of the chosen URL + its decoded shape.
const scoreConfidence = (
  source: LogoCandidate["source"],
  prepared: PreparedCandidate | undefined,
): number => {
  let c = SOURCE_PRIOR[source] ?? 0.6;
  if (prepared?.width && prepared.height) {
    const aspect = prepared.width / prepared.height;
    if (aspect >= 1.4) c += 0.05; // logo-shaped
    if (
      prepared.width >= 900 &&
      prepared.height >= 600 &&
      aspect > 0.55 &&
      aspect < 2.2
    ) {
      c -= 0.4; // screenshot-shaped — the agent shouldn't have picked it
    }
  }
  return Math.max(0, Math.min(1, Math.round(c * 100) / 100));
};

/**
 * Run the logo-discovery agent. Always returns within ~30s. Network/API/parse
 * failures degrade to { ok:false } → caller renders a clean wordmark.
 * `opts.visionCall` is injected for tests; the default sends every candidate
 * preview as ONE multi-image pick to the native GLM-5V-Turbo endpoint (the old
 * Anthropic-compat SDK path silently DROPPED the images → the agent was blind).
 * `opts.onUsage` (when given) receives the vision model + token usage of the
 * single completed call.
 */
export const findBrandLogo = async (
  brandHostname: string,
  brandTitle: string | undefined,
  candidates: LogoCandidate[],
  opts: {
    visionCall?: (
      images: string[],
      prompt: string,
    ) => Promise<{ text: string; usage: Usage }>;
    onUsage?: (model: string, usage: Usage) => void;
  } = {},
): Promise<LogoAgentResult> => {
  if (candidates.length === 0) {
    return { ok: false, reason: "no candidates to evaluate" };
  }

  const visionCall =
    opts.visionCall ??
    ((images, prompt) =>
      callZaiVision(images, prompt, { disableThinking: true, maxTokens: 1024, stage: "crawl" }));

  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharp = await import("sharp").then((m) => m.default).catch(() => null);

  // Prepare up to 8 candidates as vision-safe PNGs (rasterize SVGs, decode dims).
  const prepared = await Promise.all(
    candidates.slice(0, 8).map((c) => prepareCandidate(c, sharp, userAgent)),
  );
  const byUrl = new Map(prepared.map((p) => [p.cand.url, p]));

  // The base64 PNG previews, in candidate order, for ONE multi-image pick. The
  // native endpoint shows these in the same order as the numbered text list, so
  // a chosen_index maps cleanly back to candidates[] on our side.
  const images = prepared
    .filter((p) => p.visionPng)
    .map((p) => p.visionPng as string);

  const textIntro = [
    `Brand: ${brandTitle ?? brandHostname} (${brandHostname})`,
    "",
    "Candidates (numbered; previews are attached in this order where available):",
    ...candidates.map((c, i) => {
      const p = byUrl.get(c.url);
      const note = p?.note ? ` [${p.note}]` : "";
      const shown = p?.visionPng ? "" : " (no preview — judge by source/URL)";
      return `  ${i + 1}. [${c.source}] ${c.url.slice(0, 120)}${note}${c.hint ? ` — ${c.hint}` : ""}${shown}`;
    }),
    "",
    'Pick the brand\'s primary logo by index. If none qualify, return {"chosen_index": null, "reason": "..."}.',
  ].join("\n");

  // callZaiVision can't take a separate system message, so prepend SYSTEM_PROMPT.
  const prompt = SYSTEM_PROMPT + "\n\n" + textIntro;

  const parse = (
    text: string,
  ): {
    chosen_index?: number;
    chosen_url?: string | null;
    source?: string;
    rationale?: string;
    reason?: string;
  } | null => {
    const rawTxt = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return JSON.parse(rawTxt);
    } catch {
      return null;
    }
  };

  // Resolve a parsed result to a concrete pick. A chosen_index maps to the FULL
  // candidate URL on our side — the agent never echoes a long data: URL (it
  // would truncate it, the bug this fixes). chosen_url is kept as a harmless
  // fallback for older response shapes; the prompt now only asks for an index.
  type Chosen = { url: string; source?: string; rationale?: string };
  const resolveChosen = (
    p: { chosen_index?: number; chosen_url?: string | null; source?: string; rationale?: string } | null,
  ): Chosen | null => {
    if (!p) return null;
    if (typeof p.chosen_index === "number") {
      const i = p.chosen_index - 1;
      if (i >= 0 && i < candidates.length) {
        return { url: candidates[i].url, source: candidates[i].source, rationale: p.rationale };
      }
    }
    if (typeof p.chosen_url === "string" && p.chosen_url) {
      return { url: p.chosen_url, source: p.source, rationale: p.rationale };
    }
    return null;
  };

  let parsed: {
    chosen_index?: number;
    chosen_url?: string | null;
    source?: string;
    rationale?: string;
    reason?: string;
  } | null;
  try {
    const { text, usage } = await visionCall(images, prompt);
    opts.onUsage?.(VISION_MODEL, usage);
    parsed = parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: `logo agent vision error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const chosen = resolveChosen(parsed);

  // Deterministic floor — "no empty hands". The vision agent is nondeterministic
  // and sometimes returns null even when the page has a clear brand mark (a
  // currentColor inline-svg renders faintly in the preview). Rather than lose it,
  // fall back to the strongest on-page candidate: an inline-svg (already filtered
  // to logo-shaped, in the brand's own nav) > a deliberate /logo.* static file >
  // a header img. These are the brand's own files, so they're safe without the
  // agent's screenshot-rejection. Only when NONE of those exist do we give up
  // (→ the resolver renders a clean wordmark, never a fabricated mark).
  if (!chosen) {
    // Among inline-svg candidates prefer the LARGEST decoded mark — a wordmark
    // is wider/bigger than a tiny nav icon that happened to score well.
    const widestInlineSvg = candidates
      .filter((c) => c.source === "inline-svg")
      .map((c) => ({ c, w: byUrl.get(c.url)?.width ?? 0 }))
      .sort((a, b) => b.w - a.w)[0]?.c;
    const floor =
      widestInlineSvg ??
      candidates.find((c) => c.source === "static-path") ??
      candidates.find((c) => c.source === "header-img");
    if (floor) {
      return {
        ok: true,
        url: floor.url,
        source: floor.source,
        confidence: Math.min(0.75, SOURCE_PRIOR[floor.source] ?? 0.7),
        rationale: "deterministic floor: strong on-page candidate (agent returned no pick)",
      };
    }
    return {
      ok: false,
      reason: parsed?.reason ?? "no candidate or web result qualified",
    };
  }

  // Validate the chosen URL is reachable (HEAD). Kills hallucinated web URLs.
  // data: URLs (inline-svg candidates) are self-contained — skip the probe.
  if (!chosen.url.startsWith("data:")) {
    try {
      const probe = await safeFetch(chosen.url, {
        method: "HEAD",
        signal: AbortSignal.timeout(3500),
        headers: { "User-Agent": userAgent },
        redirect: "follow",
      });
      if (!probe.ok) {
        return { ok: false, reason: `chosen URL returned ${probe.status}` };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `chosen URL probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Real source = the resolved candidate's source (index pick) or what the agent
  // claimed (web-search). Confidence derives from the real source + decoded shape.
  const matched = candidates.find((c) => c.url === chosen!.url);
  const source = (chosen.source ??
    matched?.source ??
    "web-search") as LogoCandidate["source"];
  const confidence = scoreConfidence(source, byUrl.get(chosen.url));

  return {
    ok: true,
    url: chosen.url,
    source,
    confidence,
    rationale: chosen.rationale ?? "",
  };
};
