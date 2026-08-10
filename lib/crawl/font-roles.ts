/**
 * WHICH FACE IS THE BRAND'S DISPLAY FACE — the type half of the brand read.
 *
 * Lifted out of `extract-brand.ts` (it re-exports everything here, so every
 * existing import keeps working) because the answer stopped being a question
 * about NAMES and became a question about USE, and that needed room.
 *
 * THE DEFECT THIS FILE EXISTS TO FIX, measured over the 38-site tune half of
 * the brand truth set on 2026-08-09: the display face was right on 12 of the
 * 21 sites that have one (57%). The nine misses were all the same shape — a
 * family that IS declared on the page but is not the one a reader sees:
 *
 *   vercel.com    → GeistPixelGrid   (a novelty pixel cut; the face is Geist)
 *   notion.com    → Noto Sans Arabic (a script-subset fallback; it is Inter)
 *   dropbox.com   → SharpGroteskSuperCondensed (the base cut is Sharp Grotesk)
 *   mailchimp.com → Graphik Web      (Graphik is the BODY face; it is Means)
 *   resend.com    → domaine          (a curated serif NAME beat ABC Favorit)
 *   retool.com    → pxGroteskFont    (the caption face; it is Saans)
 *   sentry.io     → Dammit Sans      (a one-weight novelty; it is Rubik)
 *
 * Name patterns cannot separate those, because every one of those names is a
 * plausible display face read cold. What separates them is that the site's own
 * CSS says what it puts on a headline — in a design token it NAMED
 * (`--font-stack-title: "MonzoSansDisplay"`) or in a rule on a heading
 * selector (`.headline-xxl { font-family: var(--font-saans) }`). That evidence
 * is read by `extractFontUsage` and stapled onto each font by
 * `annotateFontUsage`, so it survives into the stored `BrandExtract` and is
 * still there when `resolveBrandIdentity` re-classifies from `fonts` alone.
 *
 * After: 19 of 21 (90% hit, 76% exact), and no site regressed. Both remaining
 * misses were chased to the bytes before being called misses:
 *
 *   raycast.com   truth Instrument Serif. The string "Instrument Serif" appears
 *                 NOWHERE in raycast's HTML or in any of its 11 stylesheets
 *                 (all 11 fetched by hand and grepped, 2026-08-09). The hero
 *                 rule says `font-family: var(--font-instrument-serif)` and
 *                 that property is never defined in anything we can see. Not a
 *                 ranking failure — the answer is not in the evidence.
 *   discord.com   truth Ginto Nord. We now DO pick the right face; the site
 *                 spells it `Abcgintonord 800` (foundry prefix + weight) and
 *                 the truth set's matcher scores that WRONG, as it does the
 *                 foundry's own full name "ABC Ginto Nord". Left alone on
 *                 purpose: bending the scorer to accept an answer is not the
 *                 same as being right, and the scorer is not ours to tune.
 *
 * WHAT IT COSTS: nothing new. The evidence is read out of bytes the crawl has
 * already fetched — the tune half runs with ZERO extra network requests — and
 * the read itself is a single linear pass, 6-9ms on the largest stylesheet in
 * the corpus. (It was not always: see `eachRule`, where a 31-second stall was
 * measured and removed.)
 *
 * ORDER OF EVIDENCE (strongest first), which is the whole design:
 *   1. a role-NAMED token   the site literally called it the title font
 *   2. heading RULES        what its selectors actually do, ranked by how
 *                           exclusively the family lives on headings
 *   3. family NAMES         the old heuristic, unchanged, for the ~40% of
 *                           sites whose CSS we cannot see this way
 *
 * WHAT IS ACTUALLY CARRYING THE NUMBER. Every rule below was ablated one at a
 * time over the 38 tune rows (2026-08-09); a rule that moved nothing is either
 * deleted or annotated as such, so nobody has to guess later:
 *
 *   usage evidence, entirely      -23.8pp   9 rows move
 *   partial-coverage filter        -4.8pp   notion → Noto Sans Arabic
 *   eligibility filter             -4.8pp   sentry → Dammit Sans
 *   tier-1 role token              -4.8pp   monzo  → Oldschool
 *   ratio instead of raw count     -4.8pp   olipop → Ano
 *   tier-3 novelty/Text demotion   -4.8pp   notion → Lyon Text
 *   spelling merge                   0pp    discord's pick reverts to the body
 *                                           face; kept because it is right, and
 *                                           the truth set cannot see it
 *   "Text"→"Display" sibling swap    0pp    DELETED — fired on zero sites
 *
 * AND ONE IDEA THAT LOOKED RIGHT AND IS NOT, so it does not get rebuilt:
 * ranking by HOW MANY WEIGHTS a family declares ("a brand's workhorse has
 * several"). Measured as a tier-3 rank: it moved exactly one row on the tune
 * half and moved it the wrong way — neon.tech's display went from Inter to
 * `esbuild`, a single stray @font-face with more declarations than sense. Face
 * count says how much of a family was shipped, not what it is FOR.
 */

