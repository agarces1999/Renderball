# Spatial Quality System — specification & state

_Last updated: 2026-07-23. This is the durable record of the spatial-composition
work: principles, mechanisms, calibration evidence, what is pending, and how to
validate. A new session should be able to continue from this file alone (plus
`.data/dogfood/SPATIAL_EXEC.md`, the running lab ledger)._

## Status at last update

- **Landed in working tree, suite green (80 test files, 0 failed; tsc clean), NOT yet committed** —
  git writes are blocked for the agent; the founder runs:
  ```
  git add lib/render/measure-scene.ts lib/render/hero-contrast.ts lib/render/hero-contrast.test.ts lib/render/quality-loop.ts lib/render/render-truth-gates.ts lib/render/render-truth-gates.test.ts lib/render/type-scale.ts lib/agents/cast-build.ts lib/agents/cast-build.test.ts lib/agents/predict-ink.ts lib/agents/allocate-apply.ts lib/agents/allocate-apply.test.ts lib/agents/layout-composer.ts && git commit -m "RB_ALLOCATE default ON + founder-QA v16: sparse washouts go to AI furnish (black-slab repair killed), type step-up occupies underfilled boxes, covered-text-cluster gate" && git push origin launch-deploy
  ```
  (Deliberately a file list: the founder's editor WIP — ElementEditor, lego-store,
  edit-* routes, composition-head working-tree changes — must never be staged.)
- **Pending build**: one live validation build (~$1) to see all three v16 fixes act on
  real frames. ALL spend requires founder approval first (Fireworks balance ≈$15;
  compute real costs from token counts at $2.10 in / $6.60 out per M — never estimate).
- **Pending work**: RB_DENSITY_FLOOR (spec below, not yet built).

## Principles (all measured, none aspirational)

1. **Ink is the unit of account.** Declared boxes lie: mocks paint their box
   pixel-exact (21/21 measured) but text paints ~1.45× smaller than its box
   (0/10 matched). All void/coverage decisions use PREDICTED INK
   (`lib/agents/predict-ink.ts`, mean height error 13.5%, bias ~0).
2. **Resize is the lever; reposition-only is harmful** (measured worse than the
   head 3×). The head's placement is good; its size arithmetic is bad.
3. **Occupy, don't redistribute** (founder directive, 2026-07-23): freed space
   must be FILLED — grow the type, add a real element — never just re-centered
   or parked as a blank band.
4. **Repairs must never manufacture a defect.** The v16 washout triage exists
   because a repair (ink paint-over) was the largest source of shipped defects.
5. **Detectors are calibrated on stored builds before they ship, and rules that
   measure no signal are killed, not tuned.** See "Killed by data" below.

## System map

