/**
 * Brand-truth integrity gate (v14) — pure-detector + decoder tests.
 *
 * Run: `npm test`. No API key, no network — the network probes are exercised
 * only through their pure seams (data: URLs, header decoding, assessment with
 * injected verification results).
 *
 * Calibration anchors:
 *   • the REAL Patagonia CDN-failover extract shape (dogfood cycle 5's
 *     incident: the engine built an entire grey video from a "Sit tight"
 *     outage page) MUST hard-fail;
 *   • a healthy Klarna-shaped extract MUST pass clean;
 *   • the REAL Robinhood extract shape (cycle 6's brand) MUST pass clean.
 */
import {
  assessBrandTruth,
  decodeImageDimensions,
  dataUrlBytes,
  hslOfHex,
  isNeutralAccentHex,
  looksLikeHtml,
  verifyImageUrl,
  type BrandTruthInput,
} from "./brand-truth";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void | Promise<void>): Promise<void> | void => {
  const done = (err?: unknown) => {
    if (err === undefined) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => done(), done);
    done();
  } catch (err) {
    done(err);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// ─── neutral-accent (HSL) ────────────────────────────────────────────────────

check("neutral accent: #666666 grey (the Patagonia failover accent) is neutral", () => {
  assert(isNeutralAccentHex("#666666"), "#666666 must be neutral");
});

check("neutral accent: near-black and near-white are neutral (structure, not brand hue)", () => {
  assert(isNeutralAccentHex("#0a0a0a"), "near-black neutral");
  assert(isNeutralAccentHex("#fafafa"), "near-white neutral");
  assert(isNeutralAccentHex("#e5e5e5"), "light grey neutral");
});

check("neutral accent: chromatic brand hues are NOT neutral", () => {
  assert(!isNeutralAccentHex("#ccff00"), "Robinhood lime is chromatic");
  assert(!isNeutralAccentHex("#c8102e"), "Glossier red is chromatic");
  assert(!isNeutralAccentHex("#1e5fb8"), "Fuse blue is chromatic");
});

check("hslOfHex: pure grey has zero saturation; lime is fully saturated", () => {
  const grey = hslOfHex("#808080");
  assert(grey !== null && grey.s === 0, `grey s=0, got ${JSON.stringify(grey)}`);
  const lime = hslOfHex("#ccff00");
  assert(lime !== null && lime.s > 0.95 && lime.l > 0.45 && lime.l < 0.55, `lime HSL, got ${JSON.stringify(lime)}`);
});

// ─── image header decoding ───────────────────────────────────────────────────

const pngBuf = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); // IHDR length
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

check("decode: PNG header parses width/height", () => {
  const d = decodeImageDimensions(pngBuf(120, 80));
  assert(d !== null && d.format === "png" && d.width === 120 && d.height === 80, `got ${JSON.stringify(d)}`);
});

check("decode: JPEG SOF0 parses dimensions", () => {
  // FFD8 + APP0 (len 16) + SOF0 (len 17) with h=90, w=160.
  const b = Buffer.alloc(2 + 2 + 16 + 2 + 10);
  let i = 0;
  b[i++] = 0xff; b[i++] = 0xd8;
  b[i++] = 0xff; b[i++] = 0xe0; b.writeUInt16BE(16, i); i += 16; // APP0 segment (len includes itself)
  b[i++] = 0xff; b[i++] = 0xc0; b.writeUInt16BE(17, i);
  b[i + 2] = 8; // precision
  b.writeUInt16BE(90, i + 3);
  b.writeUInt16BE(160, i + 5);
  const d = decodeImageDimensions(b);
  assert(d !== null && d.format === "jpeg" && d.width === 160 && d.height === 90, `got ${JSON.stringify(d)}`);
});

check("decode: GIF89a parses LE dimensions", () => {
  const b = Buffer.alloc(16);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(320, 6);
  b.writeUInt16LE(200, 8);
  const d = decodeImageDimensions(b);
  assert(d !== null && d.format === "gif" && d.width === 320 && d.height === 200, `got ${JSON.stringify(d)}`);
});

