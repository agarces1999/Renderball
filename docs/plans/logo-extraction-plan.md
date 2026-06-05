# Robust Logo Resolution — Eng Plan

**Goal:** return a *real* logo (or an honest wordmark — never a fabricated mark)
for the vast majority of domains. Driven by the Fuse failure: the crawl resolved
`logo_hd` to a Webflow `Screenshot….png`, the resolver correctly rejected it,
left no logo, and the design agent invented a fake "two squares" mark.

**Decisions locked (eng-review):**
- **D1 — agentic finder, no empty hands.** The logo finder is an agent that
  inspects the page AND looks it up online, and is not allowed to come back with
  a fabricated mark. Real logo, or honest wordmark — nothing invented.
- **D2 — hybrid escalation.** Cheap DOM+web first; render-and-screenshot the
  page only when those come up empty (reuse the chromium `@remotion/renderer`
  already downloads — no new 300MB browser dep).

---

## What already exists (reuse, do NOT rebuild)

| Component | File | Keep / Change |
|---|---|---|
| Candidate net (Clearbit, static paths, header `<img>`, simple-icons, apple-touch, og, favicon) | `extract-brand.ts: collectLogoCandidates` | **Extend** (add inline-SVG, CSS bg, srcset) |
| Vision logo agent (one-shot pick + web_search) | `find-logo-agent.ts: findBrandLogo` | **Rewrite** into an agentic loop |
| Deterministic resolver (regex reject filters → logo or wordmark) | `brand-identity.ts: resolveBrandIdentity / pickLogo` | **Simplify** (trust the agent; stop re-litigating) |
| Customer-logo-grid stripping ("trusted by") | `extract-brand.ts` | Keep as-is (good) |
| Wizard logo upload fallback | wizard | Keep (manual override floor) |
| `sharp` image decode | dep (just added) | **Use** for dimension/aspect validation |

The system is not missing — it is mis-wired. Four root causes:

1. **Inline-SVG nav logos are never collected.** `collectHeaderImgs` scans only
   `<img>`. Modern sites (Webflow/React) inline the nav logo as `<svg>` → never a
   candidate. (This is the Fuse miss.)
2. **The vision agent picked the screenshot.** With the real logo absent, a
   homepage-screenshot apple-touch-icon *contains* branding, so vision chose it.
3. **No shared confidence model.** Layer 1 (vision) picks X; Layer 2 (regex) nulls
   X. All-or-nothing, no second-best, no graded confidence. The vision pass is
   wasted when the resolver disagrees.
4. **Wordmark floor not enforced.** `null` logo → the design agent fabricates
   instead of rendering the wordmark.

---

## Target architecture

```
extractBrand(url)
  │
  ├─ collectLogoCandidates(html, url)                         [Phase 1: EXTENDED]
  │     cheap "inspect the code" — gather, don't decide:
  │       • inline <svg> in <header>/<nav>      → data: URL   (NEW, the Fuse fix)
  │       • CSS background-image url(...) scoped to header/nav (NEW)
  │       • <img> src + srcset + <picture>      same-origin / "logo" in path
  │       • /logo.svg|png static-path probes    (exists)
  │       • Clearbit + simple-icons + apple-touch + og + favicon (exists)
  │     each candidate gets a PRIOR score (source) + cheap sharp dims if fetchable
  │
  ├─ resolveLogoAgent(domain, title, candidates)   [Phase 1: AGENTIC LOOP]
  │   ┌───────────────────────────────────────────────────────────────┐
  │   │ round 1  vision over candidates (priors + dims)                 │
  │   │            confident real mark? → validate → RETURN             │
  │   │ round 2  web_search "{brand} logo svg|png", press kit, brand    │
  │   │            assets → fetch → validate → RETURN                   │
  │   │ round 3  ESCALATE (Phase 2): render header screenshot,          │
  │   │            agent SEES rendered logo → extract its node/url,     │
  │   │            or web_search with the visual description → RETURN   │
  │   └───────────────────────────────────────────────────────────────┘
  │     → { ok:true, url|svgDataUrl, confidence 0-1, source }
  │     → { ok:false }   ("can't fail" mandate ⇒ this is RARE)
  │
  ├─ logo_hd = result.url ; brand_extract.logo_confidence / .logo_source [NEW]
  │
resolveBrandIdentity(extract)                          [Phase 1: SIMPLIFIED]
  │     regex reject-filters move UPSTREAM (pre-filter candidates).
  │     pickLogo TRUSTS a validated agent pick (no post-null). Wordmark only
  │     when the agent genuinely returned nothing.
  │     → BrandIdentity { logo | null→wordmark, confidence }
  │
design-agent                                           [Phase 1: ENFORCED]
        logo present → render in BrandChrome ONLY
        logo null    → render WORDMARK as styled text. NEVER invent a mark.
                       throughline element MUST NOT be the brand logo.
        (gate: flag a shape/SVG labeled "logo" when identity.logo is null)
```