| Component | File(s) | What it does |
|---|---|---|
| Ink prediction | `lib/agents/predict-ink.ts` | Strings → predicted text extent at a derived type scale. `inkSizedBox` (shrink-to-ink), `inkFilledBox` (v16 step-UP). |
| Allocator post-pass | `lib/agents/allocate-apply.ts` (`RB_ALLOCATE`, **default ON**, `off` = opt-out) | Runs in castBuild after plan-validate, before briefs. Order per text slot: (1) type STEP-UP if box ≪ ink capacity, (2) shrink-to-ink, (3) Tier-1 distribution (no-regression guard ≥2pp), (4) capped hero growth ≤1.3× on catastrophic ≥25% hero-adjacent void. Records: `allocated.json` per build. |
| Type scale | `lib/render/type-scale.ts` | Ramps (`HEADLINE_RAMP`/`BODY_RAMP`), derivation walks DOWN only; additive `override` hook is how step-up forces larger px. |
| Override threading | `lib/agents/layout-composer.ts` (`ElementSlot.typeScaleOverride`) → `lib/agents/cast-build.ts` `typeScaleForSlot` | ONE derivation point: briefs, capacity budgets, fit and the copy-overflow gate all see the same stepped scale. |
| Washout gate | `lib/render/hero-contrast.ts` | Pixel-samples hero regions (spread/std floors 45/19). v16: `readDominantPanel` (interior coverage + edge evidence), edge-treated panels (border/shadow) downgrade to advisory. |
| Washout triage | `lib/render/quality-loop.ts` (washout block) | v16: sparse panel (<`CARD_INTERIOR_FLOOR`=0.4 furnished) → paint-lift REFUSED, blocking AI furnish-regen ("fill / shrink-to-hug / remove backdrop"); dense → `forceHeroSurfaceLift` + REVERT GUARD (rolls back a lift that leaves blocking text-contrast in the piece); post-loop terminal → `subtleSurfaceLift` (border+tint+shadow, never ink). |
| Element measurement | `lib/render/measure-scene.ts` | Per-element rects + colors + `coveredAtCenter` + v16 `borderTopWidth`/`borderColor`/`boxShadow`. Persisted per build: `_measure/rects-scene-N.json` (full element arrays — offline calibration source). |
| Render-truth gates | `lib/render/render-truth-gates.ts` | 14 canonical blocking kinds. v16 added `covered-text-cluster` (≥2 covered content-text nodes in one piece → blocking regen naming the buried rows). `findIntraPieceOverlap` gained opts (`minFrac`, `requireControl`) for future sweeps; wired defaults unchanged. |

## The v16 fixes (founder QA of the alloc2 live A/B, 2026-07-23)

### 1. Black-slab washout repair killed
**Root cause (log-proven, both founder-flagged frames):**
`[washout-lift] sN.hero: FORCED surface lift (paint-rewrite → INK) — panel rgb(255,255,255)`.
The model emitted a white panel on the white canvas with sparse interior; the
deterministic lift painted the full box near-black (max-ΔL token); the spread
re-measure then PASSED it. Interior-text repaint misses template-literal/
class/inherited colors → 1.04:1 labels shipped "accepted and flagged".
**Fix:** sparsity triage + revert guard + subtle terminal + edge-evidence arm
(see System map). Telemetry: `WashoutLiftEvent.action` gained
`"sparse-furnish-routed"` and `"subtle-terminal"`, plus `reverted`/`revertReason`.
**Calibration (35 stored hero panels):** both founder black boxes SPARSE
(alloc2-on-2 s1 26.3%, alloc2-on-1 s3 29.6%); every founder-approved panel DENSE
(flags-notion s2 100%, rappi phones 90–98%, alloc2 s0/s4 92–99%). Zero mixups.

### 2. Type step-up (occupy the box)
`inkFilledBox`: when ink+padding fills <62% of a text box, walk the ramp UP in
lockstep (headline+body same index) to the largest step that stays ≤88% —
box KEPT. Override rides `ElementSlot.typeScaleOverride`, survives every
allocator exit path including bounds reverts (type is not geometry). Records in
`SceneAllocationRecord.steppedUp`; `[allocate] … stepped …` log lines; a
step-up-only scene reports `applied` with reason `type-step-up-only(…)`.

### 3. covered-text-cluster gate
The founder's s0 "overlapping elements in the center" class. Geometry sweeps
measured ZERO signal (see below); what separates is a CLUSTER (≥2) of text
nodes in one non-chrome/atmosphere piece whose centers hit-test to a covering
element. One node/scene is a known artifact (wide left-aligned eyebrow boxes
under transparent overlays). Calibrated on all 40 stored scenes: fires
alloc2-on-2 s0 (buried card footer), flags-notion s4 (CTA buried under the dark
bullet card), the old messy s0s; zero fires on founder-approved scenes.

### Killed by data (do NOT rebuild these)
- **Geometric intra-piece/panel×panel overlap for the s0 class**: swept 10
  configurations (frac 0.15–0.5 × control-required × panel minArea) over all
  stored scenes — the founder-flagged collisions never fire because the buried
  card paints no measurable rects of its own (run-1 s0's under-card is
  invisible to the element walk).
