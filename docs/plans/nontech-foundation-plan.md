# Plan — Non-tech quality: foundation fixes

> **VIDEO-ERA PLAN — retired (docs/HARNESS.md, 2026-08-27).** The quality gaps it targets are addressed architecturally by the one-call harness, not by these fixes.

**Goal:** structurally fix the quality gaps the 5-brand non-tech pilot exposed
(Falabella/Coniglio, Patagonia, Glossier, Oatly, Tony's), without adding new
infrastructure. Real-imagery sourcing is explicitly deferred (see NOT in scope).

**Reviewed via** `/plan-eng-review`. Scope: **foundation only** (chosen at the
Step-0 gate). All changes are prompt + crawl edits to existing files plus one
small pure helper.

---

## Root causes (from reading the generated source)

| Symptom (pilot) | Root cause | Layer |
|---|---|---|
| Falabella "logo" = a search-magnifier SVG; invented `LOGO_URL="https://falabella.com"` | Agent improvises brand assets from a raw crawl dump | crawl + agent |
| Falabella headline in Georgia serif | `swiper-icons` (a `*-icons` suffix font) passed the icon-font filter and was classified display → agent fell back to generic serif | crawl |
| Every scene/brand looks templated (one italic word, same stack) | Mandatory italic-accent HARD RULE + no per-scene archetype variation | script + design prompt |
| Glossier logo invisible on last slide | Light favicon variant rendered on a near-white scene (no contrast) | agent |
| Tony's bar = red on red-brown | Decorative prop filled brand-red, placed on a brand-red bg | agent |
| Patagonia/Glossier feel hollow ("mostly titles", "abstract product") | Script `visual_concept` calls for photographs; no usable photo existed → text/abstract CSS | (deferred: imagery) |

---

## Decisions locked (review gate)

1. **Scope:** foundation only; real imagery is a separate, later plan.
2. **Brand identity is resolved in code** (new `resolveBrandIdentity()`), not improvised by the agent.
3. **Scene variety lives in the script** (per-scene `register`) + design-prompt archetype rotation; italic-accent demoted to optional.
4. **Contrast/alignment fixed via design-prompt rules** (no new gate).

---

## Architecture — data flow

The backbone: stop handing the agent a raw asset dump. Resolve a clean,
validated `BrandIdentity` once, in code, and hand it to the agent locked.

```
CRAWL (extract-brand.ts)            RESOLVE (NEW lib/crawl/brand-identity.ts)        DESIGN AGENT
  logo_hd (raw; may be OG/icon) ─┐                                                   receives a LOCKED
  apple_touch_icon             ─┤   pickLogo():                                      BrandIdentity it MUST use:
  favicon                      ─┼─► • reject UI-icon SVGs (search, menu, …)  ──────►  • logo: {url|null,
  fonts[] (may incl *-icons)   ─┤   • reject share/OG images as logos                 •   onLight, onDark}
  palette[]                    ─┘   • prefer real logo > apple-touch > favicon        • wordmark: {text, font}
                                    • none usable → logo=null (use wordmark)            (used when logo=null)
                                    validateFonts():                                  • fonts: {display, body}
                                    • drop icon-fonts (prefix AND suffix)             • palette[]
                                    • real family w/o src → curated fallback          → cannot invent URLs,
                                      (NOT generic serif)                               cannot pick an icon
                                                                                        font, cannot grab a
                                                                                        random SVG
```

Variety flow (decided upstream, executed downstream):

```
SCRIPT GEN ──► each scene gets a `register`:        DESIGN AGENT rotates archetype per register;
  stat | quote | full-bleed | split | list |        no two ADJACENT scenes share a treatment;
  centered                                           italic-accent optional (≤1–2 per video)
```

---

## Workstreams (files + specifics)

### W1 — `resolveBrandIdentity()` (new, pure)  `lib/crawl/brand-identity.ts`
- Input: `BrandExtract` (+ brand name from brief/url). Output: `BrandIdentity`.
- `pickLogo()`: reject SVGs whose url/name implies a UI glyph (`search|menu|cart|close|arrow|chevron|hamburger|icon`); reject the OG/share image as a logo; rank real-logo > apple-touch-icon > favicon; if none, `logo=null`.
- Logo luminance probe → `onLight`/`onDark` hints so the agent picks a contrasting placement (fixes Glossier).
- `wordmark`: brand name + chosen display font, used when `logo=null` (never a broken `<Img>`).
- `validateFonts()`: drop icon-fonts; a real family with no usable `src` → a curated fallback chosen by classification (serif/grotesk/etc.), NOT `Georgia` blanket.
- Plumb into `pipeline.ts` (`buildAgentInputFromBrief`) so both preview + render paths get it.

### W2 — icon-font filter  `lib/crawl/extract-brand.ts:921` (`ICON_FONT_RX`)
- Add the **suffix** form: `[\w-]*-icons?\b` (catches `swiper-icons`, `oatly-icons`) alongside the existing prefix `icon-`.
- Guard against over-filtering real names: only the `-icon(s)` token, not substrings (e.g. `sodimac` stays).

### W3 — scene `register`  `lib/agents/prompts/script-generator.ts` + `src/schema.ts`
- Schema: add optional `register: "stat"|"quote"|"full-bleed"|"split"|"list"|"centered"` per scene.
- Script-gen prompt: assign each scene a register, biasing toward variety across the arc.
- `schema-validator.ts`: validate/normalize the enum (default `centered`).

### W4 — design-agent prompt  `lib/agents/prompts/design-agent.ts`
- Consume `BrandIdentity` (use the logo/wordmark/fonts verbatim; never invent a URL).
- Consume `register` → map to a layout archetype; **no two adjacent scenes share a treatment**.
- Demote italic-accent: HARD RULE → optional, ≤1–2 uses per video.
- Contrast HARD RULE: brand-color props/logo must sit on a contrasting background; pick logo variant/text color by scene-bg luminance; consistent vertical rhythm (no orphaned low-pinned boxes).

---

## Test coverage diagram

```
[+] lib/crawl/brand-identity.ts (NEW — pure, fully unit-testable)
  resolveBrandIdentity()
    ├── [★★★ planned] logo: reject search/UI-icon SVG → falls through
    ├── [★★★ planned] logo: OG/share image rejected (not a logo)
    ├── [★★★ planned] logo: none usable → wordmark {brandName, displayFont}, url=null
    ├── [★★★ planned] logo: real logo present → used; onLight/onDark luminance set
    ├── [★★★ planned] fonts: '-icons' suffix dropped (swiper-icons, oatly-icons)
    ├── [★★★ planned] fonts: real name 'sodimac' NOT dropped (no over-filter)
    ├── [★★★ planned] fonts: real family w/o src → curated fallback (not Georgia)
    └── [★★★ planned] fonts: real family w/ src → used verbatim
[~] lib/crawl/extract-brand.ts (ICON_FONT_RX)
    └── [★★★ planned] suffix '-icons' matched; prefix 'icon-' still matched; reals safe
[~] src/schema.ts + schema-validator.ts (scene.register)
    └── [★★  planned] valid enum accepted; missing → 'centered'; junk → 'centered'
[~] prompts (design-agent, script-generator)  [→REBUILD] verified by re-rendering
    └── 2 brands (Falabella 9:16, Patagonia 16:9): logo real, no Georgia, registers vary

COVERAGE: 11 unit paths planned + 1 rebuild check
GAPS at plan time: all (greenfield) — tests written alongside code
```

Prompt changes aren't unit-testable; they're verified by rebuilding Falabella +
Patagonia and asserting (via the existing gate functions + a grep): logo url is a
real asset or wordmark (never `falabella.com`), display font is not a generic
serif fallback, and `data-` register/archetype differs across adjacent scenes.

---

## Failure modes

| New/changed path | Realistic failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| `pickLogo` rejects everything | All candidates filtered → `logo=null` | yes | yes → wordmark text | Brand name as styled text (acceptable) |
| `validateFonts` drops the only font | No usable family | yes | yes → curated fallback | On-tone fallback, not Georgia |
| over-aggressive icon regex | Real font wrongly dropped (e.g. `sodimac`) | yes (guard test) | yes | — |
| `register` enum unknown | Script emits a bad register | yes | yes → default `centered` | — |
| agent ignores locked identity | Model still invents a URL | rebuild check | partial | **flagged**: rebuild assertion catches a non-asset logo URL |

No silent critical gaps: the worst case (agent ignores the locked identity) is
caught by the rebuild assertion before we trust the change.

---

## NOT in scope (deferred, with rationale)

- **Real imagery / video sourcing** (stock API, AI-gen, user upload) — the true ceiling for non-tech, but it adds an external integration (innovation token) and needs its own sourcing decision. Separate plan.
- **Prop-contrast gate** (`assessPropContrast`) — subjective; high false-positive risk. Add only if prompt rules don't hold.
- **Variety gate** (`assessVariety`) — same reason; revisit if the templated feel survives the script-register + archetype rotation.
- **Wider illustration library** — helps abstract scenes, doesn't fix "needs a real photo"; fold into the imagery plan.

---

## What already exists (reuse, not rebuild)

- `ICON_FONT_RX` (extract-brand.ts:921) — extend, don't replace.
- `discoverLogoHd()` (extract-brand.ts:396) — its candidate-gathering feeds `resolveBrandIdentity`; the resolver wraps/hardens it rather than duplicating the fetch.
- `assessContrast()` — already covers text-vs-bg; logo/prop contrast handled by prompt rules, not a parallel gate.
- Design-prompt archetype catalog + content schema — reused; we add register→archetype mapping and a no-repeat rule.
- `page_images` plumbing — already crawled + passed; the imagery plan will use it.

---

## Parallelization

```
Lane A (crawl):   W1 resolveBrandIdentity  →  W2 icon-font regex   (shared: lib/crawl/, sequential)
Lane B (script):  W3 register + schema                              (independent: schema + script-gen)
Lane C (design):  W4 design-agent prompt    depends on W1 (consumes BrandIdentity) + W3 (consumes register)

Launch A + B in parallel. When both merge, do C. Then rebuild-verify (Falabella + Patagonia).
Conflict flag: none — A=lib/crawl, B=schema+script-gen, C=design prompt. Disjoint.
```

---

## Implementation Tasks

- [ ] **T1 (P1, human ~3h / CC ~25min)** — `lib/crawl/brand-identity.ts` — build `resolveBrandIdentity()` (logo pick + reject UI/OG, luminance, wordmark fallback, font validation) + unit tests (8 paths).
  - Surfaced by: Architecture #1. Verify: `tsx` unit test, 8/8.
- [ ] **T2 (P1, human ~30min / CC ~5min)** — `extract-brand.ts` — extend `ICON_FONT_RX` with `-icons` suffix + over-filter guard test.
  - Verify: unit test (swiper-icons/oatly-icons dropped; sodimac kept).
- [ ] **T3 (P1, human ~1h / CC ~10min)** — `src/schema.ts` + `schema-validator.ts` + `script-generator.ts` — add `register` per scene + assignment prompt + validation.
  - Verify: validator unit test; generate 1 script, registers vary.
- [ ] **T4 (P1, human ~2h / CC ~20min)** — `design-agent.ts` — consume BrandIdentity + register→archetype mapping + no-adjacent-repeat + italic optional + contrast/rhythm rules.
  - Verify: rebuild Falabella + Patagonia; assert real logo/font + varied archetypes.
- [ ] **T5 (P1, human ~30min / CC ~10min)** — `pipeline.ts` — plumb `BrandIdentity` into `buildAgentInputFromBrief` (preview + render).
  - Verify: tsc + a preview build returns a non-placeholder logo.
- [ ] **T6 (P2, human ~1h / CC ~15min)** — rebuild-verify all 5 pilot brands; confirm no Georgia fallback, no invented logo URLs, varied layouts.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 decisions resolved, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | n/a |

- **Scope:** reduced at the Step-0 gate to foundation only (real imagery deferred).
- **UNRESOLVED:** 0
- **Critical gaps:** 0 (worst case — agent ignores the locked identity — is caught by the rebuild assertion in T4/T6).
- **VERDICT:** ENG CLEARED — ready to implement the foundation. Outside voice not yet run (optional). Real-imagery sourcing needs its own plan before it is built.