/** A face as the crawl found it. Owned here because the classifier is the only
 *  thing that reads the usage counts; `extract-brand.ts` re-exports the type. */
export interface CrawledFont {
  family: string;
  src: string;
  weight?: string; // raw CSS value, e.g. "400", "700", "100 900"
  style?: string; // "normal" | "italic"
  format?: string; // "woff2" | "woff" | "ttf" | "otf"
  /** Times the site's CSS puts this family on a heading — see extractFontUsage. */
  heading_uses?: number;
  /** Times the site's CSS puts this family on body copy. */
  body_uses?: number;
  /** Of `heading_uses`, how many came from a role-NAMED custom property. */
  heading_tokens?: number;
}

export interface FontRoles {
  display?: string;
  body?: string;
  mono?: string;
}

/**
 * Icon-font name patterns — these are not text fonts and must NOT be
 * routed to display/body/mono roles. Common offenders:
 *   - webflow-icons (Webflow's stock icon set, dropped on every site)
 *   - material-icons / material-symbols-* (Google Material icons)
 *   - fa-* / Font Awesome
 *   - icon-* / glyph* / glyphicons (generic naming)
 *   - simple-icons (brand-logo glyphs)
 * Without this filter, the first @font-face block on most Webflow sites
 * (which is webflow-icons) was being picked as the display font, then
 * routed onto h1/h2/h3 elements — garbling them into icon-glyph soup.
 */
// Catches: prefix `icon-foo`, AND the `<brand>-icons` / `<brand>_icon` SUFFIX
// form (`swiper-icons`, `oatly-icons` — these slipped through the prefix-only
// pattern and got routed onto headlines as a "display font", forcing a generic
// serif fallback). The suffix alternative requires a word + `-icon(s)`, so real
// names like `sodimac` or `Recoleta` are NOT caught.
// ALSO catches math-rendering LIBRARY fonts (KaTeX_*, MathJax/MJX*): edu/math
// sites (Duolingo embeds KaTeX for lessons) ship these in CSS, and they were
// mis-detected as the BRAND font — corrupting the brand identity fed to the
// design agent AND making the vision gate flag every scene as "missing the
// brand's KaTeX_Caligraphic font". They are never a brand identity.
// ALSO catches SITE-BUILDER and PLAYER CHROME faces. `squarespace-ui-font` is
// Squarespace's own interface font, shipped on every Squarespace site: in the
// 60-site sweep (2026-08-09) it appeared on 18 hosts and was crowned the DISPLAY
// face on 13 of them — on 8 of those a real brand face (Montserrat, Raleway,
// Poppins, Rubik, Varela Round, Inter) was sitting right there in the body role.
// `VideoJS` is video.js's player font and took the BODY role on toadbakery.com.
// `wf_<hex>` is Wix's hashed font alias (redbamboo-nyc.com shipped
// `wf_36dfb692240b4f9a8a0a33393` as its body font) — an opaque hash is not a
// family any downstream renderer can resolve, so it is worse than no font.
export const ICON_FONT_RX =
  /\b(webflow-?icons?|material-?(?:icons?|symbols?(?:-[a-z]+)?)|font[\s-]*awesome|fa-[a-z0-9-]+|icon-[a-z0-9-]+|[a-z0-9]+[-_]icons?|glyph[a-z0-9-]*|simple-?icons|remixicon|feather-?icons|hero-?icons|lucide-?icons|bootstrap-?icons|ionicons|tabler-?icons|phosphor-?icons|octicons|ant-?design[-_]?icons|line-?icons|streamline|katex(?:[_-][a-z0-9]+)?|mathjax[_-]?[a-z0-9]*|mjx[a-z0-9-]*|squarespace(?:[-_][a-z]+)*|video-?js|wf_[0-9a-f]{16,})\b/i;

