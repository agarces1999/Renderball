# Quality architecture: from gate-reliance to first-pass yield

> **SUPERSEDED — 2026-08-27 (docs/HARNESS.md).** This proposal is the
> judgment-substituting class the bet-on-models doctrine retired. Its
> diagnosis ("the model designs blind") was answered differently: not better
> gates, but not fragmenting the author at all — the 5-arm blind gallery put
> the gate pipeline last. Keep as archaeology of why 27 gates existed. Do not
> execute its roadmap.

*2026-07-05. Status: proposal, red-teamed (3 adversarial reviews: feasibility vs
codebase, creativity cost vs the corpus, migration risk). Owner: eng.*

## Diagnosis — why we have ~27 gates

Census: 8 measured render-truth gates, 17 static validators, plus compile/SSR/
paint checks, feeding 3 independent retry systems. Each was added for a real
shipped defect (git history is the archaeology). The root cause is structural:

> **The model designs blind into an unconstrained output space.** It predicts
> layout in its head (no eyes), and any pixel can go anywhere (no structure), so
> every geometric/timing failure is *possible* and must be caught after the fact.

## The reframe the red-team forced

**Gates are cheap. Retries are expensive.** All measured gates share ONE
browser-measure pass (~seconds); the 40–81-minute builds are dominated by the
regeneration loops that fire when gates fail. So the goal is NOT deleting gates —
it is **raising first-pass yield** so gates almost never fire. Gates then become
telemetry + insurance instead of the QA department. Deletion is only ever a
*consequence* of telemetry (N consecutive clean builds), never a precondition.

## Roadmap (sequenced by blast radius ÷ payoff)

### 1. Golden-scene exemplars (days; zero architecture risk) — DO FIRST
Retrieval library of gate-clean + user-approved scenes (we already have 8+
builds), keyed by scene register + brand vibe; inject 1–2 as few-shot into the
design prompt. Models imitate examples far better than they obey 600 lines of
HARD RULES — this raises the pass rate on *every* gate class at once.
Red-team conditions: sanitize exemplars (strip brand copy/logos so they teach
structure, not content), enforce a diversity quota per register so the portfolio
doesn't converge, flag-gated, rollback = config revert.

### 2. Vision-in-the-loop self-check (days; assembly of existing parts)
After the design pass, hand each scene's screenshot back to glm-5v in ONE
planned self-review turn ("here is what you rendered — fix your section"), using
the existing vision-gate + scoped section-regen machinery. Converts unplanned
retry-ladder loops into a planned perception step, and covers the taste long-tail
no deterministic gate can express (flat charts, weak hierarchy, off-brand vibes).
Cost basis: vision QA measured at ~$0.03/build. Calibrate first by logging the
existing advisory vision gate on every build; promote when precision is proven.

