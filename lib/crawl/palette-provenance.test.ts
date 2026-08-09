/**
 * The crawl threw away its best colour and crowned the wrong font.
 *
 * Measured over 60 live sites on 2026-08-09 (deterministic path only, no model
 * calls). Four defects, all locked here:
 *
 *  1. The palette was assembled LAST-WRITER-WINS: extractPalette read the
 *     stylesheet, then the og:image arm reassigned `palette` in every branch
 *     that succeeded. 6/6 spot-checks came back byte-identical to
 *     `pixelPalette.slice(0,5)` — stripe.com declares #635bff in its own
 *     stylesheet and shipped the ORANGE of its share card.
 *  2. Squarespace's social-links block ships eight SOCIAL-PLATFORM hexes on
 *     every site it builds. #3b5998 (Facebook) sat in the CSS palette of 16 of
 *     the 60 hosts and led it on 8 — small businesses read as Facebook blue.
 *  3. Every font pattern is \b-anchored and real webfonts are CamelCase, so
 *     "SourceCodePro" never matched `source[\s-]*code\b` and a MONOSPACE face
 *     was crowned DISPLAY. `squarespace-ui-font` — Squarespace's own interface
 *     font — was crowned DISPLAY on 13 of 18 Squarespace hosts.
 *  4. The pixel accent guarantee was gated on `chosen.length < maxColors`; the
 *     crawl passes maxColors: 8, which the greedy fill reaches on busy share
 *     cards — the exact images that needed the rescue.
 *
 * Run: `node scripts/run-tests.mjs lib/crawl/palette-provenance.test.ts`.
 * Deterministic — no network, no model calls, no sharp decode.
 */
import {
  mergePaletteByProvenance,
  extractNamedBrandColors,
  classifyFontRoles,
  normalizeFamilyName,
  isHtmlContentType,
  type CrawledFont,
} from "./extract-brand";
import { choosePaletteBuckets, type PixelBucket } from "./vision-brand";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`); }
};
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

const fonts = (...families: string[]): CrawledFont[] =>
  families.map((family) => ({ family, src: `https://x.test/${family}.woff2` }));

// ─── 1. provenance order ──────────────────────────────────────────────

check("the STRIPE case: a share-card hue cannot displace the colour the stylesheet declares", () => {
  // stripe.com: #635bff is in its own CSS; the og:image is a warm orange card.
  const out = mergePaletteByProvenance({
    named: [],
    css: ["#32325d", "#635bff", "#0d1738"],
    icon: [],
    image: ["#ff8f1c", "#f6a623", "#fff4e0", "#2b1a06"],
  });
  assert(out.includes("#635bff"), `brand purple must survive, got ${out.join(" ")}`);
  assert(!out.some((h) => h === "#ff8f1c" || h === "#f6a623"),
    `share-card orange must not enter the palette, got ${out.join(" ")}`);
});

check("a named --brand/--primary/--accent colour outranks the frequency-ranked stylesheet", () => {
  const out = mergePaletteByProvenance({
    named: ["#ff5e1f"],
    css: ["#1d1d1f", "#5b8def"],
    icon: [],
    image: [],
  });
  assert(out[0] === "#ff5e1f", `named var leads, got ${out.join(" ")}`);
});

check("the site's own icon outranks its share card, and both sit under the stylesheet", () => {
  const out = mergePaletteByProvenance({
    named: [],
    css: ["#7a2f1e"],
    icon: ["#00b3a4"],
    image: ["#c0ffee"],
  });
  assert(out[0] === "#7a2f1e" && out[1] === "#00b3a4",
    `css then icon, got ${out.join(" ")}`);
  assert(!out.includes("#c0ffee"), `image tier is corroboration only, got ${out.join(" ")}`);
});

check("no deterministic chroma anywhere → the image tier IS the palette (no yield lost)", () => {
  // The 19% of hosts whose stylesheet is JS-injected: greys only, no icon colour.
  const out = mergePaletteByProvenance({
    named: [],
    css: ["#1a1a1c", "#f2f2f3"],
    icon: [],
    image: ["#d94f2b", "#123456"],
  });
  assert(out.includes("#d94f2b"), `image colours must fill an empty palette, got ${out.join(" ")}`);
});

