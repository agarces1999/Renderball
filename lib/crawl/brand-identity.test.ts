/**
 * Regression tests for pickSignatureColor (QA finding C1).
 *
 * Run: `npm test`. Locks the fix for the brand-fidelity failure where the
 * design agent led with the dark/neutral that covered the most pixels (Fuse
 * maroon, Tony's brown) instead of the brand's actual hue (Fuse blue, Tony's
 * red). No API key, no network.
 */
import {
  pickSignatureColor,
  dominantSvgColor,
  signatureWithLogoFallback,
  resolveBrandIdentity,
  genericFor,
  deriveBrandName,
  brandShortName,
  brandNameFromTitle,
  looksLikeTagline,
  resolveCanvasPlan,
  canvasBrandFidelityAdvisory,
} from "./brand-identity";
import { buildAgentInputFromBrief } from "../agents/pipeline";

// Real palettes captured from the QA sweep.
const FUSE = ["#440b12", "#2c060b", "#5e131c", "#ff8c42", "#ecf3fb", "#1e5fb8"];
const TONYS = ["#eb0000", "#006be1", "#ffed00", "#ff7400"];
const MONO = ["#000000", "#fdfdfd", "#b8b8b8", "#d7d7d7", "#979797"]; // Liquid Death
// corgi.insure: a Webflow site whose crawl returned only greys — the brand's
// orange survived nowhere but the logo SVG (QA G1).
const CORGI_GREYS = ["#f6f6f6", "#e8e8e8", "#c7c7c7", "#6b6b6b", "#1c1c1e"];

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// ── The bug: leading with the dark neutral instead of the brand hue ──────
check("Fuse → the blue brand hue, NOT the dark maroon", () => {
  const sig = pickSignatureColor(FUSE);
  assert(sig === "#1e5fb8", `expected #1e5fb8, got ${sig}`);
});

check("Fuse → never a near-black/deep-shade neutral", () => {
  const sig = pickSignatureColor(FUSE);
  assert(
    sig !== null && !["#440b12", "#2c060b", "#5e131c"].includes(sig),
    `got a dark neutral: ${sig}`,
  );
});

// ── theme_color is the most authoritative signal ─────────────────────────
check("chromatic theme_color wins (Tony's red)", () => {
  const sig = pickSignatureColor(TONYS, "#eb0000");
  assert(sig === "#eb0000", `expected #eb0000, got ${sig}`);
});

check("a NEUTRAL theme_color is ignored → falls back to a vivid palette hue", () => {
  const sig = pickSignatureColor(FUSE, "#000000");
  assert(sig === "#1e5fb8", `expected #1e5fb8, got ${sig}`);
});

// ── Monochrome brands keep their monochrome (never invent a color) ────────
check("monochrome brand (Liquid Death) → null", () => {
  assert(pickSignatureColor(MONO) === null, "expected null for greyscale palette");
});

// ── Even the imperfect fallback beats a brown neutral ────────────────────
check("Tony's without theme_color → a vivid chromatic color, not brown", () => {
  const sig = pickSignatureColor(TONYS);
  assert(sig !== null, "should pick a color");
  assert(
    ["#ff7400", "#eb0000", "#006be1"].includes(sig as string),
    `expected a saturated brand color, got ${sig}`,
  );
});

// ── Degenerate inputs ────────────────────────────────────────────────────
check("empty / garbage palette → null", () => {
  assert(pickSignatureColor([]) === null, "empty → null");
  assert(pickSignatureColor(["not-a-color", "#zzz"]) === null, "garbage → null");
});

// ── G1: dominantSvgColor — pull the brand hue out of the logo markup ──────
const CORGI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">
  <path fill="#f47b20" d="M10 8h22v22H10z"/>
  <text fill="#1c1c1e" x="40" y="26">corgi</text>