check("decode: WebP VP8L parses packed dimensions", () => {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8L", 12, "latin1");
  b[20] = 0x2f;
  b.writeUInt32LE((100 - 1) | ((50 - 1) << 14), 21);
  const d = decodeImageDimensions(b);
  assert(d !== null && d.format === "webp" && d.width === 100 && d.height === 50, `got ${JSON.stringify(d)}`);
});

check("decode: ICO parses entry dimensions (0 byte = 256)", () => {
  const b = Buffer.alloc(22);
  b.writeUInt16LE(0, 0);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(1, 4);
  b[6] = 32; b[7] = 32;
  const d = decodeImageDimensions(b);
  assert(d !== null && d.format === "ico" && d.width === 32 && d.height === 32, `got ${JSON.stringify(d)}`);
  const b256 = Buffer.from(b);
  b256[6] = 0; b256[7] = 0;
  const d2 = decodeImageDimensions(b256);
  assert(d2 !== null && d2.width === 256 && d2.height === 256, `0-byte → 256, got ${JSON.stringify(d2)}`);
});

check("decode: SVG dims from width attr + viewBox (the Robinhood inline-svg shape)", () => {
  const svg = `<svg id="Layer_1" viewBox="0 0 781.7 149.53" width="136px" xmlns="http://www.w3.org/2000/svg"><path d="m1,1"/></svg>`;
  const d = decodeImageDimensions(Buffer.from(svg, "utf8"));
  assert(d !== null && d.format === "svg" && d.width === 136 && d.height === 150, `got ${JSON.stringify(d)}`);
});

check("decode: HTML error page / JSON body / junk bytes are NOT images", () => {
  assert(decodeImageDimensions(Buffer.from("<!DOCTYPE html><html><body>404</body></html>")) === null, "HTML page rejected");
  assert(decodeImageDimensions(Buffer.from('{"error":"not found","status":404}____pad')) === null, "JSON body rejected");
  assert(decodeImageDimensions(Buffer.from("this is not an image, just some text padding")) === null, "junk rejected");
  assert(decodeImageDimensions(Buffer.from("tiny")) === null, "too-short rejected");
  assert(looksLikeHtml(Buffer.from("  <html><head>")), "html sniff");
});

await check("verifyImageUrl (data: URL, no network): valid SVG passes; 1x1 PNG tracking pixel rejects; garbage rejects", async () => {
  const svgUrl =
    "data:image/svg+xml;base64," +
    Buffer.from(`<svg viewBox="0 0 100 40" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="40"/></svg>`).toString("base64");
  const ok = await verifyImageUrl(svgUrl);
  assert(ok.ok && ok.decoded?.format === "svg", `svg data URL decodes, got ${JSON.stringify(ok)}`);
  const pixelUrl = "data:image/png;base64," + pngBuf(1, 1).toString("base64");
  const px = await verifyImageUrl(pixelUrl);
  assert(!px.ok && /1x1/.test(px.reason ?? ""), `1x1 rejected, got ${JSON.stringify(px)}`);
  const junk = await verifyImageUrl("data:image/png;base64," + Buffer.from("not an image at all").toString("base64"));
  assert(!junk.ok, "garbage data URL rejected");
});

check("dataUrlBytes: base64 and percent-encoded payloads decode; non-data URLs are null", () => {
  const b = dataUrlBytes("data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"));
  assert(b !== null && b.toString("utf8") === "<svg/>", "base64 payload");
  const p = dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E");
  assert(p !== null && p.toString("utf8") === "<svg/>", "percent payload");
  assert(dataUrlBytes("https://x.com/a.png") === null, "non-data URL null");
});

// ─── the pure detector: calibration fixtures ─────────────────────────────────