### Confidence priors (source → base score; vision + dims adjust)

```
inline nav <svg>            0.90   the brand's own rendered mark
/logo.svg|png static path   0.85   author placed it deliberately
header <img> same-origin    0.80   "logo" in path/alt/class
simple-icons brand match    0.75   curated, exact for known brands
external API (Logo.dev/CB)  0.70   real but generic
apple-touch-icon            0.50   always brand, low-res, often square
favicon                     0.30   tiny, square
og:image                    0.20   usually a share card
sharp dims: square & >800px → screenshot suspicion → −0.5 (reject if no other signal)
            wider-than-tall, 64–1024px → logo-like → +0.1
```

### The "never fail" contract (honest)
- Real logo in ~99%: page → web → render escalation.
- **Absolute floor = a clean WORDMARK** (brand name in the brand display font).
  100% real-logo recall is impossible (brand-new/tiny domains have no findable
  asset), so the wordmark is the safety floor. The win is: **we never fabricate a
  mark again.** "Can't fail" = the brand is always represented correctly (real
  mark, or its name in its font) and never with an invented logo.

---

## Phasing (incremental — Phase 1 is the 80% fix and ships alone)

### Phase 1 — DOM + web agentic finder (the core, fixes Fuse)
1. **`collectLogoCandidates`** — add inline-`<svg>`, CSS `background-image`, and
   `srcset`/`<picture>` collection scoped to header/nav. Reuse the existing
   customer-grid stripping so partner logos stay excluded.
2. **`find-logo-agent` → agentic loop** — multi-round tool-use (vision +
   web_search), bounded (≤4 rounds), `MODELS.logoAgent`. System prompt carries the
   "no empty hands; never accept a screenshot/UI-glyph/customer-logo; persist via
   web_search; return null ONLY if web search also fails" mandate. Returns
   `{url|svgDataUrl, confidence, source, rationale}`.
3. **sharp validation** — decode chosen + top candidates; reject screenshot-shaped
   (large + ~square), prefer logo-shaped; feed dims into confidence.
4. **`resolveBrandIdentity`** — move regex rejects upstream to candidate
   pre-filtering; `pickLogo` trusts a validated agent pick; wordmark only on a true
   empty. Surface `logo_confidence` + `logo_source`.
5. **design-agent prompt + gate** — wordmark-floor enforcement; never fabricate a
   mark; **un-couple the throughline element from the brand logo** (regression from
   the throughline mandate — the agent made the fake logo the throughline).

### Phase 2 — escalation + durability (the last mile)
6. **Header render+screenshot util** (escalation-only) — `puppeteer-core` pointed
   at the chromium executable `@remotion/renderer` already downloads (no second
   browser). Load URL, screenshot top ~220px, return PNG for the agent's round 3.
   Fallback if Remotion's chromium path isn't reusable: degrade to web-only (Phase
   1 still stands) and flag Playwright as a follow-up.
7. **Domain-level cache** — key by registrable domain; store
   `{url, confidence, source, ts}` under `.data/logo-cache/`. Re-crawls of the same
   domain are instant + deterministic. TTL ~30 days.
8. **Wizard surfacing** — show resolved logo + confidence + source; low-confidence
   (< 0.6) nudges the user to confirm/upload (the manual override already exists).

---

## Test coverage diagram