</svg>`;
const MONO_SVG = `<svg viewBox="0 0 100 40"><path fill="#1c1c1e" d="M0 0h10v10H0z"/><rect fill="#ffffff" x="20" width="10" height="10"/></svg>`;
const RGB_SVG = `<svg><defs><linearGradient><stop stop-color="rgb(0, 122, 255)"/></linearGradient></defs><rect fill="#000000"/></svg>`;
const HEX3_SVG = `<svg><path fill="#f60"/><text fill="#111">x</text></svg>`; // #f60 → #ff6600

check("corgi logo SVG → the orange mark, NOT the near-black text", () => {
  assert(dominantSvgColor(CORGI_SVG) === "#f47b20", `expected #f47b20, got ${dominantSvgColor(CORGI_SVG)}`);
});

check("monochrome logo SVG (black + white only) → null", () => {
  assert(dominantSvgColor(MONO_SVG) === null, `expected null, got ${dominantSvgColor(MONO_SVG)}`);
});

check("rgb() stop-color is parsed → #007aff", () => {
  assert(dominantSvgColor(RGB_SVG) === "#007aff", `expected #007aff, got ${dominantSvgColor(RGB_SVG)}`);
});

check("3-digit hex is expanded → #ff6600", () => {
  assert(dominantSvgColor(HEX3_SVG) === "#ff6600", `expected #ff6600, got ${dominantSvgColor(HEX3_SVG)}`);
});

check("empty / colorless SVG → null", () => {
  assert(dominantSvgColor("") === null, "empty → null");
  assert(dominantSvgColor("<svg><rect/></svg>") === null, "no colors → null");
});

// ── G1: signatureWithLogoFallback — palette wins, logo is the fallback ─────
check("achromatic palette + orange logo → the logo orange (corgi)", () => {
  const sig = signatureWithLogoFallback(CORGI_GREYS, undefined, "#f47b20");
  assert(sig === "#f47b20", `expected #f47b20, got ${sig}`);
});

check("chromatic palette wins over the logo color (palette is authoritative)", () => {
  const sig = signatureWithLogoFallback(FUSE, undefined, "#f47b20");
  assert(sig === "#1e5fb8", `expected the palette blue #1e5fb8, got ${sig}`);
});

check("monochrome brand with no logo color → null (never invent)", () => {
  assert(signatureWithLogoFallback(MONO, undefined, undefined) === null, "expected null");
});

check("a grey/neutral logo color is NOT a valid fallback → null", () => {
  assert(signatureWithLogoFallback(MONO, undefined, "#cccccc") === null, "grey logo → null");
  assert(signatureWithLogoFallback(MONO, undefined, "not-a-hex") === null, "garbage logo → null");
});

// ── genericFor — the CSS generic fallback per font family (corgi bug) ─────
// f37Bolton is a grotesque SANS; the design agent shipped `'"f37Bolton", serif'`
// so when the cross-origin web font failed to load the headline fell back to a
// SERIF. genericFor is the single source of truth — a sans must degrade to
// `sans-serif`, a text serif to `serif`, a code face to `monospace`.
check("f37Bolton (grotesque sans) → sans-serif, NOT serif", () => {
  assert(genericFor("f37Bolton") === "sans-serif", `got ${genericFor("f37Bolton")}`);
});
check("Geist → sans-serif", () => {
  assert(genericFor("Geist") === "sans-serif", `got ${genericFor("Geist")}`);
});
check("Geist Mono → monospace", () => {
  assert(genericFor("Geist Mono") === "monospace", `got ${genericFor("Geist Mono")}`);
});
check("Inter → sans-serif", () => {
  assert(genericFor("Inter") === "sans-serif", `got ${genericFor("Inter")}`);
});
check("Montserrat (no style signal) → sans-serif, never serif by default", () => {
  // Display faces are overwhelmingly sans; defaulting an unknown to serif is
  // exactly the bug. The classifier must land on sans-serif here.
  assert(genericFor("Montserrat") === "sans-serif", `got ${genericFor("Montserrat")}`);
});
check("Playfair Display → serif", () => {
  assert(genericFor("Playfair Display") === "serif", `got ${genericFor("Playfair Display")}`);
});
check("Tiempos Text → serif", () => {
  assert(genericFor("Tiempos Text") === "serif", `got ${genericFor("Tiempos Text")}`);
});
check("Fraunces → serif", () => {
  assert(genericFor("Fraunces") === "serif", `got ${genericFor("Fraunces")}`);
});
check("JetBrains Mono → monospace", () => {
  assert(genericFor("JetBrains Mono") === "monospace", `got ${genericFor("JetBrains Mono")}`);
});

