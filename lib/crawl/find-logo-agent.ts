/**
 * Logo-discovery agent — persistent, "no empty hands".
 *
 * The brand's real mark is found by an agent that (1) inspects on-page
 * candidates with vision and (2) searches the web when the page comes up empty.
 * It is mandated NOT to return a fabricated mark, a screenshot, or a customer
 * logo — a real logo, or nothing (→ the resolver renders a clean wordmark, never
 * an invented mark).
 *
 * Candidates come from a wide net (inline <svg>, CSS background, header <img>,
 * static /logo.* paths, Clearbit, simple-icons, apple-touch, og, favicon). Two
 * upgrades over the old one-shot pick:
 *   - SVG candidates are RASTERIZED to PNG (Anthropic vision rejects raw SVG), so
 *     the agent actually SEES the inline nav mark — the Fuse miss.
 *   - Each previewed candidate is decoded (sharp) for dimensions; large ~square
 *     images are flagged as likely screenshots/share-cards so the agent doesn't
 *     mistake the homepage screenshot for the logo.
 *
 * Latency: ~10-25s (vision + optional web_search round). Runs inside extractBrand
 * which the wizard fires in the background while the user types.
 */

import { getAnthropic, MODELS } from "../anthropic";

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

Given image candidates from a brand's website + meta tags, pick the ONE candidate that IS the brand's primary logo or wordmark — the asset you'd put on a launch video to represent the brand. If none qualify, you MUST search the web for the official logo before giving up.

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

NO EMPTY HANDS: if none of the on-page candidates is the clean brand mark, USE the web_search tool — search "{brand} logo svg", "{brand} logo png", "{brand} brand assets", "{brand} press kit logo". Prefer a URL on the brand's own domain or a recognized brand-asset host. Only return null if the web search ALSO fails to surface the real logo.

OUTPUT (always JSON, never prose):
- Winner: {"chosen_url":"https://...","source":"inline-svg|static-path|header-img|css-bg|simple-icons|clearbit|apple-touch|web-search","rationale":"one sentence"}
- None qualify even after web_search: {"chosen_url":null,"reason":"one sentence"}
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
      const r = await fetch(cand.url, {
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

  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharp = await import("sharp").then((m) => m.default).catch(() => null);

  // Prepare up to 8 candidates as vision-safe PNGs (rasterize SVGs, decode dims).
  const prepared = await Promise.all(
    candidates.slice(0, 8).map((c) => prepareCandidate(c, sharp, userAgent)),
  );
  const byUrl = new Map(prepared.map((p) => [p.cand.url, p]));

  type ContentBlock =
    | { type: "text"; text: string }
    | {
        type: "image";
        source:
          | { type: "url"; url: string }
          | { type: "base64"; media_type: "image/png"; data: string };
      };

  const textIntro = [
    `Brand: ${brandTitle ?? brandHostname} (${brandHostname})`,
    "",
    "Candidates (numbered; previews shown below where available):",
    ...candidates.map((c, i) => {
      const p = byUrl.get(c.url);
      const note = p?.note ? ` [${p.note}]` : "";
      const shown = p?.visionPng ? "" : " (no preview — judge by source/URL)";
      return `  ${i + 1}. [${c.source}] ${c.url.slice(0, 120)}${note}${c.hint ? ` — ${c.hint}` : ""}${shown}`;
    }),
    "",
    "Pick the brand's primary logo. If none qualify, web_search for the official logo before returning null.",
  ].join("\n");

  const content: ContentBlock[] = [{ type: "text", text: textIntro }];
  for (const p of prepared) {
    if (p.visionPng) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: p.visionPng },
      });
    }
  }

  // ── Round 1: vision over candidates (web_search available) ──────────
  const runOnce = async (
    messages: { role: "user"; content: ContentBlock[] | string }[],
  ) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        model: MODELS.logoAgent,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      };
      return await client.messages.create(params);
    } catch {
      // web_search may be unavailable on the account — retry without tools.
      return await client.messages.create({
        model: MODELS.logoAgent,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      });
    }
  };

  const parse = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
  ): { chosen_url?: string | null; source?: string; rationale?: string; reason?: string } | null => {
    const textBlock = [...response.content].reverse().find((b: { type: string }) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    const rawTxt = textBlock.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return JSON.parse(rawTxt);
    } catch {
      return null;
    }
  };

  let parsed: { chosen_url?: string | null; source?: string; rationale?: string; reason?: string } | null;
  try {
    parsed = parse(await runOnce([{ role: "user", content }]));
  } catch (err) {
    return {
      ok: false,
      reason: `logo agent API error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Round 2: persistence — force a web search when the page came up empty ──
  if (!parsed || !parsed.chosen_url) {
    const webPrompt = [
      `Brand: ${brandTitle ?? brandHostname} (${brandHostname}).`,
      "None of the on-page candidates was the brand's clean logo.",
      "Use web_search NOW to find the official logo. Search \"" +
        `${brandTitle ?? brandHostname} logo svg`,
      "\", press kit, or brand assets. Prefer the brand's own domain or a recognized brand-asset host.",
      'Return JSON: {"chosen_url":"https://...","source":"web-search","rationale":"..."} or {"chosen_url":null,"reason":"..."}.',
    ].join(" ");
    try {
      parsed = parse(await runOnce([{ role: "user", content: webPrompt }]));
    } catch {
      // keep round-1 (null) result
    }
  }

  // Deterministic floor — "no empty hands". The vision agent is nondeterministic
  // and sometimes returns null even when the page has a clear brand mark (a
  // currentColor inline-svg renders faintly in the preview). Rather than lose it,
  // fall back to the strongest on-page candidate: an inline-svg (already filtered
  // to logo-shaped, in the brand's own nav) > a deliberate /logo.* static file >
  // a header img. These are the brand's own files, so they're safe without the
  // agent's screenshot-rejection. Only when NONE of those exist do we give up
  // (→ the resolver renders a clean wordmark, never a fabricated mark).
  if (!parsed || !parsed.chosen_url) {
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
  if (!parsed.chosen_url.startsWith("data:")) {
    try {
      const probe = await fetch(parsed.chosen_url, {
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

  // Real source = the candidate the URL matches, else what the agent claimed,
  // else web-search. Confidence derives from the real source + decoded shape.
  const matched = candidates.find((c) => c.url === parsed!.chosen_url);
  const source = (matched?.source ??
    (parsed.source as LogoCandidate["source"]) ??
    "web-search") as LogoCandidate["source"];
  const confidence = scoreConfidence(source, byUrl.get(parsed.chosen_url));

  return {
    ok: true,
    url: parsed.chosen_url,
    source,
    confidence,
    rationale: parsed.rationale ?? "",
  };
};
