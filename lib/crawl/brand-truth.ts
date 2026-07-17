/**
 * Brand-truth integrity gate (v14) — the Patagonia-failover class killed at
 * both ends of the pipeline.
 *
 * THE INCIDENT (dogfood cycle 5): the stored Patagonia brief had crawled the
 * brand's CDN FAILOVER page ("SPA-sitefailover/sitedownpage") — no logo, empty
 * palette, no photography, outage boilerplate copy ("Sit tight", "We've got
 * our hands full at the moment…") — and the engine faithfully built an entire
 * near-monochrome video from that degraded truth. Nothing at crawl time or
 * build time ever asked "is this extract actually the brand?"
 *
 * This module answers that question, deterministically and testably:
 *
 *   • assessBrandTruth(extract)  — PURE detector. Failover/parked URL tokens,
 *     hosting/outage boilerplate, sparse-core meta, and the asset-destitution
 *     triple (no logo AND neutral/no accent AND no photos). Emits a structured
 *     BrandTruthReport { ok, degraded[], hardFail }.
 *   • decodeImageDimensions(buf) — tiny header parsers (PNG/JPEG/GIF/WebP/
 *     ICO/SVG/AVIF, HTML-error-page sniff). No deps. The naturalWidth=0 class
 *     caught at the SOURCE instead of at render.
 *   • verifyImageUrl / verifyPageImages / verifyLogoChain — network probes
 *     (safeFetch, time-boxed, parallel) that fetch bytes and decode-check them.
 *   • preflightBrandTruth(extract) — the BUILD-ENTRY gate. Runs the network
 *     verification against a CACHED extract (stored briefs go stale: a logo
 *     URL that 200'd at crawl time can be dead at build time) and returns the
 *     report. hardFail → the caller must refuse to build; degraded → build
 *     proceeds with the report surfaced in the build output.
 *
 * Consumers: extract-brand.ts (crawl time, new crawls) + scripts/dogfood-spike
 * and lib/render/run-preview-build (build entry, cached extracts — the path
 * that protects production).
 */

import { signatureWithLogoFallback, dominantSvgColor } from "./brand-identity";
import { safeFetch } from "./ssrf-guard";

// ─── report types ────────────────────────────────────────────────────────────

export interface LogoTruthSignal {
  status: "ok" | "missing" | "undecodable";
  /** First candidate in the logo_hd → apple_touch → favicon chain that decodes (null = none). */
  effectiveUrl: string | null;
  /** Candidates that were probed and rejected, with the reason. */
  rejected: { url: string; reason: string }[];
}

export interface PhotoTruthSignal {
  /** page_images entries in the extract. */
  listed: number;
  /** Verified alive+decodable (null = network verification didn't run). */
  verified: number | null;
  /** Verified dead/undecodable (null = network verification didn't run). */
  dead: number | null;
  /** Probes that ran out of time-box — kept, benefit of the doubt. */
  timedOut: number;
  deadUrls: string[];
}

export interface BrandTruthReport {
  /** No hard failure AND zero degraded reasons. */
  ok: boolean;
  /** Refuse to build: the extract is not the brand's real page / has nothing brand-true in it. */
  hardFail: boolean;
  /** Human-readable reasons, each independently actionable. */
  degraded: string[];
  signals: {
    failover: {
      /** Failover/parked URL tokens matched (page URL or asset URLs). */
      patterns: string[];
      /** Outage/hosting boilerplate phrases matched in title/headlines/excerpts. */
      boilerplate: string[];
      /** No title AND no description AND no og:image (or a near-empty body). */
      sparseCore: boolean;
    };
    logo: LogoTruthSignal;
    accent: { status: "ok" | "neutral" | "missing"; resolved: string | null };
    photos: PhotoTruthSignal;
    copy: { headlines: number; excerpts: number };
  };
  checkedAt: string;
}

/** Structural subset of BrandExtract the detector reads — no schema import,
 *  so app/new/schema.ts can type-import BrandTruthReport without a cycle. */