// ── currentColor logo → null signature (linear.app, June 2026) ────────────
// linear.app's logo SVG paints with fill="currentColor", the crawled palette
// is pure greyscale, and logo_color was absent — recolorMonochromeLogo baked a
// near-black ink into the mark, but resolveBrandIdentity derived the signature
// from the ORIGINAL null crawl field, so the video shipped accidentally grey.
const LINEAR_GREYS = ["#161719", "#fbfbfb", "#d7d7d7"];
const LINEAR_SVG = `<svg width="100" height="100" viewBox="0 0 100 100" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228Z"/></svg>`;
// A mark with a REAL chromatic fill plus a currentColor wordmark — the recolor
// fires (currentColor present), but the brand color lives in the original SVG.
const CHROMATIC_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><path fill="#f47b20" d="M10 8h22v22H10z"/><text fill="currentColor" x="40" y="26">corgi</text></svg>`;

const svgDataUrl = (svg: string): string =>
  "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const decodeLogoUrl = (url: string): string =>
  Buffer.from(url.split(",")[1] ?? "", "base64").toString("utf-8");

check("chromatic SVG logo → signature = the extracted color, even after recolor", () => {
  const id = resolveBrandIdentity({
    url: "https://corgi.insure",
    palette: CORGI_GREYS,
    logo_hd: svgDataUrl(CHROMATIC_MARK_SVG),
    logo_confidence: 0.9,
  });
  assert(id.signature === "#f47b20", `expected #f47b20, got ${id.signature}`);
  assert(id.signature_missing === undefined, "flag must be absent when a signature exists");
  // The recolor decision really happened (currentColor → palette ink) — the
  // signature must come from the PRE-recolor markup regardless.
  const svg = decodeLogoUrl(id.logo!.url);
  assert(!/currentColor/i.test(svg), "currentColor should be baked to a real ink");
});

check("fresh logo extraction beats a STALE crawl logo_color field", () => {
  const id = resolveBrandIdentity({
    url: "https://corgi.insure",
    palette: CORGI_GREYS,
    logo_hd: svgDataUrl(CHROMATIC_MARK_SVG),
    logo_confidence: 0.9,
    logo_color: "#1e5fb8", // stale — extracted from a different candidate
  });
  assert(id.signature === "#f47b20", `expected the fresh #f47b20, got ${id.signature}`);
});

check("linear.app: currentColor logo + achromatic palette → signature_missing", () => {
  const id = resolveBrandIdentity({
    url: "https://linear.app",
    title: "Linear – Plan and build products",
    palette: LINEAR_GREYS,
    logo_hd: svgDataUrl(LINEAR_SVG),
    logo_confidence: 0.9,
    // logo_color absent — the empirical crawl shape
  });
  assert(id.signature === null, `expected null, got ${id.signature}`);
  assert(id.signature_missing === true, "must surface the no-chroma condition explicitly");
  // The recolor still happened (the mark must not render invisible) — it just
  // can't masquerade as a brand signature.
  const svg = decodeLogoUrl(id.logo!.url);
  assert(svg.includes("#161719") && !/currentColor/i.test(svg), "ink baked into the mark");
});

check("currentColor logo + ONE saturated palette accent → the accent wins", () => {
  const id = resolveBrandIdentity({
    url: "https://linear.app",
    palette: ["#161719", "#fbfbfb", "#5e6ad2"], // Linear's actual brand purple
    logo_hd: svgDataUrl(LINEAR_SVG),
    logo_confidence: 0.9,
  });
  assert(id.signature === "#5e6ad2", `expected #5e6ad2, got ${id.signature}`);
  assert(id.signature_missing === undefined, "flag must be absent when a signature exists");
});