// A CSS variable reference that reached the font list as if it were a family
// name — arc.net ships `var(--fonts-sans)` and Framer sites ship
// `var(--framer-font-family)`. Never a font; emitting one downstream produces
// `font-family: var(--fonts-sans)` in a document that has no such variable.
const PLACEHOLDER_FAMILY_RX = /^\s*var\(|^\s*$/i;

export const MONO_RX =
  /\b(mono|code|courier|consol|menlo|jetbrains|ibm[\s-]*plex[\s-]*mono|source[\s-]*code|fira[\s-]*code|roboto[\s-]*mono|space[\s-]*mono)\b/i;
const SERIF_RX =
  /\b(tiempos|merriweather|playfair|lora|freight|garamond|caslon|bodoni|didot|minion|miller|noe|times|georgia|cambria|baskerville|crimson|cormorant|libre[\s-]*baskerville|source[\s-]*serif|noto[\s-]*serif|roboto[\s-]*serif|pt[\s-]*serif|sentinel|chronicle|gt[\s-]*super|portrait|larken|fraunces|signifier|romana|literata|recoleta|reckless|romie|domaine|saol)\b/i;
const DISPLAY_HINT_RX = /\b(headline|display|hero|h1|h2|title)\b/i;
const SERIF_FAMILY_RX = /\bserif\b/i; // catches "X Serif" naming
// Distinctive display / slab / condensed family names so a real headline face
// (SuperClarendon, Druk, Anton, Splash, …) is recognized as DISPLAY rather than
// silently demoted to the body sans (the Liquid Death miss: FONT_DISPLAY became
// "Acumin Pro" because SuperClarendon/Splash matched no display regex).
const DISPLAY_FAMILY_RX =
  /\b(clarendon|druk|knockout|trade[\s-]*gothic|bebas|anton|oswald|teko|tungsten|rockwell|sentinel|recoleta|migra|canela|austin|ogg|reckless|romie|signifier|splash|monument|druk|condensed|compressed|poster)\b/i;
// Web-safe / OS-bundled system font names. When a site self-hosts a @font-face
// under one of these names it's almost never the brand's intentional DISPLAY
// face — it's a minor accent or a fallback declaration (corgi.insure ships a
// self-hosted "georgia" used 4× vs its distinctive custom "f37Bolton" used 8×,
// yet "georgia" matched SERIF_RX and got crowned the display font, forcing every
// headline into a generic serif). A distinctive CUSTOM face should outrank a
// system-named one for display. NOTE: deliberately excludes licensed display
// serifs brands actually choose (garamond, caslon, baskerville) — only the
// classic web-safe set lands here.
const SYSTEM_FONT_RX =
  /\b(georgia|times(?:[\s-]*new[\s-]*roman)?|arial(?:[\s-]*black)?|helvetica(?:[\s-]*neue)?|verdana|tahoma|trebuchet(?:[\s-]*ms)?|courier(?:[\s-]*new)?|cambria|calibri|segoe(?:[\s-]*ui)?|palatino(?:[\s-]*linotype)?|book[\s-]*antiqua|lucida(?:[\s-]*grande|[\s-]*sans)?|geneva|impact|comic[\s-]*sans)\b/i;

/**
 * A SCRIPT SUBSET of a family — the Arabic/Hebrew/CJK cut a global site ships
 * alongside its Latin face. Never the brand's display face on a Latin site.
 * notion.com shipped `NotionInter` (8 weights, the brand's own cut of Inter)
 * plus `Noto Sans Arabic` and `Noto Sans Hebrew`, and the classifier crowned
 * the Arabic one. dropbox ships `Sharp Grotesk KR`/`Thai`; spotify ships FOUR
 * (`CircularSp-Deva`/`Grek`/`Arab`/`Cyrl`) and NOTHING else — which is why the
 * filter is conditional: it only applies when a non-subset face survives, or
 * spotify would be left with no face at all. (`arab` and `arabic` both listed:
 * with only `arabic`, spotify's Arab cut survived the filter alone and became
 * the pick — a partial filter is worse than none.)
 */
const SCRIPT_SUBSET_RX =
  /\b(arab(ic)?|hebrew|thai|deva(nagari)?|cyr(l|illic)|gr(ek|eek)|cjk|jp|kr|sc|tc|hk|japanese|korean|chinese|hindi|bengali|tamil|telugu|kannada|gujarati|khmer|lao|myanmar|georgian|armenian|ethiopic|sinhala|vietnamese|viet)\b/i;

/**
 * A NUMERALS-ONLY cut — drawn for the digits and nothing else, so it is listed
 * FIRST in a font stack on purpose and every letter falls through past it.
 * clerk.com: `--font-sans: var(--font-geist-numbers), var(--font-suisse), …`.
 */
const NUMERAL_CUT_RX = /\b(numbers?|numerals?|figures?|digits?)\b/i;

/**
 * A face that CANNOT set Latin text — a script subset, a numerals cut, an icon
 * font. Distinct from NOVELTY_CUT_RX below, which is stylistic: a stencil or a
 * pixel face is a real if odd choice for a headline, whereas these three have
 * no letters to render one with.
 */
const isPartialCoverage = (name: string): boolean =>
  matchesFamily(SCRIPT_SUBSET_RX, name) ||
  matchesFamily(NUMERAL_CUT_RX, name) ||
  matchesFamily(ICON_FONT_RX, name);

/**
 * A NOVELTY cut — a face drawn for one gag, never the workhorse. vercel.com
 * declares five (`GeistPixelSquare`, `GeistPixelGrid`, `GeistPixelCircle`,
 * `GeistPixelTriangle`, `GeistPixelLine`) before it declares `GeistSans`, and
 * the first-wins ordering handed headlines a pixel font. Demotion, not
 * exclusion: if a novelty cut is the only face, it beats nothing.
 */
const NOVELTY_CUT_RX = /\b(pixel|dots?|stencil|sketch|outline|shadow|graffiti)\b/i;

/**
 * The "Text" optical cut is the READING cut by definition — its sibling
 * "Display" cut is the headline one. notion.com's `Lyon Text` beat the brand's
 * own `NotionInter` for display purely by being the second family declared.
 */
const TEXT_CUT_RX = /\btext\b/i;

/**
 * Real webfont families are CamelCase far more often than spaced, and every
 * pattern in this section is `\b`-anchored. "SourceCodePro" has no word boundary
 * between "code" and "Pro", so `source[\s-]*code\b` never fired and a MONOSPACE
 * face was crowned the DISPLAY font — observed in the stored crawls
 * (`display:SourceCodePro`) and again in the 60-site sweep. "JetBrainsMono"
 * fails the same way; "IBMPlexMono" only survives by accident because its whole
 * name is an alternative in MONO_RX.
 *
 * Splitting the camel humps into words gives every pattern a second, spaced
 * spelling to match. Kept as an ADDITIONAL attempt rather than a replacement:
 * normalization can only ever add matches, never remove one (it would otherwise
 * break `KaTeX_Main`, whose ICON_FONT_RX alternative wants the underscore).
 */
export const normalizeFamilyName = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // sourceCode → source Code
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // IBMPlex → IBM Plex
    .replace(/[_-]+/g, " ") // CircularSp-Grek → CircularSp Grek
    .replace(/\s+/g, " ")
    .trim();

const matchesFamily = (rx: RegExp, name: string): boolean =>
  rx.test(name) || rx.test(normalizeFamilyName(name));

// ─── What the site's own CSS says about USE ────────────────────────────

/** Values that name no family — the generic keywords and the CSS-wide ones.
 *  Exported because `extract-brand.ts` needs the same list for its inline
 *  `style="font-family:…"` scan, and two copies is how they drift apart. */
export const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "revert",
]);