export interface BrandTruthInput {
  url?: string;
  title?: string;
  description?: string;
  og_image?: string;
  theme_color?: string;
  favicon?: string;
  apple_touch_icon?: string;
  logo_hd?: string;
  logo_color?: string;
  headlines?: string[];
  body_excerpts?: string[];
  page_images?: { src: string; alt?: string }[];
  palette?: string[];
  background_color?: string;
}

// ─── neutral-accent test (HSL) ───────────────────────────────────────────────

const hexRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/** HSL of a #rrggbb hex — s and l in [0,1]. */
export const hslOfHex = (hex: string): { h: number; s: number; l: number } | null => {
  const rgb = hexRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
};

/**
 * A "neutral" accent reads as no-color on a frame: saturation under ~8% (grey —
 * the Patagonia #666666 class) or extreme lightness (near-black / near-white,
 * which are structure, not a brand hue).
 */
export const isNeutralAccentHex = (hex: string): boolean => {
  const hsl = hslOfHex(hex);
  if (!hsl) return true; // unparseable = no usable color
  return hsl.s < 0.08 || hsl.l < 0.06 || hsl.l > 0.94;
};

// ─── image header decoding (the naturalWidth=0 class, caught at the source) ──

export interface DecodedImage {
  format: "png" | "jpeg" | "gif" | "webp" | "ico" | "svg" | "avif";
  /** 0 = structurally valid but dimensions unknown (some SVG/AVIF/JPEG-truncated). */
  width: number;
  height: number;
}

const asciiAt = (buf: Buffer, off: number, len: number): string =>
  buf.length >= off + len ? buf.toString("latin1", off, off + len) : "";

/** An error page served where an image should be — the #1 dead-logo shape. */
export const looksLikeHtml = (buf: Buffer): boolean => {
  const head = buf.toString("utf8", 0, Math.min(buf.length, 512)).trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("{\"") // JSON error body
  );
};