// ── rescue pass: a deep saturated shade beats shipping grey ───────────────
check("a deep out-of-band saturated shade is rescued before declaring monochrome", () => {
  // #7a0c12 (wine red): lum 0.14 fails the strict 0.15 floor, but sat 0.90 —
  // it IS the brand's chroma when the rest of the palette is grey.
  const sig = signatureWithLogoFallback(["#161719", "#fbfbfb", "#7a0c12"], undefined, undefined);
  assert(sig === "#7a0c12", `expected #7a0c12, got ${sig}`);
});

check("rescue never invents color from true greys (Liquid Death stays null)", () => {
  assert(signatureWithLogoFallback(MONO, undefined, undefined) === null, "greys → null");
  assert(signatureWithLogoFallback(LINEAR_GREYS, undefined, undefined) === null, "linear greys → null");
});

// ── logo_confidence survives the build mapping (trust path end-to-end) ──
//
// The agentic finder's confidence was dropped by buildAgentInputFromBrief
// (AgentBrandExtract had no logo_confidence field), so pickLogo fell into the
// legacy regex branch on EVERY build — a vetted 0.95 pick whose URL contains a
// reject word ("card", "nav", "share") was silently nulled to the wordmark,
// exactly what the trust path exists to prevent. Test through the REAL mapping.
// A URL the regexes hate: "card" (SHARE_IMG_RX) + "nav" (UI_GLYPH_RX).
const REGEX_HOSTILE_LOGO = "https://cdn.example.com/nav-card-logo.png";
const briefWith = (confidence: number | undefined) =>
  ({
    brand_kit_url: "https://example.com",
    brand_extract: {
      ok: true,
      url: "https://example.com",
      logo_hd: REGEX_HOSTILE_LOGO,
      ...(confidence !== undefined ? { logo_confidence: confidence } : {}),
      palette: FUSE,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const minimalScript = { scenes: [], config: {} } as any;

check("a confident pick with a reject-regex URL survives the mapping", () => {
  const input = buildAgentInputFromBrief(briefWith(0.95), minimalScript);
  assert(
    input.brand_extract?.logo_confidence === 0.95,
    `confidence dropped in mapping: ${JSON.stringify(input.brand_extract?.logo_confidence)}`,
  );
  assert(
    input.brand_identity?.logo?.url === REGEX_HOSTILE_LOGO,
    `trust path should keep the vetted pick, got ${JSON.stringify(input.brand_identity?.logo)}`,
  );
});

check("the same URL with NO confidence is still re-litigated by the regexes", () => {
  const input = buildAgentInputFromBrief(briefWith(undefined), minimalScript);
  assert(
    input.brand_identity?.logo == null,
    `legacy pre-finder briefs must keep the regex filter, got ${JSON.stringify(input.brand_identity?.logo)}`,
  );
});

// ── brand SHORT NAME — the single source of truth (Audit-1 P0 #1) ────────────
check("brandShortName: the Faire leak — a 'Tagline - Brand' title → the brand", () => {
  // The exact defect: title = the whole tagline + brand, spaced-hyphen separator.
  assert(
    brandShortName({ url: "https://faire.com", title: "Your one-stop shop for wholesale - Faire" }) === "Faire",
    `expected Faire, got ${brandShortName({ url: "https://faire.com", title: "Your one-stop shop for wholesale - Faire" })}`,
  );
});

check("brandShortName tagline guard: a title that is ONLY a tagline → hostname", () => {
  // No brand segment at all; the hostname is the only real name (capitalized).
  assert(
    brandShortName({ url: "https://faire.com/wholesale", title: "Your one-stop shop for whole" }) === "Faire",
    `tagline-only title must fall back to the hostname, got ${brandShortName({ url: "https://faire.com/wholesale", title: "Your one-stop shop for whole" })}`,
  );
});

check("brandShortName: Brex colon title → 'Brex' (host-matched)", () => {
  assert(
    brandShortName({ url: "https://brex.com", title: "Brex: The Modern Finance Software" }) === "Brex",
    `expected Brex, got ${brandShortName({ url: "https://brex.com", title: "Brex: The Modern Finance Software" })}`,
  );
});

check("brandShortName: 'Tagline | Brand' (Fuse) → the host-matched brand", () => {
  assert(
    brandShortName({ url: "https://fusefinance.com", title: "AI-Powered Loan Origination Software | Fuse" }) === "Fuse",
    `expected Fuse, got ${brandShortName({ url: "https://fusefinance.com", title: "AI-Powered Loan Origination Software | Fuse" })}`,
  );
});

check("brandShortName: clean short titles pass through unchanged", () => {
  assert(brandShortName({ url: "https://vanta.com", title: "Vanta" }) === "Vanta", "clean single-word");
  assert(
    brandShortName({ url: "https://liquiddeath.com", title: "Liquid Death" }) === "Liquid Death",
    "clean two-word brand unchanged",
  );
  // No usable title → capitalized hostname.
  assert(brandShortName({ url: "https://deel.com" }) === "Deel", "no title → hostname");
  assert(brandShortName(undefined) === "Brand", "nothing → Brand");
});

check("brandShortName: never exceeds the wordmark cap (a leak can't fill a lockup)", () => {
  const n = brandShortName({ title: "A very very long marketing sentence that is not a name at all" });
  assert(n.length <= 20, `capped ≤20, got ${JSON.stringify(n)} (${n.length})`);
});

check("looksLikeTagline: brand words safe, connective sentences caught", () => {
  assert(!looksLikeTagline("Faire"), "Faire is a name");
  assert(!looksLikeTagline("Shopify"), "Shopify — no \\bshop\\b boundary");
  assert(!looksLikeTagline("Liquid Death"), "two-word brand");
  assert(looksLikeTagline("Your one-stop shop"), "connective + word count");
  assert(looksLikeTagline("The Modern Finance Software"), "leading determiner");
});

check("brandNameFromTitle: matches the wordmark path without a hostname", () => {
  assert(brandNameFromTitle("Your one-stop shop for wholesale - Faire") === "Faire", "brand segment");
  assert(brandNameFromTitle("Ben & Jerry's") === "Ben & Jerry's", "ampersand brand kept");
  assert(brandNameFromTitle("") === "", "empty → empty");
});

check("deriveBrandName is the same SSOT surface brandShortName wraps", () => {
  assert(
    deriveBrandName({ url: "https://brex.com", title: "Brex: tagline" }) ===
      brandShortName({ url: "https://brex.com", title: "Brex: tagline" }),
    "brandShortName delegates to deriveBrandName",
  );
});

// ── R1 (audit-2): resolveCanvasPlan — crawl bg wins; palette fallback biases LIGHT ──
check("resolveCanvasPlan: an extracted crawl background is authoritative (light stays light)", () => {
  const p = resolveCanvasPlan({ background_color: "#ffffff", palette: ["#15191e", "#ff5900"] });
  assert(p.background === "#ffffff" && p.source === "crawl" && p.mode === "light", `crawl light bg wins, got ${JSON.stringify(p)}`);
});

check("resolveCanvasPlan: a dark crawl background stays dark", () => {
  const p = resolveCanvasPlan({ background_color: "#0b0e13", palette: ["#f5f8fa"] });
  assert(p.background === "#0b0e13" && p.mode === "dark", `dark crawl bg wins, got ${JSON.stringify(p)}`);
});

check("resolveCanvasPlan: palette fallback BIASES toward LIGHT when a light token exists (R1)", () => {
  // No crawl bg. A prominence-ordered palette whose FIRST extreme is a dark brand
  // token but which also carries a light token: pre-R1 picked the (earlier) dark
  // extreme; R1 prefers the light one so a light brand no longer ships dark.
  const p = resolveCanvasPlan({ palette: ["#0a0a0a", "#ff5900", "#fbfbfd"] });
  assert(p.mode === "light" && p.background === "#fbfbfd", `light-biased fallback, got ${JSON.stringify(p)}`);
});

check("resolveCanvasPlan: a genuinely DARK-only palette still resolves dark", () => {
  const p = resolveCanvasPlan({ palette: ["#0a0a0a", "#171717", "#3a3a3a"] });
  assert(p.mode === "dark" && p.source === "palette", `dark-only palette stays dark, got ${JSON.stringify(p)}`);
});

check("resolveCanvasPlan: no usable palette → white default", () => {
  const p = resolveCanvasPlan({ palette: ["#7f7f7f"] }); // mid-tone only, no extreme
  assert(p.background === "#ffffff" && p.source === "default", `default white, got ${JSON.stringify(p)}`);
});

// ── R3 (audit-3): canvas white-default when the palette is not dark-dominant ──
check("resolveCanvasPlan: Rappi (bright brand, lone dark neutral) → WHITE, not the navy token", () => {
  // Real Rappi palette: orange (mid), one dark neutral (#16242b — the only token
  // clearing the extremity gate), a steel-blue (#88a8c5, lum 0.64). Pre-R3 the
  // dark neutral was promoted to full-canvas; R3 sees the light steel member and
  // defaults to white rather than paint the orange brand on navy.
  const p = resolveCanvasPlan({ palette: ["#ff5b23", "#16242b", "#88a8c5"] });
  assert(p.background === "#ffffff" && p.source === "default" && p.mode === "light", `Rappi → white, got ${JSON.stringify(p)}`);
});

check("resolveCanvasPlan: a genuinely DARK-rooted brand (CSS bg) STAYS dark (Scale/Vanta class)", () => {
  // Scale AI #000 / Vanta plum set a rooted CSS background → the crawl path wins
  // before the palette fallback, so R3 never lightens them.
  const scale = resolveCanvasPlan({ background_color: "#000000", palette: ["#ffffff", "#000000"] });
  assert(scale.mode === "dark" && scale.source === "crawl", `Scale #000 stays dark, got ${JSON.stringify(scale)}`);
  const vanta = resolveCanvasPlan({ background_color: "#1a0d24", palette: ["#c8ff00", "#1a0d24"] });
  assert(vanta.mode === "dark" && vanta.source === "crawl", `Vanta plum stays dark, got ${JSON.stringify(vanta)}`);
});

check("resolveCanvasPlan: dark token + a SUB-extremity mid-light member → white (not the dark extreme)", () => {
  // The mid token (#8f9fb0, lum ~0.6) sits below the extremity gate so it never
  // QUALIFIES as the canvas — but its presence proves the brand isn't dark, so R3
  // defaults to white rather than promote the lone dark neutral. (A QUALIFYING
  // light token instead wins outright via the light-bias prior — covered above.)
  const p = resolveCanvasPlan({ palette: ["#16242b", "#8f9fb0"] });
  assert(p.background === "#ffffff" && p.source === "default", `sub-extremity light member → white, got ${JSON.stringify(p)}`);
});

// ── R3 (audit-3): the brand-fidelity advisory (dark canvas vs bright accent) ──
check("canvasBrandFidelityAdvisory: dark canvas + bright saturated accent → advisory", () => {
  const adv = canvasBrandFidelityAdvisory({ background: "#16242b", source: "palette", mode: "dark" }, "#ff5b23");
  assert(!!adv && /DARK/.test(adv), `expected an advisory string, got ${JSON.stringify(adv)}`);
});
check("canvasBrandFidelityAdvisory: a LIGHT canvas never advises", () => {
  assert(canvasBrandFidelityAdvisory({ background: "#ffffff", source: "default", mode: "light" }, "#ff5b23") === undefined, "light canvas → no advisory");
});
check("canvasBrandFidelityAdvisory: dark canvas + a MUTED dark accent → no advisory", () => {
  assert(canvasBrandFidelityAdvisory({ background: "#111318", source: "crawl", mode: "dark" }, "#2a2f38") === undefined, "muted accent → no advisory");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