// The REAL Patagonia CDN-failover extract (dogfood cycle 5's incident),
// verbatim shape from the stored brief 01KT7ZZAC6D36Q7Y6Q7AHY8VB4.
const PATAGONIA_FAILOVER: BrandTruthInput = {
  url: "https://patagonia.com/",
  headlines: ["Sit tight", "U.S. & CANADA", "EUROPE", "JAPAN"],
  body_excerpts: [
    "We’ve got our hands full at the moment but we should be up and running shortly.",
    "If you live in the United States or Canada and need to contact us, please call.",
    "European customers can email directsales.europe@patagonia.com for assistance.",
  ],
  page_images: [
    { src: "https://patagonia.com/media/SPA-sitefailover/sitedownpage/images/patagonia-logo.png" },
  ],
  palette: [],
  // no title, no description, no og_image, no logo anywhere, no theme/background
};

// A healthy Klarna-shaped extract (v8's clean reference brand).
const KLARNA_HEALTHY: BrandTruthInput = {
  url: "https://www.klarna.com/us/",
  title: "Klarna | Shop now. Pay later.",
  description: "Klarna is the better way to shop — split payments, smoooth checkout.",
  og_image: "https://www.klarna.com/assets/og-share.png",
  theme_color: "#ffb3c7",
  favicon: "https://www.klarna.com/favicon.ico",
  apple_touch_icon: "https://www.klarna.com/apple-touch-icon.png",
  logo_hd: "https://www.klarna.com/assets/logo.svg",
  headlines: ["Shop now. Pay later.", "Smoooth payments for everything"],
  body_excerpts: [
    "Get what you love today and split the cost into 4 interest-free payments.",
    "Klarna is used by over 150 million shoppers worldwide.",
  ],
  page_images: [
    { src: "https://www.klarna.com/assets/hero-shopper.jpg", alt: "Shopper" },
    { src: "https://www.klarna.com/assets/app-screens.png", alt: "App" },
  ],
  palette: ["#ffb3c7", "#17120f", "#ffffff"],
  background_color: "#ffb3c7",
};

// The REAL Robinhood extract shape (cycle 6's brand, brief 01KW041ZC50QYCM2R3N0R204XA).
const ROBINHOOD: BrandTruthInput = {
  url: "https://robinhood.com/",
  title: "Robinhood: 24/5 Commission-Free Stock Trading & Investing",
  description: "Trade stocks on Robinhood with commission-free investing & advanced trading tools.",
  og_image: "https://images.ctfassets.net/ilblxxee70tt/1MXqbgveTatTROdavAHPlR/x/Meta_Thumbnail_Icon.jpg",
  favicon: "https://robinhood.com/us/en/rh_favicon_32.png?v=2024",
  apple_touch_icon: "https://robinhood.com/us/en/rh_favicon_60.png?v=2024",
  logo_hd: "data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMSI+PC9zdmc+",
  headlines: ["The World is Flat", "Send your agent", "to the market", "Agentic Trading"],
  body_excerpts: [
    "Get started with Robinhood Crypto Trade crypto 24/7. Start with as little as $1.",
    "Your portfolio, handled by the pros. Get timely market insights with an expert-managed portfolio.",
  ],
  page_images: [
    { src: "https://images.ctfassets.net/ilblxxee70tt/a/b/RH26_Events_Crypto_HPTO_Desktop.jpg" },
    { src: "https://images.ctfassets.net/ilblxxee70tt/c/d/Agentic_Trading_module_Desktop.png" },
  ],
  palette: ["#110e09", "#ccff00", "#110e09"],
  background_color: "#110e09",
};

check("Patagonia CDN-failover extract HARD-FAILS (the cycle-5 incident class)", () => {
  const r = assessBrandTruth(PATAGONIA_FAILOVER);
  assert(r.hardFail, `must hardFail, got ${JSON.stringify(r.degraded)}`);
  assert(!r.ok, "ok must be false");
  assert(r.signals.failover.patterns.length >= 1, "asset-URL failover token (sitefailover/sitedownpage) detected");
  assert(r.signals.failover.boilerplate.length >= 2, `outage boilerplate detected, got ${JSON.stringify(r.signals.failover.boilerplate)}`);
  assert(r.signals.failover.sparseCore, "sparse core (no title/description/og)");
  assert(r.signals.logo.status === "missing", "no logo");
  assert(r.signals.accent.status === "missing", "no accent from an empty palette");
  assert(r.degraded.some((d) => d.startsWith("HARD FAIL")), "hard-fail reason names the cause");
});