// A selector that puts type at HEADING size: an h1-h6 element, or a class whose
// own name says title/heading/hero/display. Deliberately loose — it is counted,
// not trusted individually, and the ranking below is a ratio.
const HEADING_SELECTOR_RX = /(?:^|[\s,>+~(.#])h[1-6]\b|title|head(?:ing|line)|hero|display|jumbo/i;
const BODY_SELECTOR_RX =
  /(?:^|[\s,>+~(])(?:body|html|p|li|:root)\b|paragraph|\bcopy\b|\btext\b|\bcontent\b|\bbase\b/i;
// A custom property is only a font token if its NAME says so; `--font-size-*`
// and friends are excluded or every type scale becomes evidence.
const FONT_TOKEN_RX = /^--.*(?:font|type|stack)/i;
const NON_FAMILY_TOKEN_RX =
  /(size|weight|leading|line-?height|spacing|tracking|offset|color|width|height|style|feature|variant|smooth|transform|case)/i;
const HEADING_TOKEN_RX = /(display|head(?:ing|line)?|title|hero|jumbo)/i;
const BODY_TOKEN_RX = /(body|paragraph|copy|text|base)/i;
// `font: 800 2.25rem/96% Oldschool, sans-serif` — the family list is whatever
// follows the size (and its optional /line-height). monzo.com writes every
// Title_* rule this way, so a font-family-only reader sees none of them.
const FONT_SHORTHAND_TAIL_RX =
  /(?:^|\s)(?:[\d.]+(?:px|rem|em|ex|ch|%|pt|pc|vw|vh|vmin|vmax)|xx?-(?:small|large)|small|medium|large|larger|smaller)(?:\s*\/\s*[^\s]+)?\s+(\S[\s\S]*)$/i;

export interface FontUsage {
  /** family (lowercased) → times a role-NAMED token resolves to it */
  token: Map<string, number>;
  /** family (lowercased) → heading references, tokens included */
  heading: Map<string, number>;
  /** family (lowercased) → body references */
  body: Map<string, number>;
}

/** Split a comma list at the TOP level — `var(--a, "X"), Y` is two entries. */
const splitTopLevel = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
};

const collectVarDefs = (css: string): Map<string, string[]> => {
  const defs = new Map<string, string[]>();
  for (const m of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)/g)) {
    const value = m[2].trim();
    if (!/[a-z]/i.test(value)) continue; // pure numbers/lengths: not a family
    const list = defs.get(m[1]) ?? [];
    // A property redefined per breakpoint/theme repeats; a few spellings is
    // enough to resolve one and unbounded growth is how a 500KB sheet OOMs.
    if (list.length < 4 && !list.includes(value)) list.push(value);
    defs.set(m[1], list);
  }
  return defs;
};

/**
 * Every REAL family a `font-family` value names, in stack order, following
 * `var()` chains. resend.com needs two hops: `.font-display { font-family:
 * var(--font-display) }` → `--font-display: var(--font-abc-favorit),
 * ui-sans-serif` → `--font-abc-favorit: "aBCFavorit"`.
 *
 * The whole stack, not the first entry, because of what the first entry is on
 * clerk.com — see `resolveFamilyValue` below.
 */
const MAX_STACK_FAMILIES = 8;
const familiesIn = (
  value: string,
  defs: Map<string, string[]>,
  depth = 0,
  out: string[] = [],
): string[] => {
  if (depth > 4 || out.length >= MAX_STACK_FAMILIES) return out;
  for (const raw of splitTopLevel(value)) {
    const part = raw.trim().replace(/!important/i, "").trim();
    if (!part) continue;
    const varRef = part.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,([\s\S]*))?\)$/);
    if (varRef) {
      for (const def of defs.get(varRef[1]) ?? []) familiesIn(def, defs, depth + 1, out);
      if (varRef[2]) familiesIn(varRef[2], defs, depth + 1, out);
      continue;
    }
    if (/^var\(/.test(part) || /^\d/.test(part)) continue;
    const name = part.replace(/^["']|["']$/g, "").trim();
    if (!name || GENERIC_FAMILIES.has(name.toLowerCase())) continue;
    if (!/^[a-z]/i.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_STACK_FAMILIES) break;
  }
  return out;
};

/**
 * The face a READER sees for this rule.
 *
 * Not simply the first family in the stack, because a partial-coverage cut is
 * routinely listed first on purpose. clerk.com's Tailwind theme declares
 * `--font-sans: var(--font-geist-numbers), var(--font-suisse), …` — the
 * numerals-only cut leads so digits pick it up, and every letter falls through
 * to Suisse. Reading the head of that stack made `geistNumbers` clerk's DISPLAY
 * face (measured 2026-08-09: 10 heading rules attributed to a face with no
 * letters in it), which would have set every headline in a font that cannot
 * render a headline.
 *
 * So: the first family that can actually set Latin text, and only if none can,
 * the head of the stack (better a subset than nothing — spotify.com declares
 * four script cuts of Circular and no Latin face at all).
 */
const resolveFamilyValue = (value: string, defs: Map<string, string[]>): string | null => {
  const stack = familiesIn(value, defs);
  return stack.find((n) => !isPartialCoverage(n)) ?? stack[0] ?? null;
};

/**
 * Walk the INNERMOST `selector { … }` blocks, in one pass.
 *
 * This was `bare.matchAll(/([^{}]+?)\{([^{}]*?)\}/g)` and that is a trap. Two
 * lazy quantifiers either side of a literal make the engine retry from every
 * start position when a block does not close, so the cost is quadratic in the
 * distance to the next brace. MEASURED on the truth set's own byte cache: a
 * single 488KB response took 31 SECONDS, and twelve of them took 85s between
 * them (2026-08-09). Real stylesheets close their braces promptly and ran in
 * ~5ms, which is exactly why it survived a 38-site run — but `fetchCss` does
 * not check content-type, so an HTML error page served 200 at a .css URL lands
 * in `allCss` and this sits on the FREE create path whose whole promise is a
 * 1.4s median. A hand-rolled scan is O(n) with no such cliff.
 *
 * "Innermost" reproduces what the regex matched: a body containing no braces,
 * so `@media { h1 { … } }` yields the `h1` rule and not the wrapper.
 */
const eachRule = (css: string, fn: (selector: string, body: string) => void): void => {
  const open: { selStart: number; bodyStart: number; nested: boolean }[] = [];
  let mark = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      if (open.length > 0) open[open.length - 1].nested = true;
      open.push({ selStart: mark, bodyStart: i + 1, nested: false });
      mark = i + 1;
    } else if (ch === "}") {
      const top = open.pop();
      if (top && !top.nested) fn(css.slice(top.selStart, top.bodyStart - 1), css.slice(top.bodyStart, i));
      mark = i + 1;
    }
  }
};

