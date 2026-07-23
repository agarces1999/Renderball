# Pivot: AI-Native Canvas (decided 2026-07-23)

Renderball pivots from "AI video generation" to an **AI-native design tool**
(Canva-class): a brief becomes an on-brand, editable, multi-format design
document. **Wedge format: presentation decks.** Video is shelved, not deleted.

This doc is the operating spec for the pivot. Every session doing product or
engine work reads this first. The keep/adapt/shelve map below is grounded in a
five-track codebase survey run on 2026-07-23.

## Why (founder call, Alfonso)

- With enough tokens and prompts, any LLM wrapper can match raw generation
  quality. The durable differentiator is the **experience**: marquee-to-generate
  (draw an area, type a prompt, get an element in exactly that box) plus a real
  direct-manipulation editor over discretely positioned AI-generated elements.
- Too long building in the dark. Decks launch faster than video, get real
  feedback sooner, and monetize a proven market (Gamma et al.) whose editing
  story is weak — precisely where we are strong.
- Nothing important is thrown away: the engine's atomic unit was already a
  static frame; video was a thin wrapper (see seams below).

## Locked decisions

1. **Wedge: decks first.** Social graphics follow nearly free (a post is a
   1-page document). Multi-format menu after that.
2. **Video: shelved, kept.** Hidden from UI; engine + choreographer stay
   intact. "Animate this deck" returns later as a differentiator (motion is a
   zero-token compile step for us).
3. **Name: stays Renderball.** No rename. Copy still re-vocabularizes from
   video nouns to design/deck nouns; the orb motif stays (reads as generation
   magic; "see it before you spend" survives as the outline gate).
4. **Pricing: usage-based tokens.** First **1M tokens free**, then per-token
   billing at a markup on our model costs, via Stripe usage-based billing
   (Billing Meters / meter events; free allowance = $0 first tier or granted
   credits). Deterministic edits (move/resize/text/delete/undo) cost 0 tokens →
   the product story is "editing is free, generating is metered."
   At today's burn, 1M tokens ≈ 3 full deck builds (~$1.04 COGS each at the
   fast-router rates); a marquee-generate is a few k tokens.
   **Markup locked (founder, 2026-07-23): 3× token cost** — blended COGS ≈
   $3.10/1M tokens → list price ≈ **$9.30 per 1M tokens** (a deck ≈ $3.10 to
   the user; re-derive the blend if the in/out mix or router rates change).
   Still open: user-facing framing (raw tokens vs "credits"). Supersedes the
   subscription-first plan in docs/LAUNCH.md. Domain renderball.com purchased
   on Cloudflare 2026-07-23.

## The two video seams (why this pivot is small)

