/**
 * Regression tests for classifyFontRoles (QA G2) and for the USE-based display
 * pick that replaced the name-only one.
 *
 * Run: `node scripts/run-tests.mjs lib/crawl/font-roles.test.ts`. No API key,
 * no network — every fixture below is the real shape read off the named site
 * through the brand truth set's byte cache on 2026-08-09, with the counts
 * copied verbatim so a test that goes red is telling you about that site.
 */
import { classifyFontRoles, extractFonts, type CrawledFont } from "./extract-brand";
import { annotateFontUsage, extractFontUsage } from "./font-roles";

const f = (family: string): CrawledFont => ({ family, src: `${family}.woff2` });

/** A face plus what the site's CSS was measured to put it on. */
const used = (
  family: string,
  heading: number,
  body: number,
  headingTokens = 0,
): CrawledFont => ({
  family,
  src: `${family}.woff2`,
  ...(heading ? { heading_uses: heading } : {}),
  ...(body ? { body_uses: body } : {}),
  ...(headingTokens ? { heading_tokens: headingTokens } : {}),
});

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

// ── The bug: a system-named self-hosted serif beat the real display face ──────
check("corgi: distinctive f37Bolton wins display over self-hosted georgia", () => {
  const roles = classifyFontRoles([f("Geist"), f("georgia"), f("f37Bolton")]);
  assert(roles.display === "f37Bolton", `display: expected f37Bolton, got ${roles.display}`);
  assert(roles.body === "Geist", `body: expected Geist, got ${roles.body}`);
});

check("a self-hosted 'times new roman' loses to a distinctive custom face too", () => {
  const roles = classifyFontRoles([f("Inter"), f("Times New Roman"), f("Druk Wide")]);
  // Druk is a known display family AND distinctive → it should win.
  assert(roles.display === "Druk Wide", `expected Druk Wide, got ${roles.display}`);
});

// ── Unchanged behavior: a genuine licensed display serif still wins ───────────
check("genuine display serif (Playfair) still becomes display", () => {
  const roles = classifyFontRoles([f("Inter"), f("Playfair Display")]);
  assert(roles.display === "Playfair Display", `expected Playfair Display, got ${roles.display}`);
  assert(roles.body === "Inter", `expected Inter body, got ${roles.body}`);
});

check("licensed serifs we DON'T treat as system (Garamond) still win display", () => {
  const roles = classifyFontRoles([f("Helvetica Neue"), f("Garamond")]);
  assert(roles.display === "Garamond", `expected Garamond, got ${roles.display}`);
});

check("distinctive slab/display name (SuperClarendon) wins over the body sans", () => {
  const roles = classifyFontRoles([f("Acumin Pro"), f("SuperClarendon")]);
  assert(roles.display === "SuperClarendon", `expected SuperClarendon, got ${roles.display}`);
  assert(roles.body === "Acumin Pro", `expected Acumin Pro body, got ${roles.body}`);
});

// ── System serif with NO distinctive alternative → keep it (it's all we have) ──
check("georgia stays display when it's the only non-body face", () => {
  const roles = classifyFontRoles([f("Geist"), f("georgia")]);
  assert(roles.display === "georgia", `expected georgia (only option), got ${roles.display}`);
  assert(roles.body === "Geist", `expected Geist body, got ${roles.body}`);
});

// ── Mono + icon-font routing still hold alongside the new display logic ────────
check("mono is pulled out; display still resolves to the custom face", () => {
  const roles = classifyFontRoles([f("Geist"), f("JetBrains Mono"), f("georgia"), f("f37Bolton")]);
  assert(roles.mono === "JetBrains Mono", `expected mono JetBrains Mono, got ${roles.mono}`);
  assert(roles.display === "f37Bolton", `expected f37Bolton display, got ${roles.display}`);
  assert(roles.body === "Geist", `expected Geist body, got ${roles.body}`);
});

check("icon fonts are skipped, not routed to display", () => {
  const roles = classifyFontRoles([f("webflow-icons"), f("Geist"), f("f37Bolton")]);
  assert(roles.display === "f37Bolton", `expected f37Bolton, got ${roles.display}`);
  assert(roles.body === "Geist", `expected Geist, got ${roles.body}`);
});

// ── Degenerate input ──────────────────────────────────────────────────────────
check("single face → it's the body, display falls back to the same", () => {
  const roles = classifyFontRoles([f("Geist")]);
  assert(roles.body === "Geist", `expected Geist body, got ${roles.body}`);
});