/**
 * Read the site's own CSS for what it PUTS ON THINGS, as opposed to what it
 * merely downloads. Two streams, kept apart because they are not equally
 * strong: a role-named token (`--font-stack-title`) is a statement of intent,
 * a rule on `.Title_xxlarge` is a statement of practice.
 *
 * Never throws and never fetches — it reads bytes the crawl already has, so it
 * costs nothing and cannot fail a brand read.
 */
export const extractFontUsage = (css: string): FontUsage => {
  const usage: FontUsage = { token: new Map(), heading: new Map(), body: new Map() };
  if (!css) return usage;
  // @font-face blocks name a family to DECLARE it, not to use it — counting
  // them would make every downloaded face look used.
  const bare = css.replace(/@font-face\s*\{[^}]*\}/gi, " ");
  const defs = collectVarDefs(bare);
  const bump = (m: Map<string, number>, family: string) => {
    const k = family.toLowerCase();
    m.set(k, (m.get(k) ?? 0) + 1);
  };

  eachRule(bare, (selector, body) => {
    if (selector.includes("@")) return; // at-rule preludes are not selectors
    let value = body.match(/(?:^|[;\s])font-family\s*:\s*([^;}]+)/i)?.[1];
    if (!value) {
      const shorthand = body.match(/(?:^|[;\s])font\s*:\s*([^;}]+)/i)?.[1];
      value = shorthand?.match(FONT_SHORTHAND_TAIL_RX)?.[1];
    }
    if (!value) return;
    const family = resolveFamilyValue(value, defs);
    if (!family) return;
    if (HEADING_SELECTOR_RX.test(selector)) bump(usage.heading, family);
    else if (BODY_SELECTOR_RX.test(selector)) bump(usage.body, family);
  });

  for (const [name, values] of defs) {
    if (!FONT_TOKEN_RX.test(name) || NON_FAMILY_TOKEN_RX.test(name)) continue;
    const isHeading = HEADING_TOKEN_RX.test(name);
    const isBody = !isHeading && BODY_TOKEN_RX.test(name);
    if (!isHeading && !isBody) continue;
    for (const value of values) {
      const family = resolveFamilyValue(value, defs);
      if (!family) continue;
      if (isHeading) {
        bump(usage.token, family);
        bump(usage.heading, family);
      } else {
        bump(usage.body, family);
      }
    }
  }
  return usage;
};