check("an image colour that CORROBORATES a declared one does not duplicate it — the exact hex is kept", () => {
  const out = mergePaletteByProvenance({
    named: ["#635bff"],
    css: [],
    icon: [],
    image: ["#645cfe"], // the same purple, one step off from the JPEG
  });
  assert(out.length === 1 && out[0] === "#635bff",
    `the declared hex is the authority, got ${out.join(" ")}`);
});

check("theme-color is last, not first (it used to be unshifted to the front)", () => {
  const out = mergePaletteByProvenance({
    named: [],
    css: ["#7a2f1e", "#2f7a1e"],
    icon: [],
    image: [],
    themeColor: "#000080",
  });
  assert(out[out.length - 1] === "#000080", `theme-color trails, got ${out.join(" ")}`);
});

// ─── 2. foreign template colours ──────────────────────────────────────

check("Squarespace's social-block hexes are dropped; the shop's own colour leads", () => {
  // mealsbygenetla.com et al: the measured palette was exactly this order.
  const out = mergePaletteByProvenance({
    named: [],
    css: ["#f0523d", "#3b5998", "#0099e5", "#0063dc", "#4183c4", "#a65e3f"],
    icon: [],
    image: [],
  });
  assert(!out.includes("#3b5998"), `Facebook blue must go, got ${out.join(" ")}`);
  assert(!out.includes("#0063dc") && !out.includes("#4183c4"), `whole social set goes, got ${out.join(" ")}`);
  assert(out[0] === "#a65e3f", `the site's own colour leads, got ${out.join(" ")}`);
});

check("Webflow's default link-blue is dropped (the fusefinance miss, same list)", () => {
  const out = mergePaletteByProvenance({
    named: [], css: ["#3898ec", "#440c12"], icon: [], image: [],
  });
  assert(out[0] === "#440c12", `Webflow blue must not lead, got ${out.join(" ")}`);
});

check("a brand that DECLARES a blocklisted hex as its own keeps it", () => {
  const out = mergePaletteByProvenance({
    named: ["#3b5998"], css: ["#3b5998"], icon: [], image: [],
  });
  assert(out.includes("#3b5998"), `a named brand var wins over the blocklist, got ${out.join(" ")}`);
});

// ─── 3. named custom properties ───────────────────────────────────────

check("reads --brand / --primary / --accent properties, hex and rgb()", () => {
  const css = ":root{--brand-orange:#ff5e1f;--colors-bg-accent:rgb(112,57,226);--gap:12px}";
  const out = extractNamedBrandColors(css);
  assert(out.includes("#ff5e1f"), `hex prop, got ${out.join(" ")}`);
  assert(out.includes("#7039e2"), `rgb() prop, got ${out.join(" ")}`);
});

check("Squarespace's bare HSL triple is a colour (`--accent-hsl: 21.99,100%,31.57%`)", () => {
  // maonoseattle.com, probed 2026-08-09. Squarespace stores the owner's theme
  // pick this way and consumes it as hsla(var(--accent-hsl),1) — not a CSS
  // colour token, so the old reader saw nothing at all on 18 of 60 hosts.
  const out = extractNamedBrandColors(":root{--accent-hsl:21.99,100%,31.57%}");
  assert(out.length === 1, `expected one colour, got ${out.join(" ")}`);
  assert(/^#a1/i.test(out[0]), `deep orange expected, got ${out[0]}`);
});

check("hsla(var(--accent-hsl),1) resolves through the variable table", () => {
  const css = ":root{--accent-hsl:210,80%,50%}.b{--primaryButtonBackgroundColor:hsla(var(--accent-hsl),1)}";
  const out = extractNamedBrandColors(css);
  assert(out.length > 0, "expected a colour");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(out[0].slice(i, i + 2), 16));
  assert(b > g && g > r, `hsl(210,80%,50%) is a blue, got ${out[0]}`);
});

check("near-white and near-black steps of a named ramp are not colours", () => {
  // stripe.com declares --hds-color-core-brand-25:#f5f5ff FIRST.
  const css = ":root{--hds-color-core-brand-25:#f5f5ff;--hds-color-core-brand-500:#635bff;--color-primary-black:#000000}";
  const out = extractNamedBrandColors(css);
  assert(!out.includes("#f5f5ff") && !out.includes("#000000"), `tints/blacks dropped, got ${out.join(" ")}`);
});