check("healthy Klarna-shaped extract passes CLEAN", () => {
  const r = assessBrandTruth(KLARNA_HEALTHY);
  assert(!r.hardFail, `must not hardFail: ${JSON.stringify(r.degraded)}`);
  assert(r.ok && r.degraded.length === 0, `must be clean, degraded: ${JSON.stringify(r.degraded)}`);
  assert(r.signals.logo.status === "ok", "logo present");
  assert(r.signals.accent.status === "ok", `accent resolves chromatic, got ${JSON.stringify(r.signals.accent)}`);
});

check("REAL Robinhood extract passes CLEAN — lime accent resolves via the rescue path", () => {
  const r = assessBrandTruth(ROBINHOOD);
  assert(!r.hardFail && r.ok, `must be clean, got ${JSON.stringify(r.degraded)}`);
  assert(r.signals.accent.resolved === "#ccff00", `lime resolves, got ${r.signals.accent.resolved}`);
  assert(r.signals.logo.status === "ok", "inline-svg logo counts");
});

check("asset-destitution triple (no logo + no chromatic accent + no photos) HARD-FAILS even with healthy meta", () => {
  const r = assessBrandTruth({
    url: "https://example-brand.com/",
    title: "Example Brand — Widgets",
    description: "We make widgets.",
    og_image: "https://example-brand.com/og.png",
    headlines: ["Widgets for everyone", "Built to last"],
    body_excerpts: ["Our widgets are the best widgets."],
    page_images: [],
    palette: ["#666666", "#ffffff", "#111111"],
  });
  assert(r.hardFail, `destitution must hardFail: ${JSON.stringify(r.degraded)}`);
  assert(r.degraded.some((d) => /nothing brand-true/.test(d)), "reason names the destitution");
});

check("a user-uploaded logo rescinds the destitution hard-fail (build proceeds degraded)", () => {
  const r = assessBrandTruth(
    {
      url: "https://example-brand.com/",
      title: "Example Brand — Widgets",
      description: "We make widgets.",
      og_image: "https://example-brand.com/og.png",
      headlines: ["Widgets for everyone"],
      body_excerpts: ["Our widgets are the best widgets."],
      page_images: [],
      palette: ["#666666", "#ffffff"],
    },
    { userLogoUrl: "https://uploads.renderball.com/logo.png" },
  );
  assert(!r.hardFail, `user logo must rescind hardFail: ${JSON.stringify(r.degraded)}`);
  assert(r.degraded.length > 0, "still degraded (accent + photos)");
  assert(r.signals.logo.status === "ok" && r.signals.logo.effectiveUrl === "https://uploads.renderball.com/logo.png", "user logo is the truth");
});

check("ONE failover token in an asset URL on an otherwise-healthy brand degrades, never hard-fails", () => {
  const r = assessBrandTruth({
    ...KLARNA_HEALTHY,
    page_images: [
      ...(KLARNA_HEALTHY.page_images ?? []),
      { src: "https://www.klarna.com/blog/img/coming-soon-page-teaser.png" },
    ],
  });
  assert(!r.hardFail, `single signal must not hardFail: ${JSON.stringify(r.degraded)}`);
  assert(r.degraded.some((d) => /failover\/parked URL pattern/.test(d)), "the pattern is surfaced as a degraded reason");
});

check("the PAGE URL itself matching a failover token hard-fails outright", () => {
  const r = assessBrandTruth({
    ...KLARNA_HEALTHY,
    url: "https://cdn.klarna.com/sitedownpage/index.html",
  });
  assert(r.hardFail, "page-URL failover token is definitive");
});

check("a bare 'failover'/'maintenance' word in asset paths does NOT fire (dev-infra content, not an outage)", () => {
  const r = assessBrandTruth({
    ...KLARNA_HEALTHY,
    page_images: [
      { src: "https://tailscale.com/blog/failover-diagram.png" },
      { src: "https://tailscale.com/docs/maintenance-windows.png" },
    ],
  });
  assert(r.signals.failover.patterns.length === 0, `compound tokens only, got ${JSON.stringify(r.signals.failover.patterns)}`);
});