/**
 * Staple the usage evidence onto the fonts so it survives into the stored
 * `BrandExtract`. It has to travel with the data: `resolveBrandIdentity`
 * re-classifies from `fonts` alone (deliberately — stored roles go stale), and
 * it has no CSS to consult.
 */
export const annotateFontUsage = <T extends CrawledFont>(fonts: T[], css: string): T[] => {
  if (fonts.length === 0) return fonts;
  const usage = extractFontUsage(css);
  if (usage.heading.size === 0 && usage.body.size === 0) return fonts;
  return fonts.map((f) => {
    const k = (f.family ?? "").toLowerCase();
    const heading = usage.heading.get(k) ?? 0;
    const body = usage.body.get(k) ?? 0;
    const tokens = usage.token.get(k) ?? 0;
    if (!heading && !body) return f;
    return {
      ...f,
      ...(heading ? { heading_uses: heading } : {}),
      ...(body ? { body_uses: body } : {}),
      ...(tokens ? { heading_tokens: tokens } : {}),
    };
  });
};

// How lopsided the RULES have to be before they overrule a role-named token.
// Calibrated on the two sites where the streams disagree, in opposite
// directions: monzo.com's `--font-stack-title` names MonzoSansDisplay while its
// Title_* classes set Oldschool 18× (ratio 1.4 → the token holds, and the truth
// set agrees); deathwishcoffee.com's Shopify theme leaves the stock
// `--font-heading-family: DM Sans` in place while 18 heading rules set
// Revans-Bold (ratio 9 → practice wins, and the truth set agrees). Anything
// between 1.4 and 9 is unmeasured; 3 is the midpoint in log space.
const TOKEN_LANDSLIDE = 3;
// Below this, "the CSS never mentions this family" is not evidence of anything
// — it is just as likely to be a stylesheet we did not fetch. sentry.io is the
// row that sets it: Rubik is named by exactly 2 body rules and the novelty
// `Dammit Sans` by none, which is the thinnest real signal in the set.
const MIN_USAGE_TO_TRUST = 2;
// One heading reference can be a stray utility class; two is a pattern.
const MIN_HEADING_TO_RANK = 2;