- **Cross-piece duplicate-copy deterministic deletion**: prefix/containment
  matching found ~30 legitimate mock-echoes-copy pairs (incl. founder-approved
  scenes) per real duplicate, and the actual run-2 status-line pair is
  same-piece anyway. Redundant-strip removal is instead folded into the
  covered-cluster regen instruction ("keep ONE, remove the other").
- **Run-1 s0 card-behind-card**: no deterministic instrument can see it.
  Levers: vision-judge probe (needs z.ai balance) or sub-element planning
  (backlog, structural).

## PENDING SPEC — RB_DENSITY_FLOOR (fix #2 step 3; designed, not built)

The founder's "add another UI element" placed at PLAN time (one pass of work):
- **Where:** `lib/render/run-preview-build.ts` after `generateComposition` +
  `enforcePlanFallback` (~L786–801), flag `RB_DENSITY_FLOOR` default OFF.
- **Coverage metric:** per scene, predicted-ink coverage of the frame from the
  head's authored composition — copy fields via `predictCopyInk` at the
  authored copy box; hero/diegetic boxes count as their box area (box=ink for
  mocks, 21/21 measured); atmosphere/chrome excluded.
- **Floor value:** calibrate offline on the 5 stored builds' plans first
  (pattern: the replay scripts below); pick the value that isolates the
  s0-class narrow-band scenes (bottom ~10–15%) — do not guess.
- **Action:** for an under-floor scene, ONE `generateComposition` call on a
  single-scene script slice, `intent` naming the empty regions and requiring
  EITHER a wider composition OR exactly one added subordinate element with
  REAL brief/script-bound content (a stat, caption row, logo chip, secondary
  mock detail — invented filler prohibited). Validate the merged scene list
  (`planValidationErrors`); accept only if predicted coverage improves AND
  validation is clean, else keep the original (allocator-style no-regression).
- **Cost note:** one head call per sparse scene, before any leaf emission.
- **Blocker discovered during design:** castBuild has no head caller threaded —
  which is why this lives in run-preview-build, where the caller exists.

## Validation playbook

- **Tests:** `node scripts/run-tests.mjs` (per-file summaries; no grand total —
  a green run shows `0 failed` on every file). Type check:
  `npx tsc -p tsconfig.json --noEmit`. NOTE: `cast-build.test.ts` pins
  `RB_ALLOCATE=off` internally (its counters were authored pre-default-flip);
  `allocate-apply.test.ts` owns allocator-on behavior.
- **Stored builds** (offline ground truth, element-level rects included):
  `.data/dogfood/{alloc-off-1, alloc-on-1, alloc-on-2, alloc2-on-1, alloc2-on-2,
  flags-notion, flags-on-rappi}/` — each with `frames/`, `_measure/rects-scene-N.json`,
  `build.log`, `composition.json`, `allocated.json`, `script.generated.json`.
  The founder's reviewed set = alloc-off-1 / alloc2-on-1 / alloc2-on-2
  (gallery: `.data/dogfood/GALLERY_ALLOC.html`).
- **Replay scripts** (zero API, run with `node scripts/<name>.mjs`):
  `scripts/replay-washout-triage.mjs` (sparse/dense triage over all stored hero
  panels) and `scripts/replay-covered-cluster.mjs` (covered-cluster fires over
  all stored scenes). Both bundle the REAL production functions via esbuild —
  never a reimplementation.
- **Live build:** headless via `scripts/fullpipe-render.mjs` (`RB_FP_SCRIPT` to
  pin a script, `RB_FA_BRIEF`/`RB_FP_OUT`); use `/api/dev/build` paths, not
  `/api/preview/*` (Clerk-protected). Spend needs founder approval, always.

## Founder-verdict backlog (not yet addressed)

- Run-1 s0 card-behind-card (vision-judge probe or sub-element planning).
- Two-heroes silently dropped (10/125 scenes; composer consumes hero||copy only).
- Vanishing motif (33 empty throughline fragments shipped as blanks).
- HubSpot-class build time: gate-retry phase is the main duration lever.