```
CODE PATHS                                              TARGET
[+] collectLogoCandidates()
  ├── inline <svg> in <header>/<nav>          [GAP→ADD] ★★★ Fuse fixture: nav <svg> becomes a candidate
  ├── CSS background-image in header          [GAP→ADD] ★★  div logo via background-image:url()
  ├── srcset / <picture>                      [GAP→ADD] ★★  responsive logo picks a source
  ├── customer-grid stripping                 [exists]  ★★★ "trusted by" imgs excluded (regression guard)
  └── empty header → whole-page slice         [GAP→ADD] ★★  no <header> tag fallback
[+] find-logo-agent (agentic loop)
  ├── round1 confident pick                   [GAP→ADD] ★★★ picks inline-svg over screenshot apple-touch
  ├── round2 web_search fallback              [GAP→ADD] ★★  candidates weak → web search returns press-kit svg
  ├── round3 render escalation [→E2E]         [GAP→ADD] ★★  DOM+web empty → screenshot → pick (Phase 2)
  ├── rejects screenshot/UI-glyph/customer    [GAP→ADD] ★★★ never returns a screenshot (the Fuse bug)
  ├── chosen-url HEAD 404 → reject            [exists]  ★★  hallucinated web URL rejected
  └── all fail → ok:false                     [GAP→ADD] ★★  truly logo-less domain → wordmark floor
[+] resolveBrandIdentity / pickLogo
  ├── trusts validated agent pick             [GAP→ADD] ★★★ agent pick NOT re-nulled by regex
  ├── null → wordmark                         [exists]  ★★★ clean styled brand name
  └── confidence/source surfaced              [GAP→ADD] ★★  fields populated
[+] design-agent (prompt-level → eval) [→EVAL]
  ├── null logo → wordmark, no fabrication    [GAP→ADD] ★★★ no invented mark when identity.logo null
  └── throughline ≠ logo                      [GAP→ADD] ★★  throughline element is not the brand mark
[+] logo cache (Phase 2)
  └── hit returns cached, miss resolves+writes [GAP→ADD] ★★  second crawl of same domain is instant

COVERAGE TARGET: every NEW path tested. Fixtures: Fuse (inline svg + screenshot
apple-touch), Stripe (clean static logo), a customer-grid site, a logo-less domain.
[→E2E] render escalation  [→EVAL] design-agent fabrication check
```

---

## Failure modes (each new path, one realistic production failure)

| Path | Failure | Test? | Error handling | User sees |
|---|---|---|---|---|
| Agentic loop | web_search disabled on account | yes | retry w/o tools (exists) → DOM-only | real logo or wordmark |
| Render escalation | chromium path not reusable / launch fails | yes | catch → web-only result | logo or wordmark (no crash) |
| sharp decode | candidate is SVG/AVIF sharp can't read | yes | skip dims, keep vision pick | unaffected |
| Agent loop | runs over round budget | yes | hard cap (≤4) → best-so-far or wordmark | bounded latency |
| Cache | stale/poisoned entry | yes | TTL + confidence stored; low-conf re-resolves | correct logo |
| **Wordmark floor** | agent returns null AND design agent still fabricates | **yes (gate)** | **gate flags fabricated mark** | **wordmark, never a fake mark** |

**Critical gap guarded:** a fabricated mark slipping through (the Fuse bug) — the
design-agent gate makes it a build failure, not a silent ship.

---

## NOT in scope (deferred, with rationale)
- **Brandfetch / Logo.dev paid tiers** — D1 chose an agentic finder over a single
  vendor API; web_search covers the "look it up online" need without a new key.
  Revisit only if web_search recall proves weak.
- **Live computed-style logo extraction** (reading the rendered DOM's logo element
  node) — the screenshot escalation already lets the agent SEE it; node extraction
  is a Phase-2+ refinement.
- **Logo recoloring / light-dark variants generation** — out of scope; we keep the
  existing URL-filename luminance hint.
- **Animated/Lottie logos** — not a logo-resolution concern.

## TODOS surfaced (confirm individually before adding)
- T-A: Logo cache (Phase 2 #7) — defer or bundle?
- T-B: Wizard low-confidence confirm UI (Phase 2 #8) — defer or bundle?

---

## Implementation Tasks
- [ ] **T1 (P1)** — extract-brand — collect inline `<svg>` + CSS bg + srcset in header/nav
  - Verify: Fuse fixture → nav `<svg>` appears in candidate list
- [ ] **T2 (P1)** — find-logo-agent — rewrite as bounded agentic loop (vision + web_search, no-empty mandate)
  - Verify: Fuse → returns real logo, never the screenshot
- [ ] **T3 (P1)** — find-logo-agent — sharp dimension/aspect validation + confidence scoring
- [ ] **T4 (P1)** — brand-identity — trust validated agent pick; pre-filter upstream; surface confidence/source
- [ ] **T5 (P1)** — design-agent prompt + gate — wordmark floor, no fabrication, throughline ≠ logo
- [ ] **T6 (P2)** — render util — puppeteer-core on Remotion's chromium; header screenshot; round-3 escalation
- [ ] **T7 (P2)** — domain logo cache (.data/logo-cache, TTL 30d)
- [ ] **T8 (P2)** — wizard surfacing of confidence/source + low-conf upload nudge

## Parallelization
- Lane A (sequential, `lib/crawl/`): T1 → T2 → T3 → T4
- Lane B (independent, `lib/agents/`): T5 (design-agent prompt + gate)
- Then Phase 2: T6 → T7 (Lane A), T8 (wizard, independent)
- Launch A + B in parallel; Phase 2 after Phase 1 merges.