check("neutral-only palette with a logo and photos → DEGRADED with a decision-needed accent reason", () => {
  const r = assessBrandTruth({
    ...KLARNA_HEALTHY,
    theme_color: undefined,
    palette: ["#666666", "#999999", "#eeeeee"],
    background_color: "#ffffff",
  });
  assert(!r.hardFail, "not a hard fail — logo and photos carry the brand");
  assert(!r.ok, "but not clean");
  assert(
    r.signals.accent.status !== "ok" && r.degraded.some((d) => /brand color decision needed/.test(d)),
    `accent flagged decision-needed, got ${JSON.stringify(r.signals.accent)}`,
  );
});

check("injected photo verification: dead entries count and surface; all-dead photos complete the destitution triple", () => {
  const degradedOnly = assessBrandTruth(KLARNA_HEALTHY, {
    photos: {
      kept: [{ src: "https://www.klarna.com/assets/hero-shopper.jpg" }],
      dropped: [{ src: "https://www.klarna.com/assets/app-screens.png", reason: "HTTP 404" }],
      verified: 1,
      dead: 1,
      timedOut: 0,
    },
  });
  assert(!degradedOnly.hardFail, "one dead photo is a degradation");
  assert(degradedOnly.degraded.some((d) => /1\/2 page image\(s\) dead/.test(d)), `dead count surfaced: ${JSON.stringify(degradedOnly.degraded)}`);
  assert(degradedOnly.signals.photos.deadUrls.length === 1, "dead URL listed for the caller to drop");

  const allDead = assessBrandTruth(
    {
      url: "https://example-brand.com/",
      title: "Example Brand",
      description: "Widgets.",
      og_image: "https://example-brand.com/og.png",
      headlines: ["Widgets"],
      body_excerpts: ["The best widgets."],
      page_images: [{ src: "https://example-brand.com/dead.jpg" }],
      palette: ["#777777"],
    },
    {
      logo: { status: "undecodable", effectiveUrl: null, rejected: [{ url: "https://example-brand.com/logo.png", reason: "HTML error page served as image" }], deadUrls: ["https://example-brand.com/logo.png"] },
      photos: { kept: [], dropped: [{ src: "https://example-brand.com/dead.jpg", reason: "HTTP 410" }], verified: 0, dead: 1, timedOut: 0 },
    },
  );
  assert(allDead.hardFail, `dead logo + neutral accent + all photos dead = destitution: ${JSON.stringify(allDead.degraded)}`);
});

check("injected logo verification: an undecodable chain degrades with the reason; a decoding fallback keeps status ok", () => {
  const r = assessBrandTruth(KLARNA_HEALTHY, {
    logo: {
      status: "ok",
      effectiveUrl: KLARNA_HEALTHY.apple_touch_icon!,
      rejected: [{ url: KLARNA_HEALTHY.logo_hd!, reason: "HTTP 404" }],
      deadUrls: [KLARNA_HEALTHY.logo_hd!],
    },
  });
  assert(!r.hardFail && r.signals.logo.status === "ok", "fallback that decodes keeps the logo ok");
  assert(r.signals.logo.effectiveUrl === KLARNA_HEALTHY.apple_touch_icon, "effective = the decoding candidate");
  const dead = assessBrandTruth(KLARNA_HEALTHY, {
    logo: {
      status: "undecodable",
      effectiveUrl: null,
      rejected: [{ url: KLARNA_HEALTHY.logo_hd!, reason: "HTML error page served as image" }],
      deadUrls: [KLARNA_HEALTHY.logo_hd!],
    },
  });
  assert(dead.degraded.some((d) => /logo undecodable/.test(d)), `undecodable surfaced: ${JSON.stringify(dead.degraded)}`);
});

check("empty/undefined extract input degrades hard (nothing to assess) without throwing", () => {
  const r = assessBrandTruth(undefined);
  assert(r.hardFail, "an empty extract has nothing brand-true — hard fail");
  assert(typeof r.checkedAt === "string" && r.checkedAt.length > 0, "report is well-formed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
