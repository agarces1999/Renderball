# Brand accuracy — state, method, and what has been killed by data

How close does the crawl get to a brand's real accent colour and real display
typeface? Measured, not asserted. Last update **2026-08-09**.

Read this before touching `lib/crawl/extract-brand.ts`,
`lib/crawl/brand-identity.ts` or `lib/documents/site-brand.ts`. Two plausible
ideas for the biggest remaining gap have already been built and killed by
measurement; the numbers are below so nobody spends the day rebuilding them.

## Where it stands

Scored against 52 hand-verified sites, split into a 38-site **tune** half the
fixes were developed against and a 14-site **holdout** half they never saw.

```
TUNE     (38)  ACCENT signature   hit 71%   strict 53%    EXACT 20  NEAR 7  WRONG 5  INVENTED 6
               ACCENT palette[0]  hit 76%   strict 58%
               DISPLAY FONT       hit 90%   strict 76%    (n=21 scored)
HOLDOUT  (14)  ACCENT signature   hit 64%   strict 36%    EXACT  5  NEAR 4  WRONG 2  INVENTED 3
               DISPLAY FONT       hit 78%   strict 56%    (n=9 scored)
```

Bands are euclidean sRGB distance: EXACT < 30, NEAR < 90, WRONG ≥ 90. `hit` =
EXACT+NEAR+CORRECT-NONE, `strict` = EXACT+CORRECT-NONE. INVENTED = we shipped a
colour for a brand that has none.

**The font work generalised. The accent work did not.** Font accuracy moved
+33pp on tune and +34pp on holdout — same direction, same size, which is what a
real fix looks like. Accent moved +26pp on tune and **−7pp** on holdout, which
is what fitting the sample looks like. That gap is the single most useful fact
in this document.

The font change transferred because it stopped being a pattern-match on family
names and became a principle: score a family by what the site's CSS PUTS IT ON
(heading and body selectors), not by what it is called.

### The holdout seal is broken

The holdout rows were decoded and read into a working session on 2026-08-09
while diagnosing the achromatic gap. The 64%/36% figures above were measured
BEFORE that and are honest. **Any future change calibrated against these 52
sites can no longer claim a clean holdout number** — build a new one from fresh
hosts first (`split.mjs` does the hashing).

## The lab

Everything lives in `qa/brand-truth/`. No model call, no npm install, no repo
modification.

```bash
cd qa/brand-truth && node score.mjs --half tune
```

- `score.mjs` — the scorer. `--half tune|holdout|both`, `--only <host>`,
  `--json out.json`, `--refetch`, `--reveal-holdout`.
- `harness.mjs` — loads the REAL `readSiteBrand`/`resolveBrandIdentity` out of
  the repo with the network recorded once and replayed after. Interception is
  an esbuild alias on `lib/crawl/ssrf-guard`'s `safeFetch` — the single door
  every crawl fetch goes through. It uses undici's fetch, so patching
  `globalThis.fetch` would silently do nothing; the alias proves interception
  instead. `RB_TRUTH_OFFLINE=1` forbids live fetches so a run cannot silently
  re-measure.
- `cache/` — ~18MB of recorded responses, gitignored, regenerable. A live-only
  scorer measures the picker AND whatever the CDN served this minute;
  Cloudflare and Stripe both A/B their homepages.
- `truth-tune.json`, `_sealed/truth-holdout.b64`, `truth-excluded.json` — the
  truth set. Every value came from the brand's own served bytes via
  `probe-evidence.mjs` / `probe-frequency.mjs` / `probe-builder-theme.mjs`, not
  from memory. **The favicon is never a truth source** — it is the signal the
  fixer uses, so deriving truth from it would make the truth agree with the fix
  by construction. Where two defensible answers sat more than a band apart the
  row is `excluded` rather than guessed.
- `instrumentation.patch` — `git apply` this to re-enable the measurement-only
  fields `probe-ink.mjs` and `probe-achromatic.mjs` read. Not in the shipped
  code, because nothing reads them (see below).

## Killed by data — do NOT rebuild these

### 1. `votes` — ranking a named token by how many properties resolve to it

Removed 2026-08-09. It bought exactly one row on the half it was tuned against
and cost one on the half it had never seen. asana.com shipped `#879fc8`, a pale
UI blue that merely appeared under more token names, instead of its actual
`#f06a6a`. Popularity among token names is not brand-ness — a design system
names its greys the most. Ablation-isolated; removing it took holdout accent
57% → 64%.

### 2. Vividness re-ranking of the palette

The palette stopped being a flat frequency list when `mergePaletteByProvenance`
landed; it is ranked by how strong the site's own claim is. Re-sorting by
vividness discards that ranking for a proxy. Scored over the tune half it moved
17 sites to a WORSE band and 2 to a better one — slack's `#4a154b` to a green,
mailchimp's `#ffe01b` to a teal, monzo's `#ff4f40` to a cyan.

### 3. Giving the wide chromaticity band to whatever is FIRST

A dark brand colour is still a brand colour (slack aubergine, midnight navy),
so the strict luminance band 0.15–0.85 has to widen for some entries. Keying
that on POSITION reintroduced the exact bug the band exists to stop: Fuse's
`#440b12`, a saturated dark maroon that merely headed a frequency list, sailed
through as "the brand" — the page background, again. Three existing tests
caught it. The band is earned by being **declared** (a colour the site itself
named `--brand`/`--primary`), not by being first.