// ── Font URL resolution — resolve url() against the STYLESHEET, not the page ──
// Locks the corgi f37Bolton bug: a relative `url(../media/x.otf)` in a sub-path
// stylesheet must keep the sub-path (→ /_next/static/media/x.otf), not collapse
// to the page root (→ /media/x.otf, which 404s).
const corgiFace = `@font-face { font-family: "f37Bolton"; src: url(../media/f37_bolton_light.0o6osq.otf) format("opentype"); font-weight: 300; }`;

check("relative font url() resolves against the stylesheet URL (keeps /_next/static)", () => {
  const out = extractFonts(corgiFace, "https://corgi.insure/_next/static/css/app.abc.css");
  assert(out.length === 1, `expected 1 font, got ${out.length}`);
  assert(
    out[0].src === "https://corgi.insure/_next/static/media/f37_bolton_light.0o6osq.otf",
    `expected /_next/static/media path, got ${out[0].src}`,
  );
});

check("resolving the SAME face against the page root drops the path (the bug)", () => {
  // documents the old behavior the fix avoids: page-base resolution → /media/ (404)
  const out = extractFonts(corgiFace, "https://corgi.insure/");
  assert(out[0].src === "https://corgi.insure/media/f37_bolton_light.0o6osq.otf", `got ${out[0].src}`);
});

check("absolute font url() is unaffected by the base", () => {
  const face = `@font-face { font-family: "Geist"; src: url(https://cdn.example.com/geist.woff2) format("woff2"); }`;
  const out = extractFonts(face, "https://corgi.insure/_next/static/css/app.css");
  assert(out[0].src === "https://cdn.example.com/geist.woff2", `got ${out[0].src}`);
});

check("root-absolute path resolves against the origin (not the sheet dir)", () => {
  const face = `@font-face { font-family: "Brand"; src: url(/fonts/brand.woff2) format("woff2"); }`;
  const out = extractFonts(face, "https://x.com/_next/static/css/a.css");
  assert(out[0].src === "https://x.com/fonts/brand.woff2", `got ${out[0].src}`);
});

// ── What the site's CSS says it PUTS each face on ─────────────────────────────

check("a heading rule and a body rule are counted apart", () => {
  const u = extractFontUsage(`h1{font-family:"Brand Display"} p{font-family:"Brand Text"}`);
  assert(u.heading.get("brand display") === 1, `heading: ${[...u.heading]}`);
  assert(u.body.get("brand text") === 1, `body: ${[...u.body]}`);
});

check("@font-face DECLARES, it does not use — those blocks are not counted", () => {
  const u = extractFontUsage(`@font-face{font-family:"Ghost";src:url(g.woff2)} h1{font-family:"Real"}`);
  assert(!u.heading.has("ghost"), "a downloaded face must not count as a used one");
  assert(u.heading.get("real") === 1, `heading: ${[...u.heading]}`);
});

// resend.com needs two hops: rule → --font-display → --font-abc-favorit → name.
// Spelled here with a role-NEUTRAL middle token so this test measures the chain
// and nothing else.
check("var() chains are followed to the family (resend.com's two hops)", () => {
  const u = extractFontUsage(
    `:root{--font-abc-favorit:"aBCFavorit";--font-brand:var(--font-abc-favorit),ui-sans-serif}
     h1{font-family:var(--font-brand)}`,
  );
  assert(u.heading.get("abcfavorit") === 1, `heading: ${[...u.heading]}`);
});

// Deliberate, and worth locking because it looks like a bug: resend's real
// spelling names the token `--font-display` AND puts it on `.font-display`, and
// the family is counted twice — once because the site called it the display
// font, once because a selector uses it. Two independent statements, two counts.
check("naming a token AND using it counts as both intent and practice", () => {
  const u = extractFontUsage(
    `:root{--font-abc-favorit:"aBCFavorit";--font-display:var(--font-abc-favorit),ui-sans-serif}
     .font-display{font-family:var(--font-display)}`,
  );
  assert(u.heading.get("abcfavorit") === 2, `heading: ${[...u.heading]}`);
  assert(u.token.get("abcfavorit") === 1, `token: ${[...u.token]}`);
});

// monzo.com writes every Title_* rule as the `font:` shorthand, so a
// font-family-only reader saw none of them.
check("the `font:` shorthand tail is read as a family list", () => {
  const u = extractFontUsage(`.Title_xl{font:800 2.25rem/96% Oldschool,sans-serif}`);
  assert(u.heading.get("oldschool") === 1, `heading: ${[...u.heading]}`);
});