const decodeSvgText = (text: string): DecodedImage | null => {
  const openIdx = text.search(/<svg[\s>]/i);
  if (openIdx === -1) return null;
  const openTag = text.slice(openIdx).match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const num = (s: string | undefined): number => {
    if (!s) return 0;
    const n = parseFloat(s.replace(/px$/i, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  let width = num(openTag.match(/\bwidth=["']([^"']+)["']/i)?.[1]);
  let height = num(openTag.match(/\bheight=["']([^"']+)["']/i)?.[1]);
  if (!width || !height) {
    const vb = openTag.match(/viewBox=["']\s*[\d.eE+-]+[\s,]+[\d.eE+-]+[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/i);
    if (vb) {
      width = width || num(vb[1]);
      height = height || num(vb[2]);
    }
  }
  return { format: "svg", width, height };
};

/**
 * Decode image dimensions from the leading bytes of a file. Pure, dependency-
 * free header parsers — enough to answer "is this really a renderable image,
 * and how big" without pulling a decoder. Returns null for anything that is
 * not recognizably an image (HTML error pages, JSON bodies, junk bytes).
 */
export const decodeImageDimensions = (buf: Buffer): DecodedImage | null => {
  if (buf.length < 12) return null;

  // PNG: 8-byte signature, IHDR immediately after.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    if (asciiAt(buf, 12, 4) !== "IHDR" || buf.length < 24) return null;
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: walk segments to the first SOFn frame header.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; } // tolerate fill bytes
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // no-length markers
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) return null; // malformed
      i += 2 + segLen;
    }
    // Well-formed JPEG structure but SOF beyond our capped read (huge EXIF):
    // structurally an image — accept with unknown dims (false-negative safe).
    return { format: "jpeg", width: 0, height: 0 };
  }

  // GIF87a / GIF89a.
  const gifSig = asciiAt(buf, 0, 6);
  if (gifSig === "GIF87a" || gifSig === "GIF89a") {
    return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: RIFF....WEBP + VP8/VP8L/VP8X chunk.
  if (asciiAt(buf, 0, 4) === "RIFF" && asciiAt(buf, 8, 4) === "WEBP") {
    const chunk = asciiAt(buf, 12, 4);
    if (chunk === "VP8 " && buf.length >= 30) {
      return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { format: "webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && buf.length >= 30) {
      return { format: "webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return { format: "webp", width: 0, height: 0 };
  }

  // ICO: reserved 0, type 1, ≥1 entries. Width/height bytes: 0 means 256.
  if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) >= 1 && buf.length >= 8) {
    return { format: "ico", width: buf[6] === 0 ? 256 : buf[6], height: buf[7] === 0 ? 256 : buf[7] };
  }

  // AVIF/HEIF: ....ftypavif. Dimensions live in the ispe box — cheap scan.
  if (asciiAt(buf, 4, 4) === "ftyp" && /^avi[fs]/.test(asciiAt(buf, 8, 4))) {
    const idx = buf.indexOf("ispe", 0, "latin1");
    if (idx !== -1 && buf.length >= idx + 16) {
      return { format: "avif", width: buf.readUInt32BE(idx + 8), height: buf.readUInt32BE(idx + 12) };
    }
    return { format: "avif", width: 0, height: 0 };
  }

  // SVG: text sniff (after optional BOM / xml decl / comments).
  if (looksLikeHtml(buf)) return null; // an error page is never an image
  const text = buf.toString("utf8", 0, Math.min(buf.length, 4096));
  if (/<svg[\s>]/i.test(text)) return decodeSvgText(text);

  return null;
};

/** Decode a data: URL's payload to bytes (base64 or percent-encoded). */
export const dataUrlBytes = (url: string): Buffer | null => {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  try {
    return /;base64/i.test(header)
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }
};

// ─── network verification (safeFetch, capped reads, time-boxed) ──────────────

const PROBE_UA =
  "Mozilla/5.0 (compatible; RenderballBrandTruth/1.0; +https://renderball.com/bot)";
const PROBE_MAX_BYTES = 65_536;

/** Read at most `maxBytes` from a Response body, then cancel the stream. */
const readCapped = async (res: Response, maxBytes: number): Promise<Buffer> => {
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab.slice(0, maxBytes));
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        total += value.byteLength;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
};

export interface ImageProbeResult {
  ok: boolean;
  reason?: string;
  decoded?: DecodedImage;
  /** Fetched leading bytes (for dominant-color reuse); only set when ok. */
  bytes?: Buffer;
  timedOut?: boolean;
}

/**
 * Fetch + decode-check a single image URL (or decode a data: URL inline).
 * Never throws. A probe that can't complete inside the timeout reports
 * { ok: true, timedOut: true } — we keep slow-but-possibly-fine images and
 * only drop PROVEN-dead ones (false-negative direction).
 */
export const verifyImageUrl = async (
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<ImageProbeResult> => {
  const timeoutMs = opts.timeoutMs ?? 3_500;
  if (url.startsWith("data:")) {
    const bytes = dataUrlBytes(url);
    if (!bytes || bytes.length < 12) return { ok: false, reason: "data: URL payload undecodable" };
    const decoded = decodeImageDimensions(bytes);
    if (!decoded) return { ok: false, reason: "data: URL bytes are not a recognizable image" };
    if (decoded.width === 1 && decoded.height === 1) return { ok: false, reason: "1x1 pixel (tracking pixel)" };
    return { ok: true, decoded, bytes };
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "not a fetchable URL" };
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": PROBE_UA,
        Accept: "image/*,*/*;q=0.5",
        Range: `bytes=0-${PROBE_MAX_BYTES - 1}`,
      },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (/text\/html|application\/json|text\/plain/.test(ct)) {
      return { ok: false, reason: `non-image content-type (${ct.split(";")[0]})` };
    }
    const bytes = await readCapped(res, PROBE_MAX_BYTES);
    if (bytes.length < 12) return { ok: false, reason: "empty/near-empty response body" };
    const decoded = decodeImageDimensions(bytes);
    if (!decoded) {
      return {
        ok: false,
        reason: looksLikeHtml(bytes) ? "HTML error page served as image" : "bytes are not a recognizable image",
      };
    }
    if (decoded.width === 1 && decoded.height === 1) return { ok: false, reason: "1x1 pixel (tracking pixel)" };
    return { ok: true, decoded, bytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) return { ok: true, timedOut: true, reason: "probe timed out (kept)" };
    return { ok: false, reason: `fetch failed: ${msg.split("\n")[0].slice(0, 120)}` };
  }
};

export interface PageImageVerification {
  kept: { src: string; alt?: string }[];
  dropped: { src: string; reason: string }[];
  verified: number;
  dead: number;
  timedOut: number;
}

/**
 * Verify page_images fetch + decode, in parallel, inside a total time-box.
 * Dead entries are DROPPED (they must never reach preallocated assets);
 * timed-out probes are kept with a count.
 */
export const verifyPageImages = async (
  images: { src: string; alt?: string }[] | undefined,
  opts: { budgetMs?: number } = {},
): Promise<PageImageVerification> => {
  const budgetMs = opts.budgetMs ?? 5_000;
  const list = images ?? [];
  if (list.length === 0) return { kept: [], dropped: [], verified: 0, dead: 0, timedOut: 0 };
  const results = await Promise.all(
    list.map((img) => verifyImageUrl(img.src, { timeoutMs: budgetMs })),
  );
  const kept: { src: string; alt?: string }[] = [];
  const dropped: { src: string; reason: string }[] = [];
  let verified = 0, dead = 0, timedOut = 0;
  results.forEach((r, i) => {
    if (r.ok) {
      kept.push(list[i]);
      if (r.timedOut) timedOut += 1; else verified += 1;
    } else {
      dropped.push({ src: list[i].src, reason: r.reason ?? "dead" });
      dead += 1;
    }
  });
  return { kept, dropped, verified, dead, timedOut };
};

export interface LogoChainResult {
  status: LogoTruthSignal["status"];
  effectiveUrl: string | null;
  rejected: { url: string; reason: string }[];
  /** Leading bytes of the effective logo (for dominant-color extraction). */
  effectiveBytes?: Buffer;
  /** Per-candidate probe outcomes keyed by URL (dead fallbacks get blanked upstream). */
  deadUrls: string[];
}

/**
 * Decode-verify the logo fallback chain (logo_hd → apple_touch_icon → favicon)
 * in parallel. The effective logo is the FIRST candidate that decodes; dead
 * candidates are reported so callers can blank them (a dead fallback must not
 * be resurrectable by pickLogo at design time).
 */
export const verifyLogoChain = async (
  candidates: (string | undefined)[],
  opts: { timeoutMs?: number } = {},
): Promise<LogoChainResult> => {
  const urls = candidates.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (urls.length === 0) return { status: "missing", effectiveUrl: null, rejected: [], deadUrls: [] };
  const results = await Promise.all(urls.map((u) => verifyImageUrl(u, opts)));
  const rejected: { url: string; reason: string }[] = [];
  const deadUrls: string[] = [];
  let effectiveUrl: string | null = null;
  let effectiveBytes: Buffer | undefined;
  results.forEach((r, i) => {
    if (r.ok) {
      if (effectiveUrl === null) {
        effectiveUrl = urls[i];
        effectiveBytes = r.bytes;
      }
    } else {
      rejected.push({ url: urls[i], reason: r.reason ?? "undecodable" });
      deadUrls.push(urls[i]);
    }
  });
  if (effectiveUrl === null) return { status: "undecodable", effectiveUrl: null, rejected, deadUrls };
  return { status: "ok", effectiveUrl, rejected, effectiveBytes, deadUrls };
};

/**
 * Dominant CHROMATIC color from image bytes — the accent-sanity fallback when
 * the palette is all-neutral. SVG text goes through dominantSvgColor; raster
 * bytes go through sharp (existing dep, lazy-imported) with a coarse quantize.
 * Best-effort: any failure → null.
 */
export const dominantColorFromImageBytes = async (bytes: Buffer): Promise<string | null> => {
  try {
    const text = bytes.toString("utf8", 0, Math.min(bytes.length, 4096));
    if (/<svg[\s>]/i.test(text) && !looksLikeHtml(bytes)) {
      return dominantSvgColor(bytes.toString("utf8"));
    }
    const sharpMod = await import("sharp").catch(() => null);
    if (!sharpMod) return null;
    const sharp = (sharpMod as { default?: unknown }).default ?? sharpMod;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, info } = await (sharp as any)(bytes)
      .resize(48, 48, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const counts = new Map<number, number>();
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // transparent
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    void info;
    let best: { hex: string; score: number } | null = null;
    for (const [key, count] of counts) {
      const r = ((key >> 8) & 0xf) * 17, g = ((key >> 4) & 0xf) * 17, b = (key & 0xf) * 17;
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const hsl = hslOfHex(hex);
      if (!hsl || hsl.s < 0.25 || hsl.l < 0.08 || hsl.l > 0.92) continue; // neutrals can't be the accent
      const score = count * hsl.s;
      if (!best || score > best.score) best = { hex, score };
    }
    return best?.hex ?? null;
  } catch {
    return null;
  }
};

// ─── the pure detector ───────────────────────────────────────────────────────

/**
 * Failover/parked URL tokens. Deliberately COMPOUND words only — a bare
 * "failover" or "maintenance" in a blog-image path on a dev-infra brand must
 * not fire (Tailscale writes about failover; that's content, not an outage).
 */
const FAILOVER_URL_RX =
  /(sitedownpage|site-?failover|cdn-?failover|failover-?page|sitedown\b|parked-?domain|domain-?parking|parking-?page|under-?construction|holding-?page|suspendedpage|account-?suspended|maintenance-?page|comingsoonpage|coming-?soon-?page)/i;

/** Outage / hosting-provider boilerplate phrases, matched against title +
 *  headlines + body excerpts. Each phrase is distinctive enough that real
 *  brand copy essentially never carries it. */
const BOILERPLATE_RXS: RegExp[] = [
  /\bsit tight\b/i,
  /\bbe right back\b/i,
  /\bwe(?:'|’)?ll be back\b/i,
  /\bback (?:up|online) (?:soon|shortly)\b/i,
  /\b(?:should )?be (?:back )?up and running\b/i,
  /\bhands full at the moment\b/i,
  /\btemporarily unavailable\b/i,
  /\b(?:down|closed) for maintenance\b/i,
  /\bunder maintenance\b/i,
  /\bscheduled maintenance\b/i,
  /\bservice unavailable\b/i,
  /\bthis (?:domain|site) (?:is|has been|may be) (?:parked|for sale|suspended)\b/i,
  /\bbuy this domain\b/i,
  /\bdomain is for sale\b/i,
  /\baccount (?:has been )?suspended\b/i,
  /\bdefault web(?:site)? page\b/i,
  /\bwelcome to nginx\b/i,
  /\bapache2? (?:ubuntu|debian) default\b/i,
  /\btest page for the (?:apache|nginx)\b/i,
  /\bwebsite coming soon\b/i,
  /\bsite is under construction\b/i,
];

export interface AssessOpts {
  /** Network logo-chain verification result (build preflight / crawl). */
  logo?: LogoChainResult;
  /** Network photo verification result (build preflight / crawl). */
  photos?: PageImageVerification;
  /** User-uploaded logo (wizard) — definitionally trusted, overrides logo signals. */
  userLogoUrl?: string;
}

/**
 * The pure brand-truth detector. Runs on any extract shape — a fresh crawl or
 * a years-stale cached brief — with optional network-verification results
 * folded in when the caller ran them.
 *
 * hardFail when:
 *   • the PAGE URL itself matches a failover/parked token, or
 *   • ≥2 independent failover signals fire (asset-URL token, boilerplate copy,
 *     sparse meta core), or
 *   • the asset-destitution triple: no logo AND no chromatic accent AND no
 *     photos — nothing brand-true exists to build from (the grey-video class).
 */
export const assessBrandTruth = (
  input: BrandTruthInput | undefined,
  opts: AssessOpts = {},
): BrandTruthReport => {
  const e = input ?? {};
  const degraded: string[] = [];

  // ── failover signals ──
  const patterns: string[] = [];
  const pageUrlHit = !!(e.url && FAILOVER_URL_RX.test(e.url));
  if (pageUrlHit) patterns.push(`page URL: ${e.url!.match(FAILOVER_URL_RX)![0]}`);
  const assetUrls = [
    ...(e.page_images ?? []).map((i) => i.src),
    e.logo_hd ?? "",
    e.og_image ?? "",
    e.favicon ?? "",
    e.apple_touch_icon ?? "",
  ];
  for (const u of assetUrls) {
    if (!u || u.startsWith("data:")) continue;
    const m = FAILOVER_URL_RX.exec(u);
    if (m) patterns.push(`asset URL: …${u.slice(-60)} (${m[0]})`);
  }

  const textCorpus = [e.title ?? "", ...(e.headlines ?? []), ...(e.body_excerpts ?? [])];
  const boilerplate: string[] = [];
  for (const rx of BOILERPLATE_RXS) {
    const hit = textCorpus.find((t) => rx.test(t));
    if (hit) {
      const m = rx.exec(hit);
      if (m) boilerplate.push(m[0]);
    }
  }

  const headlineCount = (e.headlines ?? []).length;
  const excerptCount = (e.body_excerpts ?? []).length;
  const sparseCore =
    (!e.title && !e.description && !e.og_image) || headlineCount + excerptCount <= 1;

  // ── logo signal ──
  let logo: LogoTruthSignal;
  if (opts.userLogoUrl) {
    logo = { status: "ok", effectiveUrl: opts.userLogoUrl, rejected: [] };
  } else if (opts.logo) {
    logo = { status: opts.logo.status, effectiveUrl: opts.logo.effectiveUrl, rejected: opts.logo.rejected };
  } else {
    const effective = e.logo_hd ?? e.apple_touch_icon ?? e.favicon ?? null;
    logo = { status: effective ? "ok" : "missing", effectiveUrl: effective, rejected: [] };
  }

  // ── accent signal ──
  const resolved = signatureWithLogoFallback(e.palette ?? [], e.theme_color, e.logo_color);
  const accent: BrandTruthReport["signals"]["accent"] =
    resolved === null
      ? { status: "missing", resolved: null }
      : isNeutralAccentHex(resolved)
        ? { status: "neutral", resolved }
        : { status: "ok", resolved };

  // ── photos signal ──
  const listed = (e.page_images ?? []).length;
  const photos: PhotoTruthSignal = opts.photos
    ? {
        listed,
        verified: opts.photos.verified,
        dead: opts.photos.dead,
        timedOut: opts.photos.timedOut,
        deadUrls: opts.photos.dropped.map((d) => d.src),
      }
    : { listed, verified: null, dead: null, timedOut: 0, deadUrls: [] };
  const alivePhotoCount = opts.photos
    ? opts.photos.kept.length
    : listed;

  // ── degraded reasons (each independently actionable) ──
  if (patterns.length > 0)
    degraded.push(`failover/parked URL pattern (${patterns.join("; ")})`);
  if (boilerplate.length > 0)
    degraded.push(`outage/hosting boilerplate copy ("${boilerplate.slice(0, 3).join('", "')}")`);
  if (sparseCore)
    degraded.push("sparse extract core (no title/description/og:image or near-empty body)");
  if (logo.status === "missing")
    degraded.push("no logo discovered — wordmark fallback will carry the brand");
  if (logo.status === "undecodable")
    degraded.push(
      `logo undecodable (${logo.rejected.map((r) => r.reason).slice(0, 3).join("; ") || "no candidate decodes"}) — wordmark fallback`,
    );
  if (accent.status === "missing")
    degraded.push("no brand accent color recoverable (palette/theme/logo all achromatic) — brand color decision needed");
  if (accent.status === "neutral")
    degraded.push(`brand accent resolves to a NEUTRAL (${accent.resolved}) — brand color decision needed`);
  if (listed === 0) degraded.push("zero page images harvested — no real product/brand imagery available");
  else if ((photos.dead ?? 0) > 0)
    degraded.push(`${photos.dead}/${listed} page image(s) dead or undecodable — dropped before the build`);

  // ── hard fail ──
  const failoverSignals =
    (patterns.length > 0 ? 1 : 0) + (boilerplate.length > 0 ? 1 : 0) + (sparseCore ? 1 : 0);
  const assetDestitution =
    logo.status !== "ok" && accent.status !== "ok" && alivePhotoCount === 0;
  const hardFail = pageUrlHit || failoverSignals >= 2 || assetDestitution;
  if (hardFail) {
    const why: string[] = [];
    if (pageUrlHit) why.push("the crawled URL is a failover/parked page");
    if (failoverSignals >= 2)
      why.push("multiple failover signals (URL pattern / outage boilerplate / empty page core) — this extract is NOT the brand's real site");
    if (assetDestitution)
      why.push("nothing brand-true to build from: no usable logo, no chromatic accent, no photos");
    degraded.push(`HARD FAIL: ${why.join(" + ")} — re-crawl the brand or supply assets before building`);
  }

  return {
    ok: !hardFail && degraded.length === 0,
    hardFail,
    degraded,
    signals: {
      failover: { patterns, boilerplate, sparseCore },
      logo,
      accent,
      photos,
      copy: { headlines: headlineCount, excerpts: excerptCount },
    },
    checkedAt: new Date().toISOString(),
  };
};

// ─── the build-entry preflight (cached extracts) ─────────────────────────────

export interface PreflightOpts {
  /** Skip the network probes (pure assessment only). Default: verify. */
  verifyNetwork?: boolean;
  /** Total budget for the page-image probes (default 5000ms). */
  photoBudgetMs?: number;
  /** Per-candidate timeout for the logo chain (default 3500ms). */
  logoTimeoutMs?: number;
  /** User-uploaded logo (wizard) — trusted, skips the chain probe. */
  userLogoUrl?: string;
}

/**
 * BUILD-ENTRY brand-truth preflight. All stored briefs carry CACHED extracts —
 * crawl-time checks never ran on them, and even a healthy crawl goes stale
 * (the Patagonia logo URL that 200'd in June was dead by July). So the gate
 * runs here, against what the build will actually consume: verify the logo
 * chain + page images over the network (time-boxed), then assess.
 *
 * Callers MUST refuse to build on hardFail, and SHOULD:
 *   • drop report.signals.photos.deadUrls from the page_images they feed the
 *     agents, and
 *   • treat report.signals.logo.effectiveUrl as the logo truth (null → wordmark).
 * Never throws — a preflight infrastructure failure degrades to the pure check.
 */
export const preflightBrandTruth = async (
  be: BrandTruthInput | undefined,
  opts: PreflightOpts = {},
): Promise<BrandTruthReport> => {
  const e = be ?? {};
  if (opts.verifyNetwork === false) {
    return assessBrandTruth(e, { userLogoUrl: opts.userLogoUrl });
  }
  try {
    const [logoChain, photoCheck] = await Promise.all([
      opts.userLogoUrl
        ? Promise.resolve<LogoChainResult | undefined>(undefined)
        : verifyLogoChain([e.logo_hd, e.apple_touch_icon, e.favicon], {
            timeoutMs: opts.logoTimeoutMs ?? 3_500,
          }),
      verifyPageImages(e.page_images, { budgetMs: opts.photoBudgetMs ?? 5_000 }),
    ]);
    return assessBrandTruth(e, {
      logo: logoChain,
      photos: photoCheck,
      userLogoUrl: opts.userLogoUrl,
    });
  } catch {
    // Infrastructure failure in the probes must never block a build harder
    // than the pure signals justify.
    return assessBrandTruth(e, { userLogoUrl: opts.userLogoUrl });
  }
};