check("within a named ramp the VIVID step leads, not the first-declared wash", () => {
  // #d6d9fc is stripe's brand-100 — pale enough to look like a colour and be
  // useless as one. Declared FIRST, so source order would have led with it.
  const css = ":root{--hds-color-core-brand-100:#d6d9fc;--hds-color-core-brand-500:#635bff}";
  const out = extractNamedBrandColors(css);
  assert(out[0] === "#635bff", `the brand hue leads its own tints, got ${out.join(" ")}`);
});

check("a property NAMED brand outranks one named accent (stripe's lemon gradient)", () => {
  // stripe.com: `--hds-color-accentColorMode-lemon-icon-gradientEnd:#ff9014` is a
  // theme-mode illustration gradient and is far more saturated than the brand
  // purple, so vividness alone put an orange at the head of Stripe's palette.
  const css = ":root{--hds-color-accentColorMode-lemon-icon-gradientEnd:#ff9014;--hds-color-core-brand-600:#533afd}";
  const out = extractNamedBrandColors(css);
  assert(out[0] === "#533afd", `the colour named "brand" leads, got ${out.join(" ")}`);
});

check("klarna: --colors-bg-brand (pink) outranks --colors-bg-accent (purple)", () => {
  const css = ":root{--colors-bg-accent:#7039e2;--colors-bg-brand:#ffa8cd}";
  const out = extractNamedBrandColors(css);
  assert(out[0] === "#ffa8cd", `brand before accent, got ${out.join(" ")}`);
});

check("third-party widget properties are not brand colours", () => {
  // --si-primary is Squarespace's social-icon colour (every Squarespace host);
  // --cookiebot-primary-color is a consent widget (toadbakery.com).
  const css = ":root{--si-primary:#3b5998;--cookiebot-primary-color:#0063dc;--swiper-theme-color:#007aff;--brand:#118844}";
  const out = extractNamedBrandColors(css);
  assert(out.length === 1 && out[0] === "#118844", `only the real brand var, got ${out.join(" ")}`);
});

// ─── 4. font classification ───────────────────────────────────────────

check("SourceCodePro is MONO, not the display face (seen in the stored crawls)", () => {
  const roles = classifyFontRoles(fonts("Inter", "SourceCodePro"));
  assert(roles.mono === "SourceCodePro", `mono, got ${JSON.stringify(roles)}`);
  assert(roles.display !== "SourceCodePro", `never display, got ${JSON.stringify(roles)}`);
});

check("JetBrainsMono and GeistMono route to mono too (same CamelCase hole)", () => {
  assert(classifyFontRoles(fonts("Inter", "JetBrainsMono")).mono === "JetBrainsMono", "JetBrainsMono");
  assert(classifyFontRoles(fonts("Inter", "GeistMono")).mono === "GeistMono", "GeistMono");
});

check("normalization only ADDS matches — spaced names still classify as before", () => {
  assert(classifyFontRoles(fonts("Inter", "Source Code Pro")).mono === "Source Code Pro", "spaced mono");
  assert(normalizeFamilyName("IBMPlexMono") === "IBM Plex Mono", normalizeFamilyName("IBMPlexMono"));
  assert(normalizeFamilyName("SourceCodePro") === "Source Code Pro", normalizeFamilyName("SourceCodePro"));
});

check("KaTeX_* library fonts stay excluded (the underscore form must not regress)", () => {
  const roles = classifyFontRoles(fonts("KaTeX_Main", "KaTeX_Caligraphic", "Inter"));
  assert(roles.display !== "KaTeX_Main" && roles.body !== "KaTeX_Main", `KaTeX out, got ${JSON.stringify(roles)}`);
  assert(roles.body === "Inter", `Inter is the face, got ${JSON.stringify(roles)}`);
});

check("squarespace-ui-font is chrome: the site's real face takes display", () => {
  // wildginger.net / mightyfineburgers.com / maonoseattle.com — measured
  // {"body":"Montserrat","display":"squarespace-ui-font"} before this change.
  const roles = classifyFontRoles(fonts("Montserrat", "squarespace-ui-font", "social-icon-font"));
  assert(roles.display !== "squarespace-ui-font", `not display, got ${JSON.stringify(roles)}`);
  assert(roles.body === "Montserrat" && roles.display === "Montserrat", `real face, got ${JSON.stringify(roles)}`);
});

check("a Squarespace site with ONLY the UI font reports no font at all, honestly", () => {
  const roles = classifyFontRoles(fonts("squarespace-ui-font", "social-icon-font"));
  assert(!roles.display && !roles.body && !roles.mono, `nothing usable, got ${JSON.stringify(roles)}`);
});