// clerk.com: `--font-sans: var(--font-geist-numbers), var(--font-suisse), …`.
// The numerals cut leads the stack on purpose; every LETTER falls past it.
check("a numerals-only cut at the head of a stack is not the face in use", () => {
  const u = extractFontUsage(
    `:root{--font-geist-numbers:"geistNumbers";--font-suisse:"suisse";
           --font-sans:var(--font-geist-numbers),var(--font-suisse),sans-serif}
     h2{font-family:var(--font-sans)}`,
  );
  assert(u.heading.get("suisse") === 1, `expected suisse, got ${[...u.heading]}`);
  assert(!u.heading.has("geistnumbers"), "a face with no letters cannot be setting a heading");
});

check("a role-NAMED token is recorded as a token, not just a heading use", () => {
  const u = extractFontUsage(`:root{--font-stack-title:"MonzoSansDisplay",sans-serif}`);
  assert(u.token.get("monzosansdisplay") === 1, `token: ${[...u.token]}`);
  assert(u.heading.get("monzosansdisplay") === 1, `heading: ${[...u.heading]}`);
});

check("--font-size-* and friends are not font tokens", () => {
  const u = extractFontUsage(`:root{--font-size-title:48px;--title-font-weight:700}`);
  assert(u.token.size === 0, `nothing here names a family: ${[...u.token]}`);
});

// A rule inside @media is still a rule; the wrapper is not.
check("nested at-rules yield the inner rule, not the wrapper", () => {
  const u = extractFontUsage(`@media (min-width:900px){h1{font-family:"Brand"}}`);
  assert(u.heading.get("brand") === 1, `heading: ${[...u.heading]}`);
});

// THE STALL. An unclosed `{` followed by a long brace-free run is quadratic for
// a regex built from two lazy quantifiers, and it is not hypothetical: reading
// notion.com's own homepage bytes this way took 834ms for 60KB and 31 SECONDS
// for 488KB (measured 2026-08-09). Well-formed CSS closes its braces and never
// triggered it, which is precisely why a 38-site run stayed green. This lives
// on the free create path, whose whole promise is a 1.4s median.
check("a 120KB unclosed brace does not stall the CSS read", () => {
  const nasty = `.a{color:red}<style>{${"x".repeat(120 * 1024)}`;
  const started = Date.now();
  extractFontUsage(nasty);
  const ms = Date.now() - started;
  // The lazy-regex version of this took 4777ms on exactly this input; the
  // linear scan takes ~1ms. Any threshold in between catches a regression.
  assert(ms < 500, `took ${ms}ms — the CSS read is quadratic again`);
});

check("annotateFontUsage staples the counts onto the fonts, and is a no-op on empty CSS", () => {
  const out = annotateFontUsage([f("Brand"), f("Other")], `h1{font-family:Brand}p{font-family:Other}`);
  assert(out[0].heading_uses === 1, `expected heading_uses on Brand, got ${JSON.stringify(out[0])}`);
  assert(out[1].body_uses === 1, `expected body_uses on Other, got ${JSON.stringify(out[1])}`);
  assert(annotateFontUsage([f("Brand")], "")[0].heading_uses === undefined, "empty CSS must add nothing");
});

// ── The display pick, on the real shapes that were getting it wrong ───────────

// vercel.com declares five GeistPixel* novelty cuts BEFORE GeistSans; the old
// declaration-order pick handed headlines a pixel font.
check("vercel: the face the CSS actually uses beats five novelty cuts declared first", () => {
  const roles = classifyFontRoles([
    f("GeistPixelSquare"),
    f("GeistPixelGrid"),
    f("GeistPixelCircle"),
    used("GeistSans", 36, 34),
  ]);
  assert(roles.display === "GeistSans", `display: expected GeistSans, got ${roles.display}`);
  // And BODY too: falling back to the head of the full list put body copy in a
  // pixel font while display was already right.
  assert(roles.body === "GeistSans", `body: expected GeistSans, got ${roles.body}`);
});

// notion.com: NotionInter (the brand's own cut) plus the Arabic/Hebrew subsets
// and the Lyon *Text* reading cut — and every one of them has zero CSS usage,
// so this is decided on names alone.
check("notion: a script subset and a Text cut both lose to the brand's own face", () => {
  const roles = classifyFontRoles([
    f("NotionInter"),
    f("Noto Sans Arabic"),
    f("Noto Sans Hebrew"),
    f("Lyon Text"),
  ]);
  assert(roles.display === "NotionInter", `display: expected NotionInter, got ${roles.display}`);
});