### 4. "The site declared greyscale" as an achromatic detector

`extractNamedBrandColors` applies a chroma floor, so a site naming
`--accent: #dcdcdc` and a site naming nothing come back identically empty —
different claims, same output. Splitting them (`declaredBrandTokens`) is
correct as a signal and useless as a detector:

```
caught 3 of 9 achromatic brands, with 4 false positives among 43 colour brands
```

The false positives are not marginal — discord `#5865f2`, sentry `#6a5fc1`,
brooklinen `#283455` are all currently CORRECT and would be suppressed.
Guarding on "and no chromatic theme-color" rescues those three and leaves
drinkolipop, whose `#14433d` is EXACT today and would become INVENTED. Net
+2 rows on 52. That is inside noise, and it is the same trade as the `votes`
rule that was just removed for making it.

### 5. Ink dominance as an achromatic detector

The hypothesis: a real brand colour OWNS the page's chromatic ink, while a
greyscale brand's saturated pixels are scattered across payment badges, social
icons, syntax-highlight tokens and customer logos. Measured as the leading hue
family's share of all chromatic colour occurrences in the site's own CSS
(`chromaticInkShare`, in `instrumentation.patch`).

**The two distributions completely overlap.**

```
achromatic brands   0.094 (notion)  …  0.508 (everlane)
colour brands       0.140 (supabase) …  1.000 (robinhood, linear, duolingo)
```

Every threshold is net negative. The best is 0.15: catches 2 of 9 achromatic
brands and breaks supabase. At 0.35 it catches 6 and breaks 20. Absolute
counts separate no better — everlane's leader is served 30 times and gymshark's
43, while gitlab's real accent appears 8 times and robinhood's 18.

### 6. "No strong claim → ask the user" as a confirmation prompt

The softest version of the idea: don't suppress the colour, just mark it
unconfirmed when nothing strong backs it — no chromatic `--brand`/`--primary`/
`--accent` token, and no chromatic fill in the brand's own logo mark. A
non-blocking "is this right?" is far cheaper to be wrong about than a
suppression. Measured (`probe-unconfirmed.mjs`):

```
flagged 27 of 52 sites — 7 of 9 achromatic caught, 20 colour brands also asked
precision 26%
```

That is a confirmation prompt on **more than half of all crawls**, three
quarters of which are unnecessary — the brand step would read as broken.
Tightening it with the ink share from #5 gives 6 caught / 13 noise, precision
32%: still bad, and now two tuned constants deep.

The measurement also killed the premise underneath it. retool declares **29**
chromatic brand-named tokens and notion declares 5 — a product with a design
system names dozens of chromatic UI tokens while having no brand colour at all.
"Declared a brand token" does not mean "has a brand colour".

## The remaining gap, stated honestly

**Achromatic brands are 0 for 9.** Every black-and-white brand gets a colour
invented for it: notion `#097fe8`, vercel `#ef4444`, squarespace `#087bb5`,
resend `#62ffb3`, retool `#eca438`, mejuri `#b64126` on tune; gymshark
`#bf2e35`, everlane `#006adc`, greenandthegrain `#ae81ff` on holdout. All nine
arrive through `pickSignatureColor`'s ranked-palette branch — the logo fallback
and the saturated rescue never fire, so a suppression aimed at either is a
no-op. That was measured (`probe-stage.mjs`), not assumed.

`resolveBrandIdentity` already supports the answer: `signature: null` sets
`signature_missing` (`brand-identity.ts`), and `pipeline.ts` already handles
it. Nothing ever sets it. The schema is not the blocker; the SIGNAL is.

What separates these cases in the truth evidence is **what the colour is
painted on** — a payment badge, a syntax token, a customer logo, an embedded
Radix search widget — and no statistic over stylesheet colour literals carries
that semantic. Three candidate signals derivable from the bytes we already have
(#4, #5, #6 above) have now been built and measured, and all three are net
negative. This is not "we haven't tried yet"; it is a measured limit of the
current inputs.

One honest route remains: **ask the vision reader.**
`extractBrandColorRoles` (Kimi K2.6) reads the homepage screenshot and returns
an `accent` role — it is the one component in the stack that can see that a
page's only saturated pixels are a Visa logo. The deck path (`site-brand.ts`)
deliberately passes `image: []` today. That is a paid call per crawl, so it is
a product and cost decision, not a code decision. Before spending it, the
question to settle is whether the vision reader ACTUALLY declines on an
achromatic page or invents like everything else — one cheap probe over the nine
known achromatic hosts answers that, and should run before any wiring.

Until then the gap ships as-is: a monochrome brand gets a colour it did not
ask for, and the user changes it in the Brand panel — which is a 0-token
deterministic re-skin, not a rebuild. That is the honest cost of the gap and
it is worth stating out loud rather than papering over with a tuned constant.

## Real bugs the truth set surfaced along the way

Neither was about colour ranking; both were found only because something was
being measured against reality.

- **The SSRF guard blocked 65,536 public addresses.** `if (a === 192 && b === 0)`
  blocks all of `192.0.0.0/16` while its own comment says `/24`. heroku.com is
  `192.0.66.110`, a public WP-VIP address that answers 200 to a plain fetch and
  got "resolves to a private address" from us. Every customer hosted there was
  silently uncrawlable. Fixed to the two `/24`s the comment always meant.
- **`extractBrand()` was never called on the live deck path** after the July
  pivot, which is why "crawling isn't working" was true and invisible.
