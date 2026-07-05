# Quality architecture: from gate-reliance to first-pass yield

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