### 3. Choreography schedule, HYBRID form (weeks; shadow-validate first)
As written ("agent emits beat roles, compiler emits all CSS") this was rejected —
it would have flattened Arc s0's timing-as-narrative and Liquid Death's
micro-sequences (the corpus's best work IS its timing). Survivable form:
- The design pass keeps authoring @keyframes (it already does — sustained-motion
  rule). Animatable elements get `data-anim="s{N}.{slug}"` tags (the
  data-content-path pattern GLM ships reliably today).
- The animation agent emits a RICH timeline: references keyframes by name,
  sub-beat staggers free, raw-keyframe escape hatch for hero beats.
- A deterministic compiler owns ONLY delays/durations/ordering, making the
  timing rules compile-time guarantees: first text beat ≤0.2s, text entrances
  ≤0.4s, last beat ≥60%, dwell enforced.
Retires the timing-gate class (dead-air, undwelled, slow-entrance + their
retries) and shrinks the animation pass from a ~32k-token file re-emit to a
small JSON. Validate in shadow mode against stored designs before switching.
Guard: regenerate-piece must preserve data-anim verbatim (one prompt rule +
attribute-diff check).

### 4. Layout GRAMMAR, prompt-level (weeks; the re-scoped "slots")
The strong form ("slot templates make overlap impossible, retire 6–8 gates") was
rejected three ways: intra-slot failures survive (wrap/overflow/sparsity one
level down), it outlaws the sanctioned-overlay pattern behind Arc s0 (fatal for
creativity), and a runtime slot engine breaks the piece contract + editor (fatal
for migration). Survivable form:
- A **layered layout grammar**, not rigid templates: z-ordered zones with
  parameterized ratios, *sanctioned overlay slots* (a copy card MAY sit over a
  full-bleed mock IF it carries its own scrim — codifying Arc s0 instead of
  banning it), composable footer sub-slots, atmosphere/chrome exempt.
- Throughline pinned at CANVAS level with an anchor shared across all layouts
  (otherwise register-variety + per-template geometry makes the motif teleport
  every cut — the drift gate would fire MORE).
- Shipped as a prompt-level contract + provided Slot component (position:
  relative, agent never authors the slot box — the BrandChrome playbook), plus a
  cheap slot-conformance check reusing measure-scene's existing piece
  attribution. 16:9 only first. **No gate deletions** — fire-rate telemetry
  decides later.

### 5. Consolidation — shrunk to what's safe now
The "collapse everything and delete redundant gates" version had a fatal
sequencing inversion (deleting the instrumentation needed to evaluate #3/#4 —
including the cross-piece gate landed days ago because Framer shipped
collisions). Do now: one thresholds table, one shared retry budget across the 3
retry systems, per-gate fire-rate telemetry in the build report. Demote/delete
individual gates only after N clean builds each.

## What we deliberately do NOT do
- No runtime layout engine that owns piece positions (breaks edit-layout.ts,
  the drag editor, and the decomposer's positional contract).
- No pure beat-role animation vocabulary (kills the corpus's best choreography).
- No gate deletion on faith. Telemetry decides, per gate.

## Success metrics
- First-pass yield: % of scenes clearing all blocking gates with zero retries
  (today: ~60–80% by build; the 46–81-min spread is the retry tax).
- Build wall time: target <25 min p50 (retry population shrinks; the deferred
  parallel-animation lever compounds).
- Gate fire-rate per 100 scenes, per gate — published in the build report; the
  deletion criterion.

## Validation run #1 — Loom, 2026-07-05 (exemplars ON, vision-loop OFF)

First live build with QA-1/2/3 landed. One data point — direction, not verdict.

- **Setup**: loom.com, never-crawled brand, 5 scenes (all five registers
  distinct). Exemplars injected: `fullbleed-product` + `quote-manifesto`
  (12.1KB). RB_VISION_LOOP off to isolate the exemplar variable.
- **Result**: shipped clean of blocking findings. `firstPassClean: false` —
  the ladder took one L1 pass (3 step-log entries) before passing. Final
  composition: `undwelled_text: 2` warnings, text-overlap advisory tail in the
  final measure. Zero user-visible defects of the Framer class (titles vs
  mocks) on eyeball review of all 5 settled stills; compositions visibly
  echo exemplar structure (s1 mirrors quote-manifesto, s0 full-bleed
  mock-as-canvas).
- **Cost/wall**: build $1.86 (+ crawl/generate/vision ≈ $2.00 total), 74.9 min
  wall. Both at the top of the 3-brand baseline range (builds $0.77–$1.37,
  46–81 min) — the repair pass, not the exemplar tokens, is the cost driver.
- **Telemetry fix shipped off the back of it**: the first recorded row tallied
  the FINAL measure, so repaired findings vanished from `fires` — undercounting
  exactly what the deletion criterion must count. `RepairResult.initialFindings`
  now feeds `fires`; the shipped advisory tail lands in `residual`.
- **Read**: n=1 says exemplars don't eliminate the retry tax by themselves
  (blocking findings still fired), but the shipped-quality tail looks better
  than baseline (2 warnings vs 3–6 + 3 user-reported defects across the
  baseline trio). Keep exemplars on; accumulate telemetry rows before any
  stronger claim.

## Validation runs #2–3 — Duolingo + Klarna, 2026-07-05/06

Deliberate stress test: every exemplar came from a dark tech brand; these two
are bright-consumer (Duolingo) and pink fintech (Klarna).

- **Both first-pass clean** — 0 repair steps, no blocking findings. With Loom
  that's 2/3 clean builds since exemplars landed vs ~0 first-pass-clean
  expectation from the baseline era (Framer/Superhuman shipped user-visible
  defects even AFTER repairs).
- **Duolingo** ($1.49 build / 82 min): fires dead-region×1 (residual — the CTA
  scene's near-empty app card) + 4 warn families. **Caveat: got ZERO exemplars**
  — GLM omitted `register` on all 5 scenes, so selection silently no-oped.
  Its clean pass is evidence about the baseline pipeline, not exemplars.
- **Klarna** ($1.48 build / 82 min): exemplars fullbleed-product +
  split-editor injected; fires text-overlap×1 (residual, advisory) + 3 warn
  families; stills flawless on eyeball review; vision gate ran, 0 findings.
- **Style-leak check passed**: Duolingo (no exemplars) also chose a dark
  canvas — the dark tendency is the Design Agent's own bias, not exemplar
  leakage. Composition variety stayed brand-true in both.
- **Three defects the batch exposed, fixed same-night**: (1) vision gate
  failure was silent — Duolingo's gate died unnoticed and the ledger read as
  "ran clean"; failures now record a failed vision-qa row and `vision: []`
  is written when the gate genuinely ran. (2) exemplar selection no-oped
  silently on register-less scripts — now falls back to two generic
  exemplars with a loud warn. (3) missing registers now backfilled
  deterministically at generation (`backfillSceneRegisters`) so the whole
  register-keyed machinery can't silently disengage.
- **Score after 3 telemetry rows**: firstPassClean 2/3; barbell, overflow,
  cross-piece-overlap: 0 fires in 15 scenes; text-overlap 6 fires (5 repaired
  in Loom, 1 advisory residual); dead-region 1. Too early to demote anything.

## First-pass contracts (FP) — the sustainable fix for the 2026-07-06 QA

The QA's five failure classes traced to sensors that were DISARMED or blind,
not missing. The fix arms the whole chain from one derivation and adds only
cheap checks inside existing loops — no new gate machinery:

1. **Canvas plan, always derived** (`resolveCanvasPlan`): crawl background →
   palette-extremity inference → white. One source of truth feeding (a) the
   machine contract's CANVAS BACKGROUND line (previously silently absent when
   the crawl missed bg — the Duolingo inversion), (b) the canvas-brightness
   gate (same disarm), now **blocking**, (c) the vision rubric. Plus a
   DOMINANT ACCENT contract line (signature owns CTAs/kickers).
2. **Placeholder lint** (`findPlaceholderData`): masked prices ("$•••.00"),
   "$—", standalone "Loading"/"TBD" → structural failure in the existing
   design-pass sweep. Replayed on the shipped Klarna build: 6 hits.
3. **Dead-air gate fixed + extended**: the old regex only parsed QUOTED inline
   animations — `<style>`-block choreography was invisible, so sections were
   skipped as "all-infinite" (how 10/10 frozen tails passed). Now parses both,
   checks the last finite beat's END ≥75% of duration, exempts only genuinely
   ambient sections; animation prompt gains an ambient-layer HARD RULE.
   Residual class (ambient present but imperceptible) is pixel-measured in the
   dogfood harness (`tailMotion`: p70-vs-p97 frame diff — free, MP4 exists).
4. **Web chrome ban**: pagination dots REMOVED from the provided BrandChrome
   (they made every scene read as a carousel screenshot); design prompt gains
   a film-frame-not-web-page HARD RULE + contract line.
5. **Vision rubric v2 + loop ON**: judges per-scene plan fidelity (the
   visual_concept), placeholder/blank-asset detection, web chrome, accent
   dominance — and RB_VISION_LOOP now defaults ON (RB_VISION_LOOP=0 disables);
   the exact defects it repairs shipped while it sat behind an opt-in flag.
   Asset ingest also rejects near-uniform (blank-box) images.