/**
 * Classify the crawled fonts into three roles: display (large headlines),
 * body (paragraphs/lede), mono (URLs/code/diegetic UI).
 *
 * Display is decided by the evidence order in this file's header: role-named
 * token, then heading rules, then family names. Body and mono are unchanged in
 * spirit — body is the most-used reading face, mono the first mono-named one.
 */
export const classifyFontRoles = (fonts: CrawledFont[]): FontRoles => {
  const roles: FontRoles = {};
  // Distinct text faces in declaration order; mono pulled out. Icon fonts are
  // skipped (routing them onto h*/p would render glyphs).
  //
  // ONE FAMILY, ONE CANDIDATE, even when the site spells it two ways. discord.com
  // declares `gg sans` (one @font-face, 17 heading rules) AND `Ggsans` (eight
  // @font-face, 20 body rules) — the same face. Scored separately, the thin
  // spelling looks like a face that lives ALMOST ONLY on headings (17/18 = .94)
  // and beat the real headline face `Abcgintonord 800` (25/39 = .64). Summed,
  // gg sans lands at .49 and loses, which is the right answer. The key keeps
  // every letter and digit in order, so two names can only collide when they
  // are the same name differently punctuated/cased.
  const keyOf = (name: string) =>
    normalizeFamilyName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  // One entry per SPELLING first. annotateFontUsage stamps the family's total
  // on every @font-face block of that family, so the counts repeat per weight —
  // take the max, never the sum, or a 12-weight family scores 12×.
  const spellings: string[] = [];
  const perSpelling = new Map<string, { heading: number; body: number; token: number }>();
  for (const f of fonts) {
    const name = f.family;
    if (!name) continue;
    if (PLACEHOLDER_FAMILY_RX.test(name)) continue;
    if (matchesFamily(ICON_FONT_RX, name)) continue;
    if (matchesFamily(MONO_RX, name)) {
      // EVERY mono face is skipped, not just the first. The old `!roles.mono`
      // guard let the SECOND declaration of a mono family fall through into the
      // text list, and on raycast.com (7× Inter then 5× JetBrains Mono) the
      // second JetBrains Mono became the display face — a code font on the
      // headlines. Same shape on vercel.com, where the leftovers took body.
      if (!roles.mono) roles.mono = name;
      continue;
    }
    if (!perSpelling.has(name)) {
      perSpelling.set(name, { heading: 0, body: 0, token: 0 });
      spellings.push(name);
    }
    const p = perSpelling.get(name)!;
    p.heading = Math.max(p.heading, f.heading_uses ?? 0);
    p.body = Math.max(p.body, f.body_uses ?? 0);
    p.token = Math.max(p.token, f.heading_tokens ?? 0);
  }

  // Then fold the spellings of one family together. Two of the 38 tune sites
  // spell a face twice — discord and dropbox — and the FIRST spelling is the
  // one emitted, not the most-declared one: `resolveFont` uses a single
  // @font-face src per role, so the extra declarations buy nothing downstream.
  // Dropbox is why that matters: `Sharp Grotesk` ×4 and `SharpGrotesk` ×12, and
  // it goes on saying "Sharp Grotesk" — the merge changed nothing there.
  const text: string[] = [];
  const byKey = new Map<string, string>();
  const evidence = new Map<string, { heading: number; body: number; token: number }>();
  for (const name of spellings) {
    const key = keyOf(name);
    if (!byKey.has(key)) {
      byKey.set(key, name);
      text.push(name);
      evidence.set(name, { heading: 0, body: 0, token: 0 });
    }
    const e = evidence.get(byKey.get(key)!)!;
    const p = perSpelling.get(name)!;
    e.heading += p.heading;
    e.body += p.body;
    e.token += p.token;
  }
  if (text.length === 0) return roles;

  const headingOf = (n: string) => evidence.get(n)?.heading ?? 0;
  const bodyOf = (n: string) => evidence.get(n)?.body ?? 0;
  const tokenOf = (n: string) => evidence.get(n)?.token ?? 0;
  const totalOf = (n: string) => headingOf(n) + bodyOf(n);
  const ruleHeadingOf = (n: string) => Math.max(0, headingOf(n) - tokenOf(n));

  // Faces with no Latin letters out — script subsets and numerals cuts — but
  // only when something is left, because spotify.com declares nothing else and
  // a partial filter is worse than none (see SCRIPT_SUBSET_RX).
  const full = text.filter((n) => !isPartialCoverage(n));
  const candidates = full.length > 0 ? full : text;

  // When the CSS demonstrably shows how at least one family is used, a family
  // it never mentions is not in the running. Measured by ablation on the tune
  // half: without this, sentry.io's one-weight novelty `Dammit Sans` — which no
  // rule anywhere puts on anything — beats Rubik. (It is ALSO what keeps a
  // never-referenced face out of the BODY fallback below, which is where
  // vercel.com's `GeistPixelSquare` was landing.)
  const strongestEvidence = Math.max(0, ...candidates.map(totalOf));
  const eligible =
    strongestEvidence >= MIN_USAGE_TO_TRUST
      ? candidates.filter((n) => totalOf(n) > 0)
      : candidates;

  // Tier 1 — the site NAMED one of these the title/display font.
  let pool = eligible;
  const tokenNamed = eligible.filter((n) => tokenOf(n) > 0);
  if (tokenNamed.length > 0) {
    const namedRules = Math.max(1, ...tokenNamed.map(ruleHeadingOf));
    const rivalRules = Math.max(0, ...eligible.map(ruleHeadingOf));
    if (rivalRules < TOKEN_LANDSLIDE * namedRules) pool = tokenNamed;
  }

  let display: string | undefined;
  // Tier 2 — heading rules, ranked by how EXCLUSIVELY the family lives on
  // headings. The ratio is what matters, not the count: drinkolipop.com's Ano
  // is on 59 heading rules to WindsorEF's 25, but Ano is also on 29 body rules
  // and WindsorEF on 1 — WindsorEF is the display face and the count says Ano.
  const ranked = pool.filter((n) => headingOf(n) >= MIN_HEADING_TO_RANK);
  if (ranked.length > 0) {
    ranked.sort(
      (a, b) =>
        headingOf(b) / totalOf(b) - headingOf(a) / totalOf(a) ||
        headingOf(b) - headingOf(a) ||
        candidates.indexOf(a) - candidates.indexOf(b),
    );
    display = ranked[0];
  } else {
    // Tier 3 — names only. Unchanged from the pre-usage classifier except that
    // it now runs over the eligible pool and demotes novelty/reading cuts.
    const isSystemNamed = (n: string) => matchesFamily(SYSTEM_FONT_RX, n);
    const isDisplayName = (n: string) =>
      matchesFamily(SERIF_RX, n) ||
      matchesFamily(DISPLAY_HINT_RX, n) ||
      matchesFamily(SERIF_FAMILY_RX, n) ||
      matchesFamily(DISPLAY_FAMILY_RX, n);
    const isWeakCut = (n: string) =>
      matchesFamily(NOVELTY_CUT_RX, n) || (matchesFamily(TEXT_CUT_RX, n) && pool.length > 1);
    const strong = pool.filter((n) => !isWeakCut(n));
    const namePool = strong.length > 0 ? strong : pool;
    const namedDisplay = namePool.find(isDisplayName);
    // A display/serif NAME that collides with a web-safe system font (a
    // self-hosted "georgia"/"times") is a weak signal — usually a minor accent,
    // not the brand's headline face (corgi.insure: georgia matched SERIF_RX and
    // beat the real display face f37Bolton). Otherwise: the FIRST face is the
    // body workhorse and the next distinctive one is the headline.
    display =
      (namedDisplay && !isSystemNamed(namedDisplay) ? namedDisplay : undefined) ??
      namePool.find((n) => n !== candidates[0] && !isSystemNamed(n)) ??
      namedDisplay ??
      namePool.find((n) => n !== candidates[0]) ??
      namePool[0];
  }

  // NOTE, so it does not get re-added: a post-hoc "X Text → X Display" sibling
  // swap used to sit here for monzo.com. Ablated 2026-08-09 and it fired on
  // ZERO of the 38 tune sites, with and without usage evidence — monzo is
  // already decided one tier up by `--font-stack-title`, and the reading cut is
  // already demoted by TEXT_CUT_RX in the name tier. It was doing nothing.
  roles.display = display;

  // Body: the face the site puts on the most body copy, else the first
  // ELIGIBLE face (the most canonical), else the display face itself.
  //
  // `eligible`, not `candidates`, and that is the whole point: vercel.com's
  // first declared face is `GeistPixelSquare`, so falling back to the head of
  // the full list handed BODY COPY a pixel novelty cut while display had
  // already been read correctly as GeistSans (observed 2026-08-09). A family
  // the CSS never puts on anything is not the reading face either.
  const others = eligible.filter((n) => n !== display);
  const mostRead = others
    .slice()
    .sort((a, b) => bodyOf(b) - bodyOf(a) || eligible.indexOf(a) - eligible.indexOf(b))[0];
  roles.body =
    mostRead && bodyOf(mostRead) >= MIN_USAGE_TO_TRUST
      ? mostRead
      : eligible[0] !== display
        ? eligible[0]
        : display;
  return roles;
};