check("video.js's player font and Wix's hashed alias are not brand faces", () => {
  // toadbakery.com shipped {"body":"VideoJS"}; redbamboo-nyc.com shipped
  // {"body":"wf_36dfb692240b4f9a8a0a33393"} — an opaque hash nothing can render.
  assert(classifyFontRoles(fonts("VideoJS", "Inter")).body === "Inter",
    `VideoJS out, got ${JSON.stringify(classifyFontRoles(fonts("VideoJS", "Inter")))}`);
  const wix = classifyFontRoles(fonts("wf_36dfb692240b4f9a8a0a33393", "wf_68dc41178c3845019e01d29bf"));
  assert(!wix.body && !wix.display, `hashed aliases out, got ${JSON.stringify(wix)}`);
});

check("a var() reference is not a font family (arc.net / Framer ship these)", () => {
  const roles = classifyFontRoles(fonts("var(--fonts-sans)", "Sohne Breit"));
  assert(roles.body === "Sohne Breit", `placeholder skipped, got ${JSON.stringify(roles)}`);
});

// ─── 5. the pixel accent guarantee ────────────────────────────────────

const bucket = (n: number, r: number, g: number, b: number): PixelBucket => ({ n, r, g, b });

check("a full 8-colour pick still surfaces the small vivid accent (the dead guard)", () => {
  // Nine well-separated near-neutrals fill the greedy pick to maxColors: 8, then
  // a 2%-of-pixels vivid red — a brand button on a busy share card.
  const reps: PixelBucket[] = [
    bucket(300, 250, 250, 250), bucket(280, 220, 220, 218), bucket(260, 190, 190, 188),
    bucket(240, 160, 160, 158), bucket(220, 130, 130, 128), bucket(200, 100, 100, 98),
    bucket(180, 70, 70, 68), bucket(160, 40, 40, 38), bucket(140, 12, 12, 10),
    bucket(40, 214, 31, 31),
  ];
  const total = reps.reduce((s, c) => s + c.n, 0);
  const out = choosePaletteBuckets(reps, 8, total);
  assert(out.length === 8, `maxColors is still honoured, got ${out.length}`);
  assert(out.some((c) => c.r === 214 && c.g === 31), `the accent must be in, got ${JSON.stringify(out)}`);
  assert(!out.some((c) => c.r === 40), `it displaces the weakest member, got ${JSON.stringify(out)}`);
});

check("an accent below the 1% floor is still noise, not a brand colour", () => {
  // Same nine-neutral fill as above so the greedy pick is FULL and the red can
  // only arrive via the rescue — at 5 of ~2000 pixels it must not.
  const reps: PixelBucket[] = [
    bucket(300, 250, 250, 250), bucket(280, 220, 220, 218), bucket(260, 190, 190, 188),
    bucket(240, 160, 160, 158), bucket(220, 130, 130, 128), bucket(200, 100, 100, 98),
    bucket(180, 70, 70, 68), bucket(160, 40, 40, 38), bucket(140, 12, 12, 10),
    bucket(5, 214, 31, 31),
  ];
  const out = choosePaletteBuckets(reps, 8, reps.reduce((s, c) => s + c.n, 0));
  assert(!out.some((c) => c.r === 214), `sub-1% stays out, got ${JSON.stringify(out)}`);
});

check("an image that already has a vivid colour is untouched", () => {
  const reps: PixelBucket[] = [bucket(500, 214, 31, 31), bucket(400, 250, 250, 250)];
  const out = choosePaletteBuckets(reps, 8, 900);
  assert(out.length === 2, `no spurious append, got ${JSON.stringify(out)}`);
});

// ─── 6. the HTML content-type gate ────────────────────────────────────

check("text/markdown is not a page we parsed (ramp.com answers this UA with it)", () => {
  assert(isHtmlContentType("text/markdown; charset=utf-8") === false, "markdown rejected");
  assert(isHtmlContentType("application/json") === false, "json rejected");
});

check("real HTML content-types pass, and a missing one is tolerated", () => {
  assert(isHtmlContentType("text/html; charset=UTF-8"), "text/html");
  assert(isHtmlContentType("application/xhtml+xml"), "xhtml");
  assert(isHtmlContentType(""), "absent header tolerated");
  assert(isHtmlContentType(null), "null header tolerated");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