// spotify.com declares FOUR script cuts of Circular and nothing else. A filter
// that leaves a site with no face at all is worse than no filter.
check("spotify: script subsets survive when they are the only faces declared", () => {
  const roles = classifyFontRoles([f("CircularSp-Deva"), f("CircularSp-Grek"), f("CircularSp-Arab")]);
  assert(roles.display !== undefined, "a face must still be returned");
  assert(roles.body !== undefined, "a body face must still be returned");
});

// sentry.io: Rubik is named by exactly two body rules; the one-weight novelty
// `Dammit Sans` is named by none, and it used to win on the serif/name tier.
check("sentry: a face no rule anywhere mentions loses to one two rules do", () => {
  const roles = classifyFontRoles([used("Rubik", 0, 2), f("Dammit Sans")]);
  assert(roles.display === "Rubik", `display: expected Rubik, got ${roles.display}`);
});

// monzo.com: --font-stack-title NAMES MonzoSansDisplay, while a rival face is
// on MORE heading rules (Oldschool, 18 vs 15). Intent beats volume.
check("monzo: a role-named title token outranks a rival with more heading rules", () => {
  const roles = classifyFontRoles([
    used("Oldschool", 18, 0),
    used("MonzoSansDisplay", 15, 9, 2),
    used("MonzoSansText", 14, 9),
  ]);
  assert(
    roles.display === "MonzoSansDisplay",
    `display: expected MonzoSansDisplay, got ${roles.display}`,
  );
});

// deathwishcoffee.com: the Shopify theme leaves the stock --font-heading-family
// (DM Sans) in place while 18 real heading rules set Revans-Bold. Practice wins
// when the landslide is big enough — 18 rules to 2.
//
// DM Sans is spelled across its FOUR declared weights on purpose. The usage
// counts are stamped on every @font-face block of a family, so a merge that
// added them instead of taking the max would read this theme default as 12
// heading rules instead of 3, clear the landslide bar, and hand the headline to
// the face the merchant never chose. Break `Math.max` to `+` and watch it.
const DEATHWISH = [
  used("DM Sans", 3, 0, 1),
  used("DM Sans", 3, 0, 1),
  used("DM Sans", 3, 0, 1),
  used("DM Sans", 3, 0, 1),
  used("Revans-Bold", 18, 0),
  used("Fenomen-Sans-Book", 0, 5),
];

check("deathwish: a landslide of real heading rules overrules a stock theme token", () => {
  const roles = classifyFontRoles(DEATHWISH);
  assert(roles.display === "Revans-Bold", `display: expected Revans-Bold, got ${roles.display}`);
});

// drinkolipop.com: Ano is on 59 heading rules to WindsorEF's 26 — but Ano is
// also on 29 body rules and WindsorEF on 1. The RATIO is the display face.
check("olipop: exclusivity to headings beats raw heading count", () => {
  const roles = classifyFontRoles([used("Ano", 59, 29), used("WindsorEF", 26, 1)]);
  assert(roles.display === "WindsorEF", `display: expected WindsorEF, got ${roles.display}`);
  assert(roles.body === "Ano", `body: expected Ano, got ${roles.body}`);
});

// discord.com spells ONE face two ways: `gg sans` (1 @font-face, 17 heading
// rules) and `Ggsans` (8 @font-face, 20 body rules). Counted apart, the thin
// spelling looks heading-exclusive (17/18) and beat the real headline face.
check("discord: two spellings of one family are one candidate", () => {
  const roles = classifyFontRoles([
    used("gg sans", 17, 1),
    used("Ggsans", 3, 20),
    used("Abcgintonord 800", 25, 14),
  ]);
  assert(
    roles.display === "Abcgintonord 800",
    `display: expected Abcgintonord 800, got ${roles.display}`,
  );
  // The emitted spelling is the FIRST one, because resolveFont only ever uses
  // one @font-face src and churning the name buys nothing.
  assert(roles.body === "gg sans", `body: expected the first spelling, got ${roles.body}`);
});

check("a family's weights count once, not once per weight", () => {
  // The same four-weight DM Sans as above, stated as its own assertion so the
  // reason is legible: dropping the extra weights must not change the answer.
  const many = classifyFontRoles(DEATHWISH).display;
  const one = classifyFontRoles([
    used("DM Sans", 3, 0, 1),
    used("Revans-Bold", 18, 0),
    used("Fenomen-Sans-Book", 0, 5),
  ]).display;
  assert(many === one, `4 weights gave ${many}, 1 weight gave ${one} — counts are multiplying`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