Generated scene components are pure React + CSS — zero Remotion APIs inside
(`lib/render/build-wrapper.ts:1` declares itself "the ONLY video-aware code
path"). Video attaches at exactly two places downstream of composition:

1. `applyChoreography` — one call in `lib/agents/cast-build.ts` (~:3378).
   Skip it → fully static settled frames.
2. `buildIndexTsx` (`lib/render/build-wrapper.ts`) + the MP4 encode
   (`lib/render/render-brief.ts`). Bypass → no timeline, no Remotion.

The QA gates already render every scene as a settled static frame at exact
canvas dims via Playwright (`lib/render/measure-scene.ts:662`, settle mode in
`lib/render/scene-iframe.ts:169`). **Static export = promoting the QA
screenshot to product output.**

## Reuse map

**KEEP AS-IS (the moat):**
- Generation engine, cast/LEGO path (`lib/agents/*`): composition-head bounds
  authoring, layout-composer, ink allocation, parallel piece fills, assemble.
  An N-slide deck is what it produces today minus the temporal wrapper.
  Scene `register` enum (stat/quote/full-bleed/split/list/centered) = slide
  archetypes. Unused per-scene voiceover script = speaker notes for free.
- Spatial-quality system (docs/SPATIAL_QUALITY.md) — MORE central now, not
  less. Static designs live or die on layout quality.
- Editor (`app/preview/[id]/ElementEditor.tsx`, `lib/edit/*`):
  marquee-to-generate (bounds enforced deterministically — the LLM never
  controls position/size), 8-handle resize, drag-move, in-iframe inline text
  editing, format toolbar, 25-deep ⌘Z undo. All manipulation ops are 0-LLM.
- Brand crawl (`lib/crawl/*`): URL → vetted logo, pixel-corrected palette,
  fonts with real @font-face srcs, design language. Ships as-is.
- All commercialization infra: Clerk, Stripe, R2, metering framework,
  zai-breaker, build locks, Docker/Railway deploy. Metered unit is already
  generic ops; price lives in Stripe objects, not code.

**ADAPT (small, known):**
- `lib/agents/script-generator.ts` → deck-outline generator: drop the timing
  half of the prompt (scene tiling over seconds, beat floors), `duration_seconds`
  → `slide_count`, voiceover → speaker notes. Near-rename per survey.
- Review screen → outline approval (same "approve before expensive compute"
  principle from DESIGN.md).
- Data model: `Project` is already a generic JSON-blob document; `Render`
  table generalizes to exports; time/audio fields on `Script` optionalized.
- Brand-kit consumers: `BrandExtract` schema is clean/format-agnostic, but the
  prompt layer (`design-constraints.ts`, pipeline prompt block) speaks "film
  frame" — needs a static-design variant. `crawl-theme.ts` re-derived without
  animation keyframes.

**SHELVE (dormant, do not delete):** `render-brief.ts` (MP4),
`buildIndexTsx`/`SectionClock`/`SceneTransition` in build-wrapper (keep
`dimensionsForScript` + shim sources — shared), `choreograph.ts` call site,
`render-mp4` route, remotion deps, transition/animation-clock tests. Audio was
never built (schema placeholders only).

**NEW:**
1. Static export: PNG per page (reuse measure-scene machinery) + PDF assembly
   (pdf-lib over PNGs or page.pdf). PPTX later.
2. Document lifecycle: blank-canvas start, page add/remove/reorder/duplicate
   (today's scene rail only selects).
3. Image upload onto canvas (insert-image is placeholder-only today; R2 upload
   infra exists — wire it).
4. Editor vocabulary tier: font-family picker, z-order, duplicate/nudge/
   delete-key/redo, multi-select + snapping later. Wedge is generation, not
   Canva manipulation parity.
5. BrandKit as a first-class entity (today welded to one brief) + kit reuse
   across documents.
6. Token metering → DB per-user meter + Stripe meter events + 1M free
   allowance (cost ledger exists in `lib/usage.ts`, file-based).
7. Copy re-vocabulary (~229 user-facing video nouns) + landing rewrite for
   decks.

## P1 validation (2026-07-23, same day)

First-ever deck build (flarebit.ai, 5 slides, freeform brief): **clean in
4m37s, ~$1.04** (257k in / 76k out at the fast router's real $2.10/$6.60
rate) on the Fireworks-only stack — vs 37-82 min for video builds. PDF/PNG
export proven on stored builds and on the live deck; marquee-to-generate
verified live on a deck slide. Deck flipped to the DEFAULT document type in
BriefForm. **Honest caveat:** build #1 ran with NO vision-gate coverage —
the migration's first vision model (Qwen-VL) turned out not to be deployed
on our Fireworks account and the advisory gate skipped silently; the
deterministic gate battery did all the passing. Vision is now Kimi K2.6
(probe-verified reading real slides, incl. a generated element, verbatim);
the first vision-gated deck build is still ahead. Model stack: z.ai removed
entirely the same day (founder call); GLM-5.2 stays, served by Fireworks;
see CLAUDE.md model routing.

## Deck build-path decision (2026-07-23, head-to-head)

Same-day comparison on 5-slide decks: **parallel path** (flarebit.ai): 4m37s,
~$1.04, clean output, minor advisories. **Cast path** (linear.app, Fireworks
GLM leaves + full spatial battery + Kimi vision): 9m0s, $2.31, round-0 flagged
9 pieces, 5 pieces escalated with no progress, residual washout/void/contrast
defects VISIBLE in the export — and scene 3 fails SSR ("rows is not defined")
yet the build returned ok:true (measure-error is not fail-closed on the cast
path — bug filed). **Decks default to the PARALLEL path.** Cast stays in the
spatial lab until its repair loop beats parallel on decks; do not flip it on
product traffic. Kimi vision confirmed live end-to-end (crawl reads + 49k-token
scene QA billed) — the re-baseline dataset accrues on parallel builds' advisory
gate. Note: Linear's achromatic palette triggered the honest
"no brand accent recoverable" degradation; grayscale brands need a
brand-color decision UI eventually.

## Build economics note

A deck costs ≈ a video build today (the spend is composition + spatial repair,
which we keep; the shelved video tail was cheap). The lever video never allowed:
**editor-primacy relaxes the perfection bar** — output is instantly fixable, so
gate/retry ceilings can come down and slides can reveal progressively as
parallel fills finish. Perceived build time is the metric now, not gate-clean
time. Single graphic ≈ 1/N of a build (~$0.10–0.30, low single-digit minutes).

## Phase plan

- **P1 — deck spine:** deck build mode (skip the two video seams) +
  outline-mode script generator + PNG/PDF export + page rail (add/remove/
  reorder/duplicate) + export buttons replacing Export MP4 + review-as-outline.
  Acceptance: URL+brief → approve outline → on-brand N-slide deck → edit
  elements/marquee → export PDF + PNGs.
- **P2 — editor baseline:** image upload, typography controls for bound text,
  duplicate/nudge/delete-key/redo/z-order, blank-canvas start, 1-page formats
  (social sizes), extra canvas dims (4:5, story, A4) in `dimensionsForScript`.
- **P3 — launch wrap:** copy/landing rewrite, token metering + Stripe meters +
  free allowance, BrandKit entity v1, provision credentials (Stripe, Clerk
  prod, R2, domain — founder side), LAUNCH.md hard gates (moderation, DMCA
  agent) re-checked for the new surface.
- **Deferred:** PPTX export, template gallery, animated decks (video's
  return), asset library/Pexels, multi-kit management, sharing/collab.

## Coordination

- Two Claude sessions share this working tree (engine session + editor
  session). In-flight uncommitted spatial/editor WIP (composition-head,
  lego-store, lib/edit/*, ElementEditor, spatial scripts/docs) should land
  before P1 edits so pivot diffs stay clean. The spatial work transfers 100% —
  land it, don't discard it.
- DESIGN.md still governs visual/UX decisions. "Story before render" → 
  "outline before build." Chrome stays quiet; the user's work stays loudest.
