//
// A brand font's `src` is one of two completely different things, and loading
// one as the other means the font never loads at all.
//
//   a font BINARY   .woff2 / .woff / .ttf / .otf   → @font-face { src: url(...) }
//   a STYLESHEET    fonts.googleapis.com/css2?...  → <link rel="stylesheet">,
//                   because it is CSS that itself contains the @font-face rules
//
// Both were being wrapped in `@font-face{src:url(...)}`. A stylesheet loaded as
// a font binary always fails to parse, so document.fonts reports the family
// unloaded — and an unloaded brand font marks the scene UNTRUSTED, which
// demotes every text-metric finding (overflow, cross-piece-overlap,
// covered-text-cluster, intra-piece-overlap) from blocking to advisory.
//
// Measured 2026-08-22 on a real deck whose only font was Google-hosted Inter:
//
//   before   fontFailures ["Inter"] on all 6 scenes   blocking 14 of 30
//   after    fontFailures undefined on all 6 scenes   blocking 30 of 30
//
// Sixteen findings — 11 overflows and 5 covered-text-clusters — were silenced
// on a deck the founder was looking at. The stylesheet URL returns 200; this
// was never a network problem. Google Fonts is the most common brand-font
// source there is, so this was quietly disarming the text gates on a large
// share of every deck built.
//
import { isFontStylesheet } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ font-source");

check("the exact URL that disarmed the gates is recognised as a stylesheet", () => {
  // Verbatim from the deck's script.json.
  assert(
    isFontStylesheet("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700"),
    "a Google Fonts css2 URL is a stylesheet, not a woff2",
  );
});

check("stylesheet sources, in the shapes brands actually use", () => {
  for (const src of [
    "https://fonts.googleapis.com/css?family=Roboto",
    "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800",
    "//fonts.googleapis.com/css2?family=Lato",
    "https://use.typekit.net/abc1234.css",
    "https://cdn.brand.example/fonts/family.css?v=3",
  ]) {
    assert(isFontStylesheet(src), `must be a stylesheet: ${src}`);
  }
});

check("font BINARIES are never mistaken for stylesheets", () => {
  for (const src of [
    "https://cdn.prod.website-files.com/abc/AnthropicSans-Roman-Web.woff2",
    "https://example.com/fonts/Inter-Regular.woff",
    "https://example.com/fonts/Souvenir.ttf",
    "https://example.com/fonts/Souvenir.otf",
    "https://fonts.gstatic.com/s/inter/v12/abc.woff2",
    "/fonts/local-brand.woff2",
  ]) {
    assert(!isFontStylesheet(src), `must be a binary: ${src}`);
  }
});

check("a .css in a QUERY STRING does not make a binary a stylesheet", () => {
  // The trap in a naive /\.css/ test: a cache-buster mentioning css.
  assert(
    !isFontStylesheet("https://example.com/fonts/Brand.woff2?from=theme.css.map"),
    "the file is a woff2; .css appears only in a query value",
  );
});

check("gstatic binaries stay binaries even though Google serves them", () => {
  // fonts.gstatic.com is where the css2 stylesheet POINTS. Treating it as a
  // stylesheet would break the one source that was working.
  assert(!isFontStylesheet("https://fonts.gstatic.com/s/roboto/v30/abc.woff2"), "gstatic serves binaries");
  assert(isFontStylesheet("https://fonts.googleapis.com/css2?family=Roboto"), "googleapis serves the stylesheet");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
